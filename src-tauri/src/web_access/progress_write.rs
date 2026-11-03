//! D3 progress-write provider boundary.
//!
//! The read plane has [`super::data::WebDataAccess`]; the write plane gets a
//! deliberately separate trait so a read-only adapter can never accidentally
//! gain a write method. The HTTP handler is added in the next task; this
//! module owns only the provider contract.

use crate::db::ProgressOutcome;
use crate::read_service::DataError;

/// Synchronous provider boundary. Implementations are called from
/// `spawn_blocking` by the HTTP layer and must not depend on a runtime handle.
pub(crate) trait WebProgressWrite: Send + Sync {
    /// Validate and apply one CAS progress write. `Ok(Conflict)` is a normal
    /// outcome, not an error; transport/validation failures use `Err`.
    fn write_progress(
        &self,
        id: &str,
        page: u32,
        scroll_pct: Option<f64>,
        base_rev: i64,
    ) -> Result<ProgressOutcome, DataError>;
}
