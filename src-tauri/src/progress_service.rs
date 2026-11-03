//! D3 write service: validate a Web progress write and run the CAS primitive.
//!
//! The HTTP layer owns route/body parsing and response mapping; this module
//! owns the database-facing rules:
//!
//! - only an active (`removed=0`) book may be written;
//! - PDF books are not writable through the Web API (D3 decision Q1);
//! - `page` must be explicitly within `0..page_count` — the desktop
//!   `clamp_reading_page` fallback is deliberately **not** used, because it
//!   silently rewrites an out-of-range page and can inflate `reading_log`;
//! - `scrollPct` is either omitted (`None` → -1 sentinel) or a finite value in
//!   `0.0..=1.0`; `-1` is not a valid way to say "no webtoon record";
//! - `baseRev` is non-negative;
//! - the active check and the CAS run inside one `db.with` closure, so the
//!   single-connection mutex makes them atomic relative to every other DB
//!   operation in the process.
//!
//! DB failures are surfaced as `DataError::Busy` (503, retryable) and never
//! include a path, SQL text, or book title.

use crate::db::{self, ProgressOutcome};
use crate::read_service::DataError;
use crate::state::AppState;

pub(crate) fn write_progress(
    state: &AppState,
    id: &str,
    page: u32,
    scroll_pct: Option<f64>,
    base_rev: i64,
) -> Result<ProgressOutcome, DataError> {
    // Cheap client-side validation before touching the single DB connection.
    if base_rev < 0 {
        return Err(DataError::InvalidParameter);
    }
    if let Some(pct) = scroll_pct {
        if !pct.is_finite() || !(0.0..=1.0).contains(&pct) {
            return Err(DataError::InvalidParameter);
        }
    }

    // The active check and the CAS share one `db.with` closure. `DbSlot` holds
    // a single connection behind a mutex, so no other DB operation can run
    // between the existence/page checks and the conditional update.
    let result: Result<Result<ProgressOutcome, DataError>, String> = state.db.with(|conn| {
        let row = db::get_active_book(conn, id).map_err(|error| error.to_string())?;
        let Some(row) = row else {
            return Ok(Err(DataError::NotFound));
        };
        // Q1: PDF is an independent source format and is not writable through
        // the Web API, even after PDF.js has filled in `page_count`.
        if row.format == db::BOOK_FORMAT_PDF {
            return Ok(Err(DataError::PdfUnsupported));
        }
        // Q2: an unknown page count has no valid page. Never fall back to the
        // desktop clamp: it would silently rewrite the page and inflate history.
        if row.page_count == 0 || page >= row.page_count {
            return Ok(Err(DataError::InvalidParameter));
        }
        db::set_progress_cas(conn, id, page, scroll_pct, base_rev)
            .map(Ok)
            .map_err(|error| error.to_string())
    });

    match result {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(error)) => Err(error),
        // DB unavailable, busy, or a constraint failure: retryable 503 with no
        // internal detail. The caller may retry with the same base rev; if the
        // first attempt actually committed, the retry becomes a 409 instead of
        // double-counting history.
        Err(_) => Err(DataError::Busy),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rusqlite::Connection;

    use super::*;
    use crate::db::{self, ProgressOutcome};

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn state_with(seed: impl FnOnce(&Connection)) -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        seed(&conn);
        state.db.set(conn);
        state
    }

    fn seed_image(conn: &Connection, page_count: u32) {
        db::upsert_book(conn, ID, "C:/library/book.zip", "书", page_count).expect("seed");
    }

    fn row(state: &AppState) -> db::BookRow {
        state
            .db
            .with(|conn| db::get_book(conn, ID).map_err(|error| error.to_string()))
            .expect("db")
            .expect("book")
    }

    fn log_total(state: &AppState) -> i64 {
        state
            .db
            .with(|conn| {
                conn.query_row(
                    "SELECT COALESCE(SUM(pages),0) FROM reading_log WHERE book_id=?1",
                    rusqlite::params![ID],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
            })
            .expect("db")
    }

    /// The happy path: active image book, explicit pct, forward page.
    #[test]
    fn writes_active_image_book_and_records_forward_pages() {
        let state = state_with(|conn| seed_image(conn, 10));
        let opened_before = row(&state).last_opened_at;

        let outcome = write_progress(&state, ID, 3, Some(0.25), 0).expect("write");
        let ProgressOutcome::Applied {
            rev,
            page,
            updated_at,
        } = outcome
        else {
            panic!("expected applied, got {outcome:?}");
        };
        assert_eq!(rev, 1);
        assert_eq!(page, 3);

        let after = row(&state);
        assert_eq!(after.current_page, 3);
        assert_eq!(after.scroll_pct, 0.25);
        assert_eq!(after.progress_rev, 1);
        assert_eq!(after.updated_at, updated_at);
        assert_eq!(after.last_opened_at, opened_before, "写入不得触碰打开时间");
        assert_eq!(log_total(&state), 3);
    }

    /// Omitted pct means "no webtoon record" and stores the -1 sentinel.
    #[test]
    fn omitted_scroll_pct_writes_the_sentinel() {
        let state = state_with(|conn| seed_image(conn, 10));
        write_progress(&state, ID, 2, None, 0).expect("write");
        assert_eq!(row(&state).scroll_pct, -1.0);
    }

    /// Soft-removed books are indistinguishable from missing books.
    #[test]
    fn rejects_removed_book_without_writing() {
        let state = state_with(|conn| {
            seed_image(conn, 10);
            db::soft_remove_books(conn, &[ID.to_string()]).expect("remove");
        });
        let before = row(&state);

        assert_eq!(
            write_progress(&state, ID, 3, None, 0).unwrap_err(),
            DataError::NotFound
        );
        let after = row(&state);
        assert_eq!(after.current_page, before.current_page);
        assert_eq!(after.progress_rev, before.progress_rev);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(log_total(&state), 0);
    }

    #[test]
    fn rejects_missing_book() {
        let state = state_with(|_| {});
        assert_eq!(
            write_progress(&state, ID, 0, None, 0).unwrap_err(),
            DataError::NotFound
        );
    }

    /// Q1: PDF is not writable through the Web API, even with a known page count.
    #[test]
    fn rejects_pdf_book_even_with_known_pages() {
        let state = state_with(|conn| {
            db::upsert_book_with_format(
                conn,
                ID,
                "C:/library/book.pdf",
                "PDF",
                5,
                db::BOOK_FORMAT_PDF,
            )
            .expect("seed");
        });
        let before = row(&state);

        assert_eq!(
            write_progress(&state, ID, 1, None, 0).unwrap_err(),
            DataError::PdfUnsupported
        );
        assert_eq!(row(&state).current_page, before.current_page);
        assert_eq!(row(&state).progress_rev, before.progress_rev);
        assert_eq!(log_total(&state), 0);
    }

    /// PDF takes precedence over the zero-page rule, so a freshly imported PDF
    /// still reports `pdf-source-unsupported`, not `invalid-parameter`.
    #[test]
    fn rejects_zero_page_pdf_as_pdf() {
        let state = state_with(|conn| {
            db::upsert_book_with_format(
                conn,
                ID,
                "C:/library/book.pdf",
                "PDF",
                0,
                db::BOOK_FORMAT_PDF,
            )
            .expect("seed");
        });
        assert_eq!(
            write_progress(&state, ID, 0, None, 0).unwrap_err(),
            DataError::PdfUnsupported
        );
    }

    /// Q2: an image book with an unknown page count has no valid page.
    #[test]
    fn rejects_zero_page_count_image_book() {
        let state = state_with(|conn| seed_image(conn, 0));
        assert_eq!(
            write_progress(&state, ID, 0, None, 0).unwrap_err(),
            DataError::InvalidParameter
        );
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(log_total(&state), 0);
    }

    /// The page bound is explicit: no silent clamp, no inflated history.
    #[test]
    fn rejects_page_at_or_above_page_count() {
        let state = state_with(|conn| seed_image(conn, 10));
        for page in [10, u32::MAX] {
            assert_eq!(
                write_progress(&state, ID, page, None, 0).unwrap_err(),
                DataError::InvalidParameter,
                "page={page}"
            );
        }
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);

        // The last valid page still works with the same base rev.
        let outcome = write_progress(&state, ID, 9, None, 0).expect("last page");
        assert!(matches!(outcome, ProgressOutcome::Applied { page: 9, .. }));
    }

    #[test]
    fn rejects_negative_base_rev() {
        let state = state_with(|conn| seed_image(conn, 10));
        assert_eq!(
            write_progress(&state, ID, 1, None, -1).unwrap_err(),
            DataError::InvalidParameter
        );
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);
    }

    /// Q9: `-1` is not an accepted way to say "no webtoon record".
    #[test]
    fn rejects_out_of_range_or_non_finite_scroll_pct() {
        let state = state_with(|conn| seed_image(conn, 10));
        for pct in [-1.0, 1.000_001, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                write_progress(&state, ID, 1, Some(pct), 0).unwrap_err(),
                DataError::InvalidParameter,
                "pct={pct}"
            );
        }
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);
    }

    /// A stale base rev is a 409 outcome, not a transport error, and changes nothing.
    #[test]
    fn stale_base_rev_returns_conflict_without_writing() {
        let state = state_with(|conn| {
            seed_image(conn, 10);
            db::set_progress(conn, ID, 2, None).expect("seed progress");
        });
        let before = row(&state);
        let log_before = log_total(&state);

        let outcome = write_progress(&state, ID, 5, None, 0).expect("conflict is an outcome");
        let ProgressOutcome::Conflict {
            current_page,
            current_rev,
            updated_at,
        } = outcome
        else {
            panic!("expected conflict, got {outcome:?}");
        };
        assert_eq!(current_page, 2);
        assert_eq!(current_rev, before.progress_rev);
        assert!(!updated_at.is_empty());

        let after = row(&state);
        assert_eq!(after.current_page, before.current_page);
        assert_eq!(after.progress_rev, before.progress_rev);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(log_total(&state), log_before);
    }

    /// An unavailable DB must be retryable (503), not a 500 or a panic.
    #[test]
    fn unavailable_db_maps_to_busy() {
        let state = Arc::new(AppState::new());
        assert_eq!(
            write_progress(&state, ID, 0, None, 0).unwrap_err(),
            DataError::Busy
        );
    }
}
