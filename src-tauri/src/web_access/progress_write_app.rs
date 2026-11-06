//! D3 production adapter from `AppState` to the write-plane trait.

use std::sync::Arc;

use crate::db::ProgressOutcome;
use crate::progress_service;
use crate::read_service::DataError;
use crate::state::AppState;

use super::progress_write::WebProgressWrite;

pub(crate) struct AppProgress {
    state: Arc<AppState>,
}

impl AppProgress {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

impl WebProgressWrite for AppProgress {
    fn write_progress(
        &self,
        id: &str,
        page: u32,
        scroll_pct: Option<f64>,
        base_rev: i64,
    ) -> Result<ProgressOutcome, DataError> {
        progress_service::write_progress(self.state.as_ref(), id, page, scroll_pct, base_rev)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rusqlite::Connection;

    use super::super::progress_write::WebProgressWrite;
    use super::AppProgress;
    use crate::db;
    use crate::state::AppState;

    const ID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn forwards_cas_writes_to_the_shared_state() {
        let state = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        db::upsert_book(&conn, ID, "C:/library/other.zip", "书", 5).expect("seed");
        state.db.set(conn);

        let write: Arc<dyn WebProgressWrite> = Arc::new(AppProgress::new(Arc::clone(&state)));
        let outcome = write.write_progress(ID, 2, Some(0.5), 0).expect("write");
        assert!(matches!(
            outcome,
            crate::db::ProgressOutcome::Applied {
                rev: 1,
                page: 2,
                ..
            }
        ));

        let row = state
            .db
            .with(|conn| {
                conn.query_row(
                    "SELECT current_page, scroll_pct, progress_rev FROM books WHERE id=?1",
                    rusqlite::params![ID],
                    |row| {
                        Ok((
                            row.get::<_, u32>(0)?,
                            row.get::<_, f64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .map_err(|error| error.to_string())
            })
            .expect("db");
        assert_eq!(row, (2, 0.5, 1));
    }
}
