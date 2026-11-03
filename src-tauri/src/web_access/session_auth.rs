//! D2 session-cookie parsing and authentication gate.
//!
//! This module only resolves an already-issued `moyus_session` cookie through
//! the existing [`PairingService`]/[`SessionStore`] state machine. It mounts no
//! route and owns no token store. Activity refresh remains explicit: the
//! authentication path never calls `refresh_activity`.

use std::fmt;
use std::time::Instant;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{HeaderValue, COOKIE, SET_COOKIE};
use hyper::{Request, Response};
use zeroize::Zeroizing;

use super::auth::PairingService;
use super::session::{refresh_trigger_for, RefreshOutcome, SessionError, SessionView};

/// The only session credential carrier accepted by D2.
pub(crate) const SESSION_COOKIE: &str = "moyus_session";

/// Frozen sliding cookie lifetime. Refresh cookies never exceed this value.
pub(crate) const SESSION_COOKIE_MAX_AGE_SECS: u64 = 2_592_000;

const TOKEN_PREFIX: &str = "moyus_";
const TOKEN_SUFFIX_LEN: usize = 43;
const TOKEN_LEN: usize = TOKEN_PREFIX.len() + TOKEN_SUFFIX_LEN;

/// Stable authentication failure. It intentionally carries no session id,
/// token, hash, or device information.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionAuthError {
    Unauthorized,
}

impl SessionAuthError {
    pub(crate) const CODE: &'static str = "unauthorized";

    pub(crate) fn code(self) -> &'static str {
        Self::CODE
    }
}

/// Parse exactly one well-formed `moyus_session` cookie.
///
/// A missing header, duplicate `Cookie` headers, duplicate `moyus_session`
/// entries, malformed cookie segments, an empty value, a wrong prefix/length,
/// or a non-base64url suffix all yield `None` (fail closed). Other cookies are
/// ignored. The returned token is zeroized on drop.
pub(crate) fn session_token<B>(request: &Request<B>) -> Option<Zeroizing<String>> {
    let mut headers = request.headers().get_all(COOKIE).iter();
    let header = headers.next()?;
    if headers.next().is_some() {
        return None;
    }

    let text = header.to_str().ok()?;
    let mut found: Option<&str> = None;
    for pair in text.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let (name, value) = pair.split_once('=')?;
        if name.trim() != SESSION_COOKIE {
            continue;
        }
        let value = value.trim();
        if found.is_some() || !is_valid_session_token(value) {
            return None;
        }
        found = Some(value);
    }

    found.map(|token| Zeroizing::new(token.to_owned()))
}

/// An authenticated request identity. The token is retained only so the same
/// request can reissue its refresh cookie without parsing a second time; both
/// fields are crate-private and Debug redacts the token.
pub(crate) struct AuthenticatedSession {
    pub(crate) view: SessionView,
    pub(crate) token: Zeroizing<String>,
}

impl fmt::Debug for AuthenticatedSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedSession")
            .field("view", &self.view)
            .finish_non_exhaustive()
    }
}

/// Resolve the request cookie through the existing session state machine.
///
/// This function never refreshes. All missing/invalid/expired/revoked states
/// collapse into the same stable `unauthorized` error so callers cannot
/// distinguish them.
pub(crate) fn authenticate_request<B>(
    request: &Request<B>,
    service: &PairingService,
) -> Result<AuthenticatedSession, SessionAuthError> {
    let token = session_token(request).ok_or(SessionAuthError::Unauthorized)?;
    let view = service
        .authenticate(token.as_str())
        .ok_or(SessionAuthError::Unauthorized)?;
    Ok(AuthenticatedSession { view, token })
}

/// Build the refresh `Set-Cookie` value for an already-validated token.
///
/// `max_age` is clamped to the frozen 30-day sliding lifetime; zero/expired
/// lifetimes return `None` rather than deleting the browser cookie. Returns
/// `None` instead of panicking on malformed token input.
pub(crate) fn session_cookie(token: &str, max_age: u64) -> Option<HeaderValue> {
    if !is_valid_session_token(token) || max_age == 0 {
        return None;
    }
    let max_age = max_age.min(SESSION_COOKIE_MAX_AGE_SECS);
    let value = Zeroizing::new(format!(
        "{SESSION_COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={max_age}"
    ));
    HeaderValue::from_str(value.as_str()).ok()
}

/// Apply the frozen refresh classifier to an already-authenticated request.
/// Unknown paths, metadata/thumb reads, and failed progress writes return
/// `Ok(None)` and never touch the session. The caller must invoke this only
/// after the route produced a 2xx/304 response.
pub(crate) fn refresh_for_request(
    service: &PairingService,
    session: &SessionView,
    method: &str,
    path: &str,
    progress_changed: bool,
) -> Result<Option<RefreshOutcome>, SessionError> {
    match refresh_trigger_for(method, path, progress_changed) {
        Some(trigger) => service.refresh_activity(session, trigger).map(Some),
        None => Ok(None),
    }
}

/// Append the refresh `Set-Cookie` when the shared classifier allows it.
///
/// `method` and `progress_changed` are explicit arguments so the same helper
/// can serve the read plane (`GET`, false) and the progress write plane
/// (`PUT`, CAS-changed). A hardcoded `GET`/`false` would silently suppress
/// write refreshes if the helper were reused.
pub(crate) fn apply_refresh_cookie(
    service: &PairingService,
    session: &AuthenticatedSession,
    method: &str,
    path: &str,
    progress_changed: bool,
    response: &mut Response<Full<Bytes>>,
) {
    let Ok(Some(RefreshOutcome::Refreshed { expires_at, .. })) =
        refresh_for_request(service, &session.view, method, path, progress_changed)
    else {
        return;
    };
    let max_age = expires_at
        .saturating_duration_since(Instant::now())
        .as_secs();
    if let Some(cookie) = session_cookie(session.token.as_str(), max_age) {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
}

fn is_valid_session_token(token: &str) -> bool {
    if token.len() != TOKEN_LEN {
        return false;
    }
    let Some(suffix) = token.strip_prefix(TOKEN_PREFIX) else {
        return false;
    };
    suffix.len() == TOKEN_SUFFIX_LEN
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::header::{HeaderValue, AUTHORIZATION, COOKIE, REFERER};
    use hyper::{Method, Request};

    use super::*;
    use crate::web_access::auth::PairingService;
    use crate::web_access::clock::test_support::FakeClock;
    use crate::web_access::pairing::PairingStore;
    use crate::web_access::session::{
        RefreshOutcome, RefreshTrigger, SessionError, SessionIssued, SessionStore, SessionView,
    };

    const VALID_SUFFIX_LEN: usize = 43;

    fn request(cookie: Option<&str>) -> Request<Full<Bytes>> {
        let mut builder = Request::builder().method(Method::GET).uri("/api/books");
        if let Some(cookie) = cookie {
            builder = builder.header(COOKIE, cookie);
        }
        builder.body(Full::new(Bytes::new())).expect("test request")
    }

    fn request_with(method: Method, uri: &str, cookie: &str) -> Request<Full<Bytes>> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(COOKIE, cookie)
            .body(Full::new(Bytes::new()))
            .expect("test request")
    }

    fn service_with_session(clock: Arc<FakeClock>) -> (PairingService, SessionIssued) {
        let session = SessionStore::new(clock.clone());
        let issued = session.create_for_test("Pixel 8");
        let service = PairingService::new(PairingStore::new(clock), session);
        (service, issued)
    }

    fn cookie_value(issued: &SessionIssued) -> String {
        format!("{}={}", SESSION_COOKIE, issued.token.as_str())
    }

    fn view_for(service: &PairingService, issued: &SessionIssued) -> SessionView {
        service
            .authenticate(issued.token.as_str())
            .expect("issued session")
    }

    fn assert_unauthorized(request: &Request<Full<Bytes>>, service: &PairingService) {
        let error = authenticate_request(request, service).expect_err("must reject");
        assert_eq!(error, SessionAuthError::Unauthorized);
        assert_eq!(error.code(), "unauthorized");
    }

    #[test]
    fn missing_cookie_is_stable_unauthorized() {
        let (service, _) = service_with_session(FakeClock::shared());
        assert!(session_token(&request(None)).is_none());
        assert!(session_token(&request(Some("theme=dark"))).is_none());
        assert_unauthorized(&request(None), &service);
        assert_unauthorized(&request(Some("theme=dark")), &service);
        assert_eq!(SessionAuthError::Unauthorized.code(), "unauthorized");
    }

    #[test]
    fn malformed_cookie_is_unauthorized() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let valid = issued.token.as_str();
        let cases = [
            String::new(),
            format!("{SESSION_COOKIE}="),
            format!("{SESSION_COOKIE}={}", "a".repeat(VALID_SUFFIX_LEN - 1)),
            format!("{SESSION_COOKIE}=notmoyus_{}", "a".repeat(VALID_SUFFIX_LEN)),
            format!("{SESSION_COOKIE}=\"{valid}\""),
            format!("{SESSION_COOKIE}={valid}="),
            format!("{SESSION_COOKIE}=moyus_{}", "!".repeat(VALID_SUFFIX_LEN)),
            format!("MOYUS_SESSION={valid}"),
            format!("{SESSION_COOKIE}2={valid}"),
            format!("moyus_{}", "a".repeat(VALID_SUFFIX_LEN)),
            format!("{SESSION_COOKIE}={}", "a".repeat(VALID_SUFFIX_LEN + 1)),
            "moyus_session".to_string(),
            format!("{SESSION_COOKIE}={valid}; broken"),
        ];

        for cookie in cases {
            let request = request(Some(&cookie));
            assert!(
                session_token(&request).is_none(),
                "malformed cookie was accepted: {cookie}"
            );
            assert_unauthorized(&request, &service);
        }
    }

    #[test]
    fn duplicate_cookie_is_unauthorized() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let valid = cookie_value(&issued);

        let same_header = format!("{valid}; {valid}");
        let same_header_request = request(Some(&same_header));
        assert!(session_token(&same_header_request).is_none());
        assert_unauthorized(&same_header_request, &service);

        let mut two_headers = request(Some(&valid));
        two_headers.headers_mut().append(
            COOKIE,
            HeaderValue::from_str(&format!("other=x; {valid}")).expect("cookie header"),
        );
        assert!(session_token(&two_headers).is_none());
        assert_unauthorized(&two_headers, &service);

        let mut split_headers = request(Some("theme=dark"));
        split_headers.headers_mut().append(
            COOKIE,
            HeaderValue::from_str(&valid).expect("cookie header"),
        );
        assert!(session_token(&split_headers).is_none());
        assert_unauthorized(&split_headers, &service);
    }

    #[test]
    fn non_utf8_cookie_header_is_unauthorized() {
        let (service, _) = service_with_session(FakeClock::shared());
        let mut request = request(None);
        request.headers_mut().insert(
            COOKIE,
            HeaderValue::from_bytes(b"moyus_session=\xff").expect("obs-text header"),
        );
        assert!(session_token(&request).is_none());
        assert_unauthorized(&request, &service);
    }

    #[test]
    fn invalid_token_is_unauthorized() {
        let (service, _) = service_with_session(FakeClock::shared());
        let token = format!("moyus_{}", "A".repeat(VALID_SUFFIX_LEN));
        let request = request(Some(&format!("{SESSION_COOKIE}={token}")));

        let parsed = session_token(&request).expect("well-formed cookie");
        assert_eq!(parsed.as_str(), token.as_str());
        assert!(service.authenticate(&token).is_none());
        assert_unauthorized(&request, &service);
    }

    #[test]
    fn expired_session_is_unauthorized() {
        let clock = FakeClock::shared();
        let (service, issued) = service_with_session(clock.clone());
        let view = view_for(&service, &issued);
        clock.advance(Duration::from_secs(31 * 24 * 60 * 60));

        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::PageRead),
            Err(SessionError::Expired)
        ));
        assert!(service.authenticate(issued.token.as_str()).is_none());
        assert_unauthorized(&request(Some(&cookie_value(&issued))), &service);
    }

    #[test]
    fn revoked_session_is_unauthorized() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let view = view_for(&service, &issued);
        assert!(service.revoke_device(&issued.id));

        assert!(service.authenticate(issued.token.as_str()).is_none());
        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::PageRead),
            Err(SessionError::Unauthorized)
        ));
        assert_unauthorized(&request(Some(&cookie_value(&issued))), &service);
    }

    #[test]
    fn valid_session_authenticates_without_exposing_secrets() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let request = request(Some(&format!("theme=dark; {}", cookie_value(&issued))));

        let authenticated = authenticate_request(&request, &service).expect("valid session");
        let view = &authenticated.view;
        assert_eq!(view.id, issued.id);
        assert_eq!(view.device_name, "Pixel 8");
        assert_eq!(authenticated.token.as_str(), issued.token.as_str());

        let auth_debug = format!("{authenticated:?}");
        assert!(!auth_debug.contains(issued.token.as_str()));
        assert!(!auth_debug.contains("token"));
        assert!(!auth_debug.contains("hash"));

        let service_debug = format!("{service:?}");
        assert!(!service_debug.contains(issued.token.as_str()));
        assert!(!service_debug.contains("token_hash"));
    }

    #[test]
    fn revocation_immediately_invalidates_authentication() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let request = request(Some(&cookie_value(&issued)));

        assert!(authenticate_request(&request, &service).is_ok());
        assert!(service.revoke_device(&issued.id));
        assert_unauthorized(&request, &service);
    }

    #[test]
    fn authentication_never_refreshes_the_session() {
        let clock = FakeClock::shared();
        let (service, issued) = service_with_session(clock.clone());
        let request = request(Some(&cookie_value(&issued)));

        let first = authenticate_request(&request, &service).expect("valid session");
        let first_expiry = first.view.expires_at;
        clock.advance(Duration::from_secs(70 * 60));
        let second = authenticate_request(&request, &service).expect("still live");
        assert_eq!(second.view.expires_at, first_expiry);
    }

    #[test]
    fn authentication_gate_does_not_depend_on_route_or_method() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let request = request_with(
            Method::POST,
            "/not-a-production-route",
            &cookie_value(&issued),
        );
        assert!(authenticate_request(&request, &service).is_ok());
    }

    #[test]
    fn only_the_session_cookie_is_a_credential() {
        let (service, issued) = service_with_session(FakeClock::shared());
        let token = issued.token.as_str();

        let bearer = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .body(Full::new(Bytes::new()))
            .expect("bearer request");
        assert_unauthorized(&bearer, &service);

        let query = Request::builder()
            .method(Method::GET)
            .uri(format!("/api/books?token={token}"))
            .body(Full::new(Bytes::new()))
            .expect("query request");
        assert_unauthorized(&query, &service);

        let referer = Request::builder()
            .method(Method::GET)
            .uri("/api/books")
            .header(REFERER, format!("https://192.168.1.10:8443/?token={token}"))
            .body(Full::new(Bytes::new()))
            .expect("referer request");
        assert_unauthorized(&referer, &service);
    }

    #[test]
    fn refresh_follows_explicit_triggers_and_throttle() {
        let clock = FakeClock::shared();
        let (service, issued) = service_with_session(clock.clone());
        let view = view_for(&service, &issued);

        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::PageRead),
            Ok(RefreshOutcome::NotRefreshed)
        ));

        clock.advance(Duration::from_secs(61 * 60));
        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::TileRead),
            Ok(RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::TileRead,
                ..
            })
        ));

        clock.advance(Duration::from_secs(10 * 60));
        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::ProgressChanged),
            Ok(RefreshOutcome::NotRefreshed)
        ));

        clock.advance(Duration::from_secs(51 * 60));
        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::ProgressChanged),
            Ok(RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::ProgressChanged,
                ..
            })
        ));
    }

    #[test]
    fn refresh_respects_the_absolute_deadline() {
        let clock = FakeClock::shared();
        let (service, issued) = service_with_session(clock.clone());
        let view = view_for(&service, &issued);
        let absolute = view.absolute_expires_at;

        // Keep the sliding window alive with eligible reads; the final
        // refresh must be capped at the immutable 90-day absolute deadline.
        for _ in 0..3 {
            clock.advance(Duration::from_secs(29 * 24 * 60 * 60));
            let outcome = service
                .refresh_activity(&view, RefreshTrigger::PageRead)
                .expect("refresh");
            if let RefreshOutcome::Refreshed { expires_at, .. } = outcome {
                assert!(expires_at <= absolute);
            } else {
                panic!("expected refresh while below the absolute deadline");
            }
        }
        let final_view = service
            .authenticate(issued.token.as_str())
            .expect("still live at 87 days");
        assert_eq!(final_view.expires_at, absolute);

        clock.advance(Duration::from_secs(3 * 24 * 60 * 60));
        assert!(matches!(
            service.refresh_activity(&view, RefreshTrigger::PageRead),
            Err(SessionError::Expired)
        ));
        assert!(service.authenticate(issued.token.as_str()).is_none());
    }

    #[test]
    fn refresh_is_limited_to_the_frozen_classifier() {
        let clock = FakeClock::shared();
        let (service, issued) = service_with_session(clock.clone());
        let view = view_for(&service, &issued);
        let id = "a".repeat(64);
        clock.advance(Duration::from_secs(61 * 60));

        let before = service
            .authenticate(issued.token.as_str())
            .expect("live session")
            .expires_at;
        assert!(matches!(
            refresh_for_request(&service, &view, "GET", "/api/books", false),
            Ok(None)
        ));
        assert_eq!(
            service
                .authenticate(issued.token.as_str())
                .expect("live session")
                .expires_at,
            before
        );

        let page = format!("/api/books/{id}/pages/0");
        assert!(matches!(
            refresh_for_request(&service, &view, "GET", &page, false),
            Ok(Some(RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::PageRead,
                ..
            }))
        ));

        clock.advance(Duration::from_secs(61 * 60));
        let tile = format!("/api/books/{id}/pages/0/tiles/0");
        assert!(matches!(
            refresh_for_request(&service, &view, "GET", &tile, false),
            Ok(Some(RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::TileRead,
                ..
            }))
        ));

        clock.advance(Duration::from_secs(61 * 60));
        let progress = format!("/api/books/{id}/progress");
        assert!(matches!(
            refresh_for_request(&service, &view, "PUT", &progress, false),
            Ok(None)
        ));
        assert!(matches!(
            refresh_for_request(&service, &view, "PUT", &progress, true),
            Ok(Some(RefreshOutcome::Refreshed {
                trigger: RefreshTrigger::ProgressChanged,
                ..
            }))
        ));
    }

    #[test]
    fn refresh_cookie_has_frozen_attributes_and_no_domain() {
        let (_, issued) = service_with_session(FakeClock::shared());
        let cookie = session_cookie(issued.token.as_str(), 1234).expect("valid token");
        let text = cookie.to_str().expect("ascii cookie");

        assert!(text.starts_with(&format!("{SESSION_COOKIE}={}", issued.token.as_str())));
        for attribute in [
            "HttpOnly",
            "Secure",
            "SameSite=Strict",
            "Path=/",
            "Max-Age=1234",
        ] {
            assert!(text.contains(attribute), "missing {attribute}: {text}");
        }
        assert!(!text.contains("Domain="));
        assert!(!text.contains("Expires="));
        assert!(!text.contains("SameSite=None"));
        assert!(session_cookie("moyus_short", 1234).is_none());
    }

    #[test]
    fn refresh_cookie_clamps_max_age_and_rejects_zero() {
        let (_, issued) = service_with_session(FakeClock::shared());
        assert!(session_cookie(issued.token.as_str(), 0).is_none());
        let cookie = session_cookie(issued.token.as_str(), u64::MAX).expect("valid token");
        let text = cookie.to_str().expect("ascii cookie");
        assert!(
            text.contains(&format!("Max-Age={SESSION_COOKIE_MAX_AGE_SECS}")),
            "{text}"
        );
    }

    #[test]
    fn refresh_cookie_rejects_header_metacharacters() {
        let semicolon = format!("moyus_{};", "a".repeat(42));
        assert_eq!(semicolon.len(), 49);
        assert!(session_cookie(&semicolon, 1234).is_none());

        let crlf = format!("moyus_{}\r\n", "a".repeat(41));
        assert_eq!(crlf.len(), 49);
        assert!(session_cookie(&crlf, 1234).is_none());
    }
}
