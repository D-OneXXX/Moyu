//! D4 PDF byte-stream route for the LAN Web Reader.
//!
//! `GET|HEAD /api/books/{id}/pdf` serves a local PDF through bounded HTTP byte
//! ranges. The desktop backend still does not parse or render PDF; it only
//! validates the book/source and performs seek-based file reads inside
//! `spawn_blocking`. The front-end PDF.js runtime consumes the same protocol
//! through `PDFDataRangeTransport`.
//!
//! Response contract:
//! - `HEAD` → 200 with `Content-Length`, `Accept-Ranges: bytes`, `ETag`;
//! - `GET` + one `Range: bytes=start-end` → 206, body ≤ 4 MiB per response;
//! - missing range on a file ≤ 4 MiB → 200; larger files require a range and
//!   answer 416 `range-not-satisfiable`;
//! - every response is `Cache-Control: private, no-store`;
//! - unauthenticated requests are 401 before any provider (filesystem) work.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::Full;
use hyper::body::{Body, Bytes};
use hyper::header::{
    HeaderMap, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG,
    RANGE, VARY,
};
use hyper::{Method, Request, Response, StatusCode};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::auth::PairingService;
use super::data::{data_error_response, error_response, parse_book_id, DataError};
use super::http::{RequestGuard, DATA_HANDLER_TIMEOUT, X_REQUEST_ID};
use super::secret::random_hex;
use super::session_auth::{apply_refresh_cookie, authenticate_request};
use crate::pdf::MAX_PDF_CHUNK_BYTES;

/// Hard per-response byte bound. The value is the same 4 MiB the desktop
/// `get_pdf_chunk` command enforces, so a single protocol constant rules both
/// transports.
pub(crate) const MAX_PDF_RANGE_BYTES: u32 = MAX_PDF_CHUNK_BYTES;

const X_CONTENT_TYPE_OPTIONS: &str = "x-content-type-options";
const PDF_CONTENT_TYPE: &str = "application/pdf";
const PRIVATE_NO_STORE: &str = "private, no-store";

const RATE_WINDOW: Duration = Duration::from_secs(60);
/// PDF.js asks for one 256 KiB range per chunk and may prefetch neighbours.
/// Ten reads per second per peer keeps rapid page turns well inside budget
/// while still bounding a tight retry loop.
const PDF_RANGE_PER_WINDOW: u32 = 600;
const MAX_RATE_BUCKETS: usize = 1024;
const READ_GATE: usize = 4;
const READ_WAIT: Duration = Duration::from_secs(5);

/// Stable file identity returned by [`WebPdfAccess::open`]. The path never
/// leaves the provider boundary and `Debug` never prints it.
pub(crate) struct PdfSource {
    pub(crate) meta: PdfMeta,
    path: PathBuf,
}

impl PdfSource {
    pub(crate) fn new(meta: PdfMeta, path: PathBuf) -> Self {
        Self { meta, path }
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl std::fmt::Debug for PdfSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PdfSource")
            .field("total", &self.meta.total)
            .field("etag", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PdfMeta {
    pub total: u64,
    pub etag: String,
}

/// Synchronous provider boundary. Both methods run in `spawn_blocking`; they
/// must not depend on a Tokio handle and must never render or cache PDF bytes.
pub(crate) trait WebPdfAccess: Send + Sync {
    fn open(&self, id: &str) -> Result<PdfSource, DataError>;
    fn read(&self, source: &PdfSource, start: u64, length: u32) -> Result<Vec<u8>, DataError>;
}

pub(crate) struct PdfHttp {
    guard: RequestGuard,
    service: Arc<PairingService>,
    pdf: Arc<dyn WebPdfAccess>,
    limiter: PdfLimiter,
    read_gate: Arc<Semaphore>,
}

impl PdfHttp {
    pub(crate) fn new(
        guard: RequestGuard,
        service: Arc<PairingService>,
        pdf: Arc<dyn WebPdfAccess>,
    ) -> Self {
        Self {
            guard,
            service,
            pdf,
            limiter: PdfLimiter::new(RATE_WINDOW),
            read_gate: Arc::new(Semaphore::new(READ_GATE)),
        }
    }

    /// Handle one request. `None` means "not the PDF route"; the production
    /// router then keeps its frozen 404/other-plane behaviour.
    pub(crate) async fn handle<B>(
        &self,
        request: &Request<B>,
        source_ip: Ipv4Addr,
    ) -> Option<Response<Full<Bytes>>>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return None;
        }
        let id = parse_pdf_route(request.method(), request.uri().path())?;
        // The production router already ran the same authority guard. Repeat it
        // here so the route cannot become weaker if it is ever mounted alone.
        if let Err(status) = self.guard.check(request) {
            return Some(guard_error_response(status));
        }
        let request_id = random_hex(8);

        // Rate limiting happens before authentication so an unauthenticated
        // flood never reaches the provider boundary.
        if let Err(retry_after) = self.limiter.check(source_ip, Instant::now()) {
            return Some(rate_limited_response(&request_id, retry_after));
        }
        let session = match authenticate_request(request, &self.service) {
            Ok(session) => session,
            Err(_) => return Some(unauthorized_response(&request_id)),
        };
        // Query validation is after authentication so an anonymous caller
        // cannot probe parameter behaviour and always sees 401 first.
        if request.uri().query().is_some() {
            return Some(invalid_parameter_response(&request_id));
        }

        let pdf = Arc::clone(&self.pdf);
        let open_id = id.clone();
        let opened = tokio::time::timeout(
            DATA_HANDLER_TIMEOUT,
            tokio::task::spawn_blocking(move || pdf.open(&open_id)),
        )
        .await;
        let source = match opened {
            Err(_) => return Some(data_error_response(DataError::Timeout, &request_id)),
            Ok(Err(_)) => return Some(data_error_response(DataError::Internal, &request_id)),
            Ok(Ok(Err(error))) => return Some(data_error_response(error, &request_id)),
            Ok(Ok(Ok(source))) => source,
        };

        if request.method() == Method::HEAD {
            let mut response = full_response(&source.meta, &request_id);
            // HEAD carries the full representation length but no body.
            response
                .headers_mut()
                .insert(CONTENT_LENGTH, header_value(source.meta.total));
            return Some(response);
        }

        let meta = source.meta.clone();
        let range = match parse_range_header(request.headers()) {
            RangeHeader::Missing => None,
            RangeHeader::Invalid => {
                return Some(unsatisfiable_response(source.meta.total, &request_id))
            }
            RangeHeader::Spec(spec) => Some(spec),
        };
        let Some((start, end)) = resolve_range(range, meta.total) else {
            return Some(unsatisfiable_response(meta.total, &request_id));
        };
        let length = end - start + 1;
        let permit: OwnedSemaphorePermit = match tokio::time::timeout(
            READ_WAIT,
            Arc::clone(&self.read_gate).acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            _ => return Some(busy_response(&request_id)),
        };

        let pdf = Arc::clone(&self.pdf);
        let read = tokio::time::timeout(
            DATA_HANDLER_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                pdf.read(&source, start, length as u32)
            }),
        )
        .await;
        let bytes = match read {
            Err(_) => return Some(data_error_response(DataError::Timeout, &request_id)),
            Ok(Err(_)) => return Some(data_error_response(DataError::Internal, &request_id)),
            Ok(Ok(Err(error))) => return Some(data_error_response(error, &request_id)),
            Ok(Ok(Ok(bytes))) => bytes,
        };
        if bytes.len() as u64 != length {
            // A file that changed between open and read must fail closed; the
            // client retries with a fresh HEAD/ETag.
            return Some(data_error_response(DataError::Internal, &request_id));
        }

        let partial = start != 0 || end + 1 != meta.total;
        let mut response =
            range_response(&meta, start, end, partial, Bytes::from(bytes), &request_id);
        apply_refresh_cookie(
            &self.service,
            &session,
            "GET",
            request.uri().path(),
            false,
            &mut response,
        );
        Some(response)
    }
}

fn parse_pdf_route(method: &Method, path: &str) -> Option<String> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let rest = path.strip_prefix("/api/books/")?;
    let (id, suffix) = rest.split_once('/')?;
    if suffix != "pdf" {
        return None;
    }
    parse_book_id(id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeSpec {
    FromTo { start: u64, end: Option<u64> },
    Suffix(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeHeader {
    Missing,
    Invalid,
    Spec(RangeSpec),
}

/// Exactly one `bytes=` range. Multiple ranges, other units, empty specs and
/// malformed integers are rejected; the caller answers a stable 416.
fn parse_range_header(headers: &HeaderMap) -> RangeHeader {
    let mut values = headers.get_all(RANGE).iter();
    let Some(value) = values.next() else {
        return RangeHeader::Missing;
    };
    if values.next().is_some() {
        return RangeHeader::Invalid;
    }
    let Ok(text) = value.to_str() else {
        return RangeHeader::Invalid;
    };
    let text = text.trim();
    let Some((unit, rest)) = text.split_once('=') else {
        return RangeHeader::Invalid;
    };
    if !unit.eq_ignore_ascii_case("bytes") {
        return RangeHeader::Invalid;
    }
    let mut specs = rest.split(',');
    let Some(spec) = specs.next() else {
        return RangeHeader::Invalid;
    };
    if specs.next().is_some() {
        return RangeHeader::Invalid;
    }
    let spec = spec.trim();
    let Some((start, end)) = spec.split_once('-') else {
        return RangeHeader::Invalid;
    };
    let start = start.trim();
    let end = end.trim();
    if start.is_empty() {
        let Some(suffix) = parse_u64(end) else {
            return RangeHeader::Invalid;
        };
        if suffix == 0 {
            return RangeHeader::Invalid;
        }
        return RangeHeader::Spec(RangeSpec::Suffix(suffix));
    }
    let Some(start) = parse_u64(start) else {
        return RangeHeader::Invalid;
    };
    let end = if end.is_empty() {
        None
    } else {
        match parse_u64(end) {
            Some(end) => Some(end),
            None => return RangeHeader::Invalid,
        }
    };
    RangeHeader::Spec(RangeSpec::FromTo { start, end })
}

fn parse_u64(raw: &str) -> Option<u64> {
    if raw.is_empty() || raw.len() > 20 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// Resolve a syntactic range against the file length and clamp the span to
/// [`MAX_PDF_RANGE_BYTES`]. `None` means 416.
fn resolve_range(range: Option<RangeSpec>, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let (start, end) = match range {
        None => {
            if total > u64::from(MAX_PDF_RANGE_BYTES) {
                return None;
            }
            (0, total - 1)
        }
        Some(RangeSpec::FromTo { start, end }) => {
            if start >= total {
                return None;
            }
            let end = end.unwrap_or(total - 1).min(total - 1);
            if start > end {
                return None;
            }
            (start, end)
        }
        Some(RangeSpec::Suffix(length)) => (total.saturating_sub(length), total - 1),
    };
    let max_end = start.saturating_add(u64::from(MAX_PDF_RANGE_BYTES).saturating_sub(1));
    Some((start, end.min(max_end)))
}

fn full_response(meta: &PdfMeta, request_id: &str) -> Response<Full<Bytes>> {
    base_response(meta)
        .header(CONTENT_LENGTH, meta.total.to_string())
        .header(X_REQUEST_ID, request_id)
        .body(Full::new(Bytes::new()))
        .expect("static PDF response")
}

fn range_response(
    meta: &PdfMeta,
    start: u64,
    end: u64,
    partial: bool,
    bytes: Bytes,
    request_id: &str,
) -> Response<Full<Bytes>> {
    let length = bytes.len() as u64;
    let response = base_response(meta).header(CONTENT_LENGTH, length.to_string());
    let response = if partial {
        response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(CONTENT_RANGE, format!("bytes {start}-{end}/{}", meta.total))
    } else {
        response.status(StatusCode::OK)
    };
    response
        .header(X_REQUEST_ID, request_id)
        .body(Full::new(bytes))
        .expect("static PDF response")
}

fn base_response(meta: &PdfMeta) -> hyper::http::response::Builder {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, PDF_CONTENT_TYPE)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, PRIVATE_NO_STORE)
        .header(ETAG, meta.etag.as_str())
        .header(VARY, "Cookie")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
}

fn unsatisfiable_response(total: u64, request_id: &str) -> Response<Full<Bytes>> {
    let mut response = error_response(
        StatusCode::RANGE_NOT_SATISFIABLE,
        "range-not-satisfiable",
        request_id,
        None,
        None,
        false,
    );
    response
        .headers_mut()
        .insert(CONTENT_RANGE, header_value(format!("bytes */{total}")));
    response
}

fn guard_error_response(status: StatusCode) -> Response<Full<Bytes>> {
    let code = if status == StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE {
        "header-too-large"
    } else {
        "forbidden"
    };
    error_response(status, code, &random_hex(8), None, None, false)
}

fn invalid_parameter_response(request_id: &str) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::BAD_REQUEST,
        "invalid-parameter",
        request_id,
        None,
        None,
        false,
    )
}

fn unauthorized_response(request_id: &str) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        request_id,
        None,
        None,
        false,
    )
}

fn busy_response(request_id: &str) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "busy",
        request_id,
        None,
        Some(Duration::from_secs(1)),
        false,
    )
}

fn rate_limited_response(request_id: &str, retry_after: Duration) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::TOO_MANY_REQUESTS,
        "pairing-rate-limited",
        request_id,
        None,
        Some(retry_after),
        true,
    )
}

fn header_value(value: impl ToString) -> hyper::header::HeaderValue {
    hyper::header::HeaderValue::from_str(&value.to_string()).expect("valid header value")
}

struct PdfBucket {
    started: Instant,
    count: u32,
}

struct PdfLimiter {
    buckets: Mutex<HashMap<Ipv4Addr, PdfBucket>>,
    window: Duration,
}

impl PdfLimiter {
    fn new(window: Duration) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            window,
        }
    }

    fn check(&self, ip: Ipv4Addr, now: Instant) -> Result<(), Duration> {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !buckets.contains_key(&ip) && buckets.len() >= MAX_RATE_BUCKETS {
            buckets.retain(|_, bucket| now.saturating_duration_since(bucket.started) < self.window);
            if buckets.len() >= MAX_RATE_BUCKETS {
                return Err(self.window);
            }
        }
        let bucket = buckets.entry(ip).or_insert_with(|| PdfBucket {
            started: now,
            count: 0,
        });
        if now.saturating_duration_since(bucket.started) >= self.window {
            bucket.started = now;
            bucket.count = 0;
        }
        if bucket.count >= PDF_RANGE_PER_WINDOW {
            let elapsed = now.saturating_duration_since(bucket.started);
            return Err(self
                .window
                .saturating_sub(elapsed)
                .max(Duration::from_millis(1)));
        }
        bucket.count += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use http_body_util::BodyExt;
    use hyper::header::{COOKIE, SET_COOKIE};

    use super::*;
    use crate::web_access::auth::PairingService;
    use crate::web_access::clock::test_support::FakeClock;
    use crate::web_access::http::{AllowedAuthority, RequestGuard};
    use crate::web_access::pairing::PairingStore;
    use crate::web_access::session::SessionStore;

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HOST_VALUE: &str = "192.168.1.10:8443";
    const SOURCE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 20);

    struct FakePdf {
        total: u64,
        open_error: Option<DataError>,
        open_calls: AtomicUsize,
        read_calls: AtomicUsize,
    }

    impl FakePdf {
        fn new(total: u64) -> Self {
            Self {
                total,
                open_error: None,
                open_calls: AtomicUsize::new(0),
                read_calls: AtomicUsize::new(0),
            }
        }

        fn failing(error: DataError) -> Self {
            Self {
                total: 0,
                open_error: Some(error),
                open_calls: AtomicUsize::new(0),
                read_calls: AtomicUsize::new(0),
            }
        }
    }

    impl WebPdfAccess for FakePdf {
        fn open(&self, _id: &str) -> Result<PdfSource, DataError> {
            self.open_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = self.open_error {
                return Err(error);
            }
            Ok(PdfSource::new(
                PdfMeta {
                    total: self.total,
                    etag: "\"pdf-test\"".to_owned(),
                },
                PathBuf::new(),
            ))
        }

        fn read(&self, _source: &PdfSource, start: u64, length: u32) -> Result<Vec<u8>, DataError> {
            self.read_calls.fetch_add(1, Ordering::SeqCst);
            Ok((0..length)
                .map(|index| ((start + u64::from(index)) % 251) as u8)
                .collect())
        }
    }

    struct Fixture {
        http: PdfHttp,
        pdf: Arc<FakePdf>,
        clock: Arc<FakeClock>,
        token: String,
    }

    fn fixture(pdf: FakePdf) -> Fixture {
        let clock = FakeClock::shared();
        let service = Arc::new(PairingService::new(
            PairingStore::new(clock.clone()),
            SessionStore::new(clock.clone()),
        ));
        let issued = service.issue_session_for_test("Pixel 8");
        let guard = RequestGuard::for_authority(
            AllowedAuthority::for_test(SocketAddr::from(([192, 168, 1, 10], 8443)))
                .expect("IPv4 authority"),
        );
        let pdf = Arc::new(pdf);
        Fixture {
            http: PdfHttp::new(guard, service, pdf.clone()),
            pdf,
            clock,
            token: issued.token.as_str().to_owned(),
        }
    }

    fn request(method: Method, path: &str) -> Request<Full<Bytes>> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", HOST_VALUE)
            .body(Full::new(Bytes::new()))
            .expect("request")
    }

    fn authed(mut request: Request<Full<Bytes>>, token: &str) -> Request<Full<Bytes>> {
        request.headers_mut().insert(
            COOKIE,
            hyper::header::HeaderValue::from_str(&format!("moyus_session={token}"))
                .expect("cookie"),
        );
        request
    }

    async fn response(
        fixture: &Fixture,
        method: Method,
        range: Option<&str>,
    ) -> (StatusCode, hyper::HeaderMap, Bytes) {
        let path = format!("/api/books/{ID}/pdf");
        let mut request = authed(request(method, &path), &fixture.token);
        if let Some(range) = range {
            request.headers_mut().insert(
                RANGE,
                hyper::header::HeaderValue::from_str(range).expect("range"),
            );
        }
        let response = fixture
            .http
            .handle(&request, SOURCE_IP)
            .await
            .expect("PDF route");
        let (parts, body) = response.into_parts();
        let body = body.collect().await.expect("body").to_bytes();
        (parts.status, parts.headers, body)
    }

    #[test]
    fn pdf_route_shape_is_exact_and_head_is_allowed() {
        let path = format!("/api/books/{ID}/pdf");
        assert_eq!(parse_pdf_route(&Method::GET, &path).as_deref(), Some(ID));
        assert_eq!(parse_pdf_route(&Method::HEAD, &path).as_deref(), Some(ID));
        assert!(parse_pdf_route(&Method::POST, &path).is_none());
        assert!(parse_pdf_route(&Method::PUT, &path).is_none());
        assert!(parse_pdf_route(&Method::GET, &format!("{path}/0")).is_none());
        assert!(parse_pdf_route(&Method::GET, &format!("{path}/")).is_none());
        assert!(parse_pdf_route(&Method::GET, "/api/books/not-hex/pdf").is_none());
        assert!(
            parse_pdf_route(&Method::GET, &format!("/api/books/{}/pdf", "A".repeat(64))).is_none()
        );
    }

    #[test]
    fn range_parser_accepts_one_range_and_resolves_bounds() {
        let mut headers = hyper::HeaderMap::new();
        assert_eq!(parse_range_header(&headers), RangeHeader::Missing);
        for (raw, expected) in [
            (
                "bytes=0-9",
                RangeHeader::Spec(RangeSpec::FromTo {
                    start: 0,
                    end: Some(9),
                }),
            ),
            (
                "bytes=5-",
                RangeHeader::Spec(RangeSpec::FromTo {
                    start: 5,
                    end: None,
                }),
            ),
            ("BYTES=-100", RangeHeader::Spec(RangeSpec::Suffix(100))),
        ] {
            headers.insert(
                RANGE,
                hyper::header::HeaderValue::from_str(raw).expect("range"),
            );
            assert_eq!(parse_range_header(&headers), expected, "{raw}");
        }
        for raw in [
            "bytes=0-1,2-3",
            "bytes=0-1,",
            "bytes=",
            "bytes=-0",
            "items=0-1",
            "bytes=abc-def",
            "bytes=1-0",
        ] {
            headers.insert(
                RANGE,
                hyper::header::HeaderValue::from_str(raw).expect("range"),
            );
            let expected = if raw == "bytes=1-0" {
                RangeHeader::Spec(RangeSpec::FromTo {
                    start: 1,
                    end: Some(0),
                })
            } else {
                RangeHeader::Invalid
            };
            assert_eq!(parse_range_header(&headers), expected, "{raw}");
        }
        headers.insert(
            RANGE,
            hyper::header::HeaderValue::from_str("bytes=0-1").expect("range"),
        );
        headers.append(
            RANGE,
            hyper::header::HeaderValue::from_str("bytes=2-3").expect("range"),
        );
        assert_eq!(parse_range_header(&headers), RangeHeader::Invalid);

        assert_eq!(
            resolve_range(
                Some(RangeSpec::FromTo {
                    start: 0,
                    end: Some(9)
                }),
                10
            ),
            Some((0, 9))
        );
        assert_eq!(
            resolve_range(Some(RangeSpec::Suffix(100)), 10),
            Some((0, 9))
        );
        assert_eq!(
            resolve_range(
                Some(RangeSpec::FromTo {
                    start: 10,
                    end: None
                }),
                10
            ),
            None
        );
        assert_eq!(resolve_range(None, 10), Some((0, 9)));
        let large = u64::from(MAX_PDF_RANGE_BYTES) + 1024;
        assert_eq!(resolve_range(None, large), None);
        assert_eq!(
            resolve_range(
                Some(RangeSpec::FromTo {
                    start: 0,
                    end: None
                }),
                large
            ),
            Some((0, u64::from(MAX_PDF_RANGE_BYTES) - 1))
        );
    }

    #[tokio::test]
    async fn unauthenticated_request_never_reaches_the_provider() {
        let fixture = fixture(FakePdf::new(1024));
        let path = format!("/api/books/{ID}/pdf");
        let response = fixture
            .http
            .handle(&request(Method::GET, &path), SOURCE_IP)
            .await
            .expect("PDF route");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(fixture.pdf.open_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.pdf.read_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn query_is_rejected_only_after_authentication() {
        let fixture = fixture(FakePdf::new(1024));
        let path = format!("/api/books/{ID}/pdf?x=1");
        let anonymous = fixture
            .http
            .handle(&request(Method::GET, &path), SOURCE_IP)
            .await
            .expect("PDF route");
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let authenticated = fixture
            .http
            .handle(
                &authed(request(Method::GET, &path), &fixture.token),
                SOURCE_IP,
            )
            .await
            .expect("PDF route");
        assert_eq!(authenticated.status(), StatusCode::BAD_REQUEST);
        assert_eq!(fixture.pdf.open_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn head_returns_length_and_etag_without_reading_bytes() {
        let fixture = fixture(FakePdf::new(1024));
        let (status, headers, body) = response(&fixture, Method::HEAD, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.len(), 0);
        assert_eq!(headers[CONTENT_LENGTH], "1024");
        assert_eq!(headers[CONTENT_TYPE], "application/pdf");
        assert_eq!(headers[ACCEPT_RANGES], "bytes");
        assert_eq!(headers[ETAG], "\"pdf-test\"");
        assert_eq!(headers[CACHE_CONTROL], "private, no-store");
        assert_eq!(fixture.pdf.read_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn single_range_is_206_and_clamped_to_four_mib() {
        let total = u64::from(MAX_PDF_RANGE_BYTES) + 1024;
        let fixture = fixture(FakePdf::new(total));
        let (status, headers, body) = response(&fixture, Method::GET, Some("bytes=0-")).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(body.len(), MAX_PDF_RANGE_BYTES as usize);
        assert_eq!(
            headers[CONTENT_RANGE],
            format!("bytes 0-{}/{total}", MAX_PDF_RANGE_BYTES - 1)
        );
        assert_eq!(headers[CONTENT_LENGTH], MAX_PDF_RANGE_BYTES.to_string());
        assert_eq!(&body[..4], &[0, 1, 2, 3]);

        let (status, headers, body) = response(&fixture, Method::GET, Some("bytes=100-199")).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(body.len(), 100);
        assert_eq!(headers[CONTENT_RANGE], format!("bytes 100-199/{total}"));
        assert_eq!(body[0], 100);
    }

    #[tokio::test]
    async fn oversized_or_illegal_ranges_are_416_with_total_length() {
        let total = u64::from(MAX_PDF_RANGE_BYTES) + 1024;
        let fixture = fixture(FakePdf::new(total));
        for range in [None, Some("bytes=999999999-"), Some("bytes=0-1,2-3")] {
            let (status, headers, body) = response(&fixture, Method::GET, range).await;
            assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE, "{range:?}");
            assert_eq!(headers[CONTENT_RANGE], format!("bytes */{total}"));
            let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
            assert_eq!(payload["error"]["code"], "range-not-satisfiable");
        }
        assert_eq!(fixture.pdf.read_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn small_file_without_range_is_a_full_200() {
        let fixture = fixture(FakePdf::new(32));
        let (status, headers, body) = response(&fixture, Method::GET, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.len(), 32);
        assert_eq!(headers[CONTENT_LENGTH], "32");
        assert!(!headers.contains_key(CONTENT_RANGE));
    }

    #[tokio::test]
    async fn provider_errors_keep_the_frozen_codes() {
        for (error, status, code) in [
            (DataError::PdfUnsupported, 415, "pdf-source-unsupported"),
            (DataError::NotFound, 404, "book-not-found"),
        ] {
            let fixture = fixture(FakePdf::failing(error));
            let (status_code, _, body) = response(&fixture, Method::GET, Some("bytes=0-1")).await;
            assert_eq!(status_code, StatusCode::from_u16(status).expect("status"));
            let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
            assert_eq!(payload["error"]["code"], code);
        }
    }

    #[tokio::test]
    async fn successful_range_read_refreshes_the_session_after_the_hourly_throttle() {
        let fixture = fixture(FakePdf::new(1024));
        let first = fixture
            .http
            .handle(
                &authed(
                    {
                        let mut request = request(Method::GET, &format!("/api/books/{ID}/pdf"));
                        request
                            .headers_mut()
                            .insert(RANGE, hyper::header::HeaderValue::from_static("bytes=0-3"));
                        request
                    },
                    &fixture.token,
                ),
                SOURCE_IP,
            )
            .await
            .expect("PDF route");
        assert_eq!(first.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            first.headers().get_all(SET_COOKIE).iter().count(),
            0,
            "a freshly issued session must stay inside the 60-minute throttle"
        );

        fixture.clock.advance(Duration::from_secs(61 * 60));
        let second = fixture
            .http
            .handle(
                &authed(
                    {
                        let mut request = request(Method::GET, &format!("/api/books/{ID}/pdf"));
                        request
                            .headers_mut()
                            .insert(RANGE, hyper::header::HeaderValue::from_static("bytes=0-3"));
                        request
                    },
                    &fixture.token,
                ),
                SOURCE_IP,
            )
            .await
            .expect("PDF route");
        assert_eq!(second.status(), StatusCode::PARTIAL_CONTENT);
        let cookies = second
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>();
        assert!(
            cookies
                .iter()
                .any(|cookie| cookie.starts_with("moyus_session=")),
            "{cookies:?}"
        );
    }

    #[tokio::test]
    async fn pdf_limiter_is_per_ip_and_resets_per_window() {
        let limiter = PdfLimiter::new(RATE_WINDOW);
        let start = Instant::now();
        let ip = Ipv4Addr::new(192, 168, 1, 30);
        for _ in 0..PDF_RANGE_PER_WINDOW {
            assert!(limiter.check(ip, start).is_ok());
        }
        let retry = limiter.check(ip, start).expect_err("bucket full");
        assert!(retry > Duration::ZERO && retry <= RATE_WINDOW);
        assert!(limiter.check(Ipv4Addr::new(192, 168, 1, 31), start).is_ok());
        assert!(limiter.check(ip, start + RATE_WINDOW).is_ok());
    }
}
