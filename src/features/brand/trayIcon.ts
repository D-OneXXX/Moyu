/**
 * 把当前应用图标栅格化成 PNG data URL。
 *
 * 用途有两个：
 * - 托盘 / 任务栏图标（64×64，主题化，随主题切换即时重绘）；
 * - 交给 Rust 生成多尺寸 Windows `.ico`（256×256 源图）。
 *
 * 偏好只存 localStorage，Rust 读不到，所以由主窗口把活 SVG（预设）或
 * 自定义图片栅格化后经 IPC 推送。
 */
import {
  readBrandIconSelection,
  type BrandIconSelection,
} from "./brandIcon";

/** 托盘 / 任务栏图标边长。 */
export const TRAY_ICON_SIZE = 64;
/** 生成 `.ico` 时使用的源图边长。 */
export const APP_ICON_SOURCE_SIZE = 256;

function cssVarValue(name: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || "#000000";
}

/** Inline `var(--token)` inside fill/stroke/color/style so a detached SVG
 * keeps the current theme colors when drawn to canvas. */
function inlineCssVars(root: SVGElement): void {
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const attr of ["fill", "stroke", "color", "style"]) {
      const value = node.getAttribute(attr);
      if (value?.includes("var(")) {
        node.setAttribute(
          attr,
          value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) =>
            cssVarValue(name),
          ),
        );
      }
    }
    stack.push(...Array.from(node.children));
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("tray-icon-load"));
    image.src = src;
  });
}

function drawToPng(
  source: CanvasImageSource,
  width: number,
  height: number,
  size: number,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  // Aspect-fit on a transparent square; never crop a user's uploaded mark.
  const scale = Math.min(size / Math.max(1, width), size / Math.max(1, height));
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  ctx.drawImage(
    source,
    (size - drawWidth) / 2,
    (size - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return canvas.toDataURL("image/png");
}

async function customIconPng(
  dataUrl: string,
  size: number,
): Promise<string | null> {
  const image = await loadImage(dataUrl);
  return drawToPng(image, image.naturalWidth, image.naturalHeight, size);
}

async function presetIconPng(
  preset: string,
  size: number,
): Promise<string | null> {
  const svg = document.querySelector<SVGSVGElement>(
    `svg[data-brand-icon="${preset}"]`,
  );
  if (!svg) return null;
  const clone = svg.cloneNode(true) as SVGElement;
  inlineCssVars(clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(size));
  clone.setAttribute("height", String(size));
  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(
    new Blob([markup], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const image = await loadImage(url);
    return drawToPng(image, size, size, size);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Resolve the PNG for the current selection. Returns `null` when the live SVG
 * is not mounted yet or rasterization fails; the caller then falls back to the
 * bundled window icon.
 */
export async function renderAppIconPng(
  selection: BrandIconSelection = readBrandIconSelection(),
  size: number = TRAY_ICON_SIZE,
): Promise<string | null> {
  try {
    if (selection.kind === "custom") {
      return await customIconPng(selection.dataUrl, size);
    }
    return await presetIconPng(selection.preset, size);
  } catch {
    return null;
  }
}

/** 托盘 / 任务栏用的 64×64 PNG。 */
export async function renderTrayIconPng(
  selection: BrandIconSelection = readBrandIconSelection(),
): Promise<string | null> {
  return renderAppIconPng(selection, TRAY_ICON_SIZE);
}
