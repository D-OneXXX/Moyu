//! Current-device session management; the caller applies the shared request guard.
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, SET_COOKIE};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::json;

use super::auth::PairingService;
use super::http::X_REQUEST_ID;
use super::secret::random_hex;
use super::session_auth::authenticate_request;

pub(crate) fn handle<B>(
    request: &Request<B>,
    service: &PairingService,
) -> Option<Response<Full<Bytes>>> {
    if request.uri().path() != "/api/session"
        || !matches!(*request.method(), Method::GET | Method::DELETE)
    {
        return None;
    }
    let session = match authenticate_request(request, service) {
        Ok(session) => session,
        Err(_) => {
            let id = random_hex(8);
            let body = json!({"error": {"code": "unauthorized", "requestId": id}}).to_string();
            return Some(
                Response::builder()
                    .status(StatusCode::UNAUTHORIZED)
                    .header(CACHE_CONTROL, "no-store")
                    .header(CONTENT_TYPE, "application/json; charset=utf-8")
                    .header(X_REQUEST_ID, id)
                    .body(Full::new(Bytes::from(body)))
                    .expect("static response"),
            );
        }
    };
    if *request.method() == Method::DELETE {
        service.revoke_device(&session.view.id);
        return Some(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(CACHE_CONTROL, "no-store")
                .header(
                    SET_COOKIE,
                    "moyus_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
                )
                .body(Full::new(Bytes::new()))
                .expect("static response"),
        );
    }
    let view = session.view;
    let body = json!({
        "deviceId": view.id,
        "deviceName": view.device_name,
        "createdAt": view.created_at.to_rfc3339(),
        "lastSeenAt": view.last_seen_at.to_rfc3339(),
    })
    .to_string();
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(CACHE_CONTROL, "no-store")
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Full::new(Bytes::from(body)))
            .expect("static response"),
    )
}
