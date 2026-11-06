/**
 * D1b Web Access control-plane view types.
 *
 * Mirrors `src-tauri/src/web_access/runtime.rs` (serde camelCase). Snapshots
 * never contain a pairing id, claim secret, hash, token, or path; the pairing
 * id only travels inside `PairingWindowView.url`'s fragment.
 */

export type WebAccessPhase =
  | "disabled"
  | "starting"
  | "enabled"
  | "stopping"
  | "error";

export interface WebAccessStatusView {
  phase: WebAccessPhase | string;
  transport: "http" | "https" | null;
  bindAddress: string | null;
  bindIp: string | null;
  port: number | null;
  caInitialized: boolean;
  rootFingerprintSha256: string | null;
  leafFingerprintSha256: string | null;
  leafNotAfter: number | null;
  certificateState: string | null;
  deviceCount: number;
  pendingClaimCount: number;
  pairingActive: boolean;
  lastErrorCode: string | null;
  stopReason: string | null;
}

export interface LanAddressView {
  ip: string;
  interface: string;
}

export interface PairingWindowView {
  /** Pairing URL; the pairing id is only in the fragment. */
  url: string;
  expiresAtUnixMs: number;
}

export interface PendingClaimView {
  /** Needed by the desktop approve/deny commands; never persisted or logged. */
  claimId: string;
  deviceName: string;
  sourceIp: string;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
}

export interface PairingStateView {
  window: PairingWindowView | null;
  claims: PendingClaimView[];
}

export interface DeviceView {
  id: string;
  deviceName: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  absoluteExpiresAtUnixMs: number;
}

export interface PairingEventView {
  kind: string;
  claimId: string | null;
  deviceName: string | null;
  sourceIp: string | null;
  createdAtUnixMs: number | null;
  pendingCount: number;
}

/** Event names emitted by the Rust runtime (UI wake-up only). */
export const WEB_ACCESS_STATE_EVENT = "web-access-state";
export const WEB_ACCESS_PAIRING_EVENT = "web-access-pairing-event";
