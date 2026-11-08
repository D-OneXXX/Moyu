//! System tray: background keep-alive, LAN quick toggle and window restore.
//!
//! The tray is created once in `setup` (after the DB and the Web Access runtime
//! exist). Every state emission from the runtime refreshes the menu/tooltip, so
//! the tray never polls. Menu labels follow the persisted UI locale; the
//! frontend calls [`tray_set_locale`] on mount and whenever the user switches
//! language. Quitting from the tray stops the listener/sessions, checkpoints
//! WAL and exits with the regular exit path.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use base64::Engine as _;

use crate::state::AppState;
use crate::web_access::{StopReason, WebAccessRuntime, WebAccessStatusView};

pub(crate) const TRAY_ID: &str = "moyu-tray";
const MENU_STATUS: &str = "moyu-tray-status";
const MENU_TOGGLE: &str = "moyu-tray-toggle";
const MENU_SHOW: &str = "moyu-tray-show";
const MENU_QUIT: &str = "moyu-tray-quit";

/// Payload-free? No: carries a backend error string with its stable code so
/// the settings page can localize it and show a toast.
pub(crate) const TRAY_ERROR_EVENT: &str = "web-access-tray-error";
/// Persisted UI locale used to build the native menu before the webview loads.
const TRAY_LOCALE_KEY: &str = "tray_locale";

static EXITING: AtomicBool = AtomicBool::new(false);

fn last_status() -> &'static Mutex<Option<WebAccessStatusView>> {
    static SLOT: OnceLock<Mutex<Option<WebAccessStatusView>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn locale_slot() -> &'static Mutex<String> {
    static SLOT: OnceLock<Mutex<String>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new("zh-CN".to_owned()))
}

/// True once the user chose "quit" from the tray; the close interceptor must
/// never hide the window at that point.
pub(crate) fn is_exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

/// Whether the tray icon actually exists. When tray initialization failed
/// (e.g. a Linux desktop without a tray host), hiding the window would strand
/// the app with no way back, so the close interceptor must not run.
pub(crate) fn is_available<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

struct TrayStrings {
    running: &'static str,
    stopped: &'static str,
    enable: &'static str,
    disable: &'static str,
    show: &'static str,
    quit: &'static str,
}

fn strings(locale: &str) -> TrayStrings {
    match locale {
        "zh-CN" => TrayStrings {
            running: "局域网阅读：运行中",
            stopped: "局域网阅读：已关闭",
            enable: "开启局域网远程阅读",
            disable: "关闭局域网远程阅读",
            show: "显示 Moyu 主界面",
            quit: "彻底退出 Moyu",
        },
        "zh-TW" => TrayStrings {
            running: "區域網路閱讀：執行中",
            stopped: "區域網路閱讀：已關閉",
            enable: "開啟區域網路遠端閱讀",
            disable: "關閉區域網路遠端閱讀",
            show: "顯示 Moyu 主視窗",
            quit: "徹底結束 Moyu",
        },
        "es" => TrayStrings {
            running: "Lectura LAN: en marcha",
            stopped: "Lectura LAN: desactivada",
            enable: "Activar lectura remota LAN",
            disable: "Desactivar lectura remota LAN",
            show: "Mostrar Moyu",
            quit: "Salir de Moyu",
        },
        "ja" => TrayStrings {
            running: "LAN リーディング：実行中",
            stopped: "LAN リーディング：停止中",
            enable: "LAN リモートリーディングを開始",
            disable: "LAN リモートリーディングを停止",
            show: "Moyu を表示",
            quit: "Moyu を完全に終了",
        },
        "ko" => TrayStrings {
            running: "LAN 읽기: 실행 중",
            stopped: "LAN 읽기: 꺼짐",
            enable: "LAN 원격 읽기 켜기",
            disable: "LAN 원격 읽기 끄기",
            show: "Moyu 창 열기",
            quit: "Moyu 완전히 종료",
        },
        // `en` plus any unknown locale.
        _ => TrayStrings {
            running: "LAN reading: running",
            stopped: "LAN reading: off",
            enable: "Start LAN remote reading",
            disable: "Stop LAN remote reading",
            show: "Show Moyu",
            quit: "Quit Moyu",
        },
    }
}

fn normalize_locale(raw: Option<&str>) -> &'static str {
    let Some(raw) = raw else {
        return "zh-CN";
    };
    let normalized = raw.replace('_', "-").to_ascii_lowercase();
    match normalized.as_str() {
        "" => "zh-CN",
        "zh-cn" | "zh-hans" => "zh-CN",
        "zh-tw" | "zh-hant" => "zh-TW",
        "en" | "en-us" | "en-gb" => "en",
        "es" | "es-es" => "es",
        "ja" | "ja-jp" => "ja",
        "ko" | "ko-kr" => "ko",
        _ => "en",
    }
}

fn is_running(status: Option<&WebAccessStatusView>) -> bool {
    matches!(
        status.map(|status| status.phase.as_str()),
        Some("starting") | Some("enabled")
    )
}

fn status_line(locale: &str, status: Option<&WebAccessStatusView>) -> String {
    let strings = strings(locale);
    if !is_running(status) {
        return strings.stopped.to_owned();
    }
    match status.and_then(|status| Some((status.bind_ip.as_deref()?, status.port?))) {
        Some((ip, port)) => format!("{} ({ip}:{port})", strings.running),
        None => strings.running.to_owned(),
    }
}

fn tooltip(locale: &str, status: Option<&WebAccessStatusView>) -> String {
    format!("Moyu · {}", status_line(locale, status))
}

fn current_locale<R: Runtime>(app: &AppHandle<R>) -> String {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return "zh-CN".to_owned();
    };
    let raw = state
        .db
        .with(|conn| crate::db::get_setting(conn, TRAY_LOCALE_KEY).map_err(|e| e.to_string()))
        .ok()
        .flatten();
    normalize_locale(raw.as_deref()).to_owned()
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    locale: &str,
    status: Option<&WebAccessStatusView>,
) -> tauri::Result<Menu<R>> {
    let strings = strings(locale);
    let running = is_running(status);
    let status_item = MenuItem::with_id(
        app,
        MENU_STATUS,
        status_line(locale, status),
        false,
        None::<&str>,
    )?;
    let toggle_item = MenuItem::with_id(
        app,
        MENU_TOGGLE,
        if running {
            strings.disable
        } else {
            strings.enable
        },
        true,
        None::<&str>,
    )?;
    let show_item = MenuItem::with_id(app, MENU_SHOW, strings.show, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, strings.quit, true, None::<&str>)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let items: [&dyn IsMenuItem<R>; 6] = [
        &status_item,
        &first_separator,
        &toggle_item,
        &show_item,
        &second_separator,
        &quit_item,
    ];
    Menu::with_items(app, &items)
}

/// Create the tray once during `setup`. Idempotent: a second call is a no-op
/// because the tray id is already registered.
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    // Locale lookup touches SQLite and custom_icon reads/decodes a user file;
    // prepare both on the blocking pool before creating native menu objects.
    let locale_app = (*app).clone();
    let (locale, custom) =
        tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(move || {
            (current_locale(&locale_app), custom_icon())
        }))
        .unwrap_or_else(|_| ("zh-CN".to_owned(), None));
    if let Ok(mut slot) = locale_slot().lock() {
        *slot = locale.clone();
    }
    let menu = build_menu(app, &locale, None)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip(&locale, None))
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // Task 7 hook: a user-selected Moyu icon is written to
    // `<data>/brand/icon.png`; fall back to the bundled window icon.
    if let Some(icon) = custom {
        builder = builder.icon(icon);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    // Dropping the last handle removes the icon; keep it owned by the app.
    app.manage(tray);
    Ok(())
}

fn custom_icon() -> Option<tauri::image::Image<'static>> {
    let root = crate::paths::data_dir()?;
    for relative in ["brand/icon.png", "brand/tray.png"] {
        let path = root.join(relative);
        if path.is_file() {
            if let Ok(image) = tauri::image::Image::from_path(&path) {
                return Some(image);
            }
        }
    }
    None
}

/// Decode the 64×64 PNG produced by the webview. Never returns raw bytes to
/// the caller; invalid payloads are log-only and keep the previous icon.
fn decode_tray_png(raw: &str) -> Result<tauri::image::Image<'static>, &'static str> {
    const PREFIX: &str = "data:image/png;base64,";
    const MAX_BYTES: usize = 512 * 1024;
    let payload = raw.strip_prefix(PREFIX).ok_or("tray-icon-invalid")?;
    if payload.len() > MAX_BYTES {
        return Err("tray-icon-too-large");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "tray-icon-invalid")?;
    tauri::image::Image::from_bytes(&bytes).map_err(|_| "tray-icon-invalid")
}

/// Apply the Task 7 brand icon (preset or custom upload) to the tray.
///
/// Task 7 keeps the preference in `localStorage`, so the main window rasterizes
/// the live SVG/image and pushes PNG here. Best-effort: a missing tray or a bad
/// payload only logs, it never surfaces a user-facing error.
#[tauri::command]
pub(crate) async fn tray_set_icon(app: AppHandle, data_url: Option<String>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let Some(raw) = data_url else {
        if let Some(icon) = app.default_window_icon() {
            let _ = tray.set_icon(Some(icon.clone()));
        }
        return;
    };
    match tauri::async_runtime::spawn_blocking(move || decode_tray_png(&raw)).await {
        Ok(Ok(image)) => {
            if let Err(error) = tray.set_icon(Some(image)) {
                crate::logging::log_error("tray", &format!("托盘图标设置失败：{error}"));
            }
        }
        Ok(Err(code)) => {
            crate::logging::log_error("tray", &format!("托盘图标无效（{code}）"));
        }
        Err(_) => {
            crate::logging::log_error("tray", "托盘图标解码任务失败");
        }
    }
}

/// Refresh menu text/tooltip from the latest runtime snapshot. Called from the
/// event sink on every state change and after a locale switch.
pub(crate) fn apply_status<R: Runtime>(app: &AppHandle<R>, status: &WebAccessStatusView) {
    match last_status().lock() {
        Ok(mut slot) => *slot = Some(status.clone()),
        Err(poisoned) => *poisoned.into_inner() = Some(status.clone()),
    }
    refresh_menu(app);
}

pub(crate) fn refresh_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let locale = locale_slot()
        .lock()
        .map(|locale| locale.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
    let status = match last_status().lock() {
        Ok(slot) => slot.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    if let Ok(menu) = build_menu(app, &locale, status.as_ref()) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(tooltip(&locale, status.as_ref())));
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_TOGGLE => toggle_service(app),
        MENU_SHOW => show_main(app),
        MENU_QUIT => quit(app),
        _ => {}
    }
}

pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_service<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(runtime) = app.try_state::<Arc<WebAccessRuntime>>() else {
            return;
        };
        let runtime = runtime.inner().clone();
        if runtime.is_running_snapshot() {
            runtime.stop(StopReason::Stopped).await;
            return;
        }
        // The tray is a second entry point: the feature switch must gate it
        // exactly like `web_access_start` does, otherwise a disabled feature
        // could still bind a LAN listener.
        let enabled = app
            .try_state::<Arc<AppState>>()
            .map(|state| crate::features::FeatureId::WebAccess.get(&state.settings.lock().features))
            .unwrap_or(false);
        if !enabled {
            emit_error(&app, "feature-disabled");
            show_main(&app);
            return;
        }
        let ip = runtime.addresses().ok().and_then(|addresses| {
            addresses
                .first()
                .and_then(|a| a.ip.parse::<Ipv4Addr>().ok())
        });
        let Some(ip) = ip else {
            emit_error(&app, "web-access-no-lan-address");
            show_main(&app);
            return;
        };
        if let Err(error) = runtime.start(ip, 0).await {
            emit_error(&app, error.code());
            show_main(&app);
        }
    });
}

fn emit_error<R: Runtime>(app: &AppHandle<R>, code: &str) {
    // The frontend parses the trailing `（code）` with localizeBackendError.
    let _ = app.emit_to("main", TRAY_ERROR_EVENT, format!("（{code}）"));
}

fn quit<R: Runtime>(app: &AppHandle<R>) {
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(runtime) = app.try_state::<Arc<WebAccessRuntime>>() {
            // Stops the TLS/HTTP listener, cancels claims and revokes sessions.
            runtime.inner().clone().stop(StopReason::Exit).await;
        }
        if let Some(state) = app.try_state::<Arc<AppState>>() {
            let state = state.inner().clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = state.db.with(|conn| {
                    crate::db::wal_checkpoint(conn).map_err(|error| error.to_string())
                });
            })
            .await;
        }
        app.exit(0);
    });
}

/// Persist and apply the UI locale (called by the frontend i18n provider).
#[tauri::command]
pub(crate) async fn tray_set_locale(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    locale: String,
) -> Result<(), String> {
    let normalized = normalize_locale(Some(&locale)).to_owned();
    let state = state.inner().clone();
    let stored = normalized.clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.db.with(|conn| {
            crate::db::set_setting(conn, TRAY_LOCALE_KEY, &stored).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|_| "托盘语言设置失败（blocking-task-failed）".to_string())??;
    if let Ok(mut slot) = locale_slot().lock() {
        *slot = normalized.clone();
    }
    refresh_menu(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_normalization_covers_the_six_dictionaries() {
        assert_eq!(normalize_locale(None), "zh-CN");
        assert_eq!(normalize_locale(Some("zh_CN")), "zh-CN");
        assert_eq!(normalize_locale(Some("zh-Hant")), "zh-TW");
        assert_eq!(normalize_locale(Some("en-US")), "en");
        assert_eq!(normalize_locale(Some("es")), "es");
        assert_eq!(normalize_locale(Some("ja-JP")), "ja");
        assert_eq!(normalize_locale(Some("ko-KR")), "ko");
        // Unknown locales fall back to English, never to a missing dictionary.
        assert_eq!(normalize_locale(Some("fr-FR")), "en");
    }

    #[test]
    fn every_locale_has_menu_labels() {
        for locale in ["zh-CN", "zh-TW", "en", "es", "ja", "ko"] {
            let strings = strings(locale);
            assert!(!strings.enable.is_empty());
            assert!(!strings.disable.is_empty());
            assert!(!strings.show.is_empty());
            assert!(!strings.quit.is_empty());
            assert!(tooltip(locale, None).starts_with("Moyu"));
        }
    }
}
