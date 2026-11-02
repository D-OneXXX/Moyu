use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls_pki_types::ServerName;
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ca::CaManager;

use super::tls::start_tls_server_with_clock;
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
        let pem = std::fs::read_to_string(self.root.join("roots/0001/root.crt")).unwrap();
        pem::parse(pem).unwrap().contents().to_vec()
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
        client_config(ca.root_cert_der()),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response:?}");
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

    let stopped = tokio::time::timeout(Duration::from_secs(2), async {
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
    let changed = tokio::time::timeout(Duration::from_secs(2), async {
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
