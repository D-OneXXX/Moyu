import { Channel, invoke } from "@tauri-apps/api/core";

import { platformKind } from "@/lib/platform";

/**
 * Front-end facade for the official Tauri updater channel.
 *
 * The endpoint and the minisign public key stay baked into the build config
 * (`tauri.conf.json plugins.updater`). The webview no longer holds the
 * `updater:default` capability, so `plugin:updater|check` and
 * `plugin:updater|download_and_install` are blocked by the ACL; everything goes
 * through the app-owned `check_native_update` / `install_native_update`
 * commands, which enforce the updates feature gate before touching the updater.
 * Signature verification and installer execution stay in Rust; the webview only
 * receives sizes, versions and text.
 */

export interface NativeUpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

/** Backend payload: display info plus the manifest replayed at install time. */
interface NativeUpdatePayload extends NativeUpdateInfo {
  /** Signed manifest cached by the backend; never logged or persisted. */
  rawJson: unknown;
}

/** An announced update plus the manifest needed to install it. */
export interface NativeUpdateCheck {
  info: NativeUpdateInfo;
  rawJson: unknown;
}

export interface NativeDownloadProgress {
  /** Bytes written so far. */
  downloaded: number;
  /** Total bytes when the server announced a content length. */
  total: number | null;
  /** 0-100, or null while the total size is unknown. */
  percent: number | null;
}

export type NativeInstallEvent =
  | ({ phase: "downloading" } & NativeDownloadProgress)
  | { phase: "installing" };

/** Wire format of `NativeInstallEvent` on the Rust side (adjacent tagging). */
type NativeInstallEventPayload =
  | { event: "started"; data: { contentLength: number | null } }
  | {
      event: "progress";
      data: { downloaded: number; total: number | null; chunkLength: number };
    }
  | { event: "installing" };

export type NativeUpdateFailureStage = "check" | "install" | "relaunch";

function messageOf(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "";
}

/**
 * Plugin errors can embed the signed download endpoint. Strip any URL before
 * writing a debug line; keys, headers and tokens never reach the console.
 */
export function reportNativeUpdateFailure(
  stage: NativeUpdateFailureStage,
  reason: unknown,
): void {
  const safe = messageOf(reason).replace(/https?:\/\/\S+/gi, "[redacted-url]");
  const name = reason instanceof Error ? reason.name : "Error";
  console.error(`[update-native] ${stage} failed (${name})`, safe);
}

/** Windows installers relaunch the app themselves; other targets need help. */
export function isWindowsPlatform(): boolean {
  return platformKind() === "windows";
}

/** 更新下载前预检系统临时目录剩余空间；探测失败返回 null。 */
export async function getTempFreeBytes(): Promise<number | null> {
  return invoke<number | null>("get_temp_free_bytes");
}

/**
 * Manual check against the endpoints configured in `tauri.conf.json`.
 *
 * The backend command enforces the `updates` feature gate first (stable code
 * `feature-disabled`) and returns the manifest needed for a later install.
 */
export async function checkNativeUpdate(): Promise<NativeUpdateCheck | null> {
  const payload = await invoke<NativeUpdatePayload | null>(
    "check_native_update",
  );
  if (!payload) return null;
  const { rawJson, ...info } = payload;
  return { info, rawJson };
}

/**
 * Download the signed package and hand it to the installer.
 *
 * The backend restores the update from the manifest already handed out by
 * {@link checkNativeUpdate} (no second network check), rejects a version that no
 * longer matches, then streams progress over a Channel. On Windows the app exits
 * once the NSIS installer starts — this only happens after the user pressed the
 * install button. On other platforms the promise resolves after installation and
 * the caller must call {@link relaunchApp}.
 */
export async function installNativeUpdate(
  check: NativeUpdateCheck,
  onProgress?: (event: NativeInstallEvent) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  const emitProgress = () => {
    if (!onProgress) return;
    const percent =
      total && total > 0
        ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
        : null;
    onProgress({ phase: "downloading", downloaded, total, percent });
  };

  const onEvent = new Channel<NativeInstallEventPayload>();
  onEvent.onmessage = (payload) => {
    if (payload.event === "started") {
      const length = payload.data?.contentLength;
      total = typeof length === "number" && length > 0 ? length : null;
      downloaded = 0;
      emitProgress();
      return;
    }
    if (payload.event === "progress") {
      downloaded = payload.data?.downloaded ?? 0;
      const length = payload.data?.total;
      total = typeof length === "number" && length > 0 ? length : total;
      emitProgress();
      return;
    }
    onProgress?.({ phase: "installing" });
  };

  await invoke<void>("install_native_update", {
    expectedVersion: check.info.version,
    rawJson: check.rawJson,
    onEvent,
  });
}

/** Restart the app after a non-Windows install (user-clicked only). */
export async function relaunchApp(): Promise<void> {
  await invoke<void>("restart_app");
}
