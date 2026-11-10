//! 单页 HTML 图集：轻量 DOM 扫描 + 多阶段提纯。
//!
//! 不执行 JS、不跟随分页查看器，只提取当前页 `<img>`。扫描器维护元素栈，
//! 剔除 header/footer/nav/aside、评论区/推荐位等站点 chrome，识别
//! data-src / data-original / data-lazy-src / data-srcset 懒加载真实地址，
//! 然后把候选交给 [`crate::online::filter`] 做尺寸、序列与站点档案过滤。

use std::collections::HashSet;

use regex::Regex;

use crate::online::direct::{make_filtered_meta, preprobe_missing, OnlineBookMeta};
use crate::online::filter::{
    filter_candidates, path_template, CandidateImage, CandidateSource, FilterMemory, FilterOutcome,
    FilterThresholds, FilteredPage,
};
use crate::online::http::HttpTransport;
use crate::online::OnlineError;
use crate::online::{normalize_url, truncate_chars, PageRef, MAX_PAGES};
use crate::source::BackendError;

/// DOM 候选少于此数时，尝试扫描 SSR 内联 JSON/脚本中的图片直链。
const MIN_DOM_IMAGES_BEFORE_INLINE: usize = 4;

/// 解析单页 HTML 图集正文（离线/兼容入口；不做网络尺寸探测）。
#[allow(dead_code)]
pub fn parse_gallery(
    body: &[u8],
    base_url: &url::Url,
    canonical_url: &url::Url,
) -> Result<OnlineBookMeta, BackendError> {
    struct NoProbe;
    impl HttpTransport for NoProbe {
        fn get(
            &self,
            _url: &str,
            _max: usize,
            _referer: Option<&str>,
            _header_scope: Option<&str>,
        ) -> Result<crate::online::http::HttpResponse, OnlineError> {
            Err(OnlineError::Network("probe disabled".into()))
        }
    }
    let thresholds = FilterThresholds {
        probe_missing_dimensions: false,
        ..FilterThresholds::default()
    };
    parse_gallery_with(
        body,
        base_url,
        canonical_url,
        &NoProbe,
        &FilterMemory::default(),
        &thresholds,
    )
}

/// 带网络尺寸探测的 HTML 图集解析入口。
pub fn parse_gallery_with(
    body: &[u8],
    base_url: &url::Url,
    canonical_url: &url::Url,
    http: &dyn HttpTransport,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    let text = decode_html(body);
    let title = extract_title(&text).unwrap_or_else(|| crate::online::title_from_url(base_url));
    // <base href> 改变相对图片解析基准；标题回退仍用最终 URL。
    let effective_base = base_href(&text, base_url).unwrap_or_else(|| base_url.clone());

    let mut stack: Vec<OpenElement> = Vec::new();
    let mut candidates: Vec<CandidateImage> = Vec::new();
    let mut seen = HashSet::new();
    let mut pos = 0usize;
    while let Some((start, end)) = next_tag(&text, pos) {
        pos = end;
        let tag = &text[start..end];
        let Some(name) = tag_name(tag) else {
            continue;
        };
        let attrs = parse_attrs(tag);
        if tag.trim_start().starts_with("</") {
            if let Some(index) = stack.iter().rposition(|el| el.name == name) {
                stack.truncate(index);
            }
            continue;
        }
        // script/style 内容不是 DOM；跳过其闭合标签前的全部文本。
        if matches!(name.as_str(), "script" | "style") && !tag.trim_end().ends_with("/>") {
            if let Some(close) = find_ci(&text, &format!("</{name}"), pos) {
                pos = text[close..]
                    .find('>')
                    .map(|offset| close + offset + 1)
                    .unwrap_or(text.len());
            }
            continue;
        }
        let class_id = attr_value(&attrs, "class")
            .into_iter()
            .chain(attr_value(&attrs, "id"))
            .collect::<Vec<_>>()
            .join(" ");
        let parent = stack.last();
        // 主容器/正文语义节点重置 chrome：顶层布局状态类名
        // （header-fixed / nav-sticky 等）不得污染整棵正文子树。
        let main_container = is_main_container(&name, &class_id);
        let self_chrome = !main_container && (is_chrome_tag(&name) || is_chrome_class(&class_id));
        let chrome = if main_container {
            false
        } else {
            parent.map(|el| el.chrome).unwrap_or(false) || self_chrome
        };
        let container = if is_content_tag(&name) || is_content_class(&class_id) {
            Some(selector_hint(&name, &attrs))
        } else {
            parent.and_then(|el| el.container.clone())
        };
        if name == "img" {
            if let Some(url) = image_url(&attrs, &effective_base) {
                if seen.insert(url.clone()) {
                    let (width, height) = image_dimensions(&attrs);
                    let img_class = class_id.trim().to_string();
                    let alt = attr_value(&attrs, "alt").map(|v| decode_entities(&v));
                    candidates.push(CandidateImage {
                        url,
                        width,
                        height,
                        order: candidates.len(),
                        in_chrome: chrome || is_chrome_class(&img_class),
                        container: container.clone(),
                        class_id: (!img_class.is_empty()).then_some(img_class),
                        alt,
                        source: CandidateSource::Html,
                        anchor: None,
                    });
                    if candidates.len() > MAX_PAGES.saturating_mul(8) {
                        return Err(BackendError::Msg(format!(
                            "HTML 图片数超过上限 {MAX_PAGES}"
                        )));
                    }
                }
            }
            // img 是 void 元素，不入栈。
            continue;
        }
        if !is_void(&name) && !tag.trim_end().ends_with("/>") {
            stack.push(OpenElement {
                name,
                chrome,
                container,
            });
        }
    }

    // 仅在完全没有 <img> 时退回 <picture><source srcset>。正常页面同时存在
    // <source> 与 <img>，此时只取 <img>，避免同一页被 webp/jpeg 双份导入。
    if candidates.is_empty() {
        collect_source_candidates(&text, &effective_base, &mut candidates, &mut seen);
    }
    // SSR/内联数据回退：DOM 标签不足时，解析 __NEXT_DATA__ 与脚本内的有序图片直链。
    if candidates.len() < MIN_DOM_IMAGES_BEFORE_INLINE {
        extract_inline_images(&text, &effective_base, &mut candidates, &mut seen);
    }
    if candidates.is_empty() {
        return Err(BackendError::Msg(
            "未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围".into(),
        ));
    }
    let referer = canonical_url.as_str().to_string();
    let mut memory = memory.clone();
    if memory.host.is_empty() {
        memory.host = crate::online::filter::url_host(canonical_url.as_str());
    }
    let prefetched = if thresholds.probe_missing_dimensions {
        preprobe_missing(
            http,
            &referer,
            &candidates,
            crate::online::filter::MAX_PROBE_IMAGES,
        )
    } else {
        std::collections::HashMap::new()
    };
    let mut probe = |candidate: &CandidateImage| prefetched.get(&candidate.url).cloned();
    let raw_candidates = candidates.clone();
    let outcome = filter_candidates(candidates, &memory, thresholds, &mut probe);
    let outcome = if outcome.pages.is_empty() {
        // 顶层布局状态类名/序列聚类曾把整章误杀：按 path 模板回退一次。
        match fallback_cluster(&raw_candidates, &outcome) {
            Some(fallback) => fallback,
            None => {
                return Err(BackendError::Msg(format!(
                    "未找到正文图片（已过滤 {} 张；原因 {}）（online-html-no-content）",
                    outcome.blocked.len(),
                    reason_summary(&outcome.blocked)
                )));
            }
        }
    } else {
        outcome
    };
    if outcome.pages.len() > MAX_PAGES {
        return Err(BackendError::Msg(format!(
            "HTML 图片数超过上限 {MAX_PAGES}"
        )));
    }
    let title = truncate_chars(&title, 200);
    make_filtered_meta(
        canonical_url,
        &title,
        outcome,
        crate::online::direct::MetaLinks::default(),
    )
}

struct OpenElement {
    name: String,
    chrome: bool,
    container: Option<String>,
}

fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn is_chrome_tag(name: &str) -> bool {
    matches!(name, "header" | "footer" | "nav" | "aside")
}

fn tokens(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
}

/// 布局状态后缀：`header-fixed` / `nav-sticky` / `sidebar-none` 等是
/// 页面状态标记，不是结构性 chrome。命中后缀时不得把节点或子树判为 chrome。
fn is_layout_state_token(token: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "-fixed",
        "-sticky",
        "-none",
        "-disabled",
        "-hidden",
        "-open",
        "-closed",
        "-active",
        "-visible",
        "-shown",
    ];
    let normalized = token.replace('_', "-");
    SUFFIXES.iter().any(|suffix| normalized.ends_with(suffix))
}

fn is_chrome_class(value: &str) -> bool {
    const EXACT: &[&str] = &[
        "ad",
        "ads",
        "adv",
        "advert",
        "banner",
        "promo",
        "sponsor",
        "comment",
        "comments",
        "sidebar",
        "recommend",
        "related",
        "share",
        "menu",
        "breadcrumb",
        "toolbar",
    ];
    // 只收录“结构性”站点 chrome。`loading` / `placeholder` / `thumb`
    // 是懒加载状态词，正文 `<img class="lazy-loading">` 或
    // `<div class="chapter-content loading">` 极为常见；把它们当 chrome
    // 会把整章正文直接判负。占位图由 URL 形态与尺寸阶段处理。
    const CONTAINS: &[&str] = &[
        "header",
        "footer",
        "nav",
        "logo",
        "avatar",
        "qrcode",
        "watermark",
        "icon",
        "sprite",
        "button",
        "btn",
        "sticker",
        "emoji",
    ];
    let lower = value.to_ascii_lowercase();
    let matched = tokens(&lower).any(|token| {
        if is_layout_state_token(&token) {
            return false;
        }
        EXACT.contains(&token.as_str()) || CONTAINS.iter().any(|word| token.contains(word))
    });
    matched
}

/// 主容器/正文语义节点：自身与后代忽略外层 chrome 继承。
fn is_main_container(name: &str, class_id: &str) -> bool {
    matches!(name, "html" | "body" | "main" | "article") || is_content_class(class_id)
}

fn is_content_tag(name: &str) -> bool {
    matches!(name, "main" | "article")
}

fn is_content_class(value: &str) -> bool {
    const WORDS: &[&str] = &[
        "reader", "content", "chapter", "gallery", "comic", "manga", "pages", "viewer",
    ];
    let lower = value.to_ascii_lowercase();
    WORDS.iter().any(|word| lower.contains(word))
}

fn selector_hint(name: &str, attrs: &[(String, String)]) -> String {
    let class = attr_value(attrs, "class").unwrap_or_default();
    let id = attr_value(attrs, "id").unwrap_or_default();
    let class = class
        .split_whitespace()
        .next()
        .unwrap_or("")
        .chars()
        .take(60)
        .collect::<String>();
    let id = id.chars().take(60).collect::<String>();
    if !id.is_empty() {
        format!("{name}#{id}")
    } else if !class.is_empty() {
        format!("{name}.{class}")
    } else {
        name.to_string()
    }
}

/// 按 BOM / `<meta charset>` / `Content-Type` meta 解码 HTML；无声明时按 UTF-8
/// lossy。编码标签只在前 8 KiB 内查找，避免把正文误当标签。
pub(crate) fn decode_html(body: &[u8]) -> String {
    use encoding_rs::{Encoding, UTF_8};
    if let Some((encoding, bom_len)) = Encoding::for_bom(body) {
        let (text, _, _) = encoding.decode(&body[bom_len..]);
        return text.into_owned();
    }
    let probe = String::from_utf8_lossy(&body[..body.len().min(8192)]);
    let lower = probe.to_ascii_lowercase();
    let label = lower
        .split("charset=")
        .nth(1)
        .map(|tail| {
            tail.trim_start_matches(['"', '\''])
                .split(|c: char| c == '"' || c == '\'' || c == ';' || c == '>' || c.is_whitespace())
                .next()
                .unwrap_or("")
        })
        .filter(|label| !label.is_empty());
    let encoding = label
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .unwrap_or(UTF_8);
    let (text, _, _) = encoding.decode(body);
    text.into_owned()
}

fn base_href(text: &str, base_url: &url::Url) -> Option<url::Url> {
    let re = Regex::new(r#"(?is)<base\b[^>]*href\s*=\s*["']([^"']+)["']"#).ok()?;
    let raw = decode_entities(re.captures(text)?.get(1)?.as_str().trim());
    let joined = base_url.join(&raw).ok()?;
    normalize_url(joined.as_str()).ok()
}

pub(crate) fn extract_title(text: &str) -> Option<String> {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    re.captures(text)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 找到下一个标签的字节区间 `[start, end)`；跳过注释与 doctype。
pub(crate) fn next_tag(text: &str, from: usize) -> Option<(usize, usize)> {
    let mut cursor = from;
    loop {
        let start = text[cursor..].find('<')? + cursor;
        if text[start..].starts_with("<!--") {
            let end = text[start + 4..].find("-->")? + start + 7;
            cursor = end;
            continue;
        }
        if text[start..].starts_with("<!") || text[start..].starts_with("<?") {
            let end = text[start..].find('>')? + start + 1;
            cursor = end;
            continue;
        }
        let mut quote: Option<char> = None;
        for (offset, ch) in text[start + 1..].char_indices() {
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
                continue;
            }
            if ch == '"' || ch == '\'' {
                quote = Some(ch);
            } else if ch == '>' {
                return Some((start, start + 1 + offset + 1));
            }
        }
        return None;
    }
}

pub(crate) fn tag_name(tag: &str) -> Option<String> {
    let inner = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start();
    let name: String = inner
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ':')
        .collect::<String>()
        .to_ascii_lowercase();
    (!name.is_empty()).then_some(name)
}

pub(crate) fn parse_attrs(tag: &str) -> Vec<(String, String)> {
    let re = Regex::new(
        r#"(?is)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
    )
    .expect("attr regex");
    re.captures_iter(tag)
        .filter_map(|caps| {
            let name = caps.get(1)?.as_str().to_ascii_lowercase();
            let value = caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            Some((name, value))
        })
        .collect()
}

pub(crate) fn attr_value(attrs: &[(String, String)], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.trim().is_empty())
}

fn image_dimensions(attrs: &[(String, String)]) -> (Option<u32>, Option<u32>) {
    let parse = |name: &str| {
        attr_value(attrs, name)
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|v| *v > 0)
    };
    (
        parse("width").or_else(|| parse("data-width")),
        parse("height").or_else(|| parse("data-height")),
    )
}

/// 从 srcset 中选择“最大”候选：有 `w` 取最大宽度，有 `x` 取最大倍率；
/// 无描述符时取第一项。只取第一项会拿到缩略图或 1x 占位图。
fn best_srcset_url(value: &str) -> Option<String> {
    let mut best: Option<(f64, String)> = None;
    for part in value.split(',') {
        let mut words = part.split_whitespace();
        let Some(url) = words.next() else { continue };
        let descriptor = words.next().unwrap_or("");
        let weight = if let Some(raw) = descriptor.strip_suffix('w') {
            raw.parse::<f64>().unwrap_or(0.0)
        } else if let Some(raw) = descriptor.strip_suffix('x') {
            raw.parse::<f64>().unwrap_or(0.0) * 10_000.0
        } else {
            0.0
        };
        let is_better = match best.as_ref() {
            None => true,
            Some((current, _)) => weight > *current,
        };
        if is_better {
            best = Some((weight, url.to_string()));
        }
    }
    best.map(|(_, url)| url)
}

/// 汇总过滤原因（去掉 `keyword:` 后缀），最多三项，便于用户判断是
/// 站点 chrome、尺寸还是用户规则导致整页失败。
fn reason_summary(blocked: &[FilteredPage]) -> String {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for page in blocked {
        let reason = page.reason.split(':').next().unwrap_or("unknown");
        *counts.entry(reason).or_insert(0) += 1;
    }
    let mut pairs: Vec<(&str, usize)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    pairs
        .iter()
        .take(3)
        .map(|(reason, count)| format!("{reason}×{count}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 零结果回退：忽略父级 chrome 标记，按归一化 path 模板取最大同构簇。
///
/// 仅在常规过滤因 `chrome` / `isolated` 归零、原始候选 >=5 时触发；
/// 最大簇 >=4 才作为正文图集返回，避免把广告/图标簇当正文。
fn fallback_cluster(
    candidates: &[CandidateImage],
    outcome: &FilterOutcome,
) -> Option<FilterOutcome> {
    const MIN_RAW_CANDIDATES: usize = 5;
    const MIN_CLUSTER_SIZE: usize = 4;
    if candidates.len() < MIN_RAW_CANDIDATES {
        return None;
    }
    let chrome_or_isolated = outcome
        .blocked
        .iter()
        .any(|page| page.reason.starts_with("chrome") || page.reason.starts_with("isolated"));
    if !chrome_or_isolated {
        return None;
    }
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for candidate in candidates {
        if let Some(template) = path_template(&candidate.url) {
            *counts.entry(template).or_insert(0) += 1;
        }
    }
    let (main_template, main_count) =
        counts
            .into_iter()
            .max_by(|(a_template, a_count), (b_template, b_count)| {
                a_count
                    .cmp(b_count)
                    .then_with(|| b_template.cmp(a_template))
            })?;
    if main_count < MIN_CLUSTER_SIZE {
        return None;
    }
    let mut pages = Vec::new();
    let mut selected = HashSet::new();
    for candidate in candidates {
        if path_template(&candidate.url).as_deref() != Some(main_template.as_str()) {
            continue;
        }
        if pages.len() >= MAX_PAGES {
            break;
        }
        selected.insert(candidate.url.clone());
        pages.push(PageRef {
            url: candidate.url.clone(),
            width: candidate.width,
            height: candidate.height,
            anchor: candidate.anchor.clone(),
            viewer: false,
        });
    }
    if pages.len() < MIN_CLUSTER_SIZE {
        return None;
    }
    let blocked = outcome
        .blocked
        .iter()
        .filter(|page| !selected.contains(&page.url))
        .cloned()
        .collect::<Vec<_>>();
    let kept_ratio = pages.len() as f32 / candidates.len() as f32;
    Some(FilterOutcome {
        pages,
        blocked,
        profile: outcome.profile.clone(),
        input_count: outcome.input_count,
        kept_ratio,
    })
}

/// 扫描内联 `<script>`：`__NEXT_DATA__`/JSON 优先按数组顺序递归，
/// 其余脚本按图片 URL 字面量顺序提取；不执行任何脚本。
fn extract_inline_images(
    text: &str,
    base_url: &url::Url,
    out: &mut Vec<CandidateImage>,
    seen: &mut HashSet<String>,
) {
    let mut pos = 0usize;
    while let Some((start, end)) = next_tag(text, pos) {
        pos = end;
        let tag = &text[start..end];
        if tag.trim_start().starts_with("</") {
            continue;
        }
        let Some(name) = tag_name(tag) else {
            continue;
        };
        if name != "script" || tag.trim_end().ends_with("/>") {
            continue;
        }
        let Some(close) = find_ci(text, "</script", pos) else {
            break;
        };
        let Some(close_end) = text[close..].find('>').map(|offset| close + offset + 1) else {
            break;
        };
        let body = &text[pos..close];
        pos = close_end;
        let attrs = parse_attrs(tag);
        if attr_value(&attrs, "src").is_some() {
            continue;
        }
        let id = attr_value(&attrs, "id").unwrap_or_default();
        let kind = attr_value(&attrs, "type")
            .unwrap_or_default()
            .to_ascii_lowercase();
        // JSON 字符串里的 `\/` 与 `\u002F` 先还原成普通路径分隔符。
        let normalized = body.replace("\\/", "/").replace("\\u002F", "/");
        let json_like = id.eq_ignore_ascii_case("__NEXT_DATA__") || kind.contains("json");
        if json_like {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(normalized.trim()) {
                collect_json_images(&value, base_url, out, seen);
                if out.len() > MAX_PAGES.saturating_mul(8) {
                    return;
                }
                continue;
            }
        }
        collect_script_image_literals(&normalized, base_url, out, seen);
        if out.len() > MAX_PAGES.saturating_mul(8) {
            return;
        }
    }
}

fn collect_json_images(
    value: &serde_json::Value,
    base_url: &url::Url,
    out: &mut Vec<CandidateImage>,
    seen: &mut HashSet<String>,
) {
    match value {
        serde_json::Value::String(raw) => {
            if let Some(url) = inline_image_url(raw, base_url) {
                push_inline_candidate(url, out, seen);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_images(item, base_url, out, seen);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_json_images(item, base_url, out, seen);
            }
        }
        _ => {}
    }
}

fn collect_script_image_literals(
    text: &str,
    base_url: &url::Url,
    out: &mut Vec<CandidateImage>,
    seen: &mut HashSet<String>,
) {
    let re = Regex::new(
        r#"(?i)(?:https?:)?//[^\s"'<>\\)]+?\.(?:jpe?g|png|gif|webp)(?:\?[^\s"'<>\\)]*)?"#,
    )
    .expect("inline image regex");
    for hit in re.find_iter(text) {
        if let Some(url) = inline_image_url(hit.as_str().trim(), base_url) {
            push_inline_candidate(url, out, seen);
        }
    }
}

fn inline_image_url(raw: &str, base_url: &url::Url) -> Option<String> {
    let raw = decode_entities(raw.trim());
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("blob:") || lower.starts_with("javascript:")
    {
        return None;
    }
    let raw = if let Some(rest) = raw.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        raw
    };
    let joined = base_url.join(&raw).ok()?;
    let normalized = normalize_url(joined.as_str()).ok()?;
    let path = normalized.path().to_ascii_lowercase();
    let image_like = [".jpg", ".jpeg", ".png", ".gif", ".webp"]
        .iter()
        .any(|extension| path.ends_with(extension));
    image_like.then(|| normalized.to_string())
}

fn push_inline_candidate(url: String, out: &mut Vec<CandidateImage>, seen: &mut HashSet<String>) {
    if out.len() > MAX_PAGES.saturating_mul(8) || !seen.insert(url.clone()) {
        return;
    }
    out.push(CandidateImage {
        url,
        width: None,
        height: None,
        order: out.len(),
        in_chrome: false,
        container: Some("inline-json".into()),
        class_id: None,
        alt: None,
        source: CandidateSource::InlineJson,
        anchor: None,
    });
}

/// `<picture>` 站点可能只提供 `<source type="image/webp" srcset="...">`。
/// 只接受声明为图片或无声明但带 srcset 的 source，避免把 `<video>` 源当图片。
fn collect_source_candidates(
    text: &str,
    base_url: &url::Url,
    out: &mut Vec<CandidateImage>,
    seen: &mut HashSet<String>,
) {
    let mut pos = 0usize;
    let mut in_picture = false;
    // `<picture>` 内多个 <source> 是同一页的不同格式回退，只取第一个可用项。
    let mut picture_used = false;
    while let Some((start, end)) = next_tag(text, pos) {
        pos = end;
        let tag = &text[start..end];
        let closing = tag.trim_start().starts_with("</");
        let Some(name) = tag_name(tag) else {
            continue;
        };
        if name == "picture" {
            in_picture = !closing;
            picture_used = false;
            continue;
        }
        if closing || name != "source" || !in_picture || picture_used {
            continue;
        }
        let attrs = parse_attrs(tag);
        let kind = attr_value(&attrs, "type").unwrap_or_default();
        let lower_kind = kind.to_ascii_lowercase();
        let has_srcset = attr_value(&attrs, "srcset")
            .or_else(|| attr_value(&attrs, "data-srcset"))
            .is_some();
        if !has_srcset && !lower_kind.starts_with("image/") {
            continue;
        }
        let Some(url) = image_url(&attrs, base_url) else {
            continue;
        };
        picture_used = true;
        if !seen.insert(url.clone()) {
            continue;
        }
        let (width, height) = image_dimensions(&attrs);
        let class_id = attr_value(&attrs, "class")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        out.push(CandidateImage {
            url,
            width,
            height,
            order: out.len(),
            in_chrome: false,
            container: None,
            class_id,
            alt: attr_value(&attrs, "alt"),
            source: CandidateSource::Html,
            anchor: None,
        });
        if out.len() > MAX_PAGES.saturating_mul(8) {
            return;
        }
    }
}

fn image_url(attrs: &[(String, String)], base_url: &url::Url) -> Option<String> {
    let mut candidates = Vec::new();
    // 懒加载属性按优先级排列；不同站点/库使用不同命名。
    for key in [
        "data-src",
        "data-original",
        "data-original-src",
        "data-lazy-src",
        "data-lazy",
        "data-lazyload",
        "data-echo",
        "data-url",
        "data-cfsrc",
    ] {
        if let Some(value) = attr_value(attrs, key) {
            candidates.push(value);
        }
    }
    for key in ["data-srcset", "srcset"] {
        if let Some(value) = attr_value(attrs, key).and_then(|v| best_srcset_url(&v)) {
            candidates.push(value);
        }
    }
    if let Some(value) = attr_value(attrs, "src") {
        candidates.push(value);
    }
    for raw in candidates {
        let raw = decode_entities(raw.trim());
        if raw.is_empty()
            || raw.starts_with("data:")
            || raw.starts_with("blob:")
            || raw.starts_with("javascript:")
        {
            continue;
        }
        let lower = raw.to_ascii_lowercase();
        if lower.ends_with(".svg") || lower.ends_with(".ico") {
            continue;
        }
        let Ok(joined) = base_url.join(&raw) else {
            continue;
        };
        let Ok(normalized) = normalize_url(joined.as_str()) else {
            continue;
        };
        return Some(normalized.to_string());
    }
    None
}

/// 从二级查看器 HTML 提取真实大图地址。
///
/// 优先 `id="img"` / `id="image"`；否则取声明面积最大的正文图；
/// 都没有声明尺寸时退回第一张非 chrome 图，最后才用 `og:image`。
pub(crate) fn extract_viewer_image(
    body: &[u8],
    base_url: &url::Url,
) -> Result<String, BackendError> {
    let text = decode_html(body);
    let mut best: Option<(u64, usize, String)> = None;
    let mut first: Option<String> = None;
    let mut order = 0usize;
    let mut pos = 0usize;
    while let Some((start, end)) = next_tag(&text, pos) {
        pos = end;
        let tag = &text[start..end];
        if tag.trim_start().starts_with("</") {
            continue;
        }
        let Some(name) = tag_name(tag) else {
            continue;
        };
        if name != "img" {
            continue;
        }
        let attrs = parse_attrs(tag);
        let id = attr_value(&attrs, "id").unwrap_or_default();
        let class_id = attr_value(&attrs, "class").unwrap_or_default();
        if is_chrome_class(&id) || is_chrome_class(&class_id) {
            continue;
        }
        let Some(url) = image_url(&attrs, base_url) else {
            continue;
        };
        if id.eq_ignore_ascii_case("img") || id.eq_ignore_ascii_case("image") {
            return Ok(url);
        }
        let (width, height) = image_dimensions(&attrs);
        let area = width.unwrap_or(0) as u64 * height.unwrap_or(0) as u64;
        if first.is_none() {
            first = Some(url.clone());
        }
        let better = match best.as_ref() {
            None => true,
            Some((best_area, _, _)) => area > *best_area,
        };
        if better {
            best = Some((area, order, url));
        }
        order += 1;
    }
    if let Some((_, _, url)) = best {
        return Ok(url);
    }
    if let Some(url) = og_image(&text, base_url) {
        return Ok(url);
    }
    first.ok_or_else(|| {
        BackendError::Msg("查看器页面未找到正文大图（online-html-no-content）".into())
    })
}

fn og_image(text: &str, base_url: &url::Url) -> Option<String> {
    let pattern = [
        r#"(?is)<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']"#,
        r#"(?is)<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']og:image["']"#,
    ];
    for pattern in pattern {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        if let Some(caps) = re.captures(text) {
            let raw = decode_entities(caps[1].trim());
            let attrs = vec![("src".to_string(), raw)];
            if let Some(url) = image_url(&attrs, base_url) {
                return Some(url);
            }
        }
    }
    None
}

/// 去掉标题中的 HTML 标签。
fn strip_tags(s: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .expect("tag strip regex")
        .replace_all(s, "")
        .to_string()
}

/// 解码标题中的常见 HTML 实体（单次解码）。
pub(crate) fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let lower = haystack[from..].to_ascii_lowercase();
    lower.find(&needle.to_ascii_lowercase()).map(|i| from + i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gallery(html: &str) -> OnlineBookMeta {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        parse_gallery(html.as_bytes(), &page, &page).unwrap()
    }

    #[test]
    fn extracts_title_and_images() {
        let meta = gallery(
            r#"<html><head><title>My Gallery</title></head>
            <body>
              <img src="/1.png">
              <img data-src="2.png">
              <img data-original="https://cdn.example/3.png">
            </body></html>"#,
        );
        assert_eq!(meta.title, "My Gallery");
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/1.png");
        assert_eq!(stored.pages[1].url, "http://gallery.example/view/2.png");
        assert_eq!(stored.pages[2].url, "https://cdn.example/3.png");
    }

    #[test]
    fn drops_thirty_page_chrome_and_keeps_all_content() {
        let mut html = String::from(
            r#"<html><head><title>QA HTML Gallery</title></head><body>
            <header><img src="/logo.png" width="128" height="128" class="logo"></header>
            <nav><img src="/ad.png" width="728" height="90" class="ad-banner"></nav>
            <aside class="comments"><img src="https://other.example/avatar.png" width="200" height="200"></aside>
            <main><div class="reader-content">"#,
        );
        for i in 1..=30 {
            html.push_str(&format!(
                r#"<img src="/page-{:03}.png" width="800" height="1200" alt="page">"#,
                i
            ));
        }
        html.push_str(
            r#"<img src="/qrcode.png" width="300" height="300" alt="qrcode">
            <img src="/thumb.png" width="240" height="240" alt="thumbnail">
            </div></main>
            <footer><img src="/icon.png" width="64" height="64"></footer></body></html>"#,
        );
        let meta = gallery(&html);
        assert_eq!(meta.page_count, 30);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert!(stored.filtered.len() >= 5);
        assert!(stored.filtered.iter().any(|p| p.reason.contains("chrome")));
        assert!(stored.filtered.iter().any(|p| {
            p.reason.contains("small")
                || p.reason.contains("banner")
                || p.reason.contains("keyword")
        }));
        assert!(meta.filter_profile.is_some());
    }

    #[test]
    fn lazy_loading_classes_do_not_mark_content_as_chrome() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let mut html = String::from(r#"<html><body><main><div class="chapter-content loading">"#);
        for i in 1..=22 {
            html.push_str(&format!(
                r#"<img class="lazy-loading" data-src="/pages/{i:03}.jpg" src="/placeholder.gif">"#
            ));
        }
        html.push_str("</div></main></body></html>");
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        assert_eq!(meta.page_count, 22);
    }

    #[test]
    fn srcset_chooses_largest_candidate() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
            <img srcset="/small.jpg 320w, /large.jpg 1600w, /mid.jpg 800w">
            <img srcset="/one.jpg 1x, /three.jpg 3x, /two.jpg 2x">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/large.jpg");
        assert_eq!(stored.pages[1].url, "http://gallery.example/three.jpg");
    }

    #[test]
    fn picture_sources_are_used_only_when_no_img_exists() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
            <picture>
              <source type="image/webp" srcset="/a-640.webp 640w, /a-1280.webp 1280w">
              <source type="image/jpeg" srcset="/a-1280.jpg 1280w">
            </picture>
            <picture><source type="image/webp" srcset="/b.webp"></picture>
            <video><source src="/movie.mp4"></video>
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/a-1280.webp",
                "http://gallery.example/b.webp",
            ]
        );
    }

    #[test]
    fn normalizes_joined_urls_and_skips_userinfo_and_fragments() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let long_path = "a".repeat(2100);
        let html = format!(
            r#"<html><body>
              <img src="https://user:pass@cdn.example/secret.png">
              <img src="/1.png#frag">
              <img src="/1.png">
              <img src="/{long_path}.png">
              <img src="https://cdn.example/2.png#part">
              <img src="https://cdn.example/2.png">
            </body></html>"#
        );
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/1.png");
        assert_eq!(stored.pages[1].url, "https://cdn.example/2.png");
    }

    #[test]
    fn falls_back_when_data_src_is_blank_or_placeholder() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-src="   " src="/blank.png">
              <img data-src="data:image/gif;base64,R0lGOD" src="/data.png">
              <img data-src="blob:http://gallery.example/x" src="/blob.png">
              <img data-src="javascript:void(0)" src="/js.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 4);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/blank.png",
                "http://gallery.example/data.png",
                "http://gallery.example/blob.png",
                "http://gallery.example/js.png",
            ]
        );
    }

    #[test]
    fn prefers_data_src_then_data_original_then_src() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-src="/a.png" data-original="/b.png" src="/c.png">
              <img data-original="/d.png" src="/e.png">
              <img src="/f.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/a.png",
                "http://gallery.example/d.png",
                "http://gallery.example/f.png",
            ]
        );
    }

    #[test]
    fn supports_data_lazy_src_and_ignores_lazy_placeholder_only_when_src_exists() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-lazy-src="/lazy-only.png">
              <img data-lazy-src="/lazy.png" src="/real.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/lazy-only.png",
                "http://gallery.example/lazy.png",
            ]
        );
    }

    #[test]
    fn decodes_entities_in_image_urls_before_join() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body><img src="/a.png?x=1&amp;y=2"></body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/a.png?x=1&y=2");
    }

    #[test]
    fn decodes_entities_in_a_single_pass() {
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_entities("A &amp; B"), "A & B");
    }

    #[test]
    fn viewer_only_page_is_rejected() {
        let page = url::Url::parse("http://gallery.example/g/1/token").unwrap();
        let html = br#"<html><body><a href="/s/abc/1-1">1</a></body></html>"#;
        let err = parse_gallery(html, &page, &page).err().unwrap().to_string();
        assert_eq!(
            err,
            "未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围"
        );
    }

    #[test]
    fn dedupes_and_skips_non_http_sources() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-src="1.png">
              <img src="1.png">
              <img src="data:image/png;base64,AAAA">
              <img src="javascript:void(0)">
              <img src="//cdn.example/2.png">
              <img src="http://cdn.example/2.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/view/1.png");
        assert_eq!(stored.pages[1].url, "http://cdn.example/2.png");
        assert!(stored
            .pages
            .iter()
            .all(|p| p.width.is_none() && p.height.is_none()));
    }

    #[test]
    fn rejects_more_than_max_pages() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let mut html = String::from("<html><body>");
        for i in 0..=crate::online::MAX_PAGES {
            html.push_str(&format!(r#"<img src="/{i}.png">"#));
        }
        html.push_str("</body></html>");
        let err = parse_gallery(html.as_bytes(), &page, &page)
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("超过上限"), "{err}");
    }

    #[test]
    fn decodes_declared_charset_and_honors_base_href() {
        let source = r#"<html><head><meta charset="gbk"><base href="https://cdn.example/gallery/"><title>中文图集</title></head><body><img src="01.jpg"></body></html>"#;
        let (encoded, _, _) = encoding_rs::GBK.encode(source);
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let meta = parse_gallery(&encoded, &page, &page).unwrap();
        assert_eq!(meta.title, "中文图集");
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "https://cdn.example/gallery/01.jpg");
    }

    #[test]
    fn viewer_prefers_img_id_then_largest_declared_image() {
        let base = url::Url::parse("http://gallery.example/s/hash/100-1").unwrap();
        let with_id = br#"<html><body>
            <img src="/logo.png" class="logo">
            <img id="img" data-src="https://cdn.example/real.jpg">
            </body></html>"#;
        assert_eq!(
            extract_viewer_image(with_id, &base).unwrap(),
            "https://cdn.example/real.jpg"
        );
        let largest = br#"<html><body>
            <img src="/small.jpg" width="200" height="300">
            <img src="/large.jpg" width="800" height="1200">
            </body></html>"#;
        assert_eq!(
            extract_viewer_image(largest, &base).unwrap(),
            "http://gallery.example/large.jpg"
        );
    }

    #[test]
    fn viewer_falls_back_to_og_image_and_reports_missing_content() {
        let base = url::Url::parse("http://gallery.example/s/hash/100-1").unwrap();
        let meta = br#"<html><head>
            <meta property="og:image" content="https://cdn.example/og.jpg">
            </head><body></body></html>"#;
        assert_eq!(
            extract_viewer_image(meta, &base).unwrap(),
            "https://cdn.example/og.jpg"
        );
        let err = extract_viewer_image(b"<html><body>empty</body></html>", &base)
            .unwrap_err()
            .to_string();
        assert!(err.contains("online-html-no-content"), "{err}");
    }

    #[test]
    fn tag_scanner_handles_quotes_comments_and_scripts() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
            <!-- <img src="/hidden.png"> -->
            <script>document.write('<img src="/script.png">')</script>
            <img alt="a > b" src="/real.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 1);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/real.png");
    }

    #[test]
    fn layout_state_suffixes_are_not_structural_chrome() {
        for value in [
            "header-fixed",
            "nav-sticky",
            "sidebar-none",
            "comment-disabled",
            "app-hidden",
            "menu_open",
            "panel-closed",
            "nav-active",
        ] {
            assert!(!is_chrome_class(value), "{value} 不应判为 chrome");
        }
        for value in ["site-header", "ad", "banner", "nav-menu", "footer-links"] {
            assert!(is_chrome_class(value), "{value} 应判为 chrome");
        }
    }

    #[test]
    fn body_layout_state_classes_do_not_poison_direct_content() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = r#"<html><body class="header-fixed sidebar-none comment-disabled nav-sticky">
            <img src="/a.jpg" width="800" height="1200">
            <img src="/b.png" width="800" height="1200">
            <img src="/c.gif" width="800" height="1200">
            <img src="/d.webp" width="800" height="1200">
            <img src="/e.jpg" width="800" height="1200">
            <img src="/f.png" width="800" height="1200">
            </body></html>"#;
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        assert_eq!(meta.page_count, 6);
    }

    #[test]
    fn zero_result_falls_back_to_largest_path_cluster() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let mut html =
            String::from(r#"<html><body><div id="app" class="page-wrapper site-header nav-menu">"#);
        for i in 1..=6 {
            html.push_str(&format!(
                r#"<img src="/pages/{i:03}.jpg" width="800" height="1200">"#
            ));
        }
        html.push_str("</div></body></html>");
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        assert_eq!(meta.page_count, 6);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/pages/001.jpg");
        assert_eq!(stored.pages[5].url, "http://gallery.example/pages/006.jpg");
    }

    #[test]
    fn fallback_still_rejects_clusters_smaller_than_four() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = r#"<html><body><div class="site-header">
            <img src="/a.jpg" width="800" height="1200">
            <img src="/b.png" width="800" height="1200">
            <img src="/c.gif" width="800" height="1200">
            <img src="/d.webp" width="800" height="1200">
            <img src="/e.jpg" width="800" height="1200">
            </div></body></html>"#;
        let err = parse_gallery(html.as_bytes(), &page, &page)
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("online-html-no-content"), "{err}");
    }

    #[test]
    fn inline_next_data_images_are_extracted_when_dom_is_insufficient() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = r#"<html><head>
            <script id="__NEXT_DATA__" type="application/json">
            {"props":{"pageProps":{"images":[
              "https://cdn.example/img/1.jpg",
              "https://cdn.example/img/2.jpg",
              "https://cdn.example/img/3.jpg",
              "https://cdn.example/img/4.jpg"
            ]}}}
            </script></head><body>
            <img src="/cover.jpg" width="800" height="1200">
            </body></html>"#;
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        // 单张跨 host 封面被序列聚类判为 isolated；SSR 的 4 张同构直链为正文。
        assert_eq!(meta.page_count, 4);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://cdn.example/img/1.jpg",
                "https://cdn.example/img/2.jpg",
                "https://cdn.example/img/3.jpg",
                "https://cdn.example/img/4.jpg",
            ]
        );
        assert!(stored.filtered.iter().any(|p| p.reason == "isolated"));
    }

    #[test]
    fn inline_script_image_literals_are_extracted_in_order() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = r#"<html><body>
            <script>
              window.__GALLERY__ = {
                pages: ["https:\/\/cdn.example\/p\/01.webp", "https:\/\/cdn.example\/p\/02.webp"]
              };
            </script>
            </body></html>"#;
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "https://cdn.example/p/01.webp");
        assert_eq!(stored.pages[1].url, "https://cdn.example/p/02.webp");
    }
}
