//! Production-compiled HTTP request validation and static responses.
//!
//! The validation is shared by the production health-only server and by the
//! production D1b pairing router. [`RequestGuard::health_only`] is the only
//! guard used before D1b; [`RequestGuard::for_authority`] is constructed from
//! the listener's actual bound IPv4 address, never from request input,
//! environment, or settings. There is no override.

use std::net::SocketAddr;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};

/// Hard cap on summed request header bytes (names + values + framing slack).
/// Enforced for every profile, including the health-only production listener,
/// so an oversized header block is rejected before any route runs.
pub(crate) const HEADER_LIMIT: usize = 8 * 1024;

/// Time the peer gets to deliver the request line and all headers.
pub(crate) const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Outer bound on one HTTP/1.1 connection (headers + response).
pub(crate) const HTTP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(65);

/// Upper bound for a pairing-route handler.
pub(crate) const PAIR_HANDLER_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound for a data-route handler.
pub(crate) const DATA_HANDLER_TIMEOUT: Duration = Duration::from_secs(60);

/// Correlation header returned on every response.
pub(crate) const X_REQUEST_ID: &str = "x-request-id";

/// Adds a correlation id only when the handler did not already set one. Data
/// responses carry their own id and must not be overwritten.
pub(crate) fn with_request_id(mut response: Response<Full<Bytes>>) -> Response<Full<Bytes>> {
    if !response.headers().contains_key(X_REQUEST_ID) {
        let request_id = super::secret::random_hex(8);
        response.headers_mut().insert(
            X_REQUEST_ID,
            hyper::header::HeaderValue::from_str(&request_id).expect("request id is ascii hex"),
        );
    }
    response
}

/// The single exact authority and origin a data-plane request may use.
/// V1 binds one concrete LAN IPv4; no wildcard, `.local`, or `moyu.local`.
#[derive(Clone)]
pub(crate) struct AllowedAuthority {
    authority: String,
    origin: String,
}

impl AllowedAuthority {
    /// Construct from the listener's actual bound address. Only IPv4 is
    /// accepted; the leaf SANs are IPv4-only, so an IPv6 authority could never
    /// be verified by a client. This never reads a request, setting, or
    /// environment value.
    pub(crate) fn from_socket_addr(addr: SocketAddr) -> Option<Self> {
        Self::from_socket_addr_scheme(addr, "https")
    }

    pub(crate) fn from_socket_addr_scheme(addr: SocketAddr, scheme: &str) -> Option<Self> {
        if !matches!(scheme, "http" | "https") {
            return None;
        }
        let SocketAddr::V4(addr) = addr else {
            return None;
        };
        let ip = addr.ip();
        Some(Self {
            authority: format!("{ip}:{}", addr.port()),
            origin: format!("{scheme}://{ip}:{}", addr.port()),
        })
    }

    /// Test-only alias kept for existing D1a tests.
    #[cfg(test)]
    pub(crate) fn for_test(addr: SocketAddr) -> Option<Self> {
        Self::from_socket_addr(addr)
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
}

/// Applies the frozen Host/Origin/Sec-Fetch/X-Moyu checks before routing.
#[derive(Clone)]
pub(crate) struct RequestGuard {
    authority: Option<AllowedAuthority>,
}

impl RequestGuard {
    /// Production health-only server: no data/pairing authority is configured.
    pub(crate) fn health_only() -> Self {
        Self { authority: None }
    }

    /// Production D1b constructor for a concrete bound IPv4 authority.
    pub(crate) fn for_authority(authority: AllowedAuthority) -> Self {
        Self {
            authority: Some(authority),
        }
    }

    /// Test-only alias kept for existing D1a tests.
    #[cfg(test)]
    pub(crate) fn for_test(authority: AllowedAuthority) -> Self {
        Self::for_authority(authority)
    }

    pub(crate) fn check<B>(&self, request: &Request<B>) -> Result<(), StatusCode> {
        // Applies before the authority shortcut so the health-only profile is
        // bound by the same header budget as the data plane.
        let header_bytes = request
            .headers()
            .iter()
            .fold(0usize, |total, (name, value)| {
                total.saturating_add(name.as_str().len() + value.as_bytes().len() + 4)
            });
        if header_bytes > HEADER_LIMIT {
            return Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE);
        }

        let Some(authority) = self.authority.as_ref() else {
            return Ok(());
        };

        // Origin-form only; absolute-form can smuggle a different authority.
        if request.uri().scheme().is_some() || request.uri().authority().is_some() {
            return Err(StatusCode::MISDIRECTED_REQUEST);
        }

        let Some(host) = single_header(request, "host") else {
            return Err(StatusCode::MISDIRECTED_REQUEST);
        };
        if host != authority.authority {
            return Err(StatusCode::MISDIRECTED_REQUEST);
        }

        let site =
            optional_single_header(request, "sec-fetch-site").map_err(|_| StatusCode::FORBIDDEN)?;
        if let Some(site) = site {
            if site != "same-origin" && site != "none" {
                return Err(StatusCode::FORBIDDEN);
            }
        }

        let origin =
            optional_single_header(request, "origin").map_err(|_| StatusCode::FORBIDDEN)?;
        if let Some(origin) = origin {
            if origin != authority.origin {
                return Err(StatusCode::FORBIDDEN);
            }
        }

        let state_changing = matches!(
            *request.method(),
            Method::POST | Method::PUT | Method::DELETE | Method::PATCH
        );
        if state_changing {
            if origin.is_none() {
                return Err(StatusCode::FORBIDDEN);
            }
            if single_header(request, "x-moyu-request") != Some("1") {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        Ok(())
    }
}

/// Returns the header only when exactly one value exists and it is valid UTF-8.
/// Duplicate headers are ambiguous and therefore rejected by returning `None`.
fn single_header<'a, B>(request: &'a Request<B>, name: &str) -> Option<&'a str> {
    let mut values = request.headers().get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

/// Distinguishes an absent optional header from an ambiguous/invalid one.
/// Duplicate or non-UTF-8 values must fail closed instead of looking absent.
fn optional_single_header<'a, B>(
    request: &'a Request<B>,
    name: &str,
) -> Result<Option<&'a str>, ()> {
    let mut values = request.headers().get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    value.to_str().map(Some).map_err(|_| ())
}

pub(crate) fn empty_response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("Connection", "close")
        .body(Full::new(Bytes::new()))
        .expect("static response")
}

pub(crate) fn health_response() -> Response<Full<Bytes>> {
    empty_response(StatusCode::NO_CONTENT)
}

pub(crate) fn not_found_response() -> Response<Full<Bytes>> {
    empty_response(StatusCode::NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> RequestGuard {
        RequestGuard::for_test(
            AllowedAuthority::for_test(SocketAddr::from(([192, 168, 1, 10], 8443)))
                .expect("IPv4 authority"),
        )
    }

    fn request(method: Method, path: &str) -> hyper::http::request::Builder {
        Request::builder().method(method).uri(path)
    }

    #[test]
    fn exact_host_and_origin_pass_for_reads_and_writes() {
        let read = request(Method::GET, "/api/health")
            .header("host", "192.168.1.10:8443")
            .body(())
            .unwrap();
        assert!(guard().check(&read).is_ok());

        let write = request(Method::POST, "/api/pair/claim")
            .header("host", "192.168.1.10:8443")
            .header("origin", "https://192.168.1.10:8443")
            .header("x-moyu-request", "1")
            .body(())
            .unwrap();
        assert!(guard().check(&write).is_ok());
    }

    #[test]
    fn host_is_exact_and_rejects_duplicates_absolute_form_and_moyu_local() {
        for host in [
            "moyu.local:8443",
            "0.0.0.0:8443",
            "192.168.1.10:8444",
            "192.168.1.10",
        ] {
            let req = request(Method::GET, "/api/health")
                .header("host", host)
                .body(())
                .unwrap();
            assert!(guard().check(&req).is_err(), "{host}");
        }
        let missing = request(Method::GET, "/api/health").body(()).unwrap();
        assert!(guard().check(&missing).is_err());

        let duplicate = request(Method::GET, "/api/health")
            .header("host", "192.168.1.10:8443")
            .header("host", "moyu.local:8443")
            .body(())
            .unwrap();
        assert_eq!(
            guard().check(&duplicate),
            Err(StatusCode::MISDIRECTED_REQUEST)
        );

        let absolute = Request::builder()
            .method(Method::GET)
            .uri("http://192.168.1.10:8443/api/health")
            .header("host", "192.168.1.10:8443")
            .body(())
            .unwrap();
        assert!(guard().check(&absolute).is_err());
    }

    #[test]
    fn origin_null_wrong_and_missing_write_origin_are_rejected() {
        for origin in [
            "null",
            "https://192.168.1.10:8444",
            "http://192.168.1.10:8443",
        ] {
            let req = request(Method::POST, "/api/pair/claim")
                .header("host", "192.168.1.10:8443")
                .header("origin", origin)
                .header("x-moyu-request", "1")
                .body(())
                .unwrap();
            assert!(guard().check(&req).is_err(), "{origin}");
        }
        let missing = request(Method::POST, "/api/pair/claim")
            .header("host", "192.168.1.10:8443")
            .header("x-moyu-request", "1")
            .body(())
            .unwrap();
        assert!(guard().check(&missing).is_err());
    }

    #[test]
    fn x_moyu_is_required_only_for_state_changing_requests_and_referer_is_ignored() {
        let missing = request(Method::PUT, "/api/books/x/progress")
            .header("host", "192.168.1.10:8443")
            .header("origin", "https://192.168.1.10:8443")
            .body(())
            .unwrap();
        assert!(guard().check(&missing).is_err());

        let referer_only = request(Method::POST, "/api/pair/claim")
            .header("host", "192.168.1.10:8443")
            .header("referer", "https://192.168.1.10:8443/")
            .header("x-moyu-request", "1")
            .body(())
            .unwrap();
        assert!(guard().check(&referer_only).is_err());

        let read = request(Method::GET, "/api/health")
            .header("host", "192.168.1.10:8443")
            .header("referer", "https://evil.example/")
            .body(())
            .unwrap();
        assert!(guard().check(&read).is_ok());
    }

    #[test]
    fn duplicate_optional_headers_fail_closed_even_on_reads() {
        let duplicate_origin = request(Method::GET, "/api/health")
            .header("host", "192.168.1.10:8443")
            .header("origin", "https://192.168.1.10:8443")
            .header("origin", "https://192.168.1.10:8444")
            .body(())
            .unwrap();
        assert_eq!(guard().check(&duplicate_origin), Err(StatusCode::FORBIDDEN));

        let duplicate_site = request(Method::GET, "/api/health")
            .header("host", "192.168.1.10:8443")
            .header("sec-fetch-site", "same-origin")
            .header("sec-fetch-site", "cross-site")
            .body(())
            .unwrap();
        assert_eq!(guard().check(&duplicate_site), Err(StatusCode::FORBIDDEN));
    }

    #[test]
    fn sec_fetch_site_only_allows_same_origin_or_none() {
        for site in ["cross-site", "same-site"] {
            let req = request(Method::GET, "/api/health")
                .header("host", "192.168.1.10:8443")
                .header("sec-fetch-site", site)
                .body(())
                .unwrap();
            assert!(guard().check(&req).is_err(), "{site}");
        }
        for site in ["same-origin", "none"] {
            let req = request(Method::GET, "/api/health")
                .header("host", "192.168.1.10:8443")
                .header("sec-fetch-site", site)
                .body(())
                .unwrap();
            assert!(guard().check(&req).is_ok(), "{site}");
        }
    }

    #[test]
    fn authority_is_ipv4_only_and_uses_the_actual_socket_address() {
        let ipv4 = AllowedAuthority::from_socket_addr(SocketAddr::from(([192, 168, 1, 10], 8443)))
            .expect("IPv4 authority");
        assert_eq!(ipv4.origin(), "https://192.168.1.10:8443");
        assert!(AllowedAuthority::from_socket_addr("[::1]:8443".parse().unwrap()).is_none());
    }

    #[test]
    fn health_only_guard_does_not_enforce_authority() {
        let req = Request::builder()
            .method(Method::GET)
            .uri("/api/health")
            .header("host", "moyu.local:8443")
            .body(())
            .unwrap();
        assert!(RequestGuard::health_only().check(&req).is_ok());
    }

    #[test]
    fn oversized_headers_are_rejected_with_431_for_both_profiles() {
        let oversized = "a".repeat(9 * 1024);
        let req = request(Method::GET, "/api/health")
            .header("host", "192.168.1.10:8443")
            .header("x-pad", oversized)
            .body(())
            .unwrap();
        assert_eq!(
            guard().check(&req),
            Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE)
        );
        assert_eq!(
            RequestGuard::health_only().check(&req),
            Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE)
        );
    }

    #[test]
    fn normal_headers_are_within_the_limit_for_both_profiles() {
        let req = request(Method::POST, "/api/pair/claim")
            .header("host", "192.168.1.10:8443")
            .header("origin", "https://192.168.1.10:8443")
            .header("x-moyu-request", "1")
            .header("user-agent", "Mozilla/5.0 (integration check)")
            .body(())
            .unwrap();
        assert!(guard().check(&req).is_ok());
        assert!(RequestGuard::health_only().check(&req).is_ok());
    }

    #[test]
    fn with_request_id_adds_one_sixteen_hex_id_when_absent() {
        let response = with_request_id(health_response());
        let values = response
            .headers()
            .get_all(X_REQUEST_ID)
            .iter()
            .collect::<Vec<_>>();
        assert_eq!(values.len(), 1);
        let value = values[0].to_str().expect("ascii request id");
        assert_eq!(value.len(), 16);
        assert!(value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    }

    #[test]
    fn with_request_id_never_duplicates_or_overrides_an_existing_id() {
        let existing = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(X_REQUEST_ID, "0123456789abcdef")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = with_request_id(existing);
        assert_eq!(response.headers().get_all(X_REQUEST_ID).iter().count(), 1);
        assert_eq!(
            response
                .headers()
                .get(X_REQUEST_ID)
                .expect("request id")
                .as_bytes(),
            b"0123456789abcdef"
        );
    }
}
