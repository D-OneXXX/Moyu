//! 跨平台启动期加固与安装形态探测。
//!
//! Linux（WebKitGTK）专属逻辑全部用 `#[cfg(target_os = "linux")]` 隔离；
//! Windows 侧的版本准入收敛到 [`enforce_windows_baseline`]。纯决策函数保持
//! 跨平台可测（非 Windows 宿主上 `cargo test` 也能覆盖决策表）。

/// Windows 最低支持基线：Windows 10 (NT 10.0) RTM，Build 10240。
///
/// 低于该基线的系统（Win7 SP1 / Win8 / Win8.1）不再提供任何兼容垫片：
/// 安装器（`nsis/hooks.nsh`）先拦一层，进程启动期再硬校验一次。
pub const MIN_WINDOWS_BUILD: u32 = 10240;

/// 系统低于基线时的退出码（Fail-Fast，非零，便于安装器/自动化识别）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const EXIT_UNSUPPORTED_WINDOWS: i32 = 96;

/// Windows 版本准入判定（纯函数，便于在任意宿主上单测）。
///
/// - `major > 10`：未来版本，放行；
/// - `major == 10`：Build 必须 ≥ 10240（Win10 RTM；Win11 同样报 major 10）；
/// - `major < 10`：Win7 / Win8 / Win8.1，拒绝。
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn windows_supported(major: u32, build: u32) -> bool {
    major > 10 || (major == 10 && build >= MIN_WINDOWS_BUILD)
}

/// 启动最早期硬校验：必须在数据库初始化与 WebView 创建之前调用。
///
/// 非 Windows 目标为空实现（Linux 的 WebKitGTK 加固仍走
/// [`early_env_hardening`]）。
pub fn enforce_windows_baseline() {
    #[cfg(target_os = "windows")]
    windows_baseline_gate();
}

#[cfg(target_os = "windows")]
fn windows_baseline_gate() {
    let Some((major, build)) = windows_kernel_version() else {
        // 查询失败（理论上不会发生）不误伤用户：记录后放行。
        eprintln!("[platform] 无法读取 Windows 内核版本，跳过基线校验");
        return;
    };
    if windows_supported(major, build) {
        return;
    }
    eprintln!(
        "[platform] windows-unsupported: NT {major}.x build {build}（要求 Windows 10 / Build {MIN_WINDOWS_BUILD}+）"
    );
    show_unsupported_windows_notice();
    std::process::exit(EXIT_UNSUPPORTED_WINDOWS);
}

/// `OSVERSIONINFOW`（只用到前 5 个 DWORD + CSD 串，布局必须逐字节一致）。
#[cfg(target_os = "windows")]
#[repr(C)]
struct OsVersionInfoW {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform: u32,
    csd: [u16; 128],
}

#[cfg(target_os = "windows")]
#[link(name = "ntdll")]
extern "system" {
    /// 真实内核版本。`GetVersionEx` 会被应用清单的兼容性声明欺骗，
    /// `RtlGetVersion` 不会——这是「低于 Win10 必须拒绝」的可信来源。
    fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
}

#[cfg(target_os = "windows")]
fn windows_kernel_version() -> Option<(u32, u32)> {
    let mut info = OsVersionInfoW {
        size: std::mem::size_of::<OsVersionInfoW>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        csd: [0; 128],
    };
    // SAFETY: `info` 是按 RtlGetVersion 期望布局初始化、可写的 OSVERSIONINFOW；
    // 调用只写入该结构体，不保留任何指针。
    let status = unsafe { RtlGetVersion(&mut info) };
    (status == 0).then_some((info.major, info.build))
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(
        hwnd: *mut core::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        utype: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
fn show_unsupported_windows_notice() {
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_OK: u32 = 0x0000_0000;
    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
    let text = wide(
        "MangaReader 需要 Windows 10（NT 10.0, Build 10240）或更高版本。\n\
         MangaReader requires Windows 10 (Build 10240) or later.",
    );
    let caption = wide("MangaReader");
    // SAFETY: 两个字符串都以 NUL 结尾并在调用期间存活；无父窗口（桌面提示）。
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_ICONERROR | MB_OK,
        );
    }
}

/// setup 之前的启动期环境加固。
///
/// Linux + WebKitGTK：在安全模式、用户显式请求或「Wayland + NVIDIA」
/// 组合下注入 `WEBKIT_DISABLE_DMABUF_RENDERER=1`，避免 DMABUF 渲染器
/// 在部分驱动栈上黑屏/闪烁。用户已手动设置的值永远优先，不覆盖。
pub fn early_env_hardening() {
    #[cfg(target_os = "linux")]
    linux_webkit_hardening();
}

/// DMABUF 禁用决策（纯函数，便于测试）。
///
/// - `user_set`：用户环境里已有 `WEBKIT_DISABLE_DMABUF_RENDERER` → 不动；
/// - `force`：`MR_FORCE_DISABLE_DMABUF=1` 显式请求 → 禁用；
/// - `safe_mode`：安全模式激活 → 禁用；
/// - `wayland && nvidia`：Wayland 合成器 + NVIDIA 专有驱动 → 禁用。
// 非 Linux 目标上唯一调用方被 cfg 掉，保留函数供测试与文档引用。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn decide_dmabuf_disable(
    user_set: bool,
    force: bool,
    safe_mode: bool,
    wayland: bool,
    nvidia: bool,
) -> bool {
    if user_set {
        return false;
    }
    force || safe_mode || (wayland && nvidia)
}

#[cfg(target_os = "linux")]
const DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

#[cfg(target_os = "linux")]
fn linux_webkit_hardening() {
    if std::env::var_os(DMABUF_ENV).is_some() {
        return;
    }
    let force = std::env::var("MR_FORCE_DISABLE_DMABUF")
        .map(|v| v == "1")
        .unwrap_or(false);
    let safe_mode = linux_safe_mode_active();
    let wayland = linux_wayland_session();
    let nvidia = linux_nvidia_present();
    if decide_dmabuf_disable(false, force, safe_mode, wayland, nvidia) {
        // Rust 2021 edition：set_var 仍是安全 API。
        std::env::set_var(DMABUF_ENV, "1");
        let reason = if force {
            "user-override"
        } else if safe_mode {
            "safe-mode"
        } else {
            "nvidia-wayland"
        };
        eprintln!("[platform] WEBKIT_DISABLE_DMABUF_RENDERER=1（{reason}）");
    }
}

/// 安全模式标记文件在 setup 之前读取：数据根尚未经 Tauri 解析，
/// 按 XDG 约定直接定位（`MR_DATA_DIR` > `$XDG_DATA_HOME` > `~/.local/share`）。
#[cfg(target_os = "linux")]
fn linux_pre_setup_data_dir() -> Option<std::path::PathBuf> {
    if let Some(raw) = std::env::var_os("MR_DATA_DIR") {
        let trimmed = raw.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            let path = std::path::PathBuf::from(&trimmed);
            // 与 lib::data_dir 保持同一契约：相对路径绝不落到 CWD。
            if path.is_absolute() {
                return Some(path);
            }
            eprintln!("[platform] MR_DATA_DIR 不是绝对路径，已忽略并回落到 XDG 目录");
        }
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })?;
    Some(base.join("com.local.manga-reader"))
}

#[cfg(target_os = "linux")]
fn linux_safe_mode_active() -> bool {
    let Some(dir) = linux_pre_setup_data_dir() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(dir.join("safe-mode.json")) else {
        return false;
    };
    #[derive(serde::Deserialize)]
    struct SafeModeFlag {
        #[serde(default)]
        active: bool,
    }
    serde_json::from_str::<SafeModeFlag>(&raw)
        .map(|flag| flag.active)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v == "wayland")
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_nvidia_present() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::env::var("__GLX_VENDOR_LIBRARY_NAME")
            .map(|v| v == "nvidia")
            .unwrap_or(false)
}

/// 当前安装形态（更新策略使用；跨平台编译，非 Linux 恒为空串）。
///
/// - `appimage`：AppImage 运行态（`APPIMAGE`/`APPDIR` 由运行时注入）；
/// - `system`：`/usr`、`/opt` 下的系统安装（deb/rpm 包管理器管辖）；
/// - `portable`：其余（开发态、手动解压运行）；
/// - Windows/macOS：空串，前端据此完全跳过 Linux 更新策略分支。
pub fn install_channel() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() && std::env::var_os("APPDIR").is_some() {
            return "appimage";
        }
        if let Ok(exe) = std::env::current_exe() {
            if exe.starts_with("/usr/") || exe.starts_with("/opt/") {
                return "system";
            }
        }
        "portable"
    }
    #[cfg(not(target_os = "linux"))]
    {
        ""
    }
}

/// 目标路径所在卷的可用字节数（更新下载前预检）。
///
/// 用 sysinfo 的挂载点列表做跨平台探测：取包含 canonical path 的最长挂载点，
/// 避免把 Windows 多盘符或 Linux bind mount 的 `/` 当成唯一答案。
pub fn free_bytes(path: &std::path::Path) -> Option<u64> {
    let canonical = path.canonicalize().ok()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dmabuf_decision_table() {
        // 用户已设置 → 永不覆盖。
        assert!(!decide_dmabuf_disable(true, false, false, true, true));
        // 显式请求 / 安全模式 / NVIDIA+Wayland 各自独立触发。
        assert!(decide_dmabuf_disable(false, true, false, false, false));
        assert!(decide_dmabuf_disable(false, false, true, false, false));
        assert!(decide_dmabuf_disable(false, false, false, true, true));
        // NVIDIA 但 X11、或 Wayland 但非 NVIDIA → 不动默认渲染路径。
        assert!(!decide_dmabuf_disable(false, false, false, true, false));
        assert!(!decide_dmabuf_disable(false, false, false, false, true));
        assert!(!decide_dmabuf_disable(false, false, false, false, false));
    }

    #[test]
    fn windows_baseline_table() {
        // 支持的基线：Win10 RTM / 后续累积更新 / Win11（同样报 major 10）。
        assert!(windows_supported(10, 10240));
        assert!(windows_supported(10, 19045));
        assert!(windows_supported(10, 22000));
        assert!(windows_supported(10, 26100));
        // 未来主版本：不拦（只拒绝低于基线的系统）。
        assert!(windows_supported(11, 0));
        // 低于基线：Win7 SP1 / Win8 / Win8.1 / 未达 RTM 的 10 预览版。
        assert!(!windows_supported(6, 7601));
        assert!(!windows_supported(6, 9200));
        assert!(!windows_supported(6, 9600));
        assert!(!windows_supported(10, 10239));
    }

    #[test]
    fn install_channel_is_empty_off_linux() {
        let channel = install_channel();
        if cfg!(target_os = "linux") {
            assert!(matches!(channel, "appimage" | "system" | "portable"));
        } else {
            assert_eq!(channel, "");
        }
    }
}
