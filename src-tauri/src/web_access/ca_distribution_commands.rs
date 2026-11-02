//! G1 CA distribution commands.
//!
//! These commands never start the listener at app startup. They expose the
//! public root certificate snapshot, an explicit CA initialization, a public
//! certificate export, and an explicitly started short-lived distribution
//! service. They do not implement pairing, sessions, data routes, G2, or D1b.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::ca_distribution::{CaDistributionError, CaDistributionRuntime, CaDistributionStatus};
use crate::ca::{CaError, CaManager, CaStatus};

/// CA state exposed to the settings UI. Fingerprints are already rendered as
/// uppercase, colon-separated SHA-256 by the CA layer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaStatusView {
    pub initialized: bool,
    pub root_generation: Option<u32>,
    pub root_fingerprint_sha256: Option<String>,
    pub root_not_after: Option<i64>,
    pub root_days_remaining: Option<i64>,
    pub intermediate_generation: Option<u32>,
    pub intermediate_fingerprint_sha256: Option<String>,
    pub intermediate_not_after: Option<i64>,
    pub intermediate_days_remaining: Option<i64>,
    pub needs_root_rotation: Option<bool>,
    pub needs_intermediate_rotation: Option<bool>,
}

impl CaStatusView {
    fn not_initialized() -> Self {
        Self {
            initialized: false,
            root_generation: None,
            root_fingerprint_sha256: None,
            root_not_after: None,
            root_days_remaining: None,
            intermediate_generation: None,
            intermediate_fingerprint_sha256: None,
            intermediate_not_after: None,
            intermediate_days_remaining: None,
            needs_root_rotation: None,
            needs_intermediate_rotation: None,
        }
    }

    fn from_status(status: CaStatus) -> Self {
        Self {
            initialized: true,
            root_generation: Some(status.root_generation),
            root_fingerprint_sha256: Some(status.root_fingerprint_sha256),
            root_not_after: Some(status.root_not_after),
            root_days_remaining: Some(status.root_days_remaining),
            intermediate_generation: Some(status.intermediate_generation),
            intermediate_fingerprint_sha256: Some(status.intermediate_fingerprint_sha256),
            intermediate_not_after: Some(status.intermediate_not_after),
            intermediate_days_remaining: Some(status.intermediate_days_remaining),
            needs_root_rotation: Some(status.needs_root_rotation),
            needs_intermediate_rotation: Some(status.needs_intermediate_rotation),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaExportView {
    pub fingerprint_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaDistributionStatusView {
    pub running: bool,
    pub url: Option<String>,
    pub expires_at_unix_ms: Option<i64>,
    pub stop_reason: Option<String>,
    pub root_fingerprint_sha256: Option<String>,
}

impl From<CaDistributionStatus> for CaDistributionStatusView {
    fn from(status: CaDistributionStatus) -> Self {
        Self {
            running: status.running,
            url: status.url,
            expires_at_unix_ms: status.expires_at_unix_ms,
            stop_reason: status.stop_reason.map(|reason| reason.as_str().to_owned()),
            root_fingerprint_sha256: status.root_fingerprint_sha256,
        }
    }
}

fn ca_manager(runtime: &CaDistributionRuntime) -> CaManager {
    CaManager::new(runtime.ca_root().to_path_buf())
}

/// Initialize only on an explicit command, then verify `status()` (which runs
/// the full ACL audit) instead of trusting the initialize return value. A
/// post-commit audit failure can return `Err` while the CA is healthy; status
/// is authoritative in that case.
fn initialize_and_verify(manager: &CaManager) -> Result<CaStatus, CaError> {
    let initialize_result = manager.initialize();
    let status_result = manager.status();
    // A post-commit audit failure can return Err while the CA is healthy.
    // Status is authoritative, but the audit/observability failure must still
    // be recorded; it is never a reason to block a healthy CA.
    if let (Err(initialize_error), Ok(_)) = (&initialize_result, &status_result) {
        if !matches!(initialize_error, CaError::AlreadyInitialized) {
            crate::logging::log_error(
                "ca",
                &format!("CA 初始化后置审计失败（{}）", initialize_error.code()),
            );
        }
    }
    match status_result {
        Ok(status) => Ok(status),
        Err(status_error) => match initialize_result {
            Err(initialize_error) if matches!(status_error, CaError::NotInitialized) => {
                Err(initialize_error)
            }
            _ => Err(status_error),
        },
    }
}

fn ca_error_message(error: &CaError) -> String {
    let text = match error.code() {
        "ca-not-initialized" => "本地 CA 尚未初始化",
        "ca-state-corrupt" => "本地 CA 状态损坏，请从备份恢复",
        "ca-partial-initialization" => "本地 CA 存在不完整的初始化残留",
        "ca-acl-verification" | "ca-acl" => "本地 CA 私钥目录权限异常",
        "ca-io" => "本地 CA 文件操作失败",
        _ => "本地 CA 操作失败",
    };
    format!("{text}（{}）", error.code())
}

fn distribution_error_message(error: &CaDistributionError) -> String {
    let text = match error.code() {
        "ca-distribution-running" => "CA 分发服务已在运行",
        "ca-distribution-no-lan" => "未找到可用的私有局域网 IPv4 地址",
        "ca-distribution-invalid-ip" => "只能选择当前设备的私有局域网 IPv4 地址",
        "ca-distribution-io" => "CA 分发服务启动或停止失败",
        _ => "CA 分发操作失败",
    };
    match error {
        CaDistributionError::Ca(ca_error) => ca_error_message(ca_error),
        _ => format!("{text}（{}）", error.code()),
    }
}

fn validate_export_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("导出路径必须是绝对路径（ca-export-path）".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) fn web_access_ca_status(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
) -> Result<CaStatusView, String> {
    let manager = ca_manager(runtime.inner().as_ref());
    match manager.status() {
        Ok(status) => Ok(CaStatusView::from_status(status)),
        Err(CaError::NotInitialized) => Ok(CaStatusView::not_initialized()),
        Err(error) => Err(ca_error_message(&error)),
    }
}

#[tauri::command]
pub(crate) fn web_access_ca_initialize(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
) -> Result<CaStatusView, String> {
    let manager = ca_manager(runtime.inner().as_ref());
    initialize_and_verify(&manager)
        .map(CaStatusView::from_status)
        .map_err(|error| ca_error_message(&error))
}

#[tauri::command]
pub(crate) fn web_access_ca_export_root(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
    path: String,
) -> Result<CaExportView, String> {
    let path = validate_export_path(&path)?;
    let manager = ca_manager(runtime.inner().as_ref());
    let certificate = manager
        .export_root_certificate(&path)
        .map_err(|error| ca_error_message(&error))?;
    Ok(CaExportView {
        fingerprint_sha256: certificate.fingerprint_sha256,
    })
}

#[tauri::command]
pub(crate) fn web_access_ca_distribution_addresses(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
) -> Result<Vec<String>, String> {
    Ok(runtime
        .inner()
        .addresses()
        .into_iter()
        .map(|ip| ip.to_string())
        .collect())
}

#[tauri::command]
pub(crate) async fn web_access_ca_distribution_start(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
    ip: Option<String>,
) -> Result<CaDistributionStatusView, String> {
    let runtime = runtime.inner().clone();
    let status = match ip {
        Some(raw) => {
            let ip = raw
                .trim()
                .parse::<Ipv4Addr>()
                .map_err(|_| "分发地址无效（ca-distribution-invalid-ip）".to_string())?;
            runtime.start(ip).await
        }
        None => runtime.start_default().await,
    }
    .map_err(|error| distribution_error_message(&error))?;
    Ok(CaDistributionStatusView::from(status))
}

#[tauri::command]
pub(crate) async fn web_access_ca_distribution_stop(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
) -> Result<CaDistributionStatusView, String> {
    let runtime = runtime.inner().clone();
    Ok(CaDistributionStatusView::from(runtime.stop().await))
}

#[tauri::command]
pub(crate) async fn web_access_ca_distribution_status(
    runtime: State<'_, Arc<CaDistributionRuntime>>,
) -> Result<CaDistributionStatusView, String> {
    let runtime = runtime.inner().clone();
    Ok(CaDistributionStatusView::from(runtime.status().await))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::ca::test_helpers::temp_path;
    use crate::web_access::ca_distribution::choose_bind_ip;

    #[test]
    fn not_initialized_view_is_typed_and_empty() {
        let view = CaStatusView::not_initialized();
        assert!(!view.initialized);
        assert!(view.root_fingerprint_sha256.is_none());
        assert!(view.root_generation.is_none());
    }

    #[test]
    fn status_view_preserves_formatted_fingerprint() {
        let root = temp_path("commands-status").join("ca");
        let manager = CaManager::new(root.clone());
        manager.initialize().unwrap();
        let status = manager.status().unwrap();
        let view = CaStatusView::from_status(status);
        assert!(view.initialized);
        let fingerprint = view.root_fingerprint_sha256.unwrap();
        assert_eq!(fingerprint.len(), 95);
        assert!(fingerprint
            .split(':')
            .all(|pair| pair.len() == 2 && pair.chars().all(|c| c.is_ascii_hexdigit())));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn initialize_and_verify_rechecks_status_and_rejects_corruption() {
        let root = temp_path("commands-init").join("ca");
        let manager = CaManager::new(root.clone());
        let first = initialize_and_verify(&manager).unwrap();
        assert_eq!(first.root_generation, 1);
        // A second call observes AlreadyInitialized but still returns the
        // verified healthy snapshot.
        let second = initialize_and_verify(&manager).unwrap();
        assert_eq!(
            first.root_fingerprint_sha256,
            second.root_fingerprint_sha256
        );

        std::fs::write(manager.paths_for_test().state_file(), b"{").unwrap();
        let error = initialize_and_verify(&manager).unwrap_err();
        assert_eq!(error.code(), "ca-state-corrupt");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn distribution_error_messages_carry_stable_codes() {
        let cases = [
            (
                CaDistributionError::AlreadyRunning,
                "ca-distribution-running",
            ),
            (CaDistributionError::NoLanAddress, "ca-distribution-no-lan"),
            (
                CaDistributionError::InvalidBindAddress,
                "ca-distribution-invalid-ip",
            ),
            (
                CaDistributionError::Io(std::io::Error::other("io")),
                "ca-distribution-io",
            ),
            (
                CaDistributionError::Ca(CaError::NotInitialized),
                "ca-not-initialized",
            ),
        ];
        for (error, code) in cases {
            let message = distribution_error_message(&error);
            assert!(message.contains(code), "{message} must contain {code}");
        }
    }

    #[test]
    fn export_path_must_be_absolute() {
        assert!(validate_export_path("relative.crt").is_err());
        assert!(validate_export_path("   ").is_err());
        let absolute = temp_path("commands-export").join("ca.crt");
        assert!(validate_export_path(absolute.to_str().unwrap()).is_ok());
    }

    #[test]
    fn choose_bind_ip_reports_no_lan_without_an_address() {
        let error = choose_bind_ip(Vec::new()).unwrap_err();
        assert_eq!(error.code(), "ca-distribution-no-lan");
        assert_eq!(
            choose_bind_ip(vec![Ipv4Addr::new(192, 168, 1, 10)]).unwrap(),
            Ipv4Addr::new(192, 168, 1, 10)
        );
    }

    #[tokio::test]
    async fn distribution_status_view_maps_stop_reason() {
        let root = temp_path("commands-runtime").join("ca");
        let manager = CaManager::new(root.clone());
        manager.initialize().unwrap();
        let runtime = CaDistributionRuntime::for_test(root.clone(), Duration::from_secs(5), 0);
        let started = runtime.start(Ipv4Addr::LOCALHOST).await.unwrap();
        let view = CaDistributionStatusView::from(started);
        assert!(view.running);
        assert!(view.root_fingerprint_sha256.is_some());
        assert!(view.stop_reason.is_none());
        let stopped = CaDistributionStatusView::from(runtime.stop().await);
        assert!(!stopped.running);
        assert_eq!(stopped.stop_reason.as_deref(), Some("stopped"));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
