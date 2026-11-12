/** Match Rust fit_size and count only actual rendered rows; never upscale. */
export function webtoonTileCount(
  origW: number,
  origH: number,
  renderW: number,
  tileHeight: number,
): number {
  if (!(origW > 0) || !(origH > 0) || !(renderW > 0) || !(tileHeight > 0)) return 1;
  const displayH =
    origW > renderW
      ? Math.max(1, Math.round(origH * (renderW / origW)))
      : origH;
  return Math.max(1, Math.ceil(displayH / tileHeight));
}

/** 条漫布局的纯几何：页高/页起点前缀和。切片数不参与任何页级计算。 */
export interface StripPageBox {
  start: number;
  dispH: number;
}

export interface StripGeometry {
  pages: readonly StripPageBox[];
  total: number;
}

/** 后端 WEBTOON_TILE_H：单片显示高度上限。 */
const WEBTOON_TILE_H = 2048;
/** 宽高比视为“变了”的相对阈值：小于 2% 的差异不算纠正，避免来回抖动。 */
const RATIO_EPSILON = 0.02;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

const positiveFinite = (v: number) => Number.isFinite(v) && v > 0;

/** 前缀高度二分：返回 y 落在的逻辑页下标（越界钳到首/尾页）。O(log n)。 */
export function pageIndexAt(pages: readonly StripPageBox[], y: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= y) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 视口中心锚点（页下标 + 页内比例），与切了几片无关。 */
export function centerAnchor(
  layout: StripGeometry,
  top: number,
  viewportHeight: number,
): { page: number; frac: number } {
  if (layout.pages.length === 0) return { page: 0, frac: 0 };
  const mid = top + viewportHeight * 0.5;
  const page = pageIndexAt(layout.pages, mid);
  const p = layout.pages[page];
  return {
    page,
    frac: p && p.dispH > 0 ? clamp((mid - p.start) / p.dispH, 0, 1) : 0,
  };
}

export interface PageDimCorrection {
  /** 切片响应里的整页源尺寸（`PageImage.origWidth/origHeight`）。 */
  origWidth: number;
  origHeight: number;
  /** 该切片成品的实际像素尺寸（`PageImage.width/height`）。 */
  tileWidth: number;
  tileHeight: number;
  /** 当前布局里这一页的尺寸（可能是 (0,0) 占位）。 */
  currentWidth: number;
  currentHeight: number;
}

const isPlaceholder = (width: number, height: number) =>
  !positiveFinite(width) || !positiveFinite(height);

/**
 * L2 兜底“伪整页尺寸”：后端拿不到逻辑页尺寸时会用单片成品尺寸充当
 * `origWidth/origHeight`。特征 = 与成品切片像素框完全一致且高度到达整片
 * 上限（2048）。这类值绝不能回写布局，否则一页会被压成一张切片的高度。
 */
export function isTileShapedDimension(
  origWidth: number,
  origHeight: number,
  tileWidth: number,
  tileHeight: number,
): boolean {
  return (
    origWidth === tileWidth &&
    origHeight === tileHeight &&
    origHeight >= WEBTOON_TILE_H
  );
}

/**
 * 是否用解码后的真实整页尺寸纠正这一页的布局尺寸。
 *
 * - 零/非有限值：忽略；
 * - L2 兜底的切片尺寸：忽略；
 * - 当前尺寸无效（占位）：接受；
 * - 宽高比相差超过 2%：接受；
 * - 其余（含本地书的正常尺寸）：不动。
 */
export function shouldCorrectPageDims(input: PageDimCorrection): boolean {
  const { origWidth, origHeight, tileWidth, tileHeight } = input;
  if (isPlaceholder(origWidth, origHeight)) return false;
  if (isTileShapedDimension(origWidth, origHeight, tileWidth, tileHeight)) {
    return false;
  }
  const { currentWidth, currentHeight } = input;
  if (isPlaceholder(currentWidth, currentHeight)) return true;
  const current = currentHeight / currentWidth;
  const decoded = origHeight / origWidth;
  return (
    Math.abs(decoded - current) / Math.max(current, decoded) > RATIO_EPSILON
  );
}

/**
 * 布局尺寸被纠正后的滚动锚定：保持“视口中心看到的页 + 页内比例”不动。
 *
 * 纯函数，返回新的 `scrollTop`（已按新布局钳制到 [0, total - vh]）：
 * - 贴顶/贴底保持贴边；
 * - 被纠正的页在锚点之上时，等效 `scrollTop += deltaHeight`；
 * - 被纠正的页在锚点之下时，锚点页的 start 不变，滚动位置不变。
 */
export function reflowScrollTop(
  oldLayout: StripGeometry | null,
  newLayout: StripGeometry,
  top: number,
  viewportHeight: number,
): number {
  const newMax = Math.max(0, newLayout.total - viewportHeight);
  if (!oldLayout || oldLayout.pages.length === 0) {
    return clamp(top, 0, newMax);
  }
  if (top <= 0.5) return 0;
  const oldMax = Math.max(0, oldLayout.total - viewportHeight);
  if (oldMax <= 0.5 || top >= oldMax - 0.5) return newMax;
  const anchor = centerAnchor(oldLayout, top, viewportHeight);
  const page = Math.min(anchor.page, newLayout.pages.length - 1);
  const p = newLayout.pages[page];
  if (!p) return clamp(top, 0, newMax);
  return clamp(p.start + anchor.frac * p.dispH - viewportHeight * 0.5, 0, newMax);
}
