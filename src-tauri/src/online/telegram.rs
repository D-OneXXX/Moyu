//! Telegram 公开频道/群组的免登录 Web 预览解析。
//!
//! 仅访问 `https://t.me/s/<channel>`、`https://t.me/<channel>/<id>?embed=1`
//! 与 `https://telegra.ph/<slug>` 的公开 HTML，不登录、不读取第三方 Cookie、
//! 不向 WebView 注入脚本。图片直链带时效签名，持久化只保存
//! `channel + message_id + photo_index` 锚点；403/404 时按锚点静默刷新。

use std::collections::HashSet;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::online::direct::{make_filtered_meta, preprobe_missing, MetaLinks, OnlineBookMeta};
use crate::online::filter::{
    filter_candidates, CandidateImage, CandidateSource, FilterMemory, FilterThresholds,
};
use crate::online::http::HttpTransport;
use crate::online::{
    normalize_url, redact_url_for_log, title_from_url, truncate_chars, PageAnchor,
    MANIFEST_MAX_BYTES,
};
use crate::source::BackendError;

/// 公开直读目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramTarget {
    /// 频道主页（可带 `?before=` 分页游标）。
    Channel {
        channel: String,
        before: Option<i64>,
        refresh_base: String,
    },
    /// 单条消息（相册组会一并聚合）。
    Message {
        channel: String,
        message_id: i64,
        refresh_base: String,
    },
    /// Telegraph 单章页面。
    Telegraph { url: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TelegramChapterKind {
    Telegraph,
    Photos,
    Document,
    /// 正文为「章节汇总目录」的消息，本身不是可读章节。
    Index,
}

fn default_downloadable() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// 目录汇总消息里的一个公开章节链接。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramIndexLink {
    pub url: String,
    /// 锚文本；为空时回退到 URL 末段。
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDocument {
    /// 公开 CDN 直链；无 `href` 的登录受限附件为空串。
    pub url: String,
    pub filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// 公开预览是否提供匿名下载直链。`false` 时只能登录 Telegram 下载。
    #[serde(default = "default_downloadable")]
    pub downloadable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChapter {
    /// 稳定标识：`channel/message_id` 或 `channel/group:<grouped_id>`。
    pub id: String,
    pub title: String,
    /// 可再次交给 `resolve_online_url` 的规范化 URL。
    pub url: String,
    pub message_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    pub kind: TelegramChapterKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<TelegramDocument>,
    #[serde(default)]
    pub grouped: bool,
    /// 目录汇总消息展开出的公开章节链接（仅 `Index` 章节非空）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<TelegramIndexLink>,
    /// 章节图集来自消息底部的公开内联按钮，而不是正文直链。
    #[serde(default, skip_serializing_if = "is_false")]
    pub via_inline: bool,
    /// 消息正文中的公开 `#标签`（含 `#`），用于频道内筛选。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannel {
    pub channel: String,
    pub title: String,
    pub chapters: Vec<TelegramChapter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
    pub has_more: bool,
    /// 本次结果是频道内搜索时回显的关键词/`#标签`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

/// 是否为受支持的 Telegram/Telegraph 链接。
pub fn is_telegram_url(raw: &str) -> bool {
    let raw = raw.trim().to_ascii_lowercase();
    raw.starts_with("tg://")
        || raw.starts_with("https://t.me/")
        || raw.starts_with("http://t.me/")
        || raw.starts_with("https://telegram.me/")
        || raw.starts_with("http://telegram.me/")
        || raw.starts_with("https://telegra.ph/")
        || raw.starts_with("http://telegra.ph/")
        || raw.starts_with("https://graph.org/")
        || raw.starts_with("http://graph.org/")
}

/// 调试构建的隔离夹具：`MR_TELEGRAM_TEST_ORIGIN=http://127.0.0.1:PORT`。
/// 仅接受 loopback 地址；release 构建永远返回 None。
fn test_origin() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let origin = std::env::var("MR_TELEGRAM_TEST_ORIGIN").ok()?;
    let origin = origin.trim().trim_end_matches('/').to_string();
    let u = url::Url::parse(&origin).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    if matches!(u.scheme(), "http" | "https") && (host == "127.0.0.1" || host == "localhost") {
        Some(origin)
    } else {
        None
    }
}

/// 把频道/消息/tg:// 链接归一化为受支持目标。
pub fn normalize_target(raw: &str) -> Result<TelegramTarget, BackendError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(BackendError::Msg("Telegram 链接不能为空".into()));
    }
    if let Some(rest) = raw.strip_prefix("tg://resolve?") {
        let mut channel: Option<String> = None;
        let mut post: Option<String> = None;
        for (key, value) in url::form_urlencoded::parse(rest.as_bytes()) {
            let value = value.trim().to_string();
            if value.is_empty() {
                continue;
            }
            match key.as_ref() {
                "domain" if channel.is_none() => channel = Some(value),
                "post" if post.is_none() => post = Some(value),
                _ => {}
            }
        }
        let channel =
            channel.ok_or_else(|| BackendError::Msg("tg:// 链接缺少 domain 参数".into()))?;
        let channel = validate_channel(&channel)?;
        let refresh_base = test_origin().unwrap_or_else(|| "https://t.me".into());
        if let Some(post) = post {
            let message_id = post
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0)
                .ok_or_else(|| BackendError::Msg("tg:// 链接的 post 参数必须是正整数".into()))?;
            return Ok(TelegramTarget::Message {
                channel,
                message_id,
                refresh_base,
            });
        }
        return Ok(TelegramTarget::Channel {
            channel,
            before: None,
            refresh_base,
        });
    }
    let mut u = url::Url::parse(raw).map_err(|e| BackendError::Msg(format!("URL 无效：{e}")))?;
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if matches!(host.as_str(), "telegra.ph" | "graph.org") {
        if !matches!(u.scheme(), "http" | "https") {
            return Err(BackendError::Msg("仅支持 http/https Telegraph URL".into()));
        }
        u.set_query(None);
        u.set_fragment(None);
        let url = if let Some(origin) = test_origin() {
            let slug = u.path().trim_start_matches('/').trim();
            if slug.is_empty() {
                return Err(BackendError::Msg("Telegraph 链接缺少页面名".into()));
            }
            format!("{origin}/telegraph/{slug}")
        } else {
            u.to_string()
        };
        return Ok(TelegramTarget::Telegraph { url });
    }
    if !matches!(host.as_str(), "t.me" | "telegram.me") {
        return Err(BackendError::Msg("不是受支持的 Telegram 链接".into()));
    }
    let segments: Vec<String> = u
        .path_segments()
        .map(|s| s.filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    let Some(first) = segments.first() else {
        return Err(BackendError::Msg("Telegram 链接缺少频道名".into()));
    };
    let channel = if first == "s" {
        segments
            .get(1)
            .cloned()
            .ok_or_else(|| BackendError::Msg("Telegram 预览链接缺少频道名".into()))?
    } else {
        first.clone()
    };
    let channel = validate_channel(&channel)?;
    let message_id = if first == "s" {
        segments.get(2).and_then(|v| v.parse::<i64>().ok())
    } else {
        segments.get(1).and_then(|v| v.parse::<i64>().ok())
    };
    let before = u
        .query_pairs()
        .find(|(k, _)| k == "before")
        .and_then(|(_, v)| v.parse::<i64>().ok())
        .filter(|v| *v > 0);
    let refresh_base = test_origin().unwrap_or_else(|| "https://t.me".into());
    match message_id {
        Some(message_id) if message_id > 0 => Ok(TelegramTarget::Message {
            channel,
            message_id,
            refresh_base,
        }),
        _ => Ok(TelegramTarget::Channel {
            channel,
            before,
            refresh_base,
        }),
    }
}

fn validate_channel(raw: &str) -> Result<String, BackendError> {
    let channel = raw.trim().to_ascii_lowercase();
    if channel.is_empty()
        || channel.len() > 64
        || !channel
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(BackendError::Msg("Telegram 频道名非法".into()));
    }
    Ok(channel)
}

/// 拉取频道页并解析章节列表（`before` 用于向上回溯）。
pub fn fetch_channel(
    http: &dyn HttpTransport,
    raw_url: &str,
    before: Option<i64>,
    query: Option<&str>,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<TelegramChannel, BackendError> {
    let target = normalize_target(raw_url)?;
    let TelegramTarget::Channel {
        channel,
        before: target_before,
        refresh_base,
    } = target
    else {
        return Err(BackendError::Msg("该链接不是 Telegram 频道主页".into()));
    };
    let cursor = before.or(target_before).filter(|v| *v > 0);
    // 深链 `t.me/s/<channel>?q=...` 与显式 query 参数等价；显式参数优先。
    let query = match query.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(sanitize_search_query(value)?),
        None => url_search_query(raw_url)?,
    };
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    if let Some(query) = query.as_deref() {
        params.append_pair("q", query);
    }
    if let Some(cursor) = cursor {
        params.append_pair("before", &cursor.to_string());
    }
    let query_string = params.finish();
    let mut url = format!("{refresh_base}/s/{channel}");
    if !query_string.is_empty() {
        url.push('?');
        url.push_str(&query_string);
    }
    let resp = get_html(http, &url, "https://t.me/")?;
    parse_channel_html(
        &resp,
        &channel,
        &refresh_base,
        cursor,
        query.as_deref(),
        memory,
        thresholds,
    )
}

/// 频道内搜索关键词：保留 `#标签` 原样，只做长度与控制字符校验；
/// 实际编码由 `form_urlencoded` 完成。
fn sanitize_search_query(raw: &str) -> Result<String, BackendError> {
    let query = raw.trim();
    if query.is_empty() {
        return Err(BackendError::Msg(
            "频道内搜索关键词不能为空（telegram-search-invalid）".into(),
        ));
    }
    if query.chars().count() > 120 {
        return Err(BackendError::Msg(
            "频道内搜索关键词不能超过 120 个字符（telegram-search-invalid）".into(),
        ));
    }
    if query.chars().any(char::is_control) {
        return Err(BackendError::Msg(
            "频道内搜索关键词包含非法字符（telegram-search-invalid）".into(),
        ));
    }
    Ok(query.to_string())
}

fn url_search_query(raw_url: &str) -> Result<Option<String>, BackendError> {
    let Ok(parsed) = url::Url::parse(raw_url.trim()) else {
        return Ok(None);
    };
    let Some((_, value)) = parsed.query_pairs().find(|(key, _)| key == "q") else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    sanitize_search_query(value).map(Some)
}

fn parse_channel_html(
    html: &str,
    channel: &str,
    refresh_base: &str,
    cursor: Option<i64>,
    query: Option<&str>,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<TelegramChannel, BackendError> {
    let _ = (refresh_base, cursor);
    let title = channel_title(html).unwrap_or_else(|| channel.to_string());
    let messages = parse_messages(html);
    let groups = group_messages(messages);
    let mut chapters = Vec::new();
    for mut group in groups {
        let message_id = group.first_id;
        let title = chapter_title(&group.text, message_id);
        let grouped = group.messages > 1;
        // 目录汇总消息：正文里至少 2 个公开章节链接，且没有真实正文图集/附件。
        // `group.telegraph` 此时可能只是正文里的第一条链接，不能据此排除目录。
        let index_links = index_links(&group);
        let thin_body = group.photos.len() <= 1
            && group
                .document
                .as_ref()
                .map_or(true, |doc| !doc.downloadable);
        if index_links.len() >= 2 && thin_body {
            chapters.push(TelegramChapter {
                id: format!("{channel}/{message_id}"),
                title,
                url: format!("https://t.me/{channel}/{message_id}"),
                message_id,
                page_count: None,
                kind: TelegramChapterKind::Index,
                document: None,
                grouped,
                links: index_links,
                via_inline: false,
                tags: group.tags.clone(),
            });
            continue;
        }
        let via_inline = adopt_inline_button(&mut group).is_some();
        if group.photos.is_empty()
            && group.telegraph.is_none()
            && group.document.is_none()
            && group.inline_url.is_none()
        {
            continue;
        }
        let (kind, url, page_count, document) = if let Some(document) = group.document {
            (
                TelegramChapterKind::Document,
                format!("https://t.me/{channel}/{message_id}"),
                None,
                Some(document),
            )
        } else if let Some(telegraph) = group.telegraph {
            (TelegramChapterKind::Telegraph, telegraph, None, None)
        } else if let Some(inline_url) = group.inline_url {
            // 同频道相册链接：章节身份仍是源消息，打开时直接解析内联按钮指向的相册。
            (TelegramChapterKind::Photos, inline_url, None, None)
        } else {
            (
                TelegramChapterKind::Photos,
                format!("https://t.me/{channel}/{message_id}"),
                Some(group.photos.len() as u32),
                None,
            )
        };
        chapters.push(TelegramChapter {
            id: format!("{channel}/{message_id}"),
            title,
            url,
            message_id,
            page_count,
            kind,
            document,
            grouped,
            links: Vec::new(),
            via_inline,
            tags: group.tags.clone(),
        });
    }
    chapters.sort_by_key(|c| c.message_id);
    let before = parse_before(html);
    let _ = (cursor, memory, thresholds);
    Ok(TelegramChannel {
        channel: channel.to_string(),
        title,
        chapters,
        before,
        has_more: before.is_some(),
        query: query.map(str::to_string),
    })
}

fn get_html(http: &dyn HttpTransport, url: &str, referer: &str) -> Result<String, BackendError> {
    let resp = http.get(url, MANIFEST_MAX_BYTES, Some(referer), Some(url))?;
    if !(200..300).contains(&resp.status) {
        return Err(BackendError::Network(format!(
            "Telegram 页面 HTTP {}：{}",
            resp.status,
            redact_url_for_log(url)
        )));
    }
    Ok(String::from_utf8_lossy(&resp.body).to_string())
}

/// 解析单条消息 / 相册组 / Telegraph 页面并返回可入库的在线书。
pub fn resolve_book(
    http: &dyn HttpTransport,
    raw_url: &str,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    match normalize_target(raw_url)? {
        TelegramTarget::Telegraph { url } => resolve_telegraph(http, &url, memory, thresholds),
        TelegramTarget::Message {
            channel,
            message_id,
            refresh_base,
        } => resolve_message(
            http,
            &channel,
            message_id,
            &refresh_base,
            memory,
            thresholds,
        ),
        TelegramTarget::Channel { .. } => Err(BackendError::Msg(
            "Telegram 频道主页已识别；请先选择章节再进入阅读器".into(),
        )),
    }
}

fn resolve_message(
    http: &dyn HttpTransport,
    channel: &str,
    message_id: i64,
    refresh_base: &str,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    // 单条消息也可能只有封面图 + 内联按钮；跟随一层同频道相册链接，
    // 但最多两步，避免按钮互相指向形成环。
    let mut current_id = message_id;
    let mut group = fetch_message_group(http, channel, current_id, refresh_base)?;
    for _ in 0..2 {
        match adopt_inline_button(&mut group) {
            Some(InlineAdoption::Telegraph(url)) => {
                return resolve_telegraph(http, &url, memory, thresholds);
            }
            Some(InlineAdoption::Message(target_id)) if target_id != current_id => {
                current_id = target_id;
                group = fetch_message_group(http, channel, target_id, refresh_base)?;
            }
            _ => break,
        }
    }
    resolve_message_group(http, channel, refresh_base, group, memory, thresholds)
}

fn resolve_message_group(
    http: &dyn HttpTransport,
    channel: &str,
    refresh_base: &str,
    group: MessageGroup,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    if group.photos.is_empty() {
        if let Some(telegraph) = group.telegraph.as_deref() {
            return resolve_telegraph(http, telegraph, memory, thresholds);
        }
        if let Some(document) = group.document.as_ref() {
            if document.downloadable {
                return Err(BackendError::Msg("压缩包附件请使用下载按钮导入".into()));
            }
            return Err(document_login_required(document));
        }
        return Err(BackendError::Msg(
            "未找到正文图片；该消息可能是纯文本或贴纸".into(),
        ));
    }
    // 合并后的章节以首条消息为书身份，和频道章节列表保持一致。
    let canonical = url::Url::parse(&format!("https://t.me/{channel}/{}", group.first_id))
        .map_err(|e| BackendError::Msg(format!("Telegram 规范化失败：{e}")))?;
    let title = chapter_title(&group.text, group.first_id);
    let candidates: Vec<CandidateImage> = group
        .photos
        .iter()
        .enumerate()
        .map(|(index, photo)| CandidateImage {
            url: photo.url.clone(),
            width: None,
            height: None,
            dom_index: index,
            main_content: false,
            in_chrome: false,
            container: None,
            class_id: None,
            alt: Some(title.clone()),
            source: CandidateSource::Telegram,
            anchor: Some(PageAnchor {
                channel: channel.to_string(),
                message_id: photo.message_id,
                photo_index: photo.photo_index,
                refresh_base: Some(refresh_base.to_string()),
            }),
        })
        .collect();
    let referer = canonical.as_str().to_string();
    // 白名单来源不做 48 张截断：21 页以上的分包相册必须全部保留。
    let prefetched = if thresholds.probe_missing_dimensions {
        preprobe_missing(http, &referer, &candidates, candidates.len())
    } else {
        std::collections::HashMap::new()
    };
    let mut probe = |candidate: &CandidateImage| prefetched.get(&candidate.url).cloned();
    let outcome = filter_candidates(candidates, memory, thresholds, &mut probe);
    if outcome.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "未找到正文图片（已过滤 {} 张非正文图）",
            outcome.blocked.len()
        )));
    }
    make_filtered_meta(&canonical, &title, outcome, MetaLinks::default())
}

/// 先看目标消息前后 11 条（连续分包相册通常同页）；失败再退回单消息 embed。
fn fetch_message_group(
    http: &dyn HttpTransport,
    channel: &str,
    message_id: i64,
    refresh_base: &str,
) -> Result<MessageGroup, BackendError> {
    let preview_url = format!(
        "{refresh_base}/s/{channel}?before={}",
        message_id.saturating_add(11)
    );
    if let Ok(html) = get_html(http, &preview_url, "https://t.me/") {
        if let Some(group) = find_message_group(&html, message_id) {
            return Ok(group);
        }
    }
    let embed_url = format!("{refresh_base}/{channel}/{message_id}?embed=1");
    let html = get_html(http, &embed_url, "https://t.me/")?;
    find_message_group(&html, message_id)
        .ok_or_else(|| BackendError::Msg("Telegram 消息页没有可解析内容".into()))
}

fn find_message_group(html: &str, message_id: i64) -> Option<MessageGroup> {
    group_messages(parse_messages(html))
        .into_iter()
        .find(|group| group.member_ids.contains(&message_id))
}

fn resolve_telegraph(
    http: &dyn HttpTransport,
    url: &str,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    let canonical = normalize_url(url)?;
    let html = get_html(http, canonical.as_str(), "https://telegra.ph/")?;
    let title = telegraph_title(&html).unwrap_or_else(|| title_from_url(&canonical));
    let article = extract_article(&html);
    let img_re = Regex::new(r"(?is)<img\b[^>]*>").expect("img regex");
    let src_re = Regex::new(r#"(?is)\bsrc\s*=\s*["']([^"']+)["']"#).expect("src regex");
    let data_re = Regex::new(r#"(?is)\bdata-src\s*=\s*["']([^"']+)["']"#).expect("data regex");
    let width_re = Regex::new(r#"(?is)\b(?:width|data-width)\s*=\s*["']?(\d+)"#).expect("w regex");
    let height_re =
        Regex::new(r#"(?is)\b(?:height|data-height)\s*=\s*["']?(\d+)"#).expect("h regex");
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for tag in img_re.find_iter(article) {
        let tag = tag.as_str();
        let raw = data_re
            .captures(tag)
            .or_else(|| src_re.captures(tag))
            .map(|c| decode_entities(c[1].trim()))
            .unwrap_or_default();
        if raw.is_empty() || raw.starts_with("data:") || raw.starts_with("blob:") {
            continue;
        }
        let lower = raw.to_ascii_lowercase();
        if lower.ends_with(".svg") || lower.ends_with(".ico") {
            continue;
        }
        let Ok(joined) = canonical.join(&raw) else {
            continue;
        };
        let Ok(url) = normalize_url(joined.as_str()) else {
            continue;
        };
        let url = url.to_string();
        if !seen.insert(url.clone()) {
            continue;
        }
        let width = width_re
            .captures(tag)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|v| *v > 0);
        let height = height_re
            .captures(tag)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|v| *v > 0);
        candidates.push(CandidateImage {
            url,
            width,
            height,
            dom_index: candidates.len(),
            main_content: true,
            in_chrome: false,
            container: Some("article".into()),
            class_id: None,
            alt: None,
            source: CandidateSource::Telegraph,
            anchor: None,
        });
    }
    if candidates.is_empty() {
        return Err(BackendError::Msg("Telegraph 页面未找到图片".into()));
    }
    let referer = canonical.as_str().to_string();
    let prefetched = if thresholds.probe_missing_dimensions {
        preprobe_missing(http, &referer, &candidates, candidates.len())
    } else {
        std::collections::HashMap::new()
    };
    let mut probe = |candidate: &CandidateImage| prefetched.get(&candidate.url).cloned();
    let outcome = filter_candidates(candidates, memory, thresholds, &mut probe);
    if outcome.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "Telegraph 图片均被判定为非正文图（已过滤 {} 张）",
            outcome.blocked.len()
        )));
    }
    let title = truncate_chars(&title, 200);
    make_filtered_meta(&canonical, &title, outcome, MetaLinks::default())
}

/// 图片直链 403/404 时按锚点重新请求消息页，返回新的直链。
pub fn refresh_page_url(
    http: &dyn HttpTransport,
    anchor: &PageAnchor,
) -> Result<Option<String>, BackendError> {
    let base = anchor
        .refresh_base
        .as_deref()
        .unwrap_or("https://t.me")
        .trim_end_matches('/');
    let base_url =
        url::Url::parse(base).map_err(|e| BackendError::Msg(format!("刷新基地址无效：{e}")))?;
    let host = base_url.host_str().unwrap_or("").to_ascii_lowercase();
    let local = host == "127.0.0.1" || host == "localhost";
    if !matches!(base_url.scheme(), "http" | "https")
        || !(matches!(host.as_str(), "t.me" | "telegram.me") || local)
    {
        return Err(BackendError::Msg("刷新基地址不在允许范围".into()));
    }
    let url = format!("{base}/{}/{}?embed=1", anchor.channel, anchor.message_id);
    let html = get_html(http, &url, "https://t.me/")?;
    let photos = parse_messages(&html)
        .into_iter()
        .find(|m| m.id == anchor.message_id)
        .or_else(|| parse_messages(&html).into_iter().next())
        .map(|m| m.photos)
        .unwrap_or_default();
    // 只返回锚点对应的图片；相册顺序异常时宁可失败重试，也不能悄悄
    // 把另一页当成当前页。
    Ok(photos.get(anchor.photo_index as usize).cloned())
}

// ---------- HTML parsing helpers ----------

#[derive(Debug, Clone, Default)]
struct ParsedMessage {
    id: i64,
    grouped_id: Option<String>,
    published: Option<i64>,
    text: String,
    photos: Vec<String>,
    telegraph: Option<String>,
    document: Option<TelegramDocument>,
    /// 消息底部的公开内联按钮目标（已按同频道/公开站点过滤）。
    inline: Vec<InlineTarget>,
    /// 正文中指向公开章节的链接（目录汇总消息）。
    links: Vec<TelegramIndexLink>,
    /// 正文中的公开 `#标签`（含 `#`）。
    tags: Vec<String>,
}

/// 内联按钮可跟随的公开目标。
#[derive(Debug, Clone, PartialEq, Eq)]
enum InlineTarget {
    Telegraph(String),
    Message { url: String, message_id: i64 },
}

/// 采用内联按钮后的实际动作。
#[derive(Debug, Clone, PartialEq, Eq)]
enum InlineAdoption {
    Telegraph(String),
    Message(i64),
}

#[derive(Debug, Clone)]
struct GroupPhoto {
    /// 图片实际所在消息；跨相册合并后仍按该消息刷新直链。
    message_id: i64,
    /// 该消息内部的 photo 序号。
    photo_index: u32,
    url: String,
}

#[derive(Debug, Clone)]
struct MessageGroup {
    first_id: i64,
    messages: usize,
    text: String,
    last_text: String,
    published: Option<i64>,
    last_published: Option<i64>,
    photos: Vec<GroupPhoto>,
    telegraph: Option<String>,
    document: Option<TelegramDocument>,
    inline: Vec<InlineTarget>,
    /// 已采用的内联同频道相册链接。
    inline_url: Option<String>,
    links: Vec<TelegramIndexLink>,
    tags: Vec<String>,
    member_ids: Vec<i64>,
}

impl MessageGroup {
    fn from_message(message: ParsedMessage) -> Self {
        let photos = message
            .photos
            .iter()
            .enumerate()
            .map(|(index, url)| GroupPhoto {
                message_id: message.id,
                photo_index: index as u32,
                url: url.clone(),
            })
            .collect();
        Self {
            first_id: message.id,
            messages: 1,
            text: message.text.clone(),
            last_text: message.text,
            published: message.published,
            last_published: message.published,
            photos,
            telegraph: message.telegraph,
            document: message.document,
            inline: message.inline,
            inline_url: None,
            links: message.links,
            tags: message.tags,
            member_ids: vec![message.id],
        }
    }

    fn push(&mut self, message: ParsedMessage) {
        self.messages += 1;
        if self.text.is_empty() {
            self.text = message.text.clone();
        }
        for (index, url) in message.photos.iter().enumerate() {
            self.photos.push(GroupPhoto {
                message_id: message.id,
                photo_index: index as u32,
                url: url.clone(),
            });
        }
        if self.telegraph.is_none() {
            self.telegraph = message.telegraph;
        }
        if self.document.is_none() {
            self.document = message.document;
        }
        if self.inline.is_empty() {
            self.inline = message.inline;
        }
        merge_index_links(&mut self.links, message.links);
        merge_tags(&mut self.tags, message.tags);
        self.last_text = message.text;
        self.last_published = message.published;
        self.member_ids.push(message.id);
    }

    fn absorb(&mut self, other: MessageGroup) {
        self.messages += other.messages;
        self.photos.extend(other.photos);
        self.member_ids.extend(other.member_ids);
        if self.telegraph.is_none() {
            self.telegraph = other.telegraph;
        }
        if self.document.is_none() {
            self.document = other.document;
        }
        if self.inline.is_empty() {
            self.inline = other.inline;
        }
        merge_index_links(&mut self.links, other.links);
        merge_tags(&mut self.tags, other.tags);
        self.last_text = other.last_text;
        self.last_published = other.last_published;
    }

    fn photo_only(&self) -> bool {
        self.telegraph.is_none() && self.document.is_none() && !self.photos.is_empty()
    }
}

fn parse_messages(html: &str) -> Vec<ParsedMessage> {
    let wrap_re =
        Regex::new(r#"(?is)<div[^>]*class="(?:[^"]*\s)?tgme_widget_message(?:\s[^"]*)?"[^>]*>"#)
            .expect("message regex");
    let time_re =
        Regex::new(r#"(?is)<time[^>]*datetime\s*=\s*["']([^"']+)["']"#).expect("time regex");
    let mut starts = Vec::new();
    for m in wrap_re.find_iter(html) {
        starts.push((m.start(), m.end(), m.as_str().to_string()));
    }
    let mut out = Vec::new();
    for (index, (start, tag_end, tag)) in starts.iter().enumerate() {
        let end = starts
            .get(index + 1)
            .map(|(next, _, _)| *next)
            .unwrap_or(html.len());
        let block = &html[*tag_end..end];
        let Some(post) = attr(tag, "data-post") else {
            continue;
        };
        let Some(id) = post.rsplit('/').next().and_then(|v| v.parse::<i64>().ok()) else {
            continue;
        };
        let grouped_id = attr(tag, "data-grouped-id").filter(|v| !v.trim().is_empty());
        let published = time_re
            .captures(block)
            .and_then(|caps| chrono::DateTime::parse_from_rfc3339(caps[1].trim()).ok())
            .map(|time| time.timestamp());
        let post_channel = post
            .rsplit_once('/')
            .map(|(channel, _)| channel.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let text = message_text(block);
        let photos = message_photos(block);
        let telegraph = telegraph_link(block);
        let document = message_document(block);
        let inline = inline_targets(block, &post_channel, id);
        let links = message_text_links(block, &post_channel, id);
        let tags = message_tags(&text);
        let _ = start;
        out.push(ParsedMessage {
            id,
            grouped_id,
            published,
            text,
            photos,
            telegraph,
            document,
            inline,
            links,
            tags,
        });
    }
    out.sort_by_key(|m| m.id);
    out
}

fn merge_index_links(target: &mut Vec<TelegramIndexLink>, incoming: Vec<TelegramIndexLink>) {
    for link in incoming {
        if target.iter().any(|existing| existing.url == link.url) {
            continue;
        }
        if target.len() >= 100 {
            break;
        }
        target.push(link);
    }
}

fn merge_tags(target: &mut Vec<String>, incoming: Vec<String>) {
    for tag in incoming {
        if target.len() >= 12 {
            break;
        }
        if !target.iter().any(|existing| existing == &tag) {
            target.push(tag);
        }
    }
}

/// 目录汇总消息的候选链接：只为每个章节保留首次出现的 URL。
fn index_links(group: &MessageGroup) -> Vec<TelegramIndexLink> {
    let mut links = Vec::new();
    merge_index_links(&mut links, group.links.clone());
    links
}

/// 采用可跟随的内联按钮；只有「薄正文」（≤1 张封面、无直链附件/图集）
/// 才允许覆盖正文来源，避免把正常相册误改成按钮目标。
fn adopt_inline_button(group: &mut MessageGroup) -> Option<InlineAdoption> {
    if group.telegraph.is_some() || group.inline_url.is_some() {
        return None;
    }
    let thin = group.photos.len() <= 1
        && group
            .document
            .as_ref()
            .map_or(true, |document| !document.downloadable);
    if !thin {
        return None;
    }
    let target = group.inline.first()?.clone();
    match target {
        InlineTarget::Telegraph(url) => {
            group.telegraph = Some(url.clone());
            group.photos.clear();
            group.document = None;
            Some(InlineAdoption::Telegraph(url))
        }
        InlineTarget::Message { url, message_id } => {
            group.inline_url = Some(url);
            group.photos.clear();
            group.document = None;
            Some(InlineAdoption::Message(message_id))
        }
    }
}

fn group_messages(messages: Vec<ParsedMessage>) -> Vec<MessageGroup> {
    // 第一阶段：同一 grouped_id 的相册成员聚合。
    let mut groups: Vec<MessageGroup> = Vec::new();
    let mut grouped_positions: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for message in messages {
        if let Some(grouped_id) = message.grouped_id.as_deref() {
            if let Some(&position) = grouped_positions.get(grouped_id) {
                groups[position].push(message);
                continue;
            }
        }
        if let Some(grouped_id) = message.grouped_id.clone() {
            grouped_positions.insert(grouped_id, groups.len());
        }
        groups.push(MessageGroup::from_message(message));
    }
    // 第二阶段：Telegram 单相册上限 10 图，连续分包相册按时间/标题合并。
    let mut merged: Vec<MessageGroup> = Vec::new();
    for group in groups {
        if let Some(last) = merged.last_mut() {
            if can_merge_adjacent(last, &group) {
                last.absorb(group);
                continue;
            }
        }
        merged.push(group);
    }
    merged
}

fn can_merge_adjacent(previous: &MessageGroup, current: &MessageGroup) -> bool {
    if !previous.photo_only() || !current.photo_only() {
        return false;
    }
    let time_ok = match (previous.last_published, current.published) {
        (Some(previous_time), Some(current_time)) => (current_time - previous_time).abs() <= 180,
        // 旧预览页没有 <time>：保留原相邻 message id 规则。
        _ => current.first_id - previous.first_id <= 1,
    };
    if !time_ok {
        return false;
    }
    let current_title = first_line(&current.text);
    let previous_title = first_line(&previous.text);
    current.text.trim().is_empty()
        || current_title == previous_title
        || current.text.trim() == previous.last_text.trim()
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn channel_title(html: &str) -> Option<String> {
    let meta = Regex::new(
        r#"(?is)<meta[^>]+(?:property|name)\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["']"#,
    )
    .ok()?;
    let meta2 = Regex::new(
        r#"(?is)<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']og:title["']"#,
    )
    .ok()?;
    meta.captures(html)
        .or_else(|| meta2.captures(html))
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let re = Regex::new(
                r#"(?is)<div[^>]*class="[^"]*tgme_channel_info_header_title[^"]*"[^>]*>(.*?)</div>"#,
            )
            .ok()?;
            re.captures(html)
                .map(|c| decode_entities(&strip_tags(&c[1])))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

fn telegraph_title(html: &str) -> Option<String> {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    re.captures(html)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn extract_article(html: &str) -> &str {
    // Telegraph 的正文有两种常见结构：<article id="_tl_editor"> 与
    // <div class="tl_article_content">。先精确匹配，再退回任意 article。
    let exact = Regex::new(
        r#"(?is)<article\b[^>]*(?:id\s*=\s*["']_tl_editor["']|class\s*=\s*["'][^"']*tl_article_content)[^>]*>(.*?)</article>"#,
    )
    .expect("telegraph article regex");
    if let Some(article) = exact.captures(html).and_then(|c| c.get(1)) {
        return article.as_str();
    }
    let any_article = Regex::new(r"(?is)<article\b[^>]*>(.*?)</article>").expect("article regex");
    if let Some(article) = any_article.captures(html).and_then(|c| c.get(1)) {
        return article.as_str();
    }
    extract_class_div(html, "tl_article_content").unwrap_or(html)
}

/// 深度感知地截取指定 class 的 div 子树，避免嵌套 div 被首个 `</div>` 截断。
fn extract_class_div<'a>(html: &'a str, token: &str) -> Option<&'a str> {
    let mut pos = 0usize;
    let mut content_start = None;
    let mut depth = 0usize;
    while let Some((start, end)) = crate::online::html::next_tag(html, pos) {
        pos = end;
        let tag = &html[start..end];
        let closing = tag.trim_start().starts_with("</");
        let Some(name) = crate::online::html::tag_name(tag) else {
            continue;
        };
        if content_start.is_none() {
            if !closing && name == "div" {
                let attrs = crate::online::html::parse_attrs(tag);
                let matches = crate::online::html::attr_value(&attrs, "class")
                    .map(|value| value.to_ascii_lowercase().contains(token))
                    .unwrap_or(false);
                if matches && !tag.trim_end().ends_with("/>") {
                    content_start = Some(end);
                    depth = 1;
                }
            }
            continue;
        }
        if name != "div" {
            continue;
        }
        if closing {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(&html[content_start?..start]);
            }
        } else if !tag.trim_end().ends_with("/>") {
            depth += 1;
        }
    }
    None
}

/// 消息正文的原始 HTML（保留链接锚文本），供目录汇总/标签/文内链接解析。
fn message_text_html(block: &str) -> Option<&str> {
    let re =
        Regex::new(r#"(?is)<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>"#)
            .expect("text regex");
    re.captures(block)
        .and_then(|caps| caps.get(1))
        .map(|inner| inner.as_str())
}

fn message_text(block: &str) -> String {
    message_text_html(block)
        .map(|html| decode_entities(&strip_tags(html)).replace('\u{00a0}', " "))
        .unwrap_or_default()
}

/// 正文中的公开 `#标签`：只保留 `#` + 字母/数字/下划线，最多 12 个。
fn message_tags(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for token in text.split_whitespace() {
        let Some(rest) = token.strip_prefix('#') else {
            continue;
        };
        // 标签允许紧跟中文标点/英文句读；只取连续的字母数字下划线。
        let mut tag = String::from("#");
        for ch in rest.chars() {
            if ch.is_alphanumeric() || ch == '_' {
                tag.push(ch);
            } else {
                break;
            }
        }
        if tag.chars().count() <= 1 || tag.chars().count() > 33 {
            continue;
        }
        if !tags.iter().any(|existing| existing == &tag) {
            tags.push(tag);
        }
        if tags.len() >= 12 {
            break;
        }
    }
    tags
}

/// 正文中的公开章节链接：`telegra.ph` / `graph.org` 页面或同频道消息。
fn message_text_links(block: &str, channel: &str, message_id: i64) -> Vec<TelegramIndexLink> {
    let Some(text) = message_text_html(block) else {
        return Vec::new();
    };
    let anchor = Regex::new(r#"(?is)<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .expect("text link regex");
    let mut links: Vec<TelegramIndexLink> = Vec::new();
    for caps in anchor.captures_iter(text) {
        let Some(target) = public_album_link(&caps[1], channel) else {
            continue;
        };
        if let PublicAlbumLink::Message {
            message_id: target_id,
            ..
        } = &target
        {
            if *target_id == message_id {
                continue;
            }
        }
        if links.len() >= 100 {
            break;
        }
        let title = decode_entities(&strip_tags(&caps[2]))
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let title = truncate_chars(&title, 120);
        let (url, fallback) = match target {
            PublicAlbumLink::Telegraph { url } => {
                let fallback = url
                    .rsplit('/')
                    .find(|segment| !segment.is_empty())
                    .unwrap_or("Telegraph")
                    .to_string();
                (url, fallback)
            }
            PublicAlbumLink::Message { url, message_id } => (url, format!("消息 {message_id}")),
        };
        let title = if title.is_empty() { fallback } else { title };
        if links.iter().any(|existing| existing.url == url) {
            continue;
        }
        links.push(TelegramIndexLink { url, title });
    }
    links
}

/// 消息底部的公开内联按钮目标；过滤跨频道、图片 CDN 与自指消息。
fn inline_targets(block: &str, channel: &str, message_id: i64) -> Vec<InlineTarget> {
    let marker =
        Regex::new(r#"(?is)class\s*=\s*["'][^"']*\btgme_widget_message_inline_button\b[^"']*["']"#)
            .expect("inline marker regex");
    let anchor_re = Regex::new(r"(?is)<a\b[^>]*>").expect("anchor regex");
    let mut targets: Vec<InlineTarget> = Vec::new();
    for marker in marker.find_iter(block) {
        let tag_start = block[..marker.start()].rfind('<').unwrap_or(marker.start());
        let tag_end = block[marker.end()..]
            .find('>')
            .map(|offset| marker.end() + offset + 1)
            .unwrap_or(block.len());
        let mut tag = &block[tag_start..tag_end];
        if !tag.trim_start().starts_with("<a") {
            // 部分预览页把 class 放在外层 div 上，href 在前面的 <a> 内。
            tag = anchor_re
                .find(&block[tag_end..])
                .map(|found| {
                    let start = tag_end + found.start();
                    let end = tag_end + found.end();
                    &block[start..end]
                })
                .unwrap_or("");
        }
        let Some(href) = attr(tag, "href") else {
            continue;
        };
        let Some(target) = public_album_link(&href, channel) else {
            continue;
        };
        if let PublicAlbumLink::Message {
            message_id: target_id,
            ..
        } = &target
        {
            if *target_id == message_id {
                continue;
            }
        }
        let inline = match target {
            PublicAlbumLink::Telegraph { url, .. } => InlineTarget::Telegraph(url),
            PublicAlbumLink::Message { url, message_id } => {
                InlineTarget::Message { url, message_id }
            }
        };
        if !targets.iter().any(|existing| existing == &inline) {
            targets.push(inline);
        }
        if targets.len() >= 8 {
            break;
        }
    }
    targets
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PublicAlbumLink {
    Telegraph { url: String },
    Message { url: String, message_id: i64 },
}

/// 归一化公开章节链接：
/// - `telegra.ph` / `graph.org` 页面（排除 `/file/...` 图片 CDN）；
/// - 与当前消息同频道的 `t.me/<channel>/<id>` 消息链接。
fn public_album_link(raw: &str, channel: &str) -> Option<PublicAlbumLink> {
    let raw = decode_entities(raw.trim());
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with('#')
        || lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
        || lower.starts_with("tg:")
    {
        return None;
    }
    let absolute = if raw.starts_with("//") {
        format!("https:{raw}")
    } else if raw.starts_with('/') {
        format!("https://t.me{raw}")
    } else {
        raw
    };
    let mut url = url::Url::parse(&absolute).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if matches!(host.as_str(), "telegra.ph" | "graph.org") {
        let segments: Vec<&str> = url
            .path_segments()
            .map(|segments| segments.filter(|part| !part.is_empty()).collect())
            .unwrap_or_default();
        let slug = *segments.first()?;
        if slug.eq_ignore_ascii_case("file") {
            return None;
        }
        url.set_query(None);
        url.set_fragment(None);
        return Some(PublicAlbumLink::Telegraph {
            url: url.to_string(),
        });
    }
    if !matches!(host.as_str(), "t.me" | "telegram.me") {
        return None;
    }
    let mut segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();
    if segments.first().copied() == Some("s") {
        segments.remove(0);
    }
    if segments.len() < 2 {
        return None;
    }
    let target_channel = segments[0].to_ascii_lowercase();
    if !channel.is_empty() && target_channel != channel.to_ascii_lowercase() {
        return None;
    }
    let message_id = segments[1].parse::<i64>().ok().filter(|id| *id > 0)?;
    Some(PublicAlbumLink::Message {
        url: format!("https://t.me/{target_channel}/{message_id}"),
        message_id,
    })
}

fn message_photos(block: &str) -> Vec<String> {
    let wrap = Regex::new(r#"(?is)<a[^>]*class="[^"]*tgme_widget_message_photo_wrap[^"]*"[^>]*>"#)
        .expect("photo regex");
    let style = Regex::new(r#"(?is)background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)"#)
        .expect("style regex");
    let img = Regex::new(r#"(?is)<img[^>]+src\s*=\s*["']([^"']+)["']"#).expect("img regex");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for wrapper in wrap.find_iter(block) {
        let tag = wrapper.as_str();
        let raw = style
            .captures(tag)
            .map(|c| c[1].trim().to_string())
            .or_else(|| {
                let end = block[wrapper.end()..]
                    .find("</a>")
                    .map(|offset| wrapper.end() + offset)
                    .unwrap_or(block.len());
                img.captures(&block[wrapper.start()..end])
                    .map(|c| c[1].trim().to_string())
            });
        let Some(raw) = raw else {
            continue;
        };
        let raw = decode_entities(&raw);
        let raw = if raw.starts_with("//") {
            format!("https:{raw}")
        } else if raw.starts_with('/') {
            format!("https://t.me{raw}")
        } else {
            raw
        };
        if let Ok(url) = normalize_url(&raw) {
            let url = url.to_string();
            if seen.insert(url.clone()) {
                out.push(url);
            }
        }
    }
    out
}

fn telegraph_link(block: &str) -> Option<String> {
    // 只看正文，避免把消息底部内联按钮当成正文直链；内联按钮由
    // `inline_targets` 单独处理并带有“薄正文”门控。
    let text = message_text_html(block)?;
    let re = Regex::new(r#"(?is)https?://(?:telegra\.ph|graph\.org)/([A-Za-z0-9_-]+)"#).ok()?;
    let found = re
        .captures_iter(text)
        .find(|caps| !caps[1].eq_ignore_ascii_case("file"))
        .map(|caps| decode_entities(caps[0].trim()))
        .filter(|url| url::Url::parse(url).is_ok());
    found
}

fn human_size(size: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = size as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", size, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// 登录受限附件的稳定错误。括号内的 JSON 由桌面端解析为文件名/大小，
/// 不会包含 CDN 地址或任何凭据，也不会进入日志。
fn document_login_required(document: &TelegramDocument) -> BackendError {
    let size = document
        .size
        .map(human_size)
        .unwrap_or_else(|| "大小未知".to_string());
    let details = serde_json::json!({
        "filename": document.filename,
        "size": document.size,
    })
    .to_string();
    BackendError::Msg(format!(
        "检测到 Telegram 频道文件附件（{}，{}）。受 Telegram 官方限制，文件附件需登录账号后下载 {details}（telegram-document-login-required）",
        document.filename, size
    ))
}

fn archive_extension(name: &str, allow_7z: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    [".zip", ".cbz", ".rar", ".cbr"]
        .iter()
        .any(|ext| lower.ends_with(ext))
        || (allow_7z && lower.ends_with(".7z"))
}

/// 是否为 `t.me/<channel>/<id>` 或 `/s/<channel>/<id>` 消息页（而非文件直链）。
fn is_telegram_message_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if !matches!(host.as_str(), "t.me" | "telegram.me") {
        return false;
    }
    let mut segments = url
        .path_segments()
        .map(|segments| segments.filter(|part| !part.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.first().copied() == Some("s") {
        segments.remove(0);
    }
    segments.len() >= 2
        && !segments[0].is_empty()
        && segments[1].bytes().all(|byte| byte.is_ascii_digit())
        && !segments[1].is_empty()
}

fn message_document(block: &str) -> Option<TelegramDocument> {
    // 公开预览有两种形态：
    // - `<a class="tgme_widget_message_document_wrap" href="…">` 有匿名直链；
    // - `<div class="tgme_widget_message_document">` 只有文件名/体积，
    //   Telegram 官方要求登录后才允许下载。
    let open = Regex::new(
        r#"(?is)<(?:a|div)[^>]*class="[^"]*\btgme_widget_message_document(?:_wrap)?\b[^"]*"[^>]*>"#,
    )
    .ok()?;
    let found = open.find(block)?;
    let tag = found.as_str();
    let mut window_end = (found.end() + 2048).min(block.len());
    // 附件前后的中文说明可能让固定字节窗口落在多字节字符中间；
    // 向前扩到字符边界，避免 &str 切片 panic。
    while window_end < block.len() && !block.is_char_boundary(window_end) {
        window_end += 1;
    }
    let window = &block[found.start()..window_end];

    let href = attr(tag, "href")
        .map(|raw| decode_entities(raw.trim()))
        .filter(|value| !value.is_empty());
    let href_present = href.is_some();
    let mut url = href.and_then(|raw| {
        let absolute = if raw.starts_with("//") {
            format!("https:{raw}")
        } else if raw.starts_with('/') {
            format!("https://t.me{raw}")
        } else {
            raw
        };
        normalize_url(&absolute).ok().map(|url| url.to_string())
    });
    // 部分公开预览把附件包在指向消息自身的 `<a href="t.me/channel/id">` 里，
    // 这不是文件直链；按登录受限占位处理，绝不能把 HTML 当压缩包下载。
    let self_message_href = url.as_deref().is_some_and(is_telegram_message_url);
    if self_message_href {
        url = None;
    }
    // 有 href 但不符合在线 URL 策略（私网/凭据/file:）时必须失败关闭，
    // 不能降级成“登录受限附件”，否则会把危险链接伪装成用户可下载项。
    if href_present && url.is_none() && !self_message_href {
        return None;
    }

    let text = Regex::new(r#"(?is)^<(?:a|div)[^>]*>(.*?)</(?:a|div)>"#)
        .ok()
        .and_then(|re| re.captures(window))
        .map(|caps| decode_entities(&strip_tags(&caps[1])))
        .unwrap_or_default();
    let title =
        Regex::new(r#"(?is)class="[^"]*tgme_widget_message_document_title[^"]*"[^>]*>(.*?)<"#)
            .ok()
            .and_then(|re| re.captures(window))
            .map(|caps| decode_entities(&strip_tags(&caps[1])))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    let filename = title
        .or_else(|| text.split_whitespace().next().map(str::to_string))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            url.as_deref()
                .and_then(|url| url::Url::parse(url).ok())
                .and_then(|url| {
                    url.path_segments()
                        .and_then(|mut segments| segments.rfind(|item| !item.is_empty()))
                        .map(str::to_string)
                })
        })
        .unwrap_or_else(|| "telegram-file".into());

    // 直链只接受现有导入管线支持的格式；纯占位附件额外识别 7z，
    // 让用户至少能得到「需登录下载」的明确引导。
    let downloadable = url.is_some();
    let candidate = url.as_deref().unwrap_or(&filename);
    if !archive_extension(candidate, !downloadable) && !archive_extension(&filename, !downloadable)
    {
        return None;
    }

    let size = Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(KB|MB|GB)")
        .ok()
        .and_then(|re| re.captures(window))
        .and_then(|caps| {
            let value = caps[1].parse::<f64>().ok()?;
            let unit = caps[2].to_ascii_uppercase();
            let multiplier = match unit.as_str() {
                "KB" => 1024.0,
                "MB" => 1024.0 * 1024.0,
                "GB" => 1024.0 * 1024.0 * 1024.0,
                _ => 1.0,
            };
            Some((value * multiplier) as u64)
        });
    Some(TelegramDocument {
        url: url.unwrap_or_default(),
        filename,
        size,
        downloadable,
    })
}

fn parse_before(html: &str) -> Option<i64> {
    let re = Regex::new(r#"(?i)(?:href|data-before)\s*=\s*["'][^"']*before=(\d+)"#).ok()?;
    re.captures(html)
        .and_then(|c| c[1].parse::<i64>().ok())
        .filter(|v| *v > 0)
}

fn chapter_title(text: &str, message_id: i64) -> String {
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let cleaned = first
        .split_whitespace()
        .filter(|token| !token.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    let title = if cleaned.is_empty() {
        format!("消息 {message_id}")
    } else {
        cleaned
    };
    truncate_chars(&title, 120)
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        regex::escape(name)
    );
    let re = Regex::new(&pattern).ok()?;
    re.captures(tag)
        .and_then(|c| c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)))
        .map(|m| m.as_str().to_string())
}

fn strip_tags(s: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .expect("strip regex")
        .replace_all(s, "")
        .to_string()
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;
    use crate::online::http::HttpResponse;
    use crate::online::OnlineError;

    struct MapHttp {
        responses: HashMap<String, (u16, Vec<u8>)>,
        calls: Mutex<Vec<String>>,
    }

    impl MapHttp {
        fn new(responses: Vec<(&str, u16, Vec<u8>)>) -> Self {
            Self {
                responses: responses
                    .into_iter()
                    .map(|(url, status, body)| (url.to_string(), (status, body)))
                    .collect(),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for MapHttp {
        fn get(
            &self,
            url: &str,
            _max: usize,
            _referer: Option<&str>,
            _scope: Option<&str>,
        ) -> Result<HttpResponse, OnlineError> {
            self.calls.lock().unwrap().push(url.to_string());
            if let Some((status, body)) = self.responses.get(url) {
                Ok(HttpResponse {
                    status: *status,
                    final_url: url.to_string(),
                    content_type: Some("text/html".into()),
                    body: body.clone(),
                })
            } else {
                Ok(HttpResponse {
                    status: 404,
                    final_url: url.to_string(),
                    content_type: None,
                    body: Vec::new(),
                })
            }
        }
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(
                &vec![120u8; (width * height * 4) as usize],
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        buf
    }

    fn channel_html() -> String {
        r#"<html><head><meta property="og:title" content="QA Channel"></head><body>
        <div class="tgme_widget_message" data-post="demo/101">
          <a class="tgme_widget_message_user_photo"><img src="https://cdn/avatar.png"></a>
          <div class="tgme_widget_message_text">频道公告：闲聊</div>
        </div>
        <div class="tgme_widget_message" data-post="demo/102" data-grouped-id="g1">
          <div class="tgme_widget_message_text">第01话 相册</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/1.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/2.png')"></a>
        </div>
        <div class="tgme_widget_message" data-post="demo/103" data-grouped-id="g1">
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/3.png')"></a>
        </div>
        <div class="tgme_widget_message" data-post="demo/104">
          <div class="tgme_widget_message_text">第02话 <a href="https://telegra.ph/QA-Test-01">telegraph</a></div>
        </div>
        <div class="tgme_widget_message" data-post="demo/105">
          <div class="tgme_widget_message_text">第03话 附件</div>
          <a class="tgme_widget_message_document_wrap" href="https://cdn/ch3.zip">ch3.zip 12 MB</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/106">
          <i class="tgme_widget_message_sticker"></i>
        </div>
        <a class="tme_messages_more" href="?before=99">more</a>
        </body></html>"#
            .to_string()
    }

    #[test]
    fn normalizes_telegram_url_forms() {
        assert_eq!(
            normalize_target("https://t.me/s/Demo_Channel").unwrap(),
            TelegramTarget::Channel {
                channel: "demo_channel".into(),
                before: None,
                refresh_base: "https://t.me".into(),
            }
        );
        assert_eq!(
            normalize_target("https://t.me/demo/123").unwrap(),
            TelegramTarget::Message {
                channel: "demo".into(),
                message_id: 123,
                refresh_base: "https://t.me".into(),
            }
        );
        assert_eq!(
            normalize_target("tg://resolve?domain=demo").unwrap(),
            TelegramTarget::Channel {
                channel: "demo".into(),
                before: None,
                refresh_base: "https://t.me".into(),
            }
        );
        assert_eq!(
            normalize_target("tg://resolve?domain=demo&post=42").unwrap(),
            TelegramTarget::Message {
                channel: "demo".into(),
                message_id: 42,
                refresh_base: "https://t.me".into(),
            }
        );
        assert!(normalize_target("tg://resolve?domain=demo&post=abc").is_err());
        assert!(normalize_target("https://example.com/x").is_err());
        assert!(normalize_target("https://t.me/bad name").is_err());
    }

    #[test]
    fn document_urls_follow_online_url_policy() {
        let link = |url: &str| {
            format!(r#"<a class="tgme_widget_message_document_wrap" href="{url}">chapter.cbz</a>"#)
        };
        for url in [
            "http://169.254.169.254/file.cbz",
            "https://user:pass@example.com/file.cbz",
            "file:///file.cbz",
        ] {
            assert!(message_document(&link(url)).is_none(), "accepted {url}");
        }
        assert_eq!(
            message_document(&link("//example.com/file.cbz#part"))
                .unwrap()
                .url,
            "https://example.com/file.cbz"
        );
        assert_eq!(
            message_document(&link("/file.cbz")).unwrap().url,
            "https://t.me/file.cbz"
        );
    }

    #[test]
    fn document_accepts_rar_and_cbr_attachments() {
        let link = |url: &str, name: &str| {
            format!(r#"<a class="tgme_widget_message_document_wrap" href="{url}">{name}</a>"#)
        };
        assert!(message_document(&link("https://cdn.example/ch.cbr", "ch.cbr")).is_some());
        assert!(message_document(&link("https://cdn.example/ch.rar", "ch.rar")).is_some());
        assert!(message_document(&link("https://cdn.example/ch.7z", "ch.7z")).is_none());
    }

    #[test]
    fn telegram_message_urls_are_not_treated_as_file_links() {
        assert!(is_telegram_message_url("https://t.me/demo/123"));
        assert!(is_telegram_message_url(
            "https://telegram.me/s/demo/123?single"
        ));
        assert!(!is_telegram_message_url("https://cdn.example/file.rar"));
        assert!(!is_telegram_message_url("https://t.me/demo"));
        assert!(!is_telegram_message_url("https://example.com/demo/123"));
    }

    #[test]
    fn document_without_public_href_reports_login_required_details() {
        let placeholder = |name: &str, size: &str| {
            format!(
                r#"<div class="tgme_widget_message_document">
                     <div class="tgme_widget_message_document_icon"></div>
                     <div class="tgme_widget_message_document_title">{name}</div>
                     <div class="tgme_widget_message_document_extra">{size}</div>
                   </div>"#
            )
        };
        let doc = message_document(&placeholder("chapter.rar", "128.5 MB"))
            .expect("placeholder document");
        assert!(!doc.downloadable);
        assert!(doc.url.is_empty());
        assert_eq!(doc.filename, "chapter.rar");
        assert_eq!(doc.size, Some(128 * 1024 * 1024 + 512 * 1024));

        let error = document_login_required(&doc).to_string();
        assert!(error.contains("telegram-document-login-required"));
        assert!(error.contains("chapter.rar"));
        assert!(error.contains("\"filename\":\"chapter.rar\""));
        assert!(error.contains("\"size\":"));

        // 无直链时仍识别 7z，让用户看到「需登录下载」而不是被当成纯文本。
        assert!(message_document(&placeholder("chapter.7z", "1 MB")).is_some());
        assert!(message_document(&placeholder("notes.txt", "1 MB")).is_none());

        // 指向消息自身的 href 不是文件直链；必须降级为登录占位，
        // 绝不能让下载器把 HTML 保存成 .rar。
        let self_link = message_document(
            r#"<a class="tgme_widget_message_document_wrap" href="https://t.me/demo/123">chapter.rar 1 MB</a>"#,
        )
        .expect("self-link document");
        assert!(!self_link.downloadable);
        assert!(self_link.url.is_empty());
        assert_eq!(self_link.filename, "chapter.rar");
    }

    #[test]
    fn channel_parses_albums_telegraph_documents_and_filters_chatter() {
        let http = MapHttp::new(vec![(
            "https://t.me/s/demo",
            200,
            channel_html().into_bytes(),
        )]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.title, "QA Channel");
        assert_eq!(channel.chapters.len(), 3);
        assert_eq!(channel.before, Some(99));
        assert!(channel.has_more);
        let kinds: Vec<_> = channel.chapters.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![
                TelegramChapterKind::Photos,
                TelegramChapterKind::Telegraph,
                TelegramChapterKind::Document,
            ]
        );
        assert_eq!(channel.chapters[0].page_count, Some(3));
        assert_eq!(channel.chapters[0].message_id, 102);
        assert!(channel.chapters[0].grouped);
        assert_eq!(
            channel.chapters[2]
                .document
                .as_ref()
                .map(|d| d.filename.as_str()),
            Some("ch3.zip")
        );
    }

    #[test]
    fn message_resolves_album_with_anchors_and_filters_small_noise() {
        let embed = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/200">
          <div class="tgme_widget_message_text">Album 1</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/a.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/b.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/qr.png')"></a>
        </div></body></html>"#;
        let http = MapHttp::new(vec![
            (
                "https://t.me/demo/200?embed=1",
                200,
                embed.as_bytes().to_vec(),
            ),
            ("https://cdn/a.png", 200, png(800, 1200)),
            ("https://cdn/b.png", 200, png(800, 1200)),
            ("https://cdn/qr.png", 200, png(200, 200)),
        ]);
        let meta = resolve_book(
            &http,
            "https://t.me/demo/200",
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages.len(), 2);
        assert_eq!(stored.filtered.len(), 1);
        let anchor = stored.pages[0].anchor.as_ref().unwrap();
        assert_eq!(anchor.channel, "demo");
        assert_eq!(anchor.message_id, 200);
        assert_eq!(anchor.photo_index, 0);
    }

    #[test]
    fn telegraph_extracts_article_images_and_drops_small_logo() {
        let html = r#"<html><head><title>Telegraph QA</title></head><body><article>
            <figure><img src="/file/a.png"></figure>
            <figure><img src="/file/b.png"></figure>
            <figure><img src="/file/c.png"></figure>
            <figure><img src="/file/logo.png" width="32" height="32"></figure>
        </article></body></html>"#;
        let http = MapHttp::new(vec![
            (
                "https://telegra.ph/QA-Test-01",
                200,
                html.as_bytes().to_vec(),
            ),
            ("https://telegra.ph/file/a.png", 200, png(800, 1200)),
            ("https://telegra.ph/file/b.png", 200, png(800, 1200)),
            ("https://telegra.ph/file/c.png", 200, png(800, 1200)),
        ]);
        let meta = resolve_book(
            &http,
            "https://telegra.ph/QA-Test-01",
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.filtered.len(), 1);
    }

    #[test]
    fn telegraph_21p_keeps_all_images_in_dom_order_including_wide_tail() {
        let mut html = String::from(
            "<html><head><title>合成 Telegraph 21P</title></head><body><article id=\"_tl_editor\">",
        );
        let mut expected = Vec::new();
        for i in 0..18 {
            let url = format!("https://telegra.ph/file/{:016x}.jpg", 0x1000 + i);
            expected.push(url.clone());
            html.push_str(&format!(
                "<figure><img src=\"{url}\" width=\"800\" height=\"1200\"></figure>"
            ));
        }
        for (url, width, height) in [
            ("https://telegra.ph/file/wide-tail-21p.jpg", 2400, 700),
            ("https://telegra.ph/file/ad/random-hash-21p.jpg", 800, 1200),
            ("https://graph.org/file/random-hash-21p.jpg", 800, 1200),
        ] {
            expected.push(url.to_string());
            html.push_str(&format!(
                "<figure><img src=\"{url}\" width=\"{width}\" height=\"{height}\"></figure>"
            ));
        }
        html.push_str(
            "<figure><img src=\"https://telegra.ph/file/tiny-icon-21p.png\" width=\"32\" height=\"32\"></figure></article></body></html>",
        );
        let http = MapHttp::new(vec![(
            "https://telegra.ph/QA-21P-11-08",
            200,
            html.into_bytes(),
        )]);
        let thresholds = FilterThresholds {
            probe_missing_dimensions: false,
            ..FilterThresholds::default()
        };
        let meta = resolve_book(
            &http,
            "https://telegra.ph/QA-21P-11-08",
            &FilterMemory::default(),
            &thresholds,
        )
        .unwrap();
        assert_eq!(
            meta.page_count, 21,
            "Telegraph 21P 不应因宽幅/关键词/跨域路径缺页"
        );
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        let expected_refs: Vec<&str> = expected.iter().map(String::as_str).collect();
        assert_eq!(urls, expected_refs, "页面顺序必须与 DOM 完全一致");
        assert_eq!(stored.filtered.len(), 1);
        assert!(stored.filtered[0].url.contains("tiny-icon-21p"));
        assert!(stored.filtered[0].reason.contains("small"));
    }

    #[test]
    fn telegraph_tl_article_content_div_scopes_images() {
        let html = r#"<html><body>
            <header><img src="/file/header-logo.jpg" width="800" height="1200"></header>
            <div class="tl_article_content">
              <figure><img src="https://telegra.ph/file/aaa.jpg" width="800" height="1200"></figure>
              <div><figure><img src="https://graph.org/file/bbb.jpg" width="800" height="1200"></figure></div>
            </div>
            <footer><img src="/file/footer-logo.jpg" width="800" height="1200"></footer>
          </body></html>"#;
        let http = MapHttp::new(vec![(
            "https://telegra.ph/QA-Div",
            200,
            html.as_bytes().to_vec(),
        )]);
        let meta = resolve_without_probes(&http, "https://telegra.ph/QA-Div").unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://telegra.ph/file/aaa.jpg",
                "https://graph.org/file/bbb.jpg",
            ]
        );
    }

    /// 构造频道/预览页：每条消息可带发布时间、标题与 N 张相册图。
    fn album_page(messages: &[(i64, &str, &str, usize)]) -> String {
        let mut html = String::from(
            r#"<html><head><meta property="og:title" content="QA Channel"></head><body>"#,
        );
        for (id, datetime, text, photos) in messages {
            html.push_str(&format!(
                r#"<div class="tgme_widget_message" data-post="demo/{id}">"#
            ));
            if !datetime.is_empty() {
                html.push_str(&format!(
                    r#"<time class="tgme_widget_message_date" datetime="{datetime}">t</time>"#
                ));
            }
            if !text.is_empty() {
                html.push_str(&format!(
                    r#"<div class="tgme_widget_message_text">{text}</div>"#
                ));
            }
            for index in 1..=*photos {
                html.push_str(&format!(
                    r#"<a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/{id}-{index}.png')"></a>"#
                ));
            }
            html.push_str("</div>");
        }
        html.push_str("</body></html>");
        html
    }

    fn resolve_without_probes(http: &MapHttp, url: &str) -> Result<OnlineBookMeta, BackendError> {
        resolve_book(
            http,
            url,
            &FilterMemory::default(),
            &FilterThresholds {
                probe_missing_dimensions: false,
                ..FilterThresholds::default()
            },
        )
    }

    #[test]
    fn channel_merges_consecutive_albums_within_180_seconds() {
        let html = album_page(&[
            (200, "2024-01-01T00:00:00Z", "第01话 相册", 7),
            (201, "2024-01-01T00:00:30Z", "", 7),
            (202, "2024-01-01T00:01:00Z", "", 7),
        ]);
        let http = MapHttp::new(vec![("https://t.me/s/demo", 200, html.into_bytes())]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.chapters.len(), 1, "{:?}", channel.chapters);
        assert_eq!(channel.chapters[0].page_count, Some(21));
        assert_eq!(channel.chapters[0].message_id, 200);
        assert!(channel.chapters[0].grouped);
    }

    #[test]
    fn single_message_resolves_all_parts_with_per_message_anchors() {
        let html = album_page(&[
            (200, "2024-01-01T00:00:00Z", "第01话 相册", 7),
            (201, "2024-01-01T00:00:30Z", "", 7),
            (202, "2024-01-01T00:01:00Z", "", 7),
        ]);
        let http = MapHttp::new(vec![(
            "https://t.me/s/demo?before=211",
            200,
            html.into_bytes(),
        )]);
        let meta = resolve_without_probes(&http, "https://t.me/demo/200").unwrap();
        assert_eq!(meta.page_count, 21);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let anchors: Vec<(i64, u32)> = stored
            .pages
            .iter()
            .map(|page| {
                let anchor = page.anchor.as_ref().expect("相册页必须带锚点");
                (anchor.message_id, anchor.photo_index)
            })
            .collect();
        assert_eq!(anchors[0], (200, 0));
        assert_eq!(anchors[6], (200, 6));
        assert_eq!(anchors[7], (201, 0));
        assert_eq!(anchors[13], (201, 6));
        assert_eq!(anchors[14], (202, 0));
        assert_eq!(anchors[20], (202, 6));
        assert_eq!(stored.pages[0].url, "https://cdn/200-1.png");
    }

    #[test]
    fn channel_does_not_merge_albums_beyond_180_seconds() {
        let html = album_page(&[
            (200, "2024-01-01T00:00:00Z", "第01话", 7),
            (201, "2024-01-01T00:00:30Z", "", 7),
            (202, "2024-01-01T00:05:00Z", "", 7),
        ]);
        let http = MapHttp::new(vec![("https://t.me/s/demo", 200, html.into_bytes())]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.chapters.len(), 2);
        assert_eq!(channel.chapters[0].page_count, Some(14));
        assert_eq!(channel.chapters[1].page_count, Some(7));
    }

    #[test]
    fn channel_does_not_merge_album_with_independent_title() {
        let html = album_page(&[
            (200, "2024-01-01T00:00:00Z", "第01话", 7),
            (201, "2024-01-01T00:00:30Z", "", 7),
            (202, "2024-01-01T00:01:00Z", "第02话", 7),
        ]);
        let http = MapHttp::new(vec![("https://t.me/s/demo", 200, html.into_bytes())]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.chapters.len(), 2);
        assert_eq!(channel.chapters[0].page_count, Some(14));
        assert_eq!(channel.chapters[1].page_count, Some(7));
    }

    #[test]
    fn normalizes_graph_org_pages_and_search_flags() {
        assert_eq!(
            normalize_target("https://graph.org/QA-Graph-01").unwrap(),
            TelegramTarget::Telegraph {
                url: "https://graph.org/QA-Graph-01".into(),
            }
        );
        assert!(is_telegram_url("https://graph.org/QA-Graph-01"));
        assert!(normalize_target("https://t.me/s/demo?q=%23tag").is_ok());
    }

    #[test]
    fn inline_buttons_follow_public_albums_only_for_thin_messages() {
        let html = r#"<html><head><meta property="og:title" content="QA Channel"></head><body>
        <div class="tgme_widget_message" data-post="demo/300">
          <div class="tgme_widget_message_text">封面消息</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover.png')"></a>
          <div class="tgme_widget_message_inline_row">
            <a class="tgme_widget_message_inline_button" href="https://telegra.ph/Inline-Album"><span>阅读</span></a>
          </div>
        </div>
        <div class="tgme_widget_message" data-post="demo/301">
          <div class="tgme_widget_message_text">登录受限附件</div>
          <div class="tgme_widget_message_document">
            <div class="tgme_widget_message_document_title">chapter.rar</div>
            <div class="tgme_widget_message_document_extra">128 MB</div>
          </div>
          <a class="tgme_widget_message_inline_button" href="https://graph.org/Graph-Album">graph</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/302">
          <div class="tgme_widget_message_text">正常相册</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/p1.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/p2.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://telegra.ph/Should-Not-Apply">不该覆盖</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/303">
          <div class="tgme_widget_message_text">同频道相册封面</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover2.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://t.me/demo/400">下一部分</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/304">
          <div class="tgme_widget_message_text">跨频道按钮</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover3.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://t.me/other/1">外部频道</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/305">
          <div class="tgme_widget_message_text">危险按钮</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover4.png')"></a>
          <a class="tgme_widget_message_inline_button" href="javascript:alert(1)">脚本</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/306">
          <div class="tgme_widget_message_text">自指按钮</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover5.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://t.me/demo/306">自己</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/3061">
          <div class="tgme_widget_message_text">带凭据按钮</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover6.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://user:pass@telegra.ph/Leak">凭据</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/307">
          <div class="tgme_widget_message_text">公开附件</div>
          <a class="tgme_widget_message_document_wrap" href="https://cdn/ch7.zip">ch7.zip 12 MB</a>
          <a class="tgme_widget_message_inline_button" href="https://telegra.ph/Should-Stay-Document">按钮</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/308">
          <div class="tgme_widget_message_text">附件章节
            <a href="https://t.me/demo/309">上一话</a>
            <a href="https://t.me/demo/310">下一话</a>
          </div>
          <a class="tgme_widget_message_document_wrap" href="https://cdn/ch308.zip">ch308.zip 20 MB</a>
        </div>
        </body></html>"#;
        let http = MapHttp::new(vec![("https://t.me/s/demo", 200, html.as_bytes().to_vec())]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.chapters.len(), 10, "{:?}", channel.chapters);
        let by_id = |id: i64| {
            channel
                .chapters
                .iter()
                .find(|chapter| chapter.message_id == id)
                .unwrap()
        };
        let telegraph = by_id(300);
        assert_eq!(telegraph.kind, TelegramChapterKind::Telegraph);
        assert_eq!(telegraph.url, "https://telegra.ph/Inline-Album");
        assert!(telegraph.via_inline);
        assert_eq!(telegraph.page_count, None);

        let graph = by_id(301);
        assert_eq!(graph.kind, TelegramChapterKind::Telegraph);
        assert_eq!(graph.url, "https://graph.org/Graph-Album");
        assert!(graph.via_inline);
        assert!(graph.document.is_none());

        let album = by_id(302);
        assert_eq!(album.kind, TelegramChapterKind::Photos);
        assert_eq!(album.page_count, Some(2));
        assert!(!album.via_inline);

        let album_link = by_id(303);
        assert_eq!(album_link.kind, TelegramChapterKind::Photos);
        assert_eq!(album_link.url, "https://t.me/demo/400");
        assert_eq!(album_link.page_count, None);
        assert!(album_link.via_inline);

        for id in [304, 305, 306, 3061] {
            let chapter = by_id(id);
            assert_eq!(chapter.kind, TelegramChapterKind::Photos, "{id}");
            assert_eq!(chapter.page_count, Some(1), "{id}");
            assert!(!chapter.via_inline, "{id}");
            assert_eq!(chapter.url, format!("https://t.me/demo/{id}"), "{id}");
        }

        // 有匿名直链的真实附件不能被内联按钮覆盖，也不能被目录汇总误判。
        for (id, filename) in [(307, "ch7.zip"), (308, "ch308.zip")] {
            let chapter = by_id(id);
            assert_eq!(chapter.kind, TelegramChapterKind::Document, "{id}");
            assert!(!chapter.via_inline, "{id}");
            assert!(chapter.links.is_empty(), "{id}");
            assert_eq!(
                chapter.document.as_ref().map(|doc| doc.filename.as_str()),
                Some(filename),
                "{id}"
            );
        }
    }

    #[test]
    fn single_message_follows_inline_telegraph_and_same_channel_album() {
        let telegraph_embed = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/300">
          <div class="tgme_widget_message_text">封面</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://telegra.ph/Inline-Chapter">阅读</a>
        </div></body></html>"#;
        let telegraph_page = r#"<html><head><title>Inline Chapter</title></head><body><article>
            <figure><img src="/file/one.jpg" width="800" height="1200"></figure>
            <figure><img src="/file/two.jpg" width="800" height="1200"></figure>
        </article></body></html>"#;
        let http = MapHttp::new(vec![
            (
                "https://t.me/demo/300?embed=1",
                200,
                telegraph_embed.as_bytes().to_vec(),
            ),
            (
                "https://telegra.ph/Inline-Chapter",
                200,
                telegraph_page.as_bytes().to_vec(),
            ),
        ]);
        let meta = resolve_without_probes(&http, "https://t.me/demo/300").unwrap();
        assert_eq!(meta.page_count, 2);
        assert_eq!(meta.canonical_url, "https://telegra.ph/Inline-Chapter");

        let album_embed = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/303">
          <div class="tgme_widget_message_text">封面</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/cover2.png')"></a>
          <a class="tgme_widget_message_inline_button" href="https://t.me/demo/400">下一部分</a>
        </div></body></html>"#;
        let target_page = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/400">
          <div class="tgme_widget_message_text">目标相册</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/a.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/b.png')"></a>
        </div></body></html>"#;
        let http = MapHttp::new(vec![
            (
                "https://t.me/demo/303?embed=1",
                200,
                album_embed.as_bytes().to_vec(),
            ),
            (
                "https://t.me/s/demo?before=411",
                200,
                target_page.as_bytes().to_vec(),
            ),
        ]);
        let meta = resolve_without_probes(&http, "https://t.me/demo/303").unwrap();
        assert_eq!(meta.page_count, 2);
        assert_eq!(meta.canonical_url, "https://t.me/demo/400");
    }

    #[test]
    fn index_posts_extract_public_chapter_links_and_skip_noise() {
        let html = r#"<html><head><meta property="og:title" content="Index Channel"></head><body>
        <div class="tgme_widget_message" data-post="demo/500">
          <div class="tgme_widget_message_text">目录汇总 #目录
            <a href="https://telegra.ph/Chapter-01">第 1 话</a>
            <a href="https://graph.org/Chapter-02">第 2 话</a>
            <a href="https://t.me/demo/501?single">第 3 话</a>
            <a href="https://t.me/demo/500">本篇目录</a>
            <a href="https://t.me/other/9">外部频道</a>
            <a href="https://t.me/s/demo?q=%23tag">#标签</a>
            <a href="https://example.com/mirror">镜像站</a>
            <a href="https://telegra.ph/file/image.jpg">图片</a>
          </div>
        </div>
        <div class="tgme_widget_message" data-post="demo/502">
          <div class="tgme_widget_message_text">正常章节
            <a href="https://t.me/demo/503">下一话</a>
            <a href="https://t.me/demo/504">下下话</a>
          </div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/502-1.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/502-2.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/502-3.png')"></a>
        </div>
        </body></html>"#;
        let http = MapHttp::new(vec![("https://t.me/s/demo", 200, html.as_bytes().to_vec())]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        let index = channel
            .chapters
            .iter()
            .find(|chapter| chapter.message_id == 500)
            .expect("index chapter");
        assert_eq!(index.kind, TelegramChapterKind::Index);
        assert_eq!(index.page_count, None);
        assert_eq!(index.links.len(), 3, "{:?}", index.links);
        let urls: Vec<&str> = index.links.iter().map(|link| link.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://telegra.ph/Chapter-01",
                "https://graph.org/Chapter-02",
                "https://t.me/demo/501",
            ]
        );
        let titles: Vec<&str> = index.links.iter().map(|link| link.title.as_str()).collect();
        assert_eq!(titles, vec!["第 1 话", "第 2 话", "第 3 话"]);
        assert!(index.tags.contains(&"#目录".to_string()));

        let album = channel
            .chapters
            .iter()
            .find(|chapter| chapter.message_id == 502)
            .expect("album chapter");
        assert_eq!(album.kind, TelegramChapterKind::Photos);
        assert_eq!(album.page_count, Some(3));
        assert!(album.links.is_empty());
    }

    #[test]
    fn search_query_is_encoded_and_paginated() {
        let html = album_page(&[(700, "2024-01-01T00:00:00Z", "第01话", 2)]);
        let first = "https://t.me/s/demo?q=%23%E6%BC%AB%E7%94%BB";
        let next = "https://t.me/s/demo?q=%23%E6%BC%AB%E7%94%BB&before=99";
        let deep = "https://t.me/s/demo?q=hello";
        let http = MapHttp::new(vec![
            (first, 200, html.clone().into_bytes()),
            (next, 200, html.clone().into_bytes()),
            (deep, 200, html.into_bytes()),
        ]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            Some("#漫画"),
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.query.as_deref(), Some("#漫画"));
        assert_eq!(channel.chapters.len(), 1);

        let more = fetch_channel(
            &http,
            "https://t.me/s/demo",
            Some(99),
            Some("#漫画"),
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(more.query.as_deref(), Some("#漫画"));

        let from_url = fetch_channel(
            &http,
            "https://t.me/s/demo?q=hello",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(from_url.query.as_deref(), Some("hello"));

        let long_query = "x".repeat(121);
        assert!(fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            Some(long_query.as_str()),
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap_err()
        .to_string()
        .contains("telegram-search-invalid"));
        assert!(fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            Some("a\nb"),
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .is_err());
    }

    #[test]
    fn public_tags_are_extracted_without_polluting_titles() {
        let html = album_page(&[(
            800,
            "2024-01-01T00:00:00Z",
            "第01话 正式标题 #漫画 #长篇，完结",
            2,
        )]);
        let http = MapHttp::new(vec![("https://t.me/s/demo", 200, html.into_bytes())]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        let chapter = &channel.chapters[0];
        assert_eq!(chapter.title, "第01话 正式标题");
        assert_eq!(chapter.tags, vec!["#漫画".to_string(), "#长篇".to_string()]);
    }

    #[test]
    fn refresh_returns_new_cdn_url_for_expired_photo() {
        let embed = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/200">
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/new.png')"></a>
        </div></body></html>"#;
        let http = MapHttp::new(vec![(
            "https://t.me/demo/200?embed=1",
            200,
            embed.as_bytes().to_vec(),
        )]);
        let anchor = PageAnchor {
            channel: "demo".into(),
            message_id: 200,
            photo_index: 0,
            refresh_base: Some("https://t.me".into()),
        };
        let fresh = refresh_page_url(&http, &anchor).unwrap();
        assert_eq!(fresh.as_deref(), Some("https://cdn/new.png"));
    }
}
