//! The production [`WebDataAccess`] adapter over the existing read-only
//! `read_service`.
//!
//! This is the only place where the Web data plane touches Tauri application
//! state. It is a pure forwarder: every method delegates to a `read_service`
//! function and none of them write. It never calls `upsert_online_book`, never
//! updates `books` progress columns or `reading_log`, and never enables the
//! L1 cache or neighbour prefetch (`page_asset(..., false, false)`).
//! `cached_page`/`cached_tile` are L2-only probes used by conditional requests;
//! they never render and never write either. The trait
//! stays the single contract; only the call sites below know the concrete
//! `AppState` handle types required by `read_service`.

use std::sync::Arc;

use crate::read_service::{
    self, DataError, ImageAsset, PageManifest, ProgressView, TileImage, WebBookDetail, WebBookPage,
};
use crate::state::AppState;
use crate::PageDim;

use super::data::WebDataAccess;

pub(crate) struct AppData {
    state: Arc<AppState>,
}

impl AppData {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

impl WebDataAccess for AppData {
    fn list_books(
        &self,
        q: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<WebBookPage, DataError> {
        read_service::list_books_page(self.state.as_ref(), q, cursor, limit)
    }
    fn book(&self, id: &str) -> Result<WebBookDetail, DataError> {
        read_service::book_detail(self.state.as_ref(), id)
    }
    fn thumb(&self, id: &str) -> Result<ImageAsset, DataError> {
        read_service::thumb_asset(&self.state, id)
    }
    fn pages(&self, id: &str) -> Result<PageManifest, DataError> {
        read_service::pages_manifest(self.state.as_ref(), id)
    }
    fn page(&self, id: &str, index: u32, width: u32) -> Result<ImageAsset, DataError> {
        read_service::page_asset(&self.state, id, index, width, false, false)
    }
    fn layout(&self, id: &str) -> Result<Vec<PageDim>, DataError> {
        read_service::layout_read_only(self.state.as_ref(), id)
    }
    fn tile(&self, id: &str, index: u32, tile: u32, width: u32) -> Result<TileImage, DataError> {
        read_service::tile_asset(&self.state, id, index, tile, width)
    }
    fn progress(&self, id: &str) -> Result<ProgressView, DataError> {
        read_service::progress(self.state.as_ref(), id)
    }
    /// L2-only probe for conditional page requests. `cached_page_asset` repeats
    /// the active/PDF/source/range guards of `page_asset` but returns the cached
    /// bytes only: no render, no neighbour prefetch, no L1 promotion, no write.
    fn cached_page(
        &self,
        id: &str,
        index: u32,
        width: u32,
    ) -> Result<Option<ImageAsset>, DataError> {
        read_service::cached_page_asset(&self.state, id, index, width)
    }
    /// L2-only probe for conditional tile requests; same read-only contract.
    fn cached_tile(
        &self,
        id: &str,
        index: u32,
        tile: u32,
        width: u32,
    ) -> Result<Option<TileImage>, DataError> {
        read_service::cached_tile_asset(&self.state, id, index, tile, width)
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use super::*;

    const BOOK_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// Seed one local book in an in-memory database. `AppState::new()` builds
    /// empty cache roots but this test never renders an image, so no files are
    /// created and the real user data directory is untouched.
    fn seeded_state() -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("memory db");
        crate::db::init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO books(id,path,title,page_count,current_page,updated_at,last_opened_at,\
             scroll_pct,source_type,meta_json,format,removed,progress_rev) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                BOOK_ID,
                "C:/library/test.zip",
                "Web",
                10i64,
                2i64,
                "2026-11-03 10:00:00",
                "2026-11-03 10:00:00",
                -1.0f64,
                "local",
                "{}",
                "image",
                0i64,
                3i64,
            ],
        )
        .expect("insert book");
        state.db.set(conn);
        state
    }

    /// `(current_page, progress_rev, updated_at)` straight from SQLite.
    fn book_row_snapshot(state: &AppState) -> (u32, i64, String) {
        state
            .db
            .with(|conn| {
                conn.query_row(
                    "SELECT current_page, progress_rev, updated_at FROM books WHERE id=?1",
                    params![BOOK_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|error| error.to_string())
            })
            .expect("snapshot")
    }

    #[test]
    fn app_data_forwards_reads_without_writing() {
        let state = seeded_state();
        let data = AppData::new(Arc::clone(&state));
        let before = book_row_snapshot(state.as_ref());

        let page = data.list_books(None, None, 40).expect("list books");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].title, "Web");
        assert!(page.items[0].thumb_url.is_some());
        let debug = format!("{page:?}");
        assert!(!debug.contains("C:/"), "list payload leaked a path");
        assert!(!debug.contains("test.zip"), "list payload leaked a path");

        let progress = data.progress(BOOK_ID).expect("progress");
        assert_eq!(progress.page, 2);
        assert_eq!(progress.rev, 3);

        let after = book_row_snapshot(state.as_ref());
        assert_eq!(before, after, "read-only provider mutated the books row");
    }
}
