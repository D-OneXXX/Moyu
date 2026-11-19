import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  InstalledSkinSummary,
  SkinAssetPayload,
  SkinBundlePayload,
} from "./types";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const BUNDLE_CACHE_LIMIT = 3;

/** Session-only cache; Rust keeps its own LRU. Never persisted. */
const bundleCache = new Map<string, SkinBundlePayload>();

/**
 * Lets the user pick one local artwork file and asks Rust to validate it.
 *
 * The file never loads through a URL: Rust sniffs the magic bytes, probes the
 * header dimensions, enforces the 4 MB / 4096 px budget and returns a
 * `data:image/…;base64,…` payload. Returns `null` when the user cancels.
 */
export async function pickSkinArtwork(): Promise<SkinAssetPayload | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof picked !== "string") return null;
  return invoke<SkinAssetPayload>("skin_import_asset", { path: picked });
}

/** Validates one already-picked path and returns a CSP-safe preview. */
export async function readSkinArtwork(
  path: string,
): Promise<SkinAssetPayload> {
  return invoke<SkinAssetPayload>("skin_import_asset", { path });
}

export async function listInstalledSkins(): Promise<InstalledSkinSummary[]> {
  const skins = await invoke<InstalledSkinSummary[]>("list_installed_skins");
  return Array.isArray(skins) ? skins : [];
}

export async function getSkinBundle(
  skinId: string,
): Promise<SkinBundlePayload | null> {
  const cached = bundleCache.get(skinId);
  if (cached) return cached;
  try {
    const bundle = await invoke<SkinBundlePayload>("get_skin_bundle", {
      skinId,
    });
    if (!bundle || bundle.id !== skinId) return null;
    bundleCache.set(skinId, bundle);
    while (bundleCache.size > BUNDLE_CACHE_LIMIT) {
      const oldest = bundleCache.keys().next().value;
      if (typeof oldest !== "string") break;
      bundleCache.delete(oldest);
    }
    return bundle;
  } catch {
    return null;
  }
}

export function forgetSkinBundle(skinId: string): void {
  bundleCache.delete(skinId);
}

export async function importSkinPack(): Promise<InstalledSkinSummary | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Moyu Skin", extensions: ["moyuskin"] }],
  });
  if (typeof picked !== "string") return null;
  return invoke<InstalledSkinSummary>("import_skin_pack", { path: picked });
}

/** Opens the native picker for the quick custom-skin builder. */
export async function pickBackdropImage(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Frames need transparency, so the picker is PNG-only. */
export async function pickFrameImage(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export interface CustomSkinInput {
  name: string;
  backdropPath: string;
  framePath?: string | null;
  insetPx: number;
  opacity: number;
}

export async function createCustomSkin(
  input: CustomSkinInput,
): Promise<InstalledSkinSummary> {
  return invoke<InstalledSkinSummary>("create_custom_skin_from_image", {
    name: input.name,
    backdropPath: input.backdropPath,
    framePath: input.framePath ?? null,
    insetPx: Math.round(input.insetPx),
    opacity: input.opacity,
  });
}

export async function exportSkinPack(
  skinId: string,
  suggestedName: string,
): Promise<boolean> {
  const safeName =
    suggestedName
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "moyu-skin";
  const target = await saveDialog({
    defaultPath: `${safeName}.moyuskin`,
    filters: [{ name: "Moyu Skin", extensions: ["moyuskin"] }],
  });
  if (typeof target !== "string") return false;
  await invoke<boolean>("export_skin_pack", {
    skinId,
    targetPath: target,
  });
  return true;
}

export async function deleteSkinPack(skinId: string): Promise<boolean> {
  const deleted = await invoke<boolean>("delete_skin_pack", { skinId });
  forgetSkinBundle(skinId);
  return Boolean(deleted);
}
