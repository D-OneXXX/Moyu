//! Read-only D2 data service.
//!
//! This module owns the Web DTOs and the read-only orchestration shared by the
//! future HTTP data layer. It uses the existing `DbSlot`, book metadata helpers,
//! and source handles; it never writes the database or reading progress.

use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{Local, NaiveDateTime, TimeZone};
use serde::Serialize;

use crate::commands::{get_next_book_impl, is_safe_library_source_path, to_book_info};
use crate::db::{self, BookRow};
use crate::state::AppState;

/// Bound the Web page manifest independently of any source-reported count.
const MAX_WEB_PAGES: u32 = 10_000;

/// Stable data-plane failure classes; HTTP mapping is added by the route layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum DataError {
    NotFound,
    Removed,
    ThumbMissing,
    PdfUnsupported,
    SourceUnsupported,
    SourceMissing,
    InvalidParameter,
    PageOutOfRange { max_page: u32 },
    TileOutOfRange { max_tile: u32 },
    Busy,
    DbUnavailable,
    Timeout,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebBook {
    pub id: String,
    pub title: String,
    pub page_count: u32,
    pub current_page: u32,
    pub progress_rev: i64,
    pub scroll_pct: f64,
    pub format: String,
    pub source_type: String,
    pub missing: bool,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebBookDetail {
    #[serde(flatten)]
    pub book: WebBook,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapter_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_book_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebBookPage {
    pub items: Vec<WebBook>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageIndex {
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageManifest {
    pub page_count: u32,
    pub pages: Vec<PageIndex>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressView {
    pub page: u32,
    pub page_count: u32,
    pub scroll_pct: f64,
    pub rev: i64,
    pub updated_at: String,
}

/// Read a stable `(updated_at, id)` page, newest first. Search is title-only;
/// path is never a search field. `limit` is validated again here even though
/// the HTTP layer will also enforce 1..=100.
pub(crate) fn list_books_page(
    state: &AppState,
    q: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> Result<WebBookPage, DataError> {
    if !(1..=100).contains(&limit) {
        return Err(DataError::InvalidParameter);
    }
    let q = q.map(str::trim).filter(|value| !value.is_empty());
    if q.map(|value| value.chars().count() > 128).unwrap_or(false) {
        return Err(DataError::InvalidParameter);
    }
    let cursor = match cursor {
        Some(raw) => Some(decode_cursor(raw).ok_or(DataError::InvalidParameter)?),
        None => None,
    };
    let (cursor_updated, cursor_id) = match &cursor {
        Some((updated, id)) => (Some(updated.as_str()), Some(id.as_str())),
        None => (None, None),
    };

    let mut rows = state
        .db
        .with(|conn| {
            db::list_books_page(conn, q, cursor_updated, cursor_id, limit)
                .map_err(|e| e.to_string())
        })
        .map_err(|_| DataError::DbUnavailable)?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last().and_then(encode_cursor)
    } else {
        None
    };
    let items = rows
        .into_iter()
        .map(|row| web_book(to_book_info(row)))
        .collect();
    Ok(WebBookPage { items, next_cursor })
}

/// Single active book plus the flattened series/next fields. A removed book is
/// indistinguishable from a missing one.
pub(crate) fn book_detail(state: &AppState, id: &str) -> Result<WebBookDetail, DataError> {
    let result = state
        .db
        .with(|conn| {
            let Some(row) = db::get_active_book(conn, id).map_err(|e| e.to_string())? else {
                return Ok(None);
            };
            let next_id = get_next_book_impl(conn, id)
                .ok()
                .flatten()
                .and_then(|next| {
                    db::get_active_book(conn, &next.id)
                        .ok()
                        .flatten()
                        .map(|_| next.id)
                });
            Ok(Some((row, next_id)))
        })
        .map_err(|_| DataError::DbUnavailable)?;
    let Some((row, next_id)) = result else {
        return Err(DataError::NotFound);
    };
    let info = to_book_info(row);
    let series_title = info.series_title.clone();
    let chapter_index = info.chapter_index;
    Ok(WebBookDetail {
        book: web_book(info),
        series_title,
        chapter_index,
        next_book_id: next_id,
    })
}

/// Page indexes only; entry names (archive/source filenames) never leave this
/// function. PDF and unsupported source types fail before opening a source.
pub(crate) fn pages_manifest(state: &AppState, id: &str) -> Result<PageManifest, DataError> {
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return Err(DataError::PdfUnsupported);
    }
    ensure_source_allowed(&row)?;
    let handle = state
        .source_handle_for_book(id)
        .map_err(|_| DataError::SourceMissing)?;
    let count = handle.page_count().map_err(|_| DataError::SourceMissing)?;
    let count = u32::try_from(count)
        .map_err(|_| DataError::Internal)?
        .min(MAX_WEB_PAGES);
    let pages = (0..count).map(|index| PageIndex { index }).collect();
    Ok(PageManifest {
        page_count: count,
        pages,
    })
}

/// Read the real `progress_rev` without touching progress columns.
pub(crate) fn progress(state: &AppState, id: &str) -> Result<ProgressView, DataError> {
    let row = active_row(state, id)?;
    Ok(ProgressView {
        page: row.current_page,
        page_count: row.page_count,
        scroll_pct: row.scroll_pct,
        rev: row.progress_rev,
        updated_at: iso_local(&row.updated_at),
    })
}

fn active_row(state: &AppState, id: &str) -> Result<BookRow, DataError> {
    state
        .db
        .with(|conn| db::get_active_book(conn, id).map_err(|e| e.to_string()))
        .map_err(|_| DataError::DbUnavailable)?
        .ok_or(DataError::NotFound)
}

fn ensure_source_allowed(row: &BookRow) -> Result<(), DataError> {
    match row.source_type.as_str() {
        "local" => {
            if !is_safe_library_source_path(Path::new(&row.path)) {
                return Err(DataError::SourceMissing);
            }
            Ok(())
        }
        "generic_manga" => Ok(()),
        _ => Err(DataError::SourceUnsupported),
    }
}

fn web_book(info: crate::BookInfo) -> WebBook {
    let id = info.id.clone();
    let rev = info.progress_rev;
    WebBook {
        id: info.id,
        title: info.title,
        page_count: info.page_count,
        current_page: info.current_page,
        progress_rev: info.progress_rev,
        scroll_pct: info.scroll_pct,
        format: info.format,
        source_type: info.source_type,
        missing: info.missing,
        updated_at: iso_local(&info.updated_at),
        thumb_url: Some(format!("/api/books/{id}/thumb?v={}", rev.max(0))),
    }
}

fn iso_local(raw: &str) -> String {
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|naive| Local.from_local_datetime(&naive).earliest())
        .map(|value| value.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        .unwrap_or_else(epoch_iso)
}

fn epoch_iso() -> String {
    Local
        .timestamp_opt(0, 0)
        .single()
        .map(|value| value.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string())
}

/// Cursor payload: one flag byte plus either an 8-byte local timestamp or
/// nothing, followed by the 32-byte book id. Empty `updated_at` is a real
/// state for newly imported books and must not collapse to the epoch key.
fn encode_cursor(row: &BookRow) -> Option<String> {
    let id = hex::decode(&row.id).ok()?;
    if id.len() != 32 {
        return None;
    }
    let mut raw = Vec::with_capacity(41);
    if row.updated_at.is_empty() {
        raw.push(0);
    } else {
        let seconds = NaiveDateTime::parse_from_str(&row.updated_at, "%Y-%m-%d %H:%M:%S")
            .ok()
            .and_then(|naive| Local.from_local_datetime(&naive).earliest())
            .map(|value| value.timestamp())
            .unwrap_or(0);
        raw.push(1);
        raw.extend_from_slice(&seconds.to_be_bytes());
    }
    raw.extend_from_slice(&id);
    Some(URL_SAFE_NO_PAD.encode(raw))
}

fn decode_cursor(raw: &str) -> Option<(String, String)> {
    if raw.len() > 64 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).ok()?;
    let (updated, id_bytes) = match (bytes.first().copied()?, bytes.len()) {
        (0, 33) => (String::new(), &bytes[1..]),
        (1, 41) => {
            let seconds = i64::from_be_bytes(bytes[1..9].try_into().ok()?);
            let updated = Local
                .timestamp_opt(seconds, 0)
                .single()?
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            (updated, &bytes[9..])
        }
        _ => return None,
    };
    let id = hex::encode(id_bytes);
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some((updated, id))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::params;
    use serde_json::json;

    use super::*;
    use crate::db::{self, BOOK_FORMAT_PDF};
    use crate::state::AppState;

    fn id_for(seed: char) -> String {
        seed.to_string().repeat(64)
    }

    fn state_with_db() -> AppState {
        let state = AppState::new();
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        state.db.set(conn);
        state
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_book(
        state: &AppState,
        id: &str,
        title: &str,
        updated: &str,
        path: &str,
        removed: i64,
        source_type: &str,
        format: &str,
        meta_json: &str,
        page_count: u32,
    ) {
        state
            .db
            .with(|conn| {
                conn.execute(
                    "INSERT INTO books(id,path,title,page_count,updated_at,last_opened_at,removed,source_type,meta_json,format)
                     VALUES(?1,?2,?3,?4,?5,?5,?6,?7,?8,?9)",
                    params![
                        id,
                        path,
                        title,
                        page_count as i64,
                        updated,
                        removed,
                        source_type,
                        meta_json,
                        format
                    ],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .expect("insert book");
    }

    fn series_meta(series: &str, title: &str, chapter: u32) -> String {
        json!({
            "schema": 1,
            "manifestHash": "",
            "fetchedAt": "",
            "pages": [],
            "seriesId": series,
            "seriesTitle": title,
            "chapterIndex": chapter
        })
        .to_string()
    }

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("moyu-d2-read-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_page_is_stable_excludes_removed_and_has_cursor() {
        let state = state_with_db();
        let a = id_for('a');
        let b = id_for('b');
        let c = id_for('c');
        let d = id_for('d');
        insert_book(
            &state,
            &a,
            "Alpha",
            "2026-11-03 10:00:00",
            "C:/library/secret/Beta.zip",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        insert_book(
            &state,
            &b,
            "Beta",
            "2026-11-03 11:00:00",
            "C:/library/b.cbz",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        insert_book(
            &state,
            &c,
            "Gamma",
            "2026-11-03 11:00:00",
            "C:/library/c.cbz",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        insert_book(
            &state,
            &d,
            "Delta",
            "2026-11-03 12:00:00",
            "C:/library/d.cbz",
            1,
            "local",
            "image",
            "{}",
            1,
        );

        let first = list_books_page(&state, None, None, 2).expect("first page");
        assert_eq!(
            first
                .items
                .iter()
                .map(|book| book.id.as_str())
                .collect::<Vec<_>>(),
            vec![b.as_str(), c.as_str()]
        );
        assert!(first.next_cursor.is_some());
        assert!(first.next_cursor.as_deref().unwrap().len() <= 64);
        assert!(first.items.iter().all(|book| book.thumb_url.is_some()));
        assert!(first.items[0].updated_at.starts_with("2026-11-03T11:00:00"));
        assert!(!first.items[0].updated_at.contains(' '));
        assert!(first.items[0].updated_at[19..].starts_with('+'));

        let second =
            list_books_page(&state, None, first.next_cursor.as_deref(), 2).expect("second page");
        assert_eq!(second.items[0].id, a);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn unread_books_with_empty_updated_at_paginate_without_duplicates() {
        let state = state_with_db();
        for seed in ['a', 'b', 'c'] {
            let id = id_for(seed);
            insert_book(
                &state,
                &id,
                &format!("Unread {seed}"),
                "",
                &format!("C:/library/{seed}.cbz"),
                0,
                "local",
                "image",
                "{}",
                1,
            );
        }

        let first = list_books_page(&state, None, None, 2).expect("first page");
        assert_eq!(
            first
                .items
                .iter()
                .map(|book| book.id.as_str())
                .collect::<Vec<_>>(),
            vec![id_for('a').as_str(), id_for('b').as_str()]
        );
        let cursor = first.next_cursor.clone().expect("cursor");
        assert!(cursor.len() <= 64);

        let second = list_books_page(&state, None, Some(&cursor), 2).expect("second page");
        assert_eq!(
            second
                .items
                .iter()
                .map(|book| book.id.as_str())
                .collect::<Vec<_>>(),
            vec![id_for('c').as_str()]
        );
        assert!(second.next_cursor.is_none());
        assert!(first.items[0].updated_at.starts_with("1970-01-01T"));
    }

    #[test]
    fn mixed_timestamp_and_empty_rows_paginate_across_boundary() {
        let state = state_with_db();
        let normal = id_for('e');
        insert_book(
            &state,
            &normal,
            "Timestamped",
            "2026-11-03 10:00:00",
            "C:/library/e.cbz",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        for seed in ['a', 'b', 'c'] {
            let id = id_for(seed);
            insert_book(
                &state,
                &id,
                &format!("Unread {seed}"),
                "",
                &format!("C:/library/{seed}.cbz"),
                0,
                "local",
                "image",
                "{}",
                1,
            );
        }

        let first = list_books_page(&state, None, None, 1).expect("first");
        assert_eq!(first.items[0].id, normal);
        let normal_cursor = first.next_cursor.clone().expect("normal cursor");
        let second = list_books_page(&state, None, Some(&normal_cursor), 1).expect("first empty");
        assert_eq!(second.items[0].id, id_for('a'));
        let empty_cursor = second.next_cursor.clone().expect("empty cursor");
        let third = list_books_page(&state, None, Some(&empty_cursor), 1).expect("second empty");
        assert_eq!(third.items[0].id, id_for('b'));
        assert_ne!(third.items[0].id, normal);
        let fourth =
            list_books_page(&state, None, third.next_cursor.as_deref(), 1).expect("third empty");
        assert_eq!(fourth.items[0].id, id_for('c'));
        assert!(fourth.next_cursor.is_none());
    }

    #[test]
    fn cursor_rejects_wrong_flag_length_and_padding() {
        let state = state_with_db();
        for seed in ['a', 'b'] {
            let id = id_for(seed);
            insert_book(
                &state,
                &id,
                &format!("Book {seed}"),
                "2026-11-03 10:00:00",
                &format!("C:/library/{seed}.cbz"),
                0,
                "local",
                "image",
                "{}",
                1,
            );
        }
        let first = list_books_page(&state, None, None, 1).expect("first");
        let cursor = first.next_cursor.expect("cursor");
        let bytes = URL_SAFE_NO_PAD.decode(&cursor).expect("cursor bytes");

        let mut bad_flag = bytes.clone();
        bad_flag[0] = 2;
        let bad_flag = URL_SAFE_NO_PAD.encode(bad_flag);
        assert!(matches!(
            list_books_page(&state, None, Some(&bad_flag), 1),
            Err(DataError::InvalidParameter)
        ));

        let bad_length = URL_SAFE_NO_PAD.encode(&bytes[..32]);
        assert!(matches!(
            list_books_page(&state, None, Some(&bad_length), 1),
            Err(DataError::InvalidParameter)
        ));

        let padded = format!("{cursor}==");
        assert!(matches!(
            list_books_page(&state, None, Some(&padded), 1),
            Err(DataError::InvalidParameter)
        ));
    }

    #[test]
    fn search_is_title_only_and_validates_bounds() {
        let state = state_with_db();
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Alpha",
            "2026-11-03 10:00:00",
            "C:/library/secret/Beta.zip",
            0,
            "local",
            "image",
            "{}",
            1,
        );

        let by_title = list_books_page(&state, Some("Alpha"), None, 10).expect("title search");
        assert_eq!(by_title.items.len(), 1);
        let by_path = list_books_page(&state, Some("secret"), None, 10).expect("path search");
        assert!(by_path.items.is_empty(), "path must not be searchable");
        let injected =
            list_books_page(&state, Some("' OR 1=1 --"), None, 10).expect("injection query");
        assert!(injected.items.is_empty());

        for invalid in ["not-a-cursor", "", "AAAA", &"a".repeat(65)] {
            assert!(matches!(
                list_books_page(&state, None, Some(invalid), 10),
                Err(DataError::InvalidParameter)
            ));
        }
        assert!(matches!(
            list_books_page(&state, None, None, 0),
            Err(DataError::InvalidParameter)
        ));
        assert!(matches!(
            list_books_page(&state, None, None, 101),
            Err(DataError::InvalidParameter)
        ));
        let long_query = "x".repeat(129);
        assert!(matches!(
            list_books_page(&state, Some(&long_query), None, 10),
            Err(DataError::InvalidParameter)
        ));
    }

    #[test]
    fn empty_library_returns_empty_page() {
        let state = state_with_db();
        let page = list_books_page(&state, None, None, 40).expect("empty page");
        assert!(page.items.is_empty());
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn web_book_json_has_no_path_or_internal_metadata() {
        let state = state_with_db();
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Alpha",
            "2026-11-03 10:00:00",
            "C:/library/a.cbz",
            0,
            "local",
            "image",
            "{}",
            12,
        );
        let page = list_books_page(&state, None, None, 10).expect("page");
        let value = serde_json::to_value(&page.items[0]).expect("json");
        assert!(value.get("path").is_none());
        assert!(value.get("metaJson").is_none());
        assert!(value.get("seriesId").is_none());
        assert!(value.get("nextUrl").is_none());
        assert!(value.get("lastOpenedAt").is_none());
        assert_eq!(value["sourceType"], "local");
        assert_eq!(value["pageCount"], 12);
        assert!(value["thumbUrl"].is_string());
    }

    #[test]
    fn detail_is_flat_and_resolves_series_next_book() {
        let state = state_with_db();
        let a = id_for('a');
        let b = id_for('b');
        insert_book(
            &state,
            &a,
            "Series 1",
            "2026-11-03 10:00:00",
            "C:/library/a.cbz",
            0,
            "local",
            "image",
            &series_meta("s1", "Series", 1),
            1,
        );
        insert_book(
            &state,
            &b,
            "Series 2",
            "2026-11-03 11:00:00",
            "C:/library/b.cbz",
            0,
            "local",
            "image",
            &series_meta("s1", "Series", 2),
            1,
        );

        let detail = book_detail(&state, &a).expect("detail");
        assert_eq!(detail.series_title.as_deref(), Some("Series"));
        assert_eq!(detail.chapter_index, Some(1));
        assert_eq!(detail.next_book_id.as_deref(), Some(b.as_str()));

        let value = serde_json::to_value(&detail).expect("json");
        assert_eq!(value["id"], a);
        assert_eq!(value["seriesTitle"], "Series");
        assert_eq!(value["chapterIndex"], 1);
        assert_eq!(value["nextBookId"], b);
        assert!(value.get("book").is_none());
        assert!(value.get("path").is_none());
    }

    #[test]
    fn next_book_id_excludes_a_removed_successor() {
        let state = state_with_db();
        let a = id_for('a');
        let next_url = "https://example.com/next";
        let removed_id = db::book_id_for_path(next_url);
        let meta = json!({
            "schema": 1,
            "manifestHash": "",
            "fetchedAt": "",
            "pages": [],
            "nextUrl": next_url
        })
        .to_string();
        insert_book(
            &state,
            &a,
            "Current",
            "2026-11-03 10:00:00",
            "C:/library/a.cbz",
            0,
            "local",
            "image",
            &meta,
            1,
        );
        insert_book(
            &state,
            &removed_id,
            "Removed successor",
            "2026-11-03 11:00:00",
            next_url,
            1,
            "generic_manga",
            "image",
            "{}",
            1,
        );

        let detail = book_detail(&state, &a).expect("detail");
        assert!(detail.next_book_id.is_none());
    }

    #[test]
    fn removed_or_missing_detail_is_not_found() {
        let state = state_with_db();
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Removed",
            "2026-11-03 10:00:00",
            "C:/library/a.cbz",
            1,
            "local",
            "image",
            "{}",
            1,
        );
        assert_eq!(book_detail(&state, &a), Err(DataError::NotFound));
        assert_eq!(book_detail(&state, &id_for('z')), Err(DataError::NotFound));
        assert_eq!(pages_manifest(&state, &a), Err(DataError::NotFound));
        assert_eq!(progress(&state, &a), Err(DataError::NotFound));
    }

    #[test]
    fn page_manifest_returns_only_indices() {
        let state = state_with_db();
        let tree = TempTree::new("pages");
        for name in ["1.jpg", "2.png", "10.webp"] {
            std::fs::write(tree.0.join(name), b"x").expect("page fixture");
        }
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Pages",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            99,
        );

        let manifest = pages_manifest(&state, &a).expect("manifest");
        assert_eq!(
            manifest.page_count, 3,
            "source count must win over stale DB"
        );
        assert_eq!(
            manifest
                .pages
                .iter()
                .map(|page| page.index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        let value = serde_json::to_value(&manifest).expect("json");
        assert_eq!(value["pageCount"], 3);
        assert_eq!(value["pages"][0]["index"], 0);
        assert!(value["pages"][0].get("name").is_none());
    }

    #[test]
    fn page_manifest_maps_pdf_missing_and_unsupported() {
        let state = state_with_db();
        let pdf = id_for('a');
        let missing = id_for('b');
        let anime = id_for('c');
        insert_book(
            &state,
            &pdf,
            "PDF",
            "2026-11-03 10:00:00",
            "C:/library/a.pdf",
            0,
            "local",
            BOOK_FORMAT_PDF,
            "{}",
            0,
        );
        insert_book(
            &state,
            &missing,
            "Missing",
            "2026-11-03 10:00:00",
            "C:/library/does-not-exist.cbz",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        insert_book(
            &state,
            &anime,
            "Anime",
            "2026-11-03 10:00:00",
            "https://example.invalid/list",
            0,
            "anime",
            "image",
            "{}",
            1,
        );

        assert_eq!(pages_manifest(&state, &pdf), Err(DataError::PdfUnsupported));
        assert_eq!(
            pages_manifest(&state, &missing),
            Err(DataError::SourceMissing)
        );
        assert_eq!(
            pages_manifest(&state, &anime),
            Err(DataError::SourceUnsupported)
        );
    }

    fn row_snapshot(
        state: &AppState,
        id: &str,
    ) -> (u32, f64, i64, String, String, String, i64, i64) {
        state
            .db
            .with(|conn| {
                let row = db::get_book(conn, id)
                    .map_err(|e| e.to_string())?
                    .expect("row");
                let (log_count, log_pages): (i64, i64) = conn
                    .query_row(
                        "SELECT COUNT(*), COALESCE(SUM(pages),0) FROM reading_log WHERE book_id=?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|e| e.to_string())?;
                Ok((
                    row.current_page,
                    row.scroll_pct,
                    row.progress_rev,
                    row.updated_at,
                    row.last_opened_at,
                    row.meta_json,
                    log_count,
                    log_pages,
                ))
            })
            .expect("snapshot")
    }

    #[test]
    fn read_operations_do_not_mutate_book_rows_or_reading_log() {
        let state = state_with_db();
        let tree = TempTree::new("immutable");
        for name in ["1.jpg", "2.png"] {
            std::fs::write(tree.0.join(name), b"x").expect("page fixture");
        }
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Immutable",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            &series_meta("s1", "Series", 1),
            2,
        );
        state
            .db
            .with(|conn| {
                conn.execute(
                    "UPDATE books SET current_page=1, scroll_pct=0.5, progress_rev=4 WHERE id=?1",
                    params![&a],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO reading_log(date,book_id,pages) VALUES('2026-11-03',?1,5)",
                    params![&a],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .expect("seed progress");

        let before = row_snapshot(&state, &a);
        let _ = list_books_page(&state, None, None, 10).expect("list");
        let _ = book_detail(&state, &a).expect("detail");
        let _ = pages_manifest(&state, &a).expect("manifest");
        let _ = progress(&state, &a).expect("progress");
        let after = row_snapshot(&state, &a);
        assert_eq!(after, before);
    }

    #[test]
    fn page_manifest_rejects_sensitive_local_paths() {
        let home = dirs::home_dir().expect("home directory must exist");
        let state = state_with_db();
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Sensitive",
            "2026-11-03 10:00:00",
            home.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        assert_eq!(pages_manifest(&state, &a), Err(DataError::SourceMissing));
    }

    #[test]
    fn progress_reads_rev_and_does_not_write() {
        let state = state_with_db();
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Progress",
            "2026-11-03 10:00:00",
            "C:/library/a.cbz",
            0,
            "local",
            "image",
            "{}",
            10,
        );
        state
            .db
            .with(|conn| {
                conn.execute(
                    "UPDATE books SET current_page=3, scroll_pct=0.25, progress_rev=7, updated_at='2026-11-03 11:00:00' WHERE id=?1",
                    params![&a],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .expect("progress setup");

        let before = state
            .db
            .with(|conn| db::get_book(conn, &a).map_err(|e| e.to_string()))
            .expect("before")
            .expect("row");
        let progress = progress(&state, &a).expect("progress");
        assert_eq!(progress.page, 3);
        assert_eq!(progress.page_count, 10);
        assert_eq!(progress.scroll_pct, 0.25);
        assert_eq!(progress.rev, 7);
        assert!(progress.updated_at.starts_with("2026-11-03T11:00:00"));

        let after = state
            .db
            .with(|conn| db::get_book(conn, &a).map_err(|e| e.to_string()))
            .expect("after")
            .expect("row");
        assert_eq!(after.current_page, before.current_page);
        assert_eq!(after.scroll_pct.to_bits(), before.scroll_pct.to_bits());
        assert_eq!(after.progress_rev, before.progress_rev);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(after.last_opened_at, before.last_opened_at);

        let value = serde_json::to_value(&progress).expect("json");
        assert_eq!(value["page"], 3);
        assert_eq!(value["pageCount"], 10);
        assert_eq!(value["scrollPct"], 0.25);
        assert_eq!(value["rev"], 7);
        assert!(value.get("updatedAt").is_some());
    }
}
