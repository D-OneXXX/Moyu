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
  BRAND_ICON_EVENT,
  BRAND_ICON_STORAGE_KEY,
  clearBrandIconSelection,
  isBrandIconSelection,
  readBrandIconSelection,
  writeBrandIconSelection,
  type BrandIconSelection,
} from "./brandIcon";

interface BrandIconContextValue {
  selection: BrandIconSelection;
  setSelection: (selection: BrandIconSelection) => boolean;
  reset: () => boolean;
}

const BrandIconContext = createContext<BrandIconContextValue | null>(null);

/**
 * 品牌图标偏好以 localStorage 为唯一事实源：
 * - 同窗口通过自定义事件即时同步（设置页 → 顶栏）；
 * - 跨窗口通过 storage 事件同步，任何一侧都只读回事实源，不反向回写。
 */
export function BrandIconProvider({ children }: { children: ReactNode }) {
  const [selection, setSelectionState] = useState<BrandIconSelection>(
    readBrandIconSelection,
  );

  useEffect(() => {
    const sync = () => setSelectionState(readBrandIconSelection());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BRAND_ICON_STORAGE_KEY) sync();
    };
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      setSelectionState(
        isBrandIconSelection(detail) ? detail : readBrandIconSelection(),
      );
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(BRAND_ICON_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BRAND_ICON_EVENT, onLocal);
    };
  }, []);

  const setSelection = useCallback(
    (next: BrandIconSelection) => writeBrandIconSelection(next),
    [],
  );
  const reset = useCallback(() => clearBrandIconSelection(), []);

  const value = useMemo(
    () => ({ selection, setSelection, reset }),
    [selection, setSelection, reset],
  );

  return (
    <BrandIconContext.Provider value={value}>
      {children}
    </BrandIconContext.Provider>
  );
}

export function useBrandIcon(): BrandIconContextValue {
  const value = useContext(BrandIconContext);
  if (!value) {
    throw new Error("useBrandIcon must be used within BrandIconProvider");
  }
  return value;
}
