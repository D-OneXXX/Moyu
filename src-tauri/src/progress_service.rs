//! D3 write service: validate a Web progress write and run the CAS primitive.
//!
//! The HTTP layer owns route/body parsing and response mapping; this module
//! owns the database-facing rules:
//!
//! - only an active (`removed=0`) book may be written;
//! - image books follow the D3 page rules; PDF books are writable from D4 and
//!   may backfill `page_count` exactly once when the stored count is still 0;
//! - `page` must be explicitly within `0..page_count` — the desktop
//!   `clamp_reading_page` fallback is deliberately **not** used, because it
//!   silently rewrites an out-of-range page and can inflate `reading_log`;
//! - `scrollPct` is either omitted (`None` → -1 sentinel) or a finite value in
//!   `0.0..=1.0`; `-1` is not a valid way to say "no webtoon record";
//! - `baseRev` is non-negative;
//! - `detectedPageCount` is only meaningful for PDF books whose stored count
//!   is 0; any other format rejects it;
//! - active state, format, and page bounds are checked under the same
//!   `BEGIN IMMEDIATE` transaction as the CAS, including against other connections.
//!
//! DB failures are surfaced as `DataError::Busy` (503, retryable) and never
//! include a path, SQL text, or book title.

use crate::db::{self, ProgressOutcome};
use crate::pdf;
use crate::read_service::DataError;
use crate::state::AppState;

pub(crate) fn write_progress(
    state: &AppState,
    id: &str,
    page: u32,
    scroll_pct: Option<f64>,
    base_rev: i64,
) -> Result<ProgressOutcome, DataError> {
    write_progress_with_detected(state, id, page, scroll_pct, base_rev, None)
}

/// D4 entry point. `detected_page_count` is the PDF.js page count for a PDF
/// whose `books.page_count` is still 0; it is validated and written inside the
/// same `BEGIN IMMEDIATE` transaction as the CAS, so a concurrent desktop
/// rescan or another device can never have its count overwritten.
pub(crate) fn write_progress_with_detected(
    state: &AppState,
    id: &str,
    page: u32,
    scroll_pct: Option<f64>,
    base_rev: i64,
    detected_page_count: Option<u32>,
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
    if detected_page_count.is_some_and(|count| count == 0 || count > pdf::MAX_PDF_PAGE_COUNT) {
        return Err(DataError::InvalidParameter);
    }

    // The independent scan connection is serialized by SQLite's write lock,
    // not by DbSlot's process-local connection mutex.
    let result: Result<Result<ProgressOutcome, DataError>, String> = state.db.with(|conn| {
        db::set_progress_cas_checked(conn, id, page, scroll_pct, base_rev, |conn| {
            let Some(row) = db::get_active_book(conn, id)? else {
                return Ok(Some(DataError::NotFound));
            };
            if row.format == db::BOOK_FORMAT_PDF {
                let page_count = if row.page_count == 0 {
                    let Some(detected) = detected_page_count else {
                        // The Web reader has the real count; without it there
                        // is no valid page to persist.
                        return Ok(Some(DataError::InvalidParameter));
                    };
                    if pdf::validate_pdf_page_count(&row.format, detected).is_err() {
                        return Ok(Some(DataError::InvalidParameter));
                    }
                    if page >= detected {
                        return Ok(Some(DataError::InvalidParameter));
                    }
                    db::set_book_page_count_if_zero(conn, id, detected)?;
                    detected
                } else {
                    // The stored count is authoritative once set; a later
                    // detection is ignored rather than overwriting desktop data.
                    row.page_count
                };
                if page >= page_count {
                    return Ok(Some(DataError::InvalidParameter));
                }
                return Ok(None);
            }
            // D4 keeps `detectedPageCount` PDF-only. An image book can never
            // grow its page count through the progress endpoint.
            if detected_page_count.is_some() {
                return Ok(Some(DataError::InvalidParameter));
            }
            if row.page_count == 0 || page >= row.page_count {
                return Ok(Some(DataError::InvalidParameter));
            }
            Ok(None)
        })
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

    fn seed_pdf(conn: &Connection, page_count: u32) {
        db::upsert_book_with_format(
            conn,
            ID,
            "C:/library/book.pdf",
            "PDF",
            page_count,
            db::BOOK_FORMAT_PDF,
        )
        .expect("seed");
    }

    /// D4: a PDF with a known page count writes progress like any other book.
    #[test]
    fn writes_pdf_progress_with_known_page_count() {
        let state = state_with(|conn| seed_pdf(conn, 5));
        let outcome = write_progress(&state, ID, 2, None, 0).expect("pdf write");
        assert!(matches!(
            outcome,
            ProgressOutcome::Applied {
                rev: 1,
                page: 2,
                ..
            }
        ));
        let after = row(&state);
        assert_eq!((after.page_count, after.current_page), (5, 2));
        assert_eq!(log_total(&state), 2);

        // A detected count on an already-populated PDF is ignored, not an error.
        write_progress_with_detected(&state, ID, 3, None, 1, Some(9)).expect("ignored detection");
        let after = row(&state);
        assert_eq!((after.page_count, after.current_page), (5, 3));
    }

    /// A freshly imported PDF stores 0 pages. The first Web write must carry
    /// the PDF.js count; the write happens once and later detections never
    /// overwrite it.
    #[test]
    fn pdf_zero_page_count_adopts_detected_count_once() {
        let state = state_with(|conn| seed_pdf(conn, 0));
        assert_eq!(
            write_progress(&state, ID, 0, None, 0).unwrap_err(),
            DataError::InvalidParameter,
            "without a detected count there is no valid page"
        );
        assert_eq!(row(&state).page_count, 0);

        for (detected, page) in [(0, 0), (pdf::MAX_PDF_PAGE_COUNT + 1, 0), (5, 5)] {
            assert_eq!(
                write_progress_with_detected(&state, ID, page, None, 0, Some(detected))
                    .unwrap_err(),
                DataError::InvalidParameter,
                "detected={detected} page={page}"
            );
            assert_eq!(
                row(&state).page_count,
                0,
                "invalid detection must not write"
            );
        }

        let outcome =
            write_progress_with_detected(&state, ID, 2, None, 0, Some(5)).expect("first write");
        assert!(matches!(
            outcome,
            ProgressOutcome::Applied {
                rev: 1,
                page: 2,
                ..
            }
        ));
        let after = row(&state);
        assert_eq!((after.page_count, after.current_page), (5, 2));
        assert_eq!(log_total(&state), 2);

        write_progress_with_detected(&state, ID, 3, None, 1, Some(9)).expect("second write");
        let after = row(&state);
        assert_eq!((after.page_count, after.current_page), (5, 3));
        assert_eq!(log_total(&state), 3);
    }

    /// Detection is a PDF-only compatibility path; image books cannot grow
    /// their page count through a progress write.
    #[test]
    fn image_book_rejects_detected_page_count() {
        let state = state_with(|conn| seed_image(conn, 10));
        assert_eq!(
            write_progress_with_detected(&state, ID, 2, None, 0, Some(20)).unwrap_err(),
            DataError::InvalidParameter
        );
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);
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

    #[test]
    fn concurrent_rescan_revalidates_under_database_write_lock() {
        use std::sync::mpsc;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mr-progress-race-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        let scan_conn = db::open(&path).unwrap();
        db::init_schema(&scan_conn).unwrap();
        seed_image(&scan_conn, 10);
        let state = Arc::new(AppState::new());
        state.db.set(db::open(&path).unwrap());
        scan_conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        db::upsert_book(&scan_conn, ID, "C:/library/book.zip", "书", 2).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx
                .send(write_progress(&worker_state, ID, 8, None, 0))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        scan_conn.execute_batch("COMMIT").unwrap();
        assert_eq!(
            done_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err(),
            DataError::InvalidParameter
        );
        worker.join().unwrap();
        let after = row(&state);
        assert_eq!(
            (after.page_count, after.current_page, after.progress_rev),
            (2, 0, 0)
        );
        assert_eq!(log_total(&state), 0);
        drop(state);
        drop(scan_conn);
        std::fs::remove_dir_all(&dir).unwrap();
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
