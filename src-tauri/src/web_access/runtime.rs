//! D1b control-plane runtime.
//!
//! `WebAccessRuntime` is the only owner of the production pair listener. It is
//! created at app setup but **never starts by itself**: the phase is
//! `Disabled` until an explicit `web_access_start` command. Every start
//! validates the selected private IPv4, the existing CA health, and the actual
//! bound address before exposing a port. Stop cancels pairing, revokes every
//! session, and shuts the listener down; there is no automatic restart.
//!
//! Runtime state is in memory only. No pairing id, claim secret, secret hash,
//! or session token is persisted or logged.

use std::collections::HashSet;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::ca::{CaError, CaManager};

use super::addrs::{is_private_lan_ipv4, local_lan_addresses, LanAddress};
use super::auth::{AuthError, PairingService};
use super::clock::SystemClock;
use super::data::WebDataAccess;
use super::error::WebAccessError;
use super::pairing::PairingStore;
use super::plain::{start_plain_server, PlainServerHandle};
use super::progress_write::WebProgressWrite;
use super::router::PairingHttp;
use super::session::SessionStore;
use super::tls::{
    start_tls_server_with, HandlerFactory, RequestHandler, TlsServerConfig, TlsServerHandle,
};
use super::tls_renewal::TlsCertificateState;

pub(crate) const STATE_EVENT: &str = "web-access-state";
pub(crate) const PAIRING_EVENT: &str = "web-access-pairing-event";
const PAIRING_BRIDGE_TICK: Duration = Duration::from_millis(500);
/// Bound recovery/exit waits so a stuck CA renewal cannot block the recovery
/// window or app exit forever.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Phase {
    Disabled,
    Starting,
    Enabled,
    Stopping,
    Error,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Starting => "starting",
            Self::Enabled => "enabled",
            Self::Stopping => "stopping",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StopReason {
    Stopped,
    Exit,
    Recovery,
    SafeMode,
}

impl StopReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Exit => "exit",
            Self::Recovery => "recovery",
            Self::SafeMode => "safe-mode",
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum RuntimeError {
    #[error("web access is already running or starting")]
    AlreadyEnabled,
    #[error("web access is not enabled")]
    NotEnabled,
    #[error("web access state does not allow this operation")]
    InvalidState,
    #[error("web access is unavailable in safe mode")]
    SafeMode,
    #[error("the selected address is not a current private LAN IPv4")]
    InvalidIp,
    #[error("no private LAN IPv4 address is available")]
    NoLanAddress,
    #[error("CA error: {0}")]
    Ca(#[from] CaError),
    #[error("TLS error: {0}")]
    Tls(#[from] WebAccessError),
    #[error("pairing error: {0}")]
    Pairing(#[from] AuthError),
}

impl RuntimeError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::AlreadyEnabled => "web-access-already-enabled",
            Self::NotEnabled => "web-access-not-enabled",
            Self::InvalidState => "web-access-invalid-state",
            Self::SafeMode => "web-access-safe-mode",
            Self::InvalidIp => "web-access-invalid-ip",
            Self::NoLanAddress => "web-access-no-lan-address",
            Self::Ca(error) => error.code(),
            Self::Tls(error) => error.code(),
            Self::Pairing(error) => error.code(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanAddressView {
    pub ip: String,
    pub interface: String,
}

impl From<LanAddress> for LanAddressView {
    fn from(address: LanAddress) -> Self {
        Self {
            ip: address.ip.to_string(),
            interface: address.interface,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebAccessStatusView {
    pub phase: String,
    pub transport: Option<String>,
    pub bind_address: Option<String>,
    pub bind_ip: Option<String>,
    pub port: Option<u16>,
    pub ca_initialized: bool,
    pub root_fingerprint_sha256: Option<String>,
    pub leaf_fingerprint_sha256: Option<String>,
    pub leaf_not_after: Option<i64>,
    pub certificate_state: Option<String>,
    pub device_count: u32,
    pub pending_claim_count: u32,
    pub pairing_active: bool,
    pub last_error_code: Option<String>,
    pub stop_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingWindowView {
    pub url: String,
    pub expires_at_unix_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingClaimView {
    pub claim_id: String,
    pub device_name: String,
    pub source_ip: String,
    pub created_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingStateView {
    pub window: Option<PairingWindowView>,
    pub claims: Vec<PendingClaimView>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceView {
    pub id: String,
    pub device_name: String,
    pub issued_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub absolute_expires_at_unix_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingEventView {
    pub kind: String,
    pub claim_id: Option<String>,
    pub device_name: Option<String>,
    pub source_ip: Option<String>,
    pub created_at_unix_ms: Option<i64>,
    pub pending_count: u32,
}

impl std::fmt::Debug for PairingWindowView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairingWindowView")
            .field("url", &"<redacted>")
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish()
    }
}

impl std::fmt::Debug for PendingClaimView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingClaimView")
            .field("claim_id", &"<redacted>")
            .field("device_name", &"<redacted>")
            .field("source_ip", &self.source_ip)
            .field("created_at_unix_ms", &self.created_at_unix_ms)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish()
    }
}

impl std::fmt::Debug for PairingStateView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairingStateView")
            .field("window", &self.window.is_some())
            .field("claims", &self.claims.len())
            .finish()
    }
}

impl std::fmt::Debug for DeviceView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeviceView")
            .field("id", &"<redacted>")
            .field("device_name", &"<redacted>")
            .field("issued_at_unix_ms", &self.issued_at_unix_ms)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .field(
                "absolute_expires_at_unix_ms",
                &self.absolute_expires_at_unix_ms,
            )
            .finish()
    }
}

impl std::fmt::Debug for PairingEventView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairingEventView")
            .field("kind", &self.kind)
            .field("claim_id", &self.claim_id.as_ref().map(|_| "<redacted>"))
            .field(
                "device_name",
                &self.device_name.as_ref().map(|_| "<redacted>"),
            )
            .field("source_ip", &self.source_ip.as_ref().map(|_| "<redacted>"))
            .field("created_at_unix_ms", &self.created_at_unix_ms)
            .field("pending_count", &self.pending_count)
            .finish()
    }
}

impl PairingEventView {
    fn window(kind: &str, pending_count: usize) -> Self {
        Self {
            kind: kind.to_owned(),
            claim_id: None,
            device_name: None,
            source_ip: None,
            created_at_unix_ms: None,
            pending_count: pending_count as u32,
        }
    }

    fn claim(kind: &str, claim: &PendingClaimView, pending_count: usize) -> Self {
        Self {
            kind: kind.to_owned(),
            claim_id: Some(claim.claim_id.clone()),
            device_name: Some(claim.device_name.clone()),
            source_ip: Some(claim.source_ip.clone()),
            created_at_unix_ms: Some(claim.created_at_unix_ms),
            pending_count: pending_count as u32,
        }
    }
}

/// Runtime-agnostic event sink. Production uses a Tauri emitter; tests use
/// `None`. Keeping the Tauri handle out of this module lets unit tests run
/// without loading the desktop runtime.
pub(crate) trait WebAccessEventSink: Send + Sync {
    fn emit_state(&self, status: &WebAccessStatusView);
    fn emit_pairing(&self, event: &PairingEventView);
}

enum Listener {
    Tls(TlsServerHandle),
    Plain(PlainServerHandle),
}
impl Listener {
    fn is_plain(&self) -> bool {
        matches!(self, Self::Plain(_))
    }
    fn certificate_snapshot(&self) -> Option<super::tls_renewal::TlsCertificateSnapshot> {
        match self {
            Self::Tls(listener) => Some(listener.certificate_snapshot()),
            Self::Plain(_) => None,
        }
    }
    async fn shutdown(self) -> Result<(), WebAccessError> {
        match self {
            Self::Tls(listener) => listener.shutdown().await,
            Self::Plain(listener) => listener.shutdown().await,
        }
    }
}

struct RunningState {
    phase: Phase,
    service: Option<Arc<PairingService>>,
    listener: Option<Listener>,
    bind_addr: Option<SocketAddr>,
    pairing_id: Option<String>,
    last_error_code: Option<&'static str>,
    stop_reason: Option<StopReason>,
    bridge: Option<JoinHandle<()>>,
}

impl Default for RunningState {
    fn default() -> Self {
        Self {
            phase: Phase::Disabled,
            service: None,
            listener: None,
            bind_addr: None,
            pairing_id: None,
            last_error_code: None,
            stop_reason: None,
            bridge: None,
        }
    }
}

/// Process-wide D1b runtime. Managed by Tauri; never starts at setup. The
/// read-only data plane is mounted only when a [`WebDataAccess`] provider is
/// injected; without one every data path stays 404 (pair-only).
pub(crate) struct WebAccessRuntime {
    ca_root: PathBuf,
    events: Option<Arc<dyn WebAccessEventSink>>,
    allow_loopback: bool,
    data: Option<Arc<dyn WebDataAccess>>,
    progress: Option<Arc<dyn WebProgressWrite>>,
    /// Serializes start/stop/pairing-start. Approval/denial only touch the
    /// in-memory service and may overlap with a snapshot read.
    operation: AsyncMutex<()>,
    state: AsyncMutex<RunningState>,
}

impl WebAccessRuntime {
    pub(crate) fn new(
        ca_root: PathBuf,
        events: Arc<dyn WebAccessEventSink>,
        data: Arc<dyn WebDataAccess>,
    ) -> Self {
        Self::with_events(ca_root, Some(events), false, Some(data))
    }

    /// Attach the progress write provider. This only stores the provider; it
    /// never starts the listener. `start_inner` mounts it on the same router
    /// and authority as the read plane, after the explicit start.
    pub(crate) fn with_progress(mut self, progress: Arc<dyn WebProgressWrite>) -> Self {
        self.progress = Some(progress);
        self
    }

    #[cfg(test)]
    pub(crate) fn for_test(ca_root: PathBuf) -> Self {
        Self::with_events(ca_root, None, true, None)
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_data(ca_root: PathBuf, data: Arc<dyn WebDataAccess>) -> Self {
        Self::with_events(ca_root, None, true, Some(data))
    }

    fn with_events(
        ca_root: PathBuf,
        events: Option<Arc<dyn WebAccessEventSink>>,
        allow_loopback: bool,
        data: Option<Arc<dyn WebDataAccess>>,
    ) -> Self {
        Self {
            ca_root,
            events,
            allow_loopback,
            data,
            progress: None,
            operation: AsyncMutex::new(()),
            state: AsyncMutex::new(RunningState::default()),
        }
    }

    pub(crate) fn addresses(&self) -> Result<Vec<LanAddressView>, RuntimeError> {
        Ok(local_lan_addresses()
            .map_err(|_| RuntimeError::NoLanAddress)?
            .into_iter()
            .map(LanAddressView::from)
            .collect())
    }

    /// Current phase/status snapshot. Reads the live certificate snapshot from
    /// the listener, so renewal/root-change state is never stale. CA status is
    /// read through the same `CaManager` path as G1; a damaged or missing CA is
    /// reported as `caInitialized=false` without mutating anything.
    pub(crate) async fn status(&self) -> WebAccessStatusView {
        let (
            phase,
            bind_addr,
            transport,
            cert,
            device_count,
            pending_count,
            pairing_active,
            last_error_code,
            stop_reason,
        ) = {
            let state = self.state.lock().await;
            let cert = state
                .listener
                .as_ref()
                .and_then(Listener::certificate_snapshot);
            let (device_count, pending_count) = state.service.as_ref().map_or((0, 0), |service| {
                (
                    service.session_slots().0 as u32,
                    service.pending_count() as u32,
                )
            });
            // The monotonic store is authoritative; wall-clock display fields
            // may drift if the system time is changed.
            let pairing_active = if state.listener.as_ref().is_some_and(Listener::is_plain) {
                state.phase == Phase::Enabled
            } else {
                match (state.service.as_ref(), state.pairing_id.as_ref()) {
                    (Some(service), Some(pairing_id)) => {
                        service.window_expiry(pairing_id).is_some()
                    }
                    _ => false,
                }
            };
            (
                state.phase,
                state.bind_addr,
                state
                    .listener
                    .as_ref()
                    .map(|listener| if listener.is_plain() { "http" } else { "https" }),
                cert,
                device_count,
                pending_count,
                pairing_active,
                state.last_error_code,
                state.stop_reason,
            )
        };

        let ca = self.ca_status().await.ok().flatten();
        let ca_initialized = ca.is_some() || cert.is_some();
        let root_fingerprint = cert
            .as_ref()
            .map(|snapshot| snapshot.root_fingerprint_sha256.clone())
            .or_else(|| {
                ca.as_ref()
                    .map(|status| status.root_fingerprint_sha256.clone())
            });
        let (bind_ip, port) = bind_addr.map_or((None, None), |addr| {
            (Some(addr.ip().to_string()), Some(addr.port()))
        });

        let certificate_state = cert
            .as_ref()
            .map(|snapshot| snapshot.state.as_str().to_owned());
        // The listener stops itself when the served leaf expires. It cannot
        // mutate the runtime phase, so expose the terminal state as `error`
        // while keeping the real phase (and stop path) intact.
        let display_phase =
            if phase == Phase::Enabled && certificate_state.as_deref() == Some("expired") {
                Phase::Error.as_str()
            } else {
                phase.as_str()
            };
        let effective_error =
            last_error_code.or_else(|| cert.as_ref().and_then(|snapshot| snapshot.last_error_code));

        WebAccessStatusView {
            phase: display_phase.to_owned(),
            transport: transport.map(str::to_owned),
            bind_address: bind_addr.map(|addr| addr.to_string()),
            bind_ip,
            port,
            ca_initialized,
            root_fingerprint_sha256: root_fingerprint,
            leaf_fingerprint_sha256: cert
                .as_ref()
                .map(|snapshot| snapshot.leaf_fingerprint_sha256.clone()),
            leaf_not_after: cert.as_ref().map(|snapshot| snapshot.leaf_not_after),
            certificate_state,
            device_count,
            pending_claim_count: pending_count,
            pairing_active,
            last_error_code: effective_error.map(str::to_owned),
            stop_reason: stop_reason.map(|reason| reason.as_str().to_owned()),
        }
    }

    /// Explicit user start. Validates the address against the current private
    /// LAN list, then the existing CA, then binds. Never creates a CA and never
    /// falls back to wildcard/loopback in release.
    pub(crate) async fn start(
        &self,
        ip: Ipv4Addr,
        port: u16,
    ) -> Result<WebAccessStatusView, RuntimeError> {
        self.start_inner(ip, ip, port).await
    }

    #[cfg(test)]
    pub(crate) async fn start_for_test(
        &self,
        bind_ip: Ipv4Addr,
        san_ip: Ipv4Addr,
        port: u16,
    ) -> Result<WebAccessStatusView, RuntimeError> {
        self.start_inner(bind_ip, san_ip, port).await
    }

    async fn start_inner(
        &self,
        bind_ip: Ipv4Addr,
        san_ip: Ipv4Addr,
        port: u16,
    ) -> Result<WebAccessStatusView, RuntimeError> {
        let _operation = self.operation.lock().await;
        // Check after acquiring the same operation lock used by safe-mode stop.
        if !self.allow_loopback && crate::resilience::ensure_online_allowed().is_err() {
            return Err(RuntimeError::SafeMode);
        }
        {
            let state = self.state.lock().await;
            match state.phase {
                Phase::Disabled | Phase::Error => {}
                Phase::Starting | Phase::Enabled | Phase::Stopping => {
                    return Err(RuntimeError::AlreadyEnabled)
                }
            }
        }

        if !self.allow_loopback {
            if !is_private_lan_ipv4(bind_ip) {
                return Err(RuntimeError::InvalidIp);
            }
            let current = local_lan_addresses().map_err(|_| RuntimeError::NoLanAddress)?;
            if !current.iter().any(|address| address.ip == bind_ip) {
                return Err(RuntimeError::InvalidIp);
            }
        }
        if !is_private_lan_ipv4(san_ip) {
            return Err(RuntimeError::InvalidIp);
        }

        // The CA must already exist and pass its full status/ACL audit. A
        // missing CA is a fail-closed error, never an implicit initialize.
        if self.ca_status().await?.is_none() {
            return Err(RuntimeError::Ca(CaError::NotInitialized));
        }

        {
            let mut state = self.state.lock().await;
            state.phase = Phase::Starting;
            state.last_error_code = None;
            state.stop_reason = None;
            state.bind_addr = None;
            state.pairing_id = None;
        }
        self.emit_state().await;

        let service = Arc::new(PairingService::new(
            PairingStore::new(Arc::new(SystemClock)),
            SessionStore::new(Arc::new(SystemClock)),
        ));
        let factory_data = self.data.clone();
        let factory_progress = self.progress.clone();
        let factory_service = Arc::clone(&service);
        let factory: HandlerFactory = Arc::new(move |addr| {
            let mut router = match factory_data.as_ref() {
                Some(provider) => PairingHttp::with_data(
                    Arc::clone(&factory_service),
                    addr,
                    Arc::clone(provider),
                )?,
                None => PairingHttp::new(Arc::clone(&factory_service), addr)?,
            };
            if let Some(progress) = factory_progress.as_ref() {
                router.with_progress(Arc::clone(progress));
            }
            let router = Arc::new(router);
            let handler: RequestHandler = Arc::new(move |request, peer| {
                let router = Arc::clone(&router);
                let source_ip = match peer.ip() {
                    std::net::IpAddr::V4(ip) => ip,
                    std::net::IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
                };
                Box::pin(
                    async move { Ok::<_, Infallible>(router.handle(request, source_ip).await) },
                )
            });
            Ok(handler)
        });

        let config = TlsServerConfig {
            ca_root: self.ca_root.clone(),
            bind_addr: SocketAddr::from((bind_ip, port)),
            san_ips: Some(vec![san_ip]),
        };
        let started = start_tls_server_with(config, factory).await;
        match started {
            Ok(listener) => {
                let local_addr = listener.local_addr();
                let mut state = self.state.lock().await;
                state.phase = Phase::Enabled;
                state.service = Some(service);
                state.listener = Some(Listener::Tls(listener));
                state.bind_addr = Some(local_addr);
                state.last_error_code = None;
                drop(state);
                self.emit_state().await;
                Ok(self.status().await)
            }
            Err(error) => {
                let code = error.code();
                {
                    let mut state = self.state.lock().await;
                    state.phase = Phase::Error;
                    state.last_error_code = Some(code);
                    state.service = None;
                    state.listener = None;
                    state.bind_addr = None;
                }
                self.emit_state().await;
                Err(RuntimeError::Tls(error))
            }
        }
    }

    /// Start the explicitly requested, unencrypted private-LAN mode.
    pub(crate) async fn start_plain(
        &self,
        ip: Ipv4Addr,
        port: u16,
    ) -> Result<WebAccessStatusView, RuntimeError> {
        let _operation = self.operation.lock().await;
        // Check after acquiring the same operation lock used by safe-mode stop.
        if !self.allow_loopback && crate::resilience::ensure_online_allowed().is_err() {
            return Err(RuntimeError::SafeMode);
        }
        {
            let state = self.state.lock().await;
            if !matches!(state.phase, Phase::Disabled | Phase::Error) {
                return Err(RuntimeError::AlreadyEnabled);
            }
        }
        if !self.allow_loopback {
            if !is_private_lan_ipv4(ip) {
                return Err(RuntimeError::InvalidIp);
            }
            let current = local_lan_addresses().map_err(|_| RuntimeError::NoLanAddress)?;
            if !current.iter().any(|address| address.ip == ip) {
                return Err(RuntimeError::InvalidIp);
            }
        } else if !ip.is_loopback() && !is_private_lan_ipv4(ip) {
            return Err(RuntimeError::InvalidIp);
        }
        {
            let mut state = self.state.lock().await;
            state.phase = Phase::Starting;
            state.last_error_code = None;
            state.stop_reason = None;
            state.bind_addr = None;
            state.pairing_id = None;
        }
        self.emit_state().await;
        let service = Arc::new(PairingService::new(
            PairingStore::new(Arc::new(SystemClock)),
            SessionStore::new(Arc::new(SystemClock)),
        ));
        let factory_data = self.data.clone();
        let factory_progress = self.progress.clone();
        let factory_service = Arc::clone(&service);
        let factory: HandlerFactory = Arc::new(move |addr| {
            let mut router = match factory_data.as_ref() {
                Some(provider) => PairingHttp::with_data_open(
                    Arc::clone(&factory_service),
                    addr,
                    Arc::clone(provider),
                )?,
                None => PairingHttp::new_with_scheme(Arc::clone(&factory_service), addr, true)?,
            };
            if let Some(progress) = factory_progress.as_ref() {
                router.with_progress(Arc::clone(progress));
            }
            let router = Arc::new(router);
            let handler: RequestHandler = Arc::new(move |request, peer| {
                let router = Arc::clone(&router);
                let source_ip = match peer.ip() {
                    std::net::IpAddr::V4(ip) => ip,
                    std::net::IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
                };
                Box::pin(
                    async move { Ok::<_, Infallible>(router.handle(request, source_ip).await) },
                )
            });
            Ok(handler)
        });
        match start_plain_server(SocketAddr::from((ip, port)), factory, self.allow_loopback).await {
            Ok(listener) => {
                let addr = listener.local_addr();
                let bridge = self.spawn_open_bridge(Arc::clone(&service));
                let mut state = self.state.lock().await;
                state.phase = Phase::Enabled;
                state.service = Some(service);
                state.listener = Some(Listener::Plain(listener));
                state.bind_addr = Some(addr);
                state.bridge = bridge;
                state.last_error_code = None;
                drop(state);
                self.emit_state().await;
                Ok(self.status().await)
            }
            Err(error) => {
                let mut state = self.state.lock().await;
                state.phase = Phase::Error;
                state.last_error_code = Some(error.code());
                drop(state);
                self.emit_state().await;
                Err(RuntimeError::Tls(error))
            }
        }
    }

    /// Stop listener + pairing + sessions. Idempotent; a failed shutdown lands
    /// in `Error` and is never retried automatically.
    pub(crate) async fn stop(&self, reason: StopReason) -> WebAccessStatusView {
        // Recovery/safe-mode/exit may run while the main WebView is frozen.
        // The panel re-reads the snapshot on remount, so skip the event emit
        // there rather than risk blocking on a dead renderer.
        let notify = matches!(reason, StopReason::Stopped);
        let _operation = self.operation.lock().await;
        let (service, listener, bridge) = {
            let mut state = self.state.lock().await;
            if state.phase == Phase::Disabled {
                state.stop_reason = Some(reason);
                (None, None, None)
            } else {
                state.phase = Phase::Stopping;
                (
                    state.service.take(),
                    state.listener.take(),
                    state.bridge.take(),
                )
            }
        };
        if let Some(bridge) = bridge {
            bridge.abort();
        }
        let mut failure = None;
        // Close the listener first so no additional request can enter while
        // we wait for any already-admitted progress transaction to finish.
        if let Some(listener) = listener {
            match tokio::time::timeout(SHUTDOWN_TIMEOUT, listener.shutdown()).await {
                Ok(Ok(())) => {}
                _ => failure = Some("web-access-server-join"),
            }
        }
        if let Some(service) = service {
            if tokio::task::spawn_blocking(move || service.stop_all())
                .await
                .is_err()
            {
                failure = Some("web-access-server-join");
            }
        }

        {
            let mut state = self.state.lock().await;
            state.phase = if failure.is_some() {
                Phase::Error
            } else {
                Phase::Disabled
            };
            state.bind_addr = None;
            state.pairing_id = None;
            state.last_error_code = failure;
            state.stop_reason = Some(reason);
        }
        if notify {
            self.emit_state().await;
        }
        self.status().await
    }

    pub(crate) async fn pairing_start(&self) -> Result<PairingWindowView, RuntimeError> {
        let _operation = self.operation.lock().await;
        let (service, bind_addr, old_bridge) = {
            let mut state = self.state.lock().await;
            if state.phase != Phase::Enabled {
                return Err(RuntimeError::NotEnabled);
            }
            ensure_listener_serving(state.listener.as_ref())?;
            if state.listener.as_ref().is_some_and(Listener::is_plain) {
                let addr = state.bind_addr.ok_or(RuntimeError::InvalidState)?;
                return Ok(PairingWindowView {
                    url: format!("http://{addr}/"),
                    expires_at_unix_ms: 0,
                });
            }
            (
                state.service.clone().ok_or(RuntimeError::NotEnabled)?,
                state.bind_addr.ok_or(RuntimeError::InvalidState)?,
                state.bridge.take(),
            )
        };
        if let Some(bridge) = old_bridge {
            bridge.abort();
        }
        // One active window per runtime; starting another cancels the first.
        service.cancel_window();
        let window = service.start_window();
        let expires_at_unix_ms = to_unix_ms(service.clock().now(), window.expires_at);
        let url = pairing_url(bind_addr, &window.id);
        let view = PairingWindowView {
            url,
            expires_at_unix_ms,
        };
        let bridge = self.spawn_pairing_bridge(Arc::clone(&service), window.id.clone());
        {
            let mut state = self.state.lock().await;
            state.pairing_id = Some(window.id);
            state.bridge = bridge;
        }
        self.emit_pairing(PairingEventView::window("window-started", 0));
        Ok(view)
    }

    pub(crate) async fn pairing_state(&self) -> PairingStateView {
        let _operation = self.operation.lock().await;
        let (service, bind_addr, pairing_id) = {
            let state = self.state.lock().await;
            (
                state.service.clone(),
                state.bind_addr,
                state.pairing_id.clone(),
            )
        };
        if let (Some(service), Some(addr)) = (&service, bind_addr) {
            let state = self.state.lock().await;
            if state.listener.as_ref().is_some_and(Listener::is_plain) {
                return PairingStateView {
                    window: Some(PairingWindowView {
                        url: format!("http://{addr}/"),
                        expires_at_unix_ms: 0,
                    }),
                    claims: pending_claim_views(service),
                };
            }
        }
        let (Some(service), Some(bind_addr), Some(pairing_id)) = (service, bind_addr, pairing_id)
        else {
            return PairingStateView {
                window: None,
                claims: Vec::new(),
            };
        };
        let Some(expires_at) = service.window_expiry(&pairing_id) else {
            self.clear_pairing_window().await;
            self.emit_pairing(PairingEventView::window("window-expired", 0));
            return PairingStateView {
                window: None,
                claims: Vec::new(),
            };
        };
        let window = PairingWindowView {
            url: pairing_url(bind_addr, &pairing_id),
            expires_at_unix_ms: to_unix_ms(service.clock().now(), expires_at),
        };
        let claims = pending_claim_views(&service);
        PairingStateView {
            window: Some(window),
            claims,
        }
    }

    pub(crate) async fn approve(
        &self,
        claim_id: &str,
    ) -> Result<WebAccessStatusView, RuntimeError> {
        let _operation = self.operation.lock().await;
        let service = self.enabled_service().await?;
        // Keep the bridge until approval succeeds: an error must not detach a
        // task that stop/new-window cannot abort.
        service.approve(claim_id)?;
        let is_plain = self
            .state
            .lock()
            .await
            .listener
            .as_ref()
            .is_some_and(Listener::is_plain);
        if !is_plain {
            self.abort_pairing_bridge().await;
            self.clear_pairing_window().await;
        }
        self.emit_pairing(PairingEventView {
            kind: "claim-approved".to_owned(),
            claim_id: Some(claim_id.to_owned()),
            device_name: None,
            source_ip: None,
            created_at_unix_ms: None,
            pending_count: service.pending_count() as u32,
        });
        Ok(self.status().await)
    }

    pub(crate) async fn deny(&self, claim_id: &str) -> Result<WebAccessStatusView, RuntimeError> {
        let _operation = self.operation.lock().await;
        let service = self.enabled_service().await?;
        service.deny(claim_id)?;
        self.emit_pairing(PairingEventView {
            kind: "claim-denied".to_owned(),
            claim_id: Some(claim_id.to_owned()),
            device_name: None,
            source_ip: None,
            created_at_unix_ms: None,
            pending_count: service.pending_count() as u32,
        });
        Ok(self.status().await)
    }

    pub(crate) async fn cancel_pairing(&self) -> Result<WebAccessStatusView, RuntimeError> {
        let _operation = self.operation.lock().await;
        let service = self.enabled_service().await?;
        service.cancel_window();
        let is_plain = self
            .state
            .lock()
            .await
            .listener
            .as_ref()
            .is_some_and(Listener::is_plain);
        if !is_plain {
            self.abort_pairing_bridge().await;
            self.clear_pairing_window().await;
        }
        self.emit_pairing(PairingEventView::window("window-cancelled", 0));
        Ok(self.status().await)
    }

    pub(crate) async fn devices(&self) -> Vec<DeviceView> {
        let service = {
            let state = self.state.lock().await;
            state.service.clone()
        };
        let Some(service) = service else {
            return Vec::new();
        };
        let now = service.clock().now();
        service
            .devices()
            .into_iter()
            .map(|device| DeviceView {
                id: device.id,
                device_name: device.device_name,
                issued_at_unix_ms: to_unix_ms(now, device.issued_at),
                expires_at_unix_ms: to_unix_ms(now, device.expires_at),
                absolute_expires_at_unix_ms: to_unix_ms(now, device.absolute_expires_at),
            })
            .collect()
    }

    pub(crate) async fn revoke_device(&self, device_id: &str) -> Result<bool, RuntimeError> {
        let service = {
            let state = self.state.lock().await;
            state.service.clone()
        };
        let Some(service) = service else {
            return Ok(false);
        };
        let device_id = device_id.to_owned();
        let revoked = tokio::task::spawn_blocking(move || service.revoke_device(&device_id))
            .await
            .map_err(|_| RuntimeError::Tls(WebAccessError::ServerJoin))?;
        if revoked {
            self.emit_state().await;
        }
        Ok(revoked)
    }

    #[cfg(test)]
    pub(crate) async fn service_for_test(&self) -> Option<Arc<PairingService>> {
        let state = self.state.lock().await;
        state.service.clone()
    }

    async fn enabled_service(&self) -> Result<Arc<PairingService>, RuntimeError> {
        let state = self.state.lock().await;
        if state.phase != Phase::Enabled {
            return Err(RuntimeError::NotEnabled);
        }
        ensure_listener_serving(state.listener.as_ref())?;
        state.service.clone().ok_or(RuntimeError::NotEnabled)
    }

    async fn abort_pairing_bridge(&self) {
        let bridge = {
            let mut state = self.state.lock().await;
            state.bridge.take()
        };
        if let Some(bridge) = bridge {
            bridge.abort();
        }
    }

    async fn clear_pairing_window(&self) {
        let mut state = self.state.lock().await;
        state.pairing_id = None;
    }

    async fn ca_status(&self) -> Result<Option<crate::ca::CaStatus>, RuntimeError> {
        let root = self.ca_root.clone();
        let result = tokio::task::spawn_blocking(move || CaManager::new(root).status())
            .await
            .map_err(|_| RuntimeError::Ca(CaError::Io(std::io::Error::other("ca status task"))))?;
        match result {
            Ok(status) => Ok(Some(status)),
            Err(CaError::NotInitialized) => Ok(None),
            Err(error) => Err(RuntimeError::Ca(error)),
        }
    }

    async fn emit_state(&self) {
        if let Some(events) = self.events.as_ref() {
            let status = self.status().await;
            events.emit_state(&status);
        }
    }

    fn emit_pairing(&self, event: PairingEventView) {
        if let Some(events) = self.events.as_ref() {
            events.emit_pairing(&event);
        }
    }

    fn spawn_open_bridge(&self, service: Arc<PairingService>) -> Option<JoinHandle<()>> {
        let events = self.events.clone()?;
        Some(tokio::spawn(async move {
            let mut known: HashSet<String> = HashSet::new();
            let mut ticker = tokio::time::interval(PAIRING_BRIDGE_TICK);
            loop {
                ticker.tick().await;
                let pending = pending_claim_views(&service);
                let current = pending
                    .iter()
                    .map(|claim| claim.claim_id.clone())
                    .collect::<HashSet<_>>();
                for claim in pending
                    .iter()
                    .filter(|claim| !known.contains(&claim.claim_id))
                {
                    events.emit_pairing(&PairingEventView::claim(
                        "claim-created",
                        claim,
                        pending.len(),
                    ));
                }
                for removed in known.difference(&current) {
                    events.emit_pairing(&PairingEventView {
                        kind: "claim-removed".into(),
                        claim_id: Some(removed.clone()),
                        device_name: None,
                        source_ip: None,
                        created_at_unix_ms: None,
                        pending_count: pending.len() as u32,
                    });
                }
                known = current;
            }
        }))
    }

    fn spawn_pairing_bridge(
        &self,
        service: Arc<PairingService>,
        pairing_id: String,
    ) -> Option<JoinHandle<()>> {
        let events = self.events.clone()?;
        Some(tokio::spawn(async move {
            let mut known: HashSet<String> = HashSet::new();
            let mut ticker = tokio::time::interval(PAIRING_BRIDGE_TICK);
            loop {
                ticker.tick().await;
                if service.window_expiry(&pairing_id).is_none() {
                    events.emit_pairing(&PairingEventView::window(
                        "window-expired",
                        service.pending_count(),
                    ));
                    return;
                }
                let pending = pending_claim_views(&service);
                let current = pending
                    .iter()
                    .map(|claim| claim.claim_id.clone())
                    .collect::<HashSet<_>>();
                for claim in pending
                    .iter()
                    .filter(|claim| !known.contains(&claim.claim_id))
                {
                    events.emit_pairing(&PairingEventView::claim(
                        "claim-created",
                        claim,
                        pending.len(),
                    ));
                }
                for removed in known.difference(&current) {
                    events.emit_pairing(&PairingEventView {
                        kind: "claim-removed".to_owned(),
                        claim_id: Some(removed.clone()),
                        device_name: None,
                        source_ip: None,
                        created_at_unix_ms: None,
                        pending_count: pending.len() as u32,
                    });
                }
                known = current;
            }
        }))
    }
}

impl std::fmt::Debug for WebAccessRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebAccessRuntime")
            .field("allow_loopback", &self.allow_loopback)
            .finish_non_exhaustive()
    }
}

/// Reject new pairing/approval work once the listener can no longer complete
/// a handshake. The runtime phase may still read `enabled` until the user
/// stops it; this guard prevents a dead listener from issuing new QR codes.
fn ensure_listener_serving(listener: Option<&Listener>) -> Result<(), RuntimeError> {
    match listener {
        Some(Listener::Tls(listener)) => match listener.certificate_snapshot().state {
            TlsCertificateState::Expired | TlsCertificateState::Stopped => {
                Err(RuntimeError::Tls(WebAccessError::CertificateExpired))
            }
            _ => Ok(()),
        },
        Some(Listener::Plain(listener)) if listener.is_running() => Ok(()),
        _ => Err(RuntimeError::NotEnabled),
    }
}

fn pending_claim_views(service: &PairingService) -> Vec<PendingClaimView> {
    let now = service.clock().now();
    service
        .pending_claims()
        .into_iter()
        .map(|claim| PendingClaimView {
            claim_id: claim.claim_id,
            device_name: claim.device_name,
            source_ip: claim.source_ip.to_string(),
            created_at_unix_ms: to_unix_ms(now, claim.created_at),
            expires_at_unix_ms: to_unix_ms(now, claim.expires_at),
        })
        .collect()
}

fn pairing_url(bind_addr: SocketAddr, pairing_id: &str) -> String {
    format!("https://{bind_addr}/#{pairing_id}")
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn to_unix_ms(now: Instant, target: Instant) -> i64 {
    let now_unix = now_unix_ms();
    if target >= now {
        now_unix.saturating_add(
            i64::try_from(target.duration_since(now).as_millis()).unwrap_or(i64::MAX),
        )
    } else {
        now_unix.saturating_sub(
            i64::try_from(now.duration_since(target).as_millis()).unwrap_or(i64::MAX),
        )
    }
}

/// The only place the desktop UI receives a pairing id is the fragment of this
/// URL. It is never included in events or status snapshots. Test-only helper.
#[cfg(test)]
pub(crate) fn pairing_id_from_url(url: &str) -> Option<&str> {
    url.rsplit_once('#').map(|(_, fragment)| fragment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ca::test_helpers::temp_path;

    struct TestCa {
        root: PathBuf,
    }

    impl TestCa {
        fn new(tag: &str) -> Self {
            let root = temp_path(tag).join("ca");
            CaManager::new(root.clone()).initialize().unwrap();
            Self { root }
        }
    }

    impl Drop for TestCa {
        fn drop(&mut self) {
            if let Ok(status) = CaManager::new(self.root.clone()).status() {
                let _ = CaManager::new(self.root.clone()).destroy(&status.root_fingerprint_sha256);
            }
            if let Some(parent) = self.root.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    #[tokio::test]
    async fn plain_runtime_emits_requests_supports_multiple_devices_and_revokes_on_stop() {
        #[derive(Default)]
        struct Sink(std::sync::Mutex<Vec<String>>);
        impl WebAccessEventSink for Sink {
            fn emit_state(&self, _: &WebAccessStatusView) {}
            fn emit_pairing(&self, event: &PairingEventView) {
                self.0.lock().unwrap().push(event.kind.clone());
            }
        }
        let wrapper = temp_path("plain-runtime-events");
        let sink = Arc::new(Sink::default());
        let runtime =
            WebAccessRuntime::with_events(wrapper.join("ca"), Some(sink.clone()), true, None);
        let started = runtime.start_plain(Ipv4Addr::LOCALHOST, 0).await.unwrap();
        assert_eq!(started.transport.as_deref(), Some("http"));
        assert!(started.pairing_active);
        assert!(!started.ca_initialized);
        assert!(runtime
            .pairing_state()
            .await
            .window
            .unwrap()
            .url
            .starts_with("http://127.0.0.1:"));
        assert!(runtime
            .pairing_start()
            .await
            .unwrap()
            .url
            .starts_with("http://127.0.0.1:"));
        let service = runtime.service_for_test().await.unwrap();
        let first = service
            .claim_open("Phone", NONCE, Ipv4Addr::new(192, 168, 1, 20))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !sink
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|kind| kind == "claim-created")
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        runtime.approve(&first.claim_id).await.unwrap();
        let session = service
            .consume(&first.claim_id, first.claim_secret.as_str())
            .unwrap();
        assert!(service.authenticate(session.token.as_str()).is_some());
        let second = service
            .claim_open("Tablet", NONCE, Ipv4Addr::new(192, 168, 1, 21))
            .unwrap();
        assert_eq!(runtime.pairing_state().await.claims.len(), 1);
        runtime.approve(&second.claim_id).await.unwrap();
        let second_session = service
            .consume(&second.claim_id, second.claim_secret.as_str())
            .unwrap();
        assert!(service
            .authenticate(second_session.token.as_str())
            .is_some());
        assert_eq!(runtime.stop(StopReason::Stopped).await.phase, "disabled");
        assert!(service.authenticate(session.token.as_str()).is_none());
        assert!(service
            .authenticate(second_session.token.as_str())
            .is_none());
        let _ = std::fs::remove_dir_all(wrapper);
    }

    #[tokio::test]
    async fn runtime_defaults_to_disabled_and_reports_ca_state() {
        let wrapper = temp_path("runtime-disabled");
        let root = wrapper.join("ca");
        let runtime = WebAccessRuntime::for_test(root.clone());

        let status = runtime.status().await;
        assert_eq!(status.phase, "disabled");
        assert!(!status.ca_initialized);
        assert!(status.bind_address.is_none());
        assert_eq!(status.device_count, 0);
        assert_eq!(status.pending_claim_count, 0);

        CaManager::new(root.clone()).initialize().unwrap();
        let status = runtime.status().await;
        assert_eq!(status.phase, "disabled");
        assert!(status.ca_initialized);
        assert!(status.root_fingerprint_sha256.is_some());
        assert!(status.leaf_fingerprint_sha256.is_none());

        let ca_status = CaManager::new(root.clone()).status().unwrap();
        let _ = CaManager::new(root).destroy(&ca_status.root_fingerprint_sha256);
        let _ = std::fs::remove_dir_all(wrapper);
    }

    #[tokio::test]
    async fn runtime_start_stop_restart_and_duplicate_start() {
        let ca = TestCa::new("runtime-start");
        let runtime = WebAccessRuntime::for_test(ca.root.clone());

        let started = runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
            .await
            .unwrap();
        assert_eq!(started.phase, "enabled");
        assert_eq!(started.bind_ip.as_deref(), Some("127.0.0.1"));
        assert!(started.port.unwrap_or(0) > 0);
        assert_eq!(started.certificate_state.as_deref(), Some("serving"));
        assert!(started.leaf_fingerprint_sha256.is_some());
        assert!(started.leaf_not_after.is_some());
        assert!(started.ca_initialized);

        let duplicate = runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
            .await
            .unwrap_err();
        assert_eq!(duplicate.code(), "web-access-already-enabled");

        let stopped = runtime.stop(StopReason::Stopped).await;
        assert_eq!(stopped.phase, "disabled");
        assert_eq!(stopped.stop_reason.as_deref(), Some("stopped"));
        assert!(stopped.bind_address.is_none());
        assert!(stopped.leaf_fingerprint_sha256.is_none());

        let restarted = runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
            .await
            .unwrap();
        assert_eq!(restarted.phase, "enabled");
        let stopped = runtime.stop(StopReason::Exit).await;
        assert_eq!(stopped.stop_reason.as_deref(), Some("exit"));
    }

    #[tokio::test]
    async fn stop_queued_during_start_leaves_runtime_disabled() {
        let runtime = Arc::new(WebAccessRuntime::for_test(
            temp_path("queued-stop").join("ca"),
        ));
        let operation = runtime.operation.lock().await;

        let start_runtime = Arc::clone(&runtime);
        let start_queued = Arc::new(tokio::sync::Notify::new());
        let start_signal = Arc::clone(&start_queued);
        let start_task = tokio::spawn(async move {
            start_signal.notify_one();
            start_runtime
                .start_plain(Ipv4Addr::LOCALHOST, 0)
                .await
                .unwrap()
        });
        start_queued.notified().await;

        let stop_runtime = Arc::clone(&runtime);
        let stop_queued = Arc::new(tokio::sync::Notify::new());
        let stop_signal = Arc::clone(&stop_queued);
        let stop_task = tokio::spawn(async move {
            stop_signal.notify_one();
            stop_runtime.stop(StopReason::Stopped).await
        });
        stop_queued.notified().await;

        drop(operation);

        let started = start_task.await.unwrap();
        let stopped = stop_task.await.unwrap();
        assert_eq!(started.phase, "enabled");
        assert_eq!(stopped.phase, "disabled");
        assert_eq!(runtime.status().await.phase, "disabled");
    }

    #[tokio::test]
    async fn pairing_window_approve_consume_and_revoke_are_secret_free() {
        let ca = TestCa::new("runtime-pairing");
        let runtime = WebAccessRuntime::for_test(ca.root.clone());
        runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
            .await
            .unwrap();

        let window = runtime.pairing_start().await.unwrap();
        assert!(window.url.starts_with("https://127.0.0.1:"));
        assert!(window.expires_at_unix_ms > now_unix_ms());
        let pairing_id = pairing_id_from_url(&window.url)
            .expect("fragment")
            .to_owned();
        assert!(pairing_id.starts_with("pair_"));
        let state = runtime.pairing_state().await;
        assert_eq!(
            state.window.as_ref().map(|view| view.url.as_str()),
            Some(window.url.as_str())
        );
        assert!(state.claims.is_empty());

        let service = runtime.service_for_test().await.expect("service");
        let issued = service
            .claim(
                &pairing_id,
                "Pixel 8",
                NONCE,
                Ipv4Addr::new(192, 168, 1, 20),
            )
            .unwrap();
        let pending = runtime.pairing_state().await;
        assert_eq!(pending.claims.len(), 1);
        assert_eq!(pending.claims[0].device_name, "Pixel 8");
        assert!(!format!("{pending:?}").contains(issued.claim_secret.as_str()));

        let approved = runtime.approve(&issued.claim_id).await.unwrap();
        assert_eq!(approved.phase, "enabled");
        assert_eq!(approved.pending_claim_count, 0);
        assert!(!approved.pairing_active);

        let session = service
            .consume(&issued.claim_id, issued.claim_secret.as_str())
            .unwrap();
        assert_eq!(session.token.len(), 49);
        let devices = runtime.devices().await;
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_name, "Pixel 8");
        assert!(!format!("{devices:?}").contains(session.token.as_str()));

        assert!(runtime.revoke_device(&devices[0].id).await.unwrap());
        assert!(runtime.devices().await.is_empty());
        runtime.stop(StopReason::Stopped).await;
    }

    #[tokio::test]
    async fn pairing_deny_and_cancel_do_not_start_a_window_automatically() {
        let ca = TestCa::new("runtime-deny");
        let runtime = WebAccessRuntime::for_test(ca.root.clone());
        runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
            .await
            .unwrap();

        let window = runtime.pairing_start().await.unwrap();
        let pairing_id = pairing_id_from_url(&window.url)
            .expect("fragment")
            .to_owned();
        let service = runtime.service_for_test().await.expect("service");
        let issued = service
            .claim(
                &pairing_id,
                "Pixel 8",
                NONCE,
                Ipv4Addr::new(192, 168, 1, 20),
            )
            .unwrap();
        let denied = runtime.deny(&issued.claim_id).await.unwrap();
        assert_eq!(denied.phase, "enabled");

        let cancelled = runtime.cancel_pairing().await.unwrap();
        assert_eq!(cancelled.phase, "enabled");
        assert!(!cancelled.pairing_active);
        assert!(runtime.pairing_state().await.window.is_none());
        runtime.stop(StopReason::Stopped).await;
    }

    #[tokio::test]
    async fn invalid_ip_and_uninitialized_ca_fail_before_binding() {
        let wrapper = temp_path("runtime-no-ca");
        let root = wrapper.join("ca");
        let runtime = WebAccessRuntime::for_test(root);
        let uninitialized = runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
            .await
            .unwrap_err();
        assert_eq!(uninitialized.code(), "ca-not-initialized");
        assert_eq!(runtime.status().await.phase, "disabled");

        let invalid = runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(8, 8, 8, 8), 0)
            .await
            .unwrap_err();
        assert_eq!(invalid.code(), "web-access-invalid-ip");
        assert_eq!(runtime.status().await.phase, "disabled");
        let _ = std::fs::remove_dir_all(wrapper);
    }

    #[tokio::test]
    async fn bind_conflict_lands_in_error_and_stop_clears_it() {
        let ca = TestCa::new("runtime-bind-conflict");
        let runtime = WebAccessRuntime::for_test(ca.root.clone());
        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = occupied.local_addr().unwrap().port();
        let error = runtime
            .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), port)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "web-access-io");
        let status = runtime.status().await;
        assert_eq!(status.phase, "error");
        assert_eq!(status.last_error_code.as_deref(), Some("web-access-io"));
        let stopped = runtime.stop(StopReason::Stopped).await;
        assert_eq!(stopped.phase, "disabled");
        assert!(stopped.last_error_code.is_none());
        drop(occupied);
    }

    #[test]
    fn pairing_url_and_events_carry_no_secret_or_token() {
        let url = pairing_url(
            SocketAddr::from(([192, 168, 1, 10], 8443)),
            "pair_0123456789abcdef0123456789abcdef",
        );
        assert_eq!(
            url,
            "https://192.168.1.10:8443/#pair_0123456789abcdef0123456789abcdef"
        );
        let event = PairingEventView::claim(
            "claim-created",
            &PendingClaimView {
                claim_id: "claim_x".into(),
                device_name: "Pixel 8".into(),
                source_ip: "192.168.1.20".into(),
                created_at_unix_ms: 1,
                expires_at_unix_ms: 2,
            },
            1,
        );
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("claimId"));
        for forbidden in ["pairingId", "claimSecret", "secretHash", "token", "pair_"] {
            assert!(!json.contains(forbidden), "{json} contains {forbidden}");
        }
        let window = PairingEventView::window("window-started", 0);
        let json = serde_json::to_string(&window).unwrap();
        assert!(!json.contains("pairingId"));
        assert!(!json.contains("claimSecret"));
    }
}
