/**
 * 品牌图标偏好：预设图标 + 用户自选图片。
 *
 * 这是纯前端 UI 偏好，只写 localStorage，不进入 SQLite / 日志 / 备份：
 * - 自定义图标以 data URL 形式驻留本机，不读取路径、不上传；
 * - 存储值必须通过 `isBrandIconSelection` 的结构、MIME 与长度校验；
 * - 启动时由 `storageSanitizer` 再清洗一次，脏值回落到默认预设。
 */

export const BRAND_ICON_STORAGE_KEY = "mr-brand-icon";
export const BRAND_ICON_EVENT = "mr-brand-icon-change";

export const BRAND_ICON_PRESETS = ["book", "fish", "moon", "wave"] as const;

export type BrandIconPreset = (typeof BRAND_ICON_PRESETS)[number];

export type BrandIconSelection =
  | { kind: "preset"; preset: BrandIconPreset }
  | { kind: "custom"; dataUrl: string };

export type CustomBrandIconErrorCode =
  | "type"
  | "size"
  | "dimension"
  | "read";

export const DEFAULT_BRAND_ICON: BrandIconSelection = {
  kind: "preset",
  preset: "book",
};

/** 单张自定义图标的原始文件上限（200 KiB）。 */
export const MAX_CUSTOM_ICON_FILE_BYTES = 200 * 1024;
/** 自定义图标的单边像素上限；超出直接拒绝，避免把大图塞进 localStorage。 */
export const MAX_CUSTOM_ICON_DIMENSION = 1024;
/** data URL 字符上限，与 storageSanitizer 的规则保持一致。 */
export const MAX_CUSTOM_ICON_DATA_URL_CHARS = 280 * 1024;

const ALLOWED_ICON_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const CUSTOM_ICON_DATA_URL =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface BrandIconStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class CustomBrandIconError extends Error {
  readonly code: CustomBrandIconErrorCode;

  constructor(code: CustomBrandIconErrorCode) {
    super(code);
    this.name = "CustomBrandIconError";
    this.code = code;
  }
}

function safeStorage(): BrandIconStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function isBrandIconPreset(value: unknown): value is BrandIconPreset {
  return (
    typeof value === "string" &&
    (BRAND_ICON_PRESETS as readonly string[]).includes(value)
  );
}

function isCustomIconDataUrl(value: string): boolean {
  return (
    value.length <= MAX_CUSTOM_ICON_DATA_URL_CHARS &&
    CUSTOM_ICON_DATA_URL.test(value)
  );
}

export function isBrandIconSelection(
  value: unknown,
): value is BrandIconSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "preset") return isBrandIconPreset(record.preset);
  if (record.kind === "custom") {
    return (
      typeof record.dataUrl === "string" && isCustomIconDataUrl(record.dataUrl)
    );
  }
  return false;
}

export function readBrandIconSelection(
  storage: BrandIconStorage | null = safeStorage(),
): BrandIconSelection {
  if (!storage) return DEFAULT_BRAND_ICON;
  try {
    const raw = storage.getItem(BRAND_ICON_STORAGE_KEY);
    if (!raw) return DEFAULT_BRAND_ICON;
    const parsed: unknown = JSON.parse(raw);
    return isBrandIconSelection(parsed) ? parsed : DEFAULT_BRAND_ICON;
  } catch {
    return DEFAULT_BRAND_ICON;
  }
}

function emit(selection: BrandIconSelection): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BrandIconSelection>(BRAND_ICON_EVENT, {
      detail: selection,
    }),
  );
}

/** 写入偏好；quota/隐私模式失败返回 false，调用方负责提示。 */
export function writeBrandIconSelection(
  selection: BrandIconSelection,
  storage: BrandIconStorage | null = safeStorage(),
): boolean {
  if (!isBrandIconSelection(selection) || !storage) return false;
  try {
    storage.setItem(BRAND_ICON_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    return false;
  }
  emit(selection);
  return true;
}

/** 恢复默认预设。 */
export function clearBrandIconSelection(
  storage: BrandIconStorage | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(BRAND_ICON_STORAGE_KEY);
  } catch {
    return false;
  }
  emit(DEFAULT_BRAND_ICON);
  return true;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new CustomBrandIconError("read"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new CustomBrandIconError("read"));
    };
    reader.readAsDataURL(file);
  });
}

function measureIcon(dataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth < 1 || image.naturalHeight < 1) {
        reject(new CustomBrandIconError("read"));
        return;
      }
      if (
        image.naturalWidth > MAX_CUSTOM_ICON_DIMENSION ||
        image.naturalHeight > MAX_CUSTOM_ICON_DIMENSION
      ) {
        reject(new CustomBrandIconError("dimension"));
        return;
      }
      resolve();
    };
    image.onerror = () => reject(new CustomBrandIconError("read"));
    image.src = dataUrl;
  });
}

/**
 * 把用户选择的本地图片转成受控的 data URL。
 * 只接受 PNG / JPEG / WebP，并在写偏好前校验文件大小与像素尺寸。
 */
export async function loadCustomBrandIcon(
  file: File,
): Promise<BrandIconSelection> {
  if (!ALLOWED_ICON_TYPES.has(file.type)) {
    throw new CustomBrandIconError("type");
  }
  if (file.size < 1 || file.size > MAX_CUSTOM_ICON_FILE_BYTES) {
    throw new CustomBrandIconError("size");
  }
  const dataUrl = await readFileAsDataUrl(file);
  if (!isCustomIconDataUrl(dataUrl)) {
    throw new CustomBrandIconError("read");
  }
  await measureIcon(dataUrl);
  return { kind: "custom", dataUrl };
}
