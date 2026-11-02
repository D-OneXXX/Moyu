//! Short-lived plaintext HTTP distribution of the public root CA certificate.
//!
//! This is intentionally **not** part of the TLS Web Access listener. A device
//! must install the root CA before it can trust the TLS endpoint, so this
//! service is plaintext and exposes exactly one public artifact:
//! `GET /ca.crt`.
//!
//! Security boundary:
//! - the listener binds a specific private LAN IPv4 on an ephemeral port;
//! - only `GET /ca.crt` (no query) is served; every other path/method is 404;
//! - the Host header must be the exact bound `<ip>:<port>`; there is no CORS;
//! - the accept task owns only the public PEM bytes and fingerprint, never a
//!   `CaManager`, CA path, key path, or private-key reader;
//! - the service stops after an absolute TTL or an explicit stop, dropping the
//!   listener and aborting in-flight connections.
//!
//! It does not create or initialize a CA, does not start at app startup, and
//! does not implement pairing, sessions, data routes, G2 leaf renewal, or D1b.

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{
    CACHE_CONTROL, CONNECTION, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, HOST,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use crate::ca::{CaError, CaManager};

use super::addrs::{is_private_lan_ipv4, local_private_ipv4s};

/// The only path this service ever serves.
pub const CA_DISTRIBUTION_PATH: &str = "/ca.crt";
/// Absolute lifetime; no request can extend it.
pub const CA_DISTRIBUTION_TTL: Duration = Duration::from_secs(120);
/// Bound concurrent downloads; the certificate is a few KiB.
const MAX_ACTIVE_CONNECTIONS: usize = 8;
/// A connection may not keep a slot forever.
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const CERTIFICATE_CONTENT_TYPE: &str = "application/x-x509-ca-cert";
const CERTIFICATE_FILENAME: &str = "moyu-root-ca.crt";

/// Stable failure classes for the distribution control path.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CaDistributionError {
    #[error("CA error: {0}")]
    Ca(#[from] CaError),
    #[error("CA distribution is already running")]
    AlreadyRunning,
    #[error("no private LAN IPv4 address is available")]
    NoLanAddress,
    #[error("CA distribution bind address must be a private LAN IPv4")]
    InvalidBindAddress,
    #[error("CA distribution I/O failed")]
    Io(#[from] std::io::Error),
}

impl CaDistributionError {
    /// Stable code consumed by command/UI localization.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Ca(error) => error.code(),
            Self::AlreadyRunning => "ca-distribution-running",
            Self::NoLanAddress => "ca-distribution-no-lan",
            Self::InvalidBindAddress => "ca-distribution-invalid-ip",
            Self::Io(_) => "ca-distribution-io",
        }
    }
}

pub(crate) type CaDistributionResult<T> = Result<T, CaDistributionError>;

/// Why a running distribution stopped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum CaDistributionStopReason {
    Expired,
    Stopped,
}

impl CaDistributionStopReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Stopped => "stopped",
        }
    }
}

/// Snapshot returned to commands and the settings UI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CaDistributionStatus {
    pub running: bool,
    pub url: Option<String>,
    pub expires_at_unix_ms: Option<i64>,
    pub stop_reason: Option<CaDistributionStopReason>,
    /// Fingerprint of the certificate this run actually serves, so the UI
    /// never displays a fingerprint from a different CA snapshot.
    pub root_fingerprint_sha256: Option<String>,
}

struct RunningDistribution {
    run_id: u64,
    url: String,
    expires_at_unix_ms: i64,
    root_fingerprint_sha256: String,
    shutdown: Option<oneshot::Sender<CaDistributionStopReason>>,
    task: JoinHandle<()>,
}

struct RuntimeState {
    running: Option<RunningDistribution>,
    last_stop_reason: Option<CaDistributionStopReason>,
    next_run_id: u64,
}

/// Process-wide distribution runtime. Managed by Tauri, created at setup, but
/// never started until an explicit command.
pub(crate) struct CaDistributionRuntime {
    ca_root: PathBuf,
    ttl: Duration,
    port: u16,
    /// Test-only escape hatch for loopback/fixed-port tests. Release builds
    /// cannot construct this state.
    test_allow_loopback: bool,
    state: Arc<Mutex<RuntimeState>>,
}

impl CaDistributionRuntime {
    pub(crate) fn new(ca_root: PathBuf) -> Self {
        Self {
            ca_root,
            ttl: CA_DISTRIBUTION_TTL,
            port: 0,
            test_allow_loopback: false,
            state: Arc::new(Mutex::new(RuntimeState {
                running: None,
                last_stop_reason: None,
                next_run_id: 0,
            })),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(ca_root: PathBuf, ttl: Duration, port: u16) -> Self {
        Self {
            ca_root,
            ttl,
            port,
            test_allow_loopback: true,
            state: Arc::new(Mutex::new(RuntimeState {
                running: None,
                last_stop_reason: None,
                next_run_id: 0,
            })),
        }
    }

    pub(crate) fn ca_root(&self) -> &std::path::Path {
        &self.ca_root
    }

    pub(crate) fn addresses(&self) -> Vec<Ipv4Addr> {
        local_private_ipv4s().unwrap_or_default()
    }

    /// Start on the first current private LAN IPv4 when the caller did not
    /// choose one. No address is a stable failure, never a wildcard bind.
    pub(crate) async fn start_default(&self) -> CaDistributionResult<CaDistributionStatus> {
        let ips = local_private_ipv4s().map_err(|_| CaDistributionError::NoLanAddress)?;
        self.start(choose_bind_ip(ips)?).await
    }

    pub(crate) async fn status(&self) -> CaDistributionStatus {
        let state = self.state.lock().await;
        Self::status_from(&state)
    }

    /// Bind and start the service. The CA must already be initialized and
    /// healthy; a failure happens before any port is exposed.
    pub(crate) async fn start(
        &self,
        bind_ip: Ipv4Addr,
    ) -> CaDistributionResult<CaDistributionStatus> {
        if !self.test_allow_loopback {
            validate_bind_ip(bind_ip)?;
        }

        let mut state = self.state.lock().await;
        if state.running.is_some() {
            return Err(CaDistributionError::AlreadyRunning);
        }

        // Read only the public certificate snapshot. The manager and the CA
        // root path are not moved into the accept task.
        let certificate = CaManager::new(self.ca_root.clone()).root_certificate()?;
        let listener = TcpListener::bind(SocketAddr::from((bind_ip, self.port))).await?;
        let local_addr = listener.local_addr()?;
        let authority = local_addr.to_string();
        let url = format!("http://{authority}{CA_DISTRIBUTION_PATH}");
        let expires_at_unix_ms = now_unix_ms().saturating_add(duration_millis(self.ttl));

        state.next_run_id = state.next_run_id.wrapping_add(1);
        let run_id = state.next_run_id;
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let body = Bytes::from(certificate.cert_pem);
        let fingerprint = certificate.fingerprint_sha256;
        let task = tokio::spawn(accept_loop(
            listener,
            Arc::<str>::from(authority),
            body,
            self.ttl,
            shutdown_rx,
            Arc::clone(&self.state),
            run_id,
        ));

        state.running = Some(RunningDistribution {
            run_id,
            url,
            expires_at_unix_ms,
            root_fingerprint_sha256: fingerprint,
            shutdown: Some(shutdown_tx),
            task,
        });
        Ok(Self::status_from(&state))
    }

    /// Stop the current service and wait for its listener to close. Repeated
    /// calls are idempotent and return the current snapshot.
    pub(crate) async fn stop(&self) -> CaDistributionStatus {
        let running = {
            let mut state = self.state.lock().await;
            state.running.take()
        };
        let Some(running) = running else {
            return self.status().await;
        };
        if let Some(shutdown) = running.shutdown {
            let _ = shutdown.send(CaDistributionStopReason::Stopped);
        }
        let _ = running.task.await;
        let mut state = self.state.lock().await;
        state.last_stop_reason = Some(CaDistributionStopReason::Stopped);
        Self::status_from(&state)
    }

    fn status_from(state: &RuntimeState) -> CaDistributionStatus {
        match &state.running {
            Some(running) => CaDistributionStatus {
                running: true,
                url: Some(running.url.clone()),
                expires_at_unix_ms: Some(running.expires_at_unix_ms),
                stop_reason: None,
                root_fingerprint_sha256: Some(running.root_fingerprint_sha256.clone()),
            },
            None => CaDistributionStatus {
                running: false,
                url: None,
                expires_at_unix_ms: None,
                stop_reason: state.last_stop_reason,
                root_fingerprint_sha256: None,
            },
        }
    }
}

/// Production binding must be a current private LAN IPv4. Loopback, public,
/// link-local, unspecified and multicast addresses are rejected here; tests use
/// the `for_test` constructor and never exercise this bypass in release.
pub(crate) fn validate_bind_ip(ip: Ipv4Addr) -> CaDistributionResult<()> {
    if is_private_lan_ipv4(ip) {
        Ok(())
    } else {
        Err(CaDistributionError::InvalidBindAddress)
    }
}

pub(crate) fn choose_bind_ip(ips: Vec<Ipv4Addr>) -> CaDistributionResult<Ipv4Addr> {
    ips.into_iter()
        .next()
        .ok_or(CaDistributionError::NoLanAddress)
}

async fn accept_loop(
    listener: TcpListener,
    authority: Arc<str>,
    body: Bytes,
    ttl: Duration,
    mut shutdown: oneshot::Receiver<CaDistributionStopReason>,
    state: Arc<Mutex<RuntimeState>>,
    run_id: u64,
) {
    let connections = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS));
    let mut tasks = JoinSet::new();
    let timer = tokio::time::sleep(ttl);
    tokio::pin!(timer);

    let reason = loop {
        tokio::select! {
            reason = &mut shutdown => {
                break reason.unwrap_or(CaDistributionStopReason::Stopped);
            }
            _ = &mut timer => break CaDistributionStopReason::Expired,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        let permit = match connections.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                // Bound concurrent downloads without blocking
                                // the accept loop.
                                drop(stream);
                                continue;
                            }
                        };
                        let body = body.clone();
                        let authority = Arc::clone(&authority);
                        tasks.spawn(async move {
                            let _permit = permit;
                            let io = TokioIo::new(stream);
                            let service = service_fn(move |request| {
                                let body = body.clone();
                                let authority = Arc::clone(&authority);
                                async move {
                                    Ok::<_, Infallible>(handle_request(request, body, &authority))
                                }
                            });
                            let _ = tokio::time::timeout(
                                CONNECTION_TIMEOUT,
                                http1::Builder::new()
                                    .keep_alive(false)
                                    .serve_connection(io, service),
                            )
                            .await;
                        });
                    }
                    Err(_) => {
                        // Transient accept failures are not fatal; avoid a
                        // tight spin. The TTL still bounds the service.
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    };

    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    // Release the port before publishing the stopped state so callers that
    // observe `running == false` can immediately rebind in tests.
    drop(listener);

    let mut state = state.lock().await;
    if state
        .running
        .as_ref()
        .is_some_and(|running| running.run_id == run_id)
    {
        state.running = None;
        state.last_stop_reason = Some(reason);
    }
}

fn handle_request(
    request: Request<hyper::body::Incoming>,
    certificate_pem: Bytes,
    authority: &str,
) -> Response<Full<Bytes>> {
    // Absolute-form can smuggle a different authority; reject it before any
    // route decision. Origin-form only.
    if request.uri().authority().is_some() {
        return empty_response(StatusCode::MISDIRECTED_REQUEST);
    }
    if !host_matches(request.headers(), authority) {
        return empty_response(StatusCode::MISDIRECTED_REQUEST);
    }
    let served_path = request.method() == Method::GET
        && request.uri().path() == CA_DISTRIBUTION_PATH
        && request.uri().query().is_none();
    if !served_path {
        return empty_response(StatusCode::NOT_FOUND);
    }

    let length = certificate_pem.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, CERTIFICATE_CONTENT_TYPE)
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{CERTIFICATE_FILENAME}\""),
        )
        .header(CONTENT_LENGTH, length)
        .header(CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(CONNECTION, "close")
        .body(Full::new(certificate_pem))
        .expect("static certificate response")
}

fn empty_response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .header(CONNECTION, "close")
        .body(Full::new(Bytes::new()))
        .expect("static empty response")
}

fn host_matches(headers: &HeaderMap, authority: &str) -> bool {
    let mut values = headers.get_all(HOST).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    value.to_str().ok() == Some(authority)
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn duration_millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;
    use crate::ca::test_helpers::temp_path;
    use crate::ca::CaManager;

    const SHORT_TTL: Duration = Duration::from_millis(150);

    struct TestCa {
        root: PathBuf,
    }

    impl TestCa {
        fn new(tag: &str) -> Self {
            let root = temp_path(tag).join("ca");
            CaManager::new(root.clone())
                .initialize()
                .expect("test CA initializes");
            Self { root }
        }

        fn manager(&self) -> CaManager {
            CaManager::new(self.root.clone())
        }
    }

    impl Drop for TestCa {
        fn drop(&mut self) {
            if let Ok(status) = self.manager().status() {
                let _ = self.manager().destroy(&status.root_fingerprint_sha256);
            }
            if let Some(parent) = self.root.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    async fn runtime_for(ca: &TestCa, ttl: Duration) -> CaDistributionRuntime {
        let cert = ca.manager().root_certificate().expect("root certificate");
        let runtime = CaDistributionRuntime::for_test(ca.root.clone(), ttl, 0);
        let status = runtime
            .start(Ipv4Addr::LOCALHOST)
            .await
            .expect("distribution starts");
        assert!(status.running);
        assert_eq!(
            status.root_fingerprint_sha256.as_deref(),
            Some(cert.fingerprint_sha256.as_str())
        );
        runtime
    }

    fn authority(status: &CaDistributionStatus) -> String {
        status
            .url
            .as_deref()
            .expect("running url")
            .strip_prefix("http://")
            .and_then(|rest| rest.strip_suffix(CA_DISTRIBUTION_PATH))
            .expect("distribution url")
            .to_owned()
    }

    fn local_addr(status: &CaDistributionStatus) -> SocketAddr {
        authority(status).parse().expect("authority parses")
    }

    async fn send_raw(addr: SocketAddr, request: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.expect("read");
        String::from_utf8_lossy(&response).into_owned()
    }

    fn request(method: &str, path: &str, authority: &str) -> String {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn split_response(raw: &str) -> (&str, &str) {
        raw.split_once("\r\n\r\n").expect("complete HTTP response")
    }

    #[tokio::test]
    async fn distribution_serves_only_root_certificate() {
        let ca = TestCa::new("distribution-cert");
        let expected = ca.manager().root_certificate().unwrap();
        let runtime = runtime_for(&ca, Duration::from_secs(5)).await;
        let status = runtime.status().await;
        let authority = authority(&status);
        let addr = local_addr(&status);

        let response = send_raw(addr, &request("GET", CA_DISTRIBUTION_PATH, &authority)).await;
        let (head, body) = split_response(&response);
        assert!(head.starts_with("HTTP/1.1 200"));
        let lower = head.to_ascii_lowercase();
        assert!(lower.contains("content-type: application/x-x509-ca-cert"));
        assert!(lower.contains("content-disposition: attachment; filename=\"moyu-root-ca.crt\""));
        assert!(lower.contains("cache-control: no-store"));
        assert!(lower.contains("x-content-type-options: nosniff"));
        assert!(!lower.contains("access-control-allow-origin"));
        assert!(!lower.contains("access-control-allow-credentials"));
        assert_eq!(body, expected.cert_pem.as_str());
        assert!(!body.contains("PRIVATE KEY"));
        assert!(lower.contains(&format!("content-length: {}", expected.cert_pem.len())));

        for (method, path) in [
            ("GET", "/"),
            ("GET", "/root.crt"),
            ("GET", "/ca.crt/"),
            ("GET", "/api/health"),
            ("GET", "/ca.crt?x=1"),
            ("POST", CA_DISTRIBUTION_PATH),
            ("HEAD", CA_DISTRIBUTION_PATH),
            ("OPTIONS", CA_DISTRIBUTION_PATH),
        ] {
            let response = send_raw(addr, &request(method, path, &authority)).await;
            assert!(
                response.starts_with("HTTP/1.1 404"),
                "{method} {path} must be 404: {response:?}"
            );
            assert!(!response
                .to_ascii_lowercase()
                .contains("access-control-allow-"));
        }

        let wrong_host =
            send_raw(addr, &request("GET", CA_DISTRIBUTION_PATH, "evil.local:1")).await;
        assert!(wrong_host.starts_with("HTTP/1.1 421"));

        // Duplicate Host is ambiguous even when both values match.
        let duplicate_host = format!(
            "GET {CA_DISTRIBUTION_PATH} HTTP/1.1\r\nHost: {authority}\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
        );
        let duplicate_host = send_raw(addr, &duplicate_host).await;
        assert!(
            duplicate_host.contains(" 421 "),
            "duplicate Host must be 421: {duplicate_host:?}"
        );

        let absolute_form = send_raw(
            addr,
            &request("GET", "http://evil.example/ca.crt", &authority),
        )
        .await;
        assert!(absolute_form.starts_with("HTTP/1.1 421"));

        let missing_host =
            send_raw(addr, "GET /ca.crt HTTP/1.0\r\nConnection: close\r\n\r\n").await;
        assert!(
            missing_host.contains(" 421 "),
            "missing Host must be 421: {missing_host:?}"
        );

        runtime.stop().await;
    }

    #[tokio::test]
    async fn distribution_auto_stops_and_releases_port() {
        let ca = TestCa::new("distribution-ttl");
        let runtime = runtime_for(&ca, SHORT_TTL).await;
        let status = runtime.status().await;
        let addr = local_addr(&status);

        // Poll instead of sleeping a fixed margin: CI scheduling can delay the
        // timer even though the runtime is correct.
        let mut stopped = runtime.status().await;
        for _ in 0..200 {
            if !stopped.running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            stopped = runtime.status().await;
        }
        assert!(!stopped.running);
        assert_eq!(stopped.stop_reason, Some(CaDistributionStopReason::Expired));
        assert_eq!(
            stopped.stop_reason.map(CaDistributionStopReason::as_str),
            Some("expired")
        );
        assert!(TcpStream::connect(addr).await.is_err());
        rebind_with_retry(addr).await;
    }

    #[tokio::test]
    async fn distribution_manual_stop_is_idempotent_and_releases_port() {
        let ca = TestCa::new("distribution-stop");
        let runtime = runtime_for(&ca, Duration::from_secs(5)).await;
        let addr = local_addr(&runtime.status().await);

        let stopped = runtime.stop().await;
        assert!(!stopped.running);
        assert_eq!(stopped.stop_reason, Some(CaDistributionStopReason::Stopped));
        assert!(TcpStream::connect(addr).await.is_err());
        rebind_with_retry(addr).await;

        let again = runtime.stop().await;
        assert!(!again.running);
        assert_eq!(again.stop_reason, Some(CaDistributionStopReason::Stopped));
    }

    #[tokio::test]
    async fn distribution_duplicate_start_is_rejected() {
        let ca = TestCa::new("distribution-duplicate");
        let runtime = runtime_for(&ca, Duration::from_secs(5)).await;
        let err = runtime
            .start(Ipv4Addr::LOCALHOST)
            .await
            .expect_err("second start must fail");
        assert_eq!(err.code(), "ca-distribution-running");
        assert!(runtime.status().await.running);
        runtime.stop().await;
    }

    #[tokio::test]
    async fn distribution_missing_or_corrupt_ca_never_binds() {
        let missing_root = temp_path("distribution-missing").join("ca");
        let port = free_port().await;
        let runtime = CaDistributionRuntime::for_test(missing_root.clone(), SHORT_TTL, port);
        let err = runtime
            .start(Ipv4Addr::LOCALHOST)
            .await
            .expect_err("missing CA must fail");
        assert_eq!(err.code(), "ca-not-initialized");
        assert!(!runtime.status().await.running);
        rebind_with_retry(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await;

        let ca = TestCa::new("distribution-corrupt");
        std::fs::write(ca.root.join("state.json"), b"{").unwrap();
        let port = free_port().await;
        let runtime = CaDistributionRuntime::for_test(ca.root.clone(), SHORT_TTL, port);
        let err = runtime
            .start(Ipv4Addr::LOCALHOST)
            .await
            .expect_err("corrupt CA must fail");
        assert_eq!(err.code(), "ca-state-corrupt");
        assert!(!runtime.status().await.running);
        rebind_with_retry(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await;
    }

    #[tokio::test]
    async fn distribution_bind_failure_returns_stable_code() {
        let ca = TestCa::new("distribution-bind");
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("occupy port");
        let port = occupied.local_addr().unwrap().port();
        let runtime = CaDistributionRuntime::for_test(ca.root.clone(), SHORT_TTL, port);
        let err = runtime
            .start(Ipv4Addr::LOCALHOST)
            .await
            .expect_err("occupied port must fail");
        assert_eq!(err.code(), "ca-distribution-io");
        assert!(!runtime.status().await.running);
        drop(occupied);
    }

    #[test]
    fn distribution_rejects_non_lan_bind_addresses() {
        for ip in [
            Ipv4Addr::new(10, 0, 0, 1),
            Ipv4Addr::new(172, 16, 0, 1),
            Ipv4Addr::new(192, 168, 1, 10),
        ] {
            assert!(validate_bind_ip(ip).is_ok(), "{ip} must be accepted");
        }
        for ip in [
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::new(8, 8, 8, 8),
            Ipv4Addr::new(169, 254, 1, 1),
            Ipv4Addr::new(224, 0, 0, 1),
            Ipv4Addr::UNSPECIFIED,
        ] {
            let err = validate_bind_ip(ip).expect_err("non-LAN IP must be rejected");
            assert_eq!(err.code(), "ca-distribution-invalid-ip");
        }
    }

    async fn free_port() -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("probe port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    async fn rebind_with_retry(addr: SocketAddr) {
        for _ in 0..50 {
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    drop(listener);
                    return;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        panic!("listener did not release {addr}");
    }
}
