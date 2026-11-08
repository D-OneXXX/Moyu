//! Skin artwork intake (Task 7).
//!
//! The production CSP fixes `img-src 'self' data:`. A user-selected artwork
//! therefore may only reach the webview as a `data:` URL, and only after the
//! backend has validated its magic bytes and decoded dimensions. Nothing is
//! fetched from the network and nothing is written outside the app.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageFormat;
use serde::Serialize;
use std::io::Cursor;

/// Hard ceiling for a decoration asset. Keeps a data URL (≈ +33 %) small
/// enough to stay in memory for a long session.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 4K is already generous for a corner companion or a window frame.
const MAX_DIMENSION: u32 = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinAssetPayload {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Validates a local image and returns it as a `data:` URL.
///
/// Every failure is a stable kebab-case code (registered in
/// `src/features/errors/localize.ts`), never a human sentence.
#[tauri::command]
pub async fn skin_import_asset(path: String) -> Result<SkinAssetPayload, String> {
    tokio::task::spawn_blocking(move || import_blocking(&path))
        .await
        .map_err(|_| "skin-read-failed".to_string())?
}

fn import_blocking(path: &str) -> Result<SkinAssetPayload, String> {
    let metadata = std::fs::metadata(path).map_err(|_| "skin-read-failed".to_string())?;
    if !metadata.is_file() {
        return Err("skin-read-failed".into());
    }
    if metadata.len() == 0 {
        return Err("skin-empty".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("skin-too-large".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "skin-read-failed".to_string())?;
    let format = image::guess_format(&bytes).map_err(|_| "skin-unsupported-format".to_string())?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
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
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err("skin-dimension-too-large".into());
    }

    Ok(SkinAssetPayload {
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
        width,
        height,
        bytes: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_file() {
        assert_eq!(
            import_blocking("definitely-not-a-file.png").unwrap_err(),
            "skin-read-failed"
        );
    }

    #[test]
    fn rejects_non_image_payload() {
        let dir = std::env::temp_dir().join("mr-skin-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("not-an-image.png");
        std::fs::write(&path, b"not an image at all").expect("write");
        let error = import_blocking(path.to_str().expect("utf8")).unwrap_err();
        assert_eq!(error, "skin-unsupported-format");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn accepts_small_png() {
        let dir = std::env::temp_dir().join("mr-skin-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("tiny.png");
        let image = image::RgbaImage::from_pixel(4, 4, image::Rgba([56, 168, 248, 255]));
        image.save(&path).expect("save png");
        let payload = import_blocking(path.to_str().expect("utf8")).expect("valid png");
        assert_eq!((payload.width, payload.height), (4, 4));
        assert!(payload.data_url.starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_file(&path);
    }
}
