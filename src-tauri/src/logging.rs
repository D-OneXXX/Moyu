//! 轻量错误日志：追加写本地文件，供"解码失败"等静默问题留痕。
//! 位置：`<数据目录>/logs/app.log`；失败静默（日志永远不能拖垮主流程）。
//!
//! 单文件达到 `MAX_LOG_FILE_BYTES` 时轮转为唯一的 `app.log.1`，磁盘占用
//! 上限约为两倍阈值；轮转任何一步失败都退回纯追加，绝不 panic、绝不阻断调用方。
//!
//! 同时在进程内保留一个有界环形缓冲，仅用于用户主动打开的本地诊断包；
//! 该缓冲绝不联网、绝不写入数据库。

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;

const MEMORY_LIMIT: usize = 200;
const MAX_MESSAGE_CHARS: usize = 32 * 1024;

/// 活跃 `app.log` 的软上限：2 MiB。
///
/// 错误日志是低频事件（每行约 80–200 字节），2 MiB 已能容纳数万条记录，
/// 足以覆盖一个发布周期的排障需求；配合单个备份，稳态磁盘占用约 4 MiB，
/// 对用户数据目录是可忽略的量级，同时避免把 `logs/` 变成无界增长点。
const MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 备份后缀：只保留一个历史文件（`app.log.1`），不做多代滚存。
const BACKUP_SUFFIX: &str = ".1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at: String,
    pub scope: String,
    pub message: String,
}

static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn ring() -> &'static Mutex<VecDeque<LogEntry>> {
    static RING: OnceLock<Mutex<VecDeque<LogEntry>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(MEMORY_LIMIT)))
}

/// 初始化日志路径（应用 setup 时调用一次）。
pub fn init(dir: PathBuf) {
    if std::fs::create_dir_all(&dir).is_ok() {
        *LOG_FILE.lock() = Some(dir.join("app.log"));
    }
}

/// `app.log` 的唯一备份路径（`app.log.1`）。
fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(BACKUP_SUFFIX);
    PathBuf::from(name)
}

/// 活跃文件达到上限时把它整体挪到 `app.log.1`（覆盖旧备份）。
///
/// 调用方必须持有 `LOG_FILE` 锁，并发写因此天然串行。任何一步失败都只是
/// 放弃本次轮转、继续向原文件追加：日志系统永远不能影响业务主流程。
fn rotate_if_oversized(path: &Path) {
    let oversized = std::fs::metadata(path)
        .map(|meta| meta.len() >= MAX_LOG_FILE_BYTES)
        .unwrap_or(false);
    if !oversized {
        return;
    }

    let backup = backup_path(path);
    // Windows 的 rename 不能覆盖已存在的目标；先删旧备份。
    // 首次轮转时备份不存在（NotFound）属于正常路径。
    match std::fs::remove_file(&backup) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return,
    }
    // rename 失败（只读、被占用、跨设备等）同样退回纯追加。
    let _ = std::fs::rename(path, &backup);
}

/// 追加一行错误：`[时间] [scope] message`，并写入内存环形缓冲。
/// 活跃文件达到 `MAX_LOG_FILE_BYTES` 时先轮转到 `app.log.1` 再追加。
pub fn log_error(scope: &str, message: &str) {
    let now = chrono::Local::now();
    let at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
    let message: String = crate::diagnostics::sanitize_text(message, true)
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect();
    let scope: String = crate::diagnostics::sanitize_text(scope, true)
        .chars()
        .take(80)
        .collect();

    let path_guard = LOG_FILE.lock();
    if let Some(path) = path_guard.as_ref() {
        rotate_if_oversized(path);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(
                f,
                "[{}] [{}] {}",
                now.format("%Y-%m-%d %H:%M:%S"),
                scope,
                message
            );
        }
    }
    drop(path_guard);

    let mut entries = ring().lock();
    if entries.len() >= MEMORY_LIMIT {
        entries.pop_front();
    }
    entries.push_back(LogEntry { at, scope, message });
}

/// Oldest-to-newest recent entries, bounded by both `limit` and the ring cap.
pub fn recent_logs(limit: usize) -> Vec<LogEntry> {
    if limit == 0 {
        return Vec::new();
    }
    let entries = ring().lock();
    entries
        .iter()
        .skip(entries.len().saturating_sub(limit))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // `LOG_FILE` is process-global by design; these two tests must not swap it
    // while the other is writing/reading, or `cargo test` becomes flaky.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mr-log-{}-{tag}-{nanos}", std::process::id()))
    }

    #[test]
    fn log_redacts_sensitive_path_before_storage() {
        let _guard = TEST_LOCK.lock();
        let dir = unique_dir("redaction");
        init(dir.clone());
        log_error("browser_import", r"failed C:\Users\Alice\Comics\Secret.cbz");
        let content = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(
            !content.contains("Alice") && !content.contains("Secret"),
            "{content}"
        );
        let entry = recent_logs(1).pop().unwrap();
        assert!(!entry.message.contains("Alice") && !entry.message.contains("Secret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn appends_lines() {
        let _guard = TEST_LOCK.lock();
        let dir = unique_dir("file");
        init(dir.clone());
        log_error("test", "第一条");
        log_error("test", "第二条");
        let content = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(content.contains("第一条") && content.contains("第二条"));
        assert!(content.matches("[test]").count() >= 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn memory_ring_returns_recent_entries_and_is_bounded() {
        let _guard = TEST_LOCK.lock();
        init(unique_dir("ring"));
        for index in 0..(MEMORY_LIMIT + 5) {
            log_error("ring-test", &format!("entry-{index}"));
        }
        let entries = recent_logs(3);
        assert_eq!(entries.len(), 3);
        assert!(entries[2]
            .message
            .ends_with(&format!("entry-{}", MEMORY_LIMIT + 4)));
        assert_eq!(entries[2].scope, "ring-test");
        assert!(recent_logs(10_000).len() <= MEMORY_LIMIT);
    }

    #[test]
    fn rotates_to_single_backup_when_cap_reached() {
        let _guard = TEST_LOCK.lock();
        let dir = unique_dir("rotate");
        init(dir.clone());
        let log = dir.join("app.log");
        let backup = dir.join("app.log.1");

        // 先把活跃文件填到刚好等于上限，下一次写入必须先轮转再追加。
        std::fs::write(&log, "x".repeat(MAX_LOG_FILE_BYTES as usize)).unwrap();
        log_error("rotate-test", "first-marker");

        assert!(backup.exists(), "达到上限后应生成 app.log.1");
        assert_eq!(
            std::fs::metadata(&backup).unwrap().len(),
            MAX_LOG_FILE_BYTES,
            "旧内容应完整进入备份"
        );
        let live = std::fs::read_to_string(&log).unwrap();
        assert!(live.contains("first-marker"), "{live}");
        assert!(!live.contains("xxxxxxxx"), "轮转后活跃文件必须从新内容开始");
        let total =
            std::fs::metadata(&backup).unwrap().len() + std::fs::metadata(&log).unwrap().len();
        // 预留 64 KiB 余量：`LOG_FILE` 是进程全局的，并行测试里其它模块的
        // `log_error` 也可能落到本目录，但整体仍必须远离无界增长。
        assert!(
            total <= MAX_LOG_FILE_BYTES + 64 * 1024,
            "备份 + 活跃文件必须保持有界，实际 {total}"
        );

        // 第二次轮转覆盖旧备份，而不是继续堆叠。
        std::fs::write(&log, "y".repeat(MAX_LOG_FILE_BYTES as usize)).unwrap();
        log_error("rotate-test", "second-marker");
        let second_backup = std::fs::read_to_string(&backup).unwrap();
        assert!(
            !second_backup.contains("first-marker"),
            "只保留一代备份，旧备份应被覆盖"
        );
        assert!(second_backup.starts_with("yyyy"));
        assert!(std::fs::read_to_string(&log)
            .unwrap()
            .contains("second-marker"));
        assert!(!dir.join("app.log.2").exists(), "不应产生第二代备份");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn does_not_rotate_below_cap() {
        let _guard = TEST_LOCK.lock();
        let dir = unique_dir("below-cap");
        init(dir.clone());
        for index in 0..20 {
            log_error("below-cap", &format!("line-{index}"));
        }
        assert!(!dir.join("app.log.1").exists(), "未达上限不得轮转");
        let content = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(content.contains("line-0") && content.contains("line-19"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotation_failure_still_appends_without_panic() {
        let _guard = TEST_LOCK.lock();
        let dir = unique_dir("rotate-fail");
        init(dir.clone());
        let log = dir.join("app.log");
        std::fs::write(&log, "z".repeat(MAX_LOG_FILE_BYTES as usize)).unwrap();
        // 用同名目录占用备份路径：删旧备份与 rename 在 Windows / Unix 都会失败，
        // 模拟轮转不可用（只读或占用目录的平台近似）。
        std::fs::create_dir_all(dir.join("app.log.1")).unwrap();

        log_error("rotate-fail", "still-written");

        let content = std::fs::read_to_string(&log).unwrap();
        assert!(
            content.contains("still-written"),
            "轮转失败时当前日志仍必须落盘"
        );
        // 内存环是进程全局的，并行测试可能有其它模块的写入，因此只断言存在性。
        assert!(recent_logs(10_000)
            .iter()
            .any(|entry| entry.message == "still-written"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
