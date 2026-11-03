use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rustls_pki_types::ServerName;
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ca::CaManager;
use crate::read_service::{
    ImageAsset, PageManifest, ProgressView, TileImage, WebBook, WebBookDetail, WebBookPage,
};
use crate::PageDim;

use super::auth::PairingService;
use super::clock::SystemClock;
use super::data::{DataError, WebDataAccess};
use super::pairing::PairingStore;
use super::router::PairingHttp;
use super::session::SessionStore;
use super::tls::{
    start_tls_server_with_clock, start_tls_server_with_clock_and_handler,
    start_tls_server_with_clock_and_header_timeout, HandlerFactory, RequestHandler,
};
use super::*;

#[test]
fn private_ipv4_filter_accepts_rfc1918_and_rejects_other_ranges() {
    for ip in [
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(10, 255, 255, 254),
        Ipv4Addr::new(172, 16, 0, 1),
        Ipv4Addr::new(172, 31, 255, 254),
        Ipv4Addr::new(192, 168, 1, 10),
    ] {
        assert!(is_private_lan_ipv4(ip), "{ip} must be accepted");
    }

    for ip in [
        Ipv4Addr::new(127, 0, 0, 1),
        Ipv4Addr::new(169, 254, 1, 1),
        Ipv4Addr::new(8, 8, 8, 8),
        Ipv4Addr::new(172, 15, 0, 1),
        Ipv4Addr::new(172, 32, 0, 1),
        Ipv4Addr::new(224, 0, 0, 1),
        Ipv4Addr::new(255, 255, 255, 255),
        Ipv4Addr::new(0, 0, 0, 0),
        Ipv4Addr::new(192, 169, 1, 1),
    ] {
        assert!(!is_private_lan_ipv4(ip), "{ip} must be rejected");
    }
}

#[test]
fn select_san_ips_deduplicates_sorts_and_enforces_the_ca_limit() {
    let selected = select_san_ips(Some(vec![
        Ipv4Addr::new(192, 168, 1, 10),
        Ipv4Addr::new(10, 0, 0, 2),
        Ipv4Addr::new(10, 0, 0, 2),
    ]))
    .unwrap();
    assert_eq!(
        selected,
        vec![Ipv4Addr::new(10, 0, 0, 2), Ipv4Addr::new(192, 168, 1, 10)]
    );

    assert_eq!(
        select_san_ips(Some(Vec::new())).unwrap_err().code(),
        "web-access-no-lan-address"
    );
    assert_eq!(
        select_san_ips(Some(vec![Ipv4Addr::new(8, 8, 8, 8)]))
            .unwrap_err()
            .code(),
        "web-access-invalid-san"
    );

    let too_many = (1..=9)
        .map(|n| Ipv4Addr::new(10, 0, 0, n))
        .collect::<Vec<_>>();
    assert_eq!(
        select_san_ips(Some(too_many)).unwrap_err().code(),
        "web-access-too-many-lan-addresses"
    );
}

struct TestCa {
    root: PathBuf,
    wrapper: PathBuf,
    clock: Arc<Mutex<OffsetDateTime>>,
}

impl TestCa {
    fn new(tag: &str) -> Self {
        Self::with_clock_at(tag, OffsetDateTime::now_utc())
    }

    fn renewal(tag: &str) -> Self {
        Self::with_clock_at(tag, OffsetDateTime::now_utc() - TimeDuration::days(23))
    }

    fn with_clock_at(tag: &str, now: OffsetDateTime) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let wrapper = std::env::temp_dir().join(format!(
            "mr-web-access-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&wrapper).unwrap();
        Self {
            root: wrapper.join("ca"),
            wrapper,
            clock: Arc::new(Mutex::new(now)),
        }
    }

    fn manager(&self) -> CaManager {
        CaManager::with_clock(self.root.clone(), self.clock_handle())
    }

    fn clock_handle(&self) -> Arc<dyn Fn() -> OffsetDateTime + Send + Sync> {
        let clock = self.clock.clone();
        Arc::new(move || *clock.lock().unwrap())
    }

    fn advance(&self, duration: TimeDuration) {
        *self.clock.lock().unwrap() += duration;
    }

    fn initialize(&self) {
        self.manager().initialize().unwrap();
    }

    fn root_cert_der(&self) -> Vec<u8> {
        self.manager().root_certificate().unwrap().cert_der
    }
}

impl Drop for TestCa {
    fn drop(&mut self) {
        if let Ok(status) = self.manager().status() {
            let _ = self.manager().destroy(&status.root_fingerprint_sha256);
        }
        let _ = std::fs::remove_dir_all(&self.wrapper);
    }
}

fn client_config(root_der: Vec<u8>) -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls_pki_types::CertificateDer::from(root_der))
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

async fn connect_tls(
    addr: std::net::SocketAddr,
    config: Arc<rustls::ClientConfig>,
    name: ServerName<'static>,
) -> std::io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let stream = TcpStream::connect(addr).await?;
    tokio_rustls::TlsConnector::from(config)
        .connect(name, stream)
        .await
}

async fn http_request<S>(stream: &mut S, method: &str, path: &str) -> String
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stream
        .write_all(
            format!("{method} {path} HTTP/1.1\r\nHost: moyu.local\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}

fn test_server_config(ca: &TestCa) -> TlsServerConfig {
    TlsServerConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        san_ips: Some(vec![Ipv4Addr::new(192, 168, 1, 10)]),
        ..TlsServerConfig::new(ca.root.clone())
    }
}

async fn start_with_test_clock(ca: &TestCa, policy: TlsRenewalPolicy) -> TlsServerHandle {
    start_tls_server_with_clock(test_server_config(ca), ca.clock_handle(), policy)
        .await
        .unwrap()
}

/// Upper bound for positive waits on a monitor transition or listener shutdown.
///
/// `CaManager` serializes every mutating operation behind a process-wide lock
/// (`CA_OPERATION_LOCK`), so a long-running CA test in the parallel full suite
/// can delay renewal well past the usual sub-second path. A short deadline
/// reports lock contention as a renewal bug; this bound only slows down tests
/// that are already failing.
const ASYNC_CA_WAIT: Duration = Duration::from_secs(30);

#[tokio::test]
async fn handle_snapshot_matches_the_served_leaf() {
    let ca = TestCa::new("tls-snapshot");
    ca.initialize();
    let handle = start_tls_server(test_server_config(&ca)).await.unwrap();
    let snapshot = handle.certificate_snapshot();
    assert_eq!(snapshot.state, TlsCertificateState::Serving);
    assert_eq!(snapshot.leaf_not_after, handle.leaf_not_after());
    assert_eq!(
        snapshot.leaf_fingerprint_sha256,
        handle.leaf_fingerprint_sha256()
    );
    assert_eq!(
        snapshot.root_fingerprint_sha256,
        ca.manager().status().unwrap().root_fingerprint_sha256
    );

    let mut stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    let peer = stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("server must send a peer chain")
        .to_vec();
    assert_eq!(peer.len(), 2);
    assert_eq!(
        crate::ca::fingerprint_sha256(peer[0].as_ref()),
        snapshot.leaf_fingerprint_sha256
    );
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_renewal_swaps_new_connections_only() {
    let ca = TestCa::renewal("tls-renew");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();
    let addr = handle.local_addr();

    let mut old_stream = connect_tls(
        addr,
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();

    ca.advance(TimeDuration::days(23));
    let snapshot = handle.renew_now().await.unwrap();
    assert_eq!(snapshot.state, TlsCertificateState::Serving);
    assert_ne!(snapshot.leaf_fingerprint_sha256, old_fingerprint);

    let mut new_stream = connect_tls(
        addr,
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let peer = new_stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("server must send a peer chain")
        .to_vec();
    assert_eq!(
        crate::ca::fingerprint_sha256(peer[0].as_ref()),
        snapshot.leaf_fingerprint_sha256
    );

    // The already-established TLS session survives the swap.
    let response = http_request(&mut old_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    let response = http_request(&mut new_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn renewal_failure_keeps_valid_old_certificate() {
    let ca = TestCa::renewal("tls-renew-fail");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();
    let root_der = ca.root_cert_der();

    let state_path = ca.root.join("state.json");
    std::fs::write(&state_path, b"{").unwrap();
    ca.advance(TimeDuration::days(1));

    let err = handle.renew_now().await.unwrap_err();
    assert_eq!(err.code(), "ca-state-corrupt");
    let snapshot = handle.certificate_snapshot();
    assert_eq!(
        snapshot.state,
        TlsCertificateState::RenewalFailed {
            code: "ca-state-corrupt"
        }
    );
    assert_eq!(snapshot.leaf_fingerprint_sha256, old_fingerprint);

    let mut stream = connect_tls(
        handle.local_addr(),
        client_config(root_der),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn renew_after_expiry_stop_is_rejected() {
    let ca = TestCa::renewal("tls-expired-api");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();
    let state_path = ca.root.join("state.json");
    let original_state = std::fs::read(&state_path).unwrap();
    std::fs::write(&state_path, b"{").unwrap();
    ca.advance(TimeDuration::days(31));
    assert_eq!(
        handle.renew_now().await.unwrap_err().code(),
        "ca-state-corrupt"
    );
    assert_eq!(
        handle.certificate_snapshot().state,
        TlsCertificateState::Expired
    );

    std::fs::write(&state_path, original_state).unwrap();
    let err = handle.renew_now().await.unwrap_err();
    assert_eq!(err.code(), "web-access-certificate-expired");
    let snapshot = handle.certificate_snapshot();
    assert_eq!(snapshot.state, TlsCertificateState::Expired);
    assert_eq!(snapshot.leaf_fingerprint_sha256, old_fingerprint);
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_renewal_retries_after_ca_recovers() {
    let ca = TestCa::renewal("tls-renew-retry");
    ca.initialize();
    let policy = TlsRenewalPolicy {
        tick: Duration::from_millis(10),
        retry_after_failure: Duration::from_millis(10),
        ..TlsRenewalPolicy::default()
    };
    let handle = start_with_test_clock(&ca, policy).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();
    let state_path = ca.root.join("state.json");
    let original_state = std::fs::read(&state_path).unwrap();
    ca.advance(TimeDuration::days(1));
    std::fs::write(&state_path, b"{").unwrap();
    assert_eq!(
        handle.renew_now().await.unwrap_err().code(),
        "ca-state-corrupt"
    );

    std::fs::write(&state_path, original_state).unwrap();
    let renewed = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            let fingerprint = handle.leaf_fingerprint_sha256();
            if fingerprint != old_fingerprint {
                break fingerprint;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("monitor did not retry after the CA recovered");
    assert_ne!(renewed, old_fingerprint);
    assert_eq!(
        handle.certificate_snapshot().state,
        TlsCertificateState::Serving
    );
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_renewal_at_expiry_stops_listener() {
    let ca = TestCa::renewal("tls-renew-expired");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let addr = handle.local_addr();

    let state_path = ca.root.join("state.json");
    std::fs::write(&state_path, b"{").unwrap();
    ca.advance(TimeDuration::days(31));

    let err = handle.renew_now().await.unwrap_err();
    assert_eq!(err.code(), "ca-state-corrupt");
    let snapshot = handle.certificate_snapshot();
    assert_eq!(snapshot.state, TlsCertificateState::Expired);
    assert_eq!(
        snapshot.last_error_code,
        Some("web-access-certificate-expired")
    );

    let stopped = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            if TcpListener::bind(addr).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(stopped.is_ok(), "listener port still bound after expiry");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn monitor_renews_before_expiry() {
    let ca = TestCa::renewal("tls-monitor");
    ca.initialize();
    let policy = TlsRenewalPolicy {
        tick: Duration::from_millis(10),
        ..TlsRenewalPolicy::default()
    };
    let handle = start_with_test_clock(&ca, policy).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();

    ca.advance(TimeDuration::days(23) + TimeDuration::seconds(1));
    let changed = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            let fingerprint = handle.leaf_fingerprint_sha256();
            if fingerprint != old_fingerprint {
                break fingerprint;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("monitor did not renew inside the test window");
    assert_ne!(changed, old_fingerprint);
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn intermediate_rotation_reloads_under_same_root() {
    let ca = TestCa::with_clock_at(
        "tls-intermediate-rotate",
        OffsetDateTime::now_utc() - TimeDuration::days(170),
    );
    ca.initialize();
    ca.advance(TimeDuration::days(150));
    let policy = TlsRenewalPolicy {
        tick: Duration::from_millis(10),
        ..TlsRenewalPolicy::default()
    };
    let handle = start_with_test_clock(&ca, policy).await;
    let old_root_fingerprint = handle.root_fingerprint_sha256();
    let old_intermediate_generation = handle.certificate_snapshot().intermediate_generation;
    let old_leaf_fingerprint = handle.leaf_fingerprint_sha256();
    let mut old_stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();

    ca.advance(TimeDuration::days(20));
    let rotation = ca.manager().rotate_intermediate().unwrap();
    assert_eq!(rotation.old_generation, old_intermediate_generation);
    let snapshot = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            let snapshot = handle.certificate_snapshot();
            if snapshot.intermediate_generation == rotation.new_generation
                && snapshot.leaf_fingerprint_sha256 != old_leaf_fingerprint
            {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("monitor did not reload after intermediate rotation");
    assert_eq!(snapshot.root_fingerprint_sha256, old_root_fingerprint);
    assert_eq!(snapshot.intermediate_generation, rotation.new_generation);

    let response = http_request(&mut old_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    let mut new_stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let peer = new_stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("server must send a peer chain")
        .to_vec();
    assert_eq!(peer.len(), 2, "server must send leaf + intermediate only");
    let response = http_request(&mut new_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn root_rotation_requires_explicit_reload_and_retrust() {
    let ca = TestCa::new("tls-root-rotate");
    ca.initialize();
    let policy = TlsRenewalPolicy {
        tick: Duration::from_millis(10),
        ..TlsRenewalPolicy::default()
    };
    let handle = start_with_test_clock(&ca, policy).await;
    let old_root_der = ca.root_cert_der();
    let old_root_fingerprint = handle.root_fingerprint_sha256();
    let mut old_stream = connect_tls(
        handle.local_addr(),
        client_config(old_root_der.clone()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();

    let plan = ca.manager().prepare_root_rotation().unwrap();
    ca.manager().activate_root_rotation(&plan).unwrap();
    let new_root_der = ca.root_cert_der();
    let new_root_fingerprint = ca.manager().status().unwrap().root_fingerprint_sha256;
    assert_ne!(old_root_fingerprint, new_root_fingerprint);

    let snapshot = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            let snapshot = handle.certificate_snapshot();
            if matches!(
                snapshot.state,
                TlsCertificateState::RootChangePending { .. }
            ) {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("monitor did not detect the root change");
    assert_eq!(snapshot.root_fingerprint_sha256, old_root_fingerprint);
    let err = handle.renew_now().await.unwrap_err();
    assert_eq!(err.code(), "web-access-root-change-pending");

    // The old leaf remains serviceable while the root change is pending.
    let response = http_request(&mut old_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");

    let err = handle.reload_after_root_rotation("00").await.unwrap_err();
    assert_eq!(err.code(), "web-access-root-change-mismatch");
    let snapshot = handle
        .reload_after_root_rotation(&new_root_fingerprint)
        .await
        .unwrap();
    assert_eq!(snapshot.state, TlsCertificateState::Serving);
    assert_eq!(snapshot.root_fingerprint_sha256, new_root_fingerprint);

    // Old-root clients are no longer trusted; new-root clients are.
    let err = connect_tls(
        handle.local_addr(),
        client_config(old_root_der),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{err:?}").contains("UnknownIssuer")
            || format!("{err:?}").contains("InvalidCertificate"),
        "old root unexpectedly accepted: {err:?}"
    );
    let mut new_stream = connect_tls(
        handle.local_addr(),
        client_config(new_root_der),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut new_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn issuer_validity_gate_keeps_old_until_expiry_then_stops() {
    let ca = TestCa::with_clock_at(
        "tls-issuer-window",
        OffsetDateTime::now_utc() - TimeDuration::days(170),
    );
    ca.initialize();
    ca.advance(TimeDuration::days(150));
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let old_leaf_fingerprint = handle.leaf_fingerprint_sha256();
    let mut old_stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();

    ca.advance(TimeDuration::days(1));
    let err = handle.renew_now().await.unwrap_err();
    assert_eq!(err.code(), "ca-insufficient-validity");
    let snapshot = handle.certificate_snapshot();
    assert_eq!(
        snapshot.state,
        TlsCertificateState::IssuerRotationRequired {
            code: "ca-insufficient-validity"
        }
    );
    assert_eq!(snapshot.leaf_fingerprint_sha256, old_leaf_fingerprint);
    let response = http_request(&mut old_stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");

    ca.advance(TimeDuration::days(30));
    let err = handle.renew_now().await.unwrap_err();
    assert_eq!(err.code(), "ca-insufficient-validity");
    assert_eq!(
        handle.certificate_snapshot().state,
        TlsCertificateState::Expired
    );
    let addr = handle.local_addr();
    let stopped = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            if TcpListener::bind(addr).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(stopped.is_ok(), "listener port still bound after expiry");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn rollback_restores_previous_certificate_once() {
    let ca = TestCa::renewal("tls-rollback");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();

    ca.advance(TimeDuration::days(23));
    let renewed = handle.renew_now().await.unwrap();
    assert_ne!(renewed.leaf_fingerprint_sha256, old_fingerprint);
    assert_eq!(
        renewed.previous_leaf_fingerprint_sha256,
        Some(old_fingerprint.clone())
    );

    let rolled_back = handle.rollback_last_reload().await.unwrap();
    assert_eq!(rolled_back.state, TlsCertificateState::Serving);
    assert_eq!(rolled_back.leaf_fingerprint_sha256, old_fingerprint);
    assert_eq!(rolled_back.previous_leaf_fingerprint_sha256, None);
    let mut stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let peer = stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("server must send a peer chain")
        .to_vec();
    assert_eq!(
        crate::ca::fingerprint_sha256(peer[0].as_ref()),
        old_fingerprint
    );
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");

    let err = handle.rollback_last_reload().await.unwrap_err();
    assert_eq!(err.code(), "web-access-rollback-unavailable");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn accept_loop_rejects_expired_leaf_and_wakes_monitor() {
    let ca = TestCa::with_clock_at(
        "tls-expiry-guard",
        OffsetDateTime::now_utc() - TimeDuration::days(29),
    );
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let old_fingerprint = handle.leaf_fingerprint_sha256();
    let addr = handle.local_addr();
    let config = client_config(ca.root_cert_der());

    ca.advance(TimeDuration::days(30));
    let expired = tokio::time::timeout(
        Duration::from_secs(2),
        connect_tls(
            addr,
            config.clone(),
            ServerName::try_from("moyu.local").unwrap(),
        ),
    )
    .await;
    assert!(
        matches!(expired, Ok(Err(_)) | Err(_)),
        "expired leaf was served or the connection hung"
    );

    let renewed = tokio::time::timeout(ASYNC_CA_WAIT, async {
        loop {
            let fingerprint = handle.leaf_fingerprint_sha256();
            if fingerprint != old_fingerprint {
                break fingerprint;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("accept-time wake did not renew the expired leaf");
    assert_ne!(renewed, old_fingerprint);

    let mut stream = connect_tls(addr, config, ServerName::try_from("moyu.local").unwrap())
        .await
        .unwrap();
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn concurrent_handshakes_survive_certificate_swap() {
    let ca = TestCa::renewal("tls-concurrent");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let addr = handle.local_addr();
    let config = client_config(ca.root_cert_der());
    let barrier = Arc::new(tokio::sync::Barrier::new(9));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let barrier = barrier.clone();
        let config = config.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            let mut stream =
                connect_tls(addr, config, ServerName::try_from("moyu.local").unwrap()).await?;
            let response = http_request(&mut stream, "GET", "/api/health").await;
            Ok::<bool, std::io::Error>(response.starts_with("HTTP/1.1 204"))
        });
    }

    barrier.wait().await;
    ca.advance(TimeDuration::days(23));
    handle.renew_now().await.unwrap();
    while let Some(result) = tasks.join_next().await {
        assert!(result.unwrap().unwrap(), "a concurrent handshake failed");
    }
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn rollback_is_unavailable_after_previous_leaf_expiry() {
    let ca = TestCa::renewal("tls-rollback-expired");
    ca.initialize();
    let handle = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    ca.advance(TimeDuration::days(23));
    handle.renew_now().await.unwrap();
    ca.advance(TimeDuration::days(8));
    assert_eq!(
        handle
            .certificate_snapshot()
            .previous_leaf_fingerprint_sha256,
        None
    );
    let err = handle.rollback_last_reload().await.unwrap_err();
    assert_eq!(err.code(), "web-access-rollback-unavailable");
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_reissues_and_does_not_persist_leaf_files() {
    let ca = TestCa::renewal("tls-restart");
    ca.initialize();
    let first = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    let first_leaf = first.leaf_fingerprint_sha256();
    let root_fingerprint = first.root_fingerprint_sha256();
    first.shutdown().await.unwrap();

    let second = start_with_test_clock(&ca, TlsRenewalPolicy::default()).await;
    assert_ne!(second.leaf_fingerprint_sha256(), first_leaf);
    assert_eq!(second.root_fingerprint_sha256(), root_fingerprint);
    let mut stream = connect_tls(
        second.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
    second.shutdown().await.unwrap();

    assert!(!ca.root.join("leaves").exists());
    assert!(!ca.root.join("leaf.key").exists());
}

#[tokio::test]
async fn tls_server_serves_only_health_and_verifies_chain_and_san() {
    let ca = TestCa::new("tls-health");
    ca.initialize();
    let handle = start_tls_server(test_server_config(&ca)).await.unwrap();
    let addr = handle.local_addr();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert_eq!(handle.san_ips(), &[Ipv4Addr::new(192, 168, 1, 10)]);
    assert!(
        handle.leaf_not_after() > now,
        "served leaf is already expired"
    );
    assert!(!handle.leaf_fingerprint_sha256().is_empty());
    assert_eq!(
        handle.root_fingerprint_sha256(),
        ca.manager().status().unwrap().root_fingerprint_sha256
    );

    let root_der = ca.root_cert_der();
    let config = client_config(root_der.clone());

    // IP SAN: the client verifies the leaf against the CA root and the
    // configured private IPv4, while the TCP connection stays on loopback.
    let mut stream = connect_tls(
        addr,
        config.clone(),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    // The served chain must be exactly leaf + intermediate; the root is a
    // local trust anchor and must not be sent.
    let peer = stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("server must send a peer chain")
        .to_vec();
    assert_eq!(peer.len(), 2, "server must send leaf + intermediate only");
    assert!(
        peer.iter().all(|cert| cert.as_ref() != root_der.as_slice()),
        "server sent the root certificate"
    );
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(
        response.starts_with("HTTP/1.1 204"),
        "unexpected health response: {response:?}"
    );

    // DNS SAN.
    let mut stream = connect_tls(
        addr,
        config.clone(),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(
        response.starts_with("HTTP/1.1 204"),
        "unexpected DNS-SAN response: {response:?}"
    );

    // Only the health route exists, and only for GET.
    let mut stream = connect_tls(
        addr,
        config.clone(),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/unknown").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "unexpected unknown-route response: {response:?}"
    );

    // Pairing routes are mounted only by the cfg(test) router; the production
    // TLS server must never expose them. The POST consume route is included
    // even though D1a's test-only router can now consume claims.
    for (method, path) in [
        ("GET", "/api/pair/claim/claim_test"),
        ("POST", "/api/pair/claim"),
        ("POST", "/api/pair/claim/claim_test/consume"),
    ] {
        let mut stream = connect_tls(
            addr,
            config.clone(),
            ServerName::try_from("moyu.local").unwrap(),
        )
        .await
        .unwrap();
        let response = http_request(&mut stream, method, path).await;
        assert!(
            response.starts_with("HTTP/1.1 404"),
            "production exposed a pairing route: {method} {path}: {response:?}"
        );
    }

    for method in ["POST", "HEAD"] {
        let mut stream = connect_tls(
            addr,
            config.clone(),
            ServerName::try_from("moyu.local").unwrap(),
        )
        .await
        .unwrap();
        let response = http_request(&mut stream, method, "/api/health").await;
        assert!(
            response.starts_with("HTTP/1.1 404"),
            "{method} /api/health must be 404, got: {response:?}"
        );
    }

    // A name or IP outside the leaf SAN must fail the TLS handshake.
    let err = connect_tls(
        addr,
        config.clone(),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11)).into()),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{err:?}").contains("NotValidForName"),
        "unexpected wrong-IP error: {err:?}"
    );
    let err = connect_tls(addr, config, ServerName::try_from("evil.local").unwrap())
        .await
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("NotValidForName"),
        "unexpected wrong-name error: {err:?}"
    );

    // The listener is TLS-only: a plaintext HTTP request must not produce an
    // HTTP response and must not leave the connection hanging.
    let mut plain = TcpStream::connect(addr).await.unwrap();
    plain
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: moyu.local\r\n\r\n")
        .await
        .unwrap();
    let mut buf = [0u8; 64];
    match tokio::time::timeout(Duration::from_secs(2), plain.read(&mut buf)).await {
        Ok(Ok(n)) => assert!(
            !buf[..n].starts_with(b"HTTP/"),
            "plaintext request was served: {:?}",
            &buf[..n]
        ),
        Ok(Err(_)) => {}
        Err(_) => panic!("TLS listener left a plaintext connection open"),
    }

    handle.shutdown().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(addr))
            .await
            .map(|result| result.is_err())
            .unwrap_or(true),
        "listener still accepts connections after shutdown"
    );
}

#[tokio::test]
async fn start_rejects_uninitialized_ca_and_no_san() {
    let ca = TestCa::new("tls-no-ca");
    let err = start_tls_server(test_server_config(&ca))
        .await
        .err()
        .expect("uninitialized CA must fail");
    assert_eq!(err.code(), "ca-not-initialized");

    ca.initialize();
    let err = start_tls_server(TlsServerConfig {
        san_ips: Some(Vec::new()),
        ..TlsServerConfig::new(ca.root.clone())
    })
    .await
    .err()
    .expect("empty SAN list must fail");
    assert_eq!(err.code(), "web-access-no-lan-address");
}

#[tokio::test]
async fn start_rejects_relative_ca_root_and_ipv6_bind() {
    let err = start_tls_server(TlsServerConfig {
        ca_root: PathBuf::from("relative-ca"),
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        san_ips: Some(vec![Ipv4Addr::new(192, 168, 1, 10)]),
    })
    .await
    .err()
    .expect("relative CA root must fail");
    assert_eq!(err.code(), "ca-root-relative");

    let ca = TestCa::new("tls-v6");
    ca.initialize();
    let err = start_tls_server(TlsServerConfig {
        bind_addr: "[::1]:0".parse().unwrap(),
        ..test_server_config(&ca)
    })
    .await
    .err()
    .expect("IPv6 bind must fail");
    assert_eq!(err.code(), "web-access-invalid-bind");
}

#[tokio::test]
async fn start_rejects_a_damaged_ca_before_spawning() {
    let ca = TestCa::new("tls-damaged");
    ca.initialize();
    let state = ca.root.join("state.json");
    let original = std::fs::read(&state).unwrap();
    std::fs::write(&state, b"{").unwrap();
    let err = start_tls_server(test_server_config(&ca))
        .await
        .err()
        .expect("damaged CA must fail");
    assert_eq!(err.code(), "ca-state-corrupt");
    // Restore the state so TestCa::drop can destroy the CA and remove the
    // private tree.
    std::fs::write(&state, original).unwrap();
}

#[tokio::test]
async fn bind_failure_returns_io_error() {
    let ca = TestCa::new("tls-bind-fail");
    ca.initialize();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = occupied.local_addr().unwrap();
    let err = start_tls_server(TlsServerConfig {
        bind_addr: addr,
        ..test_server_config(&ca)
    })
    .await
    .err()
    .expect("occupied port must fail");
    assert_eq!(err.code(), "web-access-io");
    drop(occupied);
}

async fn pair_http_request<S>(
    stream: &mut S,
    method: &str,
    path: &str,
    host: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
    body: Option<&str>,
) -> String
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(origin) = origin {
        request.push_str(&format!("Origin: {origin}\r\n"));
        request.push_str("X-Moyu-Request: 1\r\n");
    }
    if let Some(cookie) = cookie {
        request.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    if let Some(body) = body {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}

fn response_set_cookie(response: &str, name: &str) -> Option<String> {
    let prefix = format!("set-cookie: {name}=");
    response.lines().find_map(|line| {
        let line = line.trim();
        if line.to_ascii_lowercase().starts_with(&prefix) {
            let value = line.split_once('=')?.1;
            Some(value.split(';').next()?.trim().to_owned())
        } else {
            None
        }
    })
}

/// Reads a raw response header value case-insensitively. Header names are
/// ASCII case-insensitive over the wire, so the transport spelling of
/// `x-request-id` must not decide whether the test passes.
fn response_header<'a>(response: &'a str, name: &str) -> Option<&'a str> {
    response.lines().find_map(|line| {
        let line = line.trim_end_matches('\r');
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

/// Asserts the response carries a 16-character lowercase hex `x-request-id`
/// and returns it.
fn assert_request_id(response: &str) -> String {
    let id = response_header(response, "x-request-id")
        .unwrap_or_else(|| panic!("missing x-request-id: {response:?}"))
        .to_owned();
    assert_eq!(id.len(), 16, "request id is not 16 chars: {id:?}");
    assert!(
        id.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "request id is not lowercase hex: {id:?}"
    );
    id
}

/// G4: the production handler factory receives the actual bound address, the
/// real TLS listener serves health + the three pair routes, and every data
/// path is 404. The claim is approved through the same in-memory service the
/// Tauri control plane will use.
#[tokio::test]
async fn production_pair_router_serves_only_health_and_pair_over_real_tls() {
    let ca = TestCa::new("pair-router");
    ca.initialize();

    let pairing_clock = Arc::new(SystemClock);
    let service = Arc::new(PairingService::new(
        PairingStore::new(pairing_clock.clone()),
        SessionStore::new(pairing_clock),
    ));
    let window = service.start_window();

    let factory_service = Arc::clone(&service);
    let factory: HandlerFactory = Arc::new(move |addr| {
        let mut router = PairingHttp::new(Arc::clone(&factory_service), addr)?;
        router.set_polling(Duration::from_millis(20), Duration::from_millis(5));
        let router = Arc::new(router);
        let handler: RequestHandler = Arc::new(move |request, peer| {
            let router = Arc::clone(&router);
            let source_ip = match peer.ip() {
                IpAddr::V4(ip) => ip,
                IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
            };
            Box::pin(async move {
                Ok::<_, std::convert::Infallible>(router.handle(request, source_ip).await)
            })
        });
        Ok(handler)
    });

    let handle = start_tls_server_with_clock_and_handler(
        test_server_config(&ca),
        ca.clock_handle(),
        TlsRenewalPolicy::default(),
        factory,
    )
    .await
    .unwrap();
    let host = handle.local_addr().to_string();
    let origin = format!("https://{host}");
    let cookie = |secret: &str| format!("moyu_claim={secret}");

    let health = pair_request(&ca, &handle, "GET", "/api/health", &host, None, None, None).await;
    assert!(health.starts_with("HTTP/1.1 204"), "{health:?}");

    let data = pair_request(&ca, &handle, "GET", "/api/books", &host, None, None, None).await;
    assert!(data.starts_with("HTTP/1.1 404"), "{data:?}");

    let claim_body = format!(
        "{{\"pairingId\":\"{}\",\"deviceName\":\"Pixel 8\",\"claimNonce\":\"AAAAAAAAAAAAAAAAAAAAAA\"}}",
        window.id
    );
    let claim = pair_request(
        &ca,
        &handle,
        "POST",
        "/api/pair/claim",
        &host,
        Some(&origin),
        None,
        Some(&claim_body),
    )
    .await;
    assert!(claim.starts_with("HTTP/1.1 202"), "{claim:?}");
    let claim_secret = response_set_cookie(&claim, "moyu_claim").expect("claim cookie");
    let claim_json = claim.split("\r\n\r\n").nth(1).unwrap_or_default();
    let claim_id = serde_json::from_str::<serde_json::Value>(claim_json)
        .unwrap()
        .get("claimId")
        .and_then(|value| value.as_str())
        .expect("claimId")
        .to_owned();
    assert_eq!(claim_secret.len(), 43);

    let pending = pair_request(
        &ca,
        &handle,
        "GET",
        &format!("/api/pair/claim/{claim_id}"),
        &host,
        None,
        Some(&cookie(&claim_secret)),
        None,
    )
    .await;
    assert!(pending.starts_with("HTTP/1.1 200"), "{pending:?}");
    assert!(pending.contains("\"pending\""), "{pending:?}");

    service.approve(&claim_id).expect("approve");
    let approved = pair_request(
        &ca,
        &handle,
        "GET",
        &format!("/api/pair/claim/{claim_id}"),
        &host,
        None,
        Some(&cookie(&claim_secret)),
        None,
    )
    .await;
    assert!(approved.starts_with("HTTP/1.1 200"), "{approved:?}");
    assert!(approved.contains("\"approved\""), "{approved:?}");

    let consumed = pair_request(
        &ca,
        &handle,
        "POST",
        &format!("/api/pair/claim/{claim_id}/consume"),
        &host,
        Some(&origin),
        Some(&cookie(&claim_secret)),
        None,
    )
    .await;
    assert!(consumed.starts_with("HTTP/1.1 200"), "{consumed:?}");
    assert!(
        response_set_cookie(&consumed, "moyus_session").is_some(),
        "{consumed:?}"
    );
    assert!(!consumed.contains(&claim_secret), "token/secret echo");

    let second = pair_request(
        &ca,
        &handle,
        "POST",
        &format!("/api/pair/claim/{claim_id}/consume"),
        &host,
        Some(&origin),
        Some(&cookie(&claim_secret)),
        None,
    )
    .await;
    assert!(second.starts_with("HTTP/1.1 409"), "{second:?}");
    assert!(second.contains("pairing-consumed"), "{second:?}");

    // G5: a half-open/slow TCP connection must not block a normal client.
    let _slow = TcpStream::connect(handle.local_addr()).await.unwrap();
    let health = pair_request(&ca, &handle, "GET", "/api/health", &host, None, None, None).await;
    assert!(health.starts_with("HTTP/1.1 204"), "{health:?}");

    // G5: header totals above 8 KiB are rejected by the shared request guard
    // with 431 before routing, and the listener keeps serving afterwards.
    let mut oversized = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}\r\nX-Big: {}\r\nConnection: close\r\n\r\n",
        "a".repeat(9 * 1024)
    );
    oversized.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let _ = oversized.read_to_end(&mut response).await;
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 431"), "{text:?}");
    assert!(text.contains("header-too-large"), "{text:?}");
    assert_request_id(&text);
    let health = pair_request(&ca, &handle, "GET", "/api/health", &host, None, None, None).await;
    assert!(health.starts_with("HTTP/1.1 204"), "{health:?}");

    handle.shutdown().await.unwrap();
}

/// A client that sends only part of its request headers must be cut off by the
/// short header-read timeout, long before the 65 s connection timeout.
#[tokio::test]
async fn slow_header_connection_is_closed_within_the_header_timeout() {
    let ca = TestCa::new("header-timeout");
    ca.initialize();
    let handle = start_tls_server_with_clock_and_header_timeout(
        test_server_config(&ca),
        ca.clock_handle(),
        TlsRenewalPolicy::default(),
        Duration::from_millis(300),
    )
    .await
    .unwrap();
    let host = handle.local_addr().to_string();

    let mut stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    // No terminating blank line: the server must not wait for the 65 s
    // connection timeout to give up on the incomplete header block.
    stream
        .write_all(format!("GET /api/health HTTP/1.1\r\nHost: {host}\r\nX-Slow: ").as_bytes())
        .await
        .unwrap();

    let started = Instant::now();
    let mut response = Vec::new();
    let outcome =
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response)).await;
    let elapsed = started.elapsed();
    match outcome {
        // A clean EOF (Ok) or a reset (Err) both prove the server closed.
        Ok(read_result) => {
            let _ = read_result;
        }
        Err(_) => panic!("header timeout did not close the connection"),
    }
    assert!(
        elapsed < Duration::from_secs(2),
        "connection stayed open past the header timeout: {elapsed:?}"
    );
    handle.shutdown().await.unwrap();
}

/// The health-only production listener rejects an oversized header total with
/// 431 + request id and keeps serving normal health requests afterwards.
#[tokio::test]
async fn health_only_oversized_headers_are_431_with_request_id() {
    let ca = TestCa::new("health-oversized");
    ca.initialize();
    let handle = start_tls_server(test_server_config(&ca)).await.unwrap();
    let host = handle.local_addr().to_string();

    let mut oversized = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}\r\nX-Big: {}\r\nConnection: close\r\n\r\n",
        "a".repeat(9 * 1024)
    );
    oversized.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let _ = oversized.read_to_end(&mut response).await;
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 431"), "{text:?}");
    assert_request_id(&text);

    // The rejected request must not take the listener down.
    let mut stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    let health = http_request(&mut stream, "GET", "/api/health").await;
    assert!(health.starts_with("HTTP/1.1 204"), "{health:?}");
    handle.shutdown().await.unwrap();
}

#[allow(clippy::too_many_arguments)] // Test helper mirrors the HTTP request.
async fn pair_request(
    ca: &TestCa,
    handle: &TlsServerHandle,
    method: &str,
    path: &str,
    host: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
    body: Option<&str>,
) -> String {
    let server_name = ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into());
    let mut stream = connect_tls(
        handle.local_addr(),
        client_config(ca.root_cert_der()),
        server_name,
    )
    .await
    .unwrap();
    pair_http_request(&mut stream, method, path, host, origin, cookie, body).await
}

/// Minimal read-only provider for the data-plane end-to-end test. It returns a
/// single book and `NotFound` for every per-book route so the test only needs
/// the list response.
struct TestData;

impl WebDataAccess for TestData {
    fn list_books(
        &self,
        _q: Option<&str>,
        _cursor: Option<&str>,
        _limit: u32,
    ) -> Result<WebBookPage, DataError> {
        let id = "b".repeat(64);
        Ok(WebBookPage {
            items: vec![WebBook {
                id: id.clone(),
                title: "Web Book".into(),
                page_count: 3,
                current_page: 1,
                progress_rev: 2,
                scroll_pct: -1.0,
                format: "image".into(),
                source_type: "local".into(),
                missing: false,
                updated_at: "2026-11-03T10:00:00+08:00".into(),
                thumb_url: Some(format!("/api/books/{id}/thumb?v=2")),
            }],
            next_cursor: None,
        })
    }

    fn book(&self, _id: &str) -> Result<WebBookDetail, DataError> {
        Err(DataError::NotFound)
    }

    fn thumb(&self, _id: &str) -> Result<ImageAsset, DataError> {
        Err(DataError::NotFound)
    }

    fn pages(&self, _id: &str) -> Result<PageManifest, DataError> {
        Err(DataError::NotFound)
    }

    fn page(&self, _id: &str, _index: u32, _width: u32) -> Result<ImageAsset, DataError> {
        Err(DataError::NotFound)
    }

    fn layout(&self, _id: &str) -> Result<Vec<PageDim>, DataError> {
        Err(DataError::NotFound)
    }

    fn tile(
        &self,
        _id: &str,
        _index: u32,
        _tile: u32,
        _width: u32,
    ) -> Result<TileImage, DataError> {
        Err(DataError::NotFound)
    }

    fn progress(&self, _id: &str) -> Result<ProgressView, DataError> {
        Err(DataError::NotFound)
    }
}

/// One-shot `GET /api/books` over a fresh TLS connection, optionally carrying
/// the `moyus_session` cookie. The connection still targets loopback; only the
/// TLS SNI uses the configured LAN SAN.
async fn data_request(
    ca: &TestCa,
    addr: std::net::SocketAddr,
    host: &str,
    cookie: Option<&str>,
) -> String {
    let mut stream = connect_tls(
        addr,
        client_config(ca.root_cert_der()),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    let mut request = format!("GET /api/books HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(cookie) = cookie {
        request.push_str(&format!("Cookie: moyus_session={cookie}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}

/// Injecting a data provider into the production runtime must not start the
/// listener: the phase stays `disabled` and nothing is bound.
#[tokio::test]
async fn for_test_with_data_starts_disabled_without_binding() {
    let ca = TestCa::new("data-disabled");
    ca.initialize();

    let runtime = WebAccessRuntime::for_test_with_data(ca.root.clone(), Arc::new(TestData));
    let status = runtime.status().await;
    assert_eq!(status.phase, "disabled");
    assert!(status.bind_address.is_none());
    assert!(status.bind_ip.is_none());
    assert!(status.port.is_none());
    assert!(!status.pairing_active);

    let stopped = runtime.stop(StopReason::Stopped).await;
    assert_eq!(stopped.phase, "disabled");
}

/// Real-TLS proof for the read-only data plane: authenticated with a live
/// `moyus_session` cookie -> 200 with the book list and no path/CORS leakage;
/// missing or revoked cookie -> 401 `unauthorized`; explicit stop -> disabled.
#[tokio::test]
async fn production_router_serves_data_only_with_a_session_cookie() {
    let ca = TestCa::new("data-router");
    ca.initialize();

    let runtime = WebAccessRuntime::for_test_with_data(ca.root.clone(), Arc::new(TestData));

    // No auto-start: the runtime is `disabled` and owns no listener before the
    // explicit start, even with a data provider injected.
    let status = runtime.status().await;
    assert_eq!(status.phase, "disabled");
    assert!(status.bind_address.is_none());

    runtime
        .start_for_test(Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 1, 10), 0)
        .await
        .unwrap();

    let status = runtime.status().await;
    let host = status.bind_address.expect("bound");
    let addr: std::net::SocketAddr = host.parse().unwrap();
    let service = runtime.service_for_test().await.expect("service");
    let issued = service.issue_session_for_test("Pixel 8");

    // No cookie: the data gate fails closed before touching the provider.
    let denied = data_request(&ca, addr, &host, None).await;
    assert!(denied.starts_with("HTTP/1.1 401"), "{denied:?}");
    assert!(
        denied.to_ascii_lowercase().contains("\"unauthorized\""),
        "{denied:?}"
    );
    assert!(
        !denied.to_ascii_lowercase().contains("set-cookie"),
        "{denied:?}"
    );

    // A live session cookie returns only the JSON book list.
    let served = data_request(&ca, addr, &host, Some(issued.token.as_str())).await;
    assert!(served.starts_with("HTTP/1.1 200"), "{served:?}");
    assert!(served.contains("\"items\""), "{served:?}");
    assert!(served.contains("\"Web Book\""), "{served:?}");
    assert!(!served.contains("\"path\""), "{served:?}");
    assert!(!served.contains("C:/"), "{served:?}");
    assert!(!served.contains('\\'), "{served:?}");
    assert!(
        !served
            .to_ascii_lowercase()
            .contains("access-control-allow-origin"),
        "{served:?}"
    );

    // Revocation invalidates the same token immediately.
    assert!(service.revoke_device(&issued.id));
    let revoked = data_request(&ca, addr, &host, Some(issued.token.as_str())).await;
    assert!(revoked.starts_with("HTTP/1.1 401"), "{revoked:?}");
    assert!(
        revoked.to_ascii_lowercase().contains("\"unauthorized\""),
        "{revoked:?}"
    );

    runtime.stop(StopReason::Stopped).await;
    assert_eq!(runtime.status().await.phase, "disabled");
}
