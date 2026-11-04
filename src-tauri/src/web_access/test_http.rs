//! `#[cfg(test)]` compatibility harness for the production pair router.
//!
//! D1b moved the route implementation to `router.rs`. This module keeps the
//! synthetic-request helpers used by the D1a tests and delegates every call to
//! the same production [`PairingHttp`]; there is no second route table.
//!
//! `GET /api/pair/claim/{id}` is a read-only status/long-poll and may report
//! `approved`; the one-time pickup is `POST /api/pair/claim/{id}/consume`.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response};

use super::auth::PairingService;
use super::data::WebDataAccess;
use super::router::{
    PairingHttp, CLAIM_COOKIE, CLAIM_POLL_PREFIX, CLAIM_ROUTE, CONSUME_SUFFIX, HEALTH_PATH,
    MAX_CLAIM_BODY_BYTES, SESSION_COOKIE,
};

const DEFAULT_SOURCE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 20);
const DEFAULT_POLL_WINDOW: Duration = Duration::from_millis(20);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Test-only source IP injected through request extensions. Production source
/// addresses come from the TLS peer; nothing here reads headers or environment.
#[derive(Clone, Copy)]
pub(crate) struct TestSourceIp(pub(crate) Ipv4Addr);

impl TestSourceIp {
    /// Attaches this source IP to a synthetic request.
    pub(crate) fn attach(self, mut request: Request<Full<Bytes>>) -> Request<Full<Bytes>> {
        request.extensions_mut().insert(self);
        request
    }
}

/// Test-only wrapper around the production pair router.
struct TestRouter {
    inner: PairingHttp,
}

impl TestRouter {
    fn new(service: Arc<PairingService>, addr: SocketAddr) -> Self {
        Self::with_polling(service, addr, DEFAULT_POLL_WINDOW, DEFAULT_POLL_INTERVAL)
    }

    fn with_polling(
        service: Arc<PairingService>,
        addr: SocketAddr,
        window: Duration,
        interval: Duration,
    ) -> Self {
        let mut inner = PairingHttp::for_test(service, addr);
        inner.set_polling(window, interval);
        Self { inner }
    }

    fn with_data(
        service: Arc<PairingService>,
        addr: SocketAddr,
        data: Arc<dyn WebDataAccess>,
    ) -> Self {
        Self {
            inner: PairingHttp::with_data(service, addr, data).expect("IPv4 test authority"),
        }
    }

    async fn handle(&self, request: Request<Full<Bytes>>) -> Response<Full<Bytes>> {
        let source_ip = request
            .extensions()
            .get::<TestSourceIp>()
            .map_or(DEFAULT_SOURCE_IP, |extension| extension.0);
        self.inner.handle(request, source_ip).await
    }

    async fn consume(
        &self,
        request: Request<Full<Bytes>>,
        claim_id: &str,
    ) -> Response<Full<Bytes>> {
        self.inner.consume(request, claim_id).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::header::{HeaderMap, HeaderValue, COOKIE, IF_NONE_MATCH, RANGE, SET_COOKIE};
    use hyper::{Method, Request, Response, StatusCode};
    use serde_json::{json, Value};

    use super::*;
    use crate::read_service::{
        DataError, ImageAsset, PageIndex, PageManifest, ProgressView, TileImage, WebBook,
        WebBookDetail, WebBookPage,
    };
    use crate::web_access::clock::test_support::FakeClock;
    use crate::web_access::pairing::{PairingStore, PairingWindow, PICKUP_TIMEOUT};
    use crate::web_access::session::SessionStore;
    use crate::PageDim;

    const HOST: &str = "192.168.1.10:8443";
    const ORIGIN: &str = "https://192.168.1.10:8443";

    struct Fixture {
        router: TestRouter,
        service: Arc<PairingService>,
        window: PairingWindow,
        clock: Arc<FakeClock>,
    }

    impl Fixture {
        fn new() -> Self {
            let clock = FakeClock::shared();
            let pairing = PairingStore::new(clock.clone());
            let session = SessionStore::new(clock.clone());
            let service = Arc::new(PairingService::new(pairing, session));
            let window = service.start_window();
            let router = TestRouter::new(
                Arc::clone(&service),
                SocketAddr::from(([192, 168, 1, 10], 8443)),
            );
            Self {
                router,
                service,
                window,
                clock,
            }
        }

        fn with_polling(poll_window: Duration, interval: Duration) -> Self {
            let clock = FakeClock::shared();
            let pairing = PairingStore::new(clock.clone());
            let session = SessionStore::new(clock.clone());
            let service = Arc::new(PairingService::new(pairing, session));
            let window = service.start_window();
            let router = TestRouter::with_polling(
                Arc::clone(&service),
                SocketAddr::from(([192, 168, 1, 10], 8443)),
                poll_window,
                interval,
            );
            Self {
                router,
                service,
                window,
                clock,
            }
        }

        fn with_data(data: Arc<dyn WebDataAccess>) -> Self {
            let clock = FakeClock::shared();
            let pairing = PairingStore::new(clock.clone());
            let session = SessionStore::new(clock.clone());
            let service = Arc::new(PairingService::new(pairing, session));
            let window = service.start_window();
            let router = TestRouter::with_data(
                Arc::clone(&service),
                SocketAddr::from(([192, 168, 1, 10], 8443)),
                data,
            );
            Self {
                router,
                service,
                window,
                clock,
            }
        }

        fn issue_session(&self) -> crate::web_access::session::SessionIssued {
            self.service.issue_session_for_test("Pixel 8")
        }
    }

    struct TestResponse {
        status: StatusCode,
        headers: HeaderMap,
        body: Bytes,
    }

    impl TestResponse {
        fn of(response: Response<Full<Bytes>>) -> Self {
            let (parts, body) = response.into_parts();
            // No response on this surface may enable cross-origin access.
            assert!(!parts.headers.contains_key("access-control-allow-origin"));
            assert!(!parts
                .headers
                .contains_key("access-control-allow-credentials"));
            assert!(!parts.headers.contains_key("access-control-allow-headers"));
            assert!(!parts.headers.contains_key("access-control-allow-methods"));
            Self {
                status: parts.status,
                headers: parts.headers,
                body: body.into_inner().unwrap_or_default(),
            }
        }

        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).expect("json body")
        }

        fn text(&self) -> &str {
            std::str::from_utf8(&self.body).expect("utf8 body")
        }

        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name)?.to_str().ok()
        }

        fn set_cookies(&self) -> Vec<String> {
            self.headers
                .get_all(SET_COOKIE)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .map(str::to_owned)
                .collect()
        }

        fn cookies_named(&self, name: &str) -> Vec<String> {
            let prefix = format!("{name}=");
            self.set_cookies()
                .into_iter()
                .filter(|cookie| cookie.starts_with(prefix.as_str()))
                .collect()
        }

        fn single_cookie(&self, name: &str) -> (String, Vec<String>) {
            let prefix = format!("{name}=");
            let mut matching = self.cookies_named(name);
            assert_eq!(matching.len(), 1);
            let cookie = matching.pop().expect("cookie");
            let mut segments = cookie.split(';').map(str::trim);
            let value = segments
                .next()
                .and_then(|pair| pair.strip_prefix(prefix.as_str()))
                .expect("cookie value")
                .to_owned();
            (value, segments.map(str::to_owned).collect())
        }

        fn error_code(&self) -> String {
            self.json()
                .pointer("/error/code")
                .and_then(Value::as_str)
                .expect("error code")
                .to_owned()
        }
    }

    fn nonce(seed: u8) -> String {
        URL_SAFE_NO_PAD.encode([seed; 16])
    }

    fn request(method: Method, path: &str, body: Bytes) -> Request<Full<Bytes>> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", HOST)
            .header("origin", ORIGIN)
            .header("x-moyu-request", "1")
            .body(Full::new(body))
            .expect("test request")
    }

    fn read(path: &str) -> Request<Full<Bytes>> {
        request(Method::GET, path, Bytes::new())
    }

    fn write(path: &str, body: Bytes) -> Request<Full<Bytes>> {
        request(Method::POST, path, body)
    }

    fn raw_cookie(mut request: Request<Full<Bytes>>, cookie: &str) -> Request<Full<Bytes>> {
        request.headers_mut().insert(
            COOKIE,
            HeaderValue::from_str(cookie).expect("cookie header"),
        );
        request
    }

    fn poll_request(claim_id: &str, secret: &str) -> Request<Full<Bytes>> {
        let path = format!("{CLAIM_POLL_PREFIX}{claim_id}");
        raw_cookie(read(&path), &format!("{CLAIM_COOKIE}={secret}"))
    }

    fn consume_request(claim_id: &str, secret: &str) -> Request<Full<Bytes>> {
        let path = format!("{CLAIM_POLL_PREFIX}{claim_id}{CONSUME_SUFFIX}");
        raw_cookie(
            write(&path, Bytes::new()),
            &format!("{CLAIM_COOKIE}={secret}"),
        )
    }

    fn claim_body(fixture: &Fixture, claim_nonce: &str, device_name: &str) -> Bytes {
        let payload = json!({
            "pairingId": fixture.window.id.as_str(),
            "deviceName": device_name,
            "claimNonce": claim_nonce,
        });
        Bytes::from(serde_json::to_vec(&payload).expect("claim payload"))
    }

    async fn claim_over_http(
        fixture: &Fixture,
        claim_nonce: &str,
        source_ip: Option<Ipv4Addr>,
    ) -> (String, String) {
        let mut claim_request = write(CLAIM_ROUTE, claim_body(fixture, claim_nonce, "Pixel 8"));
        if let Some(source_ip) = source_ip {
            claim_request = TestSourceIp(source_ip).attach(claim_request);
        }
        let response = TestResponse::of(fixture.router.handle(claim_request).await);
        assert_eq!(response.status, StatusCode::ACCEPTED);
        let (secret, _) = response.single_cookie(CLAIM_COOKIE);
        let claim_id = response
            .json()
            .get("claimId")
            .and_then(Value::as_str)
            .expect("claimId")
            .to_owned();
        (claim_id, secret)
    }

    fn fake_image() -> ImageAsset {
        ImageAsset {
            bytes: vec![0xFF, 0xD8, 0xFF, 0xE0],
            mime: "image/jpeg",
            width: 100,
            height: 100,
            orig_width: 100,
            orig_height: 100,
            data_url: None,
        }
    }

    #[derive(Default)]
    struct FakeData {
        calls: Arc<AtomicUsize>,
        page_calls: Mutex<Vec<(u32, u32)>>,
        tile_calls: Mutex<Vec<(u32, u32, u32)>>,
        /// When set, the L2 conditional probe reports a miss so the request has
        /// to fall back to a real render. Defaults to a warm cache.
        cache_miss: bool,
    }

    impl FakeData {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn page_calls(&self) -> Vec<(u32, u32)> {
            self.page_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        fn tile_calls(&self) -> Vec<(u32, u32, u32)> {
            self.tile_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        fn record(&self) {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl WebDataAccess for FakeData {
        fn list_books(
            &self,
            _q: Option<&str>,
            _cursor: Option<&str>,
            _limit: u32,
        ) -> Result<WebBookPage, DataError> {
            self.record();
            Ok(WebBookPage {
                items: vec![],
                next_cursor: None,
            })
        }

        fn book(&self, id: &str) -> Result<WebBookDetail, DataError> {
            self.record();
            Ok(WebBookDetail {
                book: WebBook {
                    id: id.to_owned(),
                    title: "Book".to_owned(),
                    page_count: 2,
                    current_page: 0,
                    progress_rev: 0,
                    scroll_pct: -1.0,
                    format: "image".to_owned(),
                    source_type: "local".to_owned(),
                    missing: false,
                    updated_at: "2026-11-03T10:00:00+08:00".to_owned(),
                    thumb_url: Some(format!("/api/books/{id}/thumb?v=0")),
                },
                series_title: None,
                chapter_index: None,
                next_book_id: None,
            })
        }

        fn thumb(&self, _id: &str) -> Result<ImageAsset, DataError> {
            self.record();
            Ok(fake_image())
        }

        fn pages(&self, _id: &str) -> Result<PageManifest, DataError> {
            self.record();
            Ok(PageManifest {
                page_count: 2,
                pages: vec![PageIndex { index: 0 }, PageIndex { index: 1 }],
            })
        }

        fn page(&self, _id: &str, index: u32, width: u32) -> Result<ImageAsset, DataError> {
            self.record();
            self.page_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((index, width));
            Ok(fake_image())
        }

        fn cached_page(
            &self,
            _id: &str,
            _index: u32,
            _width: u32,
        ) -> Result<Option<ImageAsset>, DataError> {
            // Deliberately uncounted: only `page`/`tile` record, so a
            // conditional 304 can be proven to skip the render path.
            if self.cache_miss {
                Ok(None)
            } else {
                Ok(Some(fake_image()))
            }
        }

        fn layout(&self, _id: &str) -> Result<Vec<PageDim>, DataError> {
            self.record();
            Ok(vec![PageDim {
                index: 0,
                width: 800,
                height: 600,
            }])
        }

        fn tile(
            &self,
            _id: &str,
            index: u32,
            tile: u32,
            width: u32,
        ) -> Result<TileImage, DataError> {
            self.record();
            self.tile_calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((index, tile, width));
            Ok(TileImage {
                image: fake_image(),
                tile_count: 4,
                tile_height: 2048,
            })
        }

        fn cached_tile(
            &self,
            _id: &str,
            _index: u32,
            _tile: u32,
            _width: u32,
        ) -> Result<Option<TileImage>, DataError> {
            // Uncounted for the same reason as `cached_page`.
            if self.cache_miss {
                Ok(None)
            } else {
                Ok(Some(TileImage {
                    image: fake_image(),
                    tile_count: 4,
                    tile_height: 2048,
                }))
            }
        }

        fn progress(&self, _id: &str) -> Result<ProgressView, DataError> {
            self.record();
            Ok(ProgressView {
                page: 1,
                page_count: 2,
                scroll_pct: -1.0,
                rev: 7,
                updated_at: "2026-11-03T10:00:00+08:00".to_owned(),
            })
        }
    }

    struct ErrorData(DataError);

    impl WebDataAccess for ErrorData {
        fn list_books(
            &self,
            _q: Option<&str>,
            _cursor: Option<&str>,
            _limit: u32,
        ) -> Result<WebBookPage, DataError> {
            Err(self.0)
        }
        fn book(&self, _id: &str) -> Result<WebBookDetail, DataError> {
            Err(self.0)
        }
        fn thumb(&self, _id: &str) -> Result<ImageAsset, DataError> {
            Err(self.0)
        }
        fn pages(&self, _id: &str) -> Result<PageManifest, DataError> {
            Err(self.0)
        }
        fn page(&self, _id: &str, _index: u32, _width: u32) -> Result<ImageAsset, DataError> {
            Err(self.0)
        }
        fn cached_page(
            &self,
            _id: &str,
            _index: u32,
            _width: u32,
        ) -> Result<Option<ImageAsset>, DataError> {
            Err(self.0)
        }
        fn layout(&self, _id: &str) -> Result<Vec<PageDim>, DataError> {
            Err(self.0)
        }
        fn tile(
            &self,
            _id: &str,
            _index: u32,
            _tile: u32,
            _width: u32,
        ) -> Result<TileImage, DataError> {
            Err(self.0)
        }
        fn cached_tile(
            &self,
            _id: &str,
            _index: u32,
            _tile: u32,
            _width: u32,
        ) -> Result<Option<TileImage>, DataError> {
            Err(self.0)
        }
        fn progress(&self, _id: &str) -> Result<ProgressView, DataError> {
            Err(self.0)
        }
    }

    fn data_get(path: &str, token: Option<&str>) -> Request<Full<Bytes>> {
        let request = read(path);
        match token {
            Some(token) => raw_cookie(request, &format!("{SESSION_COOKIE}={token}")),
            None => request,
        }
    }

    fn book_path(suffix: &str) -> String {
        format!("/api/books/{}{suffix}", "a".repeat(64))
    }

    fn assert_error(response: &TestResponse, status: StatusCode, code: &str) {
        assert_eq!(response.status, status);
        assert_eq!(response.error_code(), code);
        assert_eq!(response.header("cache-control"), Some("no-store"));
        assert!(response.header("www-authenticate").is_none());
        assert_eq!(
            response.header("x-request-id").map(str::len),
            Some(16),
            "missing request id"
        );
        let body = response.json();
        assert_eq!(
            body.pointer("/error/requestId").and_then(Value::as_str),
            response.header("x-request-id")
        );
        let text = response.text();
        assert!(!text.contains("path"), "error body leaked a path: {text}");
        assert!(!text.contains("C:"), "error body leaked a drive: {text}");
        assert!(
            !text.contains("moyus_"),
            "error body leaked a token: {text}"
        );
    }

    #[tokio::test]
    async fn data_requires_a_session_and_unknown_paths_are_404() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());

        let no_cookie = TestResponse::of(fixture.router.handle(data_get("/api/books", None)).await);
        assert_error(&no_cookie, StatusCode::UNAUTHORIZED, "unauthorized");
        assert!(no_cookie.cookies_named(SESSION_COOKIE).is_empty());

        let unknown = TestResponse::of(fixture.router.handle(data_get("/api/nope", None)).await);
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
        assert_eq!(
            data.calls(),
            0,
            "unauthenticated/unknown requests must not read data"
        );

        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let ok = TestResponse::of(
            fixture
                .router
                .handle(data_get("/api/books", Some(token)))
                .await,
        );
        assert_eq!(ok.status, StatusCode::OK);
        assert_eq!(
            ok.header("content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(ok.header("cache-control"), Some("private, no-cache"));
        assert_eq!(ok.header("vary"), Some("Cookie"));
        assert_eq!(ok.header("x-request-id").map(str::len), Some(16));
        assert!(ok.header("access-control-allow-origin").is_none());
        assert_eq!(
            ok.json()
                .pointer("/items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert!(ok.json().pointer("/nextCursor").is_some_and(Value::is_null));
        assert!(!ok.text().contains("path"));
        assert_eq!(data.calls(), 1);

        let post = TestResponse::of(
            fixture
                .router
                .handle(write("/api/books", Bytes::new()))
                .await,
        );
        assert_eq!(post.status, StatusCode::NOT_FOUND);
        let head = TestResponse::of(
            fixture
                .router
                .handle(request(Method::HEAD, "/api/books", Bytes::new()))
                .await,
        );
        assert_eq!(head.status, StatusCode::NOT_FOUND);
        let options = TestResponse::of(
            fixture
                .router
                .handle(request(Method::OPTIONS, "/api/books", Bytes::new()))
                .await,
        );
        assert_eq!(options.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn all_eight_data_routes_require_a_session_and_serve_with_one() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let id = "a".repeat(64);
        let paths = [
            "/api/books".to_owned(),
            format!("/api/books/{id}"),
            format!("/api/books/{id}/thumb"),
            format!("/api/books/{id}/pages"),
            format!("/api/books/{id}/pages/0"),
            format!("/api/books/{id}/layout"),
            format!("/api/books/{id}/progress"),
            format!("/api/books/{id}/pages/0/tiles/0"),
        ];

        for path in &paths {
            let response = TestResponse::of(fixture.router.handle(data_get(path, None)).await);
            assert_error(&response, StatusCode::UNAUTHORIZED, "unauthorized");
        }
        assert_eq!(data.calls(), 0);

        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        for path in &paths {
            let response =
                TestResponse::of(fixture.router.handle(data_get(path, Some(token))).await);
            assert_eq!(response.status, StatusCode::OK, "{path}");
            assert_eq!(response.header("x-request-id").map(str::len), Some(16));
        }
        assert_eq!(data.calls(), 8);
    }

    #[tokio::test]
    async fn only_successful_page_and_tile_reads_refresh_the_cookie() {
        let fixture = Fixture::with_data(Arc::new(FakeData::default()));
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let page_path = book_path("/pages/0");

        // The first 60-minute window after issuance is deliberately throttled;
        // a refresh only becomes eligible after the shared interval elapses.
        fixture.clock.advance(Duration::from_secs(61 * 60));
        let page = TestResponse::of(
            fixture
                .router
                .handle(data_get(&page_path, Some(token)))
                .await,
        );
        assert_eq!(page.status, StatusCode::OK);
        assert_eq!(page.cookies_named(SESSION_COOKIE).len(), 1);

        let books = TestResponse::of(
            fixture
                .router
                .handle(data_get("/api/books", Some(token)))
                .await,
        );
        assert_eq!(books.status, StatusCode::OK);
        assert!(books.cookies_named(SESSION_COOKIE).is_empty());

        // The shared 60-minute throttle applies across page and tile reads.
        fixture.clock.advance(Duration::from_secs(61 * 60));
        let tile_path = book_path("/pages/0/tiles/0");
        let tile = TestResponse::of(
            fixture
                .router
                .handle(data_get(&tile_path, Some(token)))
                .await,
        );
        assert_eq!(tile.status, StatusCode::OK);
        assert_eq!(tile.cookies_named(SESSION_COOKIE).len(), 1);
    }

    #[tokio::test]
    async fn page_image_headers_etag_and_conditional_304() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let page_path = book_path("/pages/0");

        let first = TestResponse::of(
            fixture
                .router
                .handle(data_get(&page_path, Some(token)))
                .await,
        );
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(first.header("content-type"), Some("image/jpeg"));
        assert_eq!(first.header("cache-control"), Some("private, no-cache"));
        assert_eq!(first.header("vary"), Some("Cookie"));
        assert_eq!(first.header("content-disposition"), Some("inline"));
        assert_eq!(first.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(first.header("x-request-id").map(str::len), Some(16));
        assert!(first.body.starts_with(&[0xFF, 0xD8]));
        let etag = first.header("etag").expect("etag").to_owned();
        assert!(etag.starts_with("\"p-0-1080-"), "{etag}");
        assert_eq!(
            data.page_calls().len(),
            1,
            "the initial GET must render exactly once"
        );

        let mut conditional = data_get(&page_path, Some(token));
        conditional
            .headers_mut()
            .insert(IF_NONE_MATCH, HeaderValue::from_str(&etag).unwrap());
        fixture.clock.advance(Duration::from_secs(61 * 60));
        let second = TestResponse::of(fixture.router.handle(conditional).await);
        assert_eq!(second.status, StatusCode::NOT_MODIFIED);
        assert!(second.body.is_empty());
        assert_eq!(second.header("etag"), Some(etag.as_str()));
        assert_eq!(second.header("vary"), Some("Cookie"));
        assert_eq!(second.header("cache-control"), Some("private, no-cache"));
        assert!(second.header("content-type").is_none());
        // A 304 on a page read still refreshes the session.
        assert_eq!(second.cookies_named(SESSION_COOKIE).len(), 1);
        // The conditional probe served this from the cached bytes; the render
        // path must not have run a second time.
        assert_eq!(
            data.page_calls().len(),
            1,
            "a conditional 304 must be served without calling page()"
        );

        let clamped = TestResponse::of(
            fixture
                .router
                .handle(data_get(&format!("{page_path}?w=1"), Some(token)))
                .await,
        );
        assert_eq!(clamped.status, StatusCode::OK);
        assert!(clamped
            .header("etag")
            .expect("etag")
            .starts_with("\"p-0-320-"));
        assert_eq!(
            data.page_calls().len(),
            2,
            "a non-conditional request must still render"
        );
        assert_eq!(
            data.page_calls().last(),
            Some(&(0, 320)),
            "HTTP layer must pass the clamped width"
        );
    }

    #[tokio::test]
    async fn tile_headers_use_the_bucketed_width() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let tile_path = book_path("/pages/0/tiles/0");

        let tile = TestResponse::of(
            fixture
                .router
                .handle(data_get(&tile_path, Some(token)))
                .await,
        );
        assert_eq!(tile.status, StatusCode::OK);
        assert_eq!(tile.header("content-type"), Some("image/jpeg"));
        assert_eq!(tile.header("x-tile-count"), Some("4"));
        assert_eq!(tile.header("x-tile-height"), Some("2048"));
        assert_eq!(tile.header("x-request-id").map(str::len), Some(16));
        assert!(
            tile.header("etag")
                .expect("etag")
                .starts_with("\"t-0-0-1088-"),
            "default 1080 must bucket to 1088: {:?}",
            tile.header("etag")
        );
        assert_eq!(data.tile_calls(), vec![(0, 0, 1088)]);
    }

    #[tokio::test]
    async fn tile_304_keeps_geometry_headers() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let tile_path = book_path("/pages/0/tiles/0");

        let first = TestResponse::of(
            fixture
                .router
                .handle(data_get(&tile_path, Some(token)))
                .await,
        );
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(data.tile_calls().len(), 1);
        let etag = first.header("etag").expect("etag").to_owned();

        let mut conditional = data_get(&tile_path, Some(token));
        conditional
            .headers_mut()
            .insert(IF_NONE_MATCH, HeaderValue::from_str(&etag).unwrap());
        let second = TestResponse::of(fixture.router.handle(conditional).await);
        assert_eq!(second.status, StatusCode::NOT_MODIFIED);
        assert_eq!(second.header("etag"), Some(etag.as_str()));
        assert_eq!(second.header("x-tile-count"), Some("4"));
        assert_eq!(second.header("x-tile-height"), Some("2048"));
        assert_eq!(
            data.tile_calls().len(),
            1,
            "a conditional tile 304 must not call tile() again"
        );
    }

    #[tokio::test]
    async fn conditional_cache_miss_falls_through_to_render() {
        // A cold L2 cache still has to answer a conditional request by
        // re-rendering; the fallback must remain intact.
        let data = Arc::new(FakeData {
            cache_miss: true,
            ..FakeData::default()
        });
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let page_path = book_path("/pages/0");

        let first = TestResponse::of(
            fixture
                .router
                .handle(data_get(&page_path, Some(token)))
                .await,
        );
        assert_eq!(first.status, StatusCode::OK);
        let etag = first.header("etag").expect("etag").to_owned();
        assert_eq!(data.page_calls().len(), 1);

        let mut conditional = data_get(&page_path, Some(token));
        conditional
            .headers_mut()
            .insert(IF_NONE_MATCH, HeaderValue::from_str(&etag).unwrap());
        let second = TestResponse::of(fixture.router.handle(conditional).await);
        // The probe missed, so `page` ran again; identical bytes still hash to
        // the same ETag and the client gets a 304.
        assert_eq!(
            data.page_calls().len(),
            2,
            "a cache miss must fall through to page()"
        );
        assert_eq!(second.status, StatusCode::NOT_MODIFIED);
        assert_eq!(second.header("etag"), Some(etag.as_str()));
        assert!(second.body.is_empty());
        assert!(data.page_calls().contains(&(0, 1080)));
    }

    #[tokio::test]
    async fn malformed_queries_are_400_only_after_authentication() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();

        let no_cookie = TestResponse::of(
            fixture
                .router
                .handle(data_get("/api/books?limit=0", None))
                .await,
        );
        assert_error(&no_cookie, StatusCode::UNAUTHORIZED, "unauthorized");

        for path in [
            "/api/books?limit=0",
            "/api/books?limit=101",
            "/api/books?limit=x",
            "/api/books?limit=1&limit=2",
            "/api/books?q=a&q=b",
        ] {
            let response =
                TestResponse::of(fixture.router.handle(data_get(path, Some(token))).await);
            assert_error(&response, StatusCode::BAD_REQUEST, "invalid-parameter");
        }

        let long_q = format!("/api/books?q={}", "a".repeat(129));
        let response =
            TestResponse::of(fixture.router.handle(data_get(&long_q, Some(token))).await);
        assert_error(&response, StatusCode::BAD_REQUEST, "invalid-parameter");

        let long_cursor = format!("/api/books?cursor={}", "a".repeat(65));
        let response = TestResponse::of(
            fixture
                .router
                .handle(data_get(&long_cursor, Some(token)))
                .await,
        );
        assert_error(&response, StatusCode::BAD_REQUEST, "invalid-parameter");

        for suffix in ["?w=abc", "?w=1.5", "?w=1&w=2", "?w="] {
            let path = book_path(&format!("/pages/0{suffix}"));
            let response =
                TestResponse::of(fixture.router.handle(data_get(&path, Some(token))).await);
            assert_error(&response, StatusCode::BAD_REQUEST, "invalid-parameter");
        }
        assert_eq!(
            data.calls(),
            0,
            "query validation must fail before the provider runs"
        );
    }

    #[tokio::test]
    async fn data_rate_limit_returns_429_before_authentication() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let path = book_path("/pages/0/tiles/0");

        for _ in 0..600 {
            let response = TestResponse::of(fixture.router.handle(data_get(&path, None)).await);
            assert_eq!(response.status, StatusCode::UNAUTHORIZED);
        }

        let limited = TestResponse::of(fixture.router.handle(data_get(&path, None)).await);
        assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(limited.error_code(), "pairing-rate-limited");
        assert!(
            limited
                .header("retry-after")
                .expect("retry-after")
                .parse::<u64>()
                .expect("seconds")
                >= 1
        );
        assert!(
            limited
                .json()
                .pointer("/error/retryAfterMs")
                .and_then(Value::as_u64)
                .expect("retryAfterMs")
                >= 1
        );
        assert!(limited.cookies_named(SESSION_COOKIE).is_empty());
        assert_eq!(
            data.calls(),
            0,
            "rate limiting must happen before any provider read"
        );
    }

    async fn error_response_for(error: DataError, path: &str) -> TestResponse {
        let fixture = Fixture::with_data(Arc::new(ErrorData(error)));
        let issued = fixture.issue_session();
        TestResponse::of(
            fixture
                .router
                .handle(data_get(path, Some(issued.token.as_str())))
                .await,
        )
    }

    #[tokio::test]
    async fn data_errors_map_to_stable_status_codes_and_details() {
        let book = format!("/api/books/{}", "a".repeat(64));

        let not_found = error_response_for(DataError::NotFound, &book).await;
        assert_error(&not_found, StatusCode::NOT_FOUND, "book-not-found");

        let thumb = error_response_for(DataError::ThumbMissing, &format!("{book}/thumb")).await;
        assert_error(&thumb, StatusCode::NOT_FOUND, "thumbnail-missing");

        let pdf = error_response_for(DataError::PdfUnsupported, &format!("{book}/pages")).await;
        assert_error(
            &pdf,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "pdf-source-unsupported",
        );

        let source_unsupported = error_response_for(DataError::SourceUnsupported, &book).await;
        assert_error(
            &source_unsupported,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "source-unsupported",
        );

        let missing = error_response_for(DataError::SourceMissing, &format!("{book}/layout")).await;
        assert_error(&missing, StatusCode::CONFLICT, "source-missing");

        let page_range = error_response_for(
            DataError::PageOutOfRange { max_page: 4 },
            &format!("{book}/pages/9"),
        )
        .await;
        assert_error(
            &page_range,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "page-out-of-range",
        );
        assert_eq!(
            page_range
                .json()
                .pointer("/error/details/maxPage")
                .and_then(Value::as_u64),
            Some(4)
        );
        assert!(page_range.cookies_named(SESSION_COOKIE).is_empty());

        let tile_range = error_response_for(
            DataError::TileOutOfRange { max_tile: 3 },
            &format!("{book}/pages/9/tiles/9"),
        )
        .await;
        // The frozen contract uses page-out-of-range with details.maxTile.
        assert_error(
            &tile_range,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "page-out-of-range",
        );
        assert_eq!(
            tile_range
                .json()
                .pointer("/error/details/maxTile")
                .and_then(Value::as_u64),
            Some(3)
        );
        assert!(tile_range.cookies_named(SESSION_COOKIE).is_empty());

        let busy = error_response_for(DataError::Busy, &book).await;
        assert_error(&busy, StatusCode::SERVICE_UNAVAILABLE, "busy");
        assert_eq!(busy.header("retry-after"), Some("1"));
        // `retryAfterMs` is reserved for the 429 rate-limit body; a 503 only
        // carries the header.
        assert!(
            busy.json().pointer("/error/retryAfterMs").is_none(),
            "503 must not serialize retryAfterMs into the error body"
        );
        assert!(busy.cookies_named(SESSION_COOKIE).is_empty());

        let unavailable = error_response_for(DataError::DbUnavailable, &book).await;
        assert_error(&unavailable, StatusCode::SERVICE_UNAVAILABLE, "busy");
        assert_eq!(unavailable.header("retry-after"), Some("1"));

        let timeout = error_response_for(DataError::Timeout, &book).await;
        assert_error(&timeout, StatusCode::GATEWAY_TIMEOUT, "render-timeout");

        let internal = error_response_for(DataError::Internal, &book).await;
        assert_error(
            &internal,
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal-error",
        );
    }

    #[tokio::test]
    async fn revoked_session_is_unauthorized_before_any_304() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        let page_path = book_path("/pages/0");

        let first = TestResponse::of(
            fixture
                .router
                .handle(data_get(&page_path, Some(token)))
                .await,
        );
        assert_eq!(first.status, StatusCode::OK);
        let etag = first.header("etag").expect("etag").to_owned();

        assert!(fixture.service.revoke_device(&issued.id));

        let mut conditional = data_get(&page_path, Some(token));
        conditional
            .headers_mut()
            .insert(IF_NONE_MATCH, HeaderValue::from_str(&etag).unwrap());
        let revoked = TestResponse::of(fixture.router.handle(conditional).await);
        assert_error(&revoked, StatusCode::UNAUTHORIZED, "unauthorized");
        // Authentication must fail closed before the cache probe or a render.
        assert_eq!(
            data.page_calls().len(),
            1,
            "a revoked session must not probe the cache or re-render"
        );
    }

    #[tokio::test]
    async fn claim_sets_exact_cookie_and_json_has_no_secret() {
        let fixture = Fixture::new();
        let response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &nonce(1), "Pixel 8"),
                ))
                .await,
        );

        assert_eq!(response.status, StatusCode::ACCEPTED);
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(response.header("cache-control"), Some("no-store"));

        let (secret, attributes) = response.single_cookie(CLAIM_COOKIE);
        assert_eq!(secret.len(), 43);
        assert!(secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(
            attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/api/pair/claim",
                "Max-Age=120",
            ]
        );

        let json = response.json();
        assert_eq!(json.as_object().map(|object| object.len()), Some(1));
        let claim_id = json
            .get("claimId")
            .and_then(Value::as_str)
            .expect("claimId");
        assert!(claim_id.starts_with("claim_"));
        assert_eq!(claim_id.len(), 38);

        let body = response.text();
        assert!(!body.contains(&secret));
        assert!(!body.contains("moyus_"));
    }

    #[tokio::test]
    async fn claim_requires_exact_origin_and_x_moyu() {
        let fixture = Fixture::new();
        let mut cases = Vec::new();

        let mut missing_origin = write(CLAIM_ROUTE, claim_body(&fixture, &nonce(0), "Pixel 8"));
        missing_origin.headers_mut().remove("origin");
        cases.push(missing_origin);

        let mut missing_header = write(CLAIM_ROUTE, claim_body(&fixture, &nonce(1), "Pixel 8"));
        missing_header.headers_mut().remove("x-moyu-request");
        cases.push(missing_header);

        let mut referer_only = write(CLAIM_ROUTE, claim_body(&fixture, &nonce(2), "Pixel 8"));
        referer_only.headers_mut().remove("origin");
        referer_only
            .headers_mut()
            .insert("referer", HeaderValue::from_static(ORIGIN));
        cases.push(referer_only);

        let mut wrong_origin = write(CLAIM_ROUTE, claim_body(&fixture, &nonce(3), "Pixel 8"));
        wrong_origin.headers_mut().insert(
            "origin",
            HeaderValue::from_static("https://192.168.1.11:8443"),
        );
        cases.push(wrong_origin);

        let mut null_origin = write(CLAIM_ROUTE, claim_body(&fixture, &nonce(4), "Pixel 8"));
        null_origin
            .headers_mut()
            .insert("origin", HeaderValue::from_static("null"));
        cases.push(null_origin);

        for case in cases {
            let response = TestResponse::of(fixture.router.handle(case).await);
            assert_eq!(response.status, StatusCode::FORBIDDEN);
            assert_eq!(response.error_code(), "forbidden");
            assert!(response.set_cookies().is_empty());
        }

        // None of the rejected writes created a claim: the nonce from the
        // first rejected case is still claimable.
        let response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &nonce(0), "Pixel 8"),
                ))
                .await,
        );
        assert_eq!(response.status, StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn host_must_be_exact_bound_ip_port_and_moyu_local_is_rejected() {
        let fixture = Fixture::new();
        for host in [
            "moyu.local:8443",
            "0.0.0.0:8443",
            "192.168.1.10:8444",
            "192.168.1.10",
        ] {
            let request = Request::builder()
                .method(Method::GET)
                .uri(HEALTH_PATH)
                .header("host", host)
                .body(Full::new(Bytes::new()))
                .expect("health request");
            let response = TestResponse::of(fixture.router.handle(request).await);
            assert_eq!(response.status, StatusCode::MISDIRECTED_REQUEST);
            assert_eq!(response.error_code(), "forbidden");
        }

        let missing_host = Request::builder()
            .method(Method::GET)
            .uri(HEALTH_PATH)
            .body(Full::new(Bytes::new()))
            .expect("health request");
        let response = TestResponse::of(fixture.router.handle(missing_host).await);
        assert_eq!(response.status, StatusCode::MISDIRECTED_REQUEST);
        assert_eq!(response.error_code(), "forbidden");

        let response = TestResponse::of(fixture.router.handle(read(HEALTH_PATH)).await);
        assert_eq!(response.status, StatusCode::NO_CONTENT);
        assert!(response.body.is_empty());
    }

    #[tokio::test]
    async fn duplicate_claim_is_409_and_never_reissues_a_secret() {
        let fixture = Fixture::new();
        let claim_nonce = nonce(7);

        let first = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &claim_nonce, "Pixel 8"),
                ))
                .await,
        );
        assert_eq!(first.status, StatusCode::ACCEPTED);
        let (first_secret, _) = first.single_cookie(CLAIM_COOKIE);

        let second = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &claim_nonce, "Pixel 8"),
                ))
                .await,
        );
        assert_eq!(second.status, StatusCode::CONFLICT);
        assert_eq!(second.error_code(), "pairing-claimed");
        assert!(second.set_cookies().is_empty());
        assert!(!second.text().contains(&first_secret));
    }

    #[tokio::test]
    async fn approved_get_is_read_only_and_never_issues_a_session() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(1), None).await;
        fixture.service.approve(&claim_id).expect("approval");
        assert_eq!(fixture.service.session_slots(), (0, 1));

        // A same-origin GET normally carries no Origin. The read-only status
        // route must work without it and without the custom header.
        let mut request = poll_request(&claim_id, &secret);
        request.headers_mut().remove("origin");
        request.headers_mut().remove("x-moyu-request");
        let response = TestResponse::of(fixture.router.handle(request).await);
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.json().get("state").and_then(Value::as_str),
            Some("approved")
        );
        assert!(response.set_cookies().is_empty());
        assert!(!response.text().contains("moyus_"));
        assert!(!response.text().contains(&secret));
        // Approval reserved a slot, but no token was issued by the read.
        assert_eq!(fixture.service.session_slots(), (0, 1));

        // Polling again behaves identically: GET has no side effects.
        let response = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.json().get("state").and_then(Value::as_str),
            Some("approved")
        );
        assert!(response.set_cookies().is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));
    }

    #[tokio::test]
    async fn consume_post_requires_origin_and_x_moyu_then_issues_once() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(1), None).await;
        fixture.service.approve(&claim_id).expect("approval");
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let mut missing_origin = consume_request(&claim_id, &secret);
        missing_origin.headers_mut().remove("origin");
        let mut missing_header = consume_request(&claim_id, &secret);
        missing_header.headers_mut().remove("x-moyu-request");
        let mut wrong_origin = consume_request(&claim_id, &secret);
        wrong_origin.headers_mut().insert(
            "origin",
            HeaderValue::from_static("https://192.168.1.11:8443"),
        );
        for case in [missing_origin, missing_header, wrong_origin] {
            let response = TestResponse::of(fixture.router.handle(case).await);
            assert_eq!(response.status, StatusCode::FORBIDDEN);
            assert_eq!(response.error_code(), "forbidden");
            assert!(response.set_cookies().is_empty());
            assert!(!response.text().contains("moyus_"));
            assert_eq!(fixture.service.session_slots(), (0, 1));
        }

        // Missing cookie on an otherwise valid POST is 401 and consumes
        // nothing.
        let response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    &format!("{CLAIM_POLL_PREFIX}{claim_id}{CONSUME_SUFFIX}"),
                    Bytes::new(),
                ))
                .await,
        );
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
        assert_eq!(response.error_code(), "unauthorized");
        assert!(response.set_cookies().is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));

        // Duplicate or unrelated cookies are ambiguous/fail-closed on POST too.
        for cookie in [
            "other=x".to_owned(),
            format!("{CLAIM_COOKIE}=a; {CLAIM_COOKIE}=b"),
        ] {
            let response = TestResponse::of(
                fixture
                    .router
                    .handle(raw_cookie(
                        write(
                            &format!("{CLAIM_POLL_PREFIX}{claim_id}{CONSUME_SUFFIX}"),
                            Bytes::new(),
                        ),
                        &cookie,
                    ))
                    .await,
            );
            assert_eq!(response.status, StatusCode::UNAUTHORIZED);
            assert_eq!(response.error_code(), "unauthorized");
            assert!(response.set_cookies().is_empty());
            assert_eq!(fixture.service.session_slots(), (0, 1));
        }

        let response = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::OK);
        let json = response.json();
        assert_eq!(json.get("state").and_then(Value::as_str), Some("consumed"));

        let (token, session_attributes) = response.single_cookie(SESSION_COOKIE);
        assert!(token.starts_with("moyus_"));
        assert_eq!(token.len(), 49);
        assert_eq!(
            session_attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/",
                "Max-Age=2592000",
            ]
        );
        let (cleared, clear_attributes) = response.single_cookie(CLAIM_COOKIE);
        assert!(cleared.is_empty());
        assert_eq!(
            clear_attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/api/pair/claim",
                "Max-Age=0",
            ]
        );
        assert!(!response.text().contains(&token));
        assert!(!response.text().contains(&secret));
        assert_eq!(fixture.service.session_slots(), (1, 0));

        // A second pickup is 409 and never re-issues a token.
        let second = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(second.status, StatusCode::CONFLICT);
        assert_eq!(second.error_code(), "pairing-consumed");
        assert!(second.cookies_named(SESSION_COOKIE).is_empty());
        assert!(!second.text().contains("moyus_"));

        // The read-only GET after consumption reports the same terminal code
        // and never exposes the token.
        let read = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(read.status, StatusCode::CONFLICT);
        assert_eq!(read.error_code(), "pairing-consumed");
        assert!(read.cookies_named(SESSION_COOKIE).is_empty());
        assert!(!read.text().contains("moyus_"));
    }

    #[tokio::test]
    async fn consume_handler_rechecks_pickup_headers_without_the_guard() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(6), None).await;
        fixture.service.approve(&claim_id).expect("approval");
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let mut request = consume_request(&claim_id, &secret);
        request.headers_mut().remove("x-moyu-request");
        // Call the handler directly: its defense-in-depth check must hold even
        // if a future router stops running the shared RequestGuard first.
        let response = TestResponse::of(fixture.router.consume(request, &claim_id).await);
        assert_eq!(response.status, StatusCode::FORBIDDEN);
        assert_eq!(response.error_code(), "forbidden");
        assert!(response.set_cookies().is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));
    }

    #[tokio::test]
    async fn terminal_deny_rejects_consume_and_allows_one_status_receipt() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(2), None).await;
        fixture.service.deny(&claim_id).expect("deny");

        // The POST pickup on a denied claim is a state change: 403 with the
        // stable denied code, never a token, and it does not burn the receipt.
        let pickup = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(pickup.status, StatusCode::FORBIDDEN);
        assert_eq!(pickup.error_code(), "pairing-denied");
        assert!(pickup.cookies_named(SESSION_COOKIE).is_empty());
        assert!(!pickup.text().contains("moyus_"));
        assert!(!pickup.text().contains(&secret));

        let first = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(first.status, StatusCode::OK);
        let json = first.json();
        assert_eq!(json.get("state").and_then(Value::as_str), Some("denied"));
        assert!(first.cookies_named(SESSION_COOKIE).is_empty());
        let (cleared, attributes) = first.single_cookie(CLAIM_COOKIE);
        assert!(cleared.is_empty());
        assert_eq!(
            attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/api/pair/claim",
                "Max-Age=0",
            ]
        );
        assert!(!first.text().contains("moyus_"));
        assert!(!first.text().contains(&secret));

        let second = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(second.status, StatusCode::NOT_FOUND);
        assert_eq!(second.error_code(), "pairing-not-found");
        assert!(second.cookies_named(SESSION_COOKIE).is_empty());
    }

    #[tokio::test]
    async fn poll_without_or_with_ambiguous_cookie_is_401() {
        let fixture = Fixture::new();
        let (claim_id, _) = claim_over_http(&fixture, &nonce(8), None).await;
        let path = format!("{CLAIM_POLL_PREFIX}{claim_id}");

        let missing = TestResponse::of(fixture.router.handle(read(&path)).await);
        assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
        assert_eq!(missing.error_code(), "unauthorized");
        assert!(missing.cookies_named(SESSION_COOKIE).is_empty());
        assert!(missing.set_cookies().is_empty());

        for cookie in [
            "other=x".to_owned(),
            format!("{CLAIM_COOKIE}=a; {CLAIM_COOKIE}=b"),
        ] {
            let response = TestResponse::of(
                fixture
                    .router
                    .handle(raw_cookie(read(&path), &cookie))
                    .await,
            );
            assert_eq!(response.status, StatusCode::UNAUTHORIZED);
            assert_eq!(response.error_code(), "unauthorized");
            assert!(response.cookies_named(SESSION_COOKIE).is_empty());
            assert!(response.set_cookies().is_empty());
        }
    }

    #[tokio::test]
    async fn pickup_timeout_returns_410_pairing_expired() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(9), None).await;
        fixture.service.approve(&claim_id).expect("approval");
        assert_eq!(fixture.service.session_slots(), (0, 1));

        fixture
            .clock
            .advance(PICKUP_TIMEOUT + Duration::from_millis(1));

        let response = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::GONE);
        assert_eq!(response.error_code(), "pairing-expired");
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        assert!(!response.text().contains("moyus_"));
        assert!(!response.text().contains(&secret));
        // The timed-out pickup releases the reserved session slot.
        assert_eq!(fixture.service.session_slots(), (0, 0));

        // A read-only poll reports the same expired code without a receipt.
        let read = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(read.status, StatusCode::GONE);
        assert_eq!(read.error_code(), "pairing-expired");
        assert!(read.cookies_named(SESSION_COOKIE).is_empty());
        assert!(!read.text().contains("moyus_"));
        assert!(!read.text().contains(&secret));
    }

    #[tokio::test]
    async fn wrong_claim_cookie_is_404_and_does_not_burn_the_approved_pickup() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(3), None).await;
        fixture.service.approve(&claim_id).expect("approval");
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let wrong_secret = "A".repeat(43);
        let response = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &wrong_secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(response.error_code(), "pairing-not-found");
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));

        // The read-only status route is equally secret-bound and no-op.
        let read = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &wrong_secret))
                .await,
        );
        assert_eq!(read.status, StatusCode::NOT_FOUND);
        assert_eq!(read.error_code(), "pairing-not-found");
        assert!(read.cookies_named(SESSION_COOKIE).is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let response = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::OK);
        let (token, _) = response.single_cookie(SESSION_COOKIE);
        assert!(token.starts_with("moyus_"));
        assert_eq!(fixture.service.session_slots(), (1, 0));
    }

    #[tokio::test]
    async fn options_unknown_paths_and_methods_are_404_without_cors() {
        let fixture = Fixture::new();
        for (method, path) in [
            (Method::OPTIONS, CLAIM_ROUTE),
            (Method::GET, CLAIM_ROUTE),
            (Method::GET, "/api/pair/claim/"),
            (Method::GET, "/api/pair/claim/claim_x/extra"),
            (Method::GET, "/api/pair/claim/claim_x/consume"),
            (Method::POST, "/api/pair/claim/claim_x"),
            (Method::POST, "/api/pair/claim/claim_x/consume/extra"),
            (Method::POST, HEALTH_PATH),
            (Method::GET, "/api/unknown"),
            (Method::DELETE, "/api/pair/claim/claim_x"),
            (Method::DELETE, "/api/pair/claim/claim_x/consume"),
        ] {
            let response = TestResponse::of(
                fixture
                    .router
                    .handle(request(method, path, Bytes::new()))
                    .await,
            );
            assert_eq!(response.status, StatusCode::NOT_FOUND);
            assert!(response.set_cookies().is_empty());
            assert!(!response.headers.contains_key("access-control-allow-origin"));
        }
    }

    #[tokio::test]
    async fn oversized_and_invalid_claim_bodies_are_rejected() {
        let fixture = Fixture::new();

        let oversized = json!({
            "pairingId": fixture.window.id.as_str(),
            "deviceName": "x".repeat(MAX_CLAIM_BODY_BYTES + 1),
            "claimNonce": nonce(1),
        });
        let response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    Bytes::from(serde_json::to_vec(&oversized).expect("oversized payload")),
                ))
                .await,
        );
        assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response.error_code(), "body-too-large");
        assert!(response.set_cookies().is_empty());

        let invalid_json = TestResponse::of(
            fixture
                .router
                .handle(write(CLAIM_ROUTE, Bytes::from_static(b"{not-json")))
                .await,
        );
        assert_eq!(invalid_json.status, StatusCode::BAD_REQUEST);
        assert_eq!(invalid_json.error_code(), "invalid-parameter");
        assert!(invalid_json.set_cookies().is_empty());

        let invalid_nonce = TestResponse::of(
            fixture
                .router
                .handle(write(CLAIM_ROUTE, claim_body(&fixture, "short", "Pixel 8")))
                .await,
        );
        assert_eq!(invalid_nonce.status, StatusCode::BAD_REQUEST);
        assert_eq!(invalid_nonce.error_code(), "invalid-parameter");

        let missing_field = json!({ "pairingId": fixture.window.id.as_str() });
        let response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    Bytes::from(serde_json::to_vec(&missing_field).expect("payload")),
                ))
                .await,
        );
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.error_code(), "invalid-parameter");

        // Rejected bodies never reach the pairing store, so the valid nonce is
        // still available.
        let response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &nonce(1), "Pixel 8"),
                ))
                .await,
        );
        assert_eq!(response.status, StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn pending_and_device_views_never_expose_secret_or_token() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(7), None).await;

        let pending = fixture.service.pending_claims();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].claim_id, claim_id);
        assert_eq!(pending[0].device_name, "Pixel 8");
        assert_eq!(pending[0].source_ip, DEFAULT_SOURCE_IP);
        assert_eq!(fixture.service.pending_count(), 1);

        fixture.service.approve(&claim_id).expect("approve");
        assert_eq!(fixture.service.pending_count(), 0);
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let issued = fixture
            .service
            .consume(&claim_id, &secret)
            .expect("consume");
        let devices = fixture.service.devices();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_name, "Pixel 8");
        // `SessionView` has no token/token-hash field by construction; the
        // plaintext token only exists in the one-time `SessionIssued`.
        assert_eq!(issued.token.len(), 49);
        assert!(!format!("{devices:?}").contains(issued.token.as_str()));
    }

    #[tokio::test]
    async fn status_route_per_ip_bucket_returns_429_with_retry_after() {
        let fixture = Fixture::with_polling(Duration::ZERO, Duration::from_millis(1));
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(8), None).await;
        let mut last = None;
        for _ in 0..=60 {
            last = Some(TestResponse::of(
                fixture
                    .router
                    .handle(poll_request(&claim_id, &secret))
                    .await,
            ));
        }
        let response = last.expect("one response");
        assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.error_code(), "pairing-rate-limited");
        assert!(response.header("retry-after").is_some());
        assert!(response.json()["error"]["retryAfterMs"]
            .as_u64()
            .is_some_and(|value| value >= 1));
    }

    #[tokio::test]
    async fn pending_long_poll_waits_for_the_window_then_returns_pending() {
        let fixture = Fixture::with_polling(Duration::from_millis(30), Duration::from_millis(5));
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(4), None).await;

        // The status route is read-only, so it never requires Origin or
        // X-Moyu-Request; removing them must not change the poll.
        let mut pending_poll = poll_request(&claim_id, &secret);
        pending_poll.headers_mut().remove("origin");
        pending_poll.headers_mut().remove("x-moyu-request");

        let started = Instant::now();
        let response = TestResponse::of(fixture.router.handle(pending_poll).await);
        let elapsed = started.elapsed();

        assert_eq!(response.status, StatusCode::OK);
        let json = response.json();
        assert_eq!(json.get("state").and_then(Value::as_str), Some("pending"));
        assert!(elapsed >= Duration::from_millis(25));
        assert!(elapsed < Duration::from_secs(2));
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
    }

    #[tokio::test]
    async fn cookies_have_frozen_lengths_and_attributes() {
        let fixture = Fixture::new();
        let claim_response = TestResponse::of(
            fixture
                .router
                .handle(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &nonce(5), "Pixel 8"),
                ))
                .await,
        );
        assert_eq!(claim_response.status, StatusCode::ACCEPTED);
        let (claim_secret, claim_attributes) = claim_response.single_cookie(CLAIM_COOKIE);
        assert_eq!(claim_secret.len(), 43);
        assert!(!claim_secret.contains('='));
        assert_eq!(
            claim_attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/api/pair/claim",
                "Max-Age=120",
            ]
        );

        let claim_id = claim_response
            .json()
            .get("claimId")
            .and_then(Value::as_str)
            .expect("claimId")
            .to_owned();
        fixture.service.approve(&claim_id).expect("approval");

        // An approved status read never sets a cookie; only a terminal receipt
        // clears the dead claim cookie, and only the POST pickup issues the
        // session cookie.
        let status_response = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &claim_secret))
                .await,
        );
        assert_eq!(status_response.status, StatusCode::OK);
        assert_eq!(
            status_response.json().get("state").and_then(Value::as_str),
            Some("approved")
        );
        assert!(status_response.set_cookies().is_empty());

        let poll_response = TestResponse::of(
            fixture
                .router
                .handle(consume_request(&claim_id, &claim_secret))
                .await,
        );
        assert_eq!(poll_response.status, StatusCode::OK);
        assert_eq!(poll_response.cookies_named(CLAIM_COOKIE).len(), 1);
        assert_eq!(poll_response.cookies_named(SESSION_COOKIE).len(), 1);

        let (token, session_attributes) = poll_response.single_cookie(SESSION_COOKIE);
        assert!(token.starts_with("moyus_"));
        assert_eq!(token.len(), 49);
        assert!(token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(
            session_attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/",
                "Max-Age=2592000",
            ]
        );

        let (cleared, clear_attributes) = poll_response.single_cookie(CLAIM_COOKIE);
        assert!(cleared.is_empty());
        assert_eq!(
            clear_attributes,
            vec![
                "HttpOnly",
                "Secure",
                "SameSite=Strict",
                "Path=/api/pair/claim",
                "Max-Age=0",
            ]
        );
        assert!(!poll_response.text().contains(&token));
    }

    #[tokio::test]
    async fn rate_limited_claim_is_429_with_retry_after_and_no_cookie() {
        let fixture = Fixture::new();
        let source_ip = Ipv4Addr::new(10, 0, 0, 7);
        for seed in 1..=3u8 {
            let _ = claim_over_http(&fixture, &nonce(seed), Some(source_ip)).await;
        }

        let response = TestResponse::of(
            fixture
                .router
                .handle(TestSourceIp(source_ip).attach(write(
                    CLAIM_ROUTE,
                    claim_body(&fixture, &nonce(4), "Pixel 8"),
                )))
                .await,
        );
        assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.error_code(), "pairing-rate-limited");
        let retry_after = response
            .header("retry-after")
            .expect("retry-after")
            .parse::<u64>()
            .expect("retry-after seconds");
        assert!(retry_after >= 1);
        let retry_after_ms = response
            .json()
            .pointer("/error/retryAfterMs")
            .and_then(Value::as_u64)
            .expect("retryAfterMs");
        assert!(retry_after_ms >= 1);
        assert!(response.set_cookies().is_empty());

        // The default source IP has its own bucket.
        let _ = claim_over_http(&fixture, &nonce(5), None).await;
    }

    #[tokio::test]
    async fn oversized_headers_are_431_header_too_large_with_request_id() {
        let fixture = Fixture::new();
        let mut request = read(HEALTH_PATH);
        request.headers_mut().insert(
            "x-big",
            HeaderValue::from_str(&"a".repeat(9 * 1024)).expect("oversized header"),
        );

        let response = TestResponse::of(fixture.router.handle(request).await);
        assert_error(
            &response,
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "header-too-large",
        );
        assert_eq!(response.header("x-request-id").map(str::len), Some(16));
        assert_eq!(
            response
                .json()
                .pointer("/error/requestId")
                .and_then(Value::as_str),
            response.header("x-request-id")
        );
    }

    #[tokio::test]
    async fn every_pair_response_carries_a_request_id() {
        let fixture = Fixture::new();

        let health = TestResponse::of(fixture.router.handle(read(HEALTH_PATH)).await);
        assert_eq!(health.status, StatusCode::NO_CONTENT);
        assert_eq!(health.header("x-request-id").map(str::len), Some(16));

        let unknown = TestResponse::of(fixture.router.handle(read("/api/nope")).await);
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
        assert_eq!(unknown.header("x-request-id").map(str::len), Some(16));

        let empty_claim = TestResponse::of(
            fixture
                .router
                .handle(write(CLAIM_ROUTE, Bytes::new()))
                .await,
        );
        assert_eq!(empty_claim.status, StatusCode::BAD_REQUEST);
        assert_eq!(empty_claim.error_code(), "invalid-parameter");
        assert_eq!(empty_claim.header("x-request-id").map(str::len), Some(16));
        assert_eq!(
            empty_claim
                .json()
                .pointer("/error/requestId")
                .and_then(Value::as_str),
            empty_claim.header("x-request-id")
        );

        let missing_cookie = TestResponse::of(
            fixture
                .router
                .handle(read(&format!("{CLAIM_POLL_PREFIX}claim_x")))
                .await,
        );
        assert_eq!(missing_cookie.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            missing_cookie.header("x-request-id").map(str::len),
            Some(16)
        );
        assert_eq!(
            missing_cookie
                .json()
                .pointer("/error/requestId")
                .and_then(Value::as_str),
            missing_cookie.header("x-request-id")
        );
    }

    /// The exact eight read-only data route shapes used by the authentication
    /// matrix; every one must fail closed before the provider runs.
    fn eight_data_paths() -> Vec<String> {
        let id = "a".repeat(64);
        vec![
            "/api/books".to_owned(),
            format!("/api/books/{id}"),
            format!("/api/books/{id}/thumb"),
            format!("/api/books/{id}/pages"),
            format!("/api/books/{id}/pages/0"),
            format!("/api/books/{id}/layout"),
            format!("/api/books/{id}/progress"),
            format!("/api/books/{id}/pages/0/tiles/0"),
        ]
    }

    #[tokio::test]
    async fn encoded_absolute_unc_and_uppercase_ids_are_404_without_provider_calls() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let uppercase_path = format!("/api/books/{}", "A".repeat(64));
        let trailing = format!("/api/books/{}/", "a".repeat(64));
        let paths = [
            "/api/books/..",
            "/api/books/%2e%2e%2fetc",
            "/api/books/%252e%252e%252fetc",
            "/api/books/%00",
            "/api/books/C:%5CWindows%5Csystem32",
            "/api/books/%5C%5Cserver%5Cshare",
            uppercase_path.as_str(),
            trailing.as_str(),
        ];

        for path in paths {
            let response = TestResponse::of(fixture.router.handle(data_get(path, None)).await);
            assert_eq!(response.status, StatusCode::NOT_FOUND, "{path}");
        }
        assert_eq!(
            data.calls(),
            0,
            "malformed/absolute/UNC ids must not reach the provider"
        );
    }

    #[tokio::test]
    async fn every_data_route_rejects_malformed_duplicate_and_unissued_tokens() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let valid = issued.token.as_str();

        // 1) malformed length, 2) duplicate pairs in one Cookie header,
        // 3) a well-formed but never-issued token. Each is exercised on all
        // eight routes in the same fixture; only 24 requests, well below the
        // per-IP buckets (120 metadata / 120 image / 600 tile per minute).
        let cases: [(&str, String); 3] = [
            ("malformed", format!("{SESSION_COOKIE}=short")),
            (
                "duplicate-one-header",
                format!("{SESSION_COOKIE}={valid}; {SESSION_COOKIE}={valid}"),
            ),
            (
                "unissued",
                format!("{SESSION_COOKIE}=moyus_{}", "A".repeat(43)),
            ),
        ];

        for path in eight_data_paths() {
            for (label, cookie) in &cases {
                let response =
                    TestResponse::of(fixture.router.handle(raw_cookie(read(&path), cookie)).await);
                assert_eq!(
                    response.status,
                    StatusCode::UNAUTHORIZED,
                    "{label} on {path}"
                );
                assert_error(&response, StatusCode::UNAUTHORIZED, "unauthorized");
                assert_eq!(
                    response.header("x-request-id").map(str::len),
                    Some(16),
                    "{label} on {path} is missing its request id"
                );
                assert!(
                    response.cookies_named(SESSION_COOKIE).is_empty(),
                    "{label} on {path} must not set a session cookie"
                );
            }
        }
        assert_eq!(data.calls(), 0, "no credential case may reach the provider");
    }

    #[tokio::test]
    async fn duplicate_cookie_headers_are_unauthorized_on_data_routes() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let cookie = format!("{SESSION_COOKIE}={}", issued.token.as_str());

        for path in ["/api/books".to_owned(), book_path("/pages/0")] {
            // One Cookie header carrying the same pair twice.
            let single = format!("{cookie}; {cookie}");
            let response = TestResponse::of(
                fixture
                    .router
                    .handle(raw_cookie(read(&path), &single))
                    .await,
            );
            assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{path}");
            assert_error(&response, StatusCode::UNAUTHORIZED, "unauthorized");

            // The same pair split across two Cookie headers.
            let mut two_headers = raw_cookie(read(&path), &cookie);
            two_headers.headers_mut().append(
                COOKIE,
                HeaderValue::from_str(&cookie).expect("cookie header"),
            );
            let response = TestResponse::of(fixture.router.handle(two_headers).await);
            assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{path}");
            assert_error(&response, StatusCode::UNAUTHORIZED, "unauthorized");
            assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        }
        assert_eq!(
            data.calls(),
            0,
            "duplicate cookies must not reach the provider"
        );
    }

    #[tokio::test]
    async fn expired_session_is_unauthorized_on_every_data_route_before_any_304() {
        // A dedicated fixture: advancing the shared fake clock past the
        // 30-day sliding lifetime must not disturb the other credential cases.
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();
        fixture
            .clock
            .advance(Duration::from_secs(31 * 24 * 60 * 60));

        for path in eight_data_paths() {
            let response =
                TestResponse::of(fixture.router.handle(data_get(&path, Some(token))).await);
            assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{path}");
            assert_error(&response, StatusCode::UNAUTHORIZED, "unauthorized");
            assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        }

        // Authentication precedes the ETag/304 path: even a wildcard validator
        // must not turn an expired session into a 304.
        let mut conditional = data_get("/api/books", Some(token));
        conditional
            .headers_mut()
            .insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        let response = TestResponse::of(fixture.router.handle(conditional).await);
        assert_error(&response, StatusCode::UNAUTHORIZED, "unauthorized");
        assert_eq!(
            data.calls(),
            0,
            "an expired session must not reach the provider"
        );
    }

    #[tokio::test]
    async fn page_range_header_is_ignored_and_the_full_image_is_served() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();

        let mut request = data_get(&book_path("/pages/0"), Some(issued.token.as_str()));
        request
            .headers_mut()
            .insert(RANGE, HeaderValue::from_static("bytes=0-1"));
        let response = TestResponse::of(fixture.router.handle(request).await);

        // D2 never answers byte ranges: reads are whole-image only.
        assert_eq!(response.status, StatusCode::OK);
        assert_ne!(response.status, StatusCode::PARTIAL_CONTENT);
        assert!(response.header("content-range").is_none());
        assert_eq!(response.header("content-type"), Some("image/jpeg"));
        assert_eq!(response.header("x-request-id").map(str::len), Some(16));
        assert!(response.body.starts_with(&[0xFF, 0xD8]));
        assert_eq!(data.page_calls(), vec![(0, 1080)]);
    }

    #[tokio::test]
    async fn books_json_conditional_get_returns_304_without_refreshing() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();
        let token = issued.token.as_str();

        let first = TestResponse::of(
            fixture
                .router
                .handle(data_get("/api/books", Some(token)))
                .await,
        );
        assert_eq!(first.status, StatusCode::OK);
        let etag = first.header("etag").expect("etag").to_owned();
        assert!(etag.starts_with("\"j-"), "{etag}");
        assert_eq!(data.calls(), 1);

        let mut conditional = data_get("/api/books", Some(token));
        conditional
            .headers_mut()
            .insert(IF_NONE_MATCH, HeaderValue::from_str(&etag).expect("etag"));
        // Past the 60-minute refresh throttle: a metadata 304 still must not
        // refresh the session, because only page/tile reads are eligible.
        fixture.clock.advance(Duration::from_secs(61 * 60));
        let second = TestResponse::of(fixture.router.handle(conditional).await);

        assert_eq!(second.status, StatusCode::NOT_MODIFIED);
        assert!(second.body.is_empty());
        assert_eq!(second.header("etag"), Some(etag.as_str()));
        assert_eq!(second.header("vary"), Some("Cookie"));
        assert_eq!(second.header("cache-control"), Some("private, no-cache"));
        assert!(second.header("content-type").is_none());
        assert!(
            second.cookies_named(SESSION_COOKIE).is_empty(),
            "a metadata 304 must not refresh the session cookie"
        );
        // JSON metadata has no L2 cache probe, so the provider still runs.
        assert_eq!(data.calls(), 2);
    }

    #[tokio::test]
    async fn layout_reads_are_private_and_cacheable_for_five_minutes() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();

        let response = TestResponse::of(
            fixture
                .router
                .handle(data_get(&book_path("/layout"), Some(issued.token.as_str())))
                .await,
        );
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.header("cache-control"),
            Some("private, max-age=300")
        );
        assert_eq!(response.header("vary"), Some("Cookie"));
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(response.header("x-request-id").map(str::len), Some(16));
        assert_eq!(
            response
                .json()
                .pointer("/pages/0/width")
                .and_then(Value::as_u64),
            Some(800)
        );
        assert_eq!(data.calls(), 1);
    }

    #[tokio::test]
    async fn oversized_headers_on_a_data_route_are_431_before_the_provider() {
        let data = Arc::new(FakeData::default());
        let fixture = Fixture::with_data(data.clone());
        let issued = fixture.issue_session();

        let mut request = data_get("/api/books", Some(issued.token.as_str()));
        request.headers_mut().insert(
            "x-big",
            HeaderValue::from_str(&"a".repeat(9 * 1024)).expect("oversized header"),
        );
        let response = TestResponse::of(fixture.router.handle(request).await);

        assert_error(
            &response,
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "header-too-large",
        );
        assert_eq!(response.header("x-request-id").map(str::len), Some(16));
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        assert_eq!(
            data.calls(),
            0,
            "an oversized header block must be rejected before the provider runs"
        );
    }
    #[tokio::test]
    async fn session_management_authenticates_and_revokes_only_the_caller() {
        let fixture = Fixture::new();
        let first = fixture.issue_session();
        let second = fixture.issue_session();
        let cookie = format!("{SESSION_COOKIE}={}", first.token.as_str());
        let unauthorized = TestResponse::of(fixture.router.handle(read("/api/session")).await);
        assert_error(&unauthorized, StatusCode::UNAUTHORIZED, "unauthorized");
        let before = fixture
            .service
            .authenticate(first.token.as_str())
            .unwrap()
            .expires_at;
        let response = TestResponse::of(
            fixture
                .router
                .handle(raw_cookie(read("/api/session"), &cookie))
                .await,
        );
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.header("cache-control"), Some("no-store"));
        assert_eq!(response.json()["deviceId"], first.id);
        assert_eq!(response.json()["deviceName"], "Pixel 8");
        assert!(response.json()["createdAt"].as_str().is_some());
        assert!(response.json()["lastSeenAt"].as_str().is_some());
        assert!(!response.text().contains(first.token.as_str()));
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        assert_eq!(
            fixture
                .service
                .authenticate(first.token.as_str())
                .unwrap()
                .expires_at,
            before
        );
        let mut invalid = raw_cookie(
            request(Method::DELETE, "/api/session", Bytes::new()),
            &cookie,
        );
        invalid.headers_mut().remove("origin");
        let blocked = TestResponse::of(fixture.router.handle(invalid).await);
        assert_eq!(blocked.status, StatusCode::FORBIDDEN);
        assert!(fixture.service.authenticate(first.token.as_str()).is_some());
        let delete = raw_cookie(
            request(Method::DELETE, "/api/session", Bytes::new()),
            &cookie,
        );
        let deleted = TestResponse::of(fixture.router.handle(delete).await);
        assert_eq!(deleted.status, StatusCode::NO_CONTENT);
        let (_, attrs) = deleted.single_cookie(SESSION_COOKIE);
        assert!(attrs.iter().any(|s| s.eq_ignore_ascii_case("Max-Age=0")));
        assert!(fixture.service.authenticate(first.token.as_str()).is_none());
        assert!(fixture
            .service
            .authenticate(second.token.as_str())
            .is_some());
        let after = TestResponse::of(
            fixture
                .router
                .handle(raw_cookie(read("/api/session"), &cookie))
                .await,
        );
        assert_error(&after, StatusCode::UNAUTHORIZED, "unauthorized");
    }
    #[tokio::test]
    async fn browser_assets_are_same_origin_guarded_and_restrictive() {
        let fixture = Fixture::new();
        for path in [
            "/",
            "/reader.js",
            "/reader.css",
            "/reader-theme.css",
            "/reader-messages.js",
        ] {
            let response = TestResponse::of(fixture.router.handle(read(path)).await);
            assert_eq!(response.status, StatusCode::OK);
            assert_eq!(response.header("cache-control"), Some("no-store"));
            assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
            assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
            assert!(response
                .header("content-security-policy")
                .unwrap()
                .contains("default-src 'none'"));
            assert!(response
                .header("content-security-policy")
                .unwrap()
                .contains("frame-ancestors 'none'"));
            assert!(response.set_cookies().is_empty());
            if path == "/reader-theme.css" {
                assert!(response.text().contains("--sh-background: #eff8ff;"));
                assert!(response.text().contains("--sh-background: #0b111e;"));
                assert!(!response.text().contains("--mi-"));
                assert!(!response.text().contains("--v3-"));
            }
            let mut untrusted = read(path);
            untrusted
                .headers_mut()
                .insert("host", HeaderValue::from_static("attacker.invalid"));
            let denied = TestResponse::of(fixture.router.handle(untrusted).await);
            assert_eq!(denied.status, StatusCode::MISDIRECTED_REQUEST);
        }
        let response = TestResponse::of(fixture.router.handle(write("/", Bytes::new())).await);
        assert_eq!(response.status, StatusCode::NOT_FOUND);
    }
}
