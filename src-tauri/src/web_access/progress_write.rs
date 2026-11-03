//! D3 progress-write provider boundary and HTTP handler.
//!
//! The read plane has [`super::data::WebDataAccess`]; the write plane gets a
//! deliberately separate trait and handler so a read-only adapter can never
//! accidentally gain a write method, and the D2 `DataRoute` allowlist stays
//! exactly eight GET shapes.
//!
//! The handler is mounted by the runtime in a later task. Until then it is
//! exercised only through isolated tests; no production listener is started.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::Full;
use hyper::body::{Body, Bytes};
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, VARY};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::auth::PairingService;
use super::data::{data_error_response, error_response, parse_book_id};
use super::http::{RequestGuard, X_REQUEST_ID};
use super::router::{read_limited_body, BodyReadError};
use super::secret::random_hex;
use super::session_auth::{apply_refresh_cookie, authenticate_request};
use crate::db::ProgressOutcome;
use crate::read_service::{iso_local, DataError};
use crate::web_contract::{
    next_action, progress_response, NextAction, ProgressBody, ProgressStatus,
};

/// Hard cap on one progress request body. The reader counts actual bytes; the
/// `Content-Length` header is never trusted for acceptance.
pub(crate) const MAX_PROGRESS_BODY_BYTES: usize = 4 * 1024;

const BODY_READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_HANDLER_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_PER_WINDOW: u32 = 120;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_RATE_BUCKETS: usize = 1024;
const SESSION_IN_FLIGHT: usize = 2;
const SESSION_WAIT: Duration = Duration::from_secs(5);
const MAX_SESSION_BUCKETS: usize = 1024;

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

/// Exact `PUT /api/books/{64 lowercase hex}/progress` shape. Query strings are
/// rejected by the handler after this shape matches; every other method or
/// path returns `None` so the production router keeps its 404 contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgressWriteRoute {
    pub(crate) id: String,
}

impl ProgressWriteRoute {
    pub(crate) fn parse(method: &Method, path: &str) -> Option<Self> {
        if method != Method::PUT {
            return None;
        }
        let rest = path.strip_prefix("/api/books/")?;
        let (id, suffix) = rest.split_once('/')?;
        if suffix != "progress" {
            return None;
        }
        Some(Self {
            id: parse_book_id(id)?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgressPayload {
    page: u32,
    base_rev: i64,
    #[serde(default)]
    scroll_pct: Option<f64>,
}

pub(crate) struct ProgressHttp {
    guard: RequestGuard,
    service: Arc<PairingService>,
    write: Arc<dyn WebProgressWrite>,
    limiter: WriteLimiter,
    sessions: SessionWriteGate,
    body_read_timeout: Duration,
}

impl ProgressHttp {
    pub(crate) fn new(
        guard: RequestGuard,
        service: Arc<PairingService>,
        write: Arc<dyn WebProgressWrite>,
    ) -> Self {
        Self {
            guard,
            service,
            write,
            limiter: WriteLimiter::new(RATE_WINDOW),
            sessions: SessionWriteGate::new(SESSION_IN_FLIGHT, MAX_SESSION_BUCKETS),
            body_read_timeout: BODY_READ_TIMEOUT,
        }
    }

    /// Handle one request. `None` means the path is not the single write
    /// route; the caller keeps its own 404 response.
    pub(crate) async fn handle<B>(
        &self,
        request: Request<B>,
        source_ip: Ipv4Addr,
    ) -> Option<Response<Full<Bytes>>>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        // Host / Origin / Sec-Fetch-Site / X-Moyu-Request / header budget.
        // The production router also runs this guard; repeating it here keeps
        // the write handler safe if it is ever mounted on its own.
        if let Err(status) = self.guard.check(&request) {
            return Some(guard_error_response(status));
        }

        let request_id = random_hex(8);
        let path = request.uri().path().to_owned();
        let route = match ProgressWriteRoute::parse(request.method(), &path) {
            Some(route) => route,
            None => return None,
        };
        if request.uri().query().is_some() {
            return Some(invalid_parameter_response(&request_id));
        }

        // Rate limiting is before authentication: an unauthenticated flood
        // must not consume session or DB work. It is after the route match so
        // unknown paths cannot drain the write bucket.
        if let Err(retry_after) = self.limiter.check(source_ip, Instant::now()) {
            return Some(rate_limited_response(&request_id, retry_after));
        }

        let session = match authenticate_request(&request, &self.service) {
            Ok(session) => session,
            Err(_) => return Some(unauthorized_response(&request_id)),
        };

        // Authentication precedes body reading. A bad Content-Type is a 400
        // only for an authenticated caller; unauthenticated callers get 401
        // and never reach the body.
        if !is_json_content_type(&request) {
            return Some(invalid_parameter_response(&request_id));
        }

        let body = match tokio::time::timeout(
            self.body_read_timeout,
            read_limited_body(request, MAX_PROGRESS_BODY_BYTES),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(BodyReadError::TooLarge)) => return Some(body_too_large_response(&request_id)),
            Ok(Err(BodyReadError::Invalid)) => {
                return Some(invalid_parameter_response(&request_id))
            }
            Err(_) => return Some(invalid_parameter_response(&request_id)),
        };
        let payload = match serde_json::from_slice::<ProgressPayload>(&body) {
            Ok(payload) => payload,
            Err(_) => return Some(invalid_parameter_response(&request_id)),
        };

        let gate = self.sessions.gate(&session.view.id);
        let session_permit: OwnedSemaphorePermit =
            match tokio::time::timeout(SESSION_WAIT, gate.acquire_owned()).await {
                Ok(Ok(permit)) => permit,
                _ => return Some(busy_response(&request_id)),
            };

        let id = route.id;
        let page = payload.page;
        let scroll_pct = payload.scroll_pct;
        let base_rev = payload.base_rev;
        let write = Arc::clone(&self.write);
        // Permits move into the blocking task: a handler timeout must not
        // release the gate while an uncancellable DB write is still running.
        let outcome = tokio::time::timeout(
            WRITE_HANDLER_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                let _session_permit = session_permit;
                write.write_progress(&id, page, scroll_pct, base_rev)
            }),
        )
        .await;
        let outcome = match outcome {
            Err(_) => return Some(busy_response(&request_id)),
            Ok(Err(_)) => return Some(internal_error_response(&request_id)),
            Ok(Ok(Err(error))) => return Some(data_error_response(error, &request_id)),
            Ok(Ok(Ok(outcome))) => outcome,
        };

        let (status, body) = progress_response(&outcome);
        // `next_action` is the frozen client contract. Using it here also
        // derives "did this write actually change progress?" without a second
        // database read: no-op returns the same rev, a real write returns +1.
        let action = next_action(&body);
        let progress_changed = matches!(
            action,
            NextAction::Continue { next_base_rev } if next_base_rev != base_rev
        );

        let mut response = progress_http_response(status, body, &request_id);
        if status == ProgressStatus::Ok && progress_changed {
            apply_refresh_cookie(&self.service, &session, "PUT", &path, true, &mut response);
        }
        Some(response)
    }
}

fn is_json_content_type<B>(request: &Request<B>) -> bool {
    let mut values = request.headers().get_all(CONTENT_TYPE).iter();
    let Some(value) = values.next() else {
        return false;
    };
    // Duplicate Content-Type headers are ambiguous; fail closed.
    if values.next().is_some() {
        return false;
    }
    let Ok(text) = value.to_str() else {
        return false;
    };
    text.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/json")
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

fn body_too_large_response(request_id: &str) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        "body-too-large",
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

fn internal_error_response(request_id: &str) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal-error",
        request_id,
        None,
        None,
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

fn progress_http_response(
    status: ProgressStatus,
    body: ProgressBody,
    request_id: &str,
) -> Response<Full<Bytes>> {
    match (status, body) {
        (
            ProgressStatus::Ok,
            ProgressBody::Applied {
                rev,
                page,
                updated_at,
            },
        ) => {
            let payload = json!({
                "rev": rev,
                "page": page,
                "updatedAt": iso_local(&updated_at),
            });
            let bytes = serde_json::to_vec(&payload).expect("progress response serializes");
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/json; charset=utf-8")
                .header(CACHE_CONTROL, "no-store")
                .header(VARY, "Cookie")
                .header(X_REQUEST_ID, request_id)
                .body(Full::new(Bytes::from(bytes)))
                .expect("static response")
        }
        (
            ProgressStatus::Conflict,
            ProgressBody::Conflict {
                code,
                current_page,
                current_rev,
                updated_at,
            },
        ) => {
            let details = json!({
                "currentPage": current_page,
                "currentRev": current_rev,
                "updatedAt": iso_local(&updated_at),
            });
            error_response(
                StatusCode::CONFLICT,
                code,
                request_id,
                Some(details),
                None,
                false,
            )
        }
        (ProgressStatus::NotFound, ProgressBody::NotFound { code }) => {
            error_response(StatusCode::NOT_FOUND, code, request_id, None, None, false)
        }
        _ => internal_error_response(request_id),
    }
}

struct WriteBucket {
    started: Instant,
    count: u32,
}

struct WriteLimiter {
    buckets: Mutex<HashMap<Ipv4Addr, WriteBucket>>,
    window: Duration,
}

impl WriteLimiter {
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
        let bucket = buckets.entry(ip).or_insert(WriteBucket {
            started: now,
            count: 0,
        });
        if now.saturating_duration_since(bucket.started) >= self.window {
            bucket.started = now;
            bucket.count = 0;
        }
        if bucket.count >= WRITE_PER_WINDOW {
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

/// Per-session in-flight gate. The map is bounded; evicting a bucket only
/// removes the lookup entry, never a permit an in-flight request still holds.
struct SessionWriteGate {
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
    permits: usize,
    max_buckets: usize,
}

impl SessionWriteGate {
    fn new(permits: usize, max_buckets: usize) -> Self {
        Self {
            gates: Mutex::new(HashMap::new()),
            permits,
            max_buckets,
        }
    }

    fn gate(&self, session_id: &str) -> Arc<Semaphore> {
        let mut gates = self
            .gates
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(gate) = gates.get(session_id) {
            return Arc::clone(gate);
        }
        if gates.len() >= self.max_buckets {
            if let Some(key) = gates.keys().next().cloned() {
                gates.remove(&key);
            }
        }
        let gate = Arc::new(Semaphore::new(self.permits));
        gates.insert(session_id.to_owned(), Arc::clone(&gate));
        gate
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::convert::Infallible;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll};
    use std::time::{Duration, Instant};

    use http_body_util::{BodyExt, Full};
    use hyper::body::{Body, Bytes, Frame};
    use hyper::header::{
        HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, ORIGIN, SET_COOKIE,
    };
    use hyper::{Method, Request, Response, StatusCode};
    use rusqlite::Connection;
    use serde_json::{json, Value};

    use super::*;
    use crate::db::{self, ProgressOutcome};
    use crate::read_service::DataError;
    use crate::state::AppState;
    use crate::web_access::auth::PairingService;
    use crate::web_access::clock::test_support::FakeClock;
    use crate::web_access::http::{AllowedAuthority, RequestGuard, X_REQUEST_ID};
    use crate::web_access::pairing::PairingStore;
    use crate::web_access::progress_write_app::AppProgress;
    use crate::web_access::session::SessionStore;

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HOST_VALUE: &str = "192.168.1.10:8443";
    const ORIGIN_VALUE: &str = "https://192.168.1.10:8443";
    const SOURCE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 20);

    fn guard() -> RequestGuard {
        RequestGuard::for_test(
            AllowedAuthority::for_test(SocketAddr::from(([192, 168, 1, 10], 8443)))
                .expect("IPv4 authority"),
        )
    }

    fn service(clock: Arc<FakeClock>) -> PairingService {
        PairingService::new(PairingStore::new(clock.clone()), SessionStore::new(clock))
    }

    fn state_with_book(page_count: u32) -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        db::upsert_book(&conn, ID, "C:/library/book.zip", "书", page_count).expect("seed");
        state.db.set(conn);
        state
    }

    fn state_with_pdf(page_count: u32) -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("memory db");
        db::init_schema(&conn).expect("schema");
        db::upsert_book_with_format(
            &conn,
            ID,
            "C:/library/book.pdf",
            "PDF",
            page_count,
            db::BOOK_FORMAT_PDF,
        )
        .expect("seed");
        state.db.set(conn);
        state
    }

    fn state_with_removed_book() -> Arc<AppState> {
        let state = state_with_book(10);
        state
            .db
            .with(|conn| {
                db::soft_remove_books(conn, &[ID.to_string()]).map_err(|error| error.to_string())
            })
            .expect("remove");
        state
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

    fn real_http(state: &Arc<AppState>, service: PairingService) -> ProgressHttp {
        ProgressHttp::new(
            guard(),
            Arc::new(service),
            Arc::new(AppProgress::new(Arc::clone(state))),
        )
    }

    struct FakeWrite {
        calls: AtomicUsize,
        result: Result<ProgressOutcome, DataError>,
    }

    impl WebProgressWrite for FakeWrite {
        fn write_progress(
            &self,
            _id: &str,
            _page: u32,
            _scroll_pct: Option<f64>,
            _base_rev: i64,
        ) -> Result<ProgressOutcome, DataError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    struct PanicWrite;

    impl WebProgressWrite for PanicWrite {
        fn write_progress(
            &self,
            _id: &str,
            _page: u32,
            _scroll_pct: Option<f64>,
            _base_rev: i64,
        ) -> Result<ProgressOutcome, DataError> {
            panic!("provider panic is a join error, not a client error")
        }
    }

    fn fake_http(result: Result<ProgressOutcome, DataError>) -> (ProgressHttp, Arc<FakeWrite>) {
        let clock = FakeClock::shared();
        let service = service(clock);
        let write = Arc::new(FakeWrite {
            calls: AtomicUsize::new(0),
            result,
        });
        (
            ProgressHttp::new(guard(), Arc::new(service), write.clone()),
            write,
        )
    }

    struct CountingBody {
        chunks: VecDeque<Bytes>,
        polls: Arc<AtomicUsize>,
    }

    impl CountingBody {
        fn new(chunks: Vec<Bytes>) -> (Self, Arc<AtomicUsize>) {
            let polls = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    chunks: chunks.into_iter().collect(),
                    polls: Arc::clone(&polls),
                },
                polls,
            )
        }
    }

    impl Body for CountingBody {
        type Data = Bytes;
        type Error = Infallible;

        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            let this = self.get_mut();
            this.polls.fetch_add(1, Ordering::SeqCst);
            Poll::Ready(this.chunks.pop_front().map(|chunk| Ok(Frame::data(chunk))))
        }
    }

    /// A body that never yields, used to prove the 5 s read budget.
    struct PendingBody;

    impl Body for PendingBody {
        type Data = Bytes;
        type Error = Infallible;

        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            Poll::Pending
        }
    }

    fn json_body(value: Value) -> Full<Bytes> {
        Full::new(Bytes::from(serde_json::to_vec(&value).expect("json")))
    }

    fn request<B>(path: &str, token: Option<&str>, body: B) -> Request<B> {
        let mut builder = Request::builder()
            .method(Method::PUT)
            .uri(path)
            .header(HOST, HOST_VALUE)
            .header(ORIGIN, ORIGIN_VALUE)
            .header("x-moyu-request", "1")
            .header(CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            builder = builder.header(COOKIE, format!("moyus_session={token}"));
        }
        builder.body(body).expect("request")
    }

    async fn status_and_json(response: Response<Full<Bytes>>) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    fn error_code(value: &Value) -> &str {
        value["error"]["code"].as_str().unwrap_or("")
    }

    fn request_id(response: &Response<Full<Bytes>>) -> String {
        response
            .headers()
            .get(X_REQUEST_ID)
            .expect("request id")
            .to_str()
            .expect("ascii")
            .to_owned()
    }

    fn path() -> String {
        format!("/api/books/{ID}/progress")
    }

    #[tokio::test]
    async fn put_writes_and_rev_handoff() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);

        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 3, "baseRev": 0, "scrollPct": 0.5})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["rev"], 1);
        assert_eq!(body["page"], 3);
        assert!(body["updatedAt"].as_str().expect("updatedAt").contains('T'));

        let written = row(&state);
        assert_eq!(written.current_page, 3);
        assert_eq!(written.scroll_pct, 0.5);
        assert_eq!(written.progress_rev, 1);
        assert_eq!(log_total(&state), 3);

        let next_base = body["rev"].as_i64().expect("rev");
        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 4, "baseRev": next_base})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["rev"], 2);
        assert_eq!(row(&state).current_page, 4);
        assert_eq!(log_total(&state), 4);
    }

    #[tokio::test]
    async fn stale_base_rev_is_409_and_changes_nothing() {
        let state = state_with_book(10);
        state
            .db
            .with(|conn| db::set_progress(conn, ID, 2, None).map_err(|error| error.to_string()))
            .expect("seed progress");
        let clock = FakeClock::shared();
        let service = service(clock.clone());
        let issued = service.issue_session_for_test("Pixel");
        clock.advance(Duration::from_secs(61 * 60));
        let http = real_http(&state, service);
        let before = row(&state);
        let log_before = log_total(&state);

        let response = http
            .handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 5, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert!(
            response.headers().get(SET_COOKIE).is_none(),
            "409 不得刷新会话"
        );
        let (status, body) = status_and_json(response).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error_code(&body), "progress-conflict");
        assert_eq!(body["error"]["details"]["currentPage"], 2);
        assert_eq!(body["error"]["details"]["currentRev"], 1);
        assert!(body["error"]["details"]["updatedAt"].as_str().is_some());

        let after = row(&state);
        assert_eq!(after.current_page, before.current_page);
        assert_eq!(after.progress_rev, before.progress_rev);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(log_total(&state), log_before);

        // Replay with the same stale base is still a conflict, never a second write.
        let (status, _) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 5, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(log_total(&state), log_before);
    }

    #[tokio::test]
    async fn noop_does_not_refresh_session_or_touch_updated_at() {
        let state = state_with_book(10);
        state
            .db
            .with(|conn| db::set_progress(conn, ID, 2, None).map_err(|error| error.to_string()))
            .expect("seed progress");
        let before = row(&state);
        let clock = FakeClock::shared();
        let service = service(clock.clone());
        let issued = service.issue_session_for_test("Pixel");
        clock.advance(Duration::from_secs(61 * 60));
        let http = real_http(&state, service);

        let response = http
            .handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 2, "baseRev": 1})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers().get(SET_COOKIE).is_none(),
            "no-op 不得刷新会话"
        );
        let after = row(&state);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(after.progress_rev, before.progress_rev);
        assert_eq!(log_total(&state), 2);
    }

    #[tokio::test]
    async fn changed_write_refreshes_session() {
        let state = state_with_book(10);
        state
            .db
            .with(|conn| db::set_progress(conn, ID, 2, None).map_err(|error| error.to_string()))
            .expect("seed progress");
        let clock = FakeClock::shared();
        let service = service(clock.clone());
        let issued = service.issue_session_for_test("Pixel");
        clock.advance(Duration::from_secs(61 * 60));
        let http = real_http(&state, service);

        let response = http
            .handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 3, "baseRev": 1})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(SET_COOKIE)
            .expect("refresh cookie")
            .to_str()
            .expect("ascii");
        assert!(cookie.contains("moyus_session="));
        assert!(cookie.contains("Max-Age="));
        assert_eq!(row(&state).current_page, 3);
    }

    #[tokio::test]
    async fn unauthenticated_does_not_read_body_or_call_provider() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let (body, polls) =
            CountingBody::new(vec![Bytes::from_static(b"{\"page\":1,\"baseRev\":0}")]);
        let response = http
            .handle(request(&path(), None, body), SOURCE_IP)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(polls.load(Ordering::SeqCst), 0, "未认证不得读取 body");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn revoked_session_is_401() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        assert!(service.revoke_device(&issued.id));
        let http = real_http(&state, service);
        let before = row(&state);

        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 3, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(&body), "unauthorized");
        assert_eq!(row(&state).current_page, before.current_page);
        assert_eq!(row(&state).progress_rev, before.progress_rev);
        assert_eq!(log_total(&state), 0);
    }

    #[tokio::test]
    async fn invalid_content_type_is_400() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        for content_type in [None, Some("text/plain")] {
            let mut req = request(
                &path(),
                Some(issued.token.as_str()),
                json_body(json!({"page": 1, "baseRev": 0})),
            );
            match content_type {
                Some(value) => {
                    req.headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static(value));
                }
                None => {
                    req.headers_mut().remove(CONTENT_TYPE);
                }
            }
            let (status, body) =
                status_and_json(http.handle(req, SOURCE_IP).await.expect("response")).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{content_type:?}");
            assert_eq!(error_code(&body), "invalid-parameter");
        }
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn empty_and_invalid_bodies_are_400() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        for body in [
            Bytes::new(),
            Bytes::from_static(b"{not json"),
            Bytes::from_static(b"{\"page\":1,\"baseRev\":0} trailing"),
            Bytes::from_static(b"[]"),
        ] {
            let (status, _) = status_and_json(
                http.handle(
                    request(&path(), Some(issued.token.as_str()), Full::new(body)),
                    SOURCE_IP,
                )
                .await
                .expect("response"),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unknown_field_is_400() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 1, "baseRev": 0, "extra": 1})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&body), "invalid-parameter");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn body_over_4k_is_413() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        let oversized = Bytes::from(vec![b'a'; MAX_PROGRESS_BODY_BYTES + 1]);
        let (status, body) = status_and_json(
            http.handle(
                request(&path(), Some(issued.token.as_str()), Full::new(oversized)),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error_code(&body), "body-too-large");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn chunked_body_over_limit_is_413() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        let (body, polls) = CountingBody::new(vec![
            Bytes::from(vec![b'a'; 3000]),
            Bytes::from(vec![b'a'; 2000]),
        ]);
        let (status, body_json) = status_and_json(
            http.handle(
                request(&path(), Some(issued.token.as_str()), body),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error_code(&body_json), "body-too-large");
        assert!(polls.load(Ordering::SeqCst) > 0);
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn invalid_page_is_400() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);
        for value in [
            json!({"page": 10, "baseRev": 0}),
            json!({"page": u32::MAX, "baseRev": 0}),
            json!({"page": -1, "baseRev": 0}),
            json!({"page": "1", "baseRev": 0}),
            json!({"baseRev": 0}),
        ] {
            let (status, body) = status_and_json(
                http.handle(
                    request(&path(), Some(issued.token.as_str()), json_body(value)),
                    SOURCE_IP,
                )
                .await
                .expect("response"),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(error_code(&body), "invalid-parameter");
        }
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);
    }

    #[tokio::test]
    async fn invalid_base_rev_is_400() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);
        for value in [
            json!({"page": 1}),
            json!({"page": 1, "baseRev": -1}),
            json!({"page": 1, "baseRev": "0"}),
            json!({"page": 1, "baseRev": 0.5}),
        ] {
            let label = value.to_string();
            let (status, body) = status_and_json(
                http.handle(
                    request(&path(), Some(issued.token.as_str()), json_body(value)),
                    SOURCE_IP,
                )
                .await
                .expect("response"),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}");
            assert_eq!(error_code(&body), "invalid-parameter");
        }
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);
    }

    #[tokio::test]
    async fn invalid_scroll_pct_is_400() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);
        for value in [
            json!({"page": 1, "baseRev": 0, "scrollPct": -1}),
            json!({"page": 1, "baseRev": 0, "scrollPct": 1.0001}),
            json!({"page": 1, "baseRev": 0, "scrollPct": "0.5"}),
        ] {
            let label = value.to_string();
            let (status, body) = status_and_json(
                http.handle(
                    request(&path(), Some(issued.token.as_str()), json_body(value)),
                    SOURCE_IP,
                )
                .await
                .expect("response"),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}");
            assert_eq!(error_code(&body), "invalid-parameter");
        }
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(log_total(&state), 0);
    }

    #[tokio::test]
    async fn null_scroll_pct_is_treated_as_omitted() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);
        let (status, _) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 1, "baseRev": 0, "scrollPct": null})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(row(&state).scroll_pct, -1.0);
    }

    #[tokio::test]
    async fn query_string_is_400() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        let path = format!("{}?x=1", path());
        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path,
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 1, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&body), "invalid-parameter");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn invalid_paths_are_not_routes() {
        let valid = path();
        for path in [
            format!("{valid}/"),
            format!("/api/books/{}/progress/extra", ID.to_uppercase()),
            format!("/api/books/{}/progress/extra", ID),
            "/api/books/short/progress".to_string(),
            format!("/api/books/{}/progress", "A".repeat(64)),
            format!("/api/books/{ID}%2fprogress"),
            format!("/api/books/{ID}%2Fprogress"),
            format!("/api/books/{}%2f..%2fetc/progress", ID),
            "/api/books/..%2f..%2fetc/progress".to_string(),
            format!("/api/books/{ID}/progress+"),
            format!("/api/books/{ID}//progress"),
            "/api/book".to_string(),
        ] {
            assert!(
                ProgressWriteRoute::parse(&Method::PUT, &path).is_none(),
                "{path}"
            );
        }
        assert!(ProgressWriteRoute::parse(&Method::GET, &valid).is_none());
        assert!(ProgressWriteRoute::parse(&Method::POST, &valid).is_none());
        assert!(ProgressWriteRoute::parse(&Method::PATCH, &valid).is_none());
        assert!(ProgressWriteRoute::parse(&Method::DELETE, &valid).is_none());
    }

    #[tokio::test]
    async fn origin_and_x_moyu_guards_apply() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");

        let mut missing_origin = request(
            &path(),
            Some(issued.token.as_str()),
            json_body(json!({"page": 1, "baseRev": 0})),
        );
        missing_origin.headers_mut().remove(ORIGIN);
        assert_eq!(
            http.handle(missing_origin, SOURCE_IP)
                .await
                .expect("response")
                .status(),
            StatusCode::FORBIDDEN
        );

        let mut bad_origin = request(
            &path(),
            Some(issued.token.as_str()),
            json_body(json!({"page": 1, "baseRev": 0})),
        );
        bad_origin
            .headers_mut()
            .insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert_eq!(
            http.handle(bad_origin, SOURCE_IP)
                .await
                .expect("response")
                .status(),
            StatusCode::FORBIDDEN
        );

        let mut missing_x_moyu = request(
            &path(),
            Some(issued.token.as_str()),
            json_body(json!({"page": 1, "baseRev": 0})),
        );
        missing_x_moyu.headers_mut().remove("x-moyu-request");
        assert_eq!(
            http.handle(missing_x_moyu, SOURCE_IP)
                .await
                .expect("response")
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn pdf_is_415_and_removed_is_404() {
        let pdf_state = state_with_pdf(5);
        let clock = FakeClock::shared();
        let pdf_service = service(clock.clone());
        let pdf_session = pdf_service.issue_session_for_test("Pixel");
        let pdf_http = real_http(&pdf_state, pdf_service);
        let (status, body) = status_and_json(
            pdf_http
                .handle(
                    request(
                        &path(),
                        Some(pdf_session.token.as_str()),
                        json_body(json!({"page": 1, "baseRev": 0})),
                    ),
                    SOURCE_IP,
                )
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(error_code(&body), "pdf-source-unsupported");
        assert_eq!(row(&pdf_state).current_page, 0);

        let removed_state = state_with_removed_book();
        let removed_service = service(clock);
        let removed_session = removed_service.issue_session_for_test("Pixel");
        let removed_http = real_http(&removed_state, removed_service);
        let before = row(&removed_state);
        let (status, body) = status_and_json(
            removed_http
                .handle(
                    request(
                        &path(),
                        Some(removed_session.token.as_str()),
                        json_body(json!({"page": 1, "baseRev": 0})),
                    ),
                    SOURCE_IP,
                )
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_code(&body), "book-not-found");
        assert_eq!(row(&removed_state).current_page, before.current_page);
        assert_eq!(log_total(&removed_state), 0);
    }

    #[tokio::test]
    async fn transaction_failure_is_503_then_retry_succeeds() {
        let state = state_with_book(10);
        state
            .db
            .with(|conn| {
                conn.execute_batch(
                    "CREATE TABLE fk_parent(id INTEGER PRIMARY KEY);
                     CREATE TABLE fk_child(
                         id INTEGER PRIMARY KEY,
                         parent_id INTEGER REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED
                     );
                     CREATE TRIGGER fail_reading_log AFTER INSERT ON reading_log
                     BEGIN
                         INSERT INTO fk_child(parent_id) VALUES (999);
                     END;",
                )
                .map_err(|error| error.to_string())
            })
            .expect("trigger");
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);

        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 3, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&body), "busy");
        assert_eq!(row(&state).current_page, 0);
        assert_eq!(row(&state).progress_rev, 0);
        assert_eq!(log_total(&state), 0);

        state
            .db
            .with(|conn| {
                conn.execute_batch("DROP TRIGGER fail_reading_log")
                    .map_err(|e| e.to_string())
            })
            .expect("drop trigger");
        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 3, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(row(&state).current_page, 3);
        assert_eq!(row(&state).progress_rev, 1);
        assert_eq!(log_total(&state), 3);
    }

    #[tokio::test]
    async fn desktop_set_progress_still_works_after_web_write() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);

        let (status, _) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 2, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        state
            .db
            .with(|conn| db::set_progress(conn, ID, 4, None).map_err(|error| error.to_string()))
            .expect("desktop write");
        let row = row(&state);
        assert_eq!(row.current_page, 4);
        assert_eq!(row.progress_rev, 2);
        assert_eq!(log_total(&state), 4);
    }

    #[tokio::test]
    async fn rate_limit_is_429_with_retry_hints() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        let now = Instant::now();
        for _ in 0..WRITE_PER_WINDOW {
            http.limiter.check(SOURCE_IP, now).expect("under limit");
        }
        let (body, polls) =
            CountingBody::new(vec![Bytes::from_static(b"{\"page\":1,\"baseRev\":0}")]);
        let response = http
            .handle(
                request(&path(), Some(issued.token.as_str()), body),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().get("retry-after").is_some());
        assert_eq!(polls.load(Ordering::SeqCst), 0, "限流不得读取 body");
        let (_, body) = status_and_json(response).await;
        assert_eq!(error_code(&body), "pairing-rate-limited");
        assert!(body["error"]["retryAfterMs"].as_u64().is_some());
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn success_headers_are_minimal_and_stable() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = real_http(&state, service);
        let response = http
            .handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 1, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .expect("cache")
                .to_str()
                .expect("ascii"),
            "no-store"
        );
        assert!(response
            .headers()
            .get("access-control-allow-origin")
            .is_none());
        let id = request_id(&response);
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let (_, body) = status_and_json(response).await;
        assert_eq!(body["page"], 1);
        assert_eq!(body["rev"], 1);
    }

    #[tokio::test]
    async fn second_changed_write_within_hour_does_not_refresh_again() {
        let state = state_with_book(10);
        let clock = FakeClock::shared();
        let service = service(clock.clone());
        let issued = service.issue_session_for_test("Pixel");
        clock.advance(Duration::from_secs(61 * 60));
        let http = real_http(&state, service);

        let first = http
            .handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 1, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert_eq!(first.status(), StatusCode::OK);
        assert!(first.headers().get(SET_COOKIE).is_some());

        let second = http
            .handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 2, "baseRev": 1})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response");
        assert_eq!(second.status(), StatusCode::OK);
        assert!(
            second.headers().get(SET_COOKIE).is_none(),
            "60 分钟内的第二次成功写入不得再次刷新"
        );
        assert_eq!(row(&state).current_page, 2);
        assert_eq!(row(&state).progress_rev, 2);
    }

    #[tokio::test]
    async fn content_length_is_not_trusted() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");

        // Declares 10 bytes but sends 5000: the actual byte count wins.
        let mut lying_small = request(
            &path(),
            Some(issued.token.as_str()),
            Full::new(Bytes::from(vec![b'a'; 5000])),
        );
        lying_small
            .headers_mut()
            .insert(CONTENT_LENGTH, HeaderValue::from_static("10"));
        let (status, body) =
            status_and_json(http.handle(lying_small, SOURCE_IP).await.expect("response")).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error_code(&body), "body-too-large");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);

        // Declares a huge body but sends a valid small one: still accepted.
        let mut lying_large = request(
            &path(),
            Some(issued.token.as_str()),
            json_body(json!({"page": 1, "baseRev": 0})),
        );
        lying_large
            .headers_mut()
            .insert(CONTENT_LENGTH, HeaderValue::from_static("999999"));
        let (status, _) =
            status_and_json(http.handle(lying_large, SOURCE_IP).await.expect("response")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(write.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn duplicate_content_type_is_400() {
        let (http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        let issued = http.service.issue_session_for_test("Pixel");
        let mut req = request(
            &path(),
            Some(issued.token.as_str()),
            json_body(json!({"page": 1, "baseRev": 0})),
        );
        req.headers_mut()
            .append(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let (status, body) =
            status_and_json(http.handle(req, SOURCE_IP).await.expect("response")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&body), "invalid-parameter");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn slow_body_times_out_without_calling_provider() {
        let (mut http, write) = fake_http(Ok(ProgressOutcome::Applied {
            rev: 1,
            page: 1,
            updated_at: "2026-11-03 21:00:00".into(),
        }));
        // Production uses 5 s; the test shortens only the read budget so the
        // pending body proves the timeout path without a five-second wait.
        http.body_read_timeout = Duration::from_millis(10);
        let issued = http.service.issue_session_for_test("Pixel");
        let (status, body) = status_and_json(
            http.handle(
                request(&path(), Some(issued.token.as_str()), PendingBody),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&body), "invalid-parameter");
        assert_eq!(write.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn provider_join_error_is_500_without_details() {
        let clock = FakeClock::shared();
        let service = service(clock);
        let issued = service.issue_session_for_test("Pixel");
        let http = ProgressHttp::new(guard(), Arc::new(service), Arc::new(PanicWrite));
        let (status, body) = status_and_json(
            http.handle(
                request(
                    &path(),
                    Some(issued.token.as_str()),
                    json_body(json!({"page": 1, "baseRev": 0})),
                ),
                SOURCE_IP,
            )
            .await
            .expect("response"),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error_code(&body), "internal-error");
        assert!(body["error"].get("details").is_none());
    }
}
