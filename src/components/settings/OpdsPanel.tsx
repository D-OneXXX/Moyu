import { useEffect, useState } from "react";
import { Cloud, Eraser, Loader2, Save, Server, Wifi } from "lucide-react";
import {
  api,
  type OnlineProbe,
  type OpdsConfigView,
} from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { localizeBackendError } from "@/features/errors/localize";
import { recordBreadcrumb } from "@/features/resilience";
import { toast, toastErr } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/SettingsSection";

/**
 * OPDS 1.2 远程书库设置：地址/账号/密码只存本机 SQLite，密码只写不读。
 * 仅连接用户填写的 origin；不提供外部源或自动抓取。
 */
export default function OpdsPanel() {
  const { t, formatNumber } = useI18n();
  const [config, setConfig] = useState<OpdsConfigView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [clearUsername, setClearUsername] = useState(false);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<OnlineProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const saveConfig = async (): Promise<OpdsConfigView | null> => {
    setError(null);
    setProbe(null);
    const payload = {
      enabled,
      url: url.trim(),
      username: clearUsername ? "" : username.length > 0 ? username : null,
      password: clearPassword ? "" : password.length > 0 ? password : null,
    };
    const saved = await api.setOpdsConfig(payload);
    setConfig(saved);
    setEnabled(saved.enabled);
    setUrl(saved.url);
    setUsername("");
    setClearUsername(false);
    setPassword("");
    setClearPassword(false);
    recordBreadcrumb("settingsChange");
    return saved;
  };

  const onSave = async () => {
    if (saving || testing) return;
    setSaving(true);
    try {
      await saveConfig();
      toast(t("opds.settings.saved"));
    } catch (reason) {
      setError(localizeBackendError(reason));
      toastErr("opds_set_config", reason);
    } finally {
      setSaving(false);
    }
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
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-background/60 p-4">
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
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("opds.settings.enableDescription")}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("opds.settings.enableTitle")}
          data-testid="opds-enabled"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="opds-url">{t("opds.settings.urlLabel")}</Label>
        <Input
          id="opds-url"
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
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
                setUsername(event.currentTarget.value);
                if (event.currentTarget.value.length > 0) setClearUsername(false);
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
                setPassword(event.currentTarget.value);
                if (event.currentTarget.value.length > 0) setClearPassword(false);
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
          onClick={() => void onSave()}
          disabled={saving || testing}
          data-testid="opds-save"
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          {saving ? t("opds.settings.saving") : t("opds.settings.save")}
        </Button>
        <Button
          variant="pill"
          size="pill"
          onClick={() => void onTest()}
          disabled={saving || testing || !enabled || url.trim().length === 0}
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
      </div>

      {error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-1.5 rounded-2xl border border-border/60 bg-secondary/40 px-4 py-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Cloud className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("opds.settings.localOnly")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("opds.settings.backupNote")}
        </p>
      </div>
    </SettingsSection>
  );
}
