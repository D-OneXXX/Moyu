//! Read-only D2 data service.
//!
//! This module owns the Web DTOs and the read-only orchestration shared by the
//! future HTTP data layer. It uses the existing `DbSlot`, book metadata helpers,
//! and source handles; it never writes the database or reading progress.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{Local, NaiveDateTime, TimeZone};
use serde::Serialize;

use crate::commands::{get_next_book_impl, is_safe_library_source_path, to_book_info};
use crate::db::{self, BookRow};
use crate::pdf;
use crate::pipeline;
use crate::source::BackendError;
use crate::state::AppState;
use crate::PageDim;

/// Bound the Web page manifest independently of any source-reported count.
const MAX_WEB_PAGES: u32 = 10_000;
/// Frozen cover edge; the Web contract does not accept a size parameter.
pub(crate) const WEB_THUMB_EDGE: u32 = 256;

/// Stable data-plane failure classes; HTTP mapping is added by the route layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum DataError {
    NotFound,
    Removed,
    ThumbMissing,
    PdfUnsupported,
    SourceUnsupported,
    WebtoonTooLarge,
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

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ImageAsset {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub orig_width: u32,
    pub orig_height: u32,
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TileImage {
    pub image: ImageAsset,
    pub tile_count: u32,
    pub tile_height: u32,
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

/// Bytes-only page image. The Web path never populates L1 and never triggers
/// neighbour prefetch; it reuses L2 and the existing render pipeline.
pub(crate) fn page_asset(
    state: &Arc<AppState>,
    id: &str,
    index: u32,
    width: u32,
    encode_data_url: bool,
    use_l1: bool,
) -> Result<ImageAsset, DataError> {
    let cache_epoch = state.refresh_epoch();
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return Err(DataError::PdfUnsupported);
    }
    ensure_source_allowed(&row)?;
    let handle = state
        .source_handle_for_book(id)
        .map_err(|_| DataError::SourceMissing)?;
    let count = handle.page_count().map_err(|_| DataError::SourceMissing)?;
    if index as usize >= count {
        return Err(DataError::PageOutOfRange {
            max_page: count.saturating_sub(1) as u32,
        });
    }
    let width = width.clamp(320, 2160);

    if use_l1 && encode_data_url {
        if let Some(hit) = state.cache.get_page(id, index, width, 0) {
            return Ok(asset_from_rendered(hit, true));
        }
    }
    if let Some(bytes) = state.render.get(id, index, width, 0) {
        match assembled_asset(bytes, 0, 0, encode_data_url) {
            Ok(asset) => return Ok(asset),
            Err(_) => state.render.remove_page(id, index, width, 0),
        }
    }

    let raw = handle
        .read_raw(index as usize)
        .map_err(|_| DataError::SourceMissing)?;
    let rendered = if encode_data_url {
        pipeline::render_raw(&raw, Some(width), None)
    } else {
        pipeline::render_raw_asset(&raw, Some(width), None, false)
    }
    .map_err(|_| DataError::SourceMissing)?;
    state.cache_if_current(cache_epoch, || {
        state.render.put(id, index, width, 0, &rendered.bytes)
    });
    state.note_cache_write(raw.bytes.len().saturating_add(rendered.bytes.len()));
    if use_l1 && encode_data_url {
        state.cache_if_current(cache_epoch, || {
            state.cache.put_page(id, index, width, 0, rendered.clone())
        });
    }
    Ok(asset_from_rendered(rendered, encode_data_url))
}

/// First-page cover. Image books use the existing render cache; PDF covers use
/// the cache written by the desktop PDF.js path. No database write.
pub(crate) fn thumb_asset(state: &Arc<AppState>, id: &str) -> Result<ImageAsset, DataError> {
    let cache_epoch = state.refresh_epoch();
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return pdf_thumb_asset(state, id);
    }
    ensure_source_allowed(&row)?;
    let handle = state
        .source_handle_for_book(id)
        .map_err(|_| DataError::SourceMissing)?;
    let count = handle.page_count().map_err(|_| DataError::SourceMissing)?;
    if count == 0 {
        return Err(DataError::ThumbMissing);
    }
    let edge = WEB_THUMB_EDGE;
    if let Some(bytes) = state.render.get(id, 0, edge, edge) {
        match assembled_asset(bytes, 0, 0, false) {
            Ok(asset) => return Ok(asset),
            Err(_) => state.render.remove_page(id, 0, edge, edge),
        }
    }

    let raw = handle.read_raw(0).map_err(|_| DataError::SourceMissing)?;
    let rendered = pipeline::render_raw_asset(&raw, Some(edge), Some(edge), false)
        .map_err(|_| DataError::SourceMissing)?;
    state.cache_if_current(cache_epoch, || {
        state.render.put(id, 0, edge, edge, &rendered.bytes)
    });
    state.note_cache_write(raw.bytes.len().saturating_add(rendered.bytes.len()));
    Ok(asset_from_rendered(rendered, false))
}

/// One webtoon tile. Layout must exist first (usually requested before tiles);
/// the 800 ms materialisation lock wait maps to `busy`, never an infinite wait.
pub(crate) fn tile_asset(
    state: &Arc<AppState>,
    id: &str,
    index: u32,
    tile: u32,
    width: u32,
) -> Result<TileImage, DataError> {
    let cache_epoch = state.refresh_epoch();
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return Err(DataError::PdfUnsupported);
    }
    ensure_source_allowed(&row)?;
    let handle = state
        .source_handle_for_book(id)
        .map_err(|_| DataError::SourceMissing)?;
    let count = handle.page_count().map_err(|_| DataError::SourceMissing)?;
    if index as usize >= count {
        return Err(DataError::PageOutOfRange {
            max_page: count.saturating_sub(1) as u32,
        });
    }
    let dims = layout_read_only(state, id)?;
    let orig = dims
        .get(index as usize)
        .map(|dim| (dim.width, dim.height))
        .unwrap_or((0, 0));
    let width = bucket_tile_width(width);
    let display_height = pipeline::fit_size(orig.0, orig.1, Some(width), None).1;
    let expected_tiles =
        pipeline::webtoon_tile_count(orig.0, orig.1, width).min(display_height.max(1));
    if expected_tiles > pipeline::MAX_WEBTOON_WEB_TILES {
        return Err(DataError::WebtoonTooLarge);
    }
    if tile >= expected_tiles {
        return Err(DataError::TileOutOfRange {
            max_tile: expected_tiles.saturating_sub(1),
        });
    }

    if let Some(bytes) = state.render.get_tile(id, index, tile, width) {
        match assembled_asset(bytes, orig.0, orig.1, false) {
            Ok(image) => {
                return Ok(TileImage {
                    image,
                    tile_count: expected_tiles,
                    tile_height: pipeline::WEBTOON_TILE_H,
                });
            }
            Err(_) => state.render.remove_tile(id, index, tile, width),
        }
    }

    let raw = handle
        .read_raw(index as usize)
        .map_err(|_| DataError::SourceMissing)?;
    let _guard = state
        .tile_lock
        .try_lock_for(Duration::from_millis(800))
        .ok_or(DataError::Busy)?;

    if let Some(bytes) = state.render.get_tile(id, index, tile, width) {
        let image = assembled_asset(bytes, orig.0, orig.1, false)?;
        return Ok(TileImage {
            image,
            tile_count: expected_tiles,
            tile_height: pipeline::WEBTOON_TILE_H,
        });
    }

    let (tiles, pages) =
        pipeline::render_webtoon_tiles_asset(&raw, width, false).map_err(|error| match error {
            BackendError::WebtoonTooLarge => DataError::WebtoonTooLarge,
            _ => DataError::Internal,
        })?;
    if tile >= tiles {
        return Err(DataError::TileOutOfRange {
            max_tile: tiles.saturating_sub(1),
        });
    }
    let mut written = raw.bytes.len();
    for (tile_index, page) in pages.iter().enumerate() {
        written = written.saturating_add(page.bytes.len());
        state.cache_if_current(cache_epoch, || {
            state
                .render
                .put_tile(id, index, tile_index as u32, width, &page.bytes);
        });
    }
    state.note_cache_write(written);
    let page = pages
        .into_iter()
        .nth(tile as usize)
        .ok_or(DataError::TileOutOfRange {
            max_tile: tiles.saturating_sub(1),
        })?;
    Ok(TileImage {
        image: asset_from_rendered(page, false),
        tile_count: tiles,
        tile_height: pipeline::WEBTOON_TILE_H,
    })
}

/// Cache-only page probe used before rendering a conditional GET response.
/// Mirrors the guards of [`page_asset`] but only reads L2: it never renders,
/// never touches L1 or the database, never prefetches and never writes new
/// cache bytes. A corrupt L2 entry is evicted so the next request re-renders.
pub(crate) fn cached_page_asset(
    state: &Arc<AppState>,
    id: &str,
    index: u32,
    width: u32,
) -> Result<Option<ImageAsset>, DataError> {
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return Err(DataError::PdfUnsupported);
    }
    ensure_source_allowed(&row)?;
    let handle = state
        .source_handle_for_book(id)
        .map_err(|_| DataError::SourceMissing)?;
    let count = handle.page_count().map_err(|_| DataError::SourceMissing)?;
    if index as usize >= count {
        return Err(DataError::PageOutOfRange {
            max_page: count.saturating_sub(1) as u32,
        });
    }
    let width = width.clamp(320, 2160);
    let Some(bytes) = state.render.get(id, index, width, 0) else {
        return Ok(None);
    };
    match assembled_asset(bytes, 0, 0, false) {
        Ok(asset) => Ok(Some(asset)),
        Err(_) => {
            state.render.remove_page(id, index, width, 0);
            Ok(None)
        }
    }
}

/// Cache-only tile probe used before rendering a conditional GET response.
/// Mirrors the guards and geometry of [`tile_asset`] but only reads L2 for the
/// image bytes: it never takes the tile materialisation lock, never renders,
/// and never writes new cache or database state. A corrupt L2 tile is evicted
/// so the next request re-renders. It still reads the layout (local page
/// headers or cached online dimensions), which can scan the source without
/// producing image bytes.
pub(crate) fn cached_tile_asset(
    state: &Arc<AppState>,
    id: &str,
    index: u32,
    tile: u32,
    width: u32,
) -> Result<Option<TileImage>, DataError> {
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return Err(DataError::PdfUnsupported);
    }
    ensure_source_allowed(&row)?;
    let handle = state
        .source_handle_for_book(id)
        .map_err(|_| DataError::SourceMissing)?;
    let count = handle.page_count().map_err(|_| DataError::SourceMissing)?;
    if index as usize >= count {
        return Err(DataError::PageOutOfRange {
            max_page: count.saturating_sub(1) as u32,
        });
    }
    let dims = layout_read_only(state, id)?;
    let orig = dims
        .get(index as usize)
        .map(|dim| (dim.width, dim.height))
        .unwrap_or((0, 0));
    let width = bucket_tile_width(width);
    let display_height = pipeline::fit_size(orig.0, orig.1, Some(width), None).1;
    let expected_tiles =
        pipeline::webtoon_tile_count(orig.0, orig.1, width).min(display_height.max(1));
    if expected_tiles > pipeline::MAX_WEBTOON_WEB_TILES {
        return Err(DataError::WebtoonTooLarge);
    }
    if tile >= expected_tiles {
        return Err(DataError::TileOutOfRange {
            max_tile: expected_tiles.saturating_sub(1),
        });
    }
    let Some(bytes) = state.render.get_tile(id, index, tile, width) else {
        return Ok(None);
    };
    match assembled_asset(bytes, orig.0, orig.1, false) {
        Ok(image) => Ok(Some(TileImage {
            image,
            tile_count: expected_tiles,
            tile_height: pipeline::WEBTOON_TILE_H,
        })),
        Err(_) => {
            state.render.remove_tile(id, index, tile, width);
            Ok(None)
        }
    }
}

/// Read-only layout. Online missing dimensions are probed into memory only;
/// `persist_online` is false, so `meta_json` is never rewritten.
pub(crate) fn layout_read_only(state: &AppState, id: &str) -> Result<Vec<PageDim>, DataError> {
    let row = active_row(state, id)?;
    if row.format == db::BOOK_FORMAT_PDF {
        return Err(DataError::PdfUnsupported);
    }
    ensure_source_allowed(&row)?;
    layout_sync(state, id, false).map_err(|_| DataError::SourceMissing)
}

/// Shared layout scanner used by the desktop command and the Web read path.
/// `persist_online` preserves the desktop behaviour of writing probed online
/// dimensions back to `meta_json`; the Web path always passes false.
pub(crate) fn layout_sync(
    state: &AppState,
    book_id: &str,
    persist_online: bool,
) -> Result<Vec<PageDim>, BackendError> {
    let cache_epoch = state.refresh_epoch();
    if let Some(cached) = state.webtoon_layouts.lock().get(book_id).cloned() {
        return Ok(page_dims(&cached));
    }
    let row = state
        .db
        .with(|conn| db::get_book(conn, book_id).map_err(|e| e.to_string()))
        .map_err(BackendError::Msg)?
        .ok_or_else(|| BackendError::Msg("书籍不存在".into()))?;

    if row.source_type != "local" {
        let mut meta: crate::online::StoredMeta = serde_json::from_str(&row.meta_json)
            .map_err(|e| BackendError::Msg(format!("在线书元数据损坏：{e}")))?;
        if meta.pages.is_empty() {
            return Err(BackendError::Msg("该在线书籍没有可阅读页面".into()));
        }
        let mut dims: Vec<(u32, u32)> = meta
            .pages
            .iter()
            .map(|page| (page.width.unwrap_or(0), page.height.unwrap_or(0)))
            .collect();
        let missing: Vec<usize> = dims
            .iter()
            .enumerate()
            .filter(|(_, (width, height))| *width == 0 || *height == 0)
            .map(|(index, _)| index)
            .collect();
        if !missing.is_empty() {
            let handle = state.source_handle_for_book(book_id)?;
            for index in missing {
                let raw = handle.read_raw(index)?;
                let (width, height) = image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
                    .with_guessed_format()?
                    .into_dimensions()?;
                if width == 0 || height == 0 {
                    return Err(BackendError::Msg(format!("第 {} 页尺寸无效", index + 1)));
                }
                dims[index] = (width, height);
                if let Some(page) = meta.pages.get_mut(index) {
                    page.width = Some(width);
                    page.height = Some(height);
                }
            }
            if persist_online {
                if let Ok(json) = serde_json::to_string(&meta) {
                    let _ = state.db.with(|conn| {
                        db::upsert_online_book(
                            conn,
                            &row.id,
                            &row.path,
                            &row.title,
                            row.page_count,
                            &row.source_type,
                            &json,
                        )
                        .map_err(|e| e.to_string())
                    });
                }
            }
        }
        state.cache_if_current(cache_epoch, || {
            state
                .webtoon_layouts
                .lock()
                .insert(book_id.to_string(), Arc::new(dims.clone()));
        });
        return Ok(page_dims(&dims));
    }

    let handle = state.source_handle_for_book(book_id)?;
    let count = handle.page_count()?;
    let mut dims: Vec<(u32, u32)> = Vec::with_capacity(count);
    for index in 0..count {
        let header: Option<(u32, u32)> =
            handle
                .read_partial(index, 256 * 1024)
                .ok()
                .and_then(|partial| {
                    image::ImageReader::new(std::io::Cursor::new(&partial.bytes))
                        .with_guessed_format()
                        .ok()
                        .and_then(|reader| reader.into_dimensions().ok())
                        .filter(|(width, height)| *width > 0 && *height > 0)
                });
        let (width, height) = match header {
            Some(dimensions) => dimensions,
            None => {
                let raw = handle.read_raw(index)?;
                image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
                    .with_guessed_format()?
                    .into_dimensions()?
            }
        };
        dims.push((width, height));
    }
    state.cache_if_current(cache_epoch, || {
        state
            .webtoon_layouts
            .lock()
            .insert(book_id.to_string(), Arc::new(dims.clone()));
    });
    Ok(page_dims(&dims))
}

pub(crate) fn bucket_tile_width(width: u32) -> u32 {
    let clamped = width.clamp(320, 2160);
    (((clamped + 32) / 64) * 64).clamp(320, 2160)
}

fn page_dims(dims: &[(u32, u32)]) -> Vec<PageDim> {
    dims.iter()
        .enumerate()
        .map(|(index, (width, height))| PageDim {
            index: index as u32,
            width: *width,
            height: *height,
        })
        .collect()
}

fn asset_from_rendered(page: pipeline::RenderedPage, encode_data_url: bool) -> ImageAsset {
    ImageAsset {
        bytes: page.bytes,
        mime: "image/jpeg",
        width: page.width,
        height: page.height,
        orig_width: page.orig_width,
        orig_height: page.orig_height,
        data_url: if encode_data_url {
            Some(page.data_url)
        } else {
            None
        },
    }
}

fn assembled_asset(
    bytes: Vec<u8>,
    orig_width: u32,
    orig_height: u32,
    encode_data_url: bool,
) -> Result<ImageAsset, DataError> {
    let (width, height) = pdf::jpeg_dims(&bytes).map_err(|_| DataError::Internal)?;
    let data_url =
        encode_data_url.then(|| format!("data:image/jpeg;base64,{}", B64.encode(&bytes)));
    Ok(ImageAsset {
        bytes,
        mime: "image/jpeg",
        width,
        height,
        orig_width: if orig_width > 0 { orig_width } else { width },
        orig_height: if orig_height > 0 { orig_height } else { height },
        data_url,
    })
}

fn pdf_thumb_asset(state: &Arc<AppState>, id: &str) -> Result<ImageAsset, DataError> {
    let Some(bytes) = state
        .render
        .get_raw(id, 0, pdf::PDF_COVER_EDGE, pdf::PDF_COVER_EDGE)
    else {
        return Err(DataError::ThumbMissing);
    };
    match pdf::validate_pdf_cover_read(&bytes) {
        Ok((width, height)) => {
            let mime = if pdf::is_jpeg(&bytes) {
                "image/jpeg"
            } else {
                "image/png"
            };
            Ok(ImageAsset {
                bytes,
                mime,
                width,
                height,
                orig_width: width,
                orig_height: height,
                data_url: None,
            })
        }
        Err(_) => {
            state
                .render
                .remove_page(id, 0, pdf::PDF_COVER_EDGE, pdf::PDF_COVER_EDGE);
            Err(DataError::ThumbMissing)
        }
    }
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

pub(crate) fn iso_local(raw: &str) -> String {
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
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use rusqlite::params;
    use serde_json::json;

    use super::*;
    use crate::db::{self, BOOK_FORMAT_PDF};
    use crate::state::AppState;

    fn id_for(seed: char) -> String {
        seed.to_string().repeat(64)
    }

    thread_local! {
        /// Per-test-thread render root. `TempTree` removes it when the test
        /// thread exits, so L2 renders never touch the real user cache.
        static TEST_RENDER_TREE: TempTree = TempTree::new("read-service-render");
    }

    fn state_with_db() -> AppState {
        let mut state = AppState::new();
        TEST_RENDER_TREE.with(|tree| {
            state.render = crate::render_cache::RenderCache::new(tree.0.join("render"));
        });
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

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder as _;
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 96])
        });
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .expect("png encode");
        bytes
    }

    fn jpeg_bytes(width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder as _;
        let image = image::RgbImage::from_fn(width, height, |_x, _y| image::Rgb([32, 64, 96]));
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80)
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .expect("jpeg encode");
        bytes
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
    fn page_asset_is_bytes_only_and_skips_l1_and_prefetch() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("page-asset");
        std::fs::write(tree.0.join("page.png"), png_bytes(40, 300)).expect("page");
        let a = id_for('a');
        insert_book(
            &state,
            &a,
            "Page",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        state.render.remove_page(&a, 0, 320, 0);

        let asset = page_asset(&state, &a, 0, 20, false, false).expect("page asset");
        assert!(asset.data_url.is_none());
        assert_eq!(asset.mime, "image/jpeg");
        assert!(asset.bytes.starts_with(&[0xFF, 0xD8]));
        assert_eq!((asset.width, asset.height), (40, 300));
        assert_eq!((asset.orig_width, asset.orig_height), (40, 300));
        assert!(state.cache.get_page(&a, 0, 320, 0).is_none());
        assert!(state.prefetching.lock().is_empty());
        assert!(state.render.get(&a, 0, 320, 0).is_some());

        let again = page_asset(&state, &a, 0, 20, false, false).expect("L2 page");
        assert_eq!(again.bytes, asset.bytes);

        // use_l1 without base64 must never return the empty L1 bytes body.
        let bytes_only = page_asset(&state, &a, 0, 320, false, true).expect("bytes-only L2");
        assert!(bytes_only.data_url.is_none());
        assert!(!bytes_only.bytes.is_empty());
        let desktop_shape = page_asset(&state, &a, 0, 320, true, true).expect("data-url L2");
        assert!(desktop_shape
            .data_url
            .as_deref()
            .unwrap_or_default()
            .starts_with("data:image/jpeg;base64,"));
        assert!(!desktop_shape.bytes.is_empty());
    }

    #[test]
    fn page_asset_maps_pdf_range_and_missing_source() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("page-errors");
        std::fs::write(tree.0.join("page.png"), png_bytes(20, 20)).expect("page");
        let image = id_for('a');
        let pdf = id_for('b');
        let missing = id_for('c');
        insert_book(
            &state,
            &image,
            "Image",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
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
            "C:/library/missing.cbz",
            0,
            "local",
            "image",
            "{}",
            1,
        );

        assert_eq!(
            page_asset(&state, &pdf, 0, 320, false, false),
            Err(DataError::PdfUnsupported)
        );
        assert_eq!(
            page_asset(&state, &image, 5, 320, false, false),
            Err(DataError::PageOutOfRange { max_page: 0 })
        );
        assert_eq!(
            page_asset(&state, &missing, 0, 320, false, false),
            Err(DataError::SourceMissing)
        );
    }

    #[test]
    fn thumb_asset_reads_first_page_and_pdf_cover() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("thumb-asset");
        std::fs::write(tree.0.join("page.png"), png_bytes(40, 40)).expect("page");
        let image = id_for('a');
        let pdf = id_for('b');
        insert_book(
            &state,
            &image,
            "Image",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
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

        state.render.remove_page(&image, 0, 256, 256);
        let thumb = thumb_asset(&state, &image).expect("image thumb");
        assert!(thumb.data_url.is_none());
        assert!(thumb.bytes.starts_with(&[0xFF, 0xD8]));
        assert_eq!(thumb.width, 40);

        state.render.put(
            &pdf,
            0,
            crate::pdf::PDF_COVER_EDGE,
            crate::pdf::PDF_COVER_EDGE,
            &jpeg_bytes(crate::pdf::PDF_COVER_EDGE, crate::pdf::PDF_COVER_EDGE),
        );
        let cover = thumb_asset(&state, &pdf).expect("pdf jpeg cover");
        assert!(cover.data_url.is_none());
        assert_eq!(cover.mime, "image/jpeg");
        assert!(cover.bytes.starts_with(&[0xFF, 0xD8]));
        state.render.remove_page(
            &pdf,
            0,
            crate::pdf::PDF_COVER_EDGE,
            crate::pdf::PDF_COVER_EDGE,
        );

        // Legacy PNG covers are readable and must not be deleted as "corrupt".
        state.render.put(
            &pdf,
            0,
            crate::pdf::PDF_COVER_EDGE,
            crate::pdf::PDF_COVER_EDGE,
            &png_bytes(256, 256),
        );
        let png_cover = thumb_asset(&state, &pdf).expect("pdf png cover");
        assert_eq!(png_cover.mime, "image/png");
        assert!(state
            .render
            .get_raw(
                &pdf,
                0,
                crate::pdf::PDF_COVER_EDGE,
                crate::pdf::PDF_COVER_EDGE
            )
            .is_some());
        state.render.remove_page(
            &pdf,
            0,
            crate::pdf::PDF_COVER_EDGE,
            crate::pdf::PDF_COVER_EDGE,
        );

        state.render.put(
            &pdf,
            0,
            crate::pdf::PDF_COVER_EDGE,
            crate::pdf::PDF_COVER_EDGE,
            b"not an image",
        );
        assert_eq!(thumb_asset(&state, &pdf), Err(DataError::ThumbMissing));
        assert!(state
            .render
            .get_raw(
                &pdf,
                0,
                crate::pdf::PDF_COVER_EDGE,
                crate::pdf::PDF_COVER_EDGE
            )
            .is_none());

        state.render.put(
            &pdf,
            0,
            crate::pdf::PDF_COVER_EDGE,
            crate::pdf::PDF_COVER_EDGE,
            &crate::pdf::fixtures::png_header(5000, 5000),
        );
        assert_eq!(thumb_asset(&state, &pdf), Err(DataError::ThumbMissing));
        assert!(state
            .render
            .get_raw(
                &pdf,
                0,
                crate::pdf::PDF_COVER_EDGE,
                crate::pdf::PDF_COVER_EDGE
            )
            .is_none());
    }

    #[test]
    fn tile_asset_returns_geometry_and_rejects_range() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("tile-asset");
        std::fs::write(tree.0.join("page.png"), png_bytes(400, 6000)).expect("page");
        let a = id_for('d');
        insert_book(
            &state,
            &a,
            "Tall",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        state.render.remove_tile(&a, 0, 0, 320);

        let tile = tile_asset(&state, &a, 0, 0, 320).expect("tile");
        assert!(tile.image.data_url.is_none());
        assert!(tile.image.bytes.starts_with(&[0xFF, 0xD8]));
        assert_eq!(tile.image.width, 320);
        assert_eq!(tile.tile_count, 3);
        assert_eq!(tile.tile_height, crate::pipeline::WEBTOON_TILE_H);
        assert_eq!(tile.image.orig_width, 400);
        assert_eq!(tile.image.orig_height, 6000);
        assert_eq!(
            tile_asset(&state, &a, 0, 3, 320),
            Err(DataError::TileOutOfRange { max_tile: 2 })
        );
    }

    #[test]
    fn narrow_web_image_uses_real_output_height_for_tile_count() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("web-tile-narrow");
        std::fs::write(tree.0.join("page.png"), png_bytes(1, 10_000)).unwrap();
        let id = id_for('8');
        insert_book(
            &state,
            &id,
            "Narrow",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        let first = tile_asset(&state, &id, 0, 0, 320).unwrap();
        assert_eq!(first.tile_count, 5);
        let last = tile_asset(&state, &id, 0, 4, 320).unwrap();
        assert_eq!(last.tile_count, 5);
        assert_eq!(
            tile_asset(&state, &id, 0, 5, 320),
            Err(DataError::TileOutOfRange { max_tile: 4 })
        );
    }

    #[test]
    fn web_tile_rejects_excessive_tile_count_before_cache_or_decode() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("web-tile-budget");
        std::fs::write(tree.0.join("page.png"), png_bytes(1, 2_100_000)).unwrap();
        let id = id_for('9');
        insert_book(
            &state,
            &id,
            "Extreme",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        assert_eq!(
            tile_asset(&state, &id, 0, 0, 320),
            Err(DataError::WebtoonTooLarge)
        );
        assert_eq!(
            cached_tile_asset(&state, &id, 0, 0, 320),
            Err(DataError::WebtoonTooLarge)
        );
        assert!(state.render.get_tile(&id, 0, 0, 320).is_none());
    }

    #[test]
    fn tile_width_bucket_and_tile_count_match_renderer() {
        assert_eq!(bucket_tile_width(320), 320);
        assert_eq!(bucket_tile_width(1080), 1088);
        assert_eq!(bucket_tile_width(2160), 2160);

        let state = Arc::new(state_with_db());
        let tree = TempTree::new("tile-clamp");
        std::fs::write(tree.0.join("page.png"), png_bytes(1, 300)).expect("page");
        let a = id_for('f');
        insert_book(
            &state,
            &a,
            "Clamp",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        // The source is not upscaled: 300 actual rows fit in one tile.
        assert_eq!(tile_asset(&state, &a, 0, 0, 2112).unwrap().tile_count, 1);
        assert_eq!(
            tile_asset(&state, &a, 0, 1, 2112),
            Err(DataError::TileOutOfRange { max_tile: 0 })
        );
    }

    #[test]
    fn tile_asset_returns_busy_when_materialization_lock_is_held() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("tile-busy");
        std::fs::write(tree.0.join("page.png"), png_bytes(20, 5000)).expect("page");
        let a = id_for('e');
        insert_book(
            &state,
            &a,
            "Busy",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        state.render.remove_tile(&a, 0, 0, 320);

        let _guard = state.tile_lock.lock();
        let started = std::time::Instant::now();
        assert_eq!(tile_asset(&state, &a, 0, 0, 320), Err(DataError::Busy));
        assert!(started.elapsed() >= Duration::from_millis(700));
    }

    #[test]
    fn layout_read_only_reads_local_and_online_without_meta_write() {
        let state = state_with_db();
        let tree = TempTree::new("layout-readonly");
        std::fs::write(tree.0.join("1.png"), png_bytes(10, 20)).expect("page 1");
        std::fs::write(tree.0.join("2.png"), png_bytes(10, 30)).expect("page 2");
        let local = id_for('a');
        insert_book(
            &state,
            &local,
            "Local layout",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            2,
        );
        let dims = layout_read_only(&state, &local).expect("local layout");
        assert_eq!(
            dims.iter()
                .map(|dim| (dim.width, dim.height))
                .collect::<Vec<_>>(),
            vec![(10, 20), (10, 30)]
        );

        let online = id_for('b');
        let meta = json!({
            "schema": 1,
            "manifestHash": "",
            "fetchedAt": "",
            "pages": [
                {"url": "https://example.com/1.png", "width": 10, "height": 20},
                {"url": "https://example.com/2.png", "width": 10, "height": 30}
            ]
        })
        .to_string();
        insert_book(
            &state,
            &online,
            "Online layout",
            "2026-11-03 10:00:00",
            "https://example.com/gallery",
            0,
            "generic_manga",
            "image",
            &meta,
            2,
        );
        let before = state
            .db
            .with(|conn| db::get_book(conn, &online).map_err(|e| e.to_string()))
            .expect("before")
            .expect("row")
            .meta_json;
        let dims = layout_read_only(&state, &online).expect("online layout");
        assert_eq!(
            dims.iter()
                .map(|dim| (dim.width, dim.height))
                .collect::<Vec<_>>(),
            vec![(10, 20), (10, 30)]
        );
        let after = state
            .db
            .with(|conn| db::get_book(conn, &online).map_err(|e| e.to_string()))
            .expect("after")
            .expect("row")
            .meta_json;
        assert_eq!(before, after);
    }

    #[test]
    fn layout_read_only_probes_online_missing_dims_without_meta_write() {
        let state = state_with_db();
        let tree = TempTree::new("layout-probe");
        std::fs::write(tree.0.join("1.png"), png_bytes(10, 20)).expect("page 1");
        std::fs::write(tree.0.join("2.png"), png_bytes(10, 30)).expect("page 2");
        let online = id_for('c');
        let meta = json!({
            "schema": 1,
            "manifestHash": "",
            "fetchedAt": "",
            "pages": [
                {"url": "https://example.com/1.png"},
                {"url": "https://example.com/2.png"}
            ]
        })
        .to_string();
        insert_book(
            &state,
            &online,
            "Probe",
            "2026-11-03 10:00:00",
            "https://example.com/gallery",
            0,
            "generic_manga",
            "image",
            &meta,
            2,
        );
        state.sources.lock().insert(
            online.clone(),
            Arc::new(crate::source::SourceHandle::open(&tree.0).expect("local probe source")),
        );

        let dims = layout_read_only(&state, &online).expect("probed layout");
        assert_eq!(
            dims.iter()
                .map(|dim| (dim.width, dim.height))
                .collect::<Vec<_>>(),
            vec![(10, 20), (10, 30)]
        );
        let after = state
            .db
            .with(|conn| db::get_book(conn, &online).map_err(|e| e.to_string()))
            .expect("after")
            .expect("row")
            .meta_json;
        assert_eq!(after, meta, "Web layout must not rewrite meta_json");
    }

    #[test]
    fn layout_read_only_rejects_pdf() {
        let state = state_with_db();
        let pdf = id_for('a');
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
        assert_eq!(
            layout_read_only(&state, &pdf),
            Err(DataError::PdfUnsupported)
        );
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

    #[test]
    fn cached_page_asset_returns_none_until_rendered_then_hits_l2() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("cached-page");
        std::fs::write(tree.0.join("page.png"), png_bytes(400, 300)).expect("page");
        let a = id_for('p');
        insert_book(
            &state,
            &a,
            "Cached page",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        state.render.remove_page(&a, 0, 320, 0);

        assert_eq!(cached_page_asset(&state, &a, 0, 320), Ok(None));

        let rendered = page_asset(&state, &a, 0, 320, false, false).expect("fill l2");
        let cached = cached_page_asset(&state, &a, 0, 320)
            .expect("probe")
            .expect("l2 hit");
        assert!(cached.data_url.is_none());
        assert!(cached.bytes.starts_with(&[0xFF, 0xD8]));
        assert_eq!(cached.width, 320);
        assert_eq!(cached.bytes, rendered.bytes);
        assert!(state.cache.get_page(&a, 0, 320, 0).is_none());
        assert!(state.prefetching.lock().is_empty());

        state.render.remove_page(&a, 0, 320, 0);
        assert_eq!(cached_page_asset(&state, &a, 0, 320), Ok(None));
    }

    #[test]
    fn cached_tile_asset_returns_none_until_rendered_then_hits_l2() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("cached-tile");
        std::fs::write(tree.0.join("page.png"), png_bytes(400, 6000)).expect("page");
        let a = id_for('q');
        insert_book(
            &state,
            &a,
            "Cached tile",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
        let width = bucket_tile_width(320);
        state.render.remove_tile(&a, 0, 0, width);

        assert_eq!(cached_tile_asset(&state, &a, 0, 0, width), Ok(None));

        let rendered = tile_asset(&state, &a, 0, 0, width).expect("fill tiles");
        let cached = cached_tile_asset(&state, &a, 0, 0, width)
            .expect("probe")
            .expect("l2 hit");
        assert!(cached.image.data_url.is_none());
        assert!(cached.image.bytes.starts_with(&[0xFF, 0xD8]));
        assert!(cached.tile_count >= 1);
        assert_eq!(cached.tile_count, rendered.tile_count);
        assert_eq!(cached.tile_height, pipeline::WEBTOON_TILE_H);
        assert_eq!(cached.image.bytes, rendered.image.bytes);
        assert!(state.cache.get_page(&a, 0, width, 0).is_none());

        state.render.remove_tile(&a, 0, 0, width);
        assert_eq!(cached_tile_asset(&state, &a, 0, 0, width), Ok(None));
    }

    #[test]
    fn cached_probes_keep_typed_errors() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("cached-errors");
        std::fs::write(tree.0.join("page.png"), png_bytes(20, 2000)).expect("page");
        let image = id_for('r');
        let pdf = id_for('s');
        let removed = id_for('t');
        insert_book(
            &state,
            &image,
            "Image",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
        );
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
            &removed,
            "Removed",
            "2026-11-03 10:00:00",
            "C:/library/removed.cbz",
            1,
            "local",
            "image",
            "{}",
            1,
        );
        state.render.remove_page(&image, 0, 320, 0);
        state.render.remove_tile(&image, 0, 0, 320);

        assert_eq!(
            cached_page_asset(&state, &pdf, 0, 320),
            Err(DataError::PdfUnsupported)
        );
        assert_eq!(
            cached_tile_asset(&state, &pdf, 0, 0, 320),
            Err(DataError::PdfUnsupported)
        );
        assert_eq!(
            cached_page_asset(&state, &image, 5, 320),
            Err(DataError::PageOutOfRange { max_page: 0 })
        );
        assert_eq!(
            cached_tile_asset(&state, &image, 5, 0, 320),
            Err(DataError::PageOutOfRange { max_page: 0 })
        );
        assert!(matches!(
            cached_tile_asset(&state, &image, 0, 1000, 320),
            Err(DataError::TileOutOfRange { .. })
        ));
        assert_eq!(
            cached_page_asset(&state, &removed, 0, 320),
            Err(DataError::NotFound)
        );
        assert_eq!(
            cached_tile_asset(&state, &removed, 0, 0, 320),
            Err(DataError::NotFound)
        );
    }

    #[test]
    fn cached_probes_do_not_mutate_progress_or_reading_log() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("cached-integrity");
        std::fs::write(tree.0.join("page.png"), png_bytes(40, 300)).expect("page");
        let a = id_for('u');
        insert_book(
            &state,
            &a,
            "Cached integrity",
            "2026-11-03 10:00:00",
            tree.0.to_string_lossy().as_ref(),
            0,
            "local",
            "image",
            "{}",
            1,
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
        state.render.remove_page(&a, 0, 320, 0);
        state.render.remove_tile(&a, 0, 0, 320);

        let before = row_snapshot(&state, &a);
        let _ = cached_page_asset(&state, &a, 0, 320).expect("probe page");
        let _ = cached_tile_asset(&state, &a, 0, 0, 320).expect("probe tile");
        let _ = cached_page_asset(&state, &a, 9, 320).expect_err("range stays typed");
        let after = row_snapshot(&state, &a);
        assert_eq!(after, before);
    }

    fn assert_no_path_in_debug(error: &DataError, path: &str) {
        let debug = format!("{error:?}");
        assert!(
            !debug.contains(path),
            "error debug leaked the source path: {debug}"
        );
        assert!(
            !debug.contains("C:"),
            "error debug leaked a Windows drive prefix: {debug}"
        );
    }

    #[test]
    fn removed_book_is_not_served_by_thumb_or_cache_probes() {
        let tree = TempTree::new("removed-reads");
        let page = tree.0.join("page.png");
        std::fs::write(&page, png_bytes(40, 40)).expect("page fixture");
        // Keep any accidental cache write inside this test's temp tree rather
        // than the real user render cache.
        let mut state = state_with_db();
        state.render = crate::render_cache::RenderCache::new(tree.0.join("render"));
        let state = Arc::new(state);
        let id = id_for('r');
        insert_book(
            &state,
            &id,
            "Removed with real source",
            "2026-11-03 10:00:00",
            page.to_string_lossy().as_ref(),
            1,
            "local",
            "image",
            "{}",
            1,
        );

        assert_eq!(thumb_asset(&state, &id), Err(DataError::NotFound));
        assert_eq!(
            cached_page_asset(&state, &id, 0, 320),
            Err(DataError::NotFound)
        );
        assert_eq!(
            cached_tile_asset(&state, &id, 0, 0, 320),
            Err(DataError::NotFound)
        );
        // Full render entries share the same active-row guard.
        assert_eq!(
            page_asset(&state, &id, 0, 320, false, false),
            Err(DataError::NotFound)
        );
        assert_eq!(tile_asset(&state, &id, 0, 0, 320), Err(DataError::NotFound));
        assert_eq!(pages_manifest(&state, &id), Err(DataError::NotFound));
        assert_eq!(layout_read_only(&state, &id), Err(DataError::NotFound));

        // A removed book must not have materialised any render cache entry.
        assert!(state
            .render
            .get(&id, 0, WEB_THUMB_EDGE, WEB_THUMB_EDGE)
            .is_none());
        assert!(state.render.get(&id, 0, 320, 0).is_none());
        assert!(state.render.get_tile(&id, 0, 0, 320).is_none());
    }

    #[test]
    fn anime_source_is_rejected_without_path_leak() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("anime");
        let page = tree.0.join("page.png");
        std::fs::write(&page, png_bytes(10, 10)).expect("page fixture");
        let path = page.to_string_lossy().to_string();
        let id = id_for('n');
        insert_book(
            &state,
            &id,
            "Anime",
            "2026-11-03 10:00:00",
            &path,
            0,
            "anime",
            "image",
            "{}",
            1,
        );

        let errors = [
            pages_manifest(&state, &id).expect_err("manifest"),
            page_asset(&state, &id, 0, 320, false, false).expect_err("page"),
            thumb_asset(&state, &id).expect_err("thumb"),
            layout_read_only(&state, &id).expect_err("layout"),
            cached_page_asset(&state, &id, 0, 320).expect_err("cached page"),
            cached_tile_asset(&state, &id, 0, 0, 320).expect_err("cached tile"),
        ];
        for error in errors {
            assert_eq!(error, DataError::SourceUnsupported);
            assert_no_path_in_debug(&error, &path);
        }
    }

    #[test]
    fn missing_local_source_is_typed_for_all_read_entries() {
        let state = Arc::new(state_with_db());
        let tree = TempTree::new("missing-source");
        let missing = tree.0.join("never-created.png");
        assert!(!missing.exists(), "fixture path must not exist");
        let path = missing.to_string_lossy().to_string();
        let id = id_for('m');
        insert_book(
            &state,
            &id,
            "Missing",
            "2026-11-03 10:00:00",
            &path,
            0,
            "local",
            "image",
            "{}",
            1,
        );

        let errors = [
            pages_manifest(&state, &id).expect_err("manifest"),
            page_asset(&state, &id, 0, 320, false, false).expect_err("page"),
            thumb_asset(&state, &id).expect_err("thumb"),
            layout_read_only(&state, &id).expect_err("layout"),
            cached_page_asset(&state, &id, 0, 320).expect_err("cached page"),
            cached_tile_asset(&state, &id, 0, 0, 320).expect_err("cached tile"),
        ];
        for error in errors {
            assert_eq!(error, DataError::SourceMissing);
            assert_no_path_in_debug(&error, &path);
        }
    }

    #[test]
    fn unsafe_local_path_is_rejected_by_the_existing_policy() {
        // Verified against `commands::is_safe_library_source_path`: the first
        // check is `!path.is_absolute()`, so any relative path is rejected
        // before canonicalisation and source opening.
        let state = state_with_db();
        let relative = id_for('w');
        insert_book(
            &state,
            &relative,
            "Relative",
            "2026-11-03 10:00:00",
            "relative/library.zip",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        let error = pages_manifest(&state, &relative).expect_err("relative path rejected");
        assert_eq!(error, DataError::SourceMissing);
        assert_no_path_in_debug(&error, "relative/library.zip");
        assert_eq!(
            layout_read_only(&state, &relative),
            Err(DataError::SourceMissing)
        );

        // Traversal input is rejected as well (`canonical_existing` requires a
        // real, resolvable target before the protected-directory checks run).
        let traversal = id_for('v');
        insert_book(
            &state,
            &traversal,
            "Traversal",
            "2026-11-03 10:00:00",
            "C:/library/../secret.zip",
            0,
            "local",
            "image",
            "{}",
            1,
        );
        let error = pages_manifest(&state, &traversal).expect_err("traversal rejected");
        assert_eq!(error, DataError::SourceMissing);
        assert_no_path_in_debug(&error, "C:/library/../secret.zip");
    }
}
