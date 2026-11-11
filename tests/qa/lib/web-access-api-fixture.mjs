/**
 * QA-only stand-in for `src/features/web-access/api.ts`.
 *
 * The Vite QA plugin aliases `./api` in `useWebAccess.ts` to this module when
 * `MR_QA_WEB_ACCESS_FIXTURE=1`. It intentionally does NOT touch
 * `__TAURI_INTERNALS__.invoke`: the static anti-mock guard forbids QA suites
 * from replacing the real IPC bridge, and that property is non-configurable in
 * Tauri anyway.
 *
 * The suite installs `window.__QA_WEB_ACCESS__`; without that global every
 * method delegates to the real backend, so unrelated suites sharing the same
 * Vite server keep their real behaviour.
 */
import { invoke } from "@tauri-apps/api/core";

function fixture() {
  return window.__QA_WEB_ACCESS__ ?? null;
}

function activate(state) {
  window.__QA_WEB_ACCESS_FIXTURE_ACTIVE__ = true;
  return state;
}

function record(state, name) {
  state.calls.push(name);
}

function pendingClaims(state) {
  return (state.pairing.claims ?? []).filter(
    (claim) => claim.expiresAtUnixMs > Date.now(),
  );
}

function pairingSnapshot(state) {
  return {
    window: state.pairing.window ?? null,
    claims: pendingClaims(state),
  };
}

function statusSnapshot(state) {
  const claims = pendingClaims(state);
  state.status.pairingActive =
    state.pairing.window !== null || claims.length > 0;
  return { ...state.status, pendingClaimCount: claims.length };
}

function withFixture(name, run, real) {
  const state = fixture();
  if (!state) return real();
  activate(state);
  record(state, name);
  return run(state);
}

export const webAccessApi = {
  status: () =>
    withFixture(
      "web_access_status",
      statusSnapshot,
      () => invoke("web_access_status"),
    ),
  addresses: () =>
    withFixture(
      "web_access_addresses",
      (state) => state.addresses,
      () => invoke("web_access_addresses"),
    ),
  start: (ip, port) =>
    withFixture(
      "web_access_start",
      (state) => {
        state.status = {
          ...state.status,
          phase: "enabled",
          transport: "https",
          bindAddress: ip,
          bindIp: ip,
          port: port ?? 7443,
        };
        return statusSnapshot(state);
      },
      () => invoke("web_access_start", { ip, port: port ?? null }),
    ),
  startPlain: (ip, port) =>
    withFixture(
      "web_access_start_plain",
      (state) => {
        state.status = {
          ...state.status,
          phase: "enabled",
          transport: "http",
          bindAddress: ip,
          bindIp: ip,
          port: port ?? 7443,
        };
        return statusSnapshot(state);
      },
      () => invoke("web_access_start_plain", { ip, port: port ?? null }),
    ),
  stop: () =>
    withFixture(
      "stop",
      (state) => {
        state.status = {
          ...state.status,
          phase: "disabled",
          transport: null,
          bindAddress: null,
          bindIp: null,
          port: null,
          pairingActive: false,
        };
        state.pairing = { window: null, claims: [] };
        return state.status;
      },
      () => invoke("web_access_stop"),
    ),
  pairingStart: () =>
    withFixture(
      "pairing-start",
      (state) => {
        state.pairing = {
          window: {
            url: "https://192.168.1.10:7443/?pair=1#pair_" + "d".repeat(32),
            expiresAtUnixMs: Date.now() + 300000,
          },
          claims: [],
        };
        state.status.pairingActive = true;
        return state.pairing.window;
      },
      () => invoke("web_access_pairing_start"),
    ),
  pairingState: () =>
    withFixture(
      "web_access_pairing_state",
      (state) => {
        const snapshot = pairingSnapshot(state);
        state.status.pairingActive =
          snapshot.window !== null || snapshot.claims.length > 0;
        return snapshot;
      },
      () => invoke("web_access_pairing_state"),
    ),
  approve: (claimId) =>
    withFixture(
      "approve:" + claimId,
      (state) => {
        state.approved = claimId;
        state.pairing.claims = [];
        state.status.deviceCount = 1;
        return statusSnapshot(state);
      },
      () => invoke("web_access_pairing_approve", { claimId }),
    ),
  deny: (claimId) =>
    withFixture(
      "deny:" + claimId,
      (state) => {
        state.denied = claimId;
        state.pairing.claims = [];
        return statusSnapshot(state);
      },
      () => invoke("web_access_pairing_deny", { claimId }),
    ),
  cancelPairing: () =>
    withFixture(
      "pairing-cancel",
      (state) => {
        state.pairing = { window: null, claims: [] };
        return statusSnapshot(state);
      },
      () => invoke("web_access_pairing_cancel"),
    ),
  devicesList: () =>
    withFixture(
      "web_access_devices_list",
      (state) => state.devices,
      () => invoke("web_access_devices_list"),
    ),
  revokeDevice: (deviceId) =>
    withFixture(
      "web_access_device_revoke",
      (state) => {
        state.devices = [];
        state.status.deviceCount = 0;
        return true;
      },
      () => invoke("web_access_device_revoke", { deviceId }),
    ),
};
