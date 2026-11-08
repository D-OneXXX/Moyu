//! MangaReader 后端：书库、阅读、在线直读、更新、隐私与韧性。
//! 前端契约见 `src/lib/tauri.ts`。

mod backup;
mod browser;
pub mod ca;
pub mod cache;
mod cache_health;
mod commands;
pub mod db;
mod desktop_icon;
pub mod diagnostics;
pub mod disk_cache;
mod features;
pub mod logging;
mod online;
mod opds;
mod open_with;
mod paths;
pub mod pdf;
pub mod pipeline;
mod platform;
pub(crate) mod progress_service;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod read_service;
pub mod render_cache;
mod resilience;
mod security;
pub mod skin;
pub mod source;
mod state;
mod system_proxy;
mod tray;
pub mod update;
mod versioning;
pub mod web_access;
pub mod web_contract;
pub use state::AppState;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

// ---------- Data contract (camelCase JSON，与冻结契约一致) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    pub id: String,
    pub title: String,
    pub path: String,
    pub page_count: u32,
    pub current_page: u32,
    /// 最近一次**阅读进度发生变化**的时间（方案 C：与「最近打开」分列）。
    pub updated_at: String,
    /// 最近一次**打开这本书**的时间（方案 C：与「最近阅读进度」分列）。
    pub last_opened_at: String,
    /// 进度修订号：进度每次变化 +1，供未来的乐观并发控制。
    pub progress_rev: i64,
    /// 条漫滚动偏移百分比（0.0..1.0）；-1 = 无条漫阅读记录。
    pub scroll_pct: f64,
    /// local | generic_manga | anime（预留）。
    pub source_type: String,
    /// 书籍来源格式：image（图片目录 / ZIP / CBZ）| pdf（PDF 文档，PDF-1 仅识别与入库，
    /// 尚不能阅读；PDF-2 提供渲染后再开放阅读）。
    pub format: String,
    /// 条漫是否可用：本地 true；在线取决于清单尺寸。
    pub webtoon_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapter_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
    /// 本地书源路径当前已不存在（在线书恒为 false）。前端据此显示
    /// 「文件位置已变更」状态并提供无损重定位，不以崩溃或丢进度处理。
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageEntry {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImage {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    /// 源图原始尺寸（条漫建议/布局用）。
    pub orig_width: u32,
    pub orig_height: u32,
    pub mime: String,
    pub data_url: String,
}

/// PDF 字节分块（PDF-2）：前端 PDF.js 按区间拉取本地 PDF。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfChunk {
    /// PDF 文件总字节数（始终是真实大小，与请求区间无关）。
    pub total: u64,
    /// 本次区间的原始字节（base64，**无** `data:` 前缀）。
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub process_mb: f64,
    pub cache_bytes: u64,
    pub cache_limit_bytes: u64,
    pub cached_pages: usize,
    pub cached_thumbs: usize,
    /// 条漫切片缓存（字节/片数）。
    pub webtoon_bytes: u64,
    pub webtoon_tiles: usize,
    /// 统一磁盘缓存：渲染成品 + 在线原图，二者共用同一软上限。
    pub disk_cache_bytes: u64,
    pub disk_cache_limit_bytes: u64,
    pub render_cache_bytes: u64,
    pub online_cache_bytes: u64,
    /// 本次进程累计派生缓存写入失败次数（诊断可见，首次失败会 toast）。
    pub cache_write_failures: u64,
}

/// 条漫布局数据：单页源图尺寸（header 解析，不解码）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDim {
    pub index: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatDay {
    pub date: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesProgress {
    pub book_id: String,
    pub title: String,
    pub current_page: u32,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub total_books: u32,
    pub reading: u32,
    pub today_pages: u32,
    pub heatmap: Vec<HeatDay>,
    pub series: Vec<SeriesProgress>,
}

/// 逐日逐书阅读页数（趋势堆叠图数据点）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDayPoint {
    pub book_id: String,
    pub date: String,
    pub pages: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub added: usize,
    pub books: Vec<BookInfo>,
    /// 无法读取/损坏的条目；不再只写 stderr。
    #[serde(default)]
    pub errors: Vec<String>,
}

/// 单路径导入结果（status: added=已入库 / restored=恢复(进度保留) / skipped=已在书库中 / failed）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItemResult {
    pub path: String,
    pub status: String,
    pub message: String,
    pub book: Option<BookInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub items: Vec<ImportItemResult>,
    pub added: usize,
    pub restored: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: usize,
    pub deleted_files: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    /// 内存页/缩略图 LRU 预算（MB）。
    pub cache_budget_mb: u32,
    /// 磁盘缓存软上限（MB）：渲染成品 + 在线原图共用。
    pub disk_cache_budget_mb: u32,
    pub library_dir: String,
    /// 可选大功能总开关；关闭 = 前端入口隐藏 + 后端命令拒绝。
    #[serde(default)]
    pub features: features::FeatureFlags,
    /// 在线源 HTTP 代理（空=直连；http/https/socks5）。
    pub online_proxy: String,
    /// 单本在线书页面下载并发（1-8）。
    pub online_concurrency: u32,
    /// 手动请求头：JSON 对象或单行 Cookie；仅用于自建/授权源。
    pub online_headers: String,
    /// 关闭主窗口时隐藏到系统托盘。局域网阅读运行中始终拦截关闭。
    #[serde(default)]
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            cache_budget_mb: 128,
            disk_cache_budget_mb: disk_cache::DEFAULT_DISK_CACHE_MB,
            library_dir: String::new(),
            features: features::FeatureFlags::default(),
            online_proxy: String::new(),
            online_concurrency: 3,
            online_headers: String::new(),
            close_to_tray: false,
        }
    }
}

/// 在线源连通性探测结果（只解析清单，不写库）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineProbe {
    pub ok: bool,
    pub title: String,
    pub page_count: u32,
    pub elapsed_ms: u64,
    pub message: String,
}

/// 从 SQLite `settings` 表恢复持久化设置（无值则保留默认）。
pub(crate) fn hydrate_settings(
    conn: &rusqlite::Connection,
    s: &mut Settings,
) -> Result<(), source::BackendError> {
    let get = |k: &str| db::get_setting(conn, k);
    if let Some(v) = get("theme")? {
        s.theme = v;
    }
    if let Some(v) = get("cache_budget_mb")?.and_then(|v| v.parse::<u32>().ok()) {
        s.cache_budget_mb = v.clamp(16, 2048);
    }
    if let Some(v) = get("disk_cache_budget_mb")?.and_then(|v| v.parse::<u32>().ok()) {
        s.disk_cache_budget_mb = disk_cache::clamp_budget_mb(v);
    }
    if let Some(v) = get("library_dir")? {
        s.library_dir = v;
    }
    if let Some(v) = get("feature_webtoon")? {
        s.features.webtoon = v == "true" || v == "1";
    }
    // 在线直读兼容旧键；新键优先。
    let online = get("feature_online")?;
    let online = match online {
        Some(value) => Some(value),
        None => get("experimental_online")?,
    };
    if let Some(v) = online {
        s.features.online = v == "true" || v == "1";
    }
    for feature in [
        features::FeatureId::Browser,
        features::FeatureId::Pdf,
        features::FeatureId::Opds,
        features::FeatureId::WebAccess,
        features::FeatureId::Updates,
        features::FeatureId::Backup,
        features::FeatureId::Diagnostics,
    ] {
        if let Some(v) = get(feature.key())? {
            feature.set(&mut s.features, v == "true" || v == "1");
        }
    }
    if let Some(v) = get("online_proxy")? {
        s.online_proxy = v;
    }
    if let Some(v) = get("online_concurrency")?.and_then(|v| v.parse::<u32>().ok()) {
        s.online_concurrency = v.clamp(1, 8);
    }
    if let Some(v) = get("online_headers")? {
        s.online_headers = v;
    }
    if let Some(v) = get("close_to_tray")? {
        s.close_to_tray = v == "true" || v == "1";
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupSettingsError {
    Load,
    Normalize,
}

impl StartupSettingsError {
    fn code(self) -> &'static str {
        match self {
            Self::Load => "db-settings-load-failed",
            Self::Normalize => "db-settings-normalize-failed",
        }
    }
}

fn load_normalized_settings(
    conn: &rusqlite::Connection,
    mut settings: Settings,
) -> Result<(Settings, Vec<String>), StartupSettingsError> {
    hydrate_settings(conn, &mut settings).map_err(|_| StartupSettingsError::Load)?;
    let repaired = versioning::normalize_settings(conn, &mut settings)
        .map_err(|_| StartupSettingsError::Normalize)?;
    Ok((settings, repaired))
}

/// 旧版数据根：`%LOCALAPPDATA%\com.local.manga-reader`（仅用于迁移与最终回落）。
fn legacy_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("com.local.manga-reader"))
}

/// `MR_DATA_DIR` 覆盖解析：先 trim，空值视为未设置，只接受绝对路径。
///
/// 相对路径会让书库数据库落到进程 CWD，与日志/缓存根分叉，因此一律忽略。
/// 保持纯函数以便单测；拒绝时的脱敏日志由 [`env_data_dir_override`] 记录。
fn data_dir_override(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Some(path)
    } else {
        None
    }
}

/// 读取并校验 `MR_DATA_DIR`；非空但不是绝对路径时记录脱敏日志后忽略。
///
/// `data_dir()` 与 `install_app_paths()` 必须共用这一解析入口，避免同一
/// 环境变量在两处得出不同的数据根。
fn env_data_dir_override() -> Option<PathBuf> {
    let raw = std::env::var("MR_DATA_DIR").ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    match data_dir_override(&raw) {
        Some(path) => Some(path),
        None => {
            logging::log_error(
                "paths",
                "MR_DATA_DIR 不是绝对路径，已忽略并回落到 app_data_dir",
            );
            None
        }
    }
}

/// 统一数据目录解析：`MR_DATA_DIR`（测试隔离）> 已安装的 Tauri 数据根 >
/// 旧版本地目录。绝不使用 CWD / exe 同级目录。
pub(crate) fn data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = env_data_dir_override() {
        return Ok(dir);
    }
    if let Some(dir) = paths::data_dir() {
        return Ok(dir.to_path_buf());
    }
    legacy_data_dir().ok_or_else(|| "无法定位本地数据目录".to_string())
}

/// setup 第一步：解析并落地数据/缓存根。
///
/// - 数据根：`MR_DATA_DIR` > Tauri `app_data_dir` > 旧 Local AppData；
/// - 缓存根：`MR_DATA_DIR` 隔离模式下取 `<数据根>/cache`，否则 Tauri
///   `app_cache_dir`；两者都 `create_dir_all`。
///
/// 返回 `(data, cache, 是否 MR_DATA_DIR 隔离)`。
fn install_app_paths(
    tauri_data: Option<PathBuf>,
    app_cache: Option<PathBuf>,
    legacy: Option<PathBuf>,
) -> (PathBuf, PathBuf, bool) {
    let env_override = env_data_dir_override();
    let data = match env_override.as_ref() {
        // 覆盖值已在 env_data_dir_override 中完成 trim 与绝对路径校验。
        Some(dir) => dir.clone(),
        None => paths::resolve_data_root(None, tauri_data, legacy).unwrap_or_else(|err| {
            logging::log_error("paths", &format!("{err}；回落到系统临时目录"));
            std::env::temp_dir().join("com.local.manga-reader")
        }),
    };
    let cache = if env_override.is_some() {
        // 隔离模式不触碰真实用户缓存目录。
        data.join("cache")
    } else {
        app_cache
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| data.join("cache"))
    };
    if let Err(err) = std::fs::create_dir_all(&data) {
        logging::log_error("paths", &format!("创建数据目录失败：{err}"));
    }
    if let Err(err) = std::fs::create_dir_all(&cache) {
        logging::log_error("paths", &format!("创建缓存目录失败：{err}"));
    }
    // Linux 多用户桌面：书库与应用数据默认只给当前用户（0700）。
    paths::harden_private_dir(&data);
    paths::harden_private_dir(&cache);
    paths::install(data.clone(), cache.clone());
    logging::init(data.join("logs"));
    (data, cache, env_override.is_some())
}

/// 旧本地目录 → 新数据根一次性接续（仅补缺失文件，不删源、不复制缓存）。
/// 日志只写文件名与字节数，不落任何本地绝对路径。
fn migrate_legacy_into(data: &Path, isolated: bool) {
    if isolated {
        logging::log_error("paths", "MR_DATA_DIR 隔离模式：跳过旧数据目录迁移");
        return;
    }
    let Some(legacy) = legacy_data_dir() else {
        return;
    };
    let notes = paths::migrate_legacy_state(data, &legacy);
    if !notes.is_empty() {
        logging::log_error(
            "paths",
            &format!("旧数据目录迁移（仅补缺失文件）：{}", notes.join("；")),
        );
    }
}

fn init_app(state: &Arc<AppState>, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join("library.db");
    state.set_db_path(db_path.clone());
    let conn = match db::open(&db_path) {
        Ok(conn) => conn,
        Err(error) => {
            state.set_db_error("db-open-failed");
            logging::log_error(
                "startup",
                "书库数据库打开失败（db-open-failed，详情已省略）",
            );
            return Err(error.to_string());
        }
    };
    if let Err(error) = db::init_schema(&conn) {
        state.set_db_error("db-schema-failed");
        logging::log_error(
            "startup",
            "书库数据库结构初始化失败（db-schema-failed，详情已省略）",
        );
        return Err(error.to_string());
    }
    if let Err(error) = db::quick_check(&conn) {
        state.set_db_error("db-quick-check-failed");
        logging::log_error(
            "startup",
            "书库数据库完整性自检失败（db-quick-check-failed，详情已省略）",
        );
        return Err(error.to_string());
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut raw = db_path.as_os_str().to_os_string();
        raw.push(suffix);
        paths::harden_private_file(Path::new(&raw));
    }
    let current_version = env!("CARGO_PKG_VERSION");
    let previous_version = versioning::read_last_run_version(&conn).unwrap_or_else(|err| {
        logging::log_error("version", &format!("读取 last_run_version 失败：{err}"));
        None
    });
    let migration = versioning::plan(previous_version.as_deref(), current_version);
    let (settings, repaired_settings) =
        match load_normalized_settings(&conn, state.settings.lock().clone()) {
            Ok(settings) => settings,
            Err(error) => {
                state.set_db_error(error.code());
                logging::log_error(
                    "startup",
                    &format!("书库设置加载/规范化失败（{}，详情已省略）", error.code()),
                );
                return Err(error.code().to_string());
            }
        };
    state
        .cache
        .set_budgets((settings.cache_budget_mb.max(16) as u64) * 1024 * 1024);
    *state.settings.lock() = settings;
    state.db.set(conn);
    state.clear_db_error();
    if migration.clear_memory_cache {
        state.cache.clear_pages();
        state.cache.clear_thumbs();
        state.webtoon_layouts.lock().clear();
        state.invalidate_sources();
    }
    if migration.clear_disk_cache {
        // MAJOR/downgrade/unknown metadata may point at incompatible render
        // artifacts. Removing the derived directories never touches the library.
        state.render.clear_all();
        state.online_cache.clear_all();
    }
    if let Err(err) = state.db.with(|conn| {
        versioning::record_run_version(conn, current_version).map_err(|err| err.to_string())
    }) {
        logging::log_error("version", &format!("写入 last_run_version 失败：{err}"));
    }
    if migration.change != versioning::VersionChange::Unchanged {
        logging::log_error(
            "version",
            &format!(
                "本地版本 {} → {}（{}）；清理内存缓存={}，清理磁盘缓存={}，修复配置={}",
                migration.previous.as_deref().unwrap_or("first-run"),
                current_version,
                migration.change.as_str(),
                migration.clear_memory_cache,
                migration.clear_disk_cache,
                if repaired_settings.is_empty() {
                    "none".to_string()
                } else {
                    repaired_settings.join(",")
                }
            ),
        );
    } else if !repaired_settings.is_empty() {
        logging::log_error(
            "version",
            &format!(
                "版本未变化，但修复了异常配置：{}",
                repaired_settings.join(",")
            ),
        );
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 系统准入先于一切：低于 Windows 10（NT 10.0 / Build 10240）直接原生
    // 提示并非零退出，绝不在未验证的运行时上初始化 SQLite / WebView。
    platform::enforce_windows_baseline();
    // WebKitGTK（Linux）渲染回退等启动期加固必须先于 Builder/WebView 创建。
    platform::early_env_hardening();
    let resilience_state = resilience::new_state();
    let app = tauri::Builder::default()
        .manage(resilience_state.clone())
        // 单实例插件必须是第一个注册的插件：第二次双击文件时唤醒已有实例，
        // 由回调把命令行路径转交给 open_with。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            open_with::handle_launch(app, argv);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 官方 Updater：GitHub Releases latest.json + minisign 校验。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 关闭主窗口：LAN 服务运行中或用户开启「关闭到托盘」时只隐藏，
        // 不触发退出；托盘「彻底退出」走 app.exit（不产生 CloseRequested）。
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if window.label() != "main" || tray::is_exiting() {
                return;
            }
            let app = window.app_handle();
            let close_to_tray = app
                .try_state::<Arc<AppState>>()
                .map(|state| state.settings.lock().close_to_tray)
                .unwrap_or(false);
            let running = app
                .try_state::<Arc<web_access::WebAccessRuntime>>()
                .map(|runtime| runtime.is_running_snapshot())
                .unwrap_or(false);
            if close_to_tray || running {
                if !tray::is_available(app) {
                    // No tray host: let the window close instead of stranding it.
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            diagnostics::install_panic_hook();
            // 1) 先锚定数据/缓存根（app_data_dir / app_cache_dir），再初始化日志。
            let tauri_data = app.path().app_data_dir().ok();
            let app_cache = app.path().app_cache_dir().ok();
            let legacy = legacy_data_dir();
            let (data_dir, _cache_dir, isolated) =
                tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(move || {
                    install_app_paths(tauri_data, app_cache, legacy)
                }))
                .map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("启动路径后台任务失败：{error}"),
                    )
                })?;
            // 1.1) 清理上次更新遗留的临时包 / AppImage 旧备份（>24h）。
            let _ = tauri::async_runtime::spawn_blocking(update::cleanup_stale_artifacts);
            // 2) 旧 Local AppData 数据一次性接续（仅补缺失文件；隔离模式跳过）。
            let migration_data = data_dir.clone();
            tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(move || {
                migrate_legacy_into(&migration_data, isolated)
            }))
            .map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("旧数据后台迁移任务失败：{error}"),
                )
            })?;
            // 3) AppState 的渲染/在线缓存根依赖已安装的 cache_dir，必须最后创建。
            let app_state =
                tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(|| {
                    Arc::new(AppState::new())
                }))
                .map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("缓存状态初始化后台任务失败：{error}"),
                    )
                })?;
            app.manage(app_state);
            // G1：CA 公钥分发运行时只托管，不启动；只有显式命令才 bind。
            let ca_root = ca::resolve_ca_root(None, Some(data_dir.as_path()))
                .unwrap_or_else(|_| data_dir.join("security").join("ca"));
            app.manage(Arc::new(web_access::CaDistributionRuntime::new(
                ca_root.clone(),
            )));
            // D1b：控制面运行时只托管，默认 Disabled；启动不 bind、不建配对窗口。
            // D2：注入只读数据面 provider；D3：注入进度写 provider。
            // 两者都只在显式 start 后由 start_inner 挂载，库初始化绝不监听。
            let app_state = app.state::<Arc<AppState>>().inner().clone();
            let web_data = Arc::new(web_access::AppData::new(Arc::clone(&app_state)));
            let web_progress = Arc::new(web_access::AppProgress::new(app_state));
            app.manage(Arc::new(
                web_access::WebAccessRuntime::new(
                    ca_root,
                    Arc::new(web_access::TauriEventSink::new(app.handle().clone())),
                    web_data,
                )
                .with_progress(web_progress),
            ));
            cache_health::install(app.handle().clone());
            let init_state = app.state::<Arc<AppState>>().inner().clone();
            let init_dir = data_dir.clone();
            let init_result =
                tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(move || {
                    init_app(&init_state, &init_dir)
                }))
                .map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("数据库初始化后台任务失败：{error}"),
                    )
                })?;
            if init_result.is_err() {
                // 具体错误码已写入 AppState；这里只记录脱敏错误码，不输出路径。
                logging::log_error("startup", "后端初始化失败（db-init-failed）");
            }
            // 系统托盘：DB 与运行时都已就绪，才能读取上次的托盘语言。
            if let Err(error) = tray::install(app.handle()) {
                logging::log_error("tray", &format!("系统托盘初始化失败：{error}"));
            }
            // Task 7：恢复上次安装的桌面/托盘图标（只刷新运行时，不碰快捷方式）。
            desktop_icon::restore_runtime_icon(app.handle());
            // 4) 文件关联/命令行直开：首次启动在后台导入，完成后 ping 前端。
            open_with::handle_launch(
                app.handle(),
                std::env::args_os()
                    .filter_map(|value| match value.into_string() {
                        Ok(value) => Some(value),
                        Err(_) => {
                            // 非 UTF-8 路径无法无损穿过 IPC/JSON；忽略并留痕，
                            // 绝不 to_string_lossy 后当成另一本书导入。
                            logging::log_error(
                                "open_with",
                                "忽略非 UTF-8 命令行路径（non-utf8-path）",
                            );
                            None
                        }
                    })
                    .collect(),
            );
            if let Err(e) = resilience::initialize(app.handle(), &resilience_state) {
                logging::log_error("startup", &format!("韧性守卫初始化失败：{e}"));
            }
            // 启动时后台 trim 统一磁盘缓存（render + online，共用软上限）。
            let st2 = app.state::<Arc<AppState>>().inner().clone();
            let _ = tauri::async_runtime::spawn_blocking(move || st2.trim_disk_cache());
            // 之后不再有常驻巡检定时器：写盘累计 256MB（`note_cache_write`）
            // 与设置保存会按需触发淘汰，退出路径再做一次收尾。
            // 空闲静默态不允许任何周期线程唤醒（CPU 归零）。
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_library,
            commands::import_books,
            commands::remove_books,
            commands::list_books,
            commands::list_books_page,
            commands::library_stats,
            commands::get_last_read,
            commands::get_book,
            commands::relocate_book,
            open_with::take_pending_open,
            commands::get_next_book,
            commands::get_series_books,
            commands::list_entries,
            commands::get_page,
            commands::get_thumbnail,
            // PDF-2：PDF 渲染支持（页面由前端 PDF.js 渲染，后端只供字节与封面缓存）。
            commands::get_pdf_chunk,
            commands::set_book_page_count,
            commands::put_pdf_thumbnail,
            commands::clear_thumbnail_cache,
            commands::clear_temp_cache,
            commands::get_webtoon_layout,
            commands::get_webtoon_tile,
            commands::get_memory_stats,
            commands::get_temp_free_bytes,
            commands::get_dashboard,
            commands::get_reading_log,
            commands::get_reading_by_book,
            commands::set_progress,
            commands::mark_book_opened,
            commands::clear_pages,
            commands::get_settings,
            commands::set_settings,
            commands::set_feature_enabled,
            commands::assert_feature_enabled,
            backup::export_backup,
            backup::import_backup,
            backup::get_db_health,
            backup::open_data_dir,
            backup::recover_database_from_backup,
            commands::resolve_online_url,
            commands::test_online_connection,
            commands::opds_get_config,
            commands::opds_set_config,
            commands::opds_test_connection,
            commands::opds_browse,
            commands::opds_cover,
            commands::opds_download_entry,
            commands::import_resolved_pages,
            commands::resolve_online_batch,
            commands::resolve_telegram_channel,
            commands::download_telegram_document,
            commands::get_online_filter_status,
            commands::list_online_filter_rules,
            commands::export_online_filter_rules,
            commands::import_online_filter_rules,
            commands::reset_online_filter_rules,
            commands::get_filtered_pages,
            commands::get_filtered_preview,
            commands::mark_online_page_non_content,
            commands::restore_online_filtered_page,
            commands::set_session_online_headers,
            commands::clear_session_online_headers,
            commands::get_session_online_headers,
            online::handoff::start_browser_handoff,
            online::handoff::stop_browser_handoff,
            online::handoff::get_browser_handoff_status,
            system_proxy::detect_system_proxy,
            browser::open_browser_window,
            browser::navigate_browser,
            browser::list_browser_downloads,
            browser::import_browser_download,
            // 旧自定义补丁通道（check/download/install/cancel/snapshot）已下线：
            // 前端零调用，且与官方 latest.json 通道不兼容。仅保留应用信息与
            // 用户点击后的 restart_app；旧校验代码/负向测试仍可作为回归资产。
            update::get_app_info,
            update::restart_app,
            // Task 7：皮肤素材只走「后端校验 → data: URL」通道，CSP 不变。
            skin::skin_import_asset,
            // Task 7：桌面快捷方式 / 任务栏 / 托盘图标（Shell Link，不改 EXE 签名）。
            desktop_icon::desktop_icon_state,
            desktop_icon::desktop_icon_install,
            desktop_icon::desktop_icon_reset,
            security::security_audit,
            security::clear_online_traces,
            // G1：仅根 CA 初始化/导出/短时分发；不含 D1b 配对或数据路由。
            web_access::ca_distribution_commands::web_access_ca_status,
            web_access::ca_distribution_commands::web_access_ca_initialize,
            web_access::ca_distribution_commands::web_access_ca_export_root,
            web_access::ca_distribution_commands::web_access_ca_distribution_addresses,
            web_access::ca_distribution_commands::web_access_ca_distribution_start,
            web_access::ca_distribution_commands::web_access_ca_distribution_stop,
            web_access::ca_distribution_commands::web_access_ca_distribution_status,
            // D1b：控制面命令。默认 Disabled；只有显式 start 才 bind；无数据路由。
            web_access::commands::web_access_status,
            web_access::commands::web_access_addresses,
            web_access::commands::web_access_start,
            web_access::commands::web_access_start_plain,
            web_access::commands::web_access_stop,
            web_access::commands::web_access_pairing_start,
            web_access::commands::web_access_pairing_state,
            web_access::commands::web_access_pairing_approve,
            web_access::commands::web_access_pairing_deny,
            web_access::commands::web_access_pairing_cancel,
            web_access::commands::web_access_devices_list,
            web_access::commands::web_access_device_revoke,
            tray::tray_set_locale,
            tray::tray_set_icon,
            diagnostics::diagnostics_record_frontend_error,
            diagnostics::diagnostics_record_breadcrumb,
            diagnostics::diagnostics_update_context,
            diagnostics::diagnostics_collect,
            diagnostics::diagnostics_sanitize_description,
            diagnostics::diagnostics_export,
            resilience::heartbeat_ping,
            resilience::resilience_report_rage_click,
            resilience::get_recovery_context,
            resilience::resilience_reload_main,
            resilience::resilience_close_recovery,
            resilience::get_safe_mode_state,
            resilience::resilience_enable_safe_mode,
            resilience::resilience_disable_safe_mode,
            resilience::resilience_mark_ready
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // D1b：退出前先关闭控制面监听、配对窗口与全部会话。失败只记录
            // 稳定码，不自动重试/重启；随后完成数据库 WAL 收尾。
            let web_access = app_handle.state::<Arc<web_access::WebAccessRuntime>>();
            let shutdown_timeout = std::time::Duration::from_secs(10);
            if tauri::async_runtime::block_on(web_access.stop_for_exit(shutdown_timeout)).is_err() {
                logging::log_error("web_access", "退出时停止监听超时（web-access-server-join）");
            }
            let state = app_handle.state::<Arc<AppState>>();
            state.cancel_handoff();
            let state = state.inner().clone();
            // 退出时只做 WAL checkpoint；派生缓存由启动与写入压力路径修剪，
            // 避免关闭窗口时扫描整棵缓存目录。checkpoint 在阻塞池完成。
            let checkpoint = tauri::async_runtime::spawn_blocking(move || {
                state
                    .db
                    .with(|conn| db::wal_checkpoint(conn).map_err(|error| error.to_string()))
            });
            if !matches!(
                tauri::async_runtime::block_on(tokio::time::timeout(shutdown_timeout, checkpoint,)),
                Ok(Ok(Ok(())))
            ) {
                logging::log_error("database", "退出时数据库收尾未完成（blocking-task-failed）");
            }
        }
    });
}

#[cfg(test)]
mod settings_feature_tests {
    use super::*;

    fn conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')")
            .unwrap();
        conn
    }

    #[test]
    fn hydrate_defaults_keep_webtoon_on_and_online_off() {
        let conn = conn();
        let mut s = Settings::default();
        hydrate_settings(&conn, &mut s).unwrap();
        assert!(s.features.webtoon);
        assert!(!s.features.online);
        assert!(s.features.pdf);
    }

    #[test]
    fn hydrate_reads_new_keys_and_legacy_online() {
        let conn = conn();
        db::set_setting(&conn, "feature_webtoon", "false").unwrap();
        db::set_setting(&conn, "experimental_online", "true").unwrap();
        db::set_setting(&conn, "feature_pdf", "false").unwrap();
        let mut s = Settings::default();
        hydrate_settings(&conn, &mut s).unwrap();
        assert!(!s.features.webtoon);
        assert!(s.features.online);
        assert!(!s.features.pdf);
    }

    #[test]
    fn hydrate_propagates_settings_table_read_errors() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut s = Settings::default();
        assert!(hydrate_settings(&conn, &mut s).is_err());
    }

    #[test]
    fn startup_settings_loader_classifies_read_and_normalize_failures() {
        let missing_table = rusqlite::Connection::open_in_memory().unwrap();
        assert_eq!(
            load_normalized_settings(&missing_table, Settings::default()).unwrap_err(),
            StartupSettingsError::Load
        );

        let readonly = conn();
        db::set_setting(&readonly, "theme", "invalid-theme").unwrap();
        readonly.pragma_update(None, "query_only", true).unwrap();
        assert_eq!(
            load_normalized_settings(&readonly, Settings::default()).unwrap_err(),
            StartupSettingsError::Normalize
        );
    }
}

#[cfg(test)]
mod data_dir_tests {
    use super::*;

    #[test]
    fn data_dir_override_accepts_only_absolute_paths() {
        let absolute = std::env::temp_dir().join("mr-data-root");
        let absolute_text = absolute.to_string_lossy().into_owned();
        assert_eq!(data_dir_override(&absolute_text), Some(absolute.clone()));
        // 两端空白先 trim 再判定。
        assert_eq!(
            data_dir_override(&format!("  {absolute_text}  ")),
            Some(absolute)
        );
        // 相对路径、空值与纯空白一律视为未设置，不得回落 CWD。
        for rejected in ["", "   ", "data", "./tmp", "../data"] {
            assert_eq!(data_dir_override(rejected), None, "{rejected:?}");
        }
    }
}
