//! 官方 GitHub 更新通道的受控代理（WebView 不得直连插件）。
//!
//! `tauri-plugin-updater` 仍然注册，端点与 minisign 公钥仍然只来自构建期
//! `tauri.conf.json plugins.updater`；但 `capabilities/updater.json` 不再授予
//! `updater:default`，页面里的 `plugin:updater|check` /
//! `plugin:updater|download_and_install` 会被 ACL 直接拒绝。
//!
//! 所有更新动作只能经本模块的两个命令：
//!
//! 1. `check_native_update`：过 `FeatureId::Updates` 门卫后再访问 updater；
//! 2. `install_native_update`：同样先过门卫，再用 `restore_update(rawJson)`
//!    复原清单（不重复联网检查），校验版本号后用官方
//!    `download_and_install` 完成下载、签名校验与安装。
//!
//! Rust 侧插件 API 不受 ACL 约束，因此门卫是关闭开关后的唯一防线：顺序固定为
//! 「门卫 → 更新器」，关闭时绝不触碰 updater，也绝不发起网络请求。
//!
//! 日志只记录阶段与稳定码：原始 JSON、下载地址、签名与请求头一律不进日志。

use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::features::{ensure_enabled, FeatureFlags, FeatureId};
use crate::AppState;

/// 检查更新失败（网络、清单缺失、平台不支持等）。
const UPDATE_CHECK_FAILED: &str = "无法检查更新（update-check-failed）";
/// 下载或安装失败（下载、签名校验、安装器启动）。
const UPDATE_INSTALL_FAILED: &str = "无法下载或安装更新（update-install-failed）";
/// 检查之后清单发生变化：必须重新检查，绝不错装另一个版本。
const UPDATE_VERSION_CHANGED: &str = "更新版本已变化，请重新检查（update-version-changed）";

/// 门卫令牌：只有 `open_updates` 成功返回后，命令才允许访问 updater。
///
/// 这是一个纯顺序约束（不持有任何 updater 资源），便于单元测试断言
/// 「关闭开关时更新器访问代码根本不会执行」。
struct UpdatesGate;

/// `FeatureId::Updates` 的唯一门卫。关闭时返回稳定码 `feature-disabled`。
fn open_updates(flags: &FeatureFlags) -> Result<UpdatesGate, String> {
    ensure_enabled(flags, FeatureId::Updates)?;
    Ok(UpdatesGate)
}

/// 校验前端记下的版本与复原后的清单版本一致。
fn verify_expected_version(expected: &str, announced: &str) -> Result<(), String> {
    if expected.trim() == announced.trim() && !announced.trim().is_empty() {
        Ok(())
    } else {
        Err(UPDATE_VERSION_CHANGED.to_string())
    }
}

/// 检查结果：只含展示信息与复原所需的原始清单。
///
/// `rawJson` 是安装时的唯一凭据来源（`restore_update` 会强制签名绑定版本），
/// 绝不写日志、诊断产物或备份。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUpdateInfo {
    pub version: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
}

impl NativeUpdateInfo {
    fn from_update(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            date: update.date.as_ref().and_then(|value| {
                // 前端用 `new Date(date)` 解析，因此输出 RFC 3339（UTC）。
                chrono::DateTime::from_timestamp(value.unix_timestamp(), 0)
                    .map(|value| value.to_rfc3339())
            }),
            body: update
                .body
                .as_deref()
                .map(str::trim)
                .filter(|body| !body.is_empty())
                .map(str::to_string),
            raw_json: update.raw_json.clone(),
        }
    }
}

/// 安装进度事件：与插件回调一一对应，由前端映射成原有进度条形态。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NativeInstallEvent {
    /// 第一个数据块（或 0 字节响应）之前推送一次，携带服务端声明的内容长度。
    Started { content_length: Option<u64> },
    /// 每个数据块一次：累计字节数 + 服务端声明总长度。
    Progress {
        downloaded: u64,
        total: Option<u64>,
        chunk_length: u64,
    },
    /// 下载完成、开始校验与调用安装器。
    Installing,
}

/// 只记录阶段与稳定码；不含 URL、签名、原始 JSON 与请求头。
fn log_failure(stage: &str, code: &str) {
    crate::logging::log_error("update_native", &format!("{stage}失败（{code}）"));
}

/// 检查更新。关闭开关时在接触 updater 之前就返回 `feature-disabled`。
#[tauri::command]
pub async fn check_native_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<NativeUpdateInfo>, String> {
    let flags = state.settings.lock().features.clone();
    let _gate = open_updates(&flags)?;
    let updater = app.updater().map_err(|_| UPDATE_CHECK_FAILED.to_string())?;
    let update = updater.check().await.map_err(|_| {
        log_failure("检查更新", "update-check-failed");
        UPDATE_CHECK_FAILED.to_string()
    })?;
    Ok(update.as_ref().map(NativeUpdateInfo::from_update))
}

/// 用检查阶段保存的清单复原更新并安装。
///
/// 不重复联网检查（`restore_update` 不发请求），但仍要求签名绑定版本；
/// 版本与前端确认过的 `expectedVersion` 不一致时返回 `update-version-changed`。
/// Windows 上 NSIS 安装器会在用户点击安装后接管并结束进程；其它平台返回后
/// 由前端调用 `restart_app`。
#[tauri::command]
pub async fn install_native_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    expected_version: String,
    raw_json: serde_json::Value,
    on_event: Channel<NativeInstallEvent>,
) -> Result<(), String> {
    let flags = state.settings.lock().features.clone();
    let _gate = open_updates(&flags)?;

    let updater: Updater = app
        .updater()
        .map_err(|_| UPDATE_INSTALL_FAILED.to_string())?;
    // 清单本身未经认证：`restore_update` 会强制「签名绑定版本」，篡改版本号
    // 只会让安装阶段验签失败，不会装错包。
    let update = updater
        .restore_update(raw_json)
        .map_err(|_| {
            log_failure("恢复更新清单", "update-install-failed");
            UPDATE_INSTALL_FAILED.to_string()
        })?
        .ok_or_else(|| UPDATE_VERSION_CHANGED.to_string())?;
    verify_expected_version(&expected_version, &update.version)?;

    let progress_channel = on_event.clone();
    let mut started = false;
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    downloaded = 0;
                    let _ = progress_channel.send(NativeInstallEvent::Started { content_length });
                }
                downloaded += chunk_length as u64;
                let _ = progress_channel.send(NativeInstallEvent::Progress {
                    downloaded,
                    total: content_length,
                    chunk_length: chunk_length as u64,
                });
            },
            move || {
                let _ = on_event.send(NativeInstallEvent::Installing);
            },
        )
        .await;

    result.map_err(|_| {
        log_failure("下载或安装更新", "update-install-failed");
        UPDATE_INSTALL_FAILED.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::FeatureFlags;
    use serde_json::json;

    fn flags_with_updates(enabled: bool) -> FeatureFlags {
        FeatureFlags {
            updates: enabled,
            ..FeatureFlags::default()
        }
    }

    #[test]
    fn gate_blocks_before_any_updater_access() {
        // 关闭开关时 `open_updates` 失败，之后的「访问更新器」代码不会执行。
        fn gated_probe(flags: &FeatureFlags) -> Result<&'static str, String> {
            let _gate = open_updates(flags)?;
            Ok("updater-accessed")
        }

        let err = gated_probe(&flags_with_updates(false)).unwrap_err();
        assert!(err.contains("feature-disabled"), "实际错误：{err}");
        assert_eq!(
            gated_probe(&flags_with_updates(true)).unwrap(),
            "updater-accessed"
        );
    }

    #[test]
    fn version_mismatch_returns_stable_code() {
        assert!(verify_expected_version("1.2.3", "1.2.3").is_ok());
        assert!(verify_expected_version(" 1.2.3 ", "1.2.3").is_ok());
        let err = verify_expected_version("1.2.3", "1.2.4").unwrap_err();
        assert!(err.contains("update-version-changed"));
        // 空版本一律拒绝，避免把空字符串当成匹配。
        assert!(verify_expected_version("", "").is_err());
    }

    #[test]
    fn install_events_match_frontend_contract() {
        let started = serde_json::to_value(NativeInstallEvent::Started {
            content_length: Some(42),
        })
        .unwrap();
        assert_eq!(
            started,
            json!({"event": "started", "data": {"contentLength": 42}})
        );

        let unknown = serde_json::to_value(NativeInstallEvent::Started {
            content_length: None,
        })
        .unwrap();
        assert_eq!(
            unknown,
            json!({"event": "started", "data": {"contentLength": null}})
        );

        let progress = serde_json::to_value(NativeInstallEvent::Progress {
            downloaded: 7,
            total: Some(42),
            chunk_length: 7,
        })
        .unwrap();
        assert_eq!(
            progress,
            json!({"event": "progress", "data": {"downloaded": 7, "total": 42, "chunkLength": 7}})
        );

        // 单元变体不携带 data 键，前端用 `event` 判别。
        let installing = serde_json::to_value(NativeInstallEvent::Installing).unwrap();
        assert_eq!(installing, json!({"event": "installing"}));
    }

    #[test]
    fn info_serializes_camel_case_with_raw_json() {
        let info = NativeUpdateInfo {
            version: "1.2.4".into(),
            current_version: "1.2.3".into(),
            date: None,
            body: None,
            raw_json: json!({"version": "1.2.4"}),
        };
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["version"], "1.2.4");
        assert_eq!(value["currentVersion"], "1.2.3");
        assert_eq!(value["rawJson"]["version"], "1.2.4");
        // 可选字段为空时不出现（前端据此决定是否显示发布日期/更新说明）。
        assert!(value.get("date").is_none());
        assert!(value.get("body").is_none());
    }
}
