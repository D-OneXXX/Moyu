import { invoke } from "@tauri-apps/api/core";

/** G1 CA state exposed by `web_access_ca_status`. */
export interface CaStatusView {
  initialized: boolean;
  rootGeneration: number | null;
  /** Uppercase, colon-separated SHA-256 (95 characters). */
  rootFingerprintSha256: string | null;
  rootNotAfter: number | null;
  rootDaysRemaining: number | null;
  intermediateGeneration: number | null;
  intermediateFingerprintSha256: string | null;
  intermediateNotAfter: number | null;
  intermediateDaysRemaining: number | null;
  needsRootRotation: boolean | null;
  needsIntermediateRotation: boolean | null;
}

export interface CaExportView {
  fingerprintSha256: string;
}

export type CaDistributionStopReason = "expired" | "stopped";

export interface CaDistributionStatusView {
  running: boolean;
  url: string | null;
  expiresAtUnixMs: number | null;
  stopReason: CaDistributionStopReason | null;
  /** Fingerprint of the certificate this run actually serves. */
  rootFingerprintSha256: string | null;
}

/**
 * G1 CA distribution commands. These never start a listener at app startup;
 * `start` is only called from an explicit user action.
 */
export const caDistributionApi = {
  status: () => invoke<CaStatusView>("web_access_ca_status"),
  initialize: () => invoke<CaStatusView>("web_access_ca_initialize"),
  exportRoot: (path: string) =>
    invoke<CaExportView>("web_access_ca_export_root", { path }),
  addresses: () =>
    invoke<string[]>("web_access_ca_distribution_addresses"),
  start: (ip?: string | null) =>
    invoke<CaDistributionStatusView>("web_access_ca_distribution_start", {
      ip: ip ?? null,
    }),
  stop: () =>
    invoke<CaDistributionStatusView>("web_access_ca_distribution_stop"),
  distributionStatus: () =>
    invoke<CaDistributionStatusView>("web_access_ca_distribution_status"),
};
