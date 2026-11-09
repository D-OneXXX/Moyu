import type { SkinDefinition } from "./types";

/**
 * 画框视窗的材质 token。
 *
 * 内置「画框包裹」皮肤与用户导入的自定义背景共用同一套视窗材质：
 * 视窗向内收缩、外围留出画布，背景图铺满整片窗口。
 */
export const FRAMED_VIEWPORT_TOKENS: Record<string, string> = {
  // 视窗内缩：上下 72px、左右 96px，留出画框走位（角色与插画的画布带）。
  "--mr-skin-viewport-inset": "72px 96px 72px 96px",
  "--mr-skin-viewport-radius": "22px",
  "--mr-skin-viewport-border": "2px solid var(--sh-border)",
  "--mr-skin-viewport-shadow": "0 24px 52px -30px rgb(2 6 23 / 0.62)",
  // 毛玻璃视窗：底色透明 + 叠加层控制通透度。
  "--mr-skin-surface-bg": "transparent",
  "--mr-skin-surface-tint": "var(--sh-card)",
  "--mr-skin-surface-opacity": "0.72",
  "--mr-skin-surface-blur": "14px",
  // 画布底色跟随主题，外围画框因此在深浅两种主题下都成立。
  "--mr-skin-canvas-bg":
    "radial-gradient(circle at 16% 8%, rgb(56 168 248 / 0.24), transparent 52%), radial-gradient(circle at 88% 92%, rgb(56 168 248 / 0.18), transparent 55%), var(--sh-background)",
};

/**
 * 内置皮肤。
 *
 * 「极简」是默认档：视窗内缩为 0px，全屏铺满，不额外绘制任何东西。
 * 「画框包裹」把整片窗口变成一张主题画布：背景铺满全窗，内容视窗向内
 * 收缩留出外围画框，角色与插画就画在这圈画框上，与视窗严丝合缝。
 *
 * 皮肤是纯数据：token 覆盖 + 素材引用。没有任何组件需要知道皮肤存在。
 */
export const BUILTIN_SKINS: readonly SkinDefinition[] = [
  {
    id: "default",
    nameKey: "settings.skin.defaultName",
    descriptionKey: "settings.skin.defaultDescription",
    tokens: {},
  },
  {
    id: "framed",
    nameKey: "settings.skin.framedName",
    descriptionKey: "settings.skin.framedDescription",
    // 预留态：默认不生效。启用入口是代码注入美术资源包（addSkin + setSkin）。
    dormant: true,
    tokens: FRAMED_VIEWPORT_TOKENS,
    backdrop: { src: "/skins/framed-backdrop.svg" },
    frame: { src: "/skins/framed-frame.svg" },
  },
];

const BUNDLED_SKIN_PREFIX = "/skins/";
const DATA_IMAGE_PREFIX =
  /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

/**
 * The single funnel every skin artwork URL has to pass. Remote origins are
 * rejected outright so a skin can never widen the production CSP.
 */
export function resolveSkinAssetUrl(src: string): string | null {
  const value = src.trim();
  if (!value) return null;
  if (value.startsWith(BUNDLED_SKIN_PREFIX)) {
    if (value.includes("..") || value.includes("\\")) return null;
    return value;
  }
  if (DATA_IMAGE_PREFIX.test(value)) return value;
  return null;
}

/** Runtime registry: a future "install skin pack" flow only needs to push. */
const registry = new Map<string, SkinDefinition>(
  BUILTIN_SKINS.map((skin) => [skin.id, skin]),
);

export function listSkins(): readonly SkinDefinition[] {
  return [...registry.values()];
}

export function getSkin(id: string): SkinDefinition | undefined {
  return registry.get(id);
}

export function registerSkin(skin: SkinDefinition): void {
  registry.set(skin.id, skin);
}
