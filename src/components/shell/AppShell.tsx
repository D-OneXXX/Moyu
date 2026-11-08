import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  onExperimentalChange,
  type BookInfo,
} from "@/lib/tauri";
import {
  readFeatureFlags,
  type FeatureFlags,
} from "@/features/features";
import { toast, Toaster } from "@/components/Toast";
import { translate, useI18n } from "@/i18n";
import { Loader2 } from "lucide-react";
import Library from "@/pages/Library";

/** 非首屏路由按需加载；书库首页保持静态以保证首屏最快。 */
const SettingsPage = lazy(() => import("@/pages/Settings"));
const Browser = lazy(() => import("@/pages/Browser"));

/** 懒加载路由的占位，文案走 t() 且保持胶囊视觉。 */
function ShellRouteFallback() {
  const { t } = useI18n();
  return (
    <div
      className="grid min-h-[60vh] w-full place-items-center bg-background text-sm text-muted-foreground"
      aria-busy="true"
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-hard-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("common.loading")}
      </span>
    </div>
  );
}
import { useWorkspace } from "@/features/workspace/WorkspaceContext";
import {
  FOCUS_LIBRARY_SEARCH_EVENT,
  LIBRARY_REFRESH_EVENT,
} from "@/lib/events";
import TopBar from "./TopBar";
import ThemeDecorationLayer from "./ThemeDecorationLayer";
import PrivacyDialog from "@/components/privacy/PrivacyDialog";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { useGlobalShortcuts } from "@/features/shortcuts/useGlobalShortcuts";
import { useScrollRestoration } from "@/features/scroll/useScrollRestoration";

export default function AppShell() {
  const nav = useNavigate();
  const loc = useLocation();
  const ws = useWorkspace();
  const { active: safeMode } = useSafeMode();
  const [lastRead, setLastRead] = useState<BookInfo | null>(null);
  const [features, setFeatures] = useState<FeatureFlags>(readFeatureFlags);
  const onlineOn = features.online;
  const [onlineProxy, setOnlineProxy] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [libraryBadge, setLibraryBadge] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const pathRef = useRef(loc.pathname);
  pathRef.current = loc.pathname;

  // 原生窗口标题统一为品牌名；文档标题仍由 i18n 的 app.title 维护。
  useEffect(() => {
    void getCurrentWindow().setTitle("Moyu").catch(() => {});
  }, []);

  // Page transitions must start at the top: the shell owns the scroll container,
  // so without this a previous page's scroll position can clip the next header.
  // Back/forward restores instead (see useScrollRestoration).
  useScrollRestoration(mainRef);

  // 最小化 / 隐藏到托盘：释放后端页与条漫切片的内存 LRU，把常驻内存压到
  // 最低水位。只清派生缓存，不动书库与阅读进度；回到前台按需重渲染。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      void api.clearPages().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getSettings().then(
        (settings) => {
          if (!alive) return;
          setOnlineProxy(settings.onlineProxy);
          setFeatures(settings.features);
          setSettingsReady(true);
          setSettingsError(false);
        },
        () => {
          if (!alive) return;
          setSettingsError(true);
          setSettingsReady(true);
        },
      );
    };
    void load();
    const off = onExperimentalChange(() => {
      setFeatures(readFeatureFlags());
      void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // ADR-034：只取「最近打开、未读完」的一本，避免每次导航加载全量书库。
    api
      .getLastRead(safeMode)
      .then(
        (book) => {
          if (!alive) return;
          setLastRead(book);
        },
        () => {
          /* 书库命令失败时“继续阅读”保持禁用 */
        },
      );
    return () => {
      alive = false;
    };
  }, [loc.pathname, safeMode]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<BookInfo[]>("online-handoff-imported", (event) => {
      if (disposed || safeMode) return;
      const books = Array.isArray(event.payload) ? event.payload : [];
      if (books.length === 0) return;
      const title = books[0]?.title?.trim() || translate("common.unknown");
      toast(
        books.length > 1
          ? translate("toast.receivedMany", {
              title,
              count: books.length,
            })
          : translate("toast.receivedOne", { title }),
      );
      if (pathRef.current !== "/") {
        setLibraryBadge((count) => count + books.length);
      } else {
        window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
      }
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [safeMode]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<string>("cache-write-failed", () => {
      if (!disposed) toast(translate("cache.writeFailed"));
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (loc.pathname === "/") setLibraryBadge(0);
  }, [loc.pathname]);

  // 阅读态不挂载 Shell；这里负责从书库侧切回后台阅读页签。
  const onShellKey = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Ctrl/Cmd+W 是窗口关闭保护：即使焦点在输入框里也必须拦截，
      // 否则 WebView2 会直接关窗（因此它是唯一豁免输入态的键）。
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        ws.closeActiveTab();
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (loc.pathname !== "/") nav("/");
        // The Library may still be mounting; fire once its input exists so
        // the shortcut is not dropped on a slow route transition.
        const deadline = Date.now() + 1500;
        const focusWhenReady = () => {
          if (document.getElementById("library-search-input")) {
            window.dispatchEvent(new Event(FOCUS_LIBRARY_SEARCH_EVENT));
            return;
          }
          if (Date.now() < deadline) window.setTimeout(focusWhenReady, 60);
        };
        focusWhenReady();
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      event.preventDefault();
      ws.activateIndex(Number(event.key));
    },
    [loc.pathname, nav, ws],
  );

  // 全局快捷键统一守卫：输入法组合中 / 输入框焦点一律放行，
  // 数字键切页签与 Ctrl/Cmd+K 只在非输入态生效；
  // w/W 例外（Ctrl+W 窗口关闭保护必须始终拦截）。
  const shellShortcuts = useMemo(() => {
    const map: Record<string, (event: KeyboardEvent) => void> = {};
    map.k = onShellKey;
    map.K = onShellKey;
    map.w = onShellKey;
    map.W = onShellKey;
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      map[key] = onShellKey;
    }
    return map;
  }, [onShellKey]);

  useGlobalShortcuts(shellShortcuts, { editableExempt: ["w", "W"] });

  return (
    <div className="relative flex h-screen w-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {/* 皮肤壁纸层：默认 `none`（零绘制），注入一条 CSS 变量即可换底纹。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage: "var(--mr-surface-backdrop)",
          backgroundSize: "var(--mr-surface-backdrop-size)",
          opacity: "var(--mr-surface-backdrop-opacity)",
        }}
      />
      <TopBar
        lastRead={lastRead}
        onlineProxy={onlineProxy}
        onlineOn={onlineOn}
        browserEnabled={features.browser}
        settingsReady={settingsReady}
        settingsError={settingsError}
        libraryBadge={libraryBadge}
        onClearLibraryBadge={() => setLibraryBadge(0)}
      />
      <main
        ref={mainRef}
        data-shell-scroll
        className="relative w-full min-w-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div key={loc.pathname} className="view-fade min-h-full">
          <Suspense fallback={<ShellRouteFallback />}>
            <Routes location={loc}>
              <Route path="/" element={<Library />} />
              <Route
                path="/browser"
                element={
                  features.browser ? <Browser /> : <Navigate to="/" replace />
                }
              />
              <Route path="/settings" element={<SettingsPage />} />
              {/* 通配兜底：已下线/未知路由静默 replace 回书库首页，
                  避免历史栈残留废弃 URL 导致返回即白屏（AGENTS.md §2.1）。 */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </div>
      </main>
      {/* 装饰层永远是内容层的兄弟节点：不参与布局、不拦截命中测试。 */}
      <ThemeDecorationLayer />
      <Toaster />
      <PrivacyDialog />
    </div>
  );
}
