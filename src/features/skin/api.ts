import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { SkinAssetPayload } from "./types";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

/**
 * Lets the user pick one local artwork file and asks Rust to validate it.
 *
 * The file never loads through a URL: Rust sniffs the magic bytes, probes the
 * header dimensions, enforces the 8 MB / 4096 px budget and returns a
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
