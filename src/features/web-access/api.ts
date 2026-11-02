import { invoke } from "@tauri-apps/api/core";
import type {
  DeviceView,
  LanAddressView,
  PairingStateView,
  PairingWindowView,
  WebAccessStatusView,
} from "./types";

/**
 * D1b control-plane commands.
 *
 * Errors reject with the backend's human-readable string plus its trailing
 * stable code (`（web-access-...）` / `（pairing-...）`); callers must pass them
 * through `localizeBackendError` instead of rewriting the message, otherwise
 * the code is lost.
 *
 * Every command is user-driven: nothing here starts the listener, creates a
 * pairing window, or approves a claim on mount.
 */
export const webAccessApi = {
  status: () => invoke<WebAccessStatusView>("web_access_status"),
  addresses: () => invoke<LanAddressView[]>("web_access_addresses"),
  start: (ip: string, port?: number | null) =>
    invoke<WebAccessStatusView>("web_access_start", {
      ip,
      port: port ?? null,
    }),
  stop: () => invoke<WebAccessStatusView>("web_access_stop"),
  pairingStart: () => invoke<PairingWindowView>("web_access_pairing_start"),
  pairingState: () => invoke<PairingStateView>("web_access_pairing_state"),
  approve: (claimId: string) =>
    invoke<WebAccessStatusView>("web_access_pairing_approve", { claimId }),
  deny: (claimId: string) =>
    invoke<WebAccessStatusView>("web_access_pairing_deny", { claimId }),
  cancelPairing: () =>
    invoke<WebAccessStatusView>("web_access_pairing_cancel"),
  devicesList: () => invoke<DeviceView[]>("web_access_devices_list"),
  revokeDevice: (deviceId: string) =>
    invoke<boolean>("web_access_device_revoke", { deviceId }),
};
