//! Explicit opt-in unencrypted private-LAN listener. No system changes.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use hyper::header::{HeaderValue, COOKIE, SET_COOKIE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::{watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use super::addrs::is_private_lan_ipv4;
use super::error::{WebAccessError, WebAccessResult};
use super::http::{HEADER_READ_TIMEOUT, HTTP_CONNECTION_TIMEOUT};
use super::tls::{ConnectionLimiter, HandlerFactory, MAX_ACTIVE_CONNECTIONS};

pub(crate) struct PlainServerHandle {
    local_addr: SocketAddr,
    shutdown: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
}

impl PlainServerHandle {
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
    pub(crate) fn is_running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }
    pub(crate) async fn shutdown(mut self) -> WebAccessResult<()> {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(true);
        }
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| WebAccessError::ServerJoin)?;
        }
        Ok(())
    }
}
impl Drop for PlainServerHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(true);
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Rewrite only our HTTP-mode cookies into separate names so HTTPS cookies on
/// the same host cannot be overwritten or mistaken for LAN HTTP sessions.
fn inbound_cookies(headers: &mut hyper::HeaderMap) {
    let values = headers.get_all(COOKIE).iter().cloned().collect::<Vec<_>>();
    headers.remove(COOKIE);
    for value in values {
        let Ok(value) = value.to_str() else {
            headers.append(COOKIE, value);
            continue;
        };
        let parts = value
            .split(';')
            .filter_map(|part| {
                let trimmed = part.trim();
                let Some((name, rest)) = trimmed.split_once('=') else {
                    return Some(trimmed.to_owned());
                };
                match name.trim() {
                    "moyus_session" | "moyu_claim" => None,
                    "moyul_session" => Some(format!("moyus_session={rest}")),
                    "moyul_claim" => Some(format!("moyu_claim={rest}")),
                    _ => Some(trimmed.to_owned()),
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        if let Ok(header) = HeaderValue::from_str(&parts) {
            headers.append(COOKIE, header);
        }
    }
}

fn outbound_cookies(headers: &mut hyper::HeaderMap) {
    let values = headers
        .get_all(SET_COOKIE)
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    headers.remove(SET_COOKIE);
    for value in values {
        let Ok(text) = value.to_str() else {
            headers.append(SET_COOKIE, value);
            continue;
        };
        let replacement = if let Some(rest) = text.strip_prefix("moyus_session=") {
            format!("moyul_session={rest}")
        } else if let Some(rest) = text.strip_prefix("moyu_claim=") {
            format!("moyul_claim={rest}")
        } else {
            headers.append(SET_COOKIE, value);
            continue;
        };
        let replacement = replacement.replace("; Secure;", ";");
        if let Ok(header) = HeaderValue::from_str(&replacement) {
            headers.append(SET_COOKIE, header);
        }
    }
}

pub(crate) async fn start_plain_server(
    bind_addr: SocketAddr,
    factory: HandlerFactory,
    allow_loopback: bool,
) -> WebAccessResult<PlainServerHandle> {
    let listener = TcpListener::bind(bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let handler = factory(local_addr)?;
    let global = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS));
    let per_ip = ConnectionLimiter::new();
    let (shutdown, mut rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                changed = rx.changed() => { if changed.is_err() || *rx.borrow() { break; } }
                accepted = listener.accept() => match accepted {
                    Ok((stream, peer)) => {
                        let allowed = match peer.ip() {
                            IpAddr::V4(ip) => is_private_lan_ipv4(ip) || (allow_loopback && ip.is_loopback()),
                            IpAddr::V6(_) => false,
                        };
                        if !allowed { continue; }
                        let Ok(permit) = global.clone().try_acquire_owned() else { continue; };
                        let Some(ip_permit) = per_ip.try_acquire(peer.ip()) else { continue; };
                        let handler = handler.clone();
                        tasks.spawn(async move {
                            let _permit = permit;
                            let _ip_permit = ip_permit;
                            let service = service_fn(move |mut request| {
                                let handler = handler.clone();
                                async move {
                                    inbound_cookies(request.headers_mut());
                                    let mut response = handler(request, peer).await?;
                                    outbound_cookies(response.headers_mut());
                                    Ok::<_, std::convert::Infallible>(response)
                                }
                            });
                            let _ = tokio::time::timeout(HTTP_CONNECTION_TIMEOUT,
                                http1::Builder::new().timer(TokioTimer::new()).max_buf_size(16 * 1024)
                                .header_read_timeout(Some(HEADER_READ_TIMEOUT)).keep_alive(false)
                                .serve_connection(TokioIo::new(stream), service)).await;
                        });
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                },
                Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            }
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    });
    Ok(PlainServerHandle {
        local_addr,
        shutdown: Some(shutdown),
        task: Some(task),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_cookies_are_separate_http_only_and_preserve_ambiguity() {
        let mut headers = hyper::HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static(
                "moyus_session=secret; HttpOnly; Secure; SameSite=Strict; Path=/",
            ),
        );
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static(
                "moyu_claim=claim; HttpOnly; Secure; SameSite=Strict; Path=/api/pair/claim/",
            ),
        );
        outbound_cookies(&mut headers);
        let values = headers
            .get_all(SET_COOKIE)
            .iter()
            .map(|h| h.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(values[0].starts_with("moyul_session="));
        assert!(values[1].starts_with("moyul_claim="));
        assert!(values.iter().all(|v| v.contains("HttpOnly")
            && v.contains("SameSite=Strict")
            && !v.contains("Secure")));
        let mut request = hyper::HeaderMap::new();
        request.append(
            COOKIE,
            HeaderValue::from_static("moyus_session=oldhttps; moyul_session=abc; malformed"),
        );
        inbound_cookies(&mut request);
        assert_eq!(request.get(COOKIE).unwrap(), "moyus_session=abc; malformed");
    }
}
