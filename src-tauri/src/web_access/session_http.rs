//! Current-device session management; the caller applies the shared request guard.
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, SET_COOKIE};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::json;

use super::auth::PairingService;
use super::data::error_response;
use super::secret::random_hex;
use super::session_auth::authenticate_request;

type SessionResponse = Pin<Box<dyn Future<Output = Response<Full<Bytes>>> + Send>>;

pub(crate) fn handle<B>(
    request: &Request<B>,
    service: &Arc<PairingService>,
) -> Option<SessionResponse> {
    if request.uri().path() != "/api/session"
        || !matches!(*request.method(), Method::GET | Method::DELETE)
    {
        return None;
    }
    let is_delete = *request.method() == Method::DELETE;
    let session = authenticate_request(request, service);
    let service = Arc::clone(service);
    Some(Box::pin(async move {
        let session = match session {
            Ok(session) => session,
            Err(_) => {
                return error_response(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    &random_hex(8),
                    None,
                    None,
                    false,
                )
            }
        };
        if is_delete {
            let id = session.view.id;
            // Waiting for an admitted SQLite write must not block a Tokio
            // worker or prevent unrelated requests and desktop UI from running.
            if tokio::task::spawn_blocking(move || service.revoke_device(&id))
                .await
                .is_err()
            {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal-error",
                    &random_hex(8),
                    None,
                    None,
                    false,
                );
            }
            return Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(CACHE_CONTROL, "no-store")
                .header(
                    SET_COOKIE,
                    "moyus_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
                )
                .body(Full::new(Bytes::new()))
                .expect("static response");
        }
        let view = session.view;
        let body = json!({
            "deviceId": view.id,
            "deviceName": view.device_name,
            "createdAt": view.created_at.to_rfc3339(),
            "lastSeenAt": view.last_seen_at.to_rfc3339(),
        })
        .to_string();
        Response::builder()
            .status(StatusCode::OK)
            .header(CACHE_CONTROL, "no-store")
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Full::new(Bytes::from(body)))
            .expect("static response")
    }))
}
