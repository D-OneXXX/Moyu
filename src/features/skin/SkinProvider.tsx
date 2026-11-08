import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  BUILTIN_SKINS,
  getSkin,
  listSkins,
  registerSkin,
} from "./registry";
import type { SkinDecoration, SkinDefinition } from "./types";

const SKIN_STORAGE_KEY = "mr-skin";

interface SkinContextValue {
  skin: SkinDefinition;
  skins: readonly SkinDefinition[];
  decorations: readonly SkinDecoration[];
  setSkin: (id: string) => boolean;
  /** Registers a runtime skin (future art packs) and returns its id. */
  addSkin: (skin: SkinDefinition) => void;
}

const DEFAULT_SKIN = BUILTIN_SKINS[0];

const SkinContext = createContext<SkinContextValue>({
  skin: DEFAULT_SKIN,
  skins: BUILTIN_SKINS,
  decorations: [],
  setSkin: () => false,
  addSkin: () => {},
});

function readStoredSkin(): string {
  try {
    return localStorage.getItem(SKIN_STORAGE_KEY) ?? DEFAULT_SKIN.id;
  } catch {
    return DEFAULT_SKIN.id;
  }
}

/** Applies a skin's `--mr-*` tokens on <html>; the previous set is removed. */
function applySkin(skin: SkinDefinition): void {
  const root = document.documentElement;
  root.dataset.mrSkin = skin.id;
  for (const [name, value] of Object.entries(skin.tokens ?? {})) {
    if (name.startsWith("--mr-")) root.style.setProperty(name, value);
  }
}

function clearSkinTokens(skin: SkinDefinition): void {
  const root = document.documentElement;
  for (const name of Object.keys(skin.tokens ?? {})) {
    if (name.startsWith("--mr-")) root.style.removeProperty(name);
  }
}

/**
 * Skin host. Mounting cost is one attribute plus a handful of CSS variables;
 * decorations live in a separate, pointer-events-none layer that is only
 * rendered when the active skin actually declares artwork.
 */
export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState<SkinDefinition>(() => {
    const stored = readStoredSkin();
    return getSkin(stored) ?? DEFAULT_SKIN;
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    applySkin(skin);
    return () => clearSkinTokens(skin);
  }, [skin]);

  const setSkin = useCallback((id: string): boolean => {
    const next = getSkin(id);
    if (!next) return false;
    setSkinState((previous) => {
      if (previous.id === next.id) return previous;
      return next;
    });
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, next.id);
    } catch {
      /* Private mode: the in-memory choice still applies for this session. */
    }
    return true;
  }, []);

  const addSkin = useCallback((definition: SkinDefinition) => {
    registerSkin(definition);
    setVersion((value) => value + 1);
  }, []);

  const skins = useMemo(() => listSkins(), [version]);

  const value = useMemo<SkinContextValue>(
    () => ({
      skin,
      skins,
      decorations: skin.decorations ?? [],
      setSkin,
      addSkin,
    }),
    [addSkin, setSkin, skin, skins],
  );

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  return useContext(SkinContext);
}

export { SKIN_STORAGE_KEY };
