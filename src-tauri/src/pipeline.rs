//! 图片管线：按需解码单页 + 按显示尺寸降采样 + JPEG 重编码。
//!
//! 约束（预算制，写入内存前就控制大小）：
//! - 解码只针对单页原始字节（`source` 已保证流式单页读）；
//! - 若请求 `max_width/max_height`（前端视口尺寸），先算目标尺寸再做
//!   `thumbnail` 一步式降采样，不保留全分辨率中间图；
//! - 输出统一为 JPEG dataURL（前端契约要求 base64 dataURL；JPEG 体积可控）。
//! - 缩略图走同样的管线（目标边 ≤ `max_size`，默认 240px）。
//!
//! 超高分辨率条漫防线（20000–65000px 高的未切分巨图）：
//! - WebView2 单张纹理高度上限约 16384px，整图直送 `<img>` 会显存溢出成黑/白块；
//! - 条漫路径走**先切后缩**（按源图纵向切带 → 逐带缩放到显示宽 → 输出连续切片），
//!   不再额外持有「整图缩放副本」：相比旧实现省掉一份同尺寸副本，
//!   但仍需同时存活「一张显示宽工作栅格 + 一条源带」，长图 JPEG 走 IDCT 缩放解码；
//! - 单页/双页路径兜底：缩放后仍超 `MAX_SAFE_TEXTURE_H` 就等比再缩小，
//!   宁可变小也不能把超限纹理交给前端。

use std::sync::{Condvar, Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::ImageFormat;

use crate::source::{BackendError, RawPage};

/// 条漫切片的目标显示高度（设备像素）；前后端共享同一常量保证边界一致。
pub const WEBTOON_TILE_H: u32 = 2048;
/// 超过该源高度视为"长图"：解码必须走按显示宽度缩放路径。
pub const TALL_IMAGE_H: u32 = 8000;

/// **WebView2 单张纹理的安全高度上限**（设备像素）。
///
/// 来源与理由：WebView2（Chromium / ANGLE / D3D 后端）的单张纹理维度上限约为
/// **16384px**；把这个上限当成"可用高度"在超高图上会触发显存分配失败，
/// 前端表现为整块黑/白图（条漫 20000–65000px 高时必现）。
/// 这里取上限的**一半**（8192）作为安全线：
/// 1. 给缩放取整留余量，避免正好压线；
/// 2. 兼容不同 GPU/驱动上更低的实际上限；
/// 3. 前端若再放大一次也不会越过 16384。
pub const MAX_SAFE_TEXTURE_H: u32 = 8192;

/// **单片源高度上限**（源图坐标系，单位：像素行）。
///
/// 来源与理由：条漫必须"先切后缩"——按源图纵向切带、逐带缩放到显示宽度，
/// 而不是"整图解码 → 整体缩放 → 再切"（后者峰值内存 ≈ 原图 + 整图缩放副本 +
/// 切片栅格，1600×65000 的图仅缩放副本就 ~300MB）。
/// 4096 行的源带在 1600px 宽时约 19MB（RGB888），缩完立刻释放，
/// 峰值内存只与带宽相关、与总图高度无关；同时单片输出高度也不会超过它。
pub const MAX_SLICE_H: u32 = 4096;

/// 源图像素数上限：防御畸形/恶意头部导致的巨额分配（返回错误而不是 OOM 崩溃）。
///
/// 注意：JPEG 有 IDCT 缩放解码、非交错 PNG 有逐带解码，**WebP / GIF / 交错 PNG
/// 只能整图解码**——这些格式的峰值 ≈ 源栅格（RGB 3B/px、RGBA 4B/px）+ 输出栅格，
/// 上限由本常量兜住（160M px × 4B ≈ 640MB，仅极端输入才会触及）。
/// 解码后立刻转 RGB 再缩放（见 `render_raw_with`），不再额外分配一份 RGBA 缩放副本。
const MAX_SOURCE_PIXELS: u64 = 160_000_000;

/// **整图展开并发上限**（进程级）。
///
/// WebP / GIF / 交错 PNG / 非长图 PNG 等没有逐带解码路径，只能一次性把源图
/// 展开成完整 RGBA 栅格；单张 160M px 的极端页面峰值可达数百 MB。多页同时
/// 渲染时若不设闸，内存会按页数线性叠加（审计中的 OOM 风险）。
/// 这里只允许 2 个重解码同时进行，其余线程在闸门处等待。
pub(crate) const HEAVY_DECODE_SEMAPHORE: usize = 2;

/// 进入闸门的源图像素阈值：小于 16M px（约 4096×4096）的展开很快、
/// 峰值可控，直接放行，避免小图被无谓排队。
const HEAVY_DECODE_MIN_PIXELS: u64 = 16_000_000;

/// 进程级重解码闸门（`Mutex<usize>` + `Condvar` + RAII 名额）。
///
/// 毒化容错：任何持有者 panic 后锁会中毒，但名额在 `Drop` 里仍会归还，
/// 后续 `lock()` 一律 `into_inner()` 继续使用，绝不因为一次解码 panic
/// 就把整个阅读器卡死。
struct HeavyDecodeGate {
    active: Mutex<usize>,
    released: Condvar,
}

impl HeavyDecodeGate {
    fn new() -> Self {
        Self {
            active: Mutex::new(0),
            released: Condvar::new(),
        }
    }

    /// 持有名额直到返回的 permit 被 drop；`pixels` 低于阈值时返回 `None`
    /// （不触碰任何名额，调用方直接放行）。
    fn acquire(&self, pixels: u64) -> Option<HeavyDecodePermit<'_>> {
        if pixels < HEAVY_DECODE_MIN_PIXELS {
            return None;
        }
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        while *active >= HEAVY_DECODE_SEMAPHORE {
            active = self
                .released
                .wait(active)
                .unwrap_or_else(|e| e.into_inner());
        }
        *active += 1;
        Some(HeavyDecodePermit { gate: self })
    }
}

static HEAVY_DECODE_GATE: OnceLock<HeavyDecodeGate> = OnceLock::new();

fn heavy_decode_gate() -> &'static HeavyDecodeGate {
    HEAVY_DECODE_GATE.get_or_init(HeavyDecodeGate::new)
}

/// 申请重解码名额；返回 `None` 表示图片低于阈值、无需排队。
fn acquire_heavy_decode(pixels: u64) -> Option<HeavyDecodePermit<'static>> {
    heavy_decode_gate().acquire(pixels)
}

/// RAII 重解码名额：drop 时归还并唤醒一个等待者。
struct HeavyDecodePermit<'a> {
    gate: &'a HeavyDecodeGate,
}

impl Drop for HeavyDecodePermit<'_> {
    fn drop(&mut self) {
        let mut active = self.gate.active.lock().unwrap_or_else(|e| e.into_inner());
        *active = active.saturating_sub(1);
        drop(active);
        self.gate.released.notify_one();
    }
}

/// 源图像素数（u64，避免 32 位溢出）。
fn pixel_count(w: u32, h: u32) -> u64 {
    u64::from(w).saturating_mul(u64::from(h))
}

/// Web requests materialize a complete logical page at once. Bound both the
/// tile plan and the accumulated encoded output before caching any of it.
pub(crate) const MAX_WEBTOON_WEB_TILES: u32 = 1024;
pub(crate) const MAX_WEBTOON_WEB_ENCODED_BYTES: usize = 128 * 1024 * 1024;

/// 条漫切片数按实际输出高度计算；只缩小、不放大，与前端一致。
pub fn webtoon_tile_count(orig_w: u32, orig_h: u32, render_w: u32) -> u32 {
    if orig_w == 0 || orig_h == 0 || render_w == 0 {
        return 1;
    }
    let (_, height) = fit_size(orig_w, orig_h, Some(render_w), None);
    height.div_ceil(WEBTOON_TILE_H).max(1)
}

/// 解码后待缓存/待返回的成品图（已是最终输出尺寸）。
/// `bytes` = JPEG 成品字节（磁盘缓存直接落盘用）；`data_url` 前端契约不变；
/// `orig_width/orig_height` = 源图原始尺寸（条漫建议/切片布局用），进内存缓存时保留（很小）。
#[derive(Debug, Clone)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub orig_width: u32,
    pub orig_height: u32,
    pub mime: String,
    pub data_url: String,
    pub bytes: Vec<u8>,
}

impl RenderedPage {
    /// 按需把成品字节编码为 data URL（请求路径用）。
    ///
    /// 条漫 `render_webtoon_tiles` 整页物化只保留 bytes + dims，不预生成
    /// base64；`get_webtoon_tile` 仅在返回所请求切片时调用本方法编码一次，
    /// 前端 `PageImage.dataUrl` 的内容与契约保持不变。
    pub fn data_url_from_bytes(&self) -> String {
        format!("data:{};base64,{}", self.mime, B64.encode(&self.bytes))
    }
}

fn decoded_format(raw: &RawPage) -> Result<ImageFormat, BackendError> {
    // 先信扩展名（zip 条目名可信度高），无扩展名再嗅探魔数。
    let by_ext = match raw.ext.as_str() {
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::WebP),
        _ => None,
    };
    if let Some(fmt) = by_ext {
        return Ok(fmt);
    }
    Ok(image::guess_format(&raw.bytes)?)
}

/// 按目标框计算等比缩放尺寸（任一边超限才缩小；不放大）。
pub fn fit_size(src_w: u32, src_h: u32, max_w: Option<u32>, max_h: Option<u32>) -> (u32, u32) {
    if src_w == 0 || src_h == 0 {
        return (1, 1);
    }
    let mut w = src_w as f64;
    let mut h = src_h as f64;
    if let Some(mw) = max_w {
        if mw > 0 && w > mw as f64 {
            let k = mw as f64 / w;
            w *= k;
            h *= k;
        }
    }
    if let Some(mh) = max_h {
        if mh > 0 && h > mh as f64 {
            let k = mh as f64 / h;
            w *= k;
            h *= k;
        }
    }
    (w.max(1.0).round() as u32, h.max(1.0).round() as u32)
}

/// 整数版 `round(x * num / den)`（四舍五入；den = 0 时返回 0）。
fn mul_round(x: u64, num: u64, den: u64) -> u64 {
    if den == 0 {
        return 0;
    }
    (x * num + den / 2) / den
}

/// 读取并校验源图尺寸：0 尺寸 / 像素数超限 / 头解析失败 → `BackendError`（不 panic）。
pub(crate) fn source_dimensions(raw: &RawPage) -> Result<(u32, u32), BackendError> {
    let dims = image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
        .with_guessed_format()?
        .into_dimensions()
        .map_err(|e| BackendError::Decode(format!("读取图片尺寸失败：{e}")))?;
    let (w, h) = (dims.0, dims.1);
    if w == 0 || h == 0 {
        return Err(BackendError::Decode(format!("图片尺寸非法（{w}×{h}）")));
    }
    if (w as u64).saturating_mul(h as u64) > MAX_SOURCE_PIXELS {
        return Err(BackendError::Decode(format!(
            "图片尺寸过大（{w}×{h}），超过解码上限 {MAX_SOURCE_PIXELS} 像素"
        )));
    }
    Ok((w, h))
}

/// `DynamicImage` → `RgbImage`；RGB8 直接**拿走**缓冲区（避免整图克隆）。
fn into_rgb(img: image::DynamicImage) -> image::RgbImage {
    match img {
        image::DynamicImage::ImageRgb8(v) => v,
        image::DynamicImage::ImageRgba8(v) => {
            // Compact in place: converting a large RGBA page with `to_rgb8`
            // would keep both the original and the new raster alive at once.
            let (width, height) = v.dimensions();
            let mut bytes = v.into_raw();
            let pixels = bytes.len() / 4;
            for i in 0..pixels {
                let src = i * 4;
                let dst = i * 3;
                bytes[dst] = bytes[src];
                bytes[dst + 1] = bytes[src + 1];
                bytes[dst + 2] = bytes[src + 2];
            }
            bytes.truncate(pixels * 3);
            image::RgbImage::from_raw(width, height, bytes)
                .expect("RGBA and RGB dimensions must have equal pixel counts")
        }
        other => other.to_rgb8(),
    }
}

/// 纹理安全目标尺寸：任一边超过 `MAX_SAFE_TEXTURE_H` 就**等比**缩小。
///
/// 宁可变小，也不能把超限纹理交给前端（WebView2 会渲染成黑/白块）；
/// 等比缩放保证与 `orig_width/orig_height` 的宽高比关系保持正确。
fn safe_fit(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (1, 1);
    }
    if w <= MAX_SAFE_TEXTURE_H && h <= MAX_SAFE_TEXTURE_H {
        return (w, h);
    }
    let k = MAX_SAFE_TEXTURE_H as f64 / w.max(h) as f64;
    (
        ((w as f64 * k).round() as u32).clamp(1, MAX_SAFE_TEXTURE_H),
        ((h as f64 * k).round() as u32).clamp(1, MAX_SAFE_TEXTURE_H),
    )
}

/// 纹理安全兜底：任一边超过 `MAX_SAFE_TEXTURE_H` 就**等比**再缩小。
fn clamp_texture_safe(rgb: image::RgbImage) -> Result<image::RgbImage, BackendError> {
    let (w, h) = (rgb.width(), rgb.height());
    if w == 0 || h == 0 {
        return Err(BackendError::Decode("渲染结果尺寸为零".into()));
    }
    let (nw, nh) = safe_fit(w, h);
    if nw == w && nh == h {
        return Ok(rgb);
    }
    Ok(resize_rgb_bounded(&rgb, nw, nh))
}

/// `imageops::resize` 的 Rgba32F 中间副本（16B/px）预算。
///
/// `image::imageops::resize` 内部先做一遍垂直采样并整页保留 **f32 RGBA** 中间栅格
/// （源宽 × 输出高 × 16B）：2000×9000 的 RGBA 源渲染到 1820×8192 时实测多分配
/// 262MB、峰值 379MB；160M px 的极端输入会放大到 GB 级。
/// 超过本预算的降采样改用盒式面积平均（只分配输出栅格）。
const RESIZE_INTERMEDIATE_BUDGET: usize = 96 * 1024 * 1024;

/// 有界降采样：
/// - 中间副本在预算内 → `imageops::resize`（Triangle），既有输出逐像素不变；
/// - 超预算 → `imageops::thumbnail`（盒式面积平均）：只分配输出栅格，无整页
///   f32 中间副本，也不会像「分带缩放」那样在接缝处引入亚像素相位差
///   （面板硬边会被切成深浅不一的行）。
fn resize_rgb_bounded(src: &image::RgbImage, tw: u32, th: u32) -> image::RgbImage {
    let (sw, sh) = (src.width(), src.height());
    if sw == 0 || sh == 0 || tw == 0 || th == 0 {
        return image::imageops::resize(
            src,
            tw.max(1),
            th.max(1),
            image::imageops::FilterType::Triangle,
        );
    }
    let intermediate = u64::from(sw) * u64::from(th) * 16;
    if intermediate <= RESIZE_INTERMEDIATE_BUDGET as u64 {
        return image::imageops::resize(src, tw, th, image::imageops::FilterType::Triangle);
    }
    image::imageops::thumbnail(src, tw, th)
}

/// 解码单页并按需降采样，重编码为 JPEG dataURL。
///
/// - `image` 0.25 的 JPEG 走 zune-jpeg（快）；降采样用 Triangle 滤镜
///   （比默认 Lanczos3 快数倍，阅读视口下画质差异不可辨）；
/// - **长图保护**：源高 > 8000px 且为 JPEG 且请求了目标宽时，走 jpeg-decoder
///   的 IDCT 缩放解码（按显示宽度），全分辨率栅格从不进内存；
/// - **纹理保护**：结果超过 `MAX_SAFE_TEXTURE_H` 时等比再缩一次（宁可变小也不给前端超限纹理）；
/// - 成品字节同时返回，供磁盘渲染缓存落盘。
pub fn render_raw(
    raw: &RawPage,
    max_w: Option<u32>,
    max_h: Option<u32>,
) -> Result<RenderedPage, BackendError> {
    render_raw_with(raw, max_w, max_h, true)
}

/// Bytes-only variant for the Web data plane. Desktop keeps `render_raw` and
/// its base64 `data_url`; this path avoids the extra 4/3 memory copy.
pub(crate) fn render_raw_asset(
    raw: &RawPage,
    max_w: Option<u32>,
    max_h: Option<u32>,
    encode_data_url: bool,
) -> Result<RenderedPage, BackendError> {
    render_raw_with(raw, max_w, max_h, encode_data_url)
}

fn render_raw_with(
    raw: &RawPage,
    max_w: Option<u32>,
    max_h: Option<u32>,
    encode_data_url: bool,
) -> Result<RenderedPage, BackendError> {
    let fmt = decoded_format(raw)?;
    let (sw, sh) = source_dimensions(raw)?;

    let tall_jpeg = sh > TALL_IMAGE_H && fmt == ImageFormat::Jpeg && max_w.unwrap_or(0) > 0;
    if tall_jpeg {
        return render_tall_jpeg_with(raw, sw, sh, max_w, max_h, encode_data_url);
    }

    // 非长图 JPEG 的这条路径是**整图解码**（含 WebP / GIF / 交错 PNG）：
    // 16M px 以上进入进程级闸门，最多 2 张同时展开。
    let _heavy_decode = acquire_heavy_decode(pixel_count(sw, sh));
    let img = image::load_from_memory_with_format(&raw.bytes, fmt)?;
    // 目标尺寸直接落到纹理安全线内：避免先缩放成超限大图再压扁（省一份峰值内存）。
    let (tw, th) = fit_size(sw, sh, max_w, max_h);
    let (fw, fh) = safe_fit(tw, th);
    // 8 位 RGB/RGBA 先原地转 RGB 再缩放：非 JPEG 只能整图解码，旧顺序
    // 「缩放成 RGBA 副本 → 再转 RGB」会让 4B/px 的副本和输出同时存活；
    // 灰度/16 位/调色板仍保持「先缩放再转 RGB」，避免整图 3B/px 转换副本。
    let rgb = if matches!(
        img,
        image::DynamicImage::ImageRgb8(_) | image::DynamicImage::ImageRgba8(_)
    ) {
        let rgb = into_rgb(img);
        if fw == sw && fh == sh {
            rgb
        } else {
            resize_rgb_bounded(&rgb, fw, fh)
        }
    } else {
        let scaled = if fw == sw && fh == sh {
            img
        } else {
            img.resize_exact(fw, fh, image::imageops::FilterType::Triangle)
        };
        into_rgb(scaled)
    };
    finish_render_with(rgb, sw, sh, encode_data_url)
}

/// 长图专用：IDCT 缩放解码到不超过目标宽的最大 1/2^k 档，再精确缩放到目标尺寸。
pub fn render_tall_jpeg(
    raw: &RawPage,
    sw: u32,
    sh: u32,
    max_w: Option<u32>,
    max_h: Option<u32>,
) -> Result<RenderedPage, BackendError> {
    render_tall_jpeg_with(raw, sw, sh, max_w, max_h, true)
}

fn render_tall_jpeg_with(
    raw: &RawPage,
    sw: u32,
    sh: u32,
    max_w: Option<u32>,
    max_h: Option<u32>,
    encode_data_url: bool,
) -> Result<RenderedPage, BackendError> {
    let (tw, th) = fit_size(sw, sh, max_w, max_h);
    // 纹理安全兜底先算目标尺寸：直接缩到安全尺寸，不生成整高副本。
    let (fw, fh) = safe_fit(tw, th);
    let raster = decode_tall_jpeg_raster(raw, tw, tall_want_h(sw, sh, tw), pixel_count(sw, sh))?;
    // 缩放解码的结果可能比目标略大（档位 1/2^k），精确缩到位。
    let rgb = if raster.width() == fw && raster.height() == fh {
        raster
    } else {
        resize_rgb_bounded(&raster, fw, fh)
    };
    finish_render_with(rgb, sw, sh, encode_data_url)
}

/// 长图请求给 IDCT 解码器的高度（u16 上限内的源都成立）。
fn tall_want_h(sw: u32, sh: u32, tw: u32) -> u32 {
    if sw == 0 {
        return sh;
    }
    ((sh as u64 * tw as u64) / sw as u64).clamp(1, u16::MAX as u64) as u32
}

/// 长图 JPEG 解码（不下线编码）：返回 IDCT 缩放解码后的栅格。
///
/// **不做**最终整图缩放——那是"先切后缩"要避免的整图副本；条漫路径改为
/// 按带逐段缩放，单页路径才做一次精确整图缩放。
fn decode_tall_jpeg_raster(
    raw: &RawPage,
    req_w: u32,
    req_h: u32,
    source_px: u64,
) -> Result<image::RgbImage, BackendError> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(&raw.bytes));
    decoder
        .read_info()
        .map_err(|e| BackendError::Decode(format!("长图解码失败：{e}")))?;
    // jpeg-decoder 的 scale 目标：按目标宽求比例的高（u16 上限内的源都成立）。
    let want_w = req_w.clamp(1, u16::MAX as u32) as u16;
    let want_h = req_h.clamp(1, u16::MAX as u32) as u16;
    decoder
        .scale(want_w, want_h)
        .map_err(|e| BackendError::Decode(format!("长图缩放不可用：{e}")))?;
    let pixels = decoder
        .decode()
        .map_err(|e| BackendError::Decode(format!("长图解码失败：{e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| BackendError::Decode("缺少 JPEG 信息".into()))?;

    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => {
            image::RgbImage::from_raw(info.width as u32, info.height as u32, pixels)
                .ok_or_else(|| BackendError::Decode("长图像素缓冲不匹配".into()))
        }
        jpeg_decoder::PixelFormat::L8 => {
            let gray = image::GrayImage::from_raw(info.width as u32, info.height as u32, pixels)
                .ok_or_else(|| BackendError::Decode("长图像素缓冲不匹配".into()))?;
            Ok(image::RgbImage::from_fn(
                gray.width(),
                gray.height(),
                |x, y| {
                    let g = gray.get_pixel(x, y)[0];
                    image::Rgb([g, g, g])
                },
            ))
        }
        _ => {
            // CMYK 等罕见格式退回常规解码（长图 CMYK 极罕见；牺牲一次全分辨率）。
            // 这是整图展开：先释放 IDCT 缩放缓冲，再按源像素数进入闸门。
            drop(pixels);
            let _heavy_decode = acquire_heavy_decode(source_px);
            let img = image::load_from_memory_with_format(&raw.bytes, ImageFormat::Jpeg)?;
            Ok(into_rgb(img))
        }
    }
}

/// 统一收尾：纹理安全兜底 + JPEG 编码 + 可选 dataURL。
fn finish_render_with(
    rgb: image::RgbImage,
    sw: u32,
    sh: u32,
    encode_data_url: bool,
) -> Result<RenderedPage, BackendError> {
    let rgb = clamp_texture_safe(rgb)?;
    let (w, h) = (rgb.width(), rgb.height());
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 82);
        enc.encode_image(&rgb)?;
    }
    // 内存缓冲即走即用，不落盘（磁盘渲染缓存由调用方决定）。
    let data_url = if encode_data_url {
        format!("data:image/jpeg;base64,{}", B64.encode(&buf))
    } else {
        String::new()
    };
    Ok(RenderedPage {
        width: w,
        height: h,
        orig_width: sw,
        orig_height: sh,
        mime: "image/jpeg".to_string(),
        data_url,
        bytes: buf,
    })
}

/// 条漫切片几何计划（显示坐标系 = 设备像素）。
///
/// 边界按 `round(j * disp_h / n)` 均分，与前端 `Webtoon.tsx` 的
/// `tileTopAt/tileHeightAt`（同样的均分取整）一致 → 前后端切片几何不漂移。
struct TilePlan {
    /// 长度 = 片数 + 1；`bounds[j]..bounds[j+1]` 是第 j 片的显示行区间。
    bounds: Vec<u32>,
}

impl TilePlan {
    fn build(disp_h: u32, tiles: u32) -> TilePlan {
        let n = tiles.max(1) as u64;
        let mut bounds: Vec<u32> = (0..=tiles)
            .map(|j| mul_round(j as u64, disp_h as u64, n) as u32)
            .collect();
        let last = bounds.len() - 1;
        bounds[0] = 0;
        bounds[last] = disp_h;
        // 单调性兜底（正常输入下取整已保证单调且每片 ≥1 行）。
        for j in 1..bounds.len() {
            if bounds[j] < bounds[j - 1] {
                bounds[j] = bounds[j - 1];
            }
        }
        for j in (0..bounds.len() - 1).rev() {
            if bounds[j] > bounds[j + 1] {
                bounds[j] = bounds[j + 1];
            }
        }
        TilePlan { bounds }
    }
}

/// 把 `total` 均分成 `n` 份（每份 ≥1，和恰为 `total`）。
fn split_even(total: u32, n: usize) -> Vec<u32> {
    let n = n.max(1);
    let base = total / n as u32;
    let mut rem = total % n as u32;
    let mut parts = vec![base; n];
    for p in parts.iter_mut() {
        if rem > 0 {
            *p += 1;
            rem -= 1;
        }
    }
    parts
}

/// 条漫整页 → 全部切片（**先切后缩**：按源图切带 → 逐带缩放 → 输出连续切片）。
///
/// 内存要点（用户报"巨图显存/内存爆掉"的根因修复）：
/// - 解码一次拿到工作栅格（长图 JPEG 走 IDCT 缩放解码，全分辨率栅格不进内存）；
/// - **不再**额外做"整图缩放"（那会同时持有原图 + 同尺寸缩放副本，1600×65000 ≈ 300MB）；
///   改为按源图纵向切带（每带 ≤ `MAX_SLICE_H` 行）逐带缩放，缩完立刻释放；
///   注意：工作栅格本身仍是「显示宽 × 显示高」的一份，非 JPEG 格式还需整图解码一次；
/// - 每片高度 ≤ `WEBTOON_TILE_H`（≤ `MAX_SLICE_H`），切片高度之和 == 显示高度；
/// - 切片几何与 `webtoon_tile_count`（前端同公式）严格一致，边界无缝；
/// - **逻辑页 identity 不变**：每个 `RenderedPage.orig_width/orig_height` 都是
///   该逻辑页的**源图原始尺寸** `(sw, sh)`（不是单片自己的 `width/height`，
///   也不是降采样后的显示尺寸）。这样 L1（刚渲染）与 L2（磁盘命中）对
///   `get_webtoon_layout` 的源尺寸口径完全一致。调用方（`get_webtoon_tile`）
///   只按 `(index, tile)` 取片，页码语义始终由 `index` 保持。
/// - **base64 按需**：桌面整页物化不为全部切片预生成 `data_url`（仅 bytes + dims），
///   由 `get_webtoon_tile` 在返回所请求切片时经 `RenderedPage::data_url_from_bytes`
///   编码一次；前端 `PageImage.dataUrl` 契约与内容不变。
pub fn render_webtoon_tiles(
    raw: &RawPage,
    max_w: u32,
) -> Result<(u32, Vec<RenderedPage>), BackendError> {
    render_webtoon_tiles_with(
        raw,
        max_w,
        // 桌面路径不再为全部切片预生成 base64；仅保留成品字节 + 尺寸。
        false,
        Some((MAX_WEBTOON_WEB_TILES, MAX_WEBTOON_WEB_ENCODED_BYTES)),
    )
}

/// Bytes-only tile variant for the Web data plane.
pub(crate) fn render_webtoon_tiles_asset(
    raw: &RawPage,
    max_w: u32,
    encode_data_url: bool,
) -> Result<(u32, Vec<RenderedPage>), BackendError> {
    render_webtoon_tiles_with(
        raw,
        max_w,
        encode_data_url,
        Some((MAX_WEBTOON_WEB_TILES, MAX_WEBTOON_WEB_ENCODED_BYTES)),
    )
}

fn render_webtoon_tiles_with(
    raw: &RawPage,
    max_w: u32,
    encode_data_url: bool,
    web_limits: Option<(u32, usize)>,
) -> Result<(u32, Vec<RenderedPage>), BackendError> {
    let fmt = decoded_format(raw)?;
    let (sw, sh) = source_dimensions(raw)?;
    if max_w == 0 {
        return Err(BackendError::Msg("条漫渲染宽度必须大于 0".into()));
    }

    // 显示几何：目标宽 = min(源宽, 请求宽)（不放大），显示高等比。
    let (tw, th) = fit_size(sw, sh, Some(max_w), None);
    if tw == 0 || th == 0 {
        return Err(BackendError::Decode(format!(
            "条漫显示尺寸非法（{tw}×{th}）"
        )));
    }
    // 片数与前端 webtoonGeometry.ts 按实际输出尺寸的公式一致。
    // 上限再收一道：每片至少 1 显示行（极端比例下不会产生 0 高切片）。
    let tiles = webtoon_tile_count(sw, sh, max_w).min(th.max(1));
    if web_limits.is_some_and(|(max_tiles, _)| tiles > max_tiles) {
        return Err(BackendError::WebtoonTooLarge);
    }
    let plan = TilePlan::build(th, tiles);

    if fmt == ImageFormat::Png && sh > TALL_IMAGE_H {
        if let Some(result) =
            render_tall_png_rows(raw, (sw, sh), tw, th, &plan, encode_data_url, web_limits)?
        {
            return Ok((tiles, result));
        }
    }

    // 工作栅格（只解码一次）：长图 JPEG 走 IDCT 缩放解码；其余格式整图解码。
    let work: image::RgbImage = if sh > TALL_IMAGE_H && fmt == ImageFormat::Jpeg {
        decode_tall_jpeg_raster(raw, tw, tall_want_h(sw, sh, tw), pixel_count(sw, sh))?
    } else {
        // WebP / GIF / 交错 PNG 等没有逐带路径：整图展开受进程级闸门约束。
        let _heavy_decode = acquire_heavy_decode(pixel_count(sw, sh));
        let img = image::load_from_memory_with_format(&raw.bytes, fmt)?;
        into_rgb(img)
    };
    let rh = work.height();

    let mut out: Vec<RenderedPage> = Vec::with_capacity(tiles as usize);
    let mut encoded_bytes = 0usize;
    for j in 0..tiles as usize {
        let d0 = plan.bounds[j];
        let d1 = plan.bounds[j + 1];
        let disp_h = d1 - d0;
        // 显示行 → 工作栅格行（工作栅格可能是 1/2^k 的 IDCT 缩放结果）。
        let w0 = work_row_at(d0, rh, th);
        let w1 = work_row_at(d1, rh, th);
        let tile = render_band_tile(&work, w0, w1, tw, disp_h)?;

        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
            enc.encode_image(&tile)?;
        }
        encoded_bytes = encoded_bytes
            .checked_add(buf.len())
            .ok_or(BackendError::WebtoonTooLarge)?;
        if web_limits.is_some_and(|(_, max_bytes)| encoded_bytes > max_bytes) {
            return Err(BackendError::WebtoonTooLarge);
        }
        out.push(RenderedPage {
            width: tw,
            height: disp_h,
            // 逻辑页源尺寸：与 get_webtoon_layout 同口径，L1/L2 一致。
            orig_width: sw,
            orig_height: sh,
            mime: "image/jpeg".to_string(),
            data_url: if encode_data_url {
                format!("data:image/jpeg;base64,{}", B64.encode(&buf))
            } else {
                String::new()
            },
            bytes: buf,
        });
    }
    Ok((tiles, out))
}

/// Decode ordinary PNGs one source band at a time instead of allocating a
/// complete 8/16-bit raster. Interlaced PNGs use the existing decoder path.
fn render_tall_png_rows(
    raw: &RawPage,
    source_size: (u32, u32),
    tw: u32,
    th: u32,
    plan: &TilePlan,
    encode_data_url: bool,
    limits: Option<(u32, usize)>,
) -> Result<Option<Vec<RenderedPage>>, BackendError> {
    const MAX_BAND_BYTES: u64 = 64 * 1024 * 1024;
    let (sw, sh) = source_size;
    let png_error = |e: png::DecodingError| BackendError::Decode(format!("PNG 解码失败：{e}"));
    let mut decoder = png::Decoder::new(std::io::Cursor::new(&raw.bytes));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(png_error)?;
    if reader.info().interlaced {
        return Ok(None);
    }
    let (color, depth) = reader.output_color_type();
    let bytes_per_sample = match depth {
        png::BitDepth::Eight => 1,
        png::BitDepth::Sixteen => 2,
        _ => return Err(BackendError::Decode("PNG 像素格式不受支持".into())),
    };
    // Keep the existing reader for extreme geometries whose source band
    // cannot fit the bounded streaming buffer. This avoids rejecting books
    // that were readable before this optimization.
    if plan.bounds.windows(2).any(|bounds| {
        let start = work_row_at(bounds[0], sh, th);
        let end = work_row_at(bounds[1], sh, th);
        u64::from(sw) * u64::from(end.saturating_sub(start)) * 3 > MAX_BAND_BYTES
    }) {
        return Ok(None);
    }
    let mut result = Vec::with_capacity(plan.bounds.len() - 1);
    let mut encoded_bytes = 0usize;
    let mut read_rows = 0u32;
    for bounds in plan.bounds.windows(2) {
        let d0 = bounds[0];
        let d1 = bounds[1];
        let w0 = work_row_at(d0, sh, th);
        let w1 = work_row_at(d1, sh, th);
        let rows = w1.saturating_sub(w0);
        let bytes = u64::from(sw) * u64::from(rows) * 3;
        if rows == 0 || bytes > MAX_BAND_BYTES || read_rows != w0 {
            return Err(BackendError::WebtoonTooLarge);
        }
        let mut band = image::RgbImage::new(sw, rows);
        for y in 0..rows {
            let row = reader
                .next_row()
                .map_err(png_error)?
                .ok_or_else(|| BackendError::Decode("PNG 行数据不完整".into()))?;
            let channels = match color {
                png::ColorType::Rgb => 3,
                png::ColorType::Rgba => 4,
                png::ColorType::Grayscale => 1,
                png::ColorType::GrayscaleAlpha => 2,
                png::ColorType::Indexed => {
                    return Err(BackendError::Decode("PNG 色板未展开".into()))
                }
            };
            let data = row.data();
            let stride = channels * bytes_per_sample;
            if data.len() != sw as usize * stride {
                return Err(BackendError::Decode("PNG 行数据长度不正确".into()));
            }
            let dest = &mut band.as_mut()
                [(y as usize * sw as usize * 3)..((y as usize + 1) * sw as usize * 3)];
            for (src, dst) in data
                .chunks_exact(stride)
                .zip(dest.as_chunks_mut::<3>().0.iter_mut())
            {
                let sample = |index: usize| -> u8 {
                    let offset = index * bytes_per_sample;
                    if bytes_per_sample == 1 {
                        src[offset]
                    } else {
                        ((u32::from(u16::from_be_bytes([src[offset], src[offset + 1]])) + 128)
                            / 257) as u8
                    }
                };
                if channels <= 2 {
                    dst.fill(sample(0));
                } else {
                    dst.copy_from_slice(&[sample(0), sample(1), sample(2)]);
                }
            }
        }
        read_rows = w1;
        let height = d1 - d0;
        let tile = render_band_tile(&band, 0, rows, tw, height)?;
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80).encode_image(&tile)?;
        encoded_bytes = encoded_bytes
            .checked_add(buf.len())
            .ok_or(BackendError::WebtoonTooLarge)?;
        if limits.is_some_and(|(_, max)| encoded_bytes > max) {
            return Err(BackendError::WebtoonTooLarge);
        }
        result.push(RenderedPage {
            width: tw,
            height,
            orig_width: sw,
            orig_height: sh,
            mime: "image/jpeg".into(),
            data_url: if encode_data_url {
                format!("data:image/jpeg;base64,{}", B64.encode(&buf))
            } else {
                String::new()
            },
            bytes: buf,
        });
    }
    if read_rows != sh {
        return Err(BackendError::Decode("PNG 行数据不完整".into()));
    }
    reader.finish().map_err(png_error)?;
    Ok(Some(result))
}

/// 显示行 → 工作栅格行（等比映射 + 取整 + 边界收敛）。
fn work_row_at(disp_row: u32, work_h: u32, disp_h: u32) -> u32 {
    if work_h == 0 || disp_h == 0 {
        return 0;
    }
    (mul_round(disp_row as u64, work_h as u64, disp_h as u64) as u32).min(work_h)
}

/// 把工作栅格的行区间 `[w0, w1)` 缩放成 `(tw, disp_h)` 的一张切片。
///
/// 内存友好：源行区间超过 `MAX_SLICE_H` 时切成多条源带，**逐带缩放后立刻拼进
/// 切片缓冲**——任意时刻只多活「一条源带（≤ MAX_SLICE_H 行）+ 一张切片栅格」，
/// 不会同时持有「原图 + 整图缩放副本 + 全部切片栅格」。
/// 零拷贝：`crop_imm` 的 `SubImage` 经 `&*` deref 成 `SubImageInner` 视图直接喂给
/// `resize`，不再 `to_image()` 物化一条源带副本（输出像素见 golden 等价测试）。
fn render_band_tile(
    work: &image::RgbImage,
    w0: u32,
    w1: u32,
    tw: u32,
    disp_h: u32,
) -> Result<image::RgbImage, BackendError> {
    let rh = work.height();
    let ww = work.width();
    let w0 = w0.min(rh);
    let w1 = w1.min(rh).max(w0);
    let src_h = w1 - w0;
    if tw == 0 || disp_h == 0 {
        return Err(BackendError::Decode("切片尺寸非法".into()));
    }
    if src_h == 0 {
        // 极端比例下源行缺失：用相邻单行拉伸兜底（绝不 panic）。
        let row = w0.min(rh.saturating_sub(1));
        let crop = image::imageops::crop_imm(work, 0, row, ww, 1);
        return Ok(image::imageops::resize(
            &*crop,
            tw,
            disp_h,
            image::imageops::FilterType::Triangle,
        ));
    }
    if src_h <= MAX_SLICE_H {
        // 单带：裁出这一条源带后直接缩放（不产生整图副本）。
        let crop = image::imageops::crop_imm(work, 0, w0, ww, src_h);
        return Ok(image::imageops::resize(
            &*crop,
            tw,
            disp_h,
            image::imageops::FilterType::Triangle,
        ));
    }

    // 多带：显示高与源行都按份切开，逐带缩放后拼进切片缓冲。
    // 正常情况下 n = ceil(src_h / MAX_SLICE_H)；极端比例（显示高远小于源行数）
    // 下 n 受显示高所限，带高可能超过 MAX_SLICE_H——宁可如此也不产生 0 高切片。
    let mut n = (src_h as u64).div_ceil(MAX_SLICE_H as u64) as usize;
    n = n.min(disp_h as usize).min(src_h as usize).max(1);
    let disp_parts = split_even(disp_h, n);
    let src_parts = split_even(src_h, n);

    let mut out = image::RgbImage::new(tw, disp_h);
    let mut dy = 0u32;
    let mut sy = w0;
    for c in 0..n {
        let crop = image::imageops::crop_imm(work, 0, sy, ww, src_parts[c]);
        let scaled = image::imageops::resize(
            &*crop,
            tw,
            disp_parts[c],
            image::imageops::FilterType::Triangle,
        );
        image::imageops::replace(&mut out, &scaled, 0, dy as i64);
        dy += disp_parts[c];
        sy += src_parts[c];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用闸门探针：不进入生产构建，避免把 `#[cfg(test)]` 提前到
    /// 条漫入口之前（静态守卫按首个 `#[cfg(test)]` 切分生产/测试源码）。
    impl HeavyDecodeGate {
        fn try_acquire(&self, pixels: u64) -> Option<HeavyDecodePermit<'_>> {
            if pixels < HEAVY_DECODE_MIN_PIXELS {
                return None;
            }
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            if *active >= HEAVY_DECODE_SEMAPHORE {
                return None;
            }
            *active += 1;
            Some(HeavyDecodePermit { gate: self })
        }

        fn active_count(&self) -> usize {
            *self.active.lock().unwrap_or_else(|e| e.into_inner())
        }
    }

    /// 线程内峰值内存统计（只在测试构建安装）。
    ///
    /// 审计报告把「非 JPEG 巨图峰值 0.5–1.1 GB」标为 INFERRED；这里用一个
    /// 只统计**当前线程**存活分配量的 `GlobalAlloc` 包装，把单页渲染的峰值
    /// 变成可复现数字（并行测试各线程独立计数，互不污染）。
    /// `realloc` 按「先减旧、再加新」记账，瞬时重叠不重复计入。
    mod peak_mem {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! {
            static LIVE: Cell<usize> = const { Cell::new(0) };
            static PEAK: Cell<usize> = const { Cell::new(0) };
        }

        fn add(bytes: usize) {
            let _ = LIVE.try_with(|live| {
                let now = live.get() + bytes;
                live.set(now);
                let _ = PEAK.try_with(|peak| {
                    if now > peak.get() {
                        peak.set(now);
                    }
                });
            });
        }

        fn sub(bytes: usize) {
            let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(bytes)));
        }

        pub struct PeakAllocator;

        unsafe impl GlobalAlloc for PeakAllocator {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                let ptr = System.alloc(layout);
                if !ptr.is_null() {
                    add(layout.size());
                }
                ptr
            }

            unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
                let ptr = System.alloc_zeroed(layout);
                if !ptr.is_null() {
                    add(layout.size());
                }
                ptr
            }

            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                sub(layout.size());
                System.dealloc(ptr, layout)
            }

            unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
                let new_ptr = System.realloc(ptr, layout, new_size);
                if !new_ptr.is_null() {
                    sub(layout.size());
                    add(new_size);
                }
                new_ptr
            }
        }

        pub fn reset() {
            let _ = LIVE.try_with(|live| live.set(0));
            let _ = PEAK.try_with(|peak| peak.set(0));
        }

        pub fn peak() -> usize {
            let live = LIVE.with(|live| live.get());
            PEAK.with(|peak| peak.get()).max(live)
        }
    }

    #[global_allocator]
    static QA_PEAK_ALLOCATOR: peak_mem::PeakAllocator = peak_mem::PeakAllocator;

    #[test]
    fn rgba_to_rgb_reuses_buffer_and_preserves_existing_conversion() {
        let input =
            image::RgbaImage::from_raw(3, 1, vec![10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255])
                .unwrap();
        let original_address = input.as_raw().as_ptr();
        let dynamic = image::DynamicImage::ImageRgba8(input);
        let expected = dynamic.to_rgb8();
        let result = into_rgb(dynamic);
        assert_eq!(result, expected);
        assert_eq!(result.as_raw().as_ptr(), original_address);
    }

    #[test]
    fn streamed_png_bands_match_full_raster_for_alpha_and_grayscale() {
        let rgba = image::RgbaImage::from_fn(4, 9001, |x, y| {
            image::Rgba([x as u8 * 30, y as u8, (y >> 3) as u8, (y >> 1) as u8])
        });
        let gray = image::GrayImage::from_fn(4, 9001, |x, y| image::Luma([(x + y) as u8]));
        let rgb16 = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::from_fn(4, 9001, |x, y| {
            image::Rgb([(y * 13) as u16, (y * 7 + x * 150) as u16, (y * 5) as u16])
        });
        for original in [
            image::DynamicImage::ImageRgba8(rgba),
            image::DynamicImage::ImageLuma8(gray),
            image::DynamicImage::ImageRgb16(rgb16),
        ] {
            let mut bytes = std::io::Cursor::new(Vec::new());
            original.write_to(&mut bytes, ImageFormat::Png).unwrap();
            let raw = RawPage {
                bytes: bytes.into_inner(),
                ext: "png".into(),
            };
            let (count, actual) = render_webtoon_tiles_asset(&raw, 4, false).unwrap();
            let source = into_rgb(original);
            let plan = TilePlan::build(9001, count);
            for (i, page) in actual.iter().enumerate() {
                let start = plan.bounds[i];
                let end = plan.bounds[i + 1];
                let tile = render_band_tile(&source, start, end, 4, end - start).unwrap();
                let mut expected = Vec::new();
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut expected, 80)
                    .encode_image(&tile)
                    .unwrap();
                assert_eq!(page.bytes, expected, "PNG band {i}");
            }
        }
    }

    #[test]
    fn source_dimensions_rejects_oversized_header_before_decode() {
        use image::ImageEncoder as _;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[0, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .expect("编码 1×1 PNG");
        // PNG: 8B signature + 4B length + 4B "IHDR" + width/height。
        bytes[16..20].copy_from_slice(&20_000u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&9_000u32.to_be_bytes());
        // 重新计算 IHDR 的 CRC（type + data），证明拒绝原因是像素上限而非坏头。
        let mut crc = 0xffff_ffffu32;
        for byte in &bytes[12..29] {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        bytes[29..33].copy_from_slice(&(crc ^ 0xffff_ffff).to_be_bytes());
        let raw = RawPage {
            bytes,
            ext: "png".into(),
        };
        let error = source_dimensions(&raw).unwrap_err().to_string();
        assert!(
            error.contains("超过解码上限"),
            "超限 header 必须在整图解码前拒绝：{error}"
        );
    }

    #[test]
    fn fit_size_downscales_only() {
        // 超限等比缩小。
        assert_eq!(fit_size(2000, 1000, Some(1000), None), (1000, 500));
        assert_eq!(fit_size(1000, 2000, None, Some(1000)), (500, 1000));
        // 未超限不放大。
        assert_eq!(fit_size(100, 100, Some(800), Some(600)), (100, 100));
        // 无限制原样。
        assert_eq!(fit_size(640, 100, None, None), (640, 100));
    }

    #[test]
    fn webtoon_tiles_cover_full_height() {
        use image::ImageEncoder as _;
        // 100×5000 PNG（非 JPEG，走常规解码路径）：切片必须无缝覆盖整高。
        let mut img = image::RgbImage::new(100, 5000);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), 100, 5000, image::ExtendedColorType::Rgb8)
            .unwrap();
        let raw = RawPage {
            bytes: buf,
            ext: "png".into(),
        };
        let (tiles, pages) = render_webtoon_tiles(&raw, 200).unwrap();
        assert!(tiles >= 1);
        assert_eq!(pages.len() as u32, tiles);
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, 5000, "切片应无缝覆盖整高（无重叠无缝隙）");
        // 整页物化只保留 bytes+dims（不预生成 base64），成品为 JPEG 字节；
        // data URL 由 get_webtoon_tile 请求路径按需生成（同 asset_renders_* 范式）。
        assert!(pages.iter().all(|p| p.data_url.is_empty()));
        assert!(pages.iter().all(|p| p.bytes.starts_with(&[0xFF, 0xD8])));
    }

    #[test]
    fn web_tile_budget_rejects_extreme_geometry_before_materialization() {
        let raw = ultra_tall_page(1, 2_100_000);
        assert!(matches!(
            render_webtoon_tiles_asset(&raw, 320, false),
            Err(BackendError::WebtoonTooLarge)
        ));
        assert!(matches!(
            render_webtoon_tiles(&raw, 320),
            Err(BackendError::WebtoonTooLarge)
        ));
        assert!(
            webtoon_tile_count(800, 65_000, 2160) <= MAX_WEBTOON_WEB_TILES,
            "typical 65k-height source remains within the tile-count budget"
        );
    }

    #[test]
    fn web_tile_budget_bounds_accumulated_encoded_bytes() {
        let raw = ultra_tall_page(20, 100);
        assert!(matches!(
            render_webtoon_tiles_with(&raw, 20, false, Some((1024, 1))),
            Err(BackendError::WebtoonTooLarge)
        ));
        assert!(
            render_webtoon_tiles(&raw, 20).is_ok(),
            "web limit must not change desktop rendering"
        );
    }

    #[test]
    fn asset_renders_skip_base64_but_keep_jpeg_bytes() {
        let raw = ultra_tall_page(100, 300);
        let page = render_raw_asset(&raw, Some(50), None, false).unwrap();
        assert!(page.data_url.is_empty());
        assert!(page.bytes.starts_with(&[0xFF, 0xD8]));
        assert!(page.width > 0 && page.height > 0);

        let (tiles, pages) = render_webtoon_tiles_asset(&raw, 50, false).unwrap();
        assert_eq!(pages.len() as u32, tiles);
        assert!(pages.iter().all(|page| page.data_url.is_empty()));
        assert!(pages
            .iter()
            .all(|page| page.bytes.starts_with(&[0xFF, 0xD8])));

        let desktop = render_raw(&raw, Some(50), None).unwrap();
        assert!(desktop.data_url.starts_with("data:image/jpeg;base64,"));
    }

    /* ---------------- 超高分辨率条漫（>20000px）防线 ---------------- */

    /// 内存构造超高条漫测试图（不落盘）：纵向平滑渐变，便于校验切片落位。
    fn ultra_tall_page(w: u32, h: u32) -> RawPage {
        use image::ImageEncoder as _;
        let mut img = image::RgbImage::new(w, h);
        for (_x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([((y as u64 * 255) / h as u64) as u8, 128, 64]);
        }
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut buf,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
        RawPage {
            bytes: buf,
            ext: "png".into(),
        }
    }

    /// 渐变参考值（与 `ultra_tall_page` 的配色一致）。
    fn ramp(y: u32, h: u32) -> u8 {
        ((y as u64 * 255) / h as u64) as u8
    }

    /// 内存构造超高条漫 JPEG（走长图 IDCT 缩放解码路径）。
    fn ultra_tall_jpeg(w: u32, h: u32) -> RawPage {
        let mut img = image::RgbImage::new(w, h);
        for (_x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([((y as u64 * 255) / h as u64) as u8, 128, 64]);
        }
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85)
            .encode_image(&img)
            .unwrap();
        RawPage {
            bytes: buf,
            ext: "jpg".into(),
        }
    }

    /// 长图 JPEG：切片几何必须与前端公式一致，且不 panic。
    #[test]
    fn webtoon_tiles_handle_ultra_tall_jpeg() {
        let (w, h) = (320u32, 20000u32);
        let raw = ultra_tall_jpeg(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        assert_eq!(tiles, webtoon_tile_count(w, h, w));
        assert!(pages.iter().all(|p| p.height <= WEBTOON_TILE_H));
        assert!(pages.iter().all(|p| p.width == w));
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, fit_size(w, h, Some(w), None).1);
    }

    /// 长图 JPEG 单页：缩放后仍超纹理上限时必须等比再缩（IDCT 路径 + 兜底）。
    #[test]
    fn render_raw_clamps_ultra_tall_jpeg() {
        let (w, h) = (320u32, 20000u32);
        let raw = ultra_tall_jpeg(w, h);
        for max_w in [None, Some(w)] {
            let page = render_raw(&raw, max_w, None).unwrap();
            assert!(
                page.height <= MAX_SAFE_TEXTURE_H,
                "长图 JPEG 输出高度 {} 超限",
                page.height
            );
            assert_eq!(page.orig_width, w);
            assert_eq!(page.orig_height, h);
            let expect = w as f64 / h as f64;
            let got = page.width as f64 / page.height as f64;
            assert!(
                (got - expect).abs() / expect < 0.02,
                "宽高比失真：{got} vs {expect}"
            );
        }
    }

    /// 400×24000 巨图：切片数/片高/无缝覆盖必须与前端公式一致。
    #[test]
    fn webtoon_tiles_handle_ultra_tall_page() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();

        let expect = webtoon_tile_count(w, h, w);
        assert_eq!(
            tiles, expect,
            "片数必须与 webtoon_tile_count（前端同公式）一致"
        );
        assert_eq!(expect, 12, "24000 / 2048 → 12 片");
        assert_eq!(pages.len() as u32, tiles);

        // 每片高度 ≤ WEBTOON_TILE_H（也因此 ≤ MAX_SLICE_H）
        assert!(
            pages.iter().all(|p| p.height <= WEBTOON_TILE_H),
            "单片高度不得超过 {WEBTOON_TILE_H}"
        );
        assert!(pages.iter().all(|p| p.height <= MAX_SLICE_H));

        // 切片高度之和 == 显示高度（无缝覆盖，不丢像素）
        let total: u32 = pages.iter().map(|p| p.height).sum();
        let disp_h = fit_size(w, h, Some(w), None).1;
        assert_eq!(disp_h, h);
        assert_eq!(total, disp_h, "切片高度之和必须等于显示高度");
        assert!(pages.iter().all(|p| p.width == w));
        // 整页物化只保留 bytes+dims（不预生成 base64），成品为 JPEG 字节；
        // data URL 由 get_webtoon_tile 请求路径按需生成（同 asset_renders_* 范式）。
        assert!(pages.iter().all(|p| p.data_url.is_empty()));
        assert!(pages.iter().all(|p| p.bytes.starts_with(&[0xFF, 0xD8])));
    }

    /// 切片必须首尾相接、顺序正确：逐片解码回来比对首尾行与源图渐变。
    #[test]
    fn webtoon_tiles_are_contiguous_and_in_order() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        let disp_h = fit_size(w, h, Some(w), None).1 as u64;
        let n = tiles as u64;

        let mut covered = 0u32;
        for (j, p) in pages.iter().enumerate() {
            // 与前端 tileTopAt 同公式：round(j * dispH / tiles)
            let b0 = ((j as u64 * disp_h + n / 2) / n) as u32;
            let b1 = (((j + 1) as u64 * disp_h + n / 2) / n) as u32;
            assert_eq!(p.height, b1 - b0, "第 {j} 片高度必须与切片几何一致");
            covered += p.height;

            let img = image::load_from_memory_with_format(&p.bytes, ImageFormat::Jpeg)
                .unwrap()
                .to_rgb8();
            assert_eq!(img.width(), w);
            assert_eq!(img.height(), p.height);
            let first = img.get_pixel(0, 0)[0] as i32;
            let last = img.get_pixel(0, img.height() - 1)[0] as i32;
            assert!(
                (first - ramp(b0, h) as i32).abs() <= 12,
                "第 {j} 片首行应落在源行 {b0}（实际 {first}）"
            );
            assert!(
                (last - ramp(b1 - 1, h) as i32).abs() <= 12,
                "第 {j} 片末行应落在源行 {}（实际 {last}）",
                b1 - 1
            );
        }
        assert_eq!(covered, disp_h as u32, "所有切片必须无缝覆盖整高");
    }

    /// 缩放路径（先切后缩）：缩到 1/4 宽时单片源行 > MAX_SLICE_H，
    /// 强制走"逐带缩放"，几何与覆盖仍必须正确。
    #[test]
    fn webtoon_tiles_scale_band_by_band() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let render_w = 100u32;
        let (tiles, pages) = render_webtoon_tiles(&raw, render_w).unwrap();
        let disp_h = fit_size(w, h, Some(render_w), None).1;
        assert_eq!(disp_h, 6000);
        assert_eq!(tiles, webtoon_tile_count(w, h, render_w));
        assert!(pages.iter().all(|p| p.height <= WEBTOON_TILE_H));
        assert!(pages.iter().all(|p| p.width == render_w));
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, disp_h, "缩放后切片仍必须无缝覆盖整高");
    }

    /* ---------------- 逻辑页 P 与物理切片解耦（页/片语义） ---------------- */

    /// 800×21000 超长 PNG：片数 > 1、单片 ≤ WEBTOON_TILE_H、片高之和 == 显示总高；
    /// 且每个 `RenderedPage.orig_height` 都是**整页**显示总高（不是单片高度），
    /// 保证上层仍能按「一页一条目」保持逻辑页语义。
    #[test]
    fn webtoon_tiles_800x21000_keep_logical_page_identity() {
        let (w, h) = (800u32, 21000u32);
        let raw = ultra_tall_page(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        let disp_h = fit_size(w, h, Some(w), None).1;

        assert_eq!(disp_h, h, "源宽 = 渲染宽时应等比保持源高");
        assert_eq!(tiles, webtoon_tile_count(w, h, w));
        assert_eq!(tiles, 11, "ceil(21000 / 2048) = 11 片");
        assert!(tiles > 1, "超长图必须切多片，不能整图直送 <img>");
        assert_eq!(pages.len() as u32, tiles);

        // 每片 ≤ 2048（也 ≤ MAX_SLICE_H）；片高之和 == 21000（无缝、无重叠）。
        assert!(
            pages.iter().all(|p| p.height <= WEBTOON_TILE_H),
            "单片高度不得超过 {WEBTOON_TILE_H}"
        );
        assert!(pages.iter().all(|p| p.height < h));
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, disp_h, "所有切片高度之和必须等于显示总高");

        // 逻辑页 identity：每片都上报整页源尺寸，而不是自己的片高/显示尺寸。
        for (j, p) in pages.iter().enumerate() {
            assert_eq!(
                p.orig_height, h,
                "第 {j} 片的 orig_height 必须是整页源高（不是单片高度/显示高）"
            );
            assert_eq!(p.orig_width, w);
            assert_eq!(p.width, w);
            assert_ne!(p.orig_height, p.height);
        }
    }

    /// 片数公式与实际物化片数在三种宽高关系下必须一致（±1 片都不允许）：
    /// 源宽 > 请求宽（缩放）、源宽 < 请求宽（后端不放大）、极端长宽比。
    #[test]
    fn webtoon_tile_count_matches_rendered_tiles() {
        let cases = [
            (800u32, 9000u32, 400u32, "源宽 > 请求宽"),
            (400u32, 10000u32, 800u32, "源宽 < 请求宽（不放大）"),
            (60u32, 6000u32, 320u32, "极端竖长条 100:1"),
            (6000u32, 120u32, 320u32, "极端横长条 50:1"),
            // 请求宽大于源宽：即使按请求宽会落在整数倍边界，也不应放大。
            (7u32, 928u32, 448u32, "窄图不放大"),
        ];
        for (sw, sh, rw, why) in cases {
            let raw = ultra_tall_page(sw, sh);
            let (tiles, pages) = render_webtoon_tiles(&raw, rw).unwrap();
            let expect = webtoon_tile_count(sw, sh, rw);
            let (tw, display_h) = fit_size(sw, sh, Some(rw), None);

            assert_eq!(tiles, expect, "{why}：{sw}×{sh}@{rw} 片数与公式漂移");
            assert_eq!(pages.len() as u32, tiles);
            assert!(
                tiles <= display_h.max(1),
                "{why}：片数不得超过显示行数（每片至少 1 行）"
            );

            let total: u32 = pages.iter().map(|p| p.height).sum();
            assert_eq!(total, display_h, "{why}：切片高度之和必须等于显示总高");
            assert!(
                pages.iter().all(|p| p.height <= WEBTOON_TILE_H),
                "{why}：单片高度超过 {WEBTOON_TILE_H}"
            );
            assert!(pages.iter().all(|p| p.width == tw));
            assert!(
                pages
                    .iter()
                    .all(|p| p.orig_width == sw && p.orig_height == sh),
                "{why}：orig_* 必须保持逻辑页源尺寸（L1/L2 同口径）"
            );
        }
    }

    /// 计数公式的零值、边界和窄图不放大行为。
    #[test]
    fn webtoon_tile_count_guards_and_extreme_narrow() {
        // 宽/高/渲染宽任一为 0 → 1（与前端 0 宽兜底一致）。
        assert_eq!(webtoon_tile_count(0, 100, 800), 1);
        assert_eq!(webtoon_tile_count(100, 0, 800), 1);
        assert_eq!(webtoon_tile_count(100, 100, 0), 1);
        // ceil 边界：正好一片 / 多一行即两片。
        assert_eq!(webtoon_tile_count(100, 2048, 100), 1);
        assert_eq!(webtoon_tile_count(100, 2049, 100), 2);
        // 源宽 < 请求宽：按未放大的实际高度计算。
        assert_eq!(webtoon_tile_count(400, 10000, 800), 5);
        // 窄图不会放大：928 高只需 1 片。
        assert_eq!(webtoon_tile_count(7, 928, 448), 1);

        // 1px 宽 + 2160 请求宽仍只需 1 片。
        let raw = ultra_tall_page(1, 300);
        assert_eq!(webtoon_tile_count(1, 300, 2160), 1);
        let (tiles, pages) = render_webtoon_tiles(&raw, 2160).unwrap();
        assert_eq!(tiles, 1, "不放大时按源高计算");
        assert_eq!(pages.len() as u32, 1);
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, 300);
        assert!(pages.iter().all(|p| p.height == 300));
        assert!(pages.iter().all(|p| p.orig_height == 300));
    }

    /// 单页模式兜底：巨图渲染结果高度不得超过 MAX_SAFE_TEXTURE_H，且比例正确。
    #[test]
    fn render_raw_clamps_ultra_tall_to_safe_texture() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let page = render_raw(&raw, None, None).unwrap();
        assert!(
            page.height <= MAX_SAFE_TEXTURE_H,
            "单页输出高度 {} 超过纹理安全上限 {MAX_SAFE_TEXTURE_H}",
            page.height
        );
        assert!(page.width > 0);
        // 原始尺寸仍要如实上报（条漫布局/比例用）
        assert_eq!(page.orig_width, w);
        assert_eq!(page.orig_height, h);
        // 宽高比与原图一致（等比再缩放）
        let expect = w as f64 / h as f64;
        let got = page.width as f64 / page.height as f64;
        assert!(
            (got - expect).abs() / expect < 0.01,
            "宽高比失真：{got} vs {expect}"
        );
        assert!(page.data_url.starts_with("data:image/jpeg;base64,"));
    }

    /* ---------------- 非 JPEG 巨图 / 极端尺寸 / 单页纹理上限 ---------------- */

    /// 测试用 RGBA PNG（透明通道会让 `into_rgb` 走原地压缩分支）。
    fn rgba_page(w: u32, h: u32) -> RawPage {
        use image::ImageEncoder as _;
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([
                ((y as u64 * 255) / h as u64) as u8,
                (x % 256) as u8,
                90,
                ((y % 251) as u8).max(1),
            ])
        });
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut buf,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .unwrap();
        RawPage {
            bytes: buf,
            ext: "png".into(),
        }
    }

    /// 无损 WebP（`image` 只支持 lossless 编码），用于验证「无逐带解码」格式的回退。
    fn webp_page(w: u32, h: u32) -> RawPage {
        use image::ImageEncoder as _;
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([((y as u64 * 255) / h as u64) as u8, 128, (x % 256) as u8])
        });
        let mut buf = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut buf)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        RawPage {
            bytes: buf,
            ext: "webp".into(),
        }
    }

    /// WebP 没有 IDCT/逐带解码：超长 WebP 只能整图解码，但切片几何与单页钳制
    /// 仍必须与 JPEG/PNG 完全一致（防止「非 JPEG 走另一套几何」的回退缺口）。
    #[test]
    fn tall_webp_falls_back_to_full_decode_with_identical_geometry() {
        let (w, h) = (240u32, 9000u32);
        let raw = webp_page(w, h);
        assert_eq!(decoded_format(&raw).unwrap(), ImageFormat::WebP);

        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        assert_eq!(tiles, webtoon_tile_count(w, h, w));
        assert_eq!(pages.len() as u32, tiles);
        assert!(pages.iter().all(|p| p.height <= WEBTOON_TILE_H));
        assert!(pages.iter().all(|p| p.width == w));
        assert_eq!(pages.iter().map(|p| p.height).sum::<u32>(), h);
        assert!(pages
            .iter()
            .all(|p| p.orig_width == w && p.orig_height == h));

        let page = render_raw(&raw, Some(w), None).unwrap();
        assert_eq!(page.height, MAX_SAFE_TEXTURE_H);
        assert_eq!((page.orig_width, page.orig_height), (w, h));
    }

    /// 宽幅巨图（宽 > 安全线）：单页路径必须等比压到安全线以内并如实上报源尺寸。
    #[test]
    fn wide_giant_single_page_is_scaled_into_safe_texture() {
        let raw = ultra_tall_page(20_000, 400);
        let page = render_raw(&raw, None, None).unwrap();
        assert_eq!(page.width, MAX_SAFE_TEXTURE_H);
        assert_eq!(page.height, 164);
        assert_eq!((page.orig_width, page.orig_height), (20_000, 400));

        // 请求更窄时按请求宽等比缩小，且不会被安全线二次压扁。
        let page = render_raw(&raw, Some(1000), None).unwrap();
        assert_eq!((page.width, page.height), (1000, 20));
    }

    /// 单页 `max_height` 先于纹理安全线生效；超过安全线时以安全线为准。
    #[test]
    fn single_page_honours_max_height_before_texture_clamp() {
        let raw = ultra_tall_page(400, 9000);
        let page = render_raw(&raw, None, Some(2000)).unwrap();
        assert_eq!((page.width, page.height), (89, 2000));
        assert_eq!((page.orig_width, page.orig_height), (400, 9000));

        let page = render_raw(&raw, None, Some(20_000)).unwrap();
        assert_eq!(page.height, MAX_SAFE_TEXTURE_H);
        assert_eq!(page.width, 364);
    }

    /// 安全线边界：正好压线不缩，极端长宽比两侧都等比收敛到 ≥1px。
    #[test]
    fn safe_fit_boundaries_cover_extreme_aspects() {
        assert_eq!(safe_fit(8192, 8192), (8192, 8192));
        assert_eq!(safe_fit(400, 8192), (400, 8192));
        assert_eq!(safe_fit(20000, 400), (8192, 164));
        assert_eq!(safe_fit(100000, 1), (8192, 1));
        let (w, h) = safe_fit(1, 100000);
        assert_eq!((w, h), (1, 8192));
        // 输出永远不超过安全线，且任一边都 ≥1px（不会产生 0 尺寸画布）。
        for (w, h) in [(1u32, 65_000u32), (65_000, 1), (12_000, 12_000)] {
            let (nw, nh) = safe_fit(w, h);
            assert!(nw <= MAX_SAFE_TEXTURE_H && nh <= MAX_SAFE_TEXTURE_H);
            assert!(nw >= 1 && nh >= 1);
        }
    }

    /// 极端几何下单片源带超过逐带缓冲预算时，PNG 流式解码必须回退整图解码，
    /// 而不是把原本可读的书直接判成超限。
    #[test]
    fn png_band_streaming_bails_out_when_a_band_exceeds_the_buffer_budget() {
        let (w, h) = (3000u32, 7500u32);
        let raw = ultra_tall_page(w, h);
        // 单片 = 整页 7500 行 × 3000 × 3B ≈ 67MB > 64MB 逐带预算。
        let plan = TilePlan::build(h, 1);
        assert!(
            render_tall_png_rows(&raw, (w, h), w, h, &plan, false, None)
                .unwrap()
                .is_none(),
            "超大源带必须回退整图解码"
        );
        // 正常分片（ceil(7500/2048) = 4 片）仍走流式解码并覆盖整高。
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        assert_eq!(tiles, 4);
        assert_eq!(pages.len() as u32, tiles);
        assert_eq!(pages.iter().map(|p| p.height).sum::<u32>(), h);
    }

    /// 极端/畸形输入必须返回可读错误，不得 panic。
    #[test]
    fn pipeline_rejects_invalid_input_without_panic() {
        // 非图片字节
        let bad = RawPage {
            bytes: b"definitely not an image".to_vec(),
            ext: "png".into(),
        };
        assert!(render_raw(&bad, Some(800), Some(800)).is_err());
        assert!(render_webtoon_tiles(&bad, 800).is_err());
        // 渲染宽度非法
        let raw = ultra_tall_page(16, 32);
        assert!(render_webtoon_tiles(&raw, 0).is_err());
        // 空字节
        let empty = RawPage {
            bytes: Vec::new(),
            ext: "png".into(),
        };
        assert!(render_raw(&empty, Some(800), Some(800)).is_err());
        assert!(render_webtoon_tiles(&empty, 800).is_err());
    }

    /// 有界降采样：预算内必须与 `imageops::resize` 逐像素一致（既有输出不变）；
    /// 超预算的巨图退到盒式面积平均——不得出现「逐行均值突变」式接缝。
    #[test]
    fn bounded_downscale_switches_filter_only_above_the_memory_budget() {
        // 预算内：与 resize 完全一致。
        let small = image::RgbImage::from_fn(64, 48, |x, y| image::Rgb([x as u8, y as u8, 7]));
        assert_eq!(
            resize_rgb_bounded(&small, 32, 24),
            image::imageops::resize(&small, 32, 24, image::imageops::FilterType::Triangle)
        );

        // 超预算：中间副本 1000×8192×16 ≈ 131MB > 96MB → 盒式降采样。
        let (sw, sh) = (1000u32, 9000u32);
        let giant = image::RgbImage::from_fn(sw, sh, |x, y| {
            image::Rgb([
                ((y as u64 * 255) / sh as u64) as u8,
                ((y as u64 * 255) / sh as u64) as u8,
                (x % 256) as u8,
            ])
        });
        let (tw, th) = (920u32, 8192u32);
        assert!(u64::from(sw) * u64::from(th) * 16 > RESIZE_INTERMEDIATE_BUDGET as u64);
        let bounded = resize_rgb_bounded(&giant, tw, th);
        assert_eq!(bounded, image::imageops::thumbnail(&giant, tw, th));
        assert_eq!(bounded.dimensions(), (tw, th));

        // 无接缝：逐行灰度均值与 Triangle 参考的差处处有界（接缝会表现为单行跳变）。
        let reference =
            image::imageops::resize(&giant, tw, th, image::imageops::FilterType::Triangle);
        let mut worst = 0f64;
        for y in 0..th {
            let row_mean = |img: &image::RgbImage| -> f64 {
                let sum: u64 = (0..tw).map(|x| img.get_pixel(x, y)[0] as u64).sum();
                sum as f64 / tw as f64
            };
            worst = worst.max((row_mean(&bounded) - row_mean(&reference)).abs());
        }
        assert!(worst <= 2.0, "逐行均值偏差过大（疑似接缝）：{worst}");
    }

    /// 非 JPEG 巨图（RGBA PNG 2000×9000）单页渲染的**实测**峰值内存必须有界：
    /// 源栅格（4B/px）+ 输出栅格（3B/px）+ 有界降采样中间带 + 编码缓冲。
    /// 回归点：`imageops::resize` 的 Rgba32F 中间副本（16B/px）曾被整页保留，
    /// 同一张图实测峰值 379MB；分带降采样后须降到 ~150MB。
    #[test]
    fn tall_rgba_single_page_peak_memory_stays_bounded() {
        const W: u32 = 2000;
        const H: u32 = 9000;
        let raw = rgba_page(W, H);
        let source_bytes = (W as usize) * (H as usize) * 4;

        peak_mem::reset();
        let page = render_raw(&raw, None, None).unwrap();
        let peak = peak_mem::peak();

        assert_eq!(page.height, MAX_SAFE_TEXTURE_H);
        let output_bytes = (page.width as usize) * (page.height as usize) * 3;
        // 审计证据：`--nocapture` 可见实测峰值（修复前同一张图 379MB）。
        println!("peak={peak} bytes (source={source_bytes}, output={output_bytes})");
        // 余量 = 编码缓冲 + 分配器开销（实测 111MB ≈ 源 69MB + 输出 43MB + 1.6MB）。
        let budget = source_bytes + output_bytes + 16 * 1024 * 1024;
        assert!(
            peak <= budget,
            "峰值 {peak} 字节超过预算 {budget}（源 {source_bytes} + 输出 {output_bytes}）"
        );
    }

    /// WS3 characterization（**非 RED**）：零拷贝视图缩放与物化副本缩放逐像素等价。
    ///
    /// 这是 `render_band_tile` 从 `crop_imm(..).to_image()` 改为 `&*crop_imm(..)`
    /// （`SubImage` deref 到 `SubImageInner` 的 `GenericImageView` 零拷贝视图）时
    /// 「输出像素不变」的安全网：改动前后都应 PASS，不得用作 RED 证据。
    #[test]
    fn band_tile_zero_copy_equiv() {
        use image::imageops::FilterType;
        let src = image::RgbImage::from_fn(37, 53, |x, y| {
            image::Rgb([(x * 5) as u8, (y * 3) as u8, ((x + y) * 2) as u8])
        });
        let (x0, y0, cw, ch) = (5u32, 7u32, 23u32, 31u32);
        let (tw, th) = (17u32, 11u32);
        // 旧：`crop_imm(..).to_image()` 先物化一份源带副本，再 resize。
        let materialized = image::imageops::crop_imm(&src, x0, y0, cw, ch).to_image();
        let old = image::imageops::resize(&materialized, tw, th, FilterType::Triangle);
        // 新：`&*crop_imm(..)` 直接把 SubImageInner 视图喂给 resize，零物化。
        let view = image::imageops::crop_imm(&src, x0, y0, cw, ch);
        let new = image::imageops::resize(&*view, tw, th, FilterType::Triangle);
        assert_eq!(old, new, "零拷贝视图与物化副本的 resize 输出必须逐像素相等");
        // 顺带覆盖放大与不变尺寸，排除只在缩小路径等价的巧合。
        let up = image::imageops::resize(&*view, 41, 47, FilterType::Triangle);
        let up_ref = image::imageops::resize(&materialized, 41, 47, FilterType::Triangle);
        assert_eq!(up, up_ref);
    }

    /// WS3 RED/GREEN：`render_webtoon_tiles` 整页物化时不再为全部切片预生成
    /// base64（仅 bytes + dims），data URL 改由 `get_webtoon_tile` 请求路径
    /// 只对所请求的那一页按需生成。IPC `PageImage.dataUrl` 契约不变。
    #[test]
    fn webtoon_tiles_bytes_only() {
        let raw = ultra_tall_page(64, 5000);
        let (tiles, pages) = render_webtoon_tiles(&raw, 64).unwrap();
        assert_eq!(pages.len() as u32, tiles);
        // 新形状：tiles 不携带预生成 base64，只保留成品字节与尺寸。
        assert!(
            pages.iter().all(|p| p.data_url.is_empty()),
            "整页物化不得为全部切片预生成 base64"
        );
        assert!(pages.iter().all(|p| !p.bytes.is_empty()));
        assert!(pages.iter().all(|p| p.width > 0 && p.height > 0));
        // 新访问器：请求路径按需把所请求切片编码为 data URL。
        let requested = pages.first().unwrap().data_url_from_bytes();
        assert!(requested.starts_with("data:image/jpeg;base64,"));
        assert_eq!(
            requested,
            format!("data:image/jpeg;base64,{}", B64.encode(&pages[0].bytes))
        );
    }

    /* ---------------- 进程级重解码闸门（整图展开并发上限） ---------------- */

    /// 4 个线程同时申请名额：任意时刻实际并发不得超过 2。
    #[test]
    fn heavy_decode_gate_caps_concurrency_at_two() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};

        let gate = Arc::new(HeavyDecodeGate::new());
        let barrier = Arc::new(Barrier::new(4));
        let current = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let gate = gate.clone();
            let barrier = barrier.clone();
            let current = current.clone();
            let peak = peak.clone();
            let completed = completed.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let _permit = gate
                    .acquire(HEAVY_DECODE_MIN_PIXELS)
                    .expect("超过阈值的解码必须进入闸门");
                let now = current.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                // 留出重叠窗口：若闸门失效，4 个线程会同时观察到 4。
                std::thread::sleep(std::time::Duration::from_millis(80));
                current.fetch_sub(1, Ordering::SeqCst);
                completed.fetch_add(1, Ordering::SeqCst);
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            completed.load(Ordering::SeqCst),
            4,
            "所有等待者最终都要拿到名额"
        );
        assert_eq!(
            peak.load(Ordering::SeqCst),
            HEAVY_DECODE_SEMAPHORE,
            "并发峰值必须恰好等于闸门上限 {HEAVY_DECODE_SEMAPHORE}"
        );
    }

    /// 小于阈值的图片直接放行，不占用也不排队任何名额。
    #[test]
    fn heavy_decode_gate_bypasses_small_images() {
        let gate = HeavyDecodeGate::new();
        assert!(
            gate.acquire(HEAVY_DECODE_MIN_PIXELS - 1).is_none(),
            "低于阈值的图片不应进入闸门"
        );
        assert_eq!(gate.active_count(), 0, "绕过的图片不得占用名额");

        let permit = gate
            .acquire(HEAVY_DECODE_MIN_PIXELS)
            .expect("阈值本身必须受控");
        assert_eq!(gate.active_count(), 1);
        drop(permit);
        assert_eq!(gate.active_count(), 0, "drop 必须归还名额");

        // 进程级闸门同样遵守阈值：小图永远不触碰全局名额。
        assert!(acquire_heavy_decode(HEAVY_DECODE_MIN_PIXELS - 1).is_none());
    }

    /// 持有名额的线程 panic：RAII 必须在 unwind 时归还名额，不得永久泄漏。
    #[test]
    fn panicking_heavy_decode_holder_releases_the_slot() {
        use std::sync::Arc;

        let gate = Arc::new(HeavyDecodeGate::new());
        let holder = gate.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _permit = holder
                .acquire(HEAVY_DECODE_MIN_PIXELS)
                .expect("超过阈值的解码必须进入闸门");
            panic!("模拟解码 panic");
        }));
        assert!(result.is_err(), "panic 必须被 catch_unwind 捕获");

        // 两个名额都必须重新可用；若泄漏一个，第二次 try_acquire 会返回 None
        // （而不是在 release 构建里永久阻塞）。
        let first = gate
            .try_acquire(HEAVY_DECODE_MIN_PIXELS)
            .expect("名额 1 未归还");
        let second = gate
            .try_acquire(HEAVY_DECODE_MIN_PIXELS)
            .expect("名额 2 未归还");
        assert!(
            gate.try_acquire(HEAVY_DECODE_MIN_PIXELS).is_none(),
            "第三个并发请求必须被闸门拒绝"
        );
        drop((first, second));
        assert_eq!(gate.active_count(), 0);
    }

    /// WS3 characterization（**非 RED**）：按需生成的 data_url 与旧预生成逐字节一致，
    /// 且 bytes-only 路径的成品字节与预生成路径完全相同——证明「tile 仅 bytes+dims +
    /// 请求路径按需编码」不改变 IPC `PageImage.dataUrl` 的内容与输出像素。
    #[test]
    fn webtoon_tile_data_url_from_bytes_matches_preencoded() {
        let raw = ultra_tall_page(64, 5000);
        // 旧：显式打开 encode_data_url 的预生成路径（对照基线行为）。
        let (_, pre) = render_webtoon_tiles_asset(&raw, 64, true).unwrap();
        // 新：桌面入口只保留 bytes+dims。
        let (_, tiles) = render_webtoon_tiles(&raw, 64).unwrap();
        assert_eq!(pre.len(), tiles.len());
        for (old, tile) in pre.iter().zip(tiles.iter()) {
            assert!(tile.data_url.is_empty(), "桌面 tile 不预生成 base64");
            assert_eq!(tile.bytes, old.bytes, "成品字节必须与预生成路径一致");
            assert_eq!(
                tile.data_url_from_bytes(),
                old.data_url,
                "按需生成的 data_url 必须与旧预生成逐字节一致（IPC 契约不变）"
            );
        }
    }
}
