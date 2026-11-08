import type { SkinDefinition } from "./types";

/**
 * Demo companion artwork is an inline SVG data URL: it ships with the
 * bundle, needs no network, and is explicitly allowed by
 * `img-src 'self' data:`. SVG inside `<img>` cannot execute scripts.
 */
const INK_MASCOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <defs>
    <linearGradient id="inkBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7fd0ff"/>
      <stop offset="1" stop-color="#38a8f8"/>
    </linearGradient>
  </defs>
  <g>
    <path d="M60 14c22 0 38 16 38 38v20c0 10-8 18-18 18H40c-10 0-18-8-18-18V52c0-22 16-38 38-38z" fill="url(#inkBody)" stroke="#09090b" stroke-width="4"/>
    <path d="M35 88c-4 10-10 16-16 18 8 2 16 0 22-4M52 90c-2 10-6 16-10 20 8 0 14-4 18-10M68 90c2 10 6 16 10 20-8 0-14-4-18-10M85 88c4 10 10 16 16 18-8 2-16 0-22-4" fill="none" stroke="#09090b" stroke-width="4" stroke-linecap="round"/>
    <ellipse cx="46" cy="52" rx="7" ry="9" fill="#09090b"/>
    <ellipse cx="74" cy="52" rx="7" ry="9" fill="#09090b"/>
    <circle cx="43" cy="48" r="2.5" fill="#ffffff"/>
    <circle cx="71" cy="48" r="2.5" fill="#ffffff"/>
    <path d="M52 70c5 4 11 4 16 0" fill="none" stroke="#09090b" stroke-width="4" stroke-linecap="round"/>
    <path d="M32 34c4-8 10-12 16-14" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.7"/>
  </g>
</svg>`;

const INK_MASCOT_URL = `data:image/svg+xml;base64,${btoa(
  INK_MASCOT_SVG.replace(/\s{2,}/g, " ").trim(),
)}`;

/**
 * Built-in skins. A skin is data only: token overrides plus decorations.
 * No component has to know a skin exists, which keeps the default UI and any
 * future art pack on exactly the same code path.
 */
export const BUILTIN_SKINS: readonly SkinDefinition[] = [
  {
    id: "default",
    nameKey: "settings.skin.defaultName",
    descriptionKey: "settings.skin.defaultDescription",
    tokens: {},
    decorations: [],
  },
  {
    id: "ink-companion",
    nameKey: "settings.skin.companionName",
    descriptionKey: "settings.skin.companionDescription",
    tokens: {
      "--mr-radius-card": "1.5rem",
      "--mr-radius-sheet": "1.75rem",
      "--mr-border-width": "1.5px",
      "--mr-shadow-elevation": "0 6px 0 0 var(--mi-hard-shadow)",
      "--mr-shadow-elevation-sm": "0 3px 0 0 var(--mi-hard-shadow)",
      "--mr-decoration-opacity": "0.96",
      "--mr-surface-backdrop":
        "radial-gradient(circle at 82% 0%, rgb(56 168 248 / 0.16), transparent 55%)",
    },
    decorations: [
      {
        id: "companion-perch",
        slot: "window-perch-top",
        asset: { src: INK_MASCOT_URL, sizePx: 52, motion: "bob" },
      },
      {
        id: "companion-corner",
        slot: "corner-companion-bottom-right",
        asset: { src: INK_MASCOT_URL, sizePx: 112, motion: "bob" },
      },
    ],
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
