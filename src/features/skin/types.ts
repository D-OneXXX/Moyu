import type { MessageKey } from "@/i18n";

/**
 * 皮肤配置包（Task 7 · 画框包裹式）。
 *
 * 皮肤只做两件事：
 *  1. 给整片窗口画布注入背景与外围画框（`--mr-skin-backdrop-image`、
 *     `--mr-skin-frame-overlay`）；
 *  2. 决定内容视窗的内缩边距与材质（`--mr-skin-viewport-inset` 等）。
 *
 * 这里没有「漂浮挂件」槽位：角色与插画属于画布美术的一部分，永远待在
 * 内容视窗的外围画框上，不可能压在列表或文字上面。
 */
export interface SkinAsset {
  src: string;
  width?: number;
  height?: number;
}

export interface SkinDefinition {
  id: string;
  nameKey: MessageKey;
  descriptionKey?: MessageKey;
  /** CSS 自定义属性（`--mr-*`），由 provider 注入到 <html>。 */
  tokens?: Record<string, string>;
  /** 整页画布背景（内置静态路径或后端校验后的 data URL）。 */
  backdrop?: SkinAsset;
  /** 视窗外围的画框装饰画布。 */
  frame?: SkinAsset;
}

export interface SkinAssetPayload {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}
