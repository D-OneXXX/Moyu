import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Cloud,
  Eraser,
  FolderSearch,
  Loader2,
  Server,
  ShieldAlert,
  Wifi,
} from "lucide-react";
import {
  api,
  type OnlineProbe,
  type OpdsConfigView,
} from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { localizeBackendError } from "@/features/errors/localize";
import { recordBreadcrumb } from "@/features/resilience";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { toastErr } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/SettingsSection";
import OpdsBrowserDialog from "@/components/library/OpdsBrowserDialog";
import { cn } from "@/lib/utils";

/**
 * OPDS 1.2 远程书库设置：地址/账号/密码只存本机 SQLite，密码只写不读。
 * 「调整即保存」：开关即时落盘，地址 400ms 防抖 / 失焦落盘，账号密码失焦落盘。
 * 仅连接用户填写的 origin；不提供外部源或自动抓取。
 */
export default function OpdsPanel() {
  const { t, formatNumber } = useI18n();
  const nav = useNavigate();
  const { active: safeMode } = useSafeMode();
  const [config, setConfig] = useState<OpdsConfigView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [clearUsername, setClearUsername] = useState(false);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [testing, setTesting] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [probe, setProbe] = useState<OnlineProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  type OpdsFields = {
    enabled: boolean;
    url: string;
    username: string;
    password: string;
    clearUsername: boolean;
    clearPassword: boolean;
  };
  const stateRef = useRef<OpdsFields>({
    enabled,
    url,
    username,
    password,
    clearUsername,
    clearPassword,
  });
  const debounceRef = useRef<number | null>(null);
  const flashRef = useRef<number | null>(null);

  /** 同步更新镜像：开关/清除按钮必须在 commit 前立刻写入，不能等 effect。 */
  const syncFields = useCallback((patch: Partial<OpdsFields>) => {
    stateRef.current = { ...stateRef.current, ...patch };
  }, []);

  useEffect(() => {
    stateRef.current = {
      enabled,
      url,
      username,
      password,
      clearUsername,
      clearPassword,
    };
  });

  useEffect(() => {
    let alive = true;
    api.getOpdsConfig().then(
      (value) => {
        if (!alive) return;
        setConfig(value);
        setEnabled(value.enabled);
        setUrl(value.url);
        setUsername("");
        setLoading(false);
      },
      (reason) => {
        if (!alive) return;
        setError(localizeBackendError(reason));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const commit = useCallback(async () => {
    const s = stateRef.current;
    const payload = {
      enabled: s.enabled,
      url: s.url.trim(),
      username: s.clearUsername ? "" : s.username.length > 0 ? s.username : null,
      password: s.clearPassword ? "" : s.password.length > 0 ? s.password : null,
    };
    setSaving(true);
    setError(null);
    setProbe(null);
    try {
      const saved = await api.setOpdsConfig(payload);
      setConfig(saved);
      setEnabled(saved.enabled);
      setUrl(saved.url);
      setUsername("");
      setClearUsername(false);
      setPassword("");
      setClearPassword(false);
      stateRef.current = {
        enabled: saved.enabled,
        url: saved.url,
        username: "",
        password: "",
        clearUsername: false,
        clearPassword: false,
      };
      recordBreadcrumb("settingsChange");
      setSavedFlash(true);
      if (flashRef.current) window.clearTimeout(flashRef.current);
      flashRef.current = window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (reason) {
      setError(localizeBackendError(reason));
      toastErr("opds_set_config", reason);
    } finally {
      setSaving(false);
    }
  }, []);

  const onUrlChange = (value: string) => {
    setUrl(value);
    syncFields({ url: value });
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => void commit(), 400);
  };

  const onTest = async () => {
    if (saving || testing) return;
    if (
      !config || !enabled || !config.enabled || url.trim() !== config.url ||
      username.length > 0 || clearUsername || password.length > 0 || clearPassword
    ) {
      setError(t("opds.settings.saveFirst"));
      return;
    }
    setTesting(true);
    try {
      const result = await api.testOpdsConnection();
      setProbe(result);
      recordBreadcrumb("onlineRead");
    } catch (reason) {
      setError(localizeBackendError(reason));
      toastErr("opds_test_connection", reason);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <SettingsSection
        icon={Server}
        title={t("opds.settings.title")}
        description={t("opds.settings.description")}
      >
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("common.loading")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        icon={Server}
        title={t("opds.settings.title")}
        description={t("opds.settings.description")}
        action={
          <Badge variant="outline" className="shrink-0 whitespace-nowrap">
            OPDS 1.2
          </Badge>
        }
      >
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">
              {t("opds.settings.enableTitle")}
            </p>
            {config?.hasPassword ? (
              <Badge variant="secondary" className="shrink-0">
                {t("opds.settings.passwordSaved")}
              </Badge>
            ) : null}
            {safeMode ? (
              <Badge variant="warning" className="shrink-0">
                <ShieldAlert className="size-3" aria-hidden />
                {t("safeMode.badgeActive")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("opds.settings.enableDescription")}
          </p>
          {safeMode ? (
            <p
              role="status"
              className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning"
            >
              {t("featureGate.safeMode", {
                feature: t("opds.settings.title"),
              })}
            </p>
          ) : null}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => {
            setEnabled(next);
            syncFields({ enabled: next });
            void commit();
          }}
          aria-label={t("opds.settings.enableTitle")}
          data-testid="opds-enabled"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="opds-url">{t("opds.settings.urlLabel")}</Label>
        <Input
          id="opds-url"
          value={url}
          onChange={(event) => onUrlChange(event.currentTarget.value)}
          onBlur={() => void commit()}
          placeholder={t("opds.settings.urlPlaceholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-testid="opds-url"
          className="font-mono text-xs"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("opds.settings.urlHint")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="opds-username">
            {t("opds.settings.usernameLabel")}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="opds-username"
              value={username}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setUsername(next);
                syncFields({ username: next, clearUsername: false });
                if (next.length > 0) setClearUsername(false);
              }}
              onBlur={() => {
                if (username.length > 0 || clearUsername) void commit();
              }}
              placeholder={t("opds.settings.usernamePlaceholder")}
              autoComplete="username"
              spellCheck={false}
              data-testid="opds-username"
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="shrink-0"
              onClick={() => {
                setUsername("");
                setClearUsername(true);
                syncFields({ username: "", clearUsername: true });
                void commit();
              }}
              disabled={!config?.hasUsername && !clearUsername}
              title={t("opds.settings.clearUsername")}
              data-testid="opds-clear-username"
            >
              <Eraser className="size-3.5" aria-hidden />
              {t("opds.settings.clearUsername")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {clearUsername
              ? t("opds.settings.clearUsername")
              : config?.hasUsername
                ? t("opds.settings.usernameSaved")
                : t("opds.settings.usernameNone")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="opds-password">
            {t("opds.settings.passwordLabel")}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="opds-password"
              type="password"
              value={password}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setPassword(next);
                syncFields({ password: next, clearPassword: false });
                if (next.length > 0) setClearPassword(false);
              }}
              onBlur={() => {
                if (password.length > 0 || clearPassword) void commit();
              }}
              placeholder={t("opds.settings.passwordPlaceholder")}
              autoComplete="new-password"
              data-testid="opds-password"
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="shrink-0"
              onClick={() => {
                setPassword("");
                setClearPassword(true);
                syncFields({ password: "", clearPassword: true });
                void commit();
              }}
              disabled={!config?.hasPassword && !clearPassword}
              title={t("opds.settings.clearPassword")}
              data-testid="opds-clear-password"
            >
              <Eraser className="size-3.5" aria-hidden />
              {t("opds.settings.clearPassword")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {clearPassword
              ? t("opds.settings.clearPassword")
              : config?.hasPassword
                ? t("opds.settings.passwordSaved")
                : t("opds.settings.passwordNone")}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("opds.settings.passwordOriginNote")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="pill-primary"
          size="pill"
          onClick={() => setBrowseOpen(true)}
          disabled={
            !enabled ||
            url.trim().length === 0 ||
            safeMode ||
            saving ||
            testing
          }
          data-testid="opds-browse"
        >
          <FolderSearch className="size-4" aria-hidden />
          {t("opds.settings.browse")}
        </Button>
        <Button
          variant="pill"
          size="pill"
          onClick={() => void onTest()}
          disabled={
            saving || testing || !enabled || url.trim().length === 0 || safeMode
          }
          data-testid="opds-test"
        >
          {testing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Wifi className="size-4" aria-hidden />
          )}
          {testing ? t("opds.settings.testing") : t("opds.settings.test")}
        </Button>
        {probe?.ok ? (
          <span
            role="status"
            className="min-w-0 break-words text-xs font-medium tabular-nums text-success"
          >
            {t("opds.settings.testOk", {
              title: probe.title || t("opds.dialog.untitled"),
              count: formatNumber(probe.pageCount),
            })}
          </span>
        ) : null}
        <span
          aria-live="polite"
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-[11px] font-medium tabular-nums",
            savedFlash ? "text-success" : "text-muted-foreground",
          )}
        >
          {saving ? (
            <Loader2 className="size-3 animate-spin" />
          ) : savedFlash ? (
            <Check className="size-3" />
          ) : null}
          {saving
            ? t("settings.autoSaving")
            : savedFlash
              ? t("settings.autoSaved")
              : null}
        </span>
      </div>

      {error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-1.5 rounded-lg border border-border/60 bg-secondary/40 px-4 py-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Cloud className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("opds.settings.localOnly")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("opds.settings.backupNote")}
        </p>
      </div>
      </SettingsSection>
      <OpdsBrowserDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onOpenBook={(book) => {
          setBrowseOpen(false);
          nav(`/reader/${encodeURIComponent(book.id)}`);
        }}
        onGoSettings={() => setBrowseOpen(false)}
      />
    </>
  );
}
