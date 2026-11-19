import type { Locale } from "@/i18n/config";
import type { MessageKey } from "@/i18n";

/**
 * 画框式皮肤（Task 21-3）。
 *
 * 皮肤只做两件事：
 *  1. 给整片窗口画布注入背景与外围画框（`--mr-skin-backdrop-image`、
 *     `--mr-skin-frame-overlay`）；
 *  2. 决定内容视窗的内缩边距与材质（`--mr-skin-viewport-inset` 等）。
 *
 * 没有「漂浮挂件」槽位：角色与插画属于画布美术的一部分，永远待在
 * 内容视窗的外围画框上，不可能压在列表或文字上面。
 *
 * 用户皮肤包（`.moyuskin`）只在 `<app_data_dir>/skins/<id>/` 落盘；
 * localStorage 仅保存轻量 id（`mr-skin`），绝不保存图片 data URL。
 */
export type SkinColorScheme = "light" | "dark" | "both";

/** 清单文本可为单一字符串或多语言对象（未提供当前语言时回落到 en / zh-CN）。 */
export type SkinText = string | Partial<Record<Locale, string>>;

export interface SkinAsset {
  src: string;
  width?: number;
  height?: number;
}

export interface SkinDefinition {
  id: string;
  /** 已安装皮肤的自定义名称（含多语言对象）。 */
  name?: SkinText;
  /** 内置皮肤的六语 key。 */
  nameKey?: MessageKey;
  description?: SkinText;
  descriptionKey?: MessageKey;
  author?: string;
  colorScheme?: SkinColorScheme;
  /** CSS 自定义属性（`--mr-*`），由 provider 注入到 <html>。 */
  tokens?: Record<string, string>;
  /** 整页画布背景（内置 CSS token 或后端校验后的 data URL）。 */
  backdrop?: SkinAsset;
  /** 视窗外围的画框装饰画布。 */
  frame?: SkinAsset;
  /** 展厅缩略图（后端生成的轻量 data URL）。 */
  preview?: SkinAsset;
  /** true = 随包内置，不允许导出/删除。 */
  builtin?: boolean;
  /** true = 来自 `<app_data_dir>/skins/<id>/`。 */
  installed?: boolean;
}

export interface SkinAssetPayload {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/** `list_installed_skins` 的轻量元数据。 */
export interface InstalledSkinSummary {
  id: string;
  name: SkinText;
  author: string;
  description?: SkinText | null;
  colorScheme: SkinColorScheme;
  tokens: Record<string, string>;
  previewDataUrl?: string | null;
}

/** `get_skin_bundle` 的按需完整资源（内存 LRU，不写 localStorage）。 */
export interface SkinBundlePayload {
  id: string;
  name: SkinText;
  author: string;
  description?: SkinText | null;
  colorScheme: SkinColorScheme;
  tokens: Record<string, string>;
  backdrop: SkinAssetPayload;
  frame?: SkinAssetPayload | null;
  preview?: SkinAssetPayload | null;
}
