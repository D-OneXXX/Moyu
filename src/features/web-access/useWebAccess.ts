import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { localizeBackendError } from "@/features/errors/localize";
import { recordBreadcrumb } from "@/features/resilience";
import { webAccessApi } from "./api";
import {
  WEB_ACCESS_DEVICES_EVENT,
  WEB_ACCESS_PAIRING_EVENT,
  WEB_ACCESS_STATE_EVENT,
  type DeviceView,
  type LanAddressView,
  type PairingEventView,
  type PairingStateView,
  type WebAccessStatusView,
} from "./types";

export type WebAccessAction =
  | "start"
  | "start-cancel"
  | "stop"
  | "pairing-start"
  | "pairing-cancel"
  | "approve"
  | "deny"
  | "revoke";

const EMPTY_PAIRING: PairingStateView = { window: null, claims: [] };

/**
 * D1b Web Access state.
 *
 * Everything is user-driven: mounting only reads snapshots, the two Tauri
 * events wake the UI, and no timer ever calls the backend. The countdown in
 * the panel is a purely local 1 s tick. Nothing is written to
 * localStorage/sessionStorage; the pairing window (and its fragment-only
 * pairing id) lives in React state for as long as the panel is mounted.
 */
export function useWebAccess() {
  const [status, setStatus] = useState<WebAccessStatusView | null>(null);
  const [addresses, setAddresses] = useState<LanAddressView[]>([]);
  const [pairing, setPairing] = useState<PairingStateView | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<WebAccessAction | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const busyActionRef = useRef<WebAccessAction | null>(null);
  const cancelStartRequestedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const pairingSeqRef = useRef(0);
  const devicesSeqRef = useRef(0);

  const clearPairing = useCallback(() => {
    pairingSeqRef.current += 1;
    setPairing(EMPTY_PAIRING);
  }, []);

  const clearDevices = useCallback(() => {
    devicesSeqRef.current += 1;
    setDevices([]);
  }, []);

  const refreshDevices = useCallback(async () => {
    const seq = ++devicesSeqRef.current;
    try {
      const next = await webAccessApi.devicesList();
      if (!mountedRef.current || seq !== devicesSeqRef.current) return;
      setDevices(next);
    } catch (cause) {
      if (!mountedRef.current || seq !== devicesSeqRef.current) return;
      setError(localizeBackendError(cause));
    }
  }, []);

  const refreshPairing = useCallback(async () => {
    const seq = ++pairingSeqRef.current;
    try {
      const next = await webAccessApi.pairingState();
      if (!mountedRef.current || seq !== pairingSeqRef.current) return;
      setPairing(next);
    } catch (cause) {
      if (!mountedRef.current || seq !== pairingSeqRef.current) return;
      setError(localizeBackendError(cause));
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      // Status and LAN addresses are independent: a machine without a
      // private IPv4 must still show the CA/phase state and its own error
      // instead of looking like a total Web Access failure.
      const [statusResult, addressesResult] = await Promise.allSettled([
        webAccessApi.status(),
        webAccessApi.addresses(),
      ]);
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (statusResult.status === "rejected") {
        setError(localizeBackendError(statusResult.reason));
      }
      if (addressesResult.status === "fulfilled") {
        setAddresses(addressesResult.value);
      } else {
        setAddresses([]);
        if (statusResult.status === "fulfilled") {
          setError(localizeBackendError(addressesResult.reason));
        }
      }
      if (statusResult.status === "rejected") {
        return;
      }
      const nextStatus = statusResult.value;
      setStatus(nextStatus);
      if (nextStatus.phase === "enabled") {
        await Promise.all([refreshPairing(), refreshDevices()]);
      } else {
        clearPairing();
        clearDevices();
      }
    } catch (cause) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setError(localizeBackendError(cause));
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) setLoading(false);
    }
  }, [clearDevices, clearPairing, refreshDevices, refreshPairing]);

  /** Serializes explicit user actions; one approval at a time. */
  const runAction = useCallback(
    async (
      action: WebAccessAction,
      target: string | null,
      task: () => Promise<void>,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      busyActionRef.current = action;
      setBusy(action);
      setBusyTarget(target);
      setError(null);
      try {
        await task();
        if (
          mountedRef.current &&
          !(action === "start" && cancelStartRequestedRef.current)
        ) {
          recordBreadcrumb("privacy");
        }
      } catch (cause) {
        if (mountedRef.current) setError(localizeBackendError(cause));
      } finally {
        if (action === "start") cancelStartRequestedRef.current = false;
        busyRef.current = false;
        busyActionRef.current = null;
        if (mountedRef.current) {
          setBusy(null);
          setBusyTarget(null);
        }
      }
    },
    [],
  );

  const start = useCallback(
    (ip: string, secure = false) =>
      runAction("start", null, async () => {
        cancelStartRequestedRef.current = false;
        const next = secure ? await webAccessApi.start(ip) : await webAccessApi.startPlain(ip);
        if (cancelStartRequestedRef.current) {
          // The backend serializes start and stop under one operation lock. A
          // cancellation requested during bind therefore stops the listener
          // immediately after the in-flight start returns.
          const stopped = await webAccessApi.stop();
          if (!mountedRef.current) return;
          setStatus(stopped);
          clearPairing();
          clearDevices();
          return;
        }
        if (!mountedRef.current) return;
        setStatus(next);
        clearPairing();
        clearDevices();
        if (next.transport === "http") await refreshPairing();
      }),
    [clearDevices, clearPairing, refreshPairing, runAction],
  );

  const stop = useCallback(
    () =>
      runAction("stop", null, async () => {
        const next = await webAccessApi.stop();
        if (!mountedRef.current) return;
        setStatus(next);
        clearPairing();
        clearDevices();
      }),
    [clearDevices, clearPairing, runAction],
  );

  const cancelStart = useCallback(() => {
    if (busyActionRef.current === "start") {
      cancelStartRequestedRef.current = true;
      if (mountedRef.current) {
        recordBreadcrumb("privacy");
        setBusy("start-cancel");
      }
      return;
    }
    // A panel can mount while another view still has the runtime in Starting.
    // In that case the backend operation lock queues this stop behind start.
    void stop();
  }, [stop]);

  const startPairing = useCallback(
    () =>
      runAction("pairing-start", null, async () => {
        const window = await webAccessApi.pairingStart();
        if (!mountedRef.current) return;
        pairingSeqRef.current += 1;
        setPairing({ window, claims: [] });
      }),
    [runAction],
  );

  const cancelPairing = useCallback(
    () =>
      runAction("pairing-cancel", null, async () => {
        const next = await webAccessApi.cancelPairing();
        if (!mountedRef.current) return;
        setStatus(next);
        clearPairing();
      }),
    [clearPairing, runAction],
  );

  const approve = useCallback(
    (claimId: string) =>
      runAction("approve", claimId, async () => {
        const next = await webAccessApi.approve(claimId);
        if (mountedRef.current) setStatus(next);
        await Promise.all([refreshPairing(), refreshDevices()]);
      }),
    [refreshDevices, refreshPairing, runAction],
  );

  const deny = useCallback(
    (claimId: string) =>
      runAction("deny", claimId, async () => {
        const next = await webAccessApi.deny(claimId);
        if (mountedRef.current) setStatus(next);
        await refreshPairing();
      }),
    [refreshPairing, runAction],
  );

  const revoke = useCallback(
    (deviceId: string) =>
      runAction("revoke", deviceId, async () => {
        await webAccessApi.revokeDevice(deviceId);
        await refreshDevices();
      }),
    [refreshDevices, runAction],
  );

  const onStateEvent = useCallback(
    (next: WebAccessStatusView) => {
      setStatus(next);
      if (next.phase === "enabled") {
        if (next.pairingActive) void refreshPairing();
        else clearPairing();
        void refreshDevices();
      } else {
        clearPairing();
        clearDevices();
      }
    },
    [clearDevices, clearPairing, refreshDevices, refreshPairing],
  );

  const onPairingEvent = useCallback(
    (event: PairingEventView) => {
      void refreshPairing();
      if (event.kind === "claim-approved") void refreshDevices();
    },
    [refreshDevices, refreshPairing],
  );

  /**
   * A session was committed by `/consume` or revoked (desktop button or the
   * web client's own DELETE). The event carries no payload; re-read both the
   * list and the status (deviceCount) exactly once.
   */
  const onDevicesChanged = useCallback(() => {
    void refreshDevices();
    void webAccessApi
      .status()
      .then((next) => {
        if (mountedRef.current) setStatus(next);
      })
      .catch(() => {
        /* status will be refreshed on the next explicit action */
      });
  }, [refreshDevices]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    let disposed = false;
    let unlistenState: UnlistenFn | undefined;
    let unlistenPairing: UnlistenFn | undefined;
    let unlistenDevices: UnlistenFn | undefined;

    const registerState = async () => {
      try {
        const off = await listen<WebAccessStatusView>(
          WEB_ACCESS_STATE_EVENT,
          (event) => {
            if (!disposed) onStateEvent(event.payload);
          },
        );
        if (disposed) off();
        else unlistenState = off;
      } catch {
        /* Not inside Tauri (browser preview); snapshots still load on click. */
      }
    };

    const registerPairing = async () => {
      try {
        const off = await listen<PairingEventView>(
          WEB_ACCESS_PAIRING_EVENT,
          (event) => {
            if (!disposed) onPairingEvent(event.payload);
          },
        );
        if (disposed) off();
        else unlistenPairing = off;
      } catch {
        /* Not inside Tauri (browser preview); snapshots still load on click. */
      }
    };

    const registerDevices = async () => {
      try {
        const off = await listen(WEB_ACCESS_DEVICES_EVENT, () => {
          if (!disposed) onDevicesChanged();
        });
        if (disposed) off();
        else unlistenDevices = off;
      } catch {
        /* Not inside Tauri (browser preview); snapshots still load on click. */
      }
    };

    void registerState();
    void registerPairing();
    void registerDevices();

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlistenState?.();
      unlistenPairing?.();
      unlistenDevices?.();
    };
  }, [onDevicesChanged, onPairingEvent, onStateEvent, refresh]);

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    addresses,
    pairing,
    devices,
    loading,
    busy,
    busyTarget,
    error,
    refresh,
    refreshPairing,
    refreshDevices,
    start,
    cancelStart,
    stop,
    startPairing,
    cancelPairing,
    approve,
    deny,
    revoke,
    clearError,
  };
}

export type WebAccessController = ReturnType<typeof useWebAccess>;
