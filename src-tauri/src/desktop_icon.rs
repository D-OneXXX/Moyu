//! Desktop / taskbar / tray icon replacement (Task 7).
//!
//! # Why the Shell Link API and not PE resource patching
//!
//! The shipped executable is covered by the Minisign signature that the
//! official updater verifies. Rewriting an icon resource inside the EXE would
//! invalidate that signature and break the update channel, so the shortcut is
//! redirected to a generated `.ico` file instead: the binary on disk is never
//! touched, only the `.lnk` metadata.
//!
//! # Layout
//!
//! - `<app_data_dir>/icons/active.ico` — generated multi-size icon;
//! - `<app_data_dir>/icons/state.json` — which selection produced it;
//! - Desktop / Start Menu `.lnk` files point at `active.ico`.
//!
//! Every failure is a stable kebab-case code (mirrored in
//! `src/features/errors/localize.ts` and the six dictionaries), never a human
//! sentence.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::ico::{IcoEncoder, IcoFrame};
use image::{
    imageops::FilterType, DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, ImageReader,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Hard ceiling for an uploaded icon: 2 MiB (Task 7 contract).
const MAX_ICON_BYTES: usize = 2 * 1024 * 1024;
/// Layers written into the generated `.ico`: Explorer, taskbar, large views.
const ICON_SIZES: [u32; 4] = [16, 32, 48, 256];
/// How deep the shortcut scan walks below Desktop / Start Menu.
const SHORTCUT_SCAN_DEPTH: usize = 3;
/// File name stems that identify a Moyu shortcut.
const SHORTCUT_STEMS: [&str; 3] = ["moyu", "mangareader", "manga reader"];

/// Stable error codes.
pub const ERR_TOO_LARGE: &str = "desktop-icon-too-large";
pub const ERR_EMPTY: &str = "desktop-icon-empty";
pub const ERR_UNSUPPORTED: &str = "desktop-icon-unsupported-format";
pub const ERR_DECODE: &str = "desktop-icon-decode-failed";
pub const ERR_ENCODE: &str = "desktop-icon-encode-failed";
pub const ERR_COM: &str = "desktop-icon-com-failed";
pub const ERR_PATH: &str = "desktop-icon-path-unavailable";

/// One shortcut the scan found, and whether the icon was written to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIconShortcut {
    pub path: String,
    pub updated: bool,
    /// Stable error code, empty when the shortcut was updated.
    pub error: String,
}

/// Current state of the desktop / taskbar icon.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIconState {
    /// False on platforms without the Shell Link API (Linux / macOS).
    pub supported: bool,
    /// Active preset id; `null` when a custom image is installed.
    pub preset: Option<String>,
    pub custom: bool,
    /// Absolute path of the generated `.ico` (empty when nothing is installed).
    pub ico_path: String,
    pub shortcuts: Vec<DesktopIconShortcut>,
}

/// What the user asked to install.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DesktopIconInput {
    /// A built-in preset rasterized by the webview (PNG data URL).
    Preset { preset: String, data_url: String },
    /// A user-uploaded image (PNG / JPEG / WebP data URL).
    Custom { data_url: String },
}

/// Persisted marker next to `active.ico`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopIconMarker {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preset: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Report the installed icon and the shortcuts the scan can see.
#[tauri::command]
pub async fn desktop_icon_state() -> DesktopIconState {
    let marker = read_marker();
    let ico = active_ico_path().ok();
    DesktopIconState {
        supported: platform_supported(),
        preset: marker.as_ref().and_then(|m| m.preset.clone()),
        custom: marker.as_ref().map(|m| m.kind == "custom").unwrap_or(false),
        ico_path: ico
            .as_ref()
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        shortcuts: scan_shortcuts(),
    }
}

/// Install an icon: encode the `.ico`, write it, retarget every shortcut and
/// refresh the running window / tray icon.
#[tauri::command]
pub async fn desktop_icon_install(
    app: tauri::AppHandle,
    input: DesktopIconInput,
) -> Result<DesktopIconState, String> {
    let (preset, data_url) = match input {
        DesktopIconInput::Preset { preset, data_url } => (Some(preset), data_url),
        DesktopIconInput::Custom { data_url } => (None, data_url),
    };
    let preset_id = preset.clone();

    let bytes = decode_data_url(&data_url)?;
    let image = decode_image(&bytes)?;
    let ico = encode_ico(&image)?;
    let png = encode_png(&image, 64)?;

    let ico_path = active_ico_path()?;
    write_atomic(&ico_path, &ico)?;
    write_marker(&DesktopIconMarker {
        kind: if preset_id.is_some() {
            "preset"
        } else {
            "custom"
        }
        .to_string(),
        preset: preset_id.clone(),
    })?;

    apply_runtime_icon(&app, &png);
    apply_shortcuts(&ico_path)?;

    Ok(DesktopIconState {
        supported: platform_supported(),
        preset: preset_id.clone(),
        custom: preset_id.is_none(),
        ico_path: ico_path.to_string_lossy().to_string(),
        shortcuts: scan_shortcuts(),
    })
}

/// Drop the custom icon and point the shortcuts back at the executable.
#[tauri::command]
pub async fn desktop_icon_reset(app: tauri::AppHandle) -> Result<DesktopIconState, String> {
    let ico_path = active_ico_path()?;
    if ico_path.is_file() {
        let _ = std::fs::remove_file(&ico_path);
    }
    let _ = std::fs::remove_file(ico_path.with_file_name("state.json"));
    reset_shortcuts()?;
    if let Some(default_icon) = app.default_window_icon().cloned() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_icon(default_icon);
        }
    }
    Ok(DesktopIconState {
        supported: platform_supported(),
        preset: None,
        custom: false,
        ico_path: String::new(),
        shortcuts: scan_shortcuts(),
    })
}

/// Re-apply the stored icon to the running window and the tray at startup.
/// The shortcuts are not touched here: they already point at `active.ico`.
pub(crate) fn restore_runtime_icon(app: &tauri::AppHandle) {
    let Ok(ico_path) = active_ico_path() else {
        return;
    };
    if !ico_path.is_file() {
        return;
    }
    let Ok(bytes) = std::fs::read(&ico_path) else {
        return;
    };
    let Ok(image) = decode_image(&bytes) else {
        return;
    };
    let Ok(png) = encode_png(&image, 64) else {
        return;
    };
    apply_runtime_icon(app, &png);
}

// ---------------------------------------------------------------------------
// Decoding / encoding (platform independent)
// ---------------------------------------------------------------------------

/// Decode a `data:image/…;base64,…` payload with the 2 MiB ceiling.
fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let trimmed = data_url.trim();
    if !trimmed.starts_with("data:image/") {
        return Err(ERR_UNSUPPORTED.to_string());
    }
    let Some((_, payload)) = trimmed.split_once(',') else {
        return Err(ERR_UNSUPPORTED.to_string());
    };
    if payload.trim().is_empty() {
        return Err(ERR_EMPTY.to_string());
    }
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| ERR_UNSUPPORTED.to_string())?;
    if bytes.is_empty() {
        return Err(ERR_EMPTY.to_string());
    }
    if bytes.len() > MAX_ICON_BYTES {
        return Err(ERR_TOO_LARGE.to_string());
    }
    Ok(bytes)
}

/// Sniff the magic bytes and decode the raster.
fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    let format = image::guess_format(bytes).map_err(|_| ERR_UNSUPPORTED.to_string())?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::WebP
            | ImageFormat::Gif
            | ImageFormat::Bmp
    ) {
        return Err(ERR_UNSUPPORTED.to_string());
    }
    let reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    reader.decode().map_err(|_| ERR_DECODE.to_string())
}

/// Encode the multi-size Windows icon (16 / 32 / 48 / 256).
fn encode_ico(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut frames: Vec<IcoFrame<'_>> = Vec::with_capacity(ICON_SIZES.len());
    for size in ICON_SIZES {
        let resized = image.resize(size, size, FilterType::Lanczos3).to_rgba8();
        let (width, height) = resized.dimensions();
        let frame = IcoFrame::as_png(resized.as_raw(), width, height, ExtendedColorType::Rgba8)
            .map_err(|_| ERR_ENCODE.to_string())?;
        frames.push(frame);
    }
    let mut out: Vec<u8> = Vec::with_capacity(64 * 1024);
    IcoEncoder::new(&mut out)
        .encode_images(&frames)
        .map_err(|_| ERR_ENCODE.to_string())?;
    Ok(out)
}

/// Encode a PNG for the runtime window / tray icon.
fn encode_png(image: &DynamicImage, size: u32) -> Result<Vec<u8>, String> {
    let resized = image.resize(size, size, FilterType::Lanczos3).to_rgba8();
    let (width, height) = resized.dimensions();
    let mut out: Vec<u8> = Vec::with_capacity(16 * 1024);
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    encoder
        .write_image(resized.as_raw(), width, height, ExtendedColorType::Rgba8)
        .map_err(|_| ERR_ENCODE.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Paths and marker
// ---------------------------------------------------------------------------

fn icons_dir() -> Result<PathBuf, String> {
    let base = crate::paths::data_dir().ok_or_else(|| ERR_PATH.to_string())?;
    Ok(base.join("icons"))
}

fn active_ico_path() -> Result<PathBuf, String> {
    Ok(icons_dir()?.join("active.ico"))
}

fn marker_path() -> Result<PathBuf, String> {
    Ok(icons_dir()?.join("state.json"))
}

fn read_marker() -> Option<DesktopIconMarker> {
    let path = marker_path().ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_marker(marker: &DesktopIconMarker) -> Result<(), String> {
    let path = marker_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| ERR_PATH.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(marker).map_err(|_| ERR_PATH.to_string())?;
    write_atomic(&path, &bytes)
}

/// Write through a temporary file so a crash never leaves a half-written icon.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| ERR_PATH.to_string())?;
    }
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).map_err(|_| ERR_PATH.to_string())?;
    std::fs::rename(&temp, path).map_err(|_| ERR_PATH.to_string())
}

// ---------------------------------------------------------------------------
// Shortcut scan (platform independent part)
// ---------------------------------------------------------------------------

fn platform_supported() -> bool {
    cfg!(target_os = "windows")
}

/// Directories that may hold a Moyu shortcut.
fn shortcut_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(desktop) = dirs::desktop_dir() {
        roots.push(desktop);
    }
    if let Some(roaming) = dirs::data_dir() {
        roots.push(
            roaming
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    roots
}

/// Is this shortcut one of ours? The installer names it after the product.
fn is_moyu_shortcut(path: &Path) -> bool {
    let is_link = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase() == "lnk")
        .unwrap_or(false);
    if !is_link {
        return false;
    }
    let Some(stem) = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_lowercase())
    else {
        return false;
    };
    SHORTCUT_STEMS.iter().any(|needle| stem.contains(needle))
}

fn collect_shortcuts(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > SHORTCUT_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_shortcuts(&path, depth + 1, out);
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if is_moyu_shortcut(&path) {
            out.push(path);
        }
    }
}

/// Every Moyu shortcut the scan can see.
fn scan_shortcuts() -> Vec<DesktopIconShortcut> {
    let mut found: Vec<PathBuf> = Vec::new();
    for root in shortcut_roots() {
        collect_shortcuts(&root, 0, &mut found);
    }
    found.sort();
    found.dedup();
    found
        .into_iter()
        .map(|path| DesktopIconShortcut {
            path: path.to_string_lossy().to_string(),
            updated: false,
            error: String::new(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn apply_shortcuts(ico_path: &Path) -> Result<(), String> {
    let mut shortcuts = scan_shortcuts();
    if shortcuts.is_empty() {
        return Ok(());
    }
    for shortcut in shortcuts.iter_mut() {
        match crate::desktop_icon::windows_impl::set_shortcut_icon(
            Path::new(&shortcut.path),
            ico_path,
        ) {
            Ok(()) => shortcut.updated = true,
            Err(code) => shortcut.error = code,
        }
    }
    crate::desktop_icon::windows_impl::notify_shell();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_shortcuts(_ico_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn reset_shortcuts() -> Result<(), String> {
    let Ok(exe) = std::env::current_exe() else {
        return Ok(());
    };
    for shortcut in scan_shortcuts() {
        let _ =
            crate::desktop_icon::windows_impl::set_shortcut_icon(Path::new(&shortcut.path), &exe);
    }
    crate::desktop_icon::windows_impl::notify_shell();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn reset_shortcuts() -> Result<(), String> {
    Ok(())
}

/// Push the icon to the running window (taskbar) and the tray.
fn apply_runtime_icon(app: &tauri::AppHandle, png: &[u8]) {
    let Ok(image) = tauri::image::Image::from_bytes(png) else {
        crate::logging::log_error("desktop-icon", "窗口图标解码失败");
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.set_icon(image.clone()) {
            crate::logging::log_error("desktop-icon", &format!("窗口图标设置失败：{error}"));
        }
    }
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
        if let Err(error) = tray.set_icon(Some(image)) {
            crate::logging::log_error("desktop-icon", &format!("托盘图标设置失败：{error}"));
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::ERR_COM;
    use std::path::Path;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{
        IShellLinkW, SHChangeNotify, ShellLink, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };

    /// NUL-terminated UTF-16 path for the Win32 wide APIs.
    fn wide(path: &Path) -> Vec<u16> {
        path.to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Point one `.lnk` at `icon_path` (index 0 = the first icon resource).
    ///
    /// The COM apartment is initialized per call and torn down right after,
    /// so the shortcut files are never touched from a foreign thread.
    pub(super) fn set_shortcut_icon(lnk: &Path, icon_path: &Path) -> Result<(), String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            // S_OK / S_FALSE both mean "this thread now owns an apartment";
            // RPC_E_CHANGED_MODE means it already had one in another mode and
            // must not be uninitialized by us.
            let owns_apartment = hr.is_ok();
            let result = set_shortcut_icon_inner(lnk, icon_path);
            if owns_apartment {
                CoUninitialize();
            }
            result
        }
    }

    unsafe fn set_shortcut_icon_inner(lnk: &Path, icon_path: &Path) -> Result<(), String> {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| ERR_COM.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|_| ERR_COM.to_string())?;
        let lnk_wide = wide(lnk);
        persist
            .Load(PCWSTR(lnk_wide.as_ptr()), STGM_READ)
            .map_err(|_| ERR_COM.to_string())?;
        let icon_wide = wide(icon_path);
        link.SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0)
            .map_err(|_| ERR_COM.to_string())?;
        persist
            .Save(PCWSTR(lnk_wide.as_ptr()), true)
            .map_err(|_| ERR_COM.to_string())?;
        Ok(())
    }

    /// Force Explorer to drop its cached icon and repaint the desktop.
    pub(super) fn notify_shell() {
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn sample_png(size: u32) -> Vec<u8> {
        let image = RgbaImage::from_pixel(size, size, Rgba([56, 168, 248, 255]));
        let mut out: Vec<u8> = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        encoder
            .write_image(image.as_raw(), size, size, ExtendedColorType::Rgba8)
            .expect("png");
        out
    }

    #[test]
    fn rejects_payload_over_two_mebibytes() {
        let payload = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(vec![0u8; MAX_ICON_BYTES + 1])
        );
        assert_eq!(decode_data_url(&payload).unwrap_err(), ERR_TOO_LARGE);
    }

    #[test]
    fn rejects_non_image_payload() {
        let payload = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"not an image at all")
        );
        // data URL 本身合法，魔术字节校验发生在解码阶段。
        let bytes = decode_data_url(&payload).expect("base64 payload");
        assert_eq!(decode_image(&bytes).unwrap_err(), ERR_UNSUPPORTED);
    }

    #[test]
    fn rejects_empty_payload() {
        let payload = "data:image/png;base64,".to_string();
        assert_eq!(decode_data_url(&payload).unwrap_err(), ERR_EMPTY);
    }

    #[test]
    fn accepts_png_payload() {
        let payload = format!("data:image/png;base64,{}", STANDARD.encode(sample_png(8)));
        let bytes = decode_data_url(&payload).expect("valid png");
        let image = decode_image(&bytes).expect("decodes");
        assert_eq!(image.width(), 8);
    }

    #[test]
    fn encodes_four_icon_layers() {
        let image = decode_image(&sample_png(64)).expect("decodes");
        let ico = encode_ico(&image).expect("encodes");
        // ICONDIR: reserved(2) + type(2) + count(2), then one 16-byte entry
        // per layer with the width/height bytes at offset 6 / 7.
        assert_eq!(&ico[0..2], &[0, 0]);
        assert_eq!(&ico[2..4], &[1, 0]);
        assert_eq!(&ico[4..6], &[4, 0]);
        let widths: Vec<u8> = (0..4).map(|index| ico[6 + index * 16]).collect();
        assert_eq!(widths, vec![16, 32, 48, 0]);
    }

    #[test]
    fn shortcut_stem_matching() {
        assert!(is_moyu_shortcut(Path::new(r"C:\Users\x\Desktop\Moyu.lnk")));
        assert!(is_moyu_shortcut(Path::new(
            r"C:\Users\x\Desktop\mangareader.lnk"
        )));
        assert!(!is_moyu_shortcut(Path::new(
            r"C:\Users\x\Desktop\Other.lnk"
        )));
        assert!(!is_moyu_shortcut(Path::new(r"C:\Users\x\Desktop\Moyu.txt")));
    }
}
