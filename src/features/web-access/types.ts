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
  /** Session id used by revoke; never a token or hash. */
  sessionId: string;
  deviceName: string;
  /** Parsed from the consume-time User-Agent (`iOS Safari`, `Android Chrome`…). */
  platform: string;
  /** Claim-time private IPv4; null only for sessions issued by tests. */
  sourceIp: string | null;
  createdAtUnixMs: number;
  lastActiveAtUnixMs: number;
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
/** Payload-free wake-up: a session was committed or revoked. */
export const WEB_ACCESS_DEVICES_EVENT = "web-access-devices-changed";
/** Tray start/stop failure; payload is a backend message with a stable code. */
export const WEB_ACCESS_TRAY_ERROR_EVENT = "web-access-tray-error";
