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
