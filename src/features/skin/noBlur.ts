/**
 * Decides whether framed-skin surfaces must drop backdrop blur.
 *
 * Linux WebKitGTK falls back to software rasterization when DMABUF is
 * disabled (Wayland + NVIDIA, safe mode, or an explicit override); backdrop
 * filters then cost visible frames. `prefers-reduced-transparency` is the
 * user-facing equivalent for every platform.
 */
export function skinNoBlurEnabled(
  softwareRenderer: boolean,
  reducedTransparency: boolean,
): boolean {
  return softwareRenderer || reducedTransparency;
}
