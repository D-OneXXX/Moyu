//! D1b Tauri commands for the Web Access control plane.
//!
//! Every command is user-driven. No command starts the listener at app setup,
//! approves automatically, or reconnects after a stop. Errors carry a stable
//! code in the trailing `（web-access-...）` form; the frontend localizes it in
//! all six dictionaries and never displays ids, secrets, tokens, or paths.

use std::net::Ipv4Addr;
use std::sync::Arc;

use tauri::State;

use super::runtime::{
    DeviceView, LanAddressView, PairingStateView, PairingWindowView, RuntimeError, StopReason,
    WebAccessRuntime, WebAccessStatusView,
};

/// Human-readable, code-tagged error for the existing string-based command
/// boundary. No error ever includes a pairing id, claim id, secret, hash, or
/// token; CA errors keep their precise code.
pub(crate) fn error_message(error: &RuntimeError) -> String {
    let text = match error.code() {
        "web-access-already-enabled" => "Web Access 已在运行或正在启动",
        "web-access-not-enabled" => "Web Access 尚未启用",
        "web-access-invalid-state" => "当前 Web Access 状态不允许该操作",
        "web-access-safe-mode" => "安全模式下无法启动局域网阅读",
        "web-access-invalid-ip" => "只能选择当前设备的私有局域网 IPv4 地址",
        "web-access-no-lan-address" => "未找到可用的私有局域网 IPv4 地址",
        "web-access-invalid-bind" => "监听地址无效",
        "web-access-tls-config" => "TLS 证书配置失败",
        "web-access-io" => "监听启动失败（端口可能被占用）",
        "web-access-server-join" => "监听停止失败",
        "web-access-certificate-expired" => "证书已过期，Web Access 已停止",
        "web-access-root-change-pending" => "CA 根已轮换，需要重新配对并分发新根证书",
        "web-access-root-change-mismatch" => "CA 根指纹与预期不一致",
        "web-access-rollback-unavailable" => "证书回滚不可用",
        "web-access-device-not-found" => "设备不存在或已失效",
        "ca-not-initialized" => "本地 CA 尚未初始化，请先在隐私与安全中初始化",
        "ca-state-corrupt" => "本地 CA 状态损坏，请从备份恢复",
        "ca-partial-initialization" => "本地 CA 存在不完整的初始化残留",
        "ca-acl-verification" | "ca-acl" => "本地 CA 私钥目录权限异常",
        "ca-io" => "本地 CA 文件操作失败",
        "pairing-not-found" => "配对请求不存在或已过期",
        "pairing-claimed" => "该配对请求已被处理",
        "pairing-consumed" => "该配对请求已领取",
        "pairing-expired" => "配对已过期，请重新开始配对",
        "pairing-denied" => "配对已被拒绝",
        "pairing-cancelled" => "配对已取消",
        "device-limit" => "设备数量已达上限（8 台）",
        "pairing-rate-limited" => "请求过于频繁，请稍后再试",
        "invalid-parameter" => "请求参数无效",
        _ => "Web Access 操作失败",
    };
    format!("{text}（{}）", error.code())
}

fn map_error(error: RuntimeError) -> String {
    error_message(&error)
}

#[tauri::command]
pub(crate) async fn web_access_status(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<WebAccessStatusView, String> {
    Ok(runtime.status().await)
}

#[tauri::command]
pub(crate) fn web_access_addresses(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<Vec<LanAddressView>, String> {
    runtime.addresses().map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_start(
    runtime: State<'_, Arc<WebAccessRuntime>>,
    ip: String,
    port: Option<u16>,
) -> Result<WebAccessStatusView, String> {
    let ip = ip
        .trim()
        .parse::<Ipv4Addr>()
        .map_err(|_| error_message(&RuntimeError::InvalidIp))?;
    runtime
        .start(ip, port.unwrap_or(0))
        .await
        .map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_start_plain(
    runtime: State<'_, Arc<WebAccessRuntime>>,
    ip: String,
    port: Option<u16>,
) -> Result<WebAccessStatusView, String> {
    let ip = ip
        .trim()
        .parse::<Ipv4Addr>()
        .map_err(|_| error_message(&RuntimeError::InvalidIp))?;
    runtime
        .start_plain(ip, port.unwrap_or(0))
        .await
        .map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_stop(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<WebAccessStatusView, String> {
    Ok(runtime.stop(StopReason::Stopped).await)
}

#[tauri::command]
pub(crate) async fn web_access_pairing_start(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<PairingWindowView, String> {
    runtime.pairing_start().await.map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_pairing_state(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<PairingStateView, String> {
    Ok(runtime.pairing_state().await)
}

#[tauri::command]
pub(crate) async fn web_access_pairing_approve(
    runtime: State<'_, Arc<WebAccessRuntime>>,
    claim_id: String,
) -> Result<WebAccessStatusView, String> {
    runtime.approve(&claim_id).await.map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_pairing_deny(
    runtime: State<'_, Arc<WebAccessRuntime>>,
    claim_id: String,
) -> Result<WebAccessStatusView, String> {
    runtime.deny(&claim_id).await.map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_pairing_cancel(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<WebAccessStatusView, String> {
    runtime.cancel_pairing().await.map_err(map_error)
}

#[tauri::command]
pub(crate) async fn web_access_devices_list(
    runtime: State<'_, Arc<WebAccessRuntime>>,
) -> Result<Vec<DeviceView>, String> {
    Ok(runtime.devices().await)
}

#[tauri::command]
pub(crate) async fn web_access_device_revoke(
    runtime: State<'_, Arc<WebAccessRuntime>>,
    device_id: String,
) -> Result<bool, String> {
    runtime.revoke_device(&device_id).await.map_err(map_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_message_carries_its_stable_code() {
        let cases = [
            RuntimeError::AlreadyEnabled,
            RuntimeError::NotEnabled,
            RuntimeError::InvalidState,
            RuntimeError::SafeMode,
            RuntimeError::InvalidIp,
            RuntimeError::NoLanAddress,
            RuntimeError::Ca(crate::ca::CaError::NotInitialized),
        ];
        for error in cases {
            let message = error_message(&error);
            assert!(
                message.contains(&format!("（{}）", error.code())),
                "{message} must carry {}",
                error.code()
            );
        }
    }

    #[test]
    fn error_message_never_contains_secret_material() {
        let message = error_message(&RuntimeError::Pairing(
            crate::web_access::auth::AuthError::Pairing(
                crate::web_access::pairing::PairingError::Consumed,
            ),
        ));
        assert!(message.contains("pairing-consumed"));
        assert!(!message.contains("moyu"));
        assert!(!message.contains("pair_"));
        assert!(!message.contains("claim_"));
    }
}
