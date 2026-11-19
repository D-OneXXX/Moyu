//! Production [`WebPdfAccess`] adapter over `AppState`.
//!
//! This is the only place the Web PDF plane touches the filesystem. Every
//! request re-validates the active book row, the `format='pdf'`/local-source
//! policy, the safe library path boundary and the PDF header. Reads are
//! seek-based and capped at 4 MiB; the whole document is never buffered.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use crate::commands::is_safe_library_source_path;
use crate::db::{self, BOOK_FORMAT_PDF};
use crate::pdf;
use crate::read_service::DataError;
use crate::state::AppState;

use super::pdf_http::{PdfMeta, PdfSource, WebPdfAccess};

pub(crate) struct AppPdf {
    state: Arc<AppState>,
}

impl AppPdf {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn resolve(&self, id: &str) -> Result<(PathBuf, PdfMeta), DataError> {
        let row = self
            .state
            .db
            .with(|conn| db::get_active_book(conn, id).map_err(|error| error.to_string()))
            .map_err(|_| DataError::DbUnavailable)?
            .ok_or(DataError::NotFound)?;
        if row.format != BOOK_FORMAT_PDF {
            return Err(DataError::PdfUnsupported);
        }
        if row.source_type != "local" {
            return Err(DataError::SourceUnsupported);
        }
        let path = PathBuf::from(&row.path);
        if !path.is_file() {
            return Err(DataError::SourceMissing);
        }
        if !is_safe_library_source_path(&path) {
            return Err(DataError::SourceMissing);
        }
        let total = pdf::validate_pdf_source(&path).map_err(|_| DataError::PdfUnsupported)?;
        let modified = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let etag = format!("\"pdf-{total:x}-{modified:x}\"");
        Ok((path, PdfMeta { total, etag }))
    }
}

impl WebPdfAccess for AppPdf {
    fn open(&self, id: &str) -> Result<PdfSource, DataError> {
        let (path, meta) = self.resolve(id)?;
        Ok(PdfSource::new(meta, path))
    }

    fn read(&self, source: &PdfSource, start: u64, length: u32) -> Result<Vec<u8>, DataError> {
        if length == 0 || length > pdf::MAX_PDF_CHUNK_BYTES {
            return Err(DataError::InvalidParameter);
        }
        let (total, bytes) = pdf::read_pdf_chunk(source.path(), start, length)
            .map_err(|_| DataError::SourceMissing)?;
        // The file changed between open and read: answer 500 instead of a
        // truncated body with a stale ETag. The reader retries with a new HEAD.
        if total != source.meta.total || bytes.len() != length as usize {
            return Err(DataError::Internal);
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::*;

    const BOOK_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn temp_tree(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("moyu-web-pdf-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn state_with(path: &std::path::Path, format: &str, source_type: &str) -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        let stored = path.to_string_lossy().into_owned();
        conn.execute(
            "INSERT INTO books(id,path,title,page_count,updated_at,last_opened_at,\
             removed,source_type,meta_json,format) \
             VALUES(?1,?2,?3,0,'','',0,?4,'{}',?5)",
            rusqlite::params![BOOK_ID, stored, "PDF", source_type, format],
        )
        .expect("insert");
        state.db.set(conn);
        state
    }

    #[test]
    fn opens_and_reads_only_the_requested_slice() {
        let tree = temp_tree("slice");
        let path = tree.join("book.pdf");
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend((0..32u8).collect::<Vec<_>>());
        std::fs::write(&path, &bytes).expect("pdf fixture");
        let state = state_with(&path, BOOK_FORMAT_PDF, "local");
        let pdf = AppPdf::new(state);

        let source = pdf.open(BOOK_ID).expect("open");
        assert_eq!(source.meta.total, bytes.len() as u64);
        assert!(source.meta.etag.starts_with("\"pdf-"));
        assert!(!format!("{source:?}").contains("book.pdf"));

        let slice = pdf.read(&source, 5, 6).expect("slice");
        assert_eq!(slice, &bytes[5..11]);
        // Offset must be honoured instead of returning the file prefix.
        let tail = pdf.read(&source, 0, 5).expect("head");
        assert_eq!(tail, b"%PDF-");

        assert_eq!(pdf.read(&source, 0, 0), Err(DataError::InvalidParameter));
        assert_eq!(
            pdf.read(&source, 0, pdf::MAX_PDF_CHUNK_BYTES + 1),
            Err(DataError::InvalidParameter)
        );
        std::fs::remove_dir_all(tree).ok();
    }

    #[test]
    fn rejects_non_pdf_remote_missing_and_unsafe_sources() {
        let tree = temp_tree("policy");
        let pdf_path = tree.join("book.pdf");
        std::fs::write(&pdf_path, b"%PDF-1.7\nbody").expect("pdf fixture");
        let image_path = tree.join("book.cbz");
        std::fs::write(&image_path, b"PK\x03\x04").expect("zip fixture");

        let pdf = AppPdf::new(state_with(&pdf_path, BOOK_FORMAT_PDF, "local"));
        let image = AppPdf::new(state_with(&image_path, "image", "local"));
        let remote = AppPdf::new(state_with(&pdf_path, BOOK_FORMAT_PDF, "generic_manga"));
        let missing_path = tree.join("gone.pdf");
        let missing = AppPdf::new(state_with(&missing_path, BOOK_FORMAT_PDF, "local"));

        assert_eq!(image.open(BOOK_ID).unwrap_err(), DataError::PdfUnsupported);
        assert_eq!(
            remote.open(BOOK_ID).unwrap_err(),
            DataError::SourceUnsupported
        );
        assert_eq!(missing.open(BOOK_ID).unwrap_err(), DataError::SourceMissing);
        assert_eq!(pdf.open(&"b".repeat(64)).unwrap_err(), DataError::NotFound);

        let home = dirs::home_dir().expect("home");
        let unsafe_state = state_with(&home, BOOK_FORMAT_PDF, "local");
        assert_eq!(
            AppPdf::new(unsafe_state).open(BOOK_ID).unwrap_err(),
            DataError::SourceMissing
        );
        std::fs::remove_dir_all(tree).ok();
    }
}
