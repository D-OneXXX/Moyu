//! Production-compiled HTTP request validation and static responses.
//!
//! The validation is shared by the production health-only server and by the
//! production D1b pairing router. [`RequestGuard::health_only`] is the only
//! guard used before D1b; [`RequestGuard::for_authority`] is constructed from
//! the listener's actual bound IPv4 address, never from request input,
//! environment, or settings. There is no override.

use std::net::SocketAddr;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};

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
        let SocketAddr::V4(addr) = addr else {
            return None;
        };
        let ip = addr.ip();
        Some(Self {
            authority: format!("{ip}:{}", addr.port()),
            origin: format!("https://{ip}:{}", addr.port()),
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
}
