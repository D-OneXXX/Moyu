//! 通用内嵌浏览器窗口与下载导入。

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::TimeZone;
use tauri::utils::config::WebviewUrl;
use tauri::webview::{DownloadEvent, PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::commands;
use crate::db;
use crate::AppState;

const BROWSER_LABEL: &str = "browser";

/// 关闭辅助浏览器窗；窗口不存在时静默忽略。
pub(crate) fn close_browser_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(BROWSER_LABEL) {
        let _ = window.close();
    }
}
const BROWSER_TITLE: &str = "Moyu 浏览器";
const BROWSER_WIDTH: f64 = 1200.0;
const BROWSER_HEIGHT: f64 = 820.0;
const TOOLBAR_LOCALE_KEY: &str = "tray_locale";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolbarLabels {
    label: &'static str,
    back: &'static str,
    forward: &'static str,
    reload: &'static str,
    import_page: &'static str,
    importing: &'static str,
    inactive: &'static str,
    empty: &'static str,
    imported: &'static str,
    failed: &'static str,
}

fn toolbar_labels(locale: &str) -> ToolbarLabels {
    match locale.trim().to_ascii_lowercase().as_str() {
        "zh-tw" => ToolbarLabels {
            label: "Moyu 交接",
            back: "後退",
            forward: "前進",
            reload: "重新整理",
            import_page: "匯入目前頁",
            importing: "匯入中…",
            inactive: "尚未啟動交接",
            empty: "目前視窗沒有已載入圖片",
            imported: "已匯入 {n} 章",
            failed: "匯入失敗",
        },
        "en" => ToolbarLabels {
            label: "Moyu handoff",
            back: "Back",
            forward: "Forward",
            reload: "Reload",
            import_page: "Import current page",
            importing: "Importing…",
            inactive: "Handoff not started",
            empty: "No loaded images in viewport",
            imported: "Imported {n} chapter(s)",
            failed: "Import failed",
        },
        "es" => ToolbarLabels {
            label: "Moyu handoff",
            back: "Atrás",
            forward: "Adelante",
            reload: "Recargar",
            import_page: "Importar página actual",
            importing: "Importando…",
            inactive: "Handoff no iniciado",
            empty: "No hay imágenes cargadas en la vista",
            imported: "Importados {n} capítulo(s)",
            failed: "Error al importar",
        },
        "ja" => ToolbarLabels {
            label: "Moyu ハンドオフ",
            back: "戻る",
            forward: "進む",
            reload: "再読み込み",
            import_page: "現在のページを取込",
            importing: "取込中…",
            inactive: "ハンドオフ未開始",
            empty: "表示中の読み込み済み画像がありません",
            imported: "{n} 章を取込しました",
            failed: "取込に失敗",
        },
        "ko" => ToolbarLabels {
            label: "Moyu 핸드오프",
            back: "뒤로",
            forward: "앞으로",
            reload: "새로고침",
            import_page: "현재 페이지 가져오기",
            importing: "가져오는 중…",
            inactive: "핸드오프가 시작되지 않음",
            empty: "뷰포트에 로드된 이미지가 없습니다",
            imported: "{n}개 장을 가져왔습니다",
            failed: "가져오기 실패",
        },
        _ => ToolbarLabels {
            label: "Moyu 交接",
            back: "后退",
            forward: "前进",
            reload: "刷新",
            import_page: "导入当前页",
            importing: "导入中…",
            inactive: "尚未启动交接",
            empty: "当前视口没有已加载图片",
            imported: "已导入 {n} 章",
            failed: "导入失败",
        },
    }
}

fn toolbar_locale(state: &AppState) -> String {
    state
        .db
        .with(|conn| crate::db::get_setting(conn, TOOLBAR_LOCALE_KEY).map_err(|e| e.to_string()))
        .ok()
        .flatten()
        .unwrap_or_else(|| "zh-CN".into())
}

const TOOLBAR_TEMPLATE: &str = r##"
(function () {
  if (window.top !== window) return;
  if (!/^https?:$/.test(location.protocol)) return;
  var config = __CONFIG__;
  var previous = document.getElementById('moyu-handoff-bar');
  if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
  var collect = function () {
    var pages = [];
    var seen = new Set();
    var viewportWidth = window.innerWidth || 0;
    var viewportHeight = window.innerHeight || 0;
    var images = document.querySelectorAll('img');
    for (var index = 0; index < images.length; index += 1) {
      var image = images[index];
      if (!image || !image.complete || image.naturalWidth <= 0) continue;
      // 与后端默认正文尺寸门槛对齐，排除视口内的 logo/头像/横幅/二维码。
      if (image.naturalWidth < 320 || image.naturalHeight < 240) continue;
      var rect = image.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > viewportHeight || rect.left > viewportWidth) continue;
      var candidates = [
        image.currentSrc,
        image.getAttribute('src'),
        image.getAttribute('data-src'),
        image.getAttribute('data-original')
      ];
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var raw = candidates[candidateIndex];
        if (!raw) continue;
        try {
          var url = new URL(raw, location.href);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
          if (!seen.has(url.href)) {
            seen.add(url.href);
            pages.push(url.href);
          }
          break;
        } catch (_) {}
      }
    }
    return pages;
  };
  var install = function () {
    if (!document.documentElement || document.getElementById('moyu-handoff-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'moyu-handoff-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', config.labels.label);
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;background:rgba(11,17,30,0.94);color:#F8FAFC;font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;border-bottom:1px solid rgba(56,168,248,0.75);direction:ltr;';
    var brand = document.createElement('span');
    brand.textContent = config.labels.label;
    brand.style.cssText = 'font-weight:700;color:#38A8F8;white-space:nowrap;';
    bar.appendChild(brand);
    var makeButton = function (text, handler) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.style.cssText = 'appearance:none;border:1px solid rgba(248,250,252,0.35);background:transparent;color:#F8FAFC;border-radius:999px;padding:2px 9px;font:inherit;cursor:pointer;white-space:nowrap;';
      button.addEventListener('click', function (event) {
        if (!event.isTrusted) return;
        return handler(event);
      });
      return button;
    };
    bar.appendChild(makeButton(config.labels.back, function () { history.back(); }));
    bar.appendChild(makeButton(config.labels.forward, function () { history.forward(); }));
    bar.appendChild(makeButton(config.labels.reload, function () { location.reload(); }));
    var status = document.createElement('span');
    status.setAttribute('data-moyu-status', '1');
    status.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#CBD5E1;';
    status.textContent = config.callbackUrl ? '' : config.labels.inactive;
    bar.appendChild(status);
    var importButton = makeButton(config.labels.importPage, async function () {
      if (!config.callbackUrl) {
        status.textContent = config.labels.inactive;
        return;
      }
      var pages = collect();
      if (!pages.length) {
        status.textContent = config.labels.empty;
        return;
      }
      status.textContent = config.labels.importing;
      try {
        var response = await fetch(config.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chapters: [{
              url: location.href,
              title: document.title || location.href,
              pages: pages
            }],
            origin: location.origin,
            userAgent: navigator.userAgent
          })
        });
        if (!response.ok) {
          status.textContent = config.labels.failed + ' (' + response.status + ')';
          return;
        }
        var data = {};
        try { data = await response.json(); } catch (_) {}
        var count = data && Array.isArray(data.books) ? data.books.length : 1;
        status.textContent = config.labels.imported.replace('{n}', String(count));
      } catch (_) {
        status.textContent = config.labels.failed;
      }
    });
    importButton.style.borderColor = config.callbackUrl ? 'rgba(56,168,248,0.95)' : 'rgba(148,163,184,0.4)';
    importButton.style.background = config.callbackUrl ? '#38A8F8' : 'transparent';
    importButton.style.color = config.callbackUrl ? '#08111F' : '#94A3B8';
    importButton.style.fontWeight = '700';
    importButton.setAttribute('data-moyu-import', '1');
    importButton.disabled = !config.callbackUrl;
    bar.appendChild(importButton);
    document.documentElement.appendChild(bar);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
"##;

fn build_toolbar_script(callback_url: &str, labels: &ToolbarLabels) -> String {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ToolbarConfig<'a> {
        callback_url: &'a str,
        labels: &'a ToolbarLabels,
    }
    let config = serde_json::to_string(&ToolbarConfig {
        callback_url,
        labels,
    })
    .unwrap_or_else(|_| "{\"callbackUrl\":\"\",\"labels\":{}}".into());
    TOOLBAR_TEMPLATE.replace("__CONFIG__", &config)
}

/// 下载文件名长度上限（保留扩展名后按字符截断）。
const MAX_DOWNLOAD_FILENAME_CHARS: usize = 120;
const MAX_DOWNLOAD_EXTENSION_CHARS: usize = 16;
static DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserDownload {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: String,
    pub imported: bool,
}

fn validate_browser_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅支持 http/https URL".into());
    }
    Ok(url)
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

fn clean_filename_part(part: &str) -> String {
    part.chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        .collect()
}

fn sanitize_download_filename(raw: &str) -> String {
    let (stem, ext) = split_extension(raw.trim());
    let mut stem = clean_filename_part(stem)
        .trim_matches(|c| c == ' ' || c == '.')
        .to_string();
    let ext: String = clean_filename_part(ext)
        .trim_matches(|c| c == ' ' || c == '.')
        .chars()
        .take(MAX_DOWNLOAD_EXTENSION_CHARS)
        .collect();
    if stem.is_empty() {
        stem = "download".into();
    }
    let suffix = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let max_stem = MAX_DOWNLOAD_FILENAME_CHARS
        .saturating_sub(suffix.chars().count())
        .max(1);
    let mut stem: String = stem.chars().take(max_stem).collect();
    stem = stem.trim_end_matches([' ', '.']).to_string();
    if stem.is_empty() {
        stem = "download".into();
    }
    format!("{stem}{suffix}")
}

fn unique_download_path(dir: &Path, filename: &str) -> PathBuf {
    let (stem, ext) = split_extension(filename);
    let sequence = DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // The WebView download callback must synchronously provide a destination.
    // Use a process-local sequence and randomized suffix instead of filesystem
    // existence probes on that callback thread. This avoids callback-thread IO;
    // the WebView API does not provide an asynchronous destination reservation.
    let mut nonce = String::with_capacity(64);
    for round in 0..4u8 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        hasher.write_u128(timestamp);
        hasher.write_u64(sequence);
        hasher.write_u8(round);
        nonce.push_str(&format!("{:016x}", hasher.finish()));
    }
    let unique_suffix = format!("-{nonce}");
    let extension = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let max_stem = MAX_DOWNLOAD_FILENAME_CHARS
        .saturating_sub(unique_suffix.chars().count() + extension.chars().count())
        .max(1);
    let stem: String = stem.chars().take(max_stem).collect();
    dir.join(format!("{stem}{unique_suffix}{extension}"))
}

fn url_download_name(url: &Url) -> Option<String> {
    let last = url.path_segments()?.rfind(|segment| !segment.is_empty())?;
    Some(
        percent_encoding::percent_decode_str(last)
            .decode_utf8_lossy()
            .to_string(),
    )
}

fn prepare_download_destination(downloads_dir: &Path, url: &Url, suggested: &Path) -> PathBuf {
    let raw = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .or_else(|| url_download_name(url))
        .unwrap_or_else(|| "download".into());
    unique_download_path(downloads_dir, &sanitize_download_filename(&raw))
}

fn is_importable_download(path: &Path) -> bool {
    crate::source::is_archive_path(path)
        || crate::archive_convert::is_convertible_archive_path(path)
}

fn simplify_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn normalize_existing_path(path: &Path) -> Result<PathBuf, std::io::Error> {
    Ok(simplify_path(std::fs::canonicalize(path)?))
}

fn is_within(root: &Path, path: &Path) -> bool {
    match (normalize_existing_path(root), normalize_existing_path(path)) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

fn downloads_dir() -> Result<PathBuf, String> {
    let dir = crate::data_dir()?.join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    normalize_existing_path(&dir).map_err(|e| format!("定位下载目录失败：{e}"))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDownloadEvent {
    path: String,
    name: String,
    imported: bool,
    book_id: Option<String>,
}

fn finish_download(app: AppHandle, path: PathBuf) {
    let path = normalize_existing_path(&path).unwrap_or(path);
    let within_downloads = downloads_dir()
        .ok()
        .is_some_and(|dir| is_within(&dir, &path));
    let (imported, display_path) = if within_downloads && is_importable_download(&path) {
        let db_path = app.state::<Arc<AppState>>().db_path();
        match commands::import_local_archive_prepared(db_path, &path) {
            Ok(Some((book_id, prepared))) => {
                if let Err(e) = commands::set_file_readonly(&prepared) {
                    crate::logging::log_error(
                        "browser_import",
                        &format!("设置下载文件只读失败：{e}"),
                    );
                }
                (Some(book_id), prepared)
            }
            Ok(None) => (None, path),
            Err(e) => {
                crate::logging::log_error("browser_import", &format!("导入下载失败：{e}"));
                (None, path)
            }
        }
    } else {
        (None, path)
    };

    let name = display_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_string();
    let payload = BrowserDownloadEvent {
        path: display_path.to_string_lossy().to_string(),
        name,
        imported: imported.is_some(),
        book_id: imported,
    };
    if let Err(e) = app.emit_to("main", "browser-download", &payload) {
        crate::logging::log_error("browser_download", &format!("发送下载事件失败：{e}"));
    }
}

fn handle_download_event(app: &AppHandle, downloads: &Path, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            *destination = prepare_download_destination(downloads, &url, destination);
            true
        }
        DownloadEvent::Finished {
            path: Some(path),
            success: true,
            ..
        } => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || finish_download(app, path));
            true
        }
        _ => true,
    }
}

/// 浏览器窗导航白名单：只允许 http/https，且**禁止跳回应用自身的本地源**。
///
/// 内嵌浏览器加载的是远程页面；一旦远程页自跳到 `tauri.localhost`（或开发态的
/// `localhost:1420`），它就会变成「本地 Origin」，从而可能拿到该窗口的本地能力。
/// 这里在导航层直接拦掉，避免远程页借导航提权。
fn navigation_allowed(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "tauri.localhost" || host.ends_with(".tauri.localhost") {
        return false;
    }
    // 开发态应用源（Vite dev server）同样禁止：远程页跳到它就等于拿到应用 Origin。
    if (host == "localhost" || host == "127.0.0.1" || host == "[::1]") && url.port() == Some(1420) {
        return false;
    }
    true
}

#[tauri::command]
pub async fn open_browser_window(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<(), String> {
    crate::resilience::ensure_online_allowed().await?;
    crate::features::ensure_enabled(
        &state.settings.lock().features,
        crate::features::FeatureId::Browser,
    )?;
    let url = validate_browser_url(&url)?;
    let callback = state
        .handoff_status()
        .map(|status| status.callback_url)
        .unwrap_or_default();
    let labels = toolbar_labels(&toolbar_locale(&state));
    let toolbar = build_toolbar_script(&callback, &labels);
    let downloads = commands::blocking(|| {
        downloads_dir().map_err(|error| crate::source::BackendError::Msg(error.to_string()))
    })
    .await?;
    if let Some(window) = app.get_webview_window(BROWSER_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        window.navigate(url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // WebView 构建不能占住 async IPC 线程/主事件循环；移到阻塞池。
    tauri::async_runtime::spawn_blocking(move || {
        let download_app = app.clone();
        let download_dir = downloads;
        let load_app = app.clone();
        WebviewWindowBuilder::new(&app, BROWSER_LABEL, WebviewUrl::External(url))
            .title(BROWSER_TITLE)
            .inner_size(BROWSER_WIDTH, BROWSER_HEIGHT)
            // §4.3：辅助浏览器只服务当次人工验证，不持久化第三方 Cookie
            // 或站点存储；关闭窗口即丢弃，避免下次启动复用上一站凭据。
            .incognito(true)
            // 顶部交接条只读 DOM 图片地址并经 127.0.0.1 handoff 回传；
            // 不暴露 Tauri IPC，不读取 Cookie。
            .initialization_script(toolbar)
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let state = load_app.state::<Arc<AppState>>();
                    let callback = state
                        .handoff_status()
                        .map(|status| status.callback_url)
                        .unwrap_or_default();
                    let labels = toolbar_labels(&toolbar_locale(&state));
                    let _ = window.eval(build_toolbar_script(&callback, &labels));
                }
            })
            .on_download(move |_webview, event| {
                handle_download_event(&download_app, &download_dir, event)
            })
            .on_navigation(navigation_allowed)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "浏览器窗口任务失败（blocking-task-failed）".to_string())?
}

/// Handoff 启停后刷新辅助浏览器顶部条（窗口不存在时静默成功）。
#[tauri::command]
pub async fn sync_browser_toolbar(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(BROWSER_LABEL) else {
        return Ok(());
    };
    let callback = state
        .handoff_status()
        .map(|status| status.callback_url)
        .unwrap_or_default();
    let labels = toolbar_labels(&toolbar_locale(&state));
    window
        .eval(build_toolbar_script(&callback, &labels))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn navigate_browser(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<(), String> {
    crate::resilience::ensure_online_allowed().await?;
    crate::features::ensure_enabled(
        &state.settings.lock().features,
        crate::features::FeatureId::Browser,
    )?;
    let url = validate_browser_url(&url)?;
    let window = app
        .get_webview_window(BROWSER_LABEL)
        .ok_or_else(|| "浏览器窗口未打开".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_browser_downloads(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<BrowserDownload>, String> {
    crate::features::ensure_enabled(
        &state.settings.lock().features,
        crate::features::FeatureId::Browser,
    )?;
    let st = state.inner().clone();
    commands::blocking(move || {
        // Downloads directory enumeration and the per-file SQLite lookup both
        // perform synchronous work; keep them off the async runtime together.
        let dir =
            downloads_dir().map_err(|error| crate::source::BackendError::Msg(error.to_string()))?;
        collect_downloads(&dir, |path| {
            let id = db::book_id_for_path(path);
            st.db
                .with(|conn| {
                    db::get_book(conn, &id)
                        .map(|book| book.is_some())
                        .map_err(|error| error.to_string())
                })
                .unwrap_or(false)
        })
        .map_err(|error| crate::source::BackendError::Msg(error.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn import_browser_download(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<Option<String>, String> {
    crate::features::ensure_enabled(
        &state.settings.lock().features,
        crate::features::FeatureId::Browser,
    )?;
    let db_path = state.db_path();
    commands::blocking(move || {
        // Path canonicalization, metadata checks, import, and permissions are
        // all synchronous filesystem operations; keep the full operation on
        // the blocking pool instead of doing path checks before the await.
        let downloads =
            downloads_dir().map_err(|error| crate::source::BackendError::Msg(error.to_string()))?;
        let candidate = normalize_existing_path(Path::new(&path)).map_err(|error| {
            crate::source::BackendError::Msg(format!("下载文件不存在：{error}"))
        })?;
        if !is_within(&downloads, &candidate) || !candidate.is_file() {
            return Err(crate::source::BackendError::Msg(
                "只能导入下载目录中的文件".into(),
            ));
        }
        if !is_importable_download(&candidate) {
            return Ok(None);
        }

        let imported = commands::import_local_archive_prepared(db_path, &candidate)?;
        if let Some((book_id, prepared)) = imported {
            if let Err(error) = commands::set_file_readonly(&prepared) {
                // Paths must not enter logs; the operation remains best-effort.
                crate::logging::log_error(
                    "browser_import",
                    &format!("设置下载文件只读失败：{error}"),
                );
            }
            Ok(Some(book_id))
        } else {
            Ok(None)
        }
    })
    .await
}

fn collect_downloads(
    dir: &Path,
    is_imported: impl Fn(&str) -> bool,
) -> Result<Vec<BrowserDownload>, std::io::Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let metadata = entry.metadata()?;
        let path = path.to_string_lossy().into_owned();
        let modified_secs = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let modified = chrono::Local
            .timestamp_opt(modified_secs as i64, 0)
            .single()
            .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default();
        rows.push((
            modified_secs,
            BrowserDownload {
                imported: is_imported(&path),
                path,
                name: entry.file_name().to_string_lossy().into_owned(),
                size: metadata.len(),
                modified,
            },
        ));
    }
    rows.sort_by(|(a_secs, a), (b_secs, b)| b_secs.cmp(a_secs).then_with(|| a.name.cmp(&b.name)));
    Ok(rows.into_iter().map(|(_, row)| row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn toolbar_script_is_local_bridge_only() {
        let labels = toolbar_labels("en");
        let script = build_toolbar_script("http://127.0.0.1:18080/handoff?token=abcdef", &labels);
        assert!(script.contains("http://127.0.0.1:18080/handoff?token=abcdef"));
        assert!(script.contains("Import current page"));
        assert!(script.contains("event.isTrusted"));
        assert!(script.contains("image.naturalWidth"));
        assert!(script.contains("getBoundingClientRect"));
        assert!(!script.contains("document.cookie"));
        assert!(!script.contains("__TAURI"));
        assert!(!script.contains("ipc"));
    }

    #[test]
    fn toolbar_labels_cover_all_six_locales() {
        assert_eq!(toolbar_labels("zh-CN").back, "后退");
        assert_eq!(toolbar_labels("zh-TW").back, "後退");
        assert_eq!(toolbar_labels("en").back, "Back");
        assert_eq!(toolbar_labels("es").back, "Atrás");
        assert_eq!(toolbar_labels("ja").back, "戻る");
        assert_eq!(toolbar_labels("ko").back, "뒤로");
        assert_eq!(toolbar_labels("unknown").reload, "刷新");
    }

    #[test]
    fn navigation_blocks_app_local_origins_and_non_http() {
        for raw in [
            "http://tauri.localhost/index.html",
            "https://sub.tauri.localhost/x",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
            "file:///c:/windows/system32/calc.exe",
            "tauri://localhost",
            "javascript:alert(1)",
        ] {
            let url = Url::parse(raw).expect("URL 应可解析");
            assert!(!navigation_allowed(&url), "{raw} 必须被拦截");
        }
        for raw in [
            "https://example.com/a",
            "http://127.0.0.1:18080/pair", // 配对桥接的回环页必须放行
        ] {
            let url = Url::parse(raw).expect("URL 应可解析");
            assert!(navigation_allowed(&url), "{raw} 应被放行");
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mr-browser-{}-{tag}-{nanos}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn validates_only_http_and_https() {
        assert!(validate_browser_url("https://example.com/a").is_ok());
        assert!(validate_browser_url(" http://example.com ").is_ok());
        for raw in [
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/a",
            "not a url",
        ] {
            assert!(validate_browser_url(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn sanitizes_separators_controls_and_preserves_extension() {
        assert_eq!(sanitize_download_filename("a/b\\c\x00d?.zip"), "abcd.zip");
        assert_eq!(sanitize_download_filename("book.CBZ"), "book.CBZ");
        assert_eq!(sanitize_download_filename("\x00/\\"), "download");
        assert_eq!(sanitize_download_filename("   "), "download");
    }

    #[test]
    fn limits_length_without_dropping_extension() {
        let raw = format!("{}.cbz", "长".repeat(300));
        let name = sanitize_download_filename(&raw);
        assert!(name.ends_with(".cbz"), "{name}");
        assert!(
            name.chars().count() <= MAX_DOWNLOAD_FILENAME_CHARS,
            "{}",
            name.chars().count()
        );
        let long_extension = sanitize_download_filename(&format!("book.{}", "x".repeat(300)));
        assert!(long_extension.chars().count() <= MAX_DOWNLOAD_FILENAME_CHARS);
    }

    #[test]
    fn destination_is_inside_download_dir_and_preserves_existing_basename() {
        let dir = temp_dir("dest");
        let original = dir.join("book.zip");
        std::fs::write(&original, b"keep").unwrap();

        let url = url::Url::parse("https://example.com/files/book.zip").unwrap();
        let first = prepare_download_destination(
            &dir,
            &url,
            Path::new("C:/Users/alice/Downloads/book.zip"),
        );
        assert!(first.starts_with(&dir));
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("book-"));
        assert!(first.is_absolute());
        assert_eq!(std::fs::read(&original).unwrap(), b"keep");

        std::fs::write(&first, b"one").unwrap();
        let second = prepare_download_destination(
            &dir,
            &url,
            Path::new("C:/Users/alice/Downloads/book.zip"),
        );
        assert_ne!(second, first);
        assert!(second.starts_with(&dir));
        assert_eq!(std::fs::read(&original).unwrap(), b"keep");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn destination_falls_back_to_url_filename() {
        let dir = temp_dir("fallback");
        let url = url::Url::parse("https://example.com/files/fallback.cbz?x=1").unwrap();
        let path = prepare_download_destination(&dir, &url, Path::new(""));
        assert!(path.starts_with(&dir));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("fallback-"));
        assert!(path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cbz")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn routes_zip_cbz_rar_and_cbr_to_import() {
        for name in [
            "a.zip", "a.cbz", "A.ZIP", "A.CBZ", "a.rar", "a.cbr", "A.RAR", "A.CBR",
        ] {
            assert!(is_importable_download(Path::new(name)), "{name}");
        }
        for name in ["a.png", "a.jpg", "a.txt", "a"] {
            assert!(!is_importable_download(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn normalizes_paths_for_containment_checks() {
        let dir = temp_dir("normalize");
        let inside = dir.join("a.zip");
        std::fs::write(&inside, b"zip").unwrap();
        let normalized = normalize_existing_path(&inside).unwrap();
        assert!(normalized.is_absolute());
        #[cfg(windows)]
        assert!(
            !normalized.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            normalized.display()
        );
        assert!(is_within(&dir, &inside));

        let outside_dir = temp_dir("normalize-outside");
        let outside = outside_dir.join("b.zip");
        std::fs::write(&outside, b"zip").unwrap();
        assert!(!is_within(&dir, &outside));

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn collects_downloads_with_import_state() {
        let dir = temp_dir("list");
        std::fs::write(dir.join("a.zip"), b"zip").unwrap();
        std::fs::write(dir.join("b.png"), b"image!").unwrap();

        let rows = collect_downloads(&dir, |path| path.ends_with("a.zip")).unwrap();
        assert_eq!(rows.len(), 2);

        let a = rows.iter().find(|r| r.name == "a.zip").unwrap();
        assert_eq!(a.size, 3);
        assert!(a.imported);
        assert!(!a.modified.is_empty());
        assert!(a.modified.contains('-'), "{}", a.modified);
        assert_eq!(a.path, dir.join("a.zip").to_string_lossy().to_string());

        let b = rows.iter().find(|r| r.name == "b.png").unwrap();
        assert_eq!(b.size, 6);
        assert!(!b.imported);

        std::fs::remove_dir_all(&dir).ok();
    }
}
