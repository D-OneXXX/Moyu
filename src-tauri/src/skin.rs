//! Skin packs (Task 21-3).
//!
//! Two artwork intake paths share one boundary:
//!
//! 1. `skin_import_asset` is the legacy single-image picker. It turns one
//!    validated image into a `data:` URL so the webview can preview it without
//!    widening the production CSP.
//! 2. `.moyuskin` packs are validated ZIP archives. They are unpacked under
//!    `<app_data_dir>/skins/<skin_id>/` and never stored in localStorage; only
//!    the lightweight `mr-skin` id lives there.
//!
//! Validation is deliberately conservative: strict manifest schema, root-relative
//! paths, no symlinks, no SVG, bounded image dimensions, and a CSS token
//! whitelist that cannot smuggle `url(...)`, `;`, `{}`, `@import`, or CSS
//! expressions into the webview. Every failure is a stable kebab-case code
//! wrapped in a Chinese message (registered in `src/features/errors/localize.ts`).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageFormat, ImageReader};
use lru::LruCache;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::num::NonZeroUsize;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Hard ceiling for a decoration asset. Keeps a data URL (≈ +33 %) small
/// enough to stay in memory for a long session.
const MAX_ASSET_BYTES: u64 = 4 * 1024 * 1024;
/// 4K is already generous for a frame or a storefront preview.
const MAX_ASSET_DIMENSION: u32 = 4096;
/// Strict manifest budget: a tiny declarative file, never artwork.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// Whole pack budget (archive bytes and uncompressed bytes alike).
const MAX_PACK_BYTES: u64 = 16 * 1024 * 1024;
/// A skin pack is a small declarative bundle, not a photo album.
const MAX_PACK_ENTRIES: usize = 16;
/// Preview thumbnails stay small enough for a gallery grid.
const PREVIEW_MAX_W: u32 = 480;
const PREVIEW_MAX_H: u32 = 300;
const SKINS_DIR: &str = "skins";
const MANIFEST_NAME: &str = "skin.json";
const MANAGED_IDS: [&str; 4] = ["default", "ink", "midnight", "pastel"];
const SAFE_LOCALES: [&str; 6] = ["zh-CN", "zh-TW", "en", "es", "ja", "ko"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinAssetPayload {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Manifest text: either one plain string or a locale -> text object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SkinText {
    Plain(String),
    Localized(BTreeMap<String, String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkinSummary {
    pub id: String,
    pub name: SkinText,
    pub author: String,
    pub description: Option<SkinText>,
    pub color_scheme: String,
    pub tokens: BTreeMap<String, String>,
    pub preview_data_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinBundle {
    pub id: String,
    pub name: SkinText,
    pub author: String,
    pub description: Option<SkinText>,
    pub color_scheme: String,
    pub tokens: BTreeMap<String, String>,
    pub backdrop: SkinAssetPayload,
    pub frame: Option<SkinAssetPayload>,
    pub preview: Option<SkinAssetPayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SkinManifest {
    schema: u32,
    id: String,
    name: SkinText,
    #[serde(default)]
    author: String,
    #[serde(default)]
    description: Option<SkinText>,
    #[serde(default = "default_color_scheme")]
    color_scheme: String,
    tokens: BTreeMap<String, String>,
    assets: SkinAssets,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SkinAssets {
    backdrop: String,
    #[serde(default)]
    frame: Option<String>,
    #[serde(default)]
    preview: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DetectedImage {
    format: ImageFormat,
    mime: &'static str,
    extension: &'static str,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone)]
struct LoadedManifest {
    manifest: SkinManifest,
    raw: Vec<u8>,
}

struct CacheInner {
    bundles: LruCache<(PathBuf, String), SkinBundle>,
    previews: LruCache<(PathBuf, String), String>,
}

/// Process-local LRU cache. Bundles (which contain base64 artwork) are capped
/// at three entries; previews at twenty-four. Nothing here is persisted.
#[derive(Clone)]
pub struct SkinCache {
    inner: Arc<Mutex<CacheInner>>,
}

impl Default for SkinCache {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CacheInner {
                bundles: LruCache::new(NonZeroUsize::new(3).expect("bundle cache cap")),
                previews: LruCache::new(NonZeroUsize::new(24).expect("preview cache cap")),
            })),
        }
    }
}

impl SkinCache {
    fn lock(&self) -> MutexGuard<'_, CacheInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn bundle(&self, root: &Path, id: &str) -> Option<SkinBundle> {
        self.lock()
            .bundles
            .get(&(root.to_path_buf(), id.to_string()))
            .cloned()
    }

    fn store_bundle(&self, root: &Path, bundle: SkinBundle) {
        self.lock()
            .bundles
            .put((root.to_path_buf(), bundle.id.clone()), bundle);
    }

    fn preview(&self, root: &Path, id: &str) -> Option<String> {
        self.lock()
            .previews
            .get(&(root.to_path_buf(), id.to_string()))
            .cloned()
    }

    fn store_preview(&self, root: &Path, id: &str, preview: String) {
        self.lock()
            .previews
            .put((root.to_path_buf(), id.to_string()), preview);
    }

    fn clear(&self) {
        let mut inner = self.lock();
        inner.bundles.clear();
        inner.previews.clear();
    }
}

fn default_color_scheme() -> String {
    "both".to_string()
}

fn skin_message(code: &str) -> &'static str {
    match code {
        "skin-not-zip" => "皮肤包不是有效的 ZIP 归档",
        "skin-pack-too-large" => "皮肤包超过 16 MiB 上限",
        "skin-too-many-entries" => "皮肤包条目超过 16 个",
        "skin-unsafe-entry" => "皮肤包包含不安全的路径或链接",
        "skin-encrypted" => "皮肤包不能加密",
        "skin-manifest-invalid" => "皮肤包清单无效",
        "skin-manifest-too-large" => "皮肤包清单超过 64 KiB 上限",
        "skin-asset-missing" => "皮肤包缺少引用的图片资源",
        "skin-unsupported-format" => "皮肤包只允许 PNG / JPEG / WebP 图片",
        "skin-too-large" => "皮肤包单张图片超过 4 MiB 上限",
        "skin-dimension-too-large" => "皮肤包图片尺寸超过 4096px 上限",
        "skin-id-invalid" => "皮肤包标识非法或与内置皮肤冲突",
        "skin-already-installed" => "该皮肤包已安装",
        "skin-token-invalid" => "皮肤包 CSS token 非法",
        "skin-write-failed" => "皮肤包写入失败",
        "skin-not-installed" => "该皮肤未安装",
        "skin-delete-failed" => "皮肤删除失败",
        "skin-export-failed" => "皮肤导出失败",
        "skin-name-invalid" => "皮肤名称无效",
        "skin-inset-invalid" => "视窗内缩边距必须在 0–32px 之间",
        "skin-opacity-invalid" => "视窗通透度必须在 70%–100% 之间",
        "skin-frame-png-required" => "画框贴图必须是 PNG",
        "skin-data-dir-unavailable" => "皮肤数据目录不可用",
        "skin-read-failed" => "读取皮肤文件失败",
        "skin-empty" => "皮肤文件为空",
        _ => "皮肤操作失败",
    }
}

fn stable(code: &str) -> String {
    format!("{}（{code}）", skin_message(code))
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn skins_root() -> Result<PathBuf, String> {
    let data = crate::paths::data_dir().ok_or_else(|| stable("skin-data-dir-unavailable"))?;
    let root = data.join(SKINS_DIR);
    fs::create_dir_all(&root).map_err(|_| stable("skin-write-failed"))?;
    if fs::symlink_metadata(&root)
        .map(|metadata| is_link_like(&metadata))
        .unwrap_or(true)
    {
        return Err(stable("skin-data-dir-unavailable"));
    }
    crate::paths::harden_private_dir(&root);
    Ok(root)
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn valid_skin_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || MANAGED_IDS.contains(&id) {
        return false;
    }
    let start_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    let end_ok = bytes
        .last()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    start_ok
        && end_ok
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_asset_path(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.len() > 200 || raw.contains('\\') || raw.contains('\0') {
        return None;
    }
    let mut path = PathBuf::new();
    let mut parts = 0usize;
    for component in raw.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || !component
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return None;
        }
        parts += 1;
        if parts > 4 {
            return None;
        }
        path.push(component);
    }
    // Rebuild through Path components as a second line of defence.
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(path)
}

fn is_image_asset(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp"
            )
        })
        .unwrap_or(false)
}

fn valid_skin_text(value: &SkinText, max_len: usize) -> bool {
    let check = |text: &str| {
        let trimmed = text.trim();
        !trimmed.is_empty()
            && trimmed.chars().count() <= max_len
            && !trimmed.chars().any(|ch| ch.is_control())
    };
    match value {
        SkinText::Plain(text) => check(text),
        SkinText::Localized(map) => {
            !map.is_empty()
                && map.len() <= SAFE_LOCALES.len()
                && map
                    .iter()
                    .all(|(locale, text)| SAFE_LOCALES.contains(&locale.as_str()) && check(text))
        }
    }
}

fn parse_px(raw: &str, max: f32) -> Option<f32> {
    let trimmed = raw.trim();
    let number = trimmed.strip_suffix("px")?.trim();
    let value: f32 = number.parse().ok()?;
    (value.is_finite() && (0.0..=max).contains(&value)).then_some(value)
}

fn valid_inset(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    (1..=4).contains(&parts.len()) && parts.iter().all(|part| parse_px(part, 64.0).is_some())
}

fn valid_length(raw: &str, max: f32) -> bool {
    parse_px(raw, max).is_some()
}

fn valid_opacity(raw: &str) -> bool {
    raw.trim()
        .parse::<f64>()
        .ok()
        .is_some_and(|value| (0.7..=1.0).contains(&value) && value.is_finite())
}

fn valid_hex_color(raw: &str) -> bool {
    let Some(hex) = raw.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn valid_color(raw: &str) -> bool {
    let value = raw.trim();
    let lower = value.to_ascii_lowercase();
    if lower == "transparent" {
        return true;
    }
    if matches!(
        lower.as_str(),
        "var(--sh-card)"
            | "var(--sh-background)"
            | "var(--sh-primary)"
            | "var(--sh-border)"
            | "var(--sh-foreground)"
            | "var(--sh-secondary)"
            | "var(--sh-muted)"
    ) {
        return true;
    }
    if valid_hex_color(&lower) {
        return true;
    }
    for prefix in ["rgb(", "rgba(", "hsl(", "hsla("] {
        if lower.starts_with(prefix) && lower.ends_with(')') {
            let inner = &lower[prefix.len()..lower.len() - 1];
            return !inner.is_empty()
                && inner.len() <= 80
                && inner
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | ',' | '/' | '%' | ' '));
        }
    }
    false
}

fn valid_position(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.is_empty() || parts.len() > 2 {
        return false;
    }
    parts.iter().all(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "center" | "top" | "bottom" | "left" | "right"
        ) || part
            .strip_suffix('%')
            .and_then(|value| value.parse::<f32>().ok())
            .is_some_and(|value| (0.0..=100.0).contains(&value))
            || parse_px(part, 4096.0).is_some()
    })
}

fn valid_background_size(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.is_empty() || parts.len() > 2 {
        return false;
    }
    parts.iter().all(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "cover" | "contain" | "auto"
        ) || part
            .strip_suffix('%')
            .and_then(|value| value.parse::<f32>().ok())
            .is_some_and(|value| (0.0..=100.0).contains(&value))
            || parse_px(part, 4096.0).is_some()
    })
}

fn valid_token(key: &str, value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 160 || trimmed.chars().any(|ch| ch.is_control()) {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if [
        "url(",
        "expression",
        "javascript:",
        "@import",
        "\\",
        "{",
        "}",
        ";",
    ]
    .iter()
    .any(|forbidden| lower.contains(forbidden))
    {
        return false;
    }
    match key {
        "--mr-skin-viewport-inset" => valid_inset(trimmed),
        "--mr-skin-viewport-radius" => valid_length(trimmed, 64.0),
        "--mr-skin-surface-opacity" => valid_opacity(trimmed),
        "--mr-skin-surface-blur" => valid_length(trimmed, 32.0),
        "--mr-skin-surface-bg" | "--mr-skin-surface-tint" | "--mr-skin-canvas-bg" => {
            valid_color(trimmed)
        }
        "--mr-skin-backdrop-size" | "--mr-skin-frame-size" => valid_background_size(trimmed),
        "--mr-skin-backdrop-position" | "--mr-skin-frame-position" => valid_position(trimmed),
        _ => false,
    }
}

fn detect_image(bytes: &[u8]) -> Result<DetectedImage, String> {
    if bytes.is_empty() {
        return Err(stable("skin-empty"));
    }
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(stable("skin-too-large"));
    }
    let format = image::guess_format(bytes).map_err(|_| stable("skin-unsupported-format"))?;
    let (mime, extension) = match format {
        ImageFormat::Png => ("image/png", "png"),
        ImageFormat::Jpeg => ("image/jpeg", "jpg"),
        ImageFormat::WebP => ("image/webp", "webp"),
        _ => return Err(stable("skin-unsupported-format")),
    };
    let reader = ImageReader::with_format(Cursor::new(bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| stable("skin-unsupported-format"))?;
    if width == 0 || height == 0 {
        return Err(stable("skin-unsupported-format"));
    }
    if width > MAX_ASSET_DIMENSION || height > MAX_ASSET_DIMENSION {
        return Err(stable("skin-dimension-too-large"));
    }
    Ok(DetectedImage {
        format,
        mime,
        extension,
        width,
        height,
    })
}

fn asset_payload(bytes: &[u8], detected: &DetectedImage) -> SkinAssetPayload {
    SkinAssetPayload {
        data_url: format!("data:{};base64,{}", detected.mime, STANDARD.encode(bytes)),
        width: detected.width,
        height: detected.height,
        bytes: bytes.len() as u64,
    }
}

fn parse_manifest(raw: &[u8]) -> Result<SkinManifest, String> {
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(stable("skin-manifest-too-large"));
    }
    let manifest: SkinManifest =
        serde_json::from_slice(raw).map_err(|_| stable("skin-manifest-invalid"))?;
    if manifest.schema != 1 {
        return Err(stable("skin-manifest-invalid"));
    }
    if !valid_skin_id(&manifest.id) {
        return Err(stable("skin-id-invalid"));
    }
    if !valid_skin_text(&manifest.name, 80) {
        return Err(stable("skin-name-invalid"));
    }
    if manifest.author.chars().count() > 80 || manifest.author.chars().any(|ch| ch.is_control()) {
        return Err(stable("skin-manifest-invalid"));
    }
    if let Some(description) = &manifest.description {
        if !valid_skin_text(description, 280) {
            return Err(stable("skin-manifest-invalid"));
        }
    }
    if !matches!(manifest.color_scheme.as_str(), "light" | "dark" | "both") {
        return Err(stable("skin-manifest-invalid"));
    }
    if manifest.tokens.len() > 16 {
        return Err(stable("skin-token-invalid"));
    }
    for (key, value) in &manifest.tokens {
        if !valid_token(key, value) {
            return Err(stable("skin-token-invalid"));
        }
    }
    let backdrop = valid_asset_path(&manifest.assets.backdrop)
        .filter(|path| is_image_asset(path))
        .ok_or_else(|| stable("skin-manifest-invalid"))?;
    if backdrop == Path::new(MANIFEST_NAME) {
        return Err(stable("skin-manifest-invalid"));
    }
    for asset in [&manifest.assets.frame, &manifest.assets.preview]
        .into_iter()
        .flatten()
    {
        let path = valid_asset_path(asset)
            .filter(|path| is_image_asset(path))
            .ok_or_else(|| stable("skin-manifest-invalid"))?;
        if path == Path::new(MANIFEST_NAME) {
            return Err(stable("skin-manifest-invalid"));
        }
    }
    Ok(manifest)
}

fn manifest_bytes(manifest: &SkinManifest) -> Result<Vec<u8>, String> {
    let raw = serde_json::to_vec_pretty(manifest).map_err(|_| stable("skin-manifest-invalid"))?;
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(stable("skin-manifest-too-large"));
    }
    Ok(raw)
}

fn manifest_paths(manifest: &SkinManifest) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for raw in [
        Some(&manifest.assets.backdrop),
        manifest.assets.frame.as_ref(),
        manifest.assets.preview.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(path) = valid_asset_path(raw) {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }
    paths
}

/// Symlinks and Windows reparse points (junctions) are both rejected: either
/// could redirect a skin directory to a path outside `<app_data_dir>/skins`.
fn is_link_like(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_reparse_point(metadata)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn safe_join(base: &Path, relative: &Path) -> Option<PathBuf> {
    let base = base.canonicalize().ok()?;
    let candidate = base.join(relative).canonicalize().ok()?;
    candidate.starts_with(&base).then_some(candidate)
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| stable("skin-asset-missing"))?;
    if is_link_like(&metadata) || !metadata.is_file() {
        return Err(stable("skin-asset-missing"));
    }
    if metadata.len() == 0 {
        return Err(stable("skin-empty"));
    }
    if metadata.len() > limit {
        return Err(if limit == MAX_MANIFEST_BYTES {
            stable("skin-manifest-too-large")
        } else {
            stable("skin-too-large")
        });
    }
    let bytes = fs::read(path).map_err(|_| stable("skin-asset-missing"))?;
    if bytes.len() as u64 > limit {
        return Err(stable("skin-too-large"));
    }
    Ok(bytes)
}

fn read_manifest(dir: &Path) -> Result<LoadedManifest, String> {
    let path = dir.join(MANIFEST_NAME);
    let raw = read_limited(&path, MAX_MANIFEST_BYTES)?;
    let manifest = parse_manifest(&raw)?;
    Ok(LoadedManifest { manifest, raw })
}

fn thumbnail_data_url(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let thumbnail = image.thumbnail(PREVIEW_MAX_W, PREVIEW_MAX_H);
    let mut encoded = Cursor::new(Vec::new());
    thumbnail.write_to(&mut encoded, ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}

fn preview_for(
    root: &Path,
    dir: &Path,
    manifest: &SkinManifest,
    cache: &SkinCache,
) -> Option<String> {
    if let Some(cached) = cache.preview(root, &manifest.id) {
        return Some(cached);
    }
    let relative = manifest
        .assets
        .preview
        .as_ref()
        .or(Some(&manifest.assets.backdrop))?;
    let path = safe_join(dir, &valid_asset_path(relative)?)?;
    let bytes = read_limited(&path, MAX_ASSET_BYTES).ok()?;
    let detected = detect_image(&bytes).ok()?;
    let preview = thumbnail_data_url(&bytes).or_else(|| {
        // Fallback for hostile/large previews: only inline small originals.
        (bytes.len() <= 1024 * 1024)
            .then(|| format!("data:{};base64,{}", detected.mime, STANDARD.encode(&bytes)))
    })?;
    cache.store_preview(root, &manifest.id, preview.clone());
    Some(preview)
}

fn summary_from(
    root: &Path,
    dir: &Path,
    manifest: &SkinManifest,
    cache: &SkinCache,
) -> InstalledSkinSummary {
    InstalledSkinSummary {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        author: manifest.author.clone(),
        description: manifest.description.clone(),
        color_scheme: manifest.color_scheme.clone(),
        tokens: manifest.tokens.clone(),
        preview_data_url: preview_for(root, dir, manifest, cache),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Validates a local image and returns it as a `data:` URL.
///
/// Every failure is a stable kebab-case code (registered in
/// `src/features/errors/localize.ts`), never a human sentence.
#[tauri::command]
pub async fn skin_import_asset(path: String) -> Result<SkinAssetPayload, String> {
    tokio::task::spawn_blocking(move || import_asset_blocking(&path))
        .await
        .map_err(|_| "skin-read-failed".to_string())?
}

fn import_asset_blocking(path: &str) -> Result<SkinAssetPayload, String> {
    let metadata = std::fs::metadata(path).map_err(|_| "skin-read-failed".to_string())?;
    if !metadata.is_file() {
        return Err("skin-read-failed".into());
    }
    if metadata.len() == 0 {
        return Err("skin-empty".into());
    }
    if metadata.len() > MAX_ASSET_BYTES {
        return Err("skin-too-large".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "skin-read-failed".to_string())?;
    let format = image::guess_format(&bytes).map_err(|_| "skin-unsupported-format".to_string())?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err("skin-unsupported-format".into()),
    };

    // Header-only probe: dimensions are read without decoding the full raster.
    let reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "skin-unsupported-format".to_string())?;
    if width == 0 || height == 0 {
        return Err("skin-unsupported-format".into());
    }
    if width > MAX_ASSET_DIMENSION || height > MAX_ASSET_DIMENSION {
        return Err("skin-dimension-too-large".into());
    }

    Ok(SkinAssetPayload {
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
        width,
        height,
        bytes: bytes.len() as u64,
    })
}

#[tauri::command]
pub async fn list_installed_skins(
    cache: tauri::State<'_, SkinCache>,
) -> Result<Vec<InstalledSkinSummary>, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = skins_root()?;
        list_blocking(&root, &cache)
    })
    .await
    .map_err(|_| stable("skin-read-failed"))?
}

fn list_blocking(root: &Path, cache: &SkinCache) -> Result<Vec<InstalledSkinSummary>, String> {
    let entries = fs::read_dir(root).map_err(|_| stable("skin-read-failed"))?;
    let mut skins = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        let metadata = match fs::symlink_metadata(&dir) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_dir() || is_link_like(&metadata) {
            continue;
        }
        let loaded = match read_manifest(&dir) {
            Ok(loaded) => loaded,
            Err(_) => continue,
        };
        if dir.file_name().and_then(|name| name.to_str()) != Some(loaded.manifest.id.as_str()) {
            continue;
        }
        skins.push(summary_from(root, &dir, &loaded.manifest, cache));
    }
    skins.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(skins)
}

#[tauri::command]
pub async fn get_skin_bundle(
    skin_id: String,
    cache: tauri::State<'_, SkinCache>,
) -> Result<SkinBundle, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = skins_root()?;
        bundle_blocking(&root, &skin_id, &cache)
    })
    .await
    .map_err(|_| stable("skin-read-failed"))?
}

fn bundle_blocking(root: &Path, skin_id: &str, cache: &SkinCache) -> Result<SkinBundle, String> {
    if !valid_skin_id(skin_id) {
        return Err(stable("skin-id-invalid"));
    }
    if let Some(bundle) = cache.bundle(root, skin_id) {
        return Ok(bundle);
    }
    let dir = root.join(skin_id);
    let metadata = fs::symlink_metadata(&dir).map_err(|_| stable("skin-not-installed"))?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err(stable("skin-not-installed"));
    }
    let loaded = read_manifest(&dir)?;
    let manifest = &loaded.manifest;
    let backdrop_path = safe_join(
        &dir,
        &valid_asset_path(&manifest.assets.backdrop)
            .ok_or_else(|| stable("skin-manifest-invalid"))?,
    )
    .ok_or_else(|| stable("skin-asset-missing"))?;
    let backdrop_bytes = read_limited(&backdrop_path, MAX_ASSET_BYTES)?;
    let backdrop_detected = detect_image(&backdrop_bytes)?;
    let backdrop = asset_payload(&backdrop_bytes, &backdrop_detected);

    let frame = match &manifest.assets.frame {
        Some(raw) => {
            let path = safe_join(
                &dir,
                &valid_asset_path(raw).ok_or_else(|| stable("skin-manifest-invalid"))?,
            )
            .ok_or_else(|| stable("skin-asset-missing"))?;
            let bytes = read_limited(&path, MAX_ASSET_BYTES)?;
            let detected = detect_image(&bytes)?;
            Some(asset_payload(&bytes, &detected))
        }
        None => None,
    };

    let preview = match &manifest.assets.preview {
        Some(raw) => {
            let path = safe_join(
                &dir,
                &valid_asset_path(raw).ok_or_else(|| stable("skin-manifest-invalid"))?,
            )
            .ok_or_else(|| stable("skin-asset-missing"))?;
            let bytes = read_limited(&path, MAX_ASSET_BYTES)?;
            let detected = detect_image(&bytes)?;
            Some(asset_payload(&bytes, &detected))
        }
        None => Some(backdrop.clone()),
    };

    let bundle = SkinBundle {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        author: manifest.author.clone(),
        description: manifest.description.clone(),
        color_scheme: manifest.color_scheme.clone(),
        tokens: manifest.tokens.clone(),
        backdrop,
        frame,
        preview,
    };
    cache.store_bundle(root, bundle.clone());
    Ok(bundle)
}

#[tauri::command]
pub async fn import_skin_pack(
    path: String,
    cache: tauri::State<'_, SkinCache>,
) -> Result<InstalledSkinSummary, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = skins_root()?;
        import_blocking(&root, &path, &cache)
    })
    .await
    .map_err(|_| stable("skin-read-failed"))?
}

fn import_blocking(
    root: &Path,
    archive_path: &str,
    cache: &SkinCache,
) -> Result<InstalledSkinSummary, String> {
    let metadata = fs::metadata(archive_path).map_err(|_| stable("skin-read-failed"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(stable("skin-read-failed"));
    }
    if metadata.len() > MAX_PACK_BYTES {
        return Err(stable("skin-pack-too-large"));
    }
    let archive_bytes = fs::read(archive_path).map_err(|_| stable("skin-read-failed"))?;
    if archive_bytes.len() < 4 || &archive_bytes[..4] != b"PK\x03\x04" {
        return Err(stable("skin-not-zip"));
    }
    let mut archive =
        ZipArchive::new(Cursor::new(archive_bytes)).map_err(|_| stable("skin-not-zip"))?;
    if archive.len() > MAX_PACK_ENTRIES {
        return Err(stable("skin-too-many-entries"));
    }

    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| stable("skin-not-zip"))?;
        if entry.encrypted() {
            return Err(stable("skin-encrypted"));
        }
        if entry.is_dir() || !entry.is_file() {
            return Err(stable("skin-unsafe-entry"));
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(stable("skin-unsafe-entry"));
            }
        }
        let name = entry
            .name()
            .map_err(|_| stable("skin-unsafe-entry"))?
            .to_string();
        if entry.enclosed_name().is_none() || valid_asset_path(&name).is_none() {
            return Err(stable("skin-unsafe-entry"));
        }
        if name == MANIFEST_NAME {
            if entry.size() > MAX_MANIFEST_BYTES {
                return Err(stable("skin-manifest-too-large"));
            }
        } else if !is_image_asset(Path::new(&name)) {
            return Err(stable("skin-unsupported-format"));
        }
        if entry.size() > MAX_ASSET_BYTES && name != MANIFEST_NAME {
            return Err(stable("skin-too-large"));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_PACK_BYTES {
            return Err(stable("skin-pack-too-large"));
        }
        if files.contains_key(&name) {
            return Err(stable("skin-unsafe-entry"));
        }
        let entry_size = entry.size();
        let mut bytes = Vec::with_capacity(entry_size as usize);
        entry
            .by_ref()
            .take(entry_size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| stable("skin-read-failed"))?;
        if bytes.len() as u64 != entry_size {
            return Err(stable("skin-read-failed"));
        }
        files.insert(name, bytes);
    }

    let manifest_raw = files
        .get(MANIFEST_NAME)
        .ok_or_else(|| stable("skin-manifest-invalid"))?
        .clone();
    let manifest = parse_manifest(&manifest_raw)?;
    let referenced = manifest_paths(&manifest);
    let mut detected_assets: Vec<(PathBuf, Vec<u8>, DetectedImage)> = Vec::new();
    for relative in &referenced {
        let key = relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .collect::<Vec<&str>>()
            .join("/");
        let bytes = files
            .get(&key)
            .ok_or_else(|| stable("skin-asset-missing"))?;
        let detected = detect_image(bytes)?;
        detected_assets.push((relative.clone(), bytes.clone(), detected));
    }

    let final_dir = root.join(&manifest.id);
    if final_dir.exists() {
        return Err(stable("skin-already-installed"));
    }
    let staging = root.join(format!(".staging-{}-{}", std::process::id(), now_nanos()));
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&staging).map_err(|_| stable("skin-write-failed"))?;
        fs::write(staging.join(MANIFEST_NAME), &manifest_raw)
            .map_err(|_| stable("skin-write-failed"))?;
        for (relative, bytes, _) in &detected_assets {
            let target = staging.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|_| stable("skin-write-failed"))?;
            }
            fs::write(&target, bytes).map_err(|_| stable("skin-write-failed"))?;
        }
        fs::rename(&staging, &final_dir).map_err(|_| stable("skin-write-failed"))
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    cache.clear();
    Ok(summary_from(root, &final_dir, &manifest, cache))
}

#[tauri::command]
pub async fn export_skin_pack(
    skin_id: String,
    target_path: String,
    cache: tauri::State<'_, SkinCache>,
) -> Result<bool, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = skins_root()?;
        export_blocking(&root, &skin_id, &target_path, &cache)
    })
    .await
    .map_err(|_| stable("skin-export-failed"))?
}

fn export_blocking(
    root: &Path,
    skin_id: &str,
    target_path: &str,
    _cache: &SkinCache,
) -> Result<bool, String> {
    if !valid_skin_id(skin_id) {
        return Err(stable("skin-id-invalid"));
    }
    let dir = root.join(skin_id);
    let metadata = fs::symlink_metadata(&dir).map_err(|_| stable("skin-not-installed"))?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err(stable("skin-not-installed"));
    }
    let loaded = read_manifest(&dir)?;
    let target = PathBuf::from(target_path);
    if !target.is_absolute() {
        return Err(stable("skin-export-failed"));
    }
    let parent = target
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| stable("skin-export-failed"))?;
    let root_canon = root
        .canonicalize()
        .map_err(|_| stable("skin-export-failed"))?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|_| stable("skin-export-failed"))?;
    if parent_canon.starts_with(&root_canon) {
        // Never let an export overwrite the live pack directory or manifest.
        return Err(stable("skin-export-failed"));
    }
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| stable("skin-export-failed"))?;
    let temp = parent.join(format!(".{file_name}.tmp-{}", now_nanos()));

    let result = (|| -> Result<(), String> {
        let file = fs::File::create(&temp).map_err(|_| stable("skin-export-failed"))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        writer
            .start_file(MANIFEST_NAME, options)
            .map_err(|_| stable("skin-export-failed"))?;
        writer
            .write_all(&loaded.raw)
            .map_err(|_| stable("skin-export-failed"))?;
        for relative in manifest_paths(&loaded.manifest) {
            let path = safe_join(&dir, &relative).ok_or_else(|| stable("skin-asset-missing"))?;
            let bytes = read_limited(&path, MAX_ASSET_BYTES)?;
            detect_image(&bytes)?;
            let name = relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(value) => value.to_str(),
                    _ => None,
                })
                .collect::<Vec<&str>>()
                .join("/");
            writer
                .start_file(name, options)
                .map_err(|_| stable("skin-export-failed"))?;
            writer
                .write_all(&bytes)
                .map_err(|_| stable("skin-export-failed"))?;
        }
        let file = writer.finish().map_err(|_| stable("skin-export-failed"))?;
        file.sync_all().map_err(|_| stable("skin-export-failed"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if target.exists() {
        fs::remove_file(&target).map_err(|_| stable("skin-export-failed"))?;
    }
    fs::rename(&temp, &target).map_err(|_| {
        let _ = fs::remove_file(&temp);
        stable("skin-export-failed")
    })?;
    Ok(true)
}

#[tauri::command]
pub async fn delete_skin_pack(
    skin_id: String,
    cache: tauri::State<'_, SkinCache>,
) -> Result<bool, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = skins_root()?;
        delete_blocking(&root, &skin_id, &cache)
    })
    .await
    .map_err(|_| stable("skin-delete-failed"))?
}

fn delete_blocking(root: &Path, skin_id: &str, cache: &SkinCache) -> Result<bool, String> {
    if !valid_skin_id(skin_id) {
        return Err(stable("skin-id-invalid"));
    }
    let dir = root.join(skin_id);
    let metadata = fs::symlink_metadata(&dir).map_err(|_| stable("skin-not-installed"))?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(stable("skin-delete-failed"));
    }
    let root_canon = root
        .canonicalize()
        .map_err(|_| stable("skin-delete-failed"))?;
    let dir_canon = dir
        .canonicalize()
        .map_err(|_| stable("skin-delete-failed"))?;
    if dir_canon.parent() != Some(root_canon.as_path()) {
        return Err(stable("skin-delete-failed"));
    }
    fs::remove_dir_all(&dir_canon).map_err(|_| stable("skin-delete-failed"))?;
    cache.clear();
    Ok(true)
}

#[tauri::command]
pub async fn create_custom_skin_from_image(
    name: String,
    backdrop_path: String,
    frame_path: Option<String>,
    inset_px: u32,
    opacity: f64,
    cache: tauri::State<'_, SkinCache>,
) -> Result<InstalledSkinSummary, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = skins_root()?;
        create_custom_blocking(
            &root,
            &name,
            &backdrop_path,
            frame_path.as_deref(),
            inset_px,
            opacity,
            &cache,
        )
    })
    .await
    .map_err(|_| stable("skin-write-failed"))?
}

fn create_custom_blocking(
    root: &Path,
    name: &str,
    backdrop_path: &str,
    frame_path: Option<&str>,
    inset_px: u32,
    opacity: f64,
    cache: &SkinCache,
) -> Result<InstalledSkinSummary, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 64
        || trimmed.chars().any(|ch| ch.is_control())
    {
        return Err(stable("skin-name-invalid"));
    }
    if inset_px > 32 {
        return Err(stable("skin-inset-invalid"));
    }
    if !opacity.is_finite() || !(0.7..=1.0).contains(&opacity) {
        return Err(stable("skin-opacity-invalid"));
    }

    let backdrop_bytes = read_limited(Path::new(backdrop_path), MAX_ASSET_BYTES)?;
    let backdrop = detect_image(&backdrop_bytes)?;
    let frame = match frame_path {
        Some(path) => {
            let bytes = read_limited(Path::new(path), MAX_ASSET_BYTES)?;
            let detected = detect_image(&bytes)?;
            if detected.format != ImageFormat::Png {
                return Err(stable("skin-frame-png-required"));
            }
            Some((bytes, detected))
        }
        None => None,
    };

    let mut hasher = Sha256::new();
    hasher.update(&backdrop_bytes);
    if let Some((bytes, _)) = &frame {
        hasher.update(bytes);
    }
    hasher.update(trimmed.as_bytes());
    hasher.update(inset_px.to_le_bytes());
    hasher.update(opacity.to_bits().to_le_bytes());
    let digest = hasher.finalize();
    let id = format!("custom-{}", hex::encode(&digest[..6]));

    let final_dir = root.join(&id);
    if final_dir.exists() {
        return Err(stable("skin-already-installed"));
    }
    let backdrop_name = format!("backdrop.{}", backdrop.extension);
    let frame_name = frame
        .as_ref()
        .map(|(_, detected)| format!("frame.{}", detected.extension));

    let mut tokens = BTreeMap::new();
    tokens.insert(
        "--mr-skin-viewport-inset".to_string(),
        format!("{inset_px}px"),
    );
    tokens.insert("--mr-skin-viewport-radius".to_string(), "24px".to_string());
    tokens.insert(
        "--mr-skin-surface-bg".to_string(),
        "transparent".to_string(),
    );
    tokens.insert(
        "--mr-skin-surface-tint".to_string(),
        "var(--sh-card)".to_string(),
    );
    tokens.insert(
        "--mr-skin-surface-opacity".to_string(),
        format!("{opacity:.2}"),
    );
    tokens.insert("--mr-skin-surface-blur".to_string(), "14px".to_string());

    let manifest = SkinManifest {
        schema: 1,
        id: id.clone(),
        name: SkinText::Plain(trimmed.to_string()),
        author: "Moyu".to_string(),
        description: None,
        color_scheme: "both".to_string(),
        tokens,
        assets: SkinAssets {
            backdrop: backdrop_name.clone(),
            frame: frame_name.clone(),
            preview: Some(backdrop_name.clone()),
        },
    };
    #[allow(clippy::question_mark)]
    if let Err(error) = manifest_bytes(&manifest) {
        return Err(error);
    }
    let manifest_raw =
        serde_json::to_vec_pretty(&manifest).map_err(|_| stable("skin-write-failed"))?;
    let staging = root.join(format!(".staging-{}-{}", std::process::id(), now_nanos()));
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&staging).map_err(|_| stable("skin-write-failed"))?;
        fs::write(staging.join(MANIFEST_NAME), &manifest_raw)
            .map_err(|_| stable("skin-write-failed"))?;
        fs::write(staging.join(&backdrop_name), &backdrop_bytes)
            .map_err(|_| stable("skin-write-failed"))?;
        if let (Some(name), Some((bytes, _))) = (&frame_name, &frame) {
            fs::write(staging.join(name), bytes).map_err(|_| stable("skin-write-failed"))?;
        }
        fs::rename(&staging, &final_dir).map_err(|_| stable("skin-write-failed"))
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    cache.clear();
    Ok(summary_from(root, &final_dir, &manifest, cache))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mr-skin-{tag}-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn tiny_png() -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(4, 4, image::Rgba([56, 168, 248, 255]));
        let mut cursor = Cursor::new(Vec::new());
        image
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode png");
        cursor.into_inner()
    }

    fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let file = fs::File::create(path).expect("create zip");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start file");
            writer.write_all(bytes).expect("write entry");
        }
        writer.finish().expect("finish zip");
    }

    fn manifest_json(id: &str, extra_tokens: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schema": 1,
            "id": id,
            "name": { "en": "Test Skin", "zh-CN": "测试皮肤" },
            "author": "Unit Test",
            "description": "A tiny framed skin.",
            "colorScheme": "both",
            "tokens": extra_tokens,
            "assets": { "backdrop": "backdrop.png", "preview": "backdrop.png" }
        }))
        .expect("manifest json")
    }

    #[test]
    fn rejects_missing_file() {
        assert_eq!(
            import_asset_blocking("definitely-not-a-file.png").unwrap_err(),
            "skin-read-failed"
        );
    }

    #[test]
    fn rejects_non_image_payload() {
        let dir = unique_dir("non-image");
        let path = dir.join("not-an-image.png");
        fs::write(&path, b"not an image at all").expect("write");
        let error = import_asset_blocking(path.to_str().expect("utf8")).unwrap_err();
        assert_eq!(error, "skin-unsupported-format");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn accepts_small_png() {
        let dir = unique_dir("small-png");
        let path = dir.join("tiny.png");
        fs::write(&path, tiny_png()).expect("write");
        let payload = import_asset_blocking(path.to_str().expect("utf8")).expect("valid png");
        assert_eq!((payload.width, payload.height), (4, 4));
        assert!(payload.data_url.starts_with("data:image/png;base64,"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_exports_and_lists_a_valid_pack() {
        let root = unique_dir("roundtrip");
        let cache = SkinCache::default();
        let archive = root.join("valid.moyuskin");
        write_zip(
            &archive,
            &[
                (
                    "skin.json",
                    manifest_json(
                        "test-skin",
                        json!({
                            "--mr-skin-viewport-inset": "20px",
                            "--mr-skin-surface-opacity": "0.82",
                            "--mr-skin-surface-tint": "var(--sh-card)",
                            "--mr-skin-canvas-bg": "#102030"
                        }),
                    ),
                ),
                ("backdrop.png", tiny_png()),
            ],
        );
        let summary = import_blocking(&root, archive.to_str().unwrap(), &cache).expect("import");
        assert_eq!(summary.id, "test-skin");
        assert!(summary.preview_data_url.is_some());
        assert_eq!(summary.tokens["--mr-skin-viewport-inset"], "20px");

        let listed = list_blocking(&root, &cache).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "test-skin");

        let bundle = bundle_blocking(&root, "test-skin", &cache).expect("bundle");
        assert_eq!(bundle.backdrop.width, 4);
        assert!(bundle
            .backdrop
            .data_url
            .starts_with("data:image/png;base64,"));
        assert_eq!(bundle.tokens["--mr-skin-surface-opacity"], "0.82");

        let export = root.join("exported.moyuskin");
        export_blocking(&root, "test-skin", export.to_str().unwrap(), &cache).expect("export");
        assert!(export.is_file());
        let fresh_root = unique_dir("roundtrip-fresh");
        let fresh_cache = SkinCache::default();
        let reimported =
            import_blocking(&fresh_root, export.to_str().unwrap(), &fresh_cache).expect("reimport");
        assert_eq!(reimported.id, "test-skin");
        assert!(delete_blocking(&root, "test-skin", &cache).expect("delete"));
        assert!(bundle_blocking(&root, "test-skin", &cache).is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&fresh_root);
    }

    #[test]
    fn rejects_path_traversal_and_symlinks() {
        let root = unique_dir("traversal");
        let cache = SkinCache::default();
        let traversal = root.join("traversal.moyuskin");
        write_zip(
            &traversal,
            &[
                ("skin.json", manifest_json("evil-skin", json!({}))),
                ("../evil.png", tiny_png()),
            ],
        );
        let error = import_blocking(&root, traversal.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-unsafe-entry"));

        let symlink = root.join("symlink.moyuskin");
        let file = fs::File::create(&symlink).expect("create symlink zip");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .system(zip::System::Unix)
            .external_attributes(0o120777 << 16);
        writer.start_file("link.png", options).expect("start link");
        writer.write_all(b"target").expect("write link");
        writer.finish().expect("finish link zip");
        let error = import_blocking(&root, symlink.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-unsafe-entry"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_svg_oversize_and_bad_tokens() {
        let root = unique_dir("invalid");
        let cache = SkinCache::default();
        let svg = root.join("svg.moyuskin");
        write_zip(
            &svg,
            &[
                ("skin.json", manifest_json("svg-skin", json!({}))),
                (
                    "backdrop.svg",
                    b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"
                        .to_vec(),
                ),
            ],
        );
        let error = import_blocking(&root, svg.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-unsupported-format"));

        let huge = root.join("huge.moyuskin");
        let large = image::RgbaImage::from_pixel(4097, 1, image::Rgba([0, 0, 0, 255]));
        let mut cursor = Cursor::new(Vec::new());
        large
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("large png");
        write_zip(
            &huge,
            &[
                ("skin.json", manifest_json("huge-skin", json!({}))),
                ("backdrop.png", cursor.into_inner()),
            ],
        );
        let error = import_blocking(&root, huge.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-dimension-too-large"));

        let injection = root.join("injection.moyuskin");
        write_zip(
            &injection,
            &[
                (
                    "skin.json",
                    manifest_json(
                        "inject-skin",
                        json!({
                            "--mr-skin-surface-tint": "red; background:url(https://evil.example/x.png)"
                        }),
                    ),
                ),
                ("backdrop.png", tiny_png()),
            ],
        );
        let error = import_blocking(&root, injection.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-token-invalid"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_reserved_ids_and_duplicate_installs() {
        let root = unique_dir("ids");
        let cache = SkinCache::default();
        let reserved = root.join("reserved.moyuskin");
        write_zip(
            &reserved,
            &[
                ("skin.json", manifest_json("ink", json!({}))),
                ("backdrop.png", tiny_png()),
            ],
        );
        let error = import_blocking(&root, reserved.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-id-invalid"));

        let valid = root.join("valid.moyuskin");
        write_zip(
            &valid,
            &[
                ("skin.json", manifest_json("dupe-skin", json!({}))),
                ("backdrop.png", tiny_png()),
            ],
        );
        import_blocking(&root, valid.to_str().unwrap(), &cache).expect("first import");
        let error = import_blocking(&root, valid.to_str().unwrap(), &cache).unwrap_err();
        assert!(error.contains("skin-already-installed"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_and_deletes_a_custom_skin() {
        let root = unique_dir("custom");
        let cache = SkinCache::default();
        let backdrop = root.join("backdrop.png");
        fs::write(&backdrop, tiny_png()).expect("write backdrop");
        let summary = create_custom_blocking(
            &root,
            "My Frame",
            backdrop.to_str().unwrap(),
            Some(backdrop.to_str().unwrap()),
            18,
            0.88,
            &cache,
        )
        .expect("custom skin");
        assert!(summary.id.starts_with("custom-"));
        assert_eq!(summary.color_scheme, "both");
        let bundle = bundle_blocking(&root, &summary.id, &cache).expect("bundle");
        assert_eq!(bundle.tokens["--mr-skin-viewport-inset"], "18px");
        assert_eq!(bundle.tokens["--mr-skin-surface-opacity"], "0.88");
        assert!(bundle.frame.is_some());
        assert!(delete_blocking(&root, &summary.id, &cache).expect("delete custom"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn custom_skin_validates_name_inset_opacity_and_frame_format() {
        let root = unique_dir("custom-invalid");
        let cache = SkinCache::default();
        let backdrop = root.join("backdrop.png");
        fs::write(&backdrop, tiny_png()).expect("write backdrop");
        let path = backdrop.to_str().unwrap();
        assert!(
            create_custom_blocking(&root, "  ", path, None, 10, 0.8, &cache)
                .unwrap_err()
                .contains("skin-name-invalid")
        );
        assert!(
            create_custom_blocking(&root, "Name", path, None, 33, 0.8, &cache)
                .unwrap_err()
                .contains("skin-inset-invalid")
        );
        assert!(
            create_custom_blocking(&root, "Name", path, None, 10, 0.69, &cache)
                .unwrap_err()
                .contains("skin-opacity-invalid")
        );
        let jpeg = root.join("frame.jpg");
        let image = image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]));
        image.save(&jpeg).expect("save jpeg");
        assert!(create_custom_blocking(
            &root,
            "Name",
            path,
            Some(jpeg.to_str().unwrap()),
            10,
            0.8,
            &cache
        )
        .unwrap_err()
        .contains("skin-frame-png-required"));
        let _ = fs::remove_dir_all(&root);
    }
}
