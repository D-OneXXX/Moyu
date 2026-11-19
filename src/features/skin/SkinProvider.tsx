import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  BUILTIN_SKINS,
  getSkin,
  listSkins,
  registerSkin,
  skinFromBundle,
  skinTokens,
  unregisterSkin,
} from "./registry";
import { forgetSkinBundle, getSkinBundle } from "./api";
import type { SkinDefinition } from "./types";

const SKIN_STORAGE_KEY = "mr-skin";

interface SkinContextValue {
  skin: SkinDefinition;
  skins: readonly SkinDefinition[];
  setSkin: (id: string) => boolean;
  /** Registers a runtime skin (internal/testing use). */
  addSkin: (skin: SkinDefinition) => void;
  /** Loads an installed pack from disk (LRU) and activates it. */
  activateInstalledSkin: (id: string) => Promise<boolean>;
  /** Removes a deleted pack from the runtime registry and falls back safely. */
  removeInstalledSkin: (id: string) => void;
}

const DEFAULT_SKIN = BUILTIN_SKINS[0];

const SkinContext = createContext<SkinContextValue>({
  skin: DEFAULT_SKIN,
  skins: BUILTIN_SKINS,
  setSkin: () => false,
  addSkin: () => {},
  activateInstalledSkin: async () => false,
  removeInstalledSkin: () => {},
});

function readStoredSkinId(): string {
  try {
    return localStorage.getItem(SKIN_STORAGE_KEY) ?? DEFAULT_SKIN.id;
  } catch {
    return DEFAULT_SKIN.id;
  }
}

function persistSkinId(id: string): void {
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    /* Private mode: the in-memory choice still applies for this session. */
  }
}

/**
 * Applies a skin's `--mr-*` tokens on <html>; the previous set is removed.
 *
 * `immersive` 覆盖内缩边距：沉浸式阅读器必须 0px 全屏，视野 100% 专注。
 * 阅读路由本身不挂载视窗，这里再兜一层，避免直接挂载画框时留边。
 */
function applySkin(skin: SkinDefinition, immersive: boolean): void {
  const root = document.documentElement;
  root.dataset.mrSkin = skin.id;
  const tokens = skinTokens(skin);
  for (const [name, value] of Object.entries(tokens)) {
    if (name.startsWith("--mr-skin-")) root.style.setProperty(name, value);
  }
  if (immersive) {
    root.style.setProperty("--mr-skin-viewport-inset", "0px");
  }
}

function clearSkinTokens(skin: SkinDefinition): void {
  const root = document.documentElement;
  for (const name of Object.keys(skinTokens(skin))) {
    if (name.startsWith("--mr-skin-")) root.style.removeProperty(name);
  }
}

/**
 * Skin host.
 *
 * Cost is one attribute plus a handful of CSS variables: the canvas backdrop
 * and the frame overlay are plain CSS layers, so a skin never mounts floating
 * artwork above the content. Installed packs are loaded on demand from disk;
 * localStorage only ever holds the lightweight id.
 */
export function SkinProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const immersive = location.pathname.startsWith("/reader/");
  const [skin, setSkinState] = useState<SkinDefinition>(() => {
    const stored = readStoredSkinId();
    return getSkin(stored) ?? DEFAULT_SKIN;
  });
  const [version, setVersion] = useState(0);

  // Installed packs live on disk. Resolve the persisted id once after mount,
  // never blocking the first paint; the default/built-in skin covers startup.
  useLayoutEffect(() => {
    let cancelled = false;
    const stored = readStoredSkinId();
    if (!stored || getSkin(stored)) return;
    void (async () => {
      const bundle = await getSkinBundle(stored);
      if (cancelled || !bundle) return;
      const definition = skinFromBundle(bundle);
      registerSkin(definition);
      setSkinState(definition);
      setVersion((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    applySkin(skin, immersive);
    return () => clearSkinTokens(skin);
  }, [skin, immersive]);

  const setSkin = useCallback((id: string): boolean => {
    const next = getSkin(id);
    if (!next) return false;
    setSkinState((previous) => (previous.id === next.id ? previous : next));
    persistSkinId(next.id);
    return true;
  }, []);

  const addSkin = useCallback((definition: SkinDefinition) => {
    registerSkin(definition);
    setVersion((value) => value + 1);
  }, []);

  const activateInstalledSkin = useCallback(
    async (id: string): Promise<boolean> => {
      if (getSkin(id)) return setSkin(id);
      const bundle = await getSkinBundle(id);
      if (!bundle) return false;
      const definition = skinFromBundle(bundle);
      registerSkin(definition);
      setSkinState(definition);
      persistSkinId(definition.id);
      setVersion((value) => value + 1);
      return true;
    },
    [setSkin],
  );

  const removeInstalledSkin = useCallback(
    (id: string) => {
      forgetSkinBundle(id);
      const removed = unregisterSkin(id);
      if (skin.id === id) {
        // Deleting the active pack must always land on the zero-decoration
        // default, never leave missing `--mr-*` variables or a broken canvas.
        setSkinState(DEFAULT_SKIN);
        persistSkinId(DEFAULT_SKIN.id);
      }
      if (removed || skin.id === id) setVersion((value) => value + 1);
    },
    [skin.id],
  );

  const skins = useMemo(() => listSkins(), [version]);

  const value = useMemo<SkinContextValue>(
    () => ({
      skin,
      skins,
      setSkin,
      addSkin,
      activateInstalledSkin,
      removeInstalledSkin,
    }),
    [
      activateInstalledSkin,
      addSkin,
      removeInstalledSkin,
      setSkin,
      skin,
      skins,
    ],
  );

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  return useContext(SkinContext);
}

export { SKIN_STORAGE_KEY };
