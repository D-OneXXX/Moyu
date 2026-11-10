//! 二级分页索引画廊：目录页只给出查看器链接，真实大图在查看器页面内。
//!
//! 阶段一只抓索引页（含 `?p=` 分页），按页序收集 viewer URL；
//! 阶段二由 [`crate::source::OnlineSource`] 在缓存未命中时按 `viewer`
//! 标记解包查看器 HTML，再走现有 Range/GET 与同源会话头。

use std::collections::{HashMap, HashSet};

use regex::Regex;
use url::Url;

use crate::online::direct::{make_meta, OnlineBookMeta};
use crate::online::filter::normalize_digit_runs;
use crate::online::html::{
    attr_value, decode_entities, decode_html, extract_title, next_tag, parse_attrs, tag_name,
};
use crate::online::http::HttpTransport;
use crate::online::{normalize_url, title_from_url, PageRef, MANIFEST_MAX_BYTES, MAX_PAGES};
use crate::source::BackendError;

/// 至少多少个同构查看器链接才按画廊索引处理。
const MIN_VIEWERS: usize = 3;
/// 索引分页抓取上限，避免异常站点制造无限请求。
const MAX_INDEX_PAGES: usize = 50;

#[derive(Debug, Clone)]
struct ViewerLink {
    url: Url,
    page: Option<u32>,
}

#[derive(Debug, Clone)]
struct GalleryIndex {
    title: Option<String>,
    viewers: Vec<ViewerLink>,
    pagination: Vec<Url>,
}

/// 若给定 HTML 是分页索引画廊，抓取索引分页并返回 viewer 页列表。
///
/// 返回 `None` 表示未识别为画廊索引（调用方继续走普通 HTML 图集）。
/// 识别后若索引分页请求失败则失败关闭，避免把缩略图当正文静默截断。
pub(crate) fn resolve_from_html(
    http: &dyn HttpTransport,
    body: &[u8],
    base_url: &Url,
    canonical_url: &Url,
) -> Result<Option<OnlineBookMeta>, BackendError> {
    let text = decode_html(body);
    let Some(first) = detect_index(&text, base_url, MIN_VIEWERS, true) else {
        return Ok(None);
    };
    let GalleryIndex {
        title,
        mut viewers,
        pagination: first_pagination,
    } = first;
    if viewers.len() < MIN_VIEWERS {
        return Ok(None);
    }
    let mut seen_viewers: HashSet<String> = viewers
        .iter()
        .map(|viewer| viewer.url.to_string())
        .collect();
    let mut seen_pages: HashSet<String> = HashSet::new();
    seen_pages.insert(base_url.to_string());
    let mut queue = first_pagination;
    let mut fetched = 1usize;
    while let Some(page_url) = queue.pop() {
        if fetched >= MAX_INDEX_PAGES || viewers.len() >= MAX_PAGES {
            break;
        }
        if !seen_pages.insert(page_url.to_string()) {
            continue;
        }
        fetched += 1;
        let resp = http.get(
            page_url.as_str(),
            MANIFEST_MAX_BYTES,
            Some(canonical_url.as_str()),
            Some(canonical_url.as_str()),
        )?;
        if !(200..300).contains(&resp.status) {
            return Err(BackendError::Network(format!(
                "画廊索引页 HTTP {}（online-fetch-failed）",
                resp.status
            )));
        }
        let page_text = decode_html(&resp.body);
        // 后续索引页已由首屏确认画廊结构，只需提取 viewer 链接，不再要求 >=3 张。
        if let Some(index) = detect_index(&page_text, &page_url, 1, false) {
            for viewer in index.viewers {
                if seen_viewers.insert(viewer.url.to_string()) {
                    viewers.push(viewer);
                }
            }
            queue.extend(index.pagination);
        }
    }
    if viewers.len() < MIN_VIEWERS {
        return Ok(None);
    }
    viewers.sort_by_key(|viewer| viewer.page.unwrap_or(u32::MAX));
    if viewers.len() > MAX_PAGES {
        return Err(BackendError::Msg(format!(
            "画廊页数超过上限 {MAX_PAGES}（online-too-many-pages）"
        )));
    }
    let title = title.unwrap_or_else(|| title_from_url(base_url));
    let pages = viewers
        .into_iter()
        .map(|viewer| PageRef {
            url: viewer.url.to_string(),
            viewer: true,
            width: None,
            height: None,
            anchor: None,
        })
        .collect();
    Ok(Some(make_meta(canonical_url, &title, pages)?))
}

fn detect_index(
    text: &str,
    base_url: &Url,
    min_viewers: usize,
    require_strong: bool,
) -> Option<GalleryIndex> {
    let mut links = Vec::new();
    let mut pagination = Vec::new();
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
        if name != "a" && name != "link" {
            continue;
        }
        let attrs = parse_attrs(tag);
        let Some(href) = attr_value(&attrs, "href") else {
            continue;
        };
        let href = decode_entities(href.trim());
        let Ok(joined) = base_url.join(&href) else {
            continue;
        };
        let Ok(url) = normalize_url(joined.as_str()) else {
            continue;
        };
        if name == "link" {
            let rel = attr_value(&attrs, "rel")
                .unwrap_or_default()
                .to_ascii_lowercase();
            if rel.split_whitespace().any(|value| value == "next")
                && url.path() == base_url.path()
                && page_query(&url).is_some_and(|page| page > 0)
            {
                pagination.push(url);
            }
            continue;
        }
        if url.path() == base_url.path() {
            if let Some(page) = page_query(&url) {
                if page > 0 {
                    pagination.push(url);
                }
                continue;
            }
        }
        if url.origin() != base_url.origin() || crate::source::is_image_name(url.path()) {
            continue;
        }
        links.push(url);
    }

    let mut groups: HashMap<String, Vec<Url>> = HashMap::new();
    for url in links {
        groups
            .entry(normalize_digit_runs(url.path()))
            .or_default()
            .push(url);
    }
    let mut best: Option<Vec<Url>> = None;
    for group in groups.into_values() {
        if group.len() < min_viewers {
            continue;
        }
        let page_numbers: Vec<u32> = group.iter().filter_map(trailing_page_number).collect();
        let strong = if require_strong {
            let sequential = page_sequence_ok(&page_numbers);
            (page_numbers.len() >= 3 && sequential) || (group.len() >= 4 && !pagination.is_empty())
        } else {
            !page_numbers.is_empty()
        };
        if !strong {
            continue;
        }
        let better = best
            .as_ref()
            .is_none_or(|current| group.len() > current.len());
        if better {
            best = Some(group);
        }
    }
    let mut viewers = best?;
    viewers.sort_by_key(|url| trailing_page_number(url).unwrap_or(u32::MAX));
    pagination.retain(|url| url.path() == base_url.path());
    pagination.sort_by_key(|url| page_query(url).unwrap_or(0));
    pagination.dedup_by(|a, b| a.as_str() == b.as_str());
    let base = base_url.as_str();
    pagination.retain(|url| url.as_str() != base);
    Some(GalleryIndex {
        title: extract_title(text),
        viewers: viewers
            .into_iter()
            .map(|url| ViewerLink {
                page: trailing_page_number(&url),
                url,
            })
            .collect(),
        pagination,
    })
}

fn page_query(url: &Url) -> Option<u32> {
    url.query_pairs()
        .find(|(name, _)| name == "p" || name == "page")
        .and_then(|(_, value)| value.parse::<u32>().ok())
}

/// 从 `/s/{hash}/{id}-{page}` 这类末段提取页码；纯 id 不算页码。
fn trailing_page_number(url: &Url) -> Option<u32> {
    let segment = url.path_segments()?.rfind(|segment| !segment.is_empty())?;
    let stem = segment.split('.').next().unwrap_or(segment);
    let re = Regex::new(r"(?i)[-_](?:p(?:age)?)?(\d{1,6})$").ok()?;
    let caps = re.captures(stem)?;
    caps[1].parse::<u32>().ok().filter(|page| *page > 0)
}

fn page_sequence_ok(numbers: &[u32]) -> bool {
    let mut numbers = numbers.to_vec();
    numbers.sort_unstable();
    numbers.dedup();
    if numbers.len() < 3 {
        return false;
    }
    let span = numbers
        .last()
        .copied()
        .unwrap_or(0)
        .saturating_sub(numbers.first().copied().unwrap_or(0));
    span <= (numbers.len() as u32).saturating_mul(3).max(3)
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

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
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
            match self.responses.get(url) {
                Some((status, body)) => Ok(HttpResponse {
                    status: *status,
                    final_url: url.to_string(),
                    content_type: Some("text/html".into()),
                    body: body.clone(),
                }),
                None => Ok(HttpResponse {
                    status: 404,
                    final_url: url.to_string(),
                    content_type: None,
                    body: Vec::new(),
                }),
            }
        }
    }

    fn index_page(links: &[(&str, u32)], pagination: &[u32]) -> Vec<u8> {
        let mut html = String::from(
            "<html><head><title>QA Gallery</title></head><body><div class=\"gallery\">",
        );
        for (prefix, page) in links {
            html.push_str(&format!(
                r#"<a href="{prefix}-{page}"><img src="/thumb/{page}.jpg"></a>"#
            ));
        }
        for page in pagination {
            html.push_str(&format!(r#"<a href="?p={page}">第 {} 页</a>"#, page + 1));
        }
        html.push_str("</div></body></html>");
        html.into_bytes()
    }

    #[test]
    fn resolves_paginated_index_into_ordered_viewer_refs() {
        let base = Url::parse("http://gallery.example/g/100/token").unwrap();
        let http = MapHttp::new(vec![
            (
                "http://gallery.example/g/100/token?p=1",
                200,
                index_page(&[("/s/hash/100", 4), ("/s/hash/100", 5)], &[2]),
            ),
            (
                "http://gallery.example/g/100/token?p=2",
                200,
                index_page(&[("/s/hash/100", 6), ("/s/hash/100", 7)], &[]),
            ),
        ]);
        let first = index_page(
            &[("/s/hash/100", 1), ("/s/hash/100", 2), ("/s/hash/100", 3)],
            &[1, 2],
        );
        let meta = resolve_from_html(&http, &first, &base, &base)
            .unwrap()
            .expect("应识别为画廊索引");
        assert_eq!(meta.title, "QA Gallery");
        assert_eq!(meta.page_count, 7);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert!(stored.pages.iter().all(|page| page.viewer));
        let urls: Vec<&str> = stored.pages.iter().map(|page| page.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/s/hash/100-1",
                "http://gallery.example/s/hash/100-2",
                "http://gallery.example/s/hash/100-3",
                "http://gallery.example/s/hash/100-4",
                "http://gallery.example/s/hash/100-5",
                "http://gallery.example/s/hash/100-6",
                "http://gallery.example/s/hash/100-7",
            ]
        );
        let calls = http.calls();
        assert!(calls.iter().all(|url| !url.contains("/s/")));
    }

    #[test]
    fn ignores_chapter_navigation_without_page_suffix() {
        let base = Url::parse("http://gallery.example/comic/1").unwrap();
        let mut html = String::from("<html><head><title>Reader</title></head><body>");
        for i in 1..=6 {
            html.push_str(&format!(r#"<img src="/chapters/{i}.jpg">"#));
        }
        for chapter in 1..=4 {
            html.push_str(&format!(
                r#"<a href="/comic/{chapter}">第 {chapter} 话</a>"#
            ));
        }
        html.push_str("</body></html>");
        let http = MapHttp::new(vec![]);
        assert!(resolve_from_html(&http, html.as_bytes(), &base, &base)
            .unwrap()
            .is_none());
    }

    #[test]
    fn detects_sequential_viewers_without_pagination() {
        let base = Url::parse("http://gallery.example/g/7/token").unwrap();
        let first = index_page(&[("/s/hash/7", 1), ("/s/hash/7", 2), ("/s/hash/7", 3)], &[]);
        let http = MapHttp::new(vec![]);
        let meta = resolve_from_html(&http, &first, &base, &base)
            .unwrap()
            .expect("连续 viewer 页应识别");
        assert_eq!(meta.page_count, 3);
    }

    #[test]
    fn scatters_viewer_pages_into_page_order() {
        let base = Url::parse("http://gallery.example/g/8/token").unwrap();
        let first = index_page(&[("/s/hash/8", 3), ("/s/hash/8", 1), ("/s/hash/8", 2)], &[]);
        let http = MapHttp::new(vec![]);
        let meta = resolve_from_html(&http, &first, &base, &base)
            .unwrap()
            .unwrap();
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|page| page.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/s/hash/8-1",
                "http://gallery.example/s/hash/8-2",
                "http://gallery.example/s/hash/8-3",
            ]
        );
    }
}
