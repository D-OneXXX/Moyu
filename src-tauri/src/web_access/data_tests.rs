//! AppData-backed read-only integrity suite for the D2 data plane.
//!
//! Every test builds an isolated `AppState`: an in-memory SQLite database plus
//! a render cache rooted inside a local temp tree, so no image render can ever
//! touch the real user cache. Requests go through the production
//! [`PairingHttp`] gate exactly like a phone would (session cookie, exact Host,
//! no Origin on GET). The only accepted evidence for the read-only contract is
//! a snapshot of the `books` progress columns plus the `reading_log` row count,
//! taken before and after each request: any write at all fails the test.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::header::{HeaderValue, CACHE_CONTROL, ETAG, IF_NONE_MATCH, VARY};
use hyper::{Method, Request, StatusCode};
use rusqlite::{params, Connection};
use serde_json::Value;

use super::auth::PairingService;
use super::clock::{Clock, SystemClock};
use super::data_app::AppData;
use super::pairing::PairingStore;
use super::router::PairingHttp;
use super::session::SessionStore;
use crate::db;
use crate::render_cache::RenderCache;
use crate::state::AppState;

const HOST: &str = "192.168.1.10:8443";
const SOURCE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 20);
const CREATED_AT: &str = "2026-11-03 10:00:00";
const OPENED_AT: &str = "2026-11-03 10:05:00";

fn id_for(seed: char) -> String {
    seed.to_string().repeat(64)
}

static NEXT_TREE: AtomicU64 = AtomicU64::new(0);

/// Isolated fixture directory; always removed on drop (including on panic,
/// because unwinding runs destructors).
struct TempTree(PathBuf);

impl TempTree {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let seq = NEXT_TREE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "moyu-d2-appdata-{tag}-{}-{nanos}-{seq}",
            std::process::id()
        ));
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

/// The exact state a data request may never change. Paths are intentionally
/// absent so a failing assertion never prints the temp tree.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    current_page: u32,
    progress_rev: i64,
    updated_at: String,
    last_opened_at: String,
    meta_json: String,
    reading_log_rows: i64,
    reading_log_pages: i64,
}

fn snapshot(state: &AppState, book_id: &str) -> Result<Snapshot, String> {
    state.db.with(|conn| {
        let mut row = conn
            .query_row(
                "SELECT current_page, progress_rev, updated_at, last_opened_at, meta_json \
                 FROM books WHERE id=?1",
                params![book_id],
                |row| {
                    Ok(Snapshot {
                        current_page: row.get(0)?,
                        progress_rev: row.get(1)?,
                        updated_at: row.get(2)?,
                        last_opened_at: row.get(3)?,
                        meta_json: row.get(4)?,
                        reading_log_rows: 0,
                        reading_log_pages: 0,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        let (rows, pages) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(pages), 0) FROM reading_log",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        row.reading_log_rows = rows;
        row.reading_log_pages = pages;
        Ok(row)
    })
}

#[allow(clippy::too_many_arguments)]
fn insert_book(
    state: &AppState,
    id: &str,
    path: &str,
    title: &str,
    page_count: u32,
    current_page: u32,
    removed: i64,
    source_type: &str,
    meta_json: &str,
    format: &str,
) {
    state
        .db
        .with(|conn| {
            conn.execute(
                "INSERT INTO books(id,path,title,page_count,current_page,updated_at,\
                 last_opened_at,scroll_pct,source_type,meta_json,format,removed,progress_rev) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    id,
                    path,
                    title,
                    page_count as i64,
                    current_page as i64,
                    CREATED_AT,
                    OPENED_AT,
                    -1.0f64,
                    source_type,
                    meta_json,
                    format,
                    removed,
                    3i64,
                ],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
        .expect("insert book");
}

struct Fixture {
    tree: TempTree,
    state: Arc<AppState>,
    token: String,
    router: PairingHttp,
}

impl Fixture {
    fn new() -> Self {
        let tree = TempTree::new("suite");
        std::fs::write(tree.0.join("page.png"), png_bytes(400, 6000)).expect("page fixture");

        // Isolate the render cache *before* the state becomes shared: a page
        // render must land in this temp tree, never in the real user cache.
        let mut state = AppState::new();
        state.render = RenderCache::new(tree.0.join("render"));

        let conn = Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        state.db.set(conn);

        let dir = tree.0.to_string_lossy().to_string();
        insert_book(
            &state,
            &id_for('a'),
            &dir,
            "Web",
            1,
            2,
            0,
            "local",
            "{}",
            "image",
        );
        state
            .db
            .with(|conn| {
                conn.execute(
                    "INSERT INTO reading_log(date, book_id, pages) VALUES('2026-11-03', ?1, 7)",
                    params![id_for('a')],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .expect("reading log");

        let state = Arc::new(state);
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let service = Arc::new(PairingService::new(
            PairingStore::new(Arc::clone(&clock)),
            SessionStore::new(clock),
        ));
        let issued = service.issue_session_for_test("Pixel 8");
        // Name the trait object explicitly so the unsizing coercion does not
        // depend on inference at the call site.
        let data: Arc<dyn super::data::WebDataAccess> = Arc::new(AppData::new(Arc::clone(&state)));
        let router =
            PairingHttp::with_data(service, SocketAddr::from(([192, 168, 1, 10], 8443)), data)
                .expect("IPv4 test authority");
        Self {
            tree,
            state,
            token: issued.token.as_str().to_owned(),
            router,
        }
    }

    fn get(&self, path: &str) -> Request<Full<Bytes>> {
        Request::builder()
            .method(Method::GET)
            .uri(path)
            .header("host", HOST)
            .header("cookie", format!("moyus_session={}", self.token))
            .body(Full::new(Bytes::new()))
            .expect("test request")
    }

    async fn status(&self, path: &str) -> StatusCode {
        self.router.handle(self.get(path), SOURCE_IP).await.status()
    }

    async fn status_and_body(&self, path: &str) -> (StatusCode, Bytes) {
        let response = self.router.handle(self.get(path), SOURCE_IP).await;
        let status = response.status();
        let body = BodyExt::collect(response.into_body())
            .await
            .expect("response body")
            .to_bytes();
        (status, body)
    }
}

fn error_code(body: &Bytes) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn all_read_routes_leave_book_progress_and_log_unchanged() {
    let fixture = Fixture::new();
    let id = id_for('a');
    let paths = [
        "/api/books".to_owned(),
        format!("/api/books/{id}"),
        format!("/api/books/{id}/thumb"),
        format!("/api/books/{id}/pages"),
        format!("/api/books/{id}/pages/0?w=320"),
        format!("/api/books/{id}/layout"),
        format!("/api/books/{id}/progress"),
        format!("/api/books/{id}/pages/0/tiles/0?w=320"),
    ];

    for path in paths {
        let before = snapshot(fixture.state.as_ref(), &id).expect("snapshot");
        let response = fixture.router.handle(fixture.get(&path), SOURCE_IP).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(
            !response
                .headers()
                .contains_key("access-control-allow-origin"),
            "{path}"
        );
        let after = snapshot(fixture.state.as_ref(), &id).expect("snapshot");
        assert_eq!(before, after, "{path}");
    }
}

#[tokio::test]
async fn conditional_page_304_does_not_write_any_state() {
    let fixture = Fixture::new();
    let id = id_for('a');
    let path = format!("/api/books/{id}/pages/0?w=320");

    let first = fixture.router.handle(fixture.get(&path), SOURCE_IP).await;
    assert_eq!(first.status(), StatusCode::OK);
    let etag = first
        .headers()
        .get(ETAG)
        .expect("etag on rendered page")
        .to_str()
        .expect("ascii etag")
        .to_owned();
    assert!(etag.starts_with("\"p-0-320-"), "{etag}");

    let before = snapshot(fixture.state.as_ref(), &id).expect("snapshot");
    let mut conditional = fixture.get(&path);
    conditional.headers_mut().insert(
        IF_NONE_MATCH,
        HeaderValue::from_str(&etag).expect("etag header"),
    );
    let response = fixture.router.handle(conditional, SOURCE_IP).await;
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        response
            .headers()
            .get(VARY)
            .and_then(|value| value.to_str().ok()),
        Some("Cookie")
    );
    assert_eq!(
        response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("private, no-cache")
    );
    assert!(!response
        .headers()
        .contains_key("access-control-allow-origin"));
    let body = BodyExt::collect(response.into_body())
        .await
        .expect("304 body")
        .to_bytes();
    assert!(body.is_empty(), "304 must not carry a body");

    let after = snapshot(fixture.state.as_ref(), &id).expect("snapshot");
    assert_eq!(before, after);
}

#[tokio::test]
async fn removed_pdf_and_missing_books_are_rejected_without_writes() {
    let fixture = Fixture::new();
    let removed = id_for('b');
    let pdf = id_for('c');
    let missing = id_for('d');

    insert_book(
        fixture.state.as_ref(),
        &removed,
        "C:/library/removed.zip",
        "Removed",
        1,
        0,
        1,
        "local",
        "{}",
        "image",
    );
    insert_book(
        fixture.state.as_ref(),
        &pdf,
        "C:/library/a.pdf",
        "Pdf",
        0,
        0,
        0,
        "local",
        "{}",
        "pdf",
    );
    let missing_path = fixture.tree.0.join("missing-source");
    insert_book(
        fixture.state.as_ref(),
        &missing,
        &missing_path.to_string_lossy(),
        "Missing",
        1,
        0,
        0,
        "local",
        "{}",
        "image",
    );

    // Removed rows are indistinguishable from unknown ones: everything 404s.
    let before = snapshot(fixture.state.as_ref(), &removed).expect("snapshot");
    for path in [
        format!("/api/books/{removed}"),
        format!("/api/books/{removed}/thumb"),
        format!("/api/books/{removed}/pages"),
        format!("/api/books/{removed}/pages/0?w=320"),
        format!("/api/books/{removed}/layout"),
        format!("/api/books/{removed}/progress"),
        format!("/api/books/{removed}/pages/0/tiles/0?w=320"),
    ] {
        assert_eq!(fixture.status(&path).await, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        before,
        snapshot(fixture.state.as_ref(), &removed).expect("snapshot")
    );

    // PDF is an independent source format: page-plane routes refuse it, but
    // the progress view stays readable.
    let before = snapshot(fixture.state.as_ref(), &pdf).expect("snapshot");
    for path in [
        format!("/api/books/{pdf}/pages"),
        format!("/api/books/{pdf}/pages/0?w=320"),
        format!("/api/books/{pdf}/layout"),
        format!("/api/books/{pdf}/pages/0/tiles/0?w=320"),
    ] {
        let (status, body) = fixture.status_and_body(&path).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{path}");
        assert_eq!(error_code(&body), "pdf-source-unsupported", "{path}");
    }
    let (status, body) = fixture
        .status_and_body(&format!("/api/books/{pdf}/progress"))
        .await;
    assert_eq!(status, StatusCode::OK);
    let progress: Value = serde_json::from_slice(&body).expect("progress json");
    assert_eq!(progress.get("pageCount").and_then(Value::as_u64), Some(0));
    // PDF covers are a separate cache path; without a cached cover the thumb
    // route is a cover miss (404), not a page-plane 415.
    let (status, body) = fixture
        .status_and_body(&format!("/api/books/{pdf}/thumb"))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "thumbnail-missing");
    assert_eq!(
        before,
        snapshot(fixture.state.as_ref(), &pdf).expect("snapshot")
    );

    // A local row whose source directory no longer exists is a 409, including
    // the cover route, and still causes no write.
    let before = snapshot(fixture.state.as_ref(), &missing).expect("snapshot");
    for path in [
        format!("/api/books/{missing}/thumb"),
        format!("/api/books/{missing}/pages"),
        format!("/api/books/{missing}/pages/0?w=320"),
        format!("/api/books/{missing}/layout"),
        format!("/api/books/{missing}/pages/0/tiles/0?w=320"),
    ] {
        let (status, body) = fixture.status_and_body(&path).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}");
        assert_eq!(error_code(&body), "source-missing", "{path}");
    }
    assert_eq!(
        before,
        snapshot(fixture.state.as_ref(), &missing).expect("snapshot")
    );
}

#[tokio::test]
async fn online_layout_does_not_rewrite_meta_json() {
    let fixture = Fixture::new();
    let id = id_for('e');
    // Actual `StoredMeta` shape: camelCase, PageRef carries url/width/height.
    // Every dimension is present, so the layout scanner has nothing to probe
    // and must not open a source or reach the network.
    let meta_json = serde_json::json!({
        "schema": 1,
        "manifestHash": "fixture-hash",
        "fetchedAt": "2026-11-03 10:00:00",
        "pages": [{
            "url": "https://example.test/p.jpg",
            "width": 800,
            "height": 600
        }]
    })
    .to_string();
    insert_book(
        fixture.state.as_ref(),
        &id,
        "https://example.test/gallery/1",
        "Online",
        1,
        0,
        0,
        "generic_manga",
        &meta_json,
        "image",
    );

    let before = snapshot(fixture.state.as_ref(), &id).expect("snapshot");
    assert_eq!(before.meta_json, meta_json);

    let (status, body) = fixture
        .status_and_body(&format!("/api/books/{id}/layout"))
        .await;
    assert_eq!(status, StatusCode::OK);
    let layout: Value = serde_json::from_slice(&body).expect("layout json");
    assert_eq!(
        layout.pointer("/pages/0/width").and_then(Value::as_u64),
        Some(800)
    );
    assert_eq!(
        layout.pointer("/pages/0/height").and_then(Value::as_u64),
        Some(600)
    );

    let after = snapshot(fixture.state.as_ref(), &id).expect("snapshot");
    assert_eq!(before, after, "layout read rewrote the online book row");
    assert_eq!(
        after.meta_json, meta_json,
        "meta_json must stay byte-identical"
    );
}
