use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_rustls::TlsAcceptor;
use zeroize::Zeroizing;

use crate::ca::{CaError, CaManager};

use super::addrs::select_san_ips;
use super::error::{WebAccessError, WebAccessResult};
use super::http::{empty_response, health_response, not_found_response, RequestGuard};
use super::tls_renewal::{TlsCertificateSnapshot, TlsCertificateState};

/// The only DNS name the CA issues leaves for.
const LEAF_DNS: &str = "moyu.local";
const HEALTH_PATH: &str = "/api/health";
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ACTIVE_CONNECTIONS: usize = 32;

/// The certificate currently served to new TLS connections.
pub(crate) struct ServingCertificate {
    pub config: Arc<rustls::ServerConfig>,
    pub leaf_fingerprint_sha256: String,
    pub leaf_not_after: i64,
    pub root_fingerprint_sha256: String,
    pub root_generation: u32,
    pub intermediate_generation: u32,
}

/// Configuration for an explicitly started TLS listener.
#[derive(Clone)]
pub struct TlsServerConfig {
    /// CA root containing `state.json`, `roots/` and `intermediates/`.
    pub ca_root: PathBuf,
    /// Defaults to `0.0.0.0:0`; tests use loopback.
    pub bind_addr: SocketAddr,
    /// `None` enumerates current private LAN IPv4s; `Some` is explicit.
    pub san_ips: Option<Vec<Ipv4Addr>>,
}

impl TlsServerConfig {
    pub fn new(ca_root: PathBuf) -> Self {
        Self {
            ca_root,
            bind_addr: SocketAddr::from(([0, 0, 0, 0], 0)),
            san_ips: None,
        }
    }
}

impl std::fmt::Debug for TlsServerConfig {
    /// The CA root is path-like and must not leak through diagnostics.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsServerConfig")
            .field("ca_root_len", &self.ca_root.as_os_str().len())
            .field("bind_addr", &self.bind_addr)
            .field("san_ips_len", &self.san_ips.as_ref().map(Vec::len))
            .finish()
    }
}

/// A running TLS listener. Dropping the handle aborts the accept task and
/// closes the listener; [`Self::shutdown`] waits for the task to finish.
pub struct TlsServerHandle {
    local_addr: SocketAddr,
    san_ips: Vec<Ipv4Addr>,
    current: watch::Receiver<ServingCertificate>,
    /// Kept alive for the renewal task added in the next slice.
    _cert_tx: watch::Sender<ServingCertificate>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl TlsServerHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// The private IPv4 SANs actually requested from the CA.
    pub fn san_ips(&self) -> &[Ipv4Addr] {
        &self.san_ips
    }

    /// Unix timestamp of the currently served leaf's `notAfter`.
    pub fn leaf_not_after(&self) -> i64 {
        self.current.borrow().leaf_not_after
    }

    pub fn leaf_fingerprint_sha256(&self) -> String {
        self.current.borrow().leaf_fingerprint_sha256.clone()
    }

    pub fn root_fingerprint_sha256(&self) -> String {
        self.current.borrow().root_fingerprint_sha256.clone()
    }

    /// A path/key-free snapshot of the certificate currently served.
    pub fn certificate_snapshot(&self) -> TlsCertificateSnapshot {
        let current = self.current.borrow();
        TlsCertificateSnapshot {
            state: TlsCertificateState::Serving,
            leaf_fingerprint_sha256: current.leaf_fingerprint_sha256.clone(),
            leaf_not_after: current.leaf_not_after,
            root_fingerprint_sha256: current.root_fingerprint_sha256.clone(),
            root_generation: current.root_generation,
            intermediate_generation: current.intermediate_generation,
            last_error_code: None,
            previous_leaf_fingerprint_sha256: None,
            previous_not_after: None,
        }
    }

    pub async fn shutdown(mut self) -> WebAccessResult<()> {
        self.signal_shutdown();
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| WebAccessError::ServerJoin)?;
        }
        Ok(())
    }

    fn signal_shutdown(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
    }
}

impl Drop for TlsServerHandle {
    fn drop(&mut self) {
        self.signal_shutdown();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Start a real HTTPS listener backed by the local CA.
///
/// The CA must already be initialized; this function never creates one
/// silently. A leaf for `moyu.local` and the selected private IPv4 SANs is
/// issued before binding, so a CA failure never exposes a port. Only
/// `GET /api/health` is served (204); every other request is 404. There is no
/// pairing, session, auth, data route, Tauri command, UI, or startup wiring.
pub async fn start_tls_server(config: TlsServerConfig) -> WebAccessResult<TlsServerHandle> {
    // The CA root must be absolute; never resolve it against the process CWD.
    if !config.ca_root.is_absolute() {
        return Err(WebAccessError::Ca(CaError::RelativeCaRoot));
    }
    // The CA only issues IPv4 SANs; an IPv6 listener would be unreachable
    // through a verifiable name.
    if config.bind_addr.is_ipv6() {
        return Err(WebAccessError::InvalidBindAddress);
    }

    let manager = CaManager::new(config.ca_root);
    // Full CA health check; an uninitialized or damaged CA fails before bind.
    let status = manager.status()?;
    let san_ips = select_san_ips(config.san_ips)?;
    let leaf = manager.issue_leaf(LEAF_DNS, &san_ips)?;
    let server_config = Arc::new(build_server_config(&leaf)?);
    let serving = ServingCertificate {
        config: server_config,
        leaf_fingerprint_sha256: leaf.fingerprint_sha256,
        leaf_not_after: leaf.not_after,
        root_fingerprint_sha256: status.root_fingerprint_sha256,
        root_generation: status.root_generation,
        intermediate_generation: status.intermediate_generation,
    };

    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let connections = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (cert_tx, cert_rx) = watch::channel(serving);
    let task = tokio::spawn(accept_loop(
        listener,
        cert_rx.clone(),
        connections,
        shutdown_rx,
    ));
    Ok(TlsServerHandle {
        local_addr,
        san_ips,
        current: cert_rx,
        _cert_tx: cert_tx,
        shutdown: Some(shutdown_tx),
        task: Some(task),
    })
}

fn build_server_config(leaf: &crate::ca::LeafMaterial) -> WebAccessResult<rustls::ServerConfig> {
    let mut chain = Vec::new();
    let blocks = pem::parse_many(&leaf.chain_pem)
        .map_err(|err| WebAccessError::TlsConfig(format!("leaf chain parse: {err}")))?;
    for block in blocks {
        if block.tag() == "CERTIFICATE" {
            chain.push(CertificateDer::from(block.contents().to_vec()));
        }
    }
    if chain.is_empty() {
        return Err(WebAccessError::TlsConfig(
            "leaf chain contains no certificates".into(),
        ));
    }
    let key = pem::parse(&leaf.key_pem)
        .map_err(|err| WebAccessError::TlsConfig(format!("leaf key parse: {err}")))?;
    if key.tag() != "PRIVATE KEY" {
        return Err(WebAccessError::TlsConfig("leaf key is not PKCS#8".into()));
    }
    // Move the parsed key bytes into rustls without leaving an extra
    // unzeroized copy in a temporary Vec; the source `LeafMaterial.key_pem`
    // remains `Zeroizing`.
    let mut key_bytes = Zeroizing::new(key.into_contents());
    let key_bytes = std::mem::take(&mut *key_bytes);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_bytes));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| WebAccessError::TlsConfig(err.to_string()))?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|err| WebAccessError::TlsConfig(err.to_string()))
}

async fn accept_loop(
    listener: TcpListener,
    cert_rx: watch::Receiver<ServingCertificate>,
    connections: Arc<Semaphore>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        let permit = match connections.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                // Bound concurrent TLS handshakes/connections.
                                drop(stream);
                                continue;
                            }
                        };
                        // Snapshot the certificate at accept time. Existing
                        // connections keep their already-negotiated session;
                        // every new connection sees the latest swap.
                        let server_config = cert_rx.borrow().config.clone();
                        tasks.spawn(async move {
                            let _permit = permit;
                            let acceptor = TlsAcceptor::from(server_config);
                            let accepted =
                                tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream))
                                    .await;
                            if let Ok(Ok(tls)) = accepted {
                                let io = TokioIo::new(tls);
                                let _ = tokio::time::timeout(
                                    HTTP_CONNECTION_TIMEOUT,
                                    http1::Builder::new()
                                        .keep_alive(false)
                                        .serve_connection(io, service_fn(handle_request)),
                                )
                                .await;
                            }
                        });
                    }
                    Err(_) => {
                        // Transient accept failures are not fatal; avoid a
                        // tight spin if the OS keeps returning an error.
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

async fn handle_request(
    request: Request<hyper::body::Incoming>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    // Production is health-only, so the shared guard has no authority and is a
    // no-op here. The call keeps the production path on the same compiled
    // validation code used by the test-only pairing router and fails closed if
    // that invariant ever changes.
    if let Err(status) = RequestGuard::health_only().check(&request) {
        return Ok(empty_response(status));
    }
    let response = if request.method() == Method::GET && request.uri().path() == HEALTH_PATH {
        health_response()
    } else {
        not_found_response()
    };
    Ok(response)
}
