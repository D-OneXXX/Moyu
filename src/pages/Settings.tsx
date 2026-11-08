import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  Command,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  Info,
  KeyRound,
  Keyboard,
  Loader2,
  Monitor,
  Moon,
  Palette,
  PanelTop,
  RefreshCw,
  RotateCcw,
  Save,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  type Dashboard,
  type MemoryStats,
  type Settings,
} from "@/lib/tauri";
import {
  LOCALE_OPTIONS,
  translate,
  useI18n,
  type MessageKey,
} from "@/i18n";
import { isLocale } from "@/i18n/config";
import {
  useTheme,
  type ThemeMode,
} from "@/features/theme/ThemeProvider";
import { updateApi } from "@/features/update/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  SettingRow,
  SettingsSection,
  SettingsStat,
  SettingsStatRow,
} from "@/components/settings/SettingsSection";
import UpdatesPanel from "@/components/settings/UpdatesPanel";
import PrivacyPanel from "@/components/settings/PrivacyPanel";
import OnlineFilterPanel from "@/components/settings/OnlineFilterPanel";
import OpdsPanel from "@/components/settings/OpdsPanel";
import CaDistributionPanel from "@/components/settings/CaDistributionPanel";
import WebAccessSummaryCard from "@/components/settings/WebAccessSummaryCard";
import WebAccessPanel from "@/components/settings/WebAccessPanel";
import DataBackupPanel from "@/components/settings/DataBackupPanel";
import DiagnosticPanel from "@/components/diagnostics/DiagnosticPanel";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { recordBreadcrumb } from "@/features/resilience";
import ErrorState from "@/components/ErrorState";
import { APP_VERSION, BUILD_COMMIT } from "@/lib/version";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";
import { localizeBackendError } from "@/features/errors/localize";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_REGISTRY,
  ONLINE_FEATURE,
  type FeatureDefinition,
  type FeatureId,
} from "@/features/features";
import { useShortcutsEnabled } from "@/features/shortcuts/preferences";

const DEFAULT_FORM: Settings = {
  theme: "system",
  cacheBudgetMb: 128,
  diskCacheBudgetMb: 2048,
  libraryDir: "",
  features: DEFAULT_FEATURE_FLAGS,
  onlineProxy: "",
  onlineConcurrency: 3,
  onlineHeaders: "",
  closeToTray: false,
};

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeMode;
  labelKey: MessageKey;
  hintKey: MessageKey;
  icon: LucideIcon;
}> = [
  {
    value: "system",
    labelKey: "theme.system",
    hintKey: "settings.theme.systemHint",
    icon: Monitor,
  },
  {
    value: "light",
    labelKey: "theme.light",
    hintKey: "settings.theme.lightHint",
    icon: Sun,
  },
  {
    value: "dark",
    labelKey: "theme.dark",
    hintKey: "settings.theme.darkHint",
    icon: Moon,
  },
];

function normalizeTheme(value: string): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/** 收敛后的五个高内聚分区。 */
type SettingsTab = "general" | "network" | "storage" | "privacy" | "about";

/**
 * 深链 id 归一化：新 id 直通；历史 id（updates / support / reading /
 * cache / online）静默映射到收敛后的分区，保证旧书签与 PrivacyDialog
 * 的 /settings?tab=privacy 都不会落到空页。
 */
function normalizeSettingsTab(raw: string | null): SettingsTab | null {
  switch (raw) {
    case "general":
    case "network":
    case "storage":
    case "privacy":
    case "about":
      return raw;
    case "online":
      return "network";
    case "reading":
    case "cache":
      return "storage";
    case "updates":
    case "support":
      return "about";
    default:
      return null;
  }
}

/** 全局快捷键说明：键位保持原样，说明复用阅读器既有 i18n key。 */
const GLOBAL_SHORTCUTS: ReadonlyArray<{
  keys: string;
  actionKey: MessageKey;
}> = [
  { keys: "Space / ← / →", actionKey: "reader.shortcut.pageTurn" },
  { keys: "Shift + Space", actionKey: "reader.nav.prev" },
  { keys: "F", actionKey: "reader.shortcut.mode" },
  { keys: "Ctrl + 1…9", actionKey: "reader.shortcut.tabs" },
  { keys: "Ctrl / Cmd + W", actionKey: "reader.shortcut.closeTab" },
  { keys: "Esc", actionKey: "reader.shortcut.escape" },
];

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 热力图为日期升序的稀疏记录；按最近 7 个自然日（含今天）求和。 */
function sumLast7Days(heatmap: Dashboard["heatmap"]): number {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  const cutoffKey = localDateKey(cutoff);
  return heatmap.reduce(
    (total, entry) => (entry.date >= cutoffKey ? total + entry.count : total),
    0,
  );
}

function formatMb(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(safe / 1048576)} MB`;
}

/** 缓存占用百分比：非法值/零上限安全，结果限制在 0-100。 */
function cachePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

function MemoryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background/60 px-3 py-2">
      <p className="truncate text-[11px] font-medium text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

/**
 * 设置页：常规与外观 / 网络与在线源 / 存储与数据 / 隐私与安全 / 关于与维护。
 *
 * 信息架构（Task 2/8）：一级面板只保留状态摘要、高频即时开关与轻量入口行；
 * 复杂低频模块全部下沉到 `SettingsSection.disclosure` 的二级 Sheet，关闭时
 * 不挂载、不请求。保存时以「已加载设置 + 当前表单」整对象写回，保留当前
 * 页面未展示、但后端仍需要的字段。
 */
export default function SettingsPage() {
  const { mode, setMode } = useTheme();
  const { locale, setLocale, t, formatNumber } = useI18n();
  const { active: safeMode } = useSafeMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(
    () => normalizeSettingsTab(searchParams.get("tab")) ?? "general",
  );
  const [form, setForm] = useState<Settings>(DEFAULT_FORM);
  const [mem, setMem] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [featureBusy, setFeatureBusy] = useState<FeatureId | null>(null);
  const [scanning, setScanning] = useState(false);
  const [detectingProxy, setDetectingProxy] = useState(false);
  const [sessionHeaders, setSessionHeaders] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [clearingTemp, setClearingTemp] = useState(false);
  /** 代理来源：system = 跟随系统探测填入；manual = 手动输入。 */
  const [proxySource, setProxySource] = useState<"system" | "manual">(
    "manual",
  );
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState<string | null>(null);
  const [shortcutsEnabled, setShortcutsEnabled] = useShortcutsEnabled();

  // 最近一次成功读/写数据库的完整设置；保存时作为底稿保留隐藏字段。
  const loadedRef = useRef<Settings | null>(null);
  const loadSeqRef = useRef(0);
  const dashSeqRef = useRef(0);

  const concurrencyItems = Array.from({ length: 8 }, (_, index) => {
    const value = String(index + 1);
    return {
      value,
      label: t("settings.online.concurrencyItem", {
        count: formatNumber(index + 1),
      }),
    };
  });

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, session] = await Promise.all([
        api.getSettings(),
        api.getSessionOnlineHeaders().catch(() => null),
      ]);
      if (seq !== loadSeqRef.current) return;
      // Cache metrics are supplementary: never let a slow sysinfo query keep
      // the whole settings page in its loading state.
      void api.getMemoryStats().then(
        (memory) => {
          if (seq === loadSeqRef.current) setMem(memory);
        },
        () => {
          if (seq === loadSeqRef.current) setMem(null);
        },
      );
      // localStorage 中的模式优先：首次启动没有偏好时跟随系统，
      // 不让历史数据库里的 dark 默认值覆盖「跟随系统」。
      let storedMode: string | null = null;
      try {
        storedMode = localStorage.getItem("mr-theme");
      } catch {
        /* 忽略 */
      }
      const theme = normalizeTheme(storedMode ?? "system");
      const sessionValue =
        typeof session === "string" && session.trim().length > 0 ? session : "";
      loadedRef.current = { ...settings, theme };
      setForm({
        ...DEFAULT_FORM,
        ...settings,
        features: { ...DEFAULT_FEATURE_FLAGS, ...(settings.features ?? {}) },
        theme,
        ...(sessionValue ? { onlineHeaders: sessionValue } : {}),
      });
      setSessionActive(sessionValue.length > 0);
      setSessionHeaders(sessionValue.length > 0);
      setDirty(false);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(
        typeof e === "string"
          ? localizeBackendError(e)
          : translate("settings.errors.loadSettings"),
      );
      toastErr("get_settings", e);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadSeqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const requested = normalizeSettingsTab(searchParams.get("tab"));
    if (requested) setTab(requested);
  }, [searchParams]);

  // Each settings tab is a separate page-length surface; always start at the
  // top instead of inheriting the previous tab's scroll offset.
  useEffect(() => {
    document
      .querySelector("[data-shell-scroll]")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [tab]);

  // 顶栏也可切换主题；保证表单里的 theme 始终与 ThemeProvider 当前模式一致。
  useEffect(() => {
    setForm((prev) =>
      prev.theme === mode ? prev : { ...prev, theme: mode },
    );
    if (loadedRef.current && loadedRef.current.theme !== mode) {
      loadedRef.current = { ...loadedRef.current, theme: mode };
    }
  }, [mode]);

  const loadDashboard = useCallback(async () => {
    const seq = ++dashSeqRef.current;
    setDashLoading(true);
    setDashError(null);
    try {
      const next = await api.getDashboard();
      if (seq !== dashSeqRef.current) return;
      setDash(next);
    } catch (e) {
      if (seq !== dashSeqRef.current) return;
      setDashError(
        typeof e === "string"
          ? localizeBackendError(e)
          : translate("settings.errors.loadStats"),
      );
    } finally {
      if (seq === dashSeqRef.current) setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
    return () => {
      dashSeqRef.current += 1;
    };
  }, [loadDashboard]);

  const refreshSessionState = useCallback(() => {
    api
      .getSessionOnlineHeaders()
      .then((session) => {
        // Runtime state only: never overwrite the user's storage-mode choice
        // just because a window regained focus.
        const active =
          typeof session === "string" && session.trim().length > 0;
        setSessionActive(active);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onFocus = () => refreshSessionState();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshSessionState();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSessionState]);

  const refreshMemory = useCallback(async () => {
    try {
      setMem(await api.getMemoryStats());
    } catch (e) {
      toastErr("get_memory_stats", e);
    }
  }, []);

  const onThemeChange = (next: ThemeMode) => {
    // setMode 立即改 <html data-theme> 并写入 localStorage 与数据库。
    setMode(next);
    recordBreadcrumb("themeChange");
    setForm((prev) => ({ ...prev, theme: next }));
    if (loadedRef.current) {
      loadedRef.current = { ...loadedRef.current, theme: next };
    }
  };

  // 功能开关立即持久化；只写单个功能键，不会把表单里尚未保存的
  // 代理、请求头、目录等一起写库。
  const toggleFeature = async (
    feature: FeatureDefinition,
    value: boolean,
  ) => {
    if (featureBusy !== null || saving || loading) return;
    const previous = form.features;
    setFeatureBusy(feature.id);
    setForm((prev) => ({
      ...prev,
      features: { ...prev.features, [feature.settingKey]: value },
    }));
    try {
      const next = await api.setFeatureEnabled(feature.id, value);
      if (loadedRef.current) {
        loadedRef.current = { ...loadedRef.current, features: next.features };
      }
      setForm((prev) => ({ ...prev, features: next.features }));
      recordBreadcrumb("settingsChange");
      toast(
        t(
          value ? "settings.toast.featureOn" : "settings.toast.featureOff",
          { feature: t(feature.titleKey) },
        ),
      );
    } catch (e) {
      setForm((prev) => ({ ...prev, features: previous }));
      toastErr("set_feature_enabled", e);
    } finally {
      setFeatureBusy(null);
    }
  };

  const onPickDir = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("settings.library.pickTitle"),
        defaultPath: form.libraryDir.trim() || undefined,
      });
      if (typeof picked === "string") set("libraryDir", picked);
    } catch (e) {
      toastErr("open_dialog", e);
    }
  };

  const onScanLibrary = async () => {
    const dir = form.libraryDir.trim();
    if (!dir || scanning) return;
    setScanning(true);
    try {
      const result = await api.scanLibrary(dir);
      toast(
        t("settings.toast.scanDone", {
          count: formatNumber(result.books.length),
        }),
      );
      if (result.errors?.length) {
        toast(
          t("settings.toast.scanErrors", {
            count: formatNumber(result.errors.length),
          }),
        );
      }
    } catch (e) {
      toastErr("scan_library", e);
    } finally {
      setScanning(false);
    }
  };

  const onDetectProxy = async () => {
    if (detectingProxy) return;
    setDetectingProxy(true);
    try {
      const proxy = (await api.detectSystemProxy())?.trim() ?? "";
      if (proxy) {
        set("onlineProxy", proxy);
        setProxySource("system");
        toast(t("settings.toast.proxyFilled"));
      } else {
        toast(t("settings.toast.proxyNotFound"));
      }
    } catch (e) {
      toastErr("detect_system_proxy", e);
    } finally {
      setDetectingProxy(false);
    }
  };

  const onClearSessionHeaders = async () => {
    try {
      await api.clearSessionOnlineHeaders();
      setForm((prev) => ({ ...prev, onlineHeaders: "" }));
      setSessionActive(false);
      setDirty(true);
      toast(t("settings.toast.sessionCleared"));
    } catch (e) {
      toastErr("clear_session_online_headers", e);
    }
  };

  const onClearTemp = async () => {
    if (clearingTemp) return;
    setClearingTemp(true);
    try {
      const result = await api.clearTempCache();
      toast(
        t("settings.toast.tempCleared", {
          size: formatMb(result.bytesFreed, locale),
        }),
      );
      await refreshMemory();
    } catch (e) {
      toastErr("clear_temp_cache", e);
    } finally {
      setClearingTemp(false);
    }
  };

  const onSave = async () => {
    // 设置尚未载入（或载入失败）时表单仍是默认值，禁止写库。
    if (loading || loadError || saving || featureBusy !== null) return;
    const base: Settings = {
      ...(loadedRef.current ?? DEFAULT_FORM),
      ...form,
    };
    setSaving(true);
    try {
      if (sessionHeaders) {
        // 会话模式：请求头只写入进程内存，数据库里保留空串。
        await api.setSessionOnlineHeaders(form.onlineHeaders);
        setSessionActive(form.onlineHeaders.trim().length > 0);
        const persisted: Settings = { ...base, onlineHeaders: "" };
        const saved = await api.setSettings(persisted);
        loadedRef.current = saved;
        setForm((prev) => ({ ...prev, features: saved.features }));
      } else {
        await api.clearSessionOnlineHeaders();
        setSessionActive(false);
        const saved = await api.setSettings(base);
        loadedRef.current = saved;
        setForm((prev) => ({ ...prev, features: saved.features }));
      }
      setDirty(false);
      recordBreadcrumb("settingsChange");
      window.dispatchEvent(new Event("mr-settings-updated"));
      toast(t("settings.toast.saved"));
      void api
        .getMemoryStats()
        .then(setMem)
        .catch(() => {});
    } catch (e) {
      toastErr("set_settings", e);
    } finally {
      setSaving(false);
    }
  };

  /** 切换一级分区时同步 ?tab=，保证深链与后退行为一致。 */
  const onTabChange = (value: string) => {
    const next = normalizeSettingsTab(value);
    if (!next) return;
    setTab(next);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  };

  const ready = !loading && !loadError;
  /** 直连 = 未填代理；填了则按来源显示跟随系统 / 手动。 */
  const proxyMode: "system" | "manual" | "direct" = form.onlineProxy.trim()
    ? proxySource
    : "direct";
  const diskCachePct = mem
    ? cachePercent(mem.diskCacheBytes, mem.diskCacheLimitBytes)
    : 0;
  const diskBudgetMb = Number.isFinite(form.diskCacheBudgetMb)
    ? Math.min(10240, Math.max(500, form.diskCacheBudgetMb))
    : 2048;
  const last7Pages = dash ? sumLast7Days(dash.heatmap) : 0;
  const statusText = loading
    ? t("settings.status.loading")
    : loadError
      ? t("settings.status.loadFailed")
      : saving
        ? t("settings.status.saving")
        : dirty
          ? t("settings.status.dirty")
          : t("settings.status.saved");
  const statusDot = loading || loadError
    ? "bg-muted-foreground"
    : saving
      ? "animate-pulse bg-primary"
      : dirty
        ? "bg-warning"
        : "bg-success";

  const activeTheme =
    THEME_OPTIONS.find((option) => option.value === mode) ?? THEME_OPTIONS[0];
  const onlineFeature = FEATURE_REGISTRY.find((item) => item.id === "online");
  const tabTriggerClass =
    "h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-elevation-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm";

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-4 sm:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t("settings.page.eyebrow")}
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">
            {t("nav.settings")}
          </h1>
          <p className="mt-1.5 line-clamp-2 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t("settings.page.description")}
          </p>
        </div>
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <ShieldCheck className="size-3.5" />
          {t("settings.page.localFirst")}
        </Badge>
      </header>

      {loadError ? (
        <Card className="items-start gap-3 p-2">
          <ErrorState
            message={t("settings.errors.loadSettingsDetail", {
              detail: loadError,
            })}
            onRetry={() => void load()}
          />
        </Card>
      ) : loading ? (
        <Card className="p-2" aria-busy="true">
          <PixelPet mode="loading" message={t("settings.page.loading")} />
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={onTabChange} className="gap-4">
          {/* 单行 5 列：900px 最小窗口 + 六语长文案下不折行、不溢出。 */}
          <TabsList
            aria-label={t("settings.tabs.label")}
            className="grid h-auto w-full grid-cols-5 gap-0.5 overflow-hidden rounded-full border border-border bg-card p-1.5 shadow-elevation-sm group-data-horizontal/tabs:h-auto"
          >
            <TabsTrigger
              value="general"
              data-testid="settings-tab-general"
              className={tabTriggerClass}
            >
              {t("settings.tabs.general")}
            </TabsTrigger>
            <TabsTrigger
              value="network"
              data-testid="settings-tab-network"
              className={tabTriggerClass}
            >
              {t("settings.tabs.network")}
            </TabsTrigger>
            {/* QA 回归依赖 settings-tab-cache，storage 分区的 testid 保持旧值。 */}
            <TabsTrigger
              value="storage"
              data-testid="settings-tab-cache"
              className={tabTriggerClass}
            >
              {t("settings.tabs.storage")}
            </TabsTrigger>
            <TabsTrigger
              value="privacy"
              data-testid="settings-tab-privacy"
              className={tabTriggerClass}
            >
              {t("settings.tabs.privacy")}
            </TabsTrigger>
            <TabsTrigger
              value="about"
              data-testid="settings-tab-about"
              className={tabTriggerClass}
            >
              {t("settings.tabs.about")}
            </TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------------------------- 常规 */}
          <TabsContent value="general" className="mt-2 space-y-3">
            <SettingsSection
              icon={Palette}
              title={t("settings.theme.title")}
              description={t("settings.theme.description")}
            >
              <div
                role="group"
                aria-label={t("settings.theme.groupLabel")}
                className="flex w-full max-w-md rounded-full border border-border bg-background/60 p-1"
              >
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const active = mode === option.value;
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      variant={active ? "pill-primary" : "pill-ghost"}
                      size="pill-sm"
                      className="min-w-0 flex-1"
                      onClick={() => onThemeChange(option.value)}
                      disabled={saving}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{t(option.labelKey)}</span>
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(activeTheme.hintKey)}
              </p>

              <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-background/60">
                <SettingRow
                  title={t("settings.language.label")}
                  description={t("settings.language.description")}
                >
                  <Select
                    items={LOCALE_OPTIONS}
                    value={locale}
                    onValueChange={(value) => {
                      if (isLocale(value)) {
                        setLocale(value);
                        recordBreadcrumb("localeChange");
                      }
                    }}
                  >
                    <SelectTrigger
                      id="ui-language"
                      aria-label={t("settings.language.label")}
                      className="w-40"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCALE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
              </div>
            </SettingsSection>

            <SettingsSection
              icon={PanelTop}
              title={t("settings.tray.title")}
              description={t("settings.tray.description")}
              rows={
                <SettingRow
                  title={t("settings.tray.closeToTray")}
                  description={t("settings.tray.closeToTrayHint")}
                  badge={
                    <Badge variant={form.closeToTray ? "success" : "muted"}>
                      {form.closeToTray
                        ? t("common.enabled")
                        : t("common.disabled")}
                    </Badge>
                  }
                >
                  <Switch
                    checked={form.closeToTray}
                    disabled={saving || loading}
                    aria-label={t("settings.tray.closeToTray")}
                    onCheckedChange={(checked) => {
                      setForm((prev) => ({ ...prev, closeToTray: checked }));
                      setDirty(true);
                    }}
                  />
                </SettingRow>
              }
            />


            <SettingsSection
              icon={SlidersHorizontal}
              title={t("settings.features.title")}
              description={t("settings.features.description")}
              rows={
                <>
                  {FEATURE_REGISTRY.map((feature) => {
                    const enabled = form.features[feature.settingKey];
                    return (
                      <SettingRow
                        key={feature.id}
                        title={t(feature.titleKey)}
                        description={t(feature.descriptionKey)}
                        badge={
                          <Badge variant={enabled ? "success" : "muted"}>
                            {enabled
                              ? t("common.enabled")
                              : t("common.disabled")}
                          </Badge>
                        }
                      >
                        <Switch
                          checked={enabled}
                          disabled={featureBusy !== null || saving || loading}
                          aria-label={t(feature.titleKey)}
                          onCheckedChange={(checked) =>
                            void toggleFeature(feature, checked)
                          }
                        />
                      </SettingRow>
                    );
                  })}
                </>
              }
            />


            <SettingsSection
              icon={Keyboard}
              title={t("settings.shortcuts.title")}
              description={t("settings.shortcuts.description")}
              summary={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={shortcutsEnabled ? "success" : "muted"}
                    className="whitespace-nowrap"
                  >
                    {shortcutsEnabled
                      ? t("settings.shortcuts.enabled")
                      : t("settings.shortcuts.disabled")}
                  </Badge>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("settings.shortcuts.count", {
                      count: GLOBAL_SHORTCUTS.length,
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="pill-ghost"
                    size="pill-sm"
                    className="ml-auto whitespace-nowrap"
                    onClick={() => {
                      setShortcutsEnabled(true);
                      toast(t("settings.shortcuts.resetDone"));
                    }}
                  >
                    <RotateCcw className="size-3.5" />
                    {t("settings.shortcuts.reset")}
                  </Button>
                </div>
              }
              rows={
                <SettingRow
                  title={t("settings.shortcuts.toggle")}
                  description={t("settings.shortcuts.toggleHint")}
                >
                  <Switch
                    checked={shortcutsEnabled}
                    aria-label={t("settings.shortcuts.toggle")}
                    onCheckedChange={setShortcutsEnabled}
                  />
                </SettingRow>
              }
              disclosure={{
                triggerLabel: t("settings.shortcuts.open"),
                triggerHint: t("settings.shortcuts.openHint"),
                description: t("settings.shortcuts.sheetDescription"),
                testId: "shortcuts-open",
              }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {GLOBAL_SHORTCUTS.map((row) => (
                  <div
                    key={row.keys}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-3 py-2.5"
                  >
                    <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                      {t(row.actionKey)}
                    </span>
                    <Badge
                      variant="secondary"
                      className="shrink-0 px-2.5 py-0.5 font-mono text-[11px]"
                    >
                      {row.keys}
                    </Badge>
                  </div>
                ))}
              </div>
              <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-background/60 px-3 py-2.5">
                <Command className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-xs font-medium">
                  {t("settings.shortcuts.command")}
                </span>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("settings.shortcuts.note")}
              </p>
            </SettingsSection>
          </TabsContent>

          {/* ---------------------------------------------------------------- 网络 */}
          <TabsContent value="network" className="mt-2 space-y-3">
            {safeMode ? (
              <Card className="items-start gap-3 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-warning text-background shadow-elevation-sm">
                  <ShieldCheck className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-medium">
                    {t("safeMode.settingsOnlinePausedTitle")}
                  </h2>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {t("safeMode.settingsOnlinePausedBody")}
                  </p>
                </div>
              </Card>
            ) : (
              <>
                <SettingsSection
                  icon={Globe2}
                  title={t("settings.online.networkTitle")}
                  description={t("settings.online.networkDescription")}
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        variant={
                          proxyMode === "system" ? "pill-primary" : "pill"
                        }
                        size="pill-sm"
                        aria-pressed={proxyMode === "system"}
                        onClick={() => void onDetectProxy()}
                        disabled={detectingProxy || saving}
                      >
                        {detectingProxy ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Globe2 />
                        )}
                        {t("settings.online.proxyMode.system")}
                      </Button>
                      <Button
                        type="button"
                        variant={
                          proxyMode === "manual" ? "pill-primary" : "pill"
                        }
                        size="pill-sm"
                        aria-pressed={proxyMode === "manual"}
                        onClick={() => setProxySource("manual")}
                        disabled={saving}
                      >
                        {t("settings.online.proxyMode.manual")}
                      </Button>
                      <Button
                        type="button"
                        variant={
                          proxyMode === "direct" ? "pill-primary" : "pill"
                        }
                        size="pill-sm"
                        aria-pressed={proxyMode === "direct"}
                        onClick={() => {
                          setProxySource("manual");
                          set("onlineProxy", "");
                        }}
                        disabled={saving}
                      >
                        {t("settings.online.proxyMode.direct")}
                      </Button>
                    </div>
                    <Input
                      id="online-proxy"
                      aria-label={t("settings.online.proxyLabel")}
                      value={form.onlineProxy}
                      onChange={(event) => {
                        setProxySource("manual");
                        set("onlineProxy", event.currentTarget.value);
                      }}
                      placeholder={t("settings.online.proxyPlaceholder")}
                      className="min-w-0 font-mono text-xs"
                      spellCheck={false}
                      disabled={saving || proxyMode === "direct"}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t("settings.online.proxyHint")}
                    </p>
                  </div>

                  <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-background/60">
                    <SettingRow
                      title={t("settings.online.concurrencyLabel")}
                      description={t("settings.online.concurrencyHint")}
                    >
                      <Select
                        items={concurrencyItems}
                        value={String(form.onlineConcurrency)}
                        disabled={saving}
                        onValueChange={(value) => {
                          const next = Number(value);
                          if (Number.isFinite(next)) {
                            set(
                              "onlineConcurrency",
                              Math.min(8, Math.max(1, next)),
                            );
                          }
                        }}
                      >
                        <SelectTrigger
                          aria-label={t("settings.online.concurrencyLabel")}
                          className="w-32"
                        >
                          <SelectValue
                            placeholder={t(
                              "settings.online.concurrencyPlaceholder",
                            )}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {concurrencyItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingRow>
                  </div>
                </SettingsSection>

                <SettingsSection
                  icon={KeyRound}
                  title={t("settings.online.headersLabel")}
                  description={t("settings.online.headersHint")}
                  summary={
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={sessionActive ? "success" : "muted"}
                        className="whitespace-nowrap"
                      >
                        {sessionActive
                          ? t("settings.online.sessionPresent")
                          : t("settings.online.sessionAbsent")}
                      </Badge>
                      <Badge variant="secondary" className="whitespace-nowrap">
                        {sessionHeaders
                          ? t("settings.online.memoryOnly")
                          : t("settings.online.persistLocal")}
                      </Badge>
                    </div>
                  }
                  disclosure={{
                    triggerLabel: t("settings.online.headersLabel"),
                    triggerHint: sessionHeaders
                      ? t("settings.online.memoryOnly")
                      : t("settings.online.persistLocal"),
                    testId: "online-headers-open",
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="online-headers">
                      {t("settings.online.headersLabel")}
                    </Label>
                    <Textarea
                      id="online-headers"
                      value={form.onlineHeaders}
                      onChange={(event) =>
                        set("onlineHeaders", event.currentTarget.value)
                      }
                      rows={5}
                      placeholder={t("settings.online.headersPlaceholder")}
                      className="select-text min-h-32 font-mono text-xs"
                      spellCheck={false}
                      autoComplete="off"
                      disabled={saving}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t("settings.online.headersHint")}
                    </p>
                  </div>

                  <div className="space-y-2 rounded-xl border border-border bg-background/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {t("settings.online.storageMode")}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {t("settings.online.storageModeDescription")}
                        </p>
                      </div>
                      <div
                        className="flex flex-wrap gap-1.5"
                        role="group"
                        aria-label={t("settings.online.storageModeGroup")}
                      >
                        <Button
                          type="button"
                          variant={sessionHeaders ? "pill-primary" : "pill"}
                          size="pill-sm"
                          aria-pressed={sessionHeaders}
                          disabled={saving}
                          onClick={() => {
                            setSessionHeaders(true);
                            setDirty(true);
                          }}
                        >
                          {t("settings.online.memoryOnly")}
                        </Button>
                        <Button
                          type="button"
                          variant={!sessionHeaders ? "pill-primary" : "pill"}
                          size="pill-sm"
                          aria-pressed={!sessionHeaders}
                          disabled={saving}
                          onClick={() => {
                            setSessionHeaders(false);
                            setDirty(true);
                          }}
                        >
                          {t("settings.online.persistLocal")}
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="pill"
                        size="pill-sm"
                        className="whitespace-nowrap"
                        onClick={() => void onClearSessionHeaders()}
                        disabled={!sessionActive || saving}
                      >
                        <Trash2 />
                        {t("settings.online.clearSession")}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {sessionActive
                          ? t("settings.online.sessionPresent")
                          : t("settings.online.sessionAbsent")}
                      </span>
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t("settings.online.storageModeNote")}
                    </p>
                  </div>
                </SettingsSection>

                {onlineFeature ? (
                  <OnlineFilterPanel
                    enabled={form.features.online}
                    toggleBusy={featureBusy !== null || saving}
                    onToggle={(value) =>
                      void toggleFeature(onlineFeature, value)
                    }
                  />
                ) : null}

                {form.features.webAccess ? (
                  <WebAccessSummaryCard>
                    <WebAccessPanel />
                    <CaDistributionPanel />
                    {form.features.opds ? <OpdsPanel /> : null}
                  </WebAccessSummaryCard>
                ) : null}

                <SettingsSection
                  icon={Wifi}
                  title={t("settings.online.urlTitle")}
                  description={t("settings.online.urlDescription")}
                  rows={
                    <SettingRow
                      title={t(ONLINE_FEATURE.titleKey)}
                      description={t(ONLINE_FEATURE.descriptionKey)}
                      badge={
                        <Badge variant={form.features.online ? "success" : "muted"}>
                          {form.features.online
                            ? t("common.enabled")
                            : t("common.disabled")}
                        </Badge>
                      }
                    >
                      <Switch
                        checked={form.features.online}
                        disabled={featureBusy !== null || saving || loading}
                        data-testid="online-direct-switch"
                        aria-label={t(ONLINE_FEATURE.titleKey)}
                        onCheckedChange={(checked) =>
                          void toggleFeature(ONLINE_FEATURE, checked)
                        }
                      />
                    </SettingRow>
                  }
                >
                  <p className="rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
                    {t("settings.online.browserHint")}
                  </p>
                </SettingsSection>
              </>
            )}
          </TabsContent>

          {/* ---------------------------------------------------------------- 存储 */}
          <TabsContent value="storage" className="mt-2 space-y-3">
            <SettingsSection
              icon={Gauge}
              title={t("settings.stats.title")}
              description={t("settings.stats.description")}
              action={
                dashError ? (
                  <Button
                    type="button"
                    variant="pill-ghost"
                    size="pill-sm"
                    onClick={() => void loadDashboard()}
                  >
                    <RefreshCw />
                    {t("common.retry")}
                  </Button>
                ) : undefined
              }
              summary={
                dashError ? (
                  <p className="line-clamp-2 text-xs leading-5 text-destructive">
                    {t("settings.stats.loadError", { detail: dashError })}
                  </p>
                ) : dashLoading || !dash ? (
                  <p className="text-xs text-muted-foreground" aria-busy="true">
                    {t("settings.stats.loading")}
                  </p>
                ) : (
                  <SettingsStatRow>
                    <SettingsStat
                      label={t("settings.stats.totalBooks")}
                      value={formatNumber(dash.totalBooks)}
                      unit={t("settings.stats.unitBooks")}
                    />
                    <SettingsStat
                      label={t("settings.stats.reading")}
                      value={formatNumber(dash.reading)}
                      unit={t("settings.stats.unitBooks")}
                    />
                    <SettingsStat
                      label={t("settings.stats.todayPages")}
                      value={formatNumber(dash.todayPages)}
                      unit={t("common.pages")}
                    />
                    <SettingsStat
                      label={t("settings.stats.last7Pages")}
                      value={formatNumber(last7Pages)}
                      unit={t("common.pages")}
                    />
                  </SettingsStatRow>
                )
              }
              disclosure={{
                triggerLabel: t("settings.library.dirLabel"),
                triggerHint:
                  form.libraryDir.trim() ||
                  t("settings.library.dirPlaceholder"),
                testId: "library-dir-open",
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="library-dir">
                  {t("settings.library.dirLabel")}
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="library-dir"
                    value={form.libraryDir}
                    onChange={(event) =>
                      set("libraryDir", event.currentTarget.value)
                    }
                    placeholder={t("settings.library.dirPlaceholder")}
                    className="min-w-0 font-mono text-xs sm:flex-1"
                    spellCheck={false}
                    disabled={saving}
                  />
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      className="whitespace-nowrap"
                      onClick={() => void onPickDir()}
                      disabled={scanning || saving}
                    >
                      <FolderOpen />
                      {t("settings.library.pick")}
                    </Button>
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-icon"
                      aria-label={t("settings.library.clearDir")}
                      title={t("settings.library.clearDir")}
                      onClick={() => set("libraryDir", "")}
                      disabled={!form.libraryDir || saving}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="pill-primary"
                    size="pill"
                    className="whitespace-nowrap"
                    onClick={() => void onScanLibrary()}
                    disabled={scanning || saving || !form.libraryDir.trim()}
                  >
                    {scanning ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <ScanLine />
                    )}
                    {scanning
                      ? t("settings.library.scanning")
                      : t("settings.library.scanNow")}
                  </Button>
                  <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                    {t("settings.library.scanHint")}
                  </span>
                </div>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("settings.stats.note")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={HardDrive}
              title={t("settings.cache.manageTitle")}
              description={t("settings.cache.manageDescription")}
              action={
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-sm"
                  onClick={() => void refreshMemory()}
                >
                  <RefreshCw />
                  {t("common.refresh")}
                </Button>
              }
              summary={
                <div className="space-y-2" data-testid="disk-cache-usage">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">
                      {t("settings.cache.diskUsage")}
                    </span>
                    <span className="font-mono font-semibold tabular-nums">
                      {mem
                        ? `${formatMb(mem.diskCacheBytes, locale)} / ${formatMb(
                            mem.diskCacheLimitBytes,
                            locale,
                          )} · ${formatNumber(diskCachePct)}%`
                        : t("settings.cache.diskEmpty")}
                    </span>
                  </div>
                  <Progress value={diskCachePct} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t("settings.cache.budgetBadge", {
                        size: formatNumber(diskBudgetMb),
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-sm"
                      className="whitespace-nowrap"
                      data-testid="clear-temp-cache"
                      onClick={() => void onClearTemp()}
                      disabled={clearingTemp || saving}
                    >
                      {clearingTemp ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                      {clearingTemp
                        ? t("settings.cache.clearingTemp")
                        : t("settings.cache.clearTemp")}
                    </Button>
                  </div>
                </div>
              }
              disclosure={{
                triggerLabel: t("settings.cache.detailOpen"),
                triggerHint: t("settings.cache.detailOpenHint"),
                testId: "cache-detail-open",
              }}
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="disk-cache-budget">
                    {t("settings.cache.diskLabel")}
                  </Label>
                  <Badge
                    variant="secondary"
                    className="px-3 py-1 font-mono tabular-nums"
                  >
                    {formatNumber(diskBudgetMb)} MB
                  </Badge>
                </div>
                <Slider
                  id="disk-cache-budget"
                  value={[diskBudgetMb]}
                  min={500}
                  max={10240}
                  step={256}
                  disabled={saving}
                  onValueChange={(value) =>
                    set(
                      "diskCacheBudgetMb",
                      typeof value === "number" ? value : (value[0] ?? 2048),
                    )
                  }
                  getAriaLabel={() => t("settings.cache.diskAria")}
                />
                <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                  <span>{formatNumber(500)} MB</span>
                  <span>{formatNumber(10240)} MB</span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("settings.cache.diskHint")}
                </p>
              </div>

              {mem ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <MemoryTile
                    label={t("settings.cache.diskRender")}
                    value={formatMb(mem.renderCacheBytes, locale)}
                  />
                  <MemoryTile
                    label={t("settings.cache.diskOnline")}
                    value={formatMb(mem.onlineCacheBytes, locale)}
                  />
                </div>
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground">
                {t("settings.cache.clearTempHint")}
              </p>
            </SettingsSection>

            {form.features.backup ? (
              <DataBackupPanel onRestored={load} />
            ) : null}
          </TabsContent>

          {/* ---------------------------------------------------------------- 隐私 */}
          <TabsContent value="privacy" className="mt-2 space-y-3">
            <PrivacyPanel />
          </TabsContent>

          {/* ---------------------------------------------------------------- 关于 */}
          <TabsContent value="about" className="mt-2 space-y-3">
            <SettingsSection
              icon={Info}
              title={t("settings.about.title")}
              description={t("settings.about.description")}
              summary={
                <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="min-w-0 rounded-lg border border-border bg-background/60 px-3 py-2">
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {t("settings.about.version")}
                    </dt>
                    <dd className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums">
                      v{APP_VERSION}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border bg-background/60 px-3 py-2">
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {t("settings.about.commit")}
                    </dt>
                    <dd
                      className="mt-0.5 truncate font-mono text-xs font-semibold"
                      title={BUILD_COMMIT}
                    >
                      {BUILD_COMMIT}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border bg-background/60 px-3 py-2">
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {t("settings.about.storage")}
                    </dt>
                    <dd className="mt-0.5 truncate text-xs font-semibold">
                      {t("settings.about.storageValue")}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border bg-background/60 px-3 py-2">
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {t("settings.about.dataFlow")}
                    </dt>
                    <dd className="mt-0.5 truncate text-xs font-semibold">
                      {t("settings.about.dataFlowValue")}
                    </dd>
                  </div>
                  <AboutBuildOriginCell />
                </dl>
              }
              rows={
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                  <Badge
                    variant="secondary"
                    className="whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium"
                  >
                    {t("settings.about.nonCommercial")}
                  </Badge>
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("settings.about.buildOriginLabel")}
                  </span>
                  <AboutBuildOriginValue />
                </div>
              }
            >
              <p className="text-xs leading-5 text-muted-foreground">
                {t("settings.about.note")}
              </p>
            </SettingsSection>

            {form.features.updates ? <UpdatesPanel /> : null}

            {form.features.diagnostics ? (
              <SettingsSection
                icon={ShieldCheck}
                title={t("support.title")}
                description={t("support.description")}
                summary={
                  <Badge variant="success" className="gap-1.5">
                    <ShieldCheck className="size-3.5" aria-hidden />
                    {t("support.localOnly")}
                  </Badge>
                }
                disclosure={{
                  triggerLabel: t("privacy.detail.exportTitle"),
                  triggerHint: t("support.description"),
                  testId: "diagnostics-open",
                }}
              >
                <DiagnosticPanel />
              </SettingsSection>
            ) : null}
          </TabsContent>
        </Tabs>
      )}

      {tab === "general" || tab === "network" || tab === "storage" ? (
        <div className="sticky bottom-4 z-30 mt-5">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-hard">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground">
              <span
                className={cn("size-2 shrink-0 rounded-full", statusDot)}
                aria-hidden
              />
              <span className="truncate">{statusText}</span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-3">
              {dirty && !saving ? (
                <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
                  {t("settings.status.saveHint")}
                </span>
              ) : null}
              <Button
                type="button"
                variant="pill-primary"
                size="pill"
                className="min-w-32 whitespace-nowrap"
                onClick={() => void onSave()}
                disabled={!ready || saving || featureBusy !== null}
              >
                {saving ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Save />
                )}
                {saving ? t("common.saving") : t("settings.saveButton")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 构建来源指纹：官方 CI 注入 `MR_BUILD_ORIGIN=official` → Official
 * Release；否则按社区构建展示。拉取失败回落 community（宁可误标社区，
 * 不把第三方产物冒充官方）。模块级缓存避免多处重复 invoke。
 */
let buildOriginCache: Promise<string> | null = null;
function fetchBuildOrigin(): Promise<string> {
  buildOriginCache ??= updateApi
    .getAppInfo()
    .then((info) => (info.buildOrigin === "official" ? "official" : "community"))
    .catch(() => "community");
  return buildOriginCache;
}

function useBuildOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchBuildOrigin().then((value) => {
      if (alive) setOrigin(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return origin;
}

/** 构建来源指纹格子（关于分区 dl 的最后一格）。 */
function AboutBuildOriginCell() {
  const { t } = useI18n();
  const origin = useBuildOrigin();
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background/60 px-3 py-2">
      <dt className="text-[11px] font-medium text-muted-foreground">
        {t("settings.about.buildOrigin")}
      </dt>
      <dd className="mt-0.5 truncate text-xs font-semibold">
        {origin === "official"
          ? t("settings.about.buildOriginOfficial")
          : t("settings.about.buildOriginCommunity")}
      </dd>
    </div>
  );
}

/** 构建来源指纹值（非商用徽章行右侧）。 */
function AboutBuildOriginValue() {
  const { t } = useI18n();
  const origin = useBuildOrigin();
  return (
    <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
      {origin === "official"
        ? t("settings.about.buildOriginOfficial")
        : t("settings.about.buildOriginCommunity")}
    </span>
  );
}
