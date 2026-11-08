import type { MessageKey } from "@/i18n";

/**
 * Fixed decoration anchors. A skin may only mount artwork into these four
 * slots; adding a slot is a layout decision, not a skin decision, so the
 * anchor list stays closed.
 */
export type SkinSlotId =
  | "window-perch-top"
  | "corner-companion-bottom-left"
  | "corner-companion-bottom-right"
  | "window-frame-surround";

export const SKIN_SLOT_IDS: readonly SkinSlotId[] = [
  "window-perch-top",
  "corner-companion-bottom-left",
  "corner-companion-bottom-right",
  "window-frame-surround",
];

export type SkinAssetMotion = "none" | "bob";

/**
 * Artwork source. Only two channels are legal under the production CSP
 * (`img-src 'self' data:`):
 *   1. a bundled static path under `/skins/…`;
 *   2. a `data:image/…;base64,…` payload produced by the Rust validator.
 * `resolveSkinAssetUrl` rejects everything else, including remote URLs.
 */
export interface SkinAsset {
  src: string;
  width?: number;
  height?: number;
  /** Rendered height in px; width follows the intrinsic ratio. */
  sizePx?: number;
  motion?: SkinAssetMotion;
}

export interface SkinDecoration {
  id: string;
  slot: SkinSlotId;
  asset: SkinAsset;
  /** Only opt into hit-testing for a sliver that really is interactive. */
  interactive?: boolean;
  /** Non-empty alt text makes the decoration perceivable; otherwise hidden. */
  alt?: string;
}

export interface SkinDefinition {
  id: string;
  nameKey: MessageKey;
  descriptionKey?: MessageKey;
  /** CSS custom properties (`--mr-*`) injected on `<html>` by the provider. */
  tokens?: Record<string, string>;
  decorations?: readonly SkinDecoration[];
}

export interface SkinAssetPayload {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}
