/**
 * 自定义整页背景的本地持久化。
 *
 * 皮肤背景只有两条合法通道：随包静态文件，或后端校验后产生的 `data:` URL。
 * 用户导入的整页背景走第二条，因此要跨重启保留，就必须把这条 `data:` URL
 * 一起存下来——它不会落 SQLite、不进日志、也不会离开本机。
 *
 * 体积是硬约束：浏览器 localStorage 的配额只有几 MB，所以这里给持久化
 * 设一个比后端 8 MiB 更紧的上限；超过上限的图仍然可以在本次会话里生效，
 * 只是重启后需要重新导入。
 */
import { FRAMED_VIEWPORT_TOKENS } from "./registry";
import type { SkinDefinition } from "./types";

/** 本地持久化的自定义皮肤键（必须同时登记进 storageSanitizer）。 */
export const CUSTOM_SKIN_STORAGE_KEY = "mr-skin-custom";

/** 可持久化的背景上限（data URL 字符数），留出 localStorage 配额余量。 */
export const MAX_PERSISTED_SKIN_CHARS = 1_800_000;

export interface PersistedCustomSkin {
  /** 稳定 id：`custom-<内容哈希>`，重启后仍指向同一张图。 */
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

const CUSTOM_SKIN_ID = /^custom-[a-f0-9]{12}$/;
const CUSTOM_SKIN_DATA_URL =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** 内容哈希（FNV-1a 32 位）：同一张图永远得到同一个 id。 */
export function hashSkinAsset(dataUrl: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < dataUrl.length; index += 1) {
    hash ^= dataUrl.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function customSkinId(dataUrl: string): string {
  return `custom-${hashSkinAsset(dataUrl)}`;
}

/** 由持久化的背景还原出一个皮肤定义（画框视窗 + 整页背景）。 */
export function customSkinDefinition(
  persisted: PersistedCustomSkin,
): SkinDefinition {
  return {
    id: persisted.id,
    nameKey: "settings.skin.customName",
    descriptionKey: "settings.skin.importHint",
    tokens: FRAMED_VIEWPORT_TOKENS,
    backdrop: {
      src: persisted.dataUrl,
      width: persisted.width,
      height: persisted.height,
    },
  };
}

export function isPersistedCustomSkin(
  value: unknown,
): value is PersistedCustomSkin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    CUSTOM_SKIN_ID.test(record.id) &&
    typeof record.dataUrl === "string" &&
    record.dataUrl.length <= MAX_PERSISTED_SKIN_CHARS &&
    CUSTOM_SKIN_DATA_URL.test(record.dataUrl) &&
    typeof record.width === "number" &&
    typeof record.height === "number"
  );
}

/** 读取持久化的自定义背景；脏值一律按「没有」处理。 */
export function readPersistedCustomSkin(): PersistedCustomSkin | null {
  try {
    const raw = localStorage.getItem(CUSTOM_SKIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedCustomSkin(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写入持久化；配额不足返回 false（调用方负责提示「本次会话有效」）。 */
export function writePersistedCustomSkin(
  skin: PersistedCustomSkin,
): boolean {
  if (!isPersistedCustomSkin(skin)) return false;
  try {
    localStorage.setItem(CUSTOM_SKIN_STORAGE_KEY, JSON.stringify(skin));
    return true;
  } catch {
    return false;
  }
}
