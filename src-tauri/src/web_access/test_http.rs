//! `#[cfg(test)]` pairing route mount for W7-D1a.
//!
//! This module is compiled only for tests and is never wired into production
//! startup, commands, or the TLS listener. It exposes a pair-only router that
//! reuses the production [`RequestGuard`] and static response helpers from
//! `http.rs`, so the frozen Host/Origin rules are exercised without sockets,
//! TLS, or a real listener.
//!
//! Tests call [`TestRouter::handle`] with synthetic
//! `Request<Full<Bytes>>` values and inspect `Response<Full<Bytes>>`. Pairing
//! claims run against the real in-memory [`PairingService`]; the only test
//! injections are the IPv4 authority passed to the constructor and the
//! [`TestSourceIp`] request extension. There is no header, environment, or
//! runtime bypass.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use http_body_util::Full;
use hyper::body::{Body as _, Bytes};
use hyper::header::{HeaderValue, CACHE_CONTROL, CONTENT_TYPE, COOKIE, SET_COOKIE};
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::auth::{AuthError, PairingService};
use super::http::{health_response, not_found_response, AllowedAuthority, RequestGuard};
use super::pairing::{ClaimIssued, ClaimState, PairingError, PICKUP_TIMEOUT};
use super::session::SessionIssued;

const DEFAULT_SOURCE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 20);
const MAX_CLAIM_BODY_BYTES: usize = 4096;
const DEFAULT_POLL_WINDOW: Duration = Duration::from_millis(20);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(5);

const HEALTH_PATH: &str = "/api/health";
const CLAIM_ROUTE: &str = "/api/pair/claim";
const CLAIM_POLL_PREFIX: &str = "/api/pair/claim/";

const CLAIM_COOKIE: &str = "moyu_claim";
const SESSION_COOKIE: &str = "moyus_session";
const CLAIM_COOKIE_PATH: &str = "/api/pair/claim";
const CLAIM_COOKIE_MAX_AGE: u64 = 120;
const SESSION_COOKIE_MAX_AGE: u64 = 2_592_000;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimPayload {
    pairing_id: String,
    device_name: String,
    claim_nonce: String,
}

/// Test-only pair router bound to one exact authority.
struct TestRouter {
    guard: RequestGuard,
    service: Arc<PairingService>,
    origin: String,
    poll_window: Duration,
    poll_interval: Duration,
}

impl TestRouter {
    fn new(service: Arc<PairingService>, addr: SocketAddr) -> Self {
        let authority = AllowedAuthority::for_test(addr).expect("IPv4 authority");
        let origin = authority.origin().to_owned();
        Self {
            guard: RequestGuard::for_test(authority),
            service,
            origin,
            poll_window: DEFAULT_POLL_WINDOW,
            poll_interval: DEFAULT_POLL_INTERVAL,
        }
    }

    async fn handle(&self, request: Request<Full<Bytes>>) -> Response<Full<Bytes>> {
        if let Err(status) = self.guard.check(&request) {
            return guard_error_response(status);
        }

        let method = request.method().clone();
        let path = request.uri().path().to_owned();

        if method == Method::GET && path == HEALTH_PATH {
            return health_response();
        }
        if method == Method::POST && path == CLAIM_ROUTE {
            return self.claim(request).await;
        }
        if method == Method::GET {
            if let Some(claim_id) = poll_claim_id(&path) {
                return self.poll(request, claim_id).await;
            }
        }
        not_found_response()
    }

    async fn claim(&self, request: Request<Full<Bytes>>) -> Response<Full<Bytes>> {
        let source_ip = request
            .extensions()
            .get::<TestSourceIp>()
            .map_or(DEFAULT_SOURCE_IP, |extension| extension.0);

        let body = request.into_body();
        // A `Full` body always knows its exact length; the post-read check
        // below still guards a body that reports a missing/inaccurate hint.
        if body
            .size_hint()
            .exact()
            .is_some_and(|length| length > MAX_CLAIM_BODY_BYTES as u64)
        {
            return body_too_large_response();
        }
        let Some(bytes) = body.into_inner() else {
            return invalid_parameter_response();
        };
        if bytes.len() > MAX_CLAIM_BODY_BYTES {
            return body_too_large_response();
        }
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

    async fn poll(&self, request: Request<Full<Bytes>>, claim_id: &str) -> Response<Full<Bytes>> {
        let Some(secret) = claim_cookie(request.headers()) else {
            return error_response(StatusCode::UNAUTHORIZED, "unauthorized", None);
        };

        // A trusted pickup attempt is a state change and is answered by the
        // atomic consume precheck, before the read-only status read. `status`
        // removes a terminal claim as soon as it hands out the one-time
        // receipt, so a pickup attempt answered after `status` could no longer
        // report 403 `pairing-denied`. The precheck is a pure no-op for every
        // terminal claim, so a rejected pickup never burns the receipt.
        // `consume` answers a still-pending claim with `pairing-not-found`;
        // only that answer falls through to the status loop.
        if self.trusted_pickup(request.headers()) {
            match self.service.consume(claim_id, secret.as_str()) {
                Ok(issued) => return consumed_response(issued),
                Err(AuthError::Pairing(PairingError::NotFound)) => {}
                Err(error) => return auth_error_response(&error),
            }
        }

        // Long-poll on the monotonic clock; the state machines keep their own
        // injected clock, so only the polling window uses wall-independent
        // `Instant`.
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
                        // Pickup is a state change: exact Origin and the
                        // custom header are required in addition to the claim
                        // cookie. A failed check never consumes the claim.
                        if !self.trusted_pickup(request.headers()) {
                            return guard_error_response(StatusCode::FORBIDDEN);
                        }
                        return match self.service.consume(claim_id, secret.as_str()) {
                            Ok(issued) => consumed_response(issued),
                            Err(error) => auth_error_response(&error),
                        };
                    }
                    ClaimState::Denied | ClaimState::Cancelled | ClaimState::Expired => {
                        // The pickup precheck above already answered trusted
                        // pickup headers with 403/410. Reaching this arm with
                        // those headers is only possible when the claim turned
                        // terminal in between; map the known state so a pickup
                        // attempt is never answered with a receipt.
                        if self.trusted_pickup(request.headers()) {
                            let error = match status.state {
                                ClaimState::Denied => PairingError::Denied,
                                ClaimState::Cancelled => PairingError::Cancelled,
                                _ => PairingError::Expired,
                            };
                            return auth_error_response(&AuthError::Pairing(error));
                        }
                        return terminal_response(status.state);
                    }
                    // `status` reports a consumed claim as an error, but keep
                    // the match exhaustive and token-free if that changes.
                    ClaimState::Consumed => {
                        return auth_error_response(&AuthError::Pairing(PairingError::Consumed));
                    }
                },
                Err(error) => return auth_error_response(&error),
            }
        }
    }

    fn trusted_pickup(&self, headers: &HeaderMap) -> bool {
        single_header(headers, "origin") == Some(self.origin.as_str())
            && single_header(headers, "x-moyu-request") == Some("1")
    }
}

fn poll_claim_id(path: &str) -> Option<&str> {
    let claim_id = path.strip_prefix(CLAIM_POLL_PREFIX)?;
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
    use std::time::{Duration, Instant};

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::header::{HeaderMap, HeaderValue, COOKIE, SET_COOKIE};
    use hyper::{Method, Request, Response, StatusCode};
    use serde_json::{json, Value};

    use super::*;
    use crate::web_access::clock::test_support::FakeClock;
    use crate::web_access::pairing::{PairingStore, PairingWindow};
    use crate::web_access::session::SessionStore;

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

    /// Read-only receipt poll: the pickup-only headers are removed so the route
    /// answers the one-time terminal receipt instead of a pickup attempt.
    fn receipt_request(claim_id: &str, secret: &str) -> Request<Full<Bytes>> {
        let mut request = poll_request(claim_id, secret);
        request.headers_mut().remove("origin");
        request.headers_mut().remove("x-moyu-request");
        request
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
    async fn approved_poll_requires_origin_and_x_moyu_then_consumes_once() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(1), None).await;
        fixture.service.approve(&claim_id).expect("approval");
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let mut without_origin = poll_request(&claim_id, &secret);
        without_origin.headers_mut().remove("origin");
        let response = TestResponse::of(fixture.router.handle(without_origin).await);
        assert_eq!(response.status, StatusCode::FORBIDDEN);
        assert_eq!(response.error_code(), "forbidden");
        assert!(response.set_cookies().is_empty());

        let mut without_header = poll_request(&claim_id, &secret);
        without_header.headers_mut().remove("x-moyu-request");
        let response = TestResponse::of(fixture.router.handle(without_header).await);
        assert_eq!(response.status, StatusCode::FORBIDDEN);
        assert_eq!(response.error_code(), "forbidden");
        assert!(response.set_cookies().is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let response = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
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
        assert_eq!(fixture.service.session_slots(), (1, 0));

        let second = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(second.status, StatusCode::CONFLICT);
        assert_eq!(second.error_code(), "pairing-consumed");
        assert!(second.cookies_named(SESSION_COOKIE).is_empty());
    }

    #[tokio::test]
    async fn terminal_deny_receipt_is_one_time_and_carries_no_token() {
        let fixture = Fixture::new();
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(2), None).await;
        fixture.service.deny(&claim_id).expect("deny");

        // A pickup attempt on a denied claim is a state change: 403 with the
        // stable denied code, never a token, and it does not burn the receipt.
        let pickup = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
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
                .handle(receipt_request(&claim_id, &secret))
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
                .handle(receipt_request(&claim_id, &secret))
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
                .handle(poll_request(&claim_id, &secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::GONE);
        assert_eq!(response.error_code(), "pairing-expired");
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        assert!(!response.text().contains("moyus_"));
        assert!(!response.text().contains(&secret));
        // The timed-out pickup releases the reserved session slot.
        assert_eq!(fixture.service.session_slots(), (0, 0));
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
                .handle(poll_request(&claim_id, &wrong_secret))
                .await,
        );
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(response.error_code(), "pairing-not-found");
        assert!(response.cookies_named(SESSION_COOKIE).is_empty());
        assert_eq!(fixture.service.session_slots(), (0, 1));

        let response = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &secret))
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
            (Method::POST, HEALTH_PATH),
            (Method::GET, "/api/unknown"),
            (Method::DELETE, "/api/pair/claim/claim_x"),
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
    async fn pending_long_poll_waits_for_the_window_then_returns_pending() {
        let mut fixture = Fixture::new();
        fixture.router.poll_window = Duration::from_millis(30);
        fixture.router.poll_interval = Duration::from_millis(5);
        let (claim_id, secret) = claim_over_http(&fixture, &nonce(4), None).await;

        // A read-only pending poll may omit Origin and X-Moyu-Request; only
        // the approved pickup is a state change.
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

        let poll_response = TestResponse::of(
            fixture
                .router
                .handle(poll_request(&claim_id, &claim_secret))
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
}
