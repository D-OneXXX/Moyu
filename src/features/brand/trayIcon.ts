/**
 * Rasterize the active brand icon (Task 7 preset or custom upload) into a
 * 64×64 PNG data URL for the native tray.
 *
 * Task 7 keeps the preference in `localStorage` only, so Rust cannot read it
 * directly. The main window resolves the live `<svg>` (presets are theme-token
 * colored) or the custom image, then pushes the PNG through `tray_set_icon`.
 */
import {
  readBrandIconSelection,
  type BrandIconSelection,
} from "./brandIcon";

const TRAY_ICON_SIZE = 64;

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
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = TRAY_ICON_SIZE;
  canvas.height = TRAY_ICON_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, TRAY_ICON_SIZE, TRAY_ICON_SIZE);
  // Aspect-fit on a transparent square; never crop a user's uploaded mark.
  const scale = Math.min(
    TRAY_ICON_SIZE / Math.max(1, width),
    TRAY_ICON_SIZE / Math.max(1, height),
  );
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  ctx.drawImage(
    source,
    (TRAY_ICON_SIZE - drawWidth) / 2,
    (TRAY_ICON_SIZE - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return canvas.toDataURL("image/png");
}

async function customIconPng(dataUrl: string): Promise<string | null> {
  const image = await loadImage(dataUrl);
  return drawToPng(image, image.naturalWidth, image.naturalHeight);
}

async function presetIconPng(preset: string): Promise<string | null> {
  const svg = document.querySelector<SVGSVGElement>(
    `svg[data-brand-icon="${preset}"]`,
  );
  if (!svg) return null;
  const clone = svg.cloneNode(true) as SVGElement;
  inlineCssVars(clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(TRAY_ICON_SIZE));
  clone.setAttribute("height", String(TRAY_ICON_SIZE));
  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(
    new Blob([markup], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const image = await loadImage(url);
    return drawToPng(image, TRAY_ICON_SIZE, TRAY_ICON_SIZE);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Resolve the tray PNG for the current selection. Returns `null` when the
 * live SVG is not mounted yet or rasterization fails; the caller then falls
 * back to the bundled window icon.
 */
export async function renderTrayIconPng(
  selection: BrandIconSelection = readBrandIconSelection(),
): Promise<string | null> {
  try {
    if (selection.kind === "custom") {
      return await customIconPng(selection.dataUrl);
    }
    return await presetIconPng(selection.preset);
  } catch {
    return null;
  }
}
