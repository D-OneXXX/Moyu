import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  Check,
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
  ScanLine,
  ShieldCheck,
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
  SettingsRowList,
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
import DeveloperFeaturePanel, {
  FeatureDisabledNotice,
} from "@/components/settings/DeveloperFeaturePanel";
import ErrorState from "@/components/ErrorState";
import ConfirmDialog from "@/components/ConfirmDialog";import { APP_VERSION, BUILD_COMMIT } from "@/lib/version";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";
import { localizeBackendError } from "@/features/errors/localize";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_REGISTRY,
  type FeatureDefinition,
  type FeatureId,
  ONLINE_FEATURE,
} from "@/features/features";
import { useShortcutsEnabled } from "@/features/shortcuts/preferences";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { recordBreadcrumb } from "@/features/resilience";

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

/** 占用条的刻度上限：至少一个预算，在线原图超出时按总量放大，避免溢出裁剪。 */
function cacheBarScale(render: number, online: number, limit: number): number {
  const total = Math.max(0, render) + Math.max(0, online);
  return Math.max(1, limit, total);
}

/** 在线原图超过该阈值时给出非破坏性提示（2 GiB）。 */
const ONLINE_CACHE_HINT_BYTES = 2048 * 1024 * 1024;

/** 缓存占用百分比：非法值/零上限安全，结果限制在 0-100。 */
function cachePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

/** 自动保存微状态：短暂浮现的绿色小勾 / 已自动保存微字。 */
function AutoSaveHint({
  state,
}: {
  state: "idle" | "saving" | "saved" | "error";
}) {
  const { t } = useI18n();
  if (state === "idle") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium tabular-nums",
        state === "saved" && "text-success",
        state === "error" && "text-destructive",
        state === "saving" && "text-muted-foreground",
      )}
      aria-live="polite"
    >
      {state === "saving" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : state === "saved" ? (
        <Check className="size-3" />
      ) : null}
      {state === "saving"
        ? t("settings.autoSaving")
        : state === "saved"
          ? t("settings.autoSaved")
          : t("settings.autoSaveFailed")}
    </span>
  );
}

/**
 * 设置页：常规与外观 / 网络与在线源 / 存储与数据 / 隐私与安全 / 关于与维护。
 *
 * 交互铁律：
 *  - 二级设置一律用居中模态弹窗（Dialog），废弃侧滑 Sheet；
 *  - 「调整即保存」：开关/选择点击即落盘，滑杆松手 200ms 落盘，文本输入
 *    400ms 防抖 / 失焦落盘；不再有底部「保存」栏。
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
  const [featureBusy, setFeatureBusy] = useState<FeatureId | null>(null);
  const [resettingFeatures, setResettingFeatures] = useState(false);
  const [confirmResetFeatures, setConfirmResetFeatures] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [detectingProxy, setDetectingProxy] = useState(false);
  const [sessionHeaders, setSessionHeaders] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [clearingTemp, setClearingTemp] = useState(false);
  const [clearingOnline, setClearingOnline] = useState(false);
  /** 代理来源：system = 跟随系统探测填入；manual = 手动输入。 */
  const [proxySource, setProxySource] = useState<"system" | "manual">(
    "manual",
  );
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState<string | null>(null);
  const [shortcutsEnabled, setShortcutsEnabled] = useShortcutsEnabled();

  /** 自动保存反馈状态。 */
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  // 最近一次成功读/写数据库的完整设置；保存时作为底稿保留隐藏字段。
  const loadedRef = useRef<Settings | null>(null);
  const loadSeqRef = useRef(0);
  const dashSeqRef = useRef(0);
  /** 表单同步镜像：persist 同步读取最新值，避免 setState 与读取的时序竞争。 */
  const formRef = useRef<Settings>(DEFAULT_FORM);
  const sessionHeadersRef = useRef(false);
  const saveFlashRef = useRef<number | null>(null);
  const debounceTimersRef = useRef<Partial<Record<keyof Settings, number>>>({});

  useEffect(() => {
    formRef.current = form;
  }, [form]);
  useEffect(() => {
    sessionHeadersRef.current = sessionHeaders;
  }, [sessionHeaders]);

  /**
   * 更新表单并同步镜像；persist 依赖它读取到最新值。
   *
   * 关键：先同步计算并写入 formRef，再提交 React state。否则输入事件里
   * 「setForm → 立刻 persist」会读到上一次渲染的旧值，导致开关看起来切换
   * 成功、实际没有落库（关闭到托盘、功能开关都受此影响）。
   */
  const applyForm = useCallback((updater: (prev: Settings) => Settings) => {
    const next = updater(formRef.current);
    formRef.current = next;
    setForm(next);
    return next;
  }, []);

  /** 静默落盘：以「已加载设置 + 当前表单」整对象写回，保留隐藏字段。 */
  const persist = useCallback(async (snapshot?: Settings) => {
    if (!loadedRef.current) return;
    const base: Settings = { ...loadedRef.current };
    const current = snapshot ?? formRef.current;
    const next: Settings = { ...base, ...current };
    setSaveState("saving");
    try {
      let saved: Settings;
      if (sessionHeadersRef.current) {
        // 会话模式：请求头只写入进程内存，数据库里保留空串。
        await api.setSessionOnlineHeaders(current.onlineHeaders);
        setSessionActive(current.onlineHeaders.trim().length > 0);
        const persisted: Settings = { ...next, onlineHeaders: "" };
        saved = await api.setSettings(persisted);
        loadedRef.current = saved;
        applyForm((prev) => ({ ...prev, features: saved.features }));
      } else {
        await api.clearSessionOnlineHeaders();
        setSessionActive(false);
        saved = await api.setSettings(next);
        loadedRef.current = saved;
        applyForm((prev) => ({ ...prev, features: saved.features }));
      }
      setSaveState("saved");
      recordBreadcrumb("settingsChange");
      window.dispatchEvent(new Event("mr-settings-updated"));
      void api
        .getMemoryStats()
        .then(setMem)
        .catch(() => {});
    } catch (e) {
      setSaveState("error");
      toastErr("set_settings", e);
    } finally {
      if (saveFlashRef.current) window.clearTimeout(saveFlashRef.current);
      saveFlashRef.current = window.setTimeout(() => setSaveState("idle"), 1600);
    }
  }, [applyForm]);

  /** 即时落盘：开关 / 选择器点击瞬间，直接把新快照交给 persist。 */
  const setField = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      const next = applyForm((prev) => ({ ...prev, [key]: value }));
      void persist(next);
    },
    [applyForm, persist],
  );

  /** 防抖落盘：文本输入 / 滑杆。 */
  const setFieldDebounced = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K], delay = 400) => {
      applyForm((prev) => ({ ...prev, [key]: value }));
      const existing = debounceTimersRef.current[key];
      if (existing) window.clearTimeout(existing);
      debounceTimersRef.current[key] = window.setTimeout(() => {
        void persist();
      }, delay);
    },
    [applyForm, persist],
  );

  const concurrencyItems = Array.from({ length: 8 }, (_, index) => {
    const value = String(index + 1);
    return {
      value,
      label: t("settings.online.concurrencyItem", {
        count: formatNumber(index + 1),
      }),
    };
  });

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
      void api.getMemoryStats().then(
        (memory) => {
          if (seq === loadSeqRef.current) setMem(memory);
        },
        () => {
          if (seq === loadSeqRef.current) setMem(null);
        },
      );
      // localStorage 中的模式优先：首次启动没有偏好时跟随系统。
      let storedMode: string | null = null;
      try {
        storedMode = localStorage.getItem("mr-theme");
      } catch {
        /* 忽略 */
      }
      const theme = normalizeTheme(storedMode ?? "system");
      const sessionValue =
        typeof session === "string" && session.trim().length > 0 ? session : "";
      const nextForm: Settings = {
        ...DEFAULT_FORM,
        ...settings,
        features: { ...DEFAULT_FEATURE_FLAGS, ...(settings.features ?? {}) },
        theme,
        ...(sessionValue ? { onlineHeaders: sessionValue } : {}),
      };
      loadedRef.current = { ...settings, theme };
      formRef.current = nextForm;
      setForm(nextForm);
      setSessionActive(sessionValue.length > 0);
      setSessionHeaders(sessionValue.length > 0);
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

  // 每个分区独立成页；切换时回到顶部，避免继承上一分区的滚动偏移。
  useEffect(() => {
    document
      .querySelector("[data-shell-scroll]")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [tab]);

  // 顶栏也可切换主题；保证表单里的 theme 始终与 ThemeProvider 当前模式一致。
  useEffect(() => {
    applyForm((prev) =>
      prev.theme === mode ? prev : { ...prev, theme: mode },
    );
    if (loadedRef.current && loadedRef.current.theme !== mode) {
      loadedRef.current = { ...loadedRef.current, theme: mode };
    }
  }, [mode, applyForm]);

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
    applyForm((prev) => ({ ...prev, theme: next }));
    if (loadedRef.current) {
      loadedRef.current = { ...loadedRef.current, theme: next };
    }
  };

  // 功能开关立即持久化；只写单个功能键，不会把表单里尚未保存的字段一起写库。
  const toggleFeature = async (
    feature: FeatureDefinition,
    value: boolean,
  ): Promise<boolean> => {
    if (featureBusy !== null) return false;
    const previous = formRef.current.features;
    setFeatureBusy(feature.id);
    applyForm((prev) => ({
      ...prev,
      features: { ...prev.features, [feature.settingKey]: value },
    }));
    try {
      const next = await api.setFeatureEnabled(feature.id, value);
      if (loadedRef.current) {
        loadedRef.current = { ...loadedRef.current, features: next.features };
      }
      applyForm((prev) => ({ ...prev, features: next.features }));
      recordBreadcrumb("settingsChange");
      toast(
        t(
          value ? "settings.toast.featureOn" : "settings.toast.featureOff",
          { feature: t(feature.titleKey) },
        ),
      );
      return true;
    } catch (e) {
      applyForm((prev) => ({ ...prev, features: previous }));
      toastErr("set_feature_enabled", e);
      return false;
    } finally {
      setFeatureBusy(null);
    }
  };

  /** 启用某个被开发者门卫关闭的模块，并同步到当前设置表单。 */
  const enableFeature = async (feature: FeatureId): Promise<boolean> => {
    const definition = FEATURE_REGISTRY.find((item) => item.id === feature);
    if (!definition) return false;
    return toggleFeature(definition, true);
  };

  /**
   * 恢复 9 项模块门卫的默认值。
   *
   * 仍然逐项走 `set_feature_enabled`（唯一写通道），最后用后端返回的权威
   * Settings 刷新表单；不使用会保留旧 features 的 `set_settings`。
   */
  const resetFeatureGates = async () => {
    setConfirmResetFeatures(false);
    if (featureBusy !== null || resettingFeatures) return;
    setResettingFeatures(true);
    const failures: string[] = [];
    let last: Settings | null = null;
    try {
      for (const definition of FEATURE_REGISTRY) {
        try {
          last = await api.setFeatureEnabled(
            definition.id,
            definition.defaultEnabled,
          );
        } catch (error) {
          failures.push(
            `${t(definition.titleKey)}: ${localizeBackendError(error)}`,
          );
        }
      }
      if (last) {
        const authoritative = last;
        if (loadedRef.current) {
          loadedRef.current = {
            ...loadedRef.current,
            features: authoritative.features,
          };
        }
        applyForm((prev) => ({
          ...prev,
          features: authoritative.features,
        }));
      }
      if (failures.length > 0) {
        toast(
          t("developer.resetPartial", { detail: failures.join("；") }),
        );
      } else {
        toast(t("developer.resetDone"));
      }
      recordBreadcrumb("settingsChange");
      window.dispatchEvent(new Event("mr-settings-updated"));
    } finally {
      setResettingFeatures(false);
    }
  };

  const onPickDir = async () => {    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("settings.library.pickTitle"),
        defaultPath: form.libraryDir.trim() || undefined,
      });
      if (typeof picked === "string") setField("libraryDir", picked);
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
        setProxySource("system");
        setField("onlineProxy", proxy);
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
      setSessionActive(false);
      applyForm((prev) => ({ ...prev, onlineHeaders: "" }));
      await persist();
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

  /** 只清理在线原图；保留未读完且 30 天内打开过的书（keepUnread=true）。 */
  const onClearOnline = async () => {
    if (clearingOnline) return;
    setClearingOnline(true);
    try {
      const result = await api.clearOnlineCache(true);
      toast(
        t("settings.toast.onlineCleared", {
          books: formatNumber(result.books),
          size: formatMb(result.bytesFreed, locale),
        }),
      );
      await refreshMemory();
    } catch (e) {
      toastErr("clear_online_cache", e);
    } finally {
      setClearingOnline(false);
    }
  };

  /** 请求头存储模式：切换后立即重新落盘。 */
  const onSessionModeChange = (memoryOnly: boolean) => {
    sessionHeadersRef.current = memoryOnly;
    setSessionHeaders(memoryOnly);
    void persist();
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

  /** 直连 = 未填代理；填了则按来源显示跟随系统 / 手动。 */
  const proxyMode: "system" | "manual" | "direct" = form.onlineProxy.trim()
    ? proxySource
    : "direct";
  // 预算只约束渲染成品；在线原图离线保留，不参与该百分比。
  const diskCachePct = mem
    ? cachePercent(mem.renderCacheBytes, mem.diskCacheLimitBytes)
    : 0;
  // 双色占用条按「预算 / 实际总量」较大者取刻度：在线原图远超预算时
  // 两段仍按真实比例铺满整条，不溢出、不裁剪。
  const cacheBarMax = mem
    ? cacheBarScale(
        mem.renderCacheBytes,
        mem.onlineCacheBytes,
        mem.diskCacheLimitBytes,
      )
    : 1;
  const renderBarPct = mem
    ? Math.min(100, (Math.max(0, mem.renderCacheBytes) / cacheBarMax) * 100)
    : 0;
  const onlineBarPct = mem
    ? Math.min(
        100 - renderBarPct,
        (Math.max(0, mem.onlineCacheBytes) / cacheBarMax) * 100,
      )
    : 0;
  const budgetMarkerPct = mem
    ? Math.min(100, (mem.diskCacheLimitBytes / cacheBarMax) * 100)
    : 100;
  const onlineCacheLarge = Boolean(
    mem && mem.onlineCacheBytes > ONLINE_CACHE_HINT_BYTES,
  );
  const diskBudgetMb = Number.isFinite(form.diskCacheBudgetMb)
    ? Math.min(10240, Math.max(500, form.diskCacheBudgetMb))
    : 2048;
  const last7Pages = dash ? sumLast7Days(dash.heatmap) : 0;

  const onlineFeature = ONLINE_FEATURE;
  const tabTriggerClass =
    "h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-elevation-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm";

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-4 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t("settings.page.eyebrow")}
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">
            {t("nav.settings")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
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
            className="grid h-auto w-full grid-cols-5 items-stretch justify-normal gap-0.5 overflow-visible rounded-full border border-border bg-card p-1.5 shadow-elevation-sm group-data-horizontal/tabs:h-auto"
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
                className="grid gap-3 sm:grid-cols-3"
              >
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const active = mode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      data-testid={`theme-card-${option.value}`}
                      onClick={() => onThemeChange(option.value)}
                      className={cn(
                        "relative flex min-w-0 flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-colors",
                        active
                          ? "border-primary bg-primary/10 shadow-hard-sm"
                          : "border-border bg-background/60 hover:bg-muted/40",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon className="size-4 shrink-0" />
                        <span className="min-w-0 truncate text-sm font-semibold">
                          {t(option.labelKey)}
                        </span>
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {t(option.hintKey)}
                      </span>
                      {active ? (
                        <Check className="absolute right-3 top-3 size-4 text-primary" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <p className="px-1 text-xs text-muted-foreground">
                {t("settings.theme.systemNote")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Globe2}
              title={t("settings.language.title")}
              description={t("settings.language.description")}
              rows={
                <SettingRow title={t("settings.language.label")}>
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
              }
            />

            <SettingsSection
              icon={PanelTop}
              title={t("settings.tray.title")}
              description={t("settings.tray.description")}
              rows={
                <SettingRow
                  title={t("settings.tray.closeToTray")}
                  description={t("settings.tray.closeToTrayHint")}
                >
                  <Switch
                    checked={form.closeToTray}
                    disabled={loading}
                    aria-label={t("settings.tray.closeToTray")}
                    onCheckedChange={(checked) =>
                      setField("closeToTray", checked)
                    }
                  />
                </SettingRow>
              }
            />

            <SettingsSection
              icon={Keyboard}
              title={t("settings.shortcuts.title")}
              description={t("settings.shortcuts.description")}
              disclosure={{
                title: t("settings.shortcuts.title"),
                triggerLabel: t("settings.shortcuts.open"),
                triggerHint: shortcutsEnabled
                  ? t("settings.shortcuts.enabled")
                  : t("settings.shortcuts.disabled"),
                width: "lg",
                testId: "shortcuts-open",
              }}
            >
              <SettingsRowList>
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
              </SettingsRowList>

              <div className="grid gap-2 sm:grid-cols-2">
                {GLOBAL_SHORTCUTS.map((row) => (
                  <div
                    key={row.keys}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5"
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
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
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
            ) : null}

            <SettingsSection
              icon={Wifi}
              title={t("settings.online.urlTitle")}
              description={t("settings.online.urlDescription")}
              rows={
                <SettingRow
                  title={t("settings.online.enableTitle")}
                  description={t("settings.online.enableDescription")}
                  badge={
                    <Badge
                      variant={form.features.online ? "success" : "muted"}
                    >
                      {form.features.online
                        ? t("common.enabled")
                        : t("common.disabled")}
                    </Badge>
                  }
                >
                  <Switch
                    checked={form.features.online}
                    disabled={featureBusy !== null || safeMode}
                    data-testid="online-direct-switch"
                    aria-label={t("settings.online.enableTitle")}
                    onCheckedChange={(checked) =>
                      void toggleFeature(onlineFeature, checked)
                    }
                  />
                </SettingRow>
              }
            />

            <SettingsSection
              icon={KeyRound}
              title={t("settings.online.networkTitle")}
              description={t("settings.online.networkDescription")}
            >
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant={
                        proxyMode === "system" ? "pill-primary" : "pill"
                      }
                      size="pill-sm"
                      aria-pressed={proxyMode === "system"}
                      onClick={() => void onDetectProxy()}
                      disabled={detectingProxy}
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
                        setField("onlineProxy", "");
                      }}
                    >
                      {t("settings.online.proxyMode.direct")}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="online-proxy">
                      {t("settings.online.proxyLabel")}
                    </Label>
                    <Input
                      id="online-proxy"
                      aria-label={t("settings.online.proxyLabel")}
                      value={form.onlineProxy}
                      onChange={(event) => {
                        setProxySource("manual");
                        setFieldDebounced(
                          "onlineProxy",
                          event.currentTarget.value,
                        );
                      }}
                      onBlur={() => {
                        if (proxySource === "manual") void persist();
                      }}
                      placeholder={t("settings.online.proxyPlaceholder")}
                      className="min-w-0 font-mono text-xs"
                      spellCheck={false}
                      disabled={proxyMode === "direct"}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                        {t("settings.online.proxyHint")}
                      </p>
                      <AutoSaveHint state={saveState} />
                    </div>
                  </div>

                  <SettingsRowList>
                    <SettingRow
                      title={t("settings.online.concurrencyLabel")}
                      description={t("settings.online.concurrencyHint")}
                    >
                      <Select
                        items={concurrencyItems}
                        value={String(form.onlineConcurrency)}
                        onValueChange={(value) => {
                          const next = Number(value);
                          if (Number.isFinite(next)) {
                            setField(
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
                  </SettingsRowList>

                  <div className="space-y-2">
                    <Label htmlFor="online-headers">
                      {t("settings.online.headersLabel")}
                    </Label>
                    <Textarea
                      id="online-headers"
                      value={form.onlineHeaders}
                      onChange={(event) =>
                        setFieldDebounced(
                          "onlineHeaders",
                          event.currentTarget.value,
                        )
                      }
                      onBlur={() => void persist()}
                      rows={5}
                      placeholder={t("settings.online.headersPlaceholder")}
                      className="select-text min-h-32 font-mono text-xs"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                        {t("settings.online.headersHint")}
                      </p>
                      <AutoSaveHint state={saveState} />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/60 bg-card/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {t("settings.online.storageMode")}
                        </p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
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
                          onClick={() => onSessionModeChange(true)}
                        >
                          {t("settings.online.memoryOnly")}
                        </Button>
                        <Button
                          type="button"
                          variant={!sessionHeaders ? "pill-primary" : "pill"}
                          size="pill-sm"
                          aria-pressed={!sessionHeaders}
                          onClick={() => onSessionModeChange(false)}
                        >
                          {t("settings.online.persistLocal")}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="pill"
                        size="pill-sm"
                        className="whitespace-nowrap"
                        onClick={() => void onClearSessionHeaders()}
                        disabled={!sessionActive}
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
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("settings.online.storageModeNote")}
                  </p>
                </SettingsSection>

            {form.features.online && !safeMode ? <OnlineFilterPanel /> : null}

            {form.features.webAccess ? (
              <WebAccessSummaryCard>
                <WebAccessPanel />
                <div id="settings-ca-distribution">
                  <CaDistributionPanel />
                </div>
              </WebAccessSummaryCard>
            ) : (
              <FeatureDisabledNotice
                feature="webAccess"
                onEnable={() => enableFeature("webAccess")}
              />
            )}

            {form.features.opds ? (
              <OpdsPanel />
            ) : (
              <FeatureDisabledNotice
                feature="opds"
                onEnable={() => enableFeature("opds")}
              />
            )}
          </TabsContent>

          {/* ---------------------------------------------------------------- 存储 */}
          <TabsContent value="storage" className="mt-2 space-y-3">
            <SettingsSection
              icon={Gauge}
              title={t("settings.stats.title")}
              description={t("settings.stats.description")}
              action={
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  className="whitespace-nowrap"
                  onClick={() => void onScanLibrary()}
                  disabled={scanning || !form.libraryDir.trim()}
                  data-testid="rescan-library"
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
                title: t("settings.library.dirLabel"),
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
                      setFieldDebounced("libraryDir", event.currentTarget.value)
                    }
                    onBlur={() => void persist()}
                    placeholder={t("settings.library.dirPlaceholder")}
                    className="min-w-0 font-mono text-xs sm:flex-1"
                    spellCheck={false}
                  />
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      className="whitespace-nowrap"
                      onClick={() => void onPickDir()}
                      disabled={scanning}
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
                      onClick={() => setField("libraryDir", "")}
                      disabled={!form.libraryDir}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                    {t("settings.library.scanHint")}
                  </span>
                  <AutoSaveHint state={saveState} />
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              icon={HardDrive}
              title={t("settings.cache.manageTitle")}
              description={t("settings.cache.manageDescription")}
            >
              <div
                className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3"
                data-testid="disk-cache-usage"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("settings.cache.diskUsage")}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">
                    {mem
                      ? `${formatMb(mem.renderCacheBytes, locale)} / ${formatMb(
                          mem.diskCacheLimitBytes,
                          locale,
                        )} · ${formatNumber(diskCachePct)}%`
                      : t("settings.cache.diskEmpty")}
                  </span>
                </div>
                <div
                  className="relative flex h-2.5 w-full overflow-hidden rounded-full border border-border/60 bg-muted"
                  role="img"
                  aria-label={
                    mem
                      ? t("settings.cache.barAria", {
                          render: formatMb(mem.renderCacheBytes, locale),
                          online: formatMb(mem.onlineCacheBytes, locale),
                        })
                      : t("settings.cache.diskEmpty")
                  }
                  data-testid="disk-cache-bar"
                >
                  <span
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${renderBarPct}%` }}
                    data-testid="disk-cache-render"
                  />
                  <span
                    className="h-full transition-[width]"
                    style={{
                      width: `${onlineBarPct}%`,
                      backgroundColor: "var(--sh-warning)",
                    }}
                    data-testid="disk-cache-online"
                  />
                  {mem && budgetMarkerPct < 100 ? (
                    <span
                      className="absolute inset-y-0 w-px bg-foreground/40"
                      style={{ left: `${budgetMarkerPct}%` }}
                      aria-hidden="true"
                      data-testid="disk-cache-budget-marker"
                    />
                  ) : null}
                </div>
                {mem ? (
                  <div className="flex flex-wrap justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="size-2 rounded-full bg-primary"
                        aria-hidden="true"
                      />
                      {t("settings.cache.diskRender")}：
                      {formatMb(mem.renderCacheBytes, locale)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: "var(--sh-warning)" }}
                        aria-hidden="true"
                      />
                      {t("settings.cache.diskOnline")}：
                      {formatMb(mem.onlineCacheBytes, locale)}
                    </span>
                  </div>
                ) : null}
                {onlineCacheLarge ? (
                  <Badge
                    variant="warning"
                    className="max-w-full whitespace-normal text-left leading-4 tabular-nums"
                    data-testid="online-cache-hint"
                  >
                    {t("settings.cache.onlineLarge", {
                      size: formatMb(mem?.onlineCacheBytes ?? 0, locale),
                    })}
                  </Badge>
                ) : null}
              </div>

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
                  onValueChange={(value) => {
                    const next =
                      typeof value === "number" ? value : (value[0] ?? 2048);
                    setFieldDebounced("diskCacheBudgetMb", next, 200);
                  }}
                  getAriaLabel={() => t("settings.cache.diskAria")}
                />
                <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                  <span>{formatNumber(500)} MB</span>
                  <span>{formatNumber(10240)} MB</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                    {t("settings.cache.clearTempHint")}
                  </p>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-sm"
                      className="shrink-0 whitespace-nowrap"
                      data-testid="clear-temp-cache"
                      onClick={() => void onClearTemp()}
                      disabled={clearingTemp}
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
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-sm"
                      className="shrink-0 whitespace-nowrap"
                      data-testid="clear-online-cache"
                      onClick={() => void onClearOnline()}
                      disabled={clearingOnline}
                    >
                      {clearingOnline ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                      {clearingOnline
                        ? t("settings.cache.clearingOnline")
                        : t("settings.cache.clearOnline")}
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t("settings.cache.clearOnlineHint")}
                </p>
              </div>
            </SettingsSection>

            {form.features.backup ? (
              <DataBackupPanel onRestored={load} />
            ) : (
              <FeatureDisabledNotice
                feature="backup"
                onEnable={() => enableFeature("backup")}
              />
            )}
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
                  <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {t("settings.about.version")}
                    </dt>
                    <dd className="mt-0.5 truncate font-mono text-xs font-semibold tabular-nums">
                      v{APP_VERSION}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
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
                  <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
                    <dt className="text-[11px] font-medium text-muted-foreground">
                      {t("settings.about.storage")}
                    </dt>
                    <dd className="mt-0.5 truncate text-xs font-semibold">
                      {t("settings.about.storageValue")}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
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
            >
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <Badge
                  variant="secondary"
                  className="whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium"
                >
                  {t("settings.about.license")}
                </Badge>
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settings.about.buildOriginLabel")}
                </span>
                <AboutBuildOriginValue />
              </div>
              <p className="px-1 text-xs leading-5 text-muted-foreground">
                {t("settings.about.note")}
              </p>
            </SettingsSection>

            <DeveloperFeaturePanel
              features={form.features}
              busy={featureBusy}
              safeMode={safeMode}
              resetting={resettingFeatures}
              onToggle={(feature, value) => {
                void toggleFeature(feature, value);
              }}
              onReset={() => setConfirmResetFeatures(true)}
            />

            {form.features.updates ? (
              <UpdatesPanel />
            ) : (
              <FeatureDisabledNotice
                feature="updates"
                onEnable={() => enableFeature("updates")}
              />
            )}

            {confirmResetFeatures ? (
              <ConfirmDialog
                title={t("developer.resetConfirmTitle")}
                message={t("developer.resetConfirmMessage")}
                confirmText={t("developer.reset")}
                tone="primary"
                onConfirm={() => void resetFeatureGates()}
                onCancel={() => setConfirmResetFeatures(false)}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

/**
 * 构建来源指纹：官方 CI 注入 `MR_BUILD_ORIGIN=official` → Official
 * Release；否则按社区构建展示。拉取失败回落 community。
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
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
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

/** 构建来源指纹值（许可证徽章行右侧）。 */
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
