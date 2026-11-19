import type { Locale } from "@/i18n/config";
import type { MessageKey } from "@/i18n";
import type {
  SkinBundlePayload,
  SkinDefinition,
  SkinText,
} from "./types";

/**
 * 内置画框预设（Task 21-3）。
 *
 * 全部由纯 CSS 渐变/纹理构成，零外部素材、零网络依赖，亮暗主题都通过
 * `--mr-*` 主题变量切换（见 `src/index.css`）。`default` 保持 0px 全屏，
 * 其余三套是非零内缩的画框视窗。
 */
const INK_TOKENS: Record<string, string> = {
  "--mr-skin-viewport-inset": "28px 36px 28px 36px",
  "--mr-skin-viewport-radius": "20px",
  "--mr-skin-viewport-border": "1px solid var(--mr-ink-border)",
  "--mr-skin-viewport-shadow": "var(--mr-ink-shadow)",
  "--mr-skin-surface-bg": "transparent",
  "--mr-skin-surface-tint": "var(--mr-ink-surface)",
  "--mr-skin-surface-opacity": "0.93",
  "--mr-skin-surface-blur": "10px",
  "--mr-skin-canvas-bg": "var(--mr-ink-canvas)",
  "--mr-skin-backdrop-image": "var(--mr-ink-backdrop)",
  "--mr-skin-frame-overlay": "var(--mr-ink-frame)",
  "--mr-skin-backdrop-size": "cover",
  "--mr-skin-backdrop-position": "center",
  "--mr-skin-frame-size": "cover",
  "--mr-skin-frame-position": "center",
};

const MIDNIGHT_TOKENS: Record<string, string> = {
  "--mr-skin-viewport-inset": "24px 32px 24px 32px",
  "--mr-skin-viewport-radius": "18px",
  "--mr-skin-viewport-border": "1px solid var(--mr-midnight-border)",
  "--mr-skin-viewport-shadow": "var(--mr-midnight-shadow)",
  "--mr-skin-surface-bg": "transparent",
  "--mr-skin-surface-tint": "var(--sh-card)",
  "--mr-skin-surface-opacity": "0.78",
  "--mr-skin-surface-blur": "18px",
  "--mr-skin-canvas-bg": "var(--mr-midnight-canvas)",
  "--mr-skin-backdrop-image": "var(--mr-midnight-backdrop)",
  "--mr-skin-frame-overlay": "var(--mr-midnight-frame)",
  "--mr-skin-backdrop-size": "cover",
  "--mr-skin-backdrop-position": "center",
  "--mr-skin-frame-size": "cover",
  "--mr-skin-frame-position": "center",
};

const PASTEL_TOKENS: Record<string, string> = {
  "--mr-skin-viewport-inset": "32px 40px 32px 40px",
  "--mr-skin-viewport-radius": "30px",
  "--mr-skin-viewport-border": "1px solid var(--mr-pastel-border)",
  "--mr-skin-viewport-shadow": "var(--mr-pastel-shadow)",
  "--mr-skin-surface-bg": "transparent",
  "--mr-skin-surface-tint": "var(--mr-pastel-surface)",
  "--mr-skin-surface-opacity": "0.90",
  "--mr-skin-surface-blur": "12px",
  "--mr-skin-canvas-bg": "var(--mr-pastel-canvas)",
  "--mr-skin-backdrop-image": "var(--mr-pastel-backdrop)",
  "--mr-skin-frame-overlay": "var(--mr-pastel-frame)",
  "--mr-skin-backdrop-size": "cover",
  "--mr-skin-backdrop-position": "center",
  "--mr-skin-frame-size": "cover",
  "--mr-skin-frame-position": "center",
};

export const BUILTIN_SKINS: readonly SkinDefinition[] = [
  {
    id: "default",
    nameKey: "settings.skin.defaultName",
    descriptionKey: "settings.skin.defaultDescription",
    colorScheme: "both",
    builtin: true,
    tokens: {},
  },
  {
    id: "ink",
    nameKey: "settings.skin.inkName",
    descriptionKey: "settings.skin.inkDescription",
    colorScheme: "both",
    builtin: true,
    tokens: INK_TOKENS,
  },
  {
    id: "midnight",
    nameKey: "settings.skin.midnightName",
    descriptionKey: "settings.skin.midnightDescription",
    colorScheme: "dark",
    builtin: true,
    tokens: MIDNIGHT_TOKENS,
  },
  {
    id: "pastel",
    nameKey: "settings.skin.pastelName",
    descriptionKey: "settings.skin.pastelDescription",
    colorScheme: "both",
    builtin: true,
    tokens: PASTEL_TOKENS,
  },
];

const BUNDLED_SKIN_PREFIX = "/skins/";
const DATA_IMAGE_PREFIX =
  /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_TOKEN_NAME = /^--mr-[a-z0-9-]+$/;

/**
 * The single funnel every skin artwork URL has to pass. Remote origins are
 * rejected outright so a skin can never widen the production CSP. SVG is
 * excluded on purpose: skin packs are raster-only.
 */
export function resolveSkinAssetUrl(src: string): string | null {
  const value = src.trim();
  if (!value) return null;
  if (value.startsWith(BUNDLED_SKIN_PREFIX)) {
    if (
      value.includes("..") ||
      value.includes("\\") ||
      value.includes("//")
    ) {
      return null;
    }
    return value;
  }
  if (DATA_IMAGE_PREFIX.test(value)) return value;
  return null;
}

/** Runtime registry: installed packs are pushed after their bundle loads. */
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

/** Drops a user-installed definition; built-ins are immutable. */
export function unregisterSkin(id: string): boolean {
  const existing = registry.get(id);
  if (!existing || existing.builtin) return false;
  return registry.delete(id);
}

/** Maps a backend bundle into the runtime skin definition. */
export function skinFromBundle(bundle: SkinBundlePayload): SkinDefinition {
  return {
    id: bundle.id,
    name: bundle.name,
    author: bundle.author,
    description: bundle.description ?? undefined,
    colorScheme: bundle.colorScheme,
    builtin: false,
    installed: true,
    tokens: { ...bundle.tokens },
    backdrop: {
      src: bundle.backdrop.dataUrl,
      width: bundle.backdrop.width,
      height: bundle.backdrop.height,
    },
    frame: bundle.frame
      ? {
          src: bundle.frame.dataUrl,
          width: bundle.frame.width,
          height: bundle.frame.height,
        }
      : undefined,
    preview: bundle.preview
      ? { src: bundle.preview.dataUrl }
      : undefined,
  };
}

/** Picks the best localized variant from a manifest text value. */
export function localizedSkinText(
  value: SkinText | null | undefined,
  locale: Locale,
): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  const candidates = [value[locale], value.en, value["zh-CN"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  const first = Object.values(value).find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  return first;
}

export function skinDisplayName(
  skin: SkinDefinition,
  locale: Locale,
  t: (key: MessageKey) => string,
): string {
  if (skin.nameKey) return t(skin.nameKey);
  return localizedSkinText(skin.name, locale) ?? skin.id;
}

export function skinDescriptionText(
  skin: SkinDefinition,
  locale: Locale,
  t: (key: MessageKey) => string,
): string | undefined {
  if (skin.descriptionKey) return t(skin.descriptionKey);
  return localizedSkinText(skin.description, locale);
}

/**
 * `--mr-*` token filtering at the last mile. Installed packs are already
 * validated by Rust; this guard exists so a future frontend caller cannot
 * smuggle declarations through a skin object by accident.
 */
function safeTokens(tokens: Record<string, string> | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens ?? {})) {
    if (!SAFE_TOKEN_NAME.test(name)) continue;
    if (!value || value.length > 320) continue;
    if (/[;{}]|url\s*\(|@import|\\/i.test(value)) continue;
    safe[name] = value;
  }
  return safe;
}

/**
 * 皮肤 token → CSS 自定义属性。
 *
 * 素材引用会被折算成 `url("…")`；非法来源（远程地址等）直接丢弃，
 * 因此皮肤永远无法放宽生产 CSP。
 */
export function skinTokens(skin: SkinDefinition): Record<string, string> {
  const tokens: Record<string, string> = safeTokens(skin.tokens);
  const backdrop = skin.backdrop ? resolveSkinAssetUrl(skin.backdrop.src) : null;
  if (backdrop) {
    tokens["--mr-skin-backdrop-image"] = `url("${backdrop}")`;
  }
  const frame = skin.frame ? resolveSkinAssetUrl(skin.frame.src) : null;
  if (frame) {
    tokens["--mr-skin-frame-overlay"] = `url("${frame}")`;
  }
  return tokens;
}
