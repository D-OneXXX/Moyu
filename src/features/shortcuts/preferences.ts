import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "mr-shortcuts-enabled";
const CHANGE_EVENT = "mr-shortcuts-preference";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let cached = read();

function subscribe(onChange: () => void): () => void {
  const handler = () => onChange();
  const storageHandler = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    cached = read();
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
}

function getSnapshot(): boolean {
  return cached;
}

export function setShortcutsEnabled(value: boolean): void {
  cached = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* Private mode: the in-memory flag still gates this session. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Global-shortcut switch. `useGlobalShortcuts` is the single choke point, so
 * turning this off immediately silences the shell and the reader alike.
 */
export function useShortcutsEnabled(): [boolean, (value: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const update = useCallback((value: boolean) => setShortcutsEnabled(value), []);
  return [enabled, update];
}

/** Synchronous read for the keydown hot path (no hook, no state). */
export function shortcutsEnabledNow(): boolean {
  return cached;
}
