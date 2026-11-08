import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  resolveSkinAssetUrl,
} from "./registry";
import {
  customSkinDefinition,
  readPersistedCustomSkin,
} from "./customSkin";
import type { SkinDefinition } from "./types";

const SKIN_STORAGE_KEY = "mr-skin";

interface SkinContextValue {
  skin: SkinDefinition;
  skins: readonly SkinDefinition[];
  setSkin: (id: string) => boolean;
  /** Registers a runtime skin (user art packs) and returns its id. */
  addSkin: (skin: SkinDefinition) => void;
}

const DEFAULT_SKIN = BUILTIN_SKINS[0];

const SkinContext = createContext<SkinContextValue>({
  skin: DEFAULT_SKIN,
  skins: BUILTIN_SKINS,
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

/**
 * 皮肤 token → CSS 自定义属性。
 *
 * 素材引用会被折算成 `url("…")`；非法来源（远程地址等）直接丢弃，
 * 因此皮肤永远无法放宽生产 CSP。
 */
function skinTokens(skin: SkinDefinition): Record<string, string> {
  const tokens: Record<string, string> = { ...(skin.tokens ?? {}) };
  const backdrop = skin.backdrop ? resolveSkinAssetUrl(skin.backdrop.src) : null;
  if (backdrop) {
    tokens["--mr-skin-backdrop-image"] = `url("${backdrop}")`;
  }
  const frame = skin.frame ? resolveSkinAssetUrl(skin.frame.src) : null;
  if (frame) {
    tokens["--mr-skin-frame-overlay"] = `url("${frame}")`;
  }
  return tokens;
}

/**
 * Applies a skin's `--mr-*` tokens on <html>; the previous set is removed.
 *
 * `immersive` 覆盖内缩边距：沉浸式阅读器必须 0px 全屏，视野 100% 专注。
 */
function applySkin(skin: SkinDefinition, immersive: boolean): void {
  const root = document.documentElement;
  root.dataset.mrSkin = skin.id;
  const tokens = skinTokens(skin);
  for (const [name, value] of Object.entries(tokens)) {
    if (name.startsWith("--mr-")) root.style.setProperty(name, value);
  }
  if (immersive) {
    root.style.setProperty("--mr-skin-viewport-inset", "0px");
  }
}

function clearSkinTokens(skin: SkinDefinition): void {
  const root = document.documentElement;
  for (const name of Object.keys(skinTokens(skin))) {
    if (name.startsWith("--mr-")) root.style.removeProperty(name);
  }
}

/**
 * Skin host.
 *
 * Cost is one attribute plus a handful of CSS variables: the canvas backdrop
 * and the frame overlay are plain CSS layers, so a skin never mounts floating
 * artwork above the content.
 */
export function SkinProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const immersive = location.pathname.startsWith("/reader/");
  const [skin, setSkinState] = useState<SkinDefinition>(() => {
    // 自定义整页背景在运行时注册表里只活一次会话：重启前先把持久化的那张
    // 还原回注册表，否则 `mr-skin` 里的 custom id 会指向不存在的皮肤。
    const persisted = readPersistedCustomSkin();
    if (persisted) registerSkin(customSkinDefinition(persisted));
    const stored = readStoredSkin();
    const resolved = getSkin(stored);
    // 预留态皮肤不在启动时自动生效：当前版本恒为极简外观（零视觉变化）。
    if (!resolved || resolved.dormant) return DEFAULT_SKIN;
    return resolved;
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    applySkin(skin, immersive);
    return () => clearSkinTokens(skin);
  }, [skin, immersive]);

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
