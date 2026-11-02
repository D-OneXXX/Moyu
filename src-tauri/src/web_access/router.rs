//! Production pair-only HTTP router (D1b).
//!
//! This is the only production router that mounts pairing routes. It serves
//! exactly:
//!
//! - `GET /api/health` (204, zero information)
//! - `POST /api/pair/claim` (create a claim + `moyu_claim` cookie)
//! - `GET /api/pair/claim/{id}` (read-only status / long-poll)
//! - `POST /api/pair/claim/{id}/consume` (one-time pickup + session cookie)
//!
//! Every other path, including all data-plane and device-management paths, is
//! 404. There is no CORS, no Referer authentication, and no token in JSON.
//! The authority is constructed from the listener's actual bound IPv4 address
//! by [`PairingHttp::new`], never from a request header or setting.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Bytes};
use hyper::header::{HeaderMap, HeaderValue, CACHE_CONTROL, CONTENT_TYPE, COOKIE, SET_COOKIE};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::auth::{AuthError, PairingService};
use super::error::{WebAccessError, WebAccessResult};
use super::http::{health_response, not_found_response, AllowedAuthority, RequestGuard};
use super::pairing::{ClaimIssued, ClaimState, PairingError};
use super::session::SessionIssued;

pub(crate) const HEALTH_PATH: &str = "/api/health";
pub(crate) const CLAIM_ROUTE: &str = "/api/pair/claim";
pub(crate) const CLAIM_POLL_PREFIX: &str = "/api/pair/claim/";
pub(crate) const CONSUME_SUFFIX: &str = "/consume";

pub(crate) const CLAIM_COOKIE: &str = "moyu_claim";
pub(crate) const SESSION_COOKIE: &str = "moyus_session";
const CLAIM_COOKIE_PATH: &str = "/api/pair/claim";
const CLAIM_COOKIE_MAX_AGE: u64 = 120;
const SESSION_COOKIE_MAX_AGE: u64 = 2_592_000;
pub(crate) const MAX_CLAIM_BODY_BYTES: usize = 4096;

/// A read-only status poll may wait this long for `pending` to change. The
/// outer connection timeout is 10 seconds, so the window stays below it.
const DEFAULT_POLL_WINDOW: Duration = Duration::from_secs(8);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// HTTP-level per-IP buckets. The pairing store has its own claim limits; this
/// layer bounds all three remote routes before any state-machine work.
const RATE_WINDOW: Duration = Duration::from_secs(60);
const CLAIM_PER_WINDOW: u32 = 10;
const STATUS_PER_WINDOW: u32 = 60;
const CONSUME_PER_WINDOW: u32 = 30;
/// Bound the per-IP map. A LAN with more distinct peers than this is
/// implausible; new peers are fail-closed with a retry hint instead of letting
/// an unbounded map grow.
const MAX_RATE_BUCKETS: usize = 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimPayload {
    pairing_id: String,
    device_name: String,
    claim_nonce: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum RouteClass {
    Claim = 0,
    Status = 1,
    Consume = 2,
}

impl RouteClass {
    fn limit(self) -> u32 {
        match self {
            Self::Claim => CLAIM_PER_WINDOW,
            Self::Status => STATUS_PER_WINDOW,
            Self::Consume => CONSUME_PER_WINDOW,
        }
    }
}

struct IpBucket {
    window_started: Instant,
    counts: [u32; 3],
}

struct RateLimiter {
    buckets: Mutex<HashMap<Ipv4Addr, IpBucket>>,
    window: Duration,
}

impl RateLimiter {
    fn new(window: Duration) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            window,
        }
    }

    /// Returns `Err(retry_after)` when the bucket for this route is full.
    fn check(&self, ip: Ipv4Addr, route: RouteClass, now: Instant) -> Result<(), Duration> {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !buckets.contains_key(&ip) && buckets.len() >= MAX_RATE_BUCKETS {
            buckets.retain(|_, bucket| {
                now.saturating_duration_since(bucket.window_started) < self.window
            });
            if buckets.len() >= MAX_RATE_BUCKETS {
                return Err(self.window);
            }
        }
        let bucket = buckets.entry(ip).or_insert_with(|| IpBucket {
            window_started: now,
            counts: [0; 3],
        });
        if now.saturating_duration_since(bucket.window_started) >= self.window {
            bucket.window_started = now;
            bucket.counts = [0; 3];
        }
        let index = route as usize;
        if bucket.counts[index] >= route.limit() {
            let elapsed = now.saturating_duration_since(bucket.window_started);
            return Err(self
                .window
                .saturating_sub(elapsed)
                .max(Duration::from_millis(1)));
        }
        bucket.counts[index] += 1;
        Ok(())
    }
}

/// Production pair router bound to the listener's actual IPv4 authority.
pub(crate) struct PairingHttp {
    guard: RequestGuard,
    service: Arc<PairingService>,
    origin: String,
    poll_window: Duration,
    poll_interval: Duration,
    limiter: RateLimiter,
}

#[cfg(test)]
impl std::fmt::Debug for PairingHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingHttp")
            .field("origin", &"<redacted>")
            .field("poll_window", &self.poll_window)
            .finish_non_exhaustive()
    }
}

impl PairingHttp {
    /// Construct from the actual bound address. Only IPv4 is accepted; the
    /// caller passes `listener.local_addr()`, never a request or setting.
    pub(crate) fn new(
        service: Arc<PairingService>,
        local_addr: SocketAddr,
    ) -> WebAccessResult<Self> {
        let authority = AllowedAuthority::from_socket_addr(local_addr)
            .ok_or(WebAccessError::InvalidBindAddress)?;
        let origin = authority.origin().to_owned();
        Ok(Self {
            guard: RequestGuard::for_authority(authority),
            service,
            origin,
            poll_window: DEFAULT_POLL_WINDOW,
            poll_interval: DEFAULT_POLL_INTERVAL,
            limiter: RateLimiter::new(RATE_WINDOW),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(service: Arc<PairingService>, local_addr: SocketAddr) -> Self {
        Self::new(service, local_addr).expect("IPv4 test authority")
    }

    #[cfg(test)]
    pub(crate) fn set_polling(&mut self, window: Duration, interval: Duration) {
        self.poll_window = window;
        self.poll_interval = interval;
    }

    /// Handle one request. `source_ip` is the TLS peer address (or a test
    /// injection); it is never read from a header.
    pub(crate) async fn handle<B>(
        &self,
        request: Request<B>,
        source_ip: Ipv4Addr,
    ) -> Response<Full<Bytes>>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        if let Err(status) = self.guard.check(&request) {
            return guard_error_response(status);
        }

        let method = request.method().clone();
        let path = request.uri().path().to_owned();

        if method == Method::GET && path == HEALTH_PATH {
            return health_response();
        }
        if method == Method::POST && path == CLAIM_ROUTE {
            if let Err(retry_after) =
                self.limiter
                    .check(source_ip, RouteClass::Claim, Instant::now())
            {
                return rate_limited_response(retry_after);
            }
            return self.claim(request, source_ip).await;
        }
        if method == Method::GET {
            if let Some(claim_id) = poll_claim_id(&path) {
                if let Err(retry_after) =
                    self.limiter
                        .check(source_ip, RouteClass::Status, Instant::now())
                {
                    return rate_limited_response(retry_after);
                }
                return self.status(request, claim_id).await;
            }
        }
        if method == Method::POST {
            if let Some(claim_id) = consume_claim_id(&path) {
                if let Err(retry_after) =
                    self.limiter
                        .check(source_ip, RouteClass::Consume, Instant::now())
                {
                    return rate_limited_response(retry_after);
                }
                return self.consume(request, claim_id).await;
            }
        }
        not_found_response()
    }

    async fn claim<B>(&self, request: Request<B>, source_ip: Ipv4Addr) -> Response<Full<Bytes>>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        let bytes = match read_limited_body(request).await {
            Ok(bytes) => bytes,
            Err(BodyReadError::TooLarge) => return body_too_large_response(),
            Err(BodyReadError::Invalid) => return invalid_parameter_response(),
        };
        let Ok(payload) = serde_json::from_slice::<ClaimPayload>(&bytes) else {
            return invalid_parameter_response();
        };

        match self.service.claim(
            &payload.pairing_id,
            &payload.device_name,
            &payload.claim_nonce,
            source_ip,
        ) {
            Ok(issued) => claim_created_response(issued),
            Err(error) => auth_error_response(&error),
        }
    }

    /// Read-only claim status / long-poll. No claim is consumed, no token is
    /// issued, and the claim cookie is never cleared by a successful read.
    async fn status<B>(&self, request: Request<B>, claim_id: &str) -> Response<Full<Bytes>> {
        let Some(secret) = claim_cookie(request.headers()) else {
            return error_response(StatusCode::UNAUTHORIZED, "unauthorized", None);
        };

        let deadline = Instant::now() + self.poll_window;
        loop {
            match self.service.status(claim_id, secret.as_str()) {
                Ok(status) => match status.state {
                    ClaimState::Pending => {
                        if Instant::now() >= deadline {
                            return json_response(
                                StatusCode::OK,
                                json!({ "state": "pending" }),
                                &[],
                            );
                        }
                        tokio::time::sleep(self.poll_interval).await;
                    }
                    ClaimState::Approved => {
                        return json_response(StatusCode::OK, json!({ "state": "approved" }), &[]);
                    }
                    ClaimState::Denied | ClaimState::Cancelled | ClaimState::Expired => {
                        return terminal_response(status.state);
                    }
                    ClaimState::Consumed => {
                        return auth_error_response(&AuthError::Pairing(PairingError::Consumed));
                    }
                },
                Err(error) => return auth_error_response(&error),
            }
        }
    }

    /// One-time pickup. The shared guard already enforced exact Host, Origin,
    /// and `X-Moyu-Request`; the check is repeated so the route contract cannot
    /// be dropped if the guard changes later.
    pub(crate) async fn consume<B>(
        &self,
        request: Request<B>,
        claim_id: &str,
    ) -> Response<Full<Bytes>> {
        if !self.trusted_pickup(request.headers()) {
            return guard_error_response(StatusCode::FORBIDDEN);
        }
        let Some(secret) = claim_cookie(request.headers()) else {
            return error_response(StatusCode::UNAUTHORIZED, "unauthorized", None);
        };
        match self.service.consume(claim_id, secret.as_str()) {
            Ok(issued) => consumed_response(issued),
            Err(error) => auth_error_response(&error),
        }
    }

    fn trusted_pickup(&self, headers: &HeaderMap) -> bool {
        single_header(headers, "origin") == Some(self.origin.as_str())
            && single_header(headers, "x-moyu-request") == Some("1")
    }
}

/// Why a claim body was rejected. Keeping this small avoids a large
/// `Response` in the error position.
enum BodyReadError {
    TooLarge,
    Invalid,
}

/// Read at most [`MAX_CLAIM_BODY_BYTES`] without trusting a size hint. A body
/// that exceeds the cap is rejected before JSON parsing, and a body read error
/// is a client error rather than a 500.
async fn read_limited_body<B>(request: Request<B>) -> Result<Bytes, BodyReadError>
where
    B: Body<Data = Bytes> + Unpin,
{
    let mut body = request.into_body();
    let mut bytes = Vec::new();
    loop {
        let frame = match body.frame().await {
            Some(Ok(frame)) => frame,
            Some(Err(_)) => return Err(BodyReadError::Invalid),
            None => break,
        };
        let Some(data) = frame.data_ref() else {
            continue;
        };
        if bytes.len().saturating_add(data.len()) > MAX_CLAIM_BODY_BYTES {
            return Err(BodyReadError::TooLarge);
        }
        bytes.extend_from_slice(data);
    }
    Ok(Bytes::from(bytes))
}

fn poll_claim_id(path: &str) -> Option<&str> {
    let claim_id = path.strip_prefix(CLAIM_POLL_PREFIX)?;
    if claim_id.is_empty() || claim_id.contains('/') {
        return None;
    }
    Some(claim_id)
}

/// Matches exactly `/api/pair/claim/{id}/consume`; extra segments or a
/// missing id are unknown paths (404), never a pickup.
fn consume_claim_id(path: &str) -> Option<&str> {
    let claim_id = path
        .strip_prefix(CLAIM_POLL_PREFIX)?
        .strip_suffix(CONSUME_SUFFIX)?;
    if claim_id.is_empty() || claim_id.contains('/') {
        return None;
    }
    Some(claim_id)
}

/// Returns the header only when exactly one value exists and it is valid UTF-8.
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

/// Parses the single `moyu_claim` cookie. A missing, duplicated, or malformed
/// cookie header yields `None` so the route answers `401 unauthorized`.
fn claim_cookie(headers: &HeaderMap) -> Option<Zeroizing<String>> {
    let mut secret = None;
    for header in headers.get_all(COOKIE).iter() {
        let value = header.to_str().ok()?;
        for pair in value.split(';') {
            let pair = pair.trim();
            if pair.is_empty() {
                continue;
            }
            let (name, cookie_value) = pair.split_once('=')?;
            if name.trim() != CLAIM_COOKIE {
                continue;
            }
            let cookie_value = cookie_value.trim();
            if cookie_value.is_empty() || secret.is_some() {
                return None;
            }
            secret = Some(cookie_value);
        }
    }
    secret.map(|secret| Zeroizing::new(secret.to_owned()))
}

fn claim_created_response(issued: ClaimIssued) -> Response<Full<Bytes>> {
    let ClaimIssued {
        claim_id,
        claim_secret,
    } = issued;
    let cookie = claim_cookie_header(claim_secret.as_str());
    json_response(
        StatusCode::ACCEPTED,
        json!({ "claimId": claim_id }),
        &[cookie],
    )
}

fn consumed_response(issued: SessionIssued) -> Response<Full<Bytes>> {
    let session_cookie = session_cookie_header(issued.token.as_str());
    json_response(
        StatusCode::OK,
        json!({ "state": "consumed" }),
        &[session_cookie, clear_claim_cookie_header()],
    )
}

fn terminal_response(state: ClaimState) -> Response<Full<Bytes>> {
    json_response(
        StatusCode::OK,
        json!({ "state": state.as_str() }),
        &[clear_claim_cookie_header()],
    )
}

fn claim_cookie_header(secret: &str) -> String {
    format!(
        "{CLAIM_COOKIE}={secret}; HttpOnly; Secure; SameSite=Strict; Path={CLAIM_COOKIE_PATH}; Max-Age={CLAIM_COOKIE_MAX_AGE}"
    )
}

fn clear_claim_cookie_header() -> String {
    format!(
        "{CLAIM_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path={CLAIM_COOKIE_PATH}; Max-Age=0"
    )
}

fn session_cookie_header(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={SESSION_COOKIE_MAX_AGE}"
    )
}

fn json_response(status: StatusCode, body: Value, set_cookies: &[String]) -> Response<Full<Bytes>> {
    let payload = serde_json::to_vec(&body).expect("json body serializes");
    let mut builder = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .header(CONTENT_TYPE, "application/json; charset=utf-8");
    for cookie in set_cookies {
        builder = builder.header(SET_COOKIE, cookie);
    }
    builder
        .body(Full::new(Bytes::from(payload)))
        .expect("static response")
}

fn error_response(
    status: StatusCode,
    code: &'static str,
    retry_after: Option<Duration>,
) -> Response<Full<Bytes>> {
    // The unified error body allows `retryAfterMs` only for rate limiting;
    // every other error keeps the bare stable code.
    let body = match retry_after {
        Some(retry_after) => json!({
            "error": {
                "code": code,
                "retryAfterMs": retry_after_millis(retry_after),
            }
        }),
        None => json!({ "error": { "code": code } }),
    };
    let mut response = json_response(status, body, &[]);
    if let Some(retry_after) = retry_after {
        let value = HeaderValue::from_str(&retry_after_seconds(retry_after).to_string())
            .expect("retry-after header");
        response.headers_mut().insert("retry-after", value);
    }
    response
}

fn auth_error_response(error: &AuthError) -> Response<Full<Bytes>> {
    let status = match error.code() {
        "pairing-not-found" => StatusCode::NOT_FOUND,
        "pairing-claimed" | "pairing-consumed" | "device-limit" => StatusCode::CONFLICT,
        "pairing-rate-limited" => StatusCode::TOO_MANY_REQUESTS,
        "pairing-expired" => StatusCode::GONE,
        "pairing-denied" | "pairing-cancelled" => StatusCode::FORBIDDEN,
        "unauthorized" | "session-expired" => StatusCode::UNAUTHORIZED,
        _ => StatusCode::BAD_REQUEST,
    };
    let retry_after = match error {
        AuthError::Pairing(PairingError::RateLimited { retry_after }) => Some(*retry_after),
        _ => None,
    };
    error_response(status, error.code(), retry_after)
}

fn retry_after_seconds(retry_after: Duration) -> u64 {
    let seconds = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
    seconds.max(1)
}

fn retry_after_millis(retry_after: Duration) -> u64 {
    u64::try_from(retry_after.as_millis().max(1)).unwrap_or(u64::MAX)
}

fn rate_limited_response(retry_after: Duration) -> Response<Full<Bytes>> {
    error_response(
        StatusCode::TOO_MANY_REQUESTS,
        "pairing-rate-limited",
        Some(retry_after),
    )
}

/// Host/Origin/header failures share the frozen public `forbidden` code; the
/// HTTP status still distinguishes 421 (Host) from 403 (Origin/header).
fn guard_error_response(status: StatusCode) -> Response<Full<Bytes>> {
    error_response(status, "forbidden", None)
}

fn body_too_large_response() -> Response<Full<Bytes>> {
    error_response(StatusCode::PAYLOAD_TOO_LARGE, "body-too-large", None)
}

fn invalid_parameter_response() -> Response<Full<Bytes>> {
    error_response(StatusCode::BAD_REQUEST, "invalid-parameter", None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_access::http::empty_response;

    fn ip(last: u8) -> Ipv4Addr {
        Ipv4Addr::new(192, 168, 1, last)
    }

    #[test]
    fn rate_limiter_buckets_are_per_ip_and_per_route() {
        let limiter = RateLimiter::new(RATE_WINDOW);
        let start = Instant::now();
        for _ in 0..CLAIM_PER_WINDOW {
            assert!(limiter.check(ip(10), RouteClass::Claim, start).is_ok());
        }
        let retry = limiter.check(ip(10), RouteClass::Claim, start).unwrap_err();
        assert!(retry > Duration::ZERO && retry <= RATE_WINDOW);
        // A different route and a different IP keep their own buckets.
        assert!(limiter.check(ip(10), RouteClass::Status, start).is_ok());
        assert!(limiter.check(ip(11), RouteClass::Claim, start).is_ok());
        // The window slides on the next check.
        assert!(limiter
            .check(ip(10), RouteClass::Claim, start + RATE_WINDOW)
            .is_ok());
    }

    #[test]
    fn rate_limiter_bounds_the_ip_map_and_fails_closed() {
        let limiter = RateLimiter::new(RATE_WINDOW);
        let start = Instant::now();
        for index in 0..MAX_RATE_BUCKETS {
            let ip = Ipv4Addr::new(10, (index >> 8) as u8, (index & 0xff) as u8, 1);
            assert!(limiter.check(ip, RouteClass::Claim, start).is_ok());
        }
        let extra = Ipv4Addr::new(172, 16, 0, 1);
        assert!(limiter.check(extra, RouteClass::Claim, start).is_err());
        // A later window prunes the old buckets and admits new peers again.
        assert!(limiter
            .check(extra, RouteClass::Claim, start + RATE_WINDOW)
            .is_ok());
    }

    #[test]
    fn rate_limit_error_body_and_headers_are_stable() {
        let response = rate_limited_response(Duration::from_millis(1500));
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["retry-after"], "2");
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    }

    #[test]
    fn route_parsers_accept_exactly_one_id_and_reject_extra_segments() {
        assert_eq!(poll_claim_id("/api/pair/claim/claim_x"), Some("claim_x"));
        assert_eq!(poll_claim_id("/api/pair/claim/"), None);
        assert_eq!(poll_claim_id("/api/pair/claim/claim_x/extra"), None);
        assert_eq!(
            consume_claim_id("/api/pair/claim/claim_x/consume"),
            Some("claim_x")
        );
        assert_eq!(consume_claim_id("/api/pair/claim/claim_x"), None);
        assert_eq!(consume_claim_id("/api/pair/claim//consume"), None);
    }

    #[test]
    fn claim_cookie_parser_rejects_duplicates_and_malformed_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_static("moyu_claim=a"));
        assert_eq!(
            claim_cookie(&headers).as_deref().map(String::as_str),
            Some("a")
        );

        headers.insert(
            COOKIE,
            HeaderValue::from_static("moyu_claim=a; moyu_claim=b"),
        );
        assert!(claim_cookie(&headers).is_none());

        let mut malformed = HeaderMap::new();
        malformed.insert(COOKIE, HeaderValue::from_static("moyu_claim"));
        assert!(claim_cookie(&malformed).is_none());
    }

    #[test]
    fn empty_response_is_no_store_and_not_found() {
        let response = empty_response(StatusCode::NOT_FOUND);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    }
}
