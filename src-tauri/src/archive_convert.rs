//! 通用 RAR/CBR -> Stored CBZ 转码。
//!
//! OPDS 已有的 `convert_rar_to_cbz` 保持为唯一解压实现；本模块负责嗅探、
//! 目标命名、源目录/数据目录回退与导入前的 `.cbz` 准备。
//! 输出策略：优先在源文件同目录生成 `<stem>-converted.cbz`，保留原文件；
//! 源目录不可写时回退到数据目录 `converted/`。绝不删除原 `.rar/.cbr`。

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::source::{BackendError, ImageSource as _};

const ZIP_LOCAL: &[u8] = &[0x50, 0x4B, 0x03, 0x04];
const ZIP_EOCD: &[u8] = &[0x50, 0x4B, 0x05, 0x06];
const ZIP_SPAN: &[u8] = &[0x50, 0x4B, 0x07, 0x08];
const RAR: &[u8] = b"Rar!";
const SEVEN_Z: &[u8] = &[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    Zip,
    Rar,
    SevenZ,
    Other,
}

pub(crate) fn sniff_archive(path: &Path) -> Result<ArchiveKind, BackendError> {
    let mut file = File::open(path)?;
    let mut head = [0u8; 8];
    let mut filled = 0usize;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) => return Err(BackendError::Io(error.to_string())),
        }
    }
    let head = &head[..filled];
    if head.starts_with(ZIP_LOCAL) || head.starts_with(ZIP_EOCD) || head.starts_with(ZIP_SPAN) {
        Ok(ArchiveKind::Zip)
    } else if head.starts_with(RAR) {
        Ok(ArchiveKind::Rar)
    } else if head.starts_with(SEVEN_Z) {
        Ok(ArchiveKind::SevenZ)
    } else {
        Ok(ArchiveKind::Other)
    }
}

pub(crate) fn is_convertible_archive_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("rar") | Some("cbr")
    )
}

/// 同目录已存在的 `<stem>-converted.cbz`（且可读）时返回该路径。
///
/// 目录重扫只导入转换产物，不再对原 `.rar/.cbr` 重复转码；
/// 显式导入原文件时 `prepare_import_cbz` 也会直接复用这个结果。
pub(crate) fn existing_converted_sibling(src: &Path) -> Option<PathBuf> {
    if !is_convertible_archive_path(src) {
        return None;
    }
    let dir = src.parent()?;
    let candidate = dir.join(format!("{}-converted.cbz", safe_stem(src)));
    (candidate.is_file() && valid_cbz(&candidate)).then_some(candidate)
}

/// 准备一个可被本地书库读取的 `.cbz`。
///
/// - 正常 ZIP/CBZ：原样返回；
/// - RAR/CBR 或伪装成 `.cbz/.zip` 的 RAR：转码后返回新 `.cbz`；
/// - 7z/未知内容：失败关闭并给出稳定错误码；
/// - 目录/PDF：原样返回（由现有书库流程处理）。
pub(crate) fn prepare_import_cbz(
    src: &Path,
    converted_root: &Path,
) -> Result<PathBuf, BackendError> {
    if src.is_dir() || crate::source::is_pdf_path(src) {
        return Ok(src.to_path_buf());
    }
    let kind = sniff_archive(src)?;
    if kind == ArchiveKind::Zip && crate::source::is_archive_path(src) {
        return Ok(src.to_path_buf());
    }
    if kind == ArchiveKind::SevenZ {
        return Err(BackendError::Zip(
            "该文件实际是 7z 压缩包，请转换为标准无密码 ZIP/CBZ 后再导入（archive-disguised-7z）"
                .into(),
        ));
    }
    if kind == ArchiveKind::Other {
        if is_convertible_archive_path(src) {
            return Err(BackendError::Zip(
                "不是有效的 RAR/CBR 压缩包（opds-cbr-failed）".into(),
            ));
        }
        return Err(BackendError::Zip(
            "该文件不是有效的 ZIP/CBZ 压缩包，请转为标准无密码 ZIP/CBZ（archive-not-zip）".into(),
        ));
    }

    let stem = safe_stem(src);
    let target = source_dir_target(src, &stem)
        .unwrap_or_else(|| converted_root_target(src, &stem, converted_root));
    if valid_cbz(&target) && is_fresh(&target, src) {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = target.with_file_name(format!(
        ".{stem}-convert-{}-{}.cbz",
        std::process::id(),
        nanos()
    ));
    let result = (|| {
        match kind {
            ArchiveKind::Rar => crate::opds::convert_rar_to_cbz(src, &temp)?,
            ArchiveKind::Zip => {
                fs::copy(src, &temp)?;
            }
            ArchiveKind::SevenZ | ArchiveKind::Other => unreachable!(),
        }
        if !valid_cbz(&temp) {
            return Err(BackendError::Zip(
                "转码结果没有可读图片（opds-cbr-failed）".into(),
            ));
        }
        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&temp, &target)?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn source_dir_target(src: &Path, stem: &str) -> Option<PathBuf> {
    let dir = src.parent()?;
    if !dir_writable(dir) {
        return None;
    }
    for index in 1..=50u32 {
        let name = if index == 1 {
            format!("{stem}-converted.cbz")
        } else {
            format!("{stem}-converted-{index}.cbz")
        };
        let path = dir.join(name);
        if !path.exists() || valid_cbz(&path) {
            return Some(path);
        }
    }
    None
}

fn converted_root_target(src: &Path, stem: &str, root: &Path) -> PathBuf {
    let digest = hex::encode(Sha256::digest(src.to_string_lossy().as_bytes()));
    root.join(format!("{stem}-{}.cbz", &digest[..12]))
}

fn valid_cbz(path: &Path) -> bool {
    crate::source::open_source(path)
        .map(|handle| handle.page_count().unwrap_or(0) > 0)
        .unwrap_or(false)
}

fn is_fresh(target: &Path, src: &Path) -> bool {
    let Ok(target_meta) = fs::metadata(target) else {
        return false;
    };
    let Ok(src_meta) = fs::metadata(src) else {
        return false;
    };
    match (target_meta.modified(), src_meta.modified()) {
        (Ok(target), Ok(source)) => target >= source,
        _ => false,
    }
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".moyu-write-{}-{}", std::process::id(), nanos()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn safe_stem(src: &Path) -> String {
    let raw = src
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("book");
    let mut cleaned: String = raw
        .chars()
        .filter(|ch| {
            !ch.is_control() && !matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        .take(80)
        .collect();
    cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "book".into()
    } else {
        cleaned
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}
