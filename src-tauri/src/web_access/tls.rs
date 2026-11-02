use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use time::OffsetDateTime;
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex as AsyncMutex, Notify, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_rustls::TlsAcceptor;
use zeroize::Zeroizing;

use crate::ca::{CaError, CaManager};

use super::addrs::select_san_ips;
use super::error::{WebAccessError, WebAccessResult};
use super::http::{empty_response, health_response, not_found_response, RequestGuard};
use super::tls_renewal::{
    certificate_expired, issuer_rotation_required, renewal_due, rollback_available,
    TlsCertificateSnapshot, TlsCertificateState, TlsRenewalPolicy,
};

/// The only DNS name the CA issues leaves for.
const LEAF_DNS: &str = "moyu.local";
const HEALTH_PATH: &str = "/api/health";
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ACTIVE_CONNECTIONS: usize = 32;

type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

/// The certificate currently served to new TLS connections.
#[derive(Clone)]
pub(crate) struct ServingCertificate {
    pub config: Arc<rustls::ServerConfig>,
    pub leaf_fingerprint_sha256: String,
    pub leaf_not_after: i64,
    pub root_fingerprint_sha256: String,
    pub root_generation: u32,
    pub intermediate_generation: u32,
}

struct PreviousCertificate {
    serving: ServingCertificate,
    swapped_at: i64,
}

struct RuntimeMeta {
    state: TlsCertificateState,
    last_error_code: Option<&'static str>,
    previous: Option<PreviousCertificate>,
}

impl RuntimeMeta {
    fn new() -> Self {
        Self {
            state: TlsCertificateState::Serving,
            last_error_code: None,
            previous: None,
        }
    }
}

struct TlsRuntime {
    manager: Arc<CaManager>,
    san_ips: Vec<Ipv4Addr>,
    clock: Clock,
    policy: TlsRenewalPolicy,
    cert_tx: watch::Sender<ServingCertificate>,
    meta: Mutex<RuntimeMeta>,
    renewal_lock: AsyncMutex<()>,
    wake: Arc<Notify>,
    shutdown_tx: Arc<watch::Sender<bool>>,
}

impl TlsRuntime {
    fn new(
        manager: Arc<CaManager>,
        san_ips: Vec<Ipv4Addr>,
        clock: Clock,
        policy: TlsRenewalPolicy,
        serving: ServingCertificate,
        shutdown_tx: Arc<watch::Sender<bool>>,
    ) -> (Arc<Self>, watch::Receiver<ServingCertificate>) {
        let (cert_tx, cert_rx) = watch::channel(serving);
        (
            Arc::new(Self {
                manager,
                san_ips,
                clock,
                policy,
                cert_tx,
                meta: Mutex::new(RuntimeMeta::new()),
                renewal_lock: AsyncMutex::new(()),
                wake: Arc::new(Notify::new()),
                shutdown_tx,
            }),
            cert_rx,
        )
    }

    fn lock_meta(&self) -> std::sync::MutexGuard<'_, RuntimeMeta> {
        self.meta
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn live_snapshot(&self) -> (ServingCertificate, bool) {
        let now = (self.clock)().unix_timestamp();
        let current = self.cert_tx.borrow().clone();
        let expired = certificate_expired(now, current.leaf_not_after);
        (current, expired)
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self.lock_meta().state,
            TlsCertificateState::Expired | TlsCertificateState::Stopped
        )
    }

    fn next_wait(&self) -> Duration {
        let base = {
            let meta = self.lock_meta();
            match meta.state {
                TlsCertificateState::RenewalFailed { .. }
                | TlsCertificateState::IssuerRotationRequired { .. } => {
                    self.policy.retry_after_failure
                }
                _ => self.policy.tick,
            }
        };
        // Wake at the leaf's absolute expiry even if the normal tick is later,
        // so an expired listener cannot remain bound without a status update.
        let now = (self.clock)().unix_timestamp();
        let current = self.cert_tx.borrow();
        let remaining = current.leaf_not_after.saturating_sub(now);
        if remaining <= 0 {
            Duration::from_secs(0)
        } else {
            base.min(Duration::from_secs(remaining as u64))
        }
    }

    fn prune_previous(&self, now: i64, current: &ServingCertificate) {
        let mut meta = self.lock_meta();
        let Some(previous) = meta.previous.as_ref() else {
            return;
        };
        if !rollback_available(
            now,
            previous.serving.leaf_not_after,
            previous.serving.root_generation,
            current.root_generation,
            previous.swapped_at,
            self.policy.rollback_grace,
        ) {
            meta.previous = None;
        }
    }

    fn mark_renewing(&self) {
        let mut meta = self.lock_meta();
        meta.state = TlsCertificateState::Renewing;
        meta.last_error_code = None;
    }

    fn record_failure(&self, code: &'static str, expired: bool) {
        let terminal = expired;
        let state = if terminal {
            TlsCertificateState::Expired
        } else {
            TlsCertificateState::RenewalFailed { code }
        };
        let last_error = if terminal {
            "web-access-certificate-expired"
        } else {
            code
        };
        {
            let mut meta = self.lock_meta();
            meta.state = state;
            meta.last_error_code = Some(last_error);
        }
        if terminal {
            let _ = self.shutdown_tx.send(true);
        }
    }

    fn set_root_pending(&self, active_root_fingerprint_sha256: String, expired: bool) {
        let terminal = expired;
        let state = if terminal {
            TlsCertificateState::Expired
        } else {
            TlsCertificateState::RootChangePending {
                active_root_fingerprint_sha256,
            }
        };
        let last_error = if terminal {
            "web-access-certificate-expired"
        } else {
            "web-access-root-change-pending"
        };
        {
            let mut meta = self.lock_meta();
            meta.state = state;
            meta.last_error_code = Some(last_error);
        }
        if terminal {
            let _ = self.shutdown_tx.send(true);
        }
    }

    fn set_issuer_required(&self, expired: bool) {
        let terminal = expired;
        let state = if terminal {
            TlsCertificateState::Expired
        } else {
            TlsCertificateState::IssuerRotationRequired {
                code: "ca-insufficient-validity",
            }
        };
        let last_error = if terminal {
            "web-access-certificate-expired"
        } else {
            "ca-insufficient-validity"
        };
        {
            let mut meta = self.lock_meta();
            meta.state = state;
            meta.last_error_code = Some(last_error);
        }
        if terminal {
            let _ = self.shutdown_tx.send(true);
        }
    }

    fn swap(&self, new: ServingCertificate, swapped_at: i64) {
        let previous = self.cert_tx.send_replace(new);
        let mut meta = self.lock_meta();
        meta.state = TlsCertificateState::Serving;
        meta.last_error_code = None;
        meta.previous = Some(PreviousCertificate {
            serving: previous,
            swapped_at,
        });
    }

    async fn tick(&self) {
        let now = (self.clock)().unix_timestamp();
        let current = self.cert_tx.borrow().clone();
        self.prune_previous(now, &current);
        let manager = self.manager.clone();
        let status = tokio::task::spawn_blocking(move || manager.status()).await;
        let status = match status {
            Err(_) => {
                let _guard = self.renewal_lock.lock().await;
                let (_, expired) = self.live_snapshot();
                self.record_failure("web-access-server-join", expired);
                return;
            }
            Ok(Err(err)) => {
                let _guard = self.renewal_lock.lock().await;
                let (_, expired) = self.live_snapshot();
                self.record_failure(err.code(), expired);
                return;
            }
            Ok(Ok(status)) => status,
        };

        // Re-read the live certificate under the renewal lock before any
        // terminal decision. A concurrent renew/reload may already have
        // installed a fresh certificate while status() was running.
        {
            let _guard = self.renewal_lock.lock().await;
            let (live, expired) = self.live_snapshot();
            if status.root_generation > live.root_generation
                || (status.root_generation == live.root_generation
                    && status.root_fingerprint_sha256 != live.root_fingerprint_sha256)
            {
                self.set_root_pending(status.root_fingerprint_sha256.clone(), expired);
                return;
            }
            if status.root_generation < live.root_generation {
                // status() raced a newer explicit root reload; the next tick
                // observes the new active root.
                return;
            }
            if issuer_rotation_required(
                status.root_days_remaining,
                status.intermediate_days_remaining,
            ) {
                self.set_issuer_required(expired);
                return;
            }
        }

        let (live, expired) = self.live_snapshot();
        let retry_failed = matches!(
            self.lock_meta().state,
            TlsCertificateState::RenewalFailed { .. }
        );
        if expired
            || retry_failed
            || status.intermediate_generation > live.intermediate_generation
            || renewal_due(now, live.leaf_not_after, self.policy.renew_before)
        {
            let _ = self.renew_locked().await;
        }
    }

    async fn issue_certificate(
        &self,
        root_fingerprint_sha256: String,
        root_generation: u32,
        intermediate_generation: u32,
    ) -> WebAccessResult<ServingCertificate> {
        let manager = self.manager.clone();
        let san_ips = self.san_ips.clone();
        let expected_root_fingerprint = root_fingerprint_sha256.clone();
        let result = tokio::task::spawn_blocking(move || -> WebAccessResult<ServingCertificate> {
            let leaf = manager.issue_leaf(LEAF_DNS, &san_ips)?;
            // Re-read the active chain after issuance. If the root changed
            // while the leaf was being signed, discard it instead of silently
            // switching the trust anchor.
            let after = manager.status().map_err(WebAccessError::Ca)?;
            if after.root_fingerprint_sha256 != expected_root_fingerprint {
                return Err(WebAccessError::RootChangePending);
            }
            let config = build_server_config(&leaf)?;
            Ok(ServingCertificate {
                config: Arc::new(config),
                leaf_fingerprint_sha256: leaf.fingerprint_sha256,
                leaf_not_after: leaf.not_after,
                root_fingerprint_sha256: expected_root_fingerprint,
                root_generation,
                intermediate_generation,
            })
        })
        .await;
        match result {
            Ok(Ok(new)) => Ok(new),
            Ok(Err(err)) => Err(err),
            Err(_) => Err(WebAccessError::ServerJoin),
        }
    }

    async fn reload_after_root_rotation(&self, expected: &str) -> WebAccessResult<()> {
        let _guard = self.renewal_lock.lock().await;
        if self.is_terminal() {
            return Err(WebAccessError::CertificateExpired);
        }
        let now = (self.clock)().unix_timestamp();
        let current = self.cert_tx.borrow().clone();
        let expired = certificate_expired(now, current.leaf_not_after);
        self.mark_renewing();

        let manager = self.manager.clone();
        let status = tokio::task::spawn_blocking(move || manager.status()).await;
        let status = match status {
            Err(_) => {
                self.record_failure("web-access-server-join", expired);
                return Err(WebAccessError::ServerJoin);
            }
            Ok(Err(err)) => {
                self.record_failure(err.code(), expired);
                return Err(WebAccessError::Ca(err));
            }
            Ok(Ok(status)) => status,
        };
        if status.root_fingerprint_sha256 != expected {
            self.record_failure("web-access-root-change-mismatch", expired);
            return Err(WebAccessError::RootChangeMismatch);
        }

        let new = self
            .issue_certificate(
                status.root_fingerprint_sha256,
                status.root_generation,
                status.intermediate_generation,
            )
            .await;
        match new {
            Ok(new) => {
                self.swap(new, now);
                Ok(())
            }
            Err(err) => {
                self.record_failure(err.code(), expired);
                Err(err)
            }
        }
    }

    async fn rollback_last_reload(&self) -> WebAccessResult<()> {
        let _guard = self.renewal_lock.lock().await;
        if self.is_terminal() {
            return Err(WebAccessError::CertificateExpired);
        }
        let now = (self.clock)().unix_timestamp();
        let current = self.cert_tx.borrow().clone();
        let previous = {
            let mut meta = self.lock_meta();
            meta.previous.take()
        };
        let Some(previous) = previous else {
            return Err(WebAccessError::RollbackUnavailable);
        };
        if !rollback_available(
            now,
            previous.serving.leaf_not_after,
            previous.serving.root_generation,
            current.root_generation,
            previous.swapped_at,
            self.policy.rollback_grace,
        ) {
            return Err(WebAccessError::RollbackUnavailable);
        }

        let _displaced = self.cert_tx.send_replace(previous.serving);
        let mut meta = self.lock_meta();
        meta.state = TlsCertificateState::Serving;
        meta.last_error_code = None;
        meta.previous = None;
        Ok(())
    }

    async fn renew_locked(&self) -> WebAccessResult<()> {
        let _guard = self.renewal_lock.lock().await;
        if self.is_terminal() {
            return Err(WebAccessError::CertificateExpired);
        }
        let now = (self.clock)().unix_timestamp();
        let current = self.cert_tx.borrow().clone();
        let expired = certificate_expired(now, current.leaf_not_after);
        self.mark_renewing();

        let manager = self.manager.clone();
        let status = tokio::task::spawn_blocking(move || manager.status()).await;
        let status = match status {
            Err(_) => {
                self.record_failure("web-access-server-join", expired);
                return Err(WebAccessError::ServerJoin);
            }
            Ok(Err(err)) => {
                self.record_failure(err.code(), expired);
                return Err(WebAccessError::Ca(err));
            }
            Ok(Ok(status)) => status,
        };

        if status.root_generation != current.root_generation
            || status.root_fingerprint_sha256 != current.root_fingerprint_sha256
        {
            self.set_root_pending(status.root_fingerprint_sha256, expired);
            return Err(WebAccessError::RootChangePending);
        }
        if issuer_rotation_required(
            status.root_days_remaining,
            status.intermediate_days_remaining,
        ) {
            self.set_issuer_required(expired);
            return Err(WebAccessError::Ca(CaError::InsufficientValidity));
        }

        let new = self
            .issue_certificate(
                status.root_fingerprint_sha256,
                status.root_generation,
                status.intermediate_generation,
            )
            .await;
        match new {
            Ok(new) => {
                self.swap(new, now);
                Ok(())
            }
            Err(err) => {
                self.record_failure(err.code(), expired);
                Err(err)
            }
        }
    }
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

/// A running TLS listener. Dropping the handle aborts the accept/renewal tasks
/// and closes the listener; [`Self::shutdown`] waits for both tasks to finish.
pub struct TlsServerHandle {
    local_addr: SocketAddr,
    san_ips: Vec<Ipv4Addr>,
    current: watch::Receiver<ServingCertificate>,
    runtime: Arc<TlsRuntime>,
    shutdown: Option<Arc<watch::Sender<bool>>>,
    task: Option<JoinHandle<()>>,
    renewal_task: Option<JoinHandle<()>>,
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
        let now = (self.runtime.clock)().unix_timestamp();
        self.runtime.prune_previous(now, &current);
        let meta = self.runtime.lock_meta();
        TlsCertificateSnapshot {
            state: meta.state.clone(),
            leaf_fingerprint_sha256: current.leaf_fingerprint_sha256.clone(),
            leaf_not_after: current.leaf_not_after,
            root_fingerprint_sha256: current.root_fingerprint_sha256.clone(),
            root_generation: current.root_generation,
            intermediate_generation: current.intermediate_generation,
            last_error_code: meta.last_error_code,
            previous_leaf_fingerprint_sha256: meta
                .previous
                .as_ref()
                .map(|previous| previous.serving.leaf_fingerprint_sha256.clone()),
            previous_not_after: meta
                .previous
                .as_ref()
                .map(|previous| previous.serving.leaf_not_after),
        }
    }

    /// Force one certificate renewal and return the resulting snapshot.
    pub async fn renew_now(&self) -> WebAccessResult<TlsCertificateSnapshot> {
        self.runtime.renew_locked().await?;
        Ok(self.certificate_snapshot())
    }

    /// Explicitly reload the serving certificate after a root rotation.
    ///
    /// The caller must confirm the new active root fingerprint and must have
    /// distributed the new root to clients; this changes the trust anchor.
    pub async fn reload_after_root_rotation(
        &self,
        expected_root_fingerprint_sha256: &str,
    ) -> WebAccessResult<TlsCertificateSnapshot> {
        self.runtime
            .reload_after_root_rotation(expected_root_fingerprint_sha256)
            .await?;
        Ok(self.certificate_snapshot())
    }

    /// Restore the certificate replaced by the most recent successful reload.
    ///
    /// Only available for the same root, before the previous leaf expires and
    /// inside the rollback grace window. One rollback level only.
    pub async fn rollback_last_reload(&self) -> WebAccessResult<TlsCertificateSnapshot> {
        self.runtime.rollback_last_reload().await?;
        Ok(self.certificate_snapshot())
    }

    pub async fn shutdown(mut self) -> WebAccessResult<()> {
        self.signal_shutdown();
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| WebAccessError::ServerJoin)?;
        }
        if let Some(task) = self.renewal_task.take() {
            task.await.map_err(|_| WebAccessError::ServerJoin)?;
        }
        Ok(())
    }

    fn signal_shutdown(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(true);
        }
    }
}

impl Drop for TlsServerHandle {
    fn drop(&mut self) {
        self.signal_shutdown();
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if let Some(task) = self.renewal_task.take() {
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
    start_tls_server_inner(
        config,
        Arc::new(OffsetDateTime::now_utc),
        TlsRenewalPolicy::default(),
    )
    .await
}

#[cfg(test)]
pub(crate) async fn start_tls_server_with_clock(
    config: TlsServerConfig,
    clock: Clock,
    policy: TlsRenewalPolicy,
) -> WebAccessResult<TlsServerHandle> {
    start_tls_server_inner(config, clock, policy).await
}

async fn start_tls_server_inner(
    config: TlsServerConfig,
    clock: Clock,
    policy: TlsRenewalPolicy,
) -> WebAccessResult<TlsServerHandle> {
    // The CA root must be absolute; never resolve it against the process CWD.
    if !config.ca_root.is_absolute() {
        return Err(WebAccessError::Ca(CaError::RelativeCaRoot));
    }
    // The CA only issues IPv4 SANs; an IPv6 listener would be unreachable
    // through a verifiable name.
    if config.bind_addr.is_ipv6() {
        return Err(WebAccessError::InvalidBindAddress);
    }

    let manager = Arc::new(CaManager::with_clock(config.ca_root, clock.clone()));
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
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let shutdown_tx = Arc::new(shutdown_tx);
    let (runtime, cert_rx) = TlsRuntime::new(
        manager,
        san_ips.clone(),
        clock.clone(),
        policy,
        serving,
        shutdown_tx.clone(),
    );
    let task = tokio::spawn(accept_loop(
        listener,
        cert_rx.clone(),
        clock,
        runtime.wake.clone(),
        connections,
        shutdown_rx.clone(),
    ));
    let renewal_task = tokio::spawn(renewal_loop(runtime.clone(), shutdown_rx));
    Ok(TlsServerHandle {
        local_addr,
        san_ips,
        current: cert_rx,
        runtime,
        shutdown: Some(shutdown_tx),
        task: Some(task),
        renewal_task: Some(renewal_task),
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

async fn renewal_loop(runtime: Arc<TlsRuntime>, mut shutdown: watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            break;
        }
        let wait = runtime.next_wait();
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = runtime.wake.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
        if *shutdown.borrow() {
            break;
        }
        runtime.tick().await;
    }
}

async fn accept_loop(
    listener: TcpListener,
    cert_rx: watch::Receiver<ServingCertificate>,
    clock: Clock,
    wake: Arc<Notify>,
    connections: Arc<Semaphore>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut tasks = JoinSet::new();
    loop {
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
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
                        let current = cert_rx.borrow().clone();
                        if certificate_expired((clock)().unix_timestamp(), current.leaf_not_after) {
                            // Do not complete a handshake with an expired leaf.
                            // Wake the monitor so it can renew or stop the listener.
                            wake.notify_one();
                            drop(stream);
                            continue;
                        }
                        let server_config = current.config.clone();
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
