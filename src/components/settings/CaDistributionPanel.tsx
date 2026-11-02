import { useCallback, useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Copy,
  Download,
  Fingerprint,
  Loader2,
  Play,
  ShieldCheck,
  Square,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/SettingsSection";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toast, toastErr } from "@/components/Toast";
import { localizeBackendError } from "@/features/errors/localize";
import { useI18n } from "@/i18n";
import { recordBreadcrumb } from "@/features/resilience";
import {
  caDistributionApi,
  type CaDistributionStatusView,
  type CaStatusView,
} from "@/features/web-access/caDistributionApi";

type Busy = "init" | "export" | "start" | "stop" | null;

function expiryText(
  notAfter: number | null,
  locale: string,
): string | null {
  if (!notAfter) return null;
  return new Date(notAfter * 1000).toLocaleDateString(locale);
}

/**
 * G1 root-CA distribution card.
 *
 * The listener is never started by rendering this panel. The user must click
 * "start distribution"; the backend then serves only `/ca.crt` for 120 seconds.
 */
export default function CaDistributionPanel() {
  const { t, locale } = useI18n();
  const [ca, setCa] = useState<CaStatusView | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [selectedIp, setSelectedIp] = useState("");
  const [distribution, setDistribution] =
    useState<CaDistributionStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmInit, setConfirmInit] = useState(false);
  const mountedRef = useRef(true);
  const wasRunningRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextCa, nextDistribution] = await Promise.all([
        caDistributionApi.status(),
        caDistributionApi.distributionStatus(),
      ]);
      if (!mountedRef.current) return;
      setCa(nextCa);
      setDistribution(nextDistribution);
      wasRunningRef.current = nextDistribution.running;
      if (nextCa.initialized) {
        const ips = await caDistributionApi.addresses();
        if (!mountedRef.current) return;
        setAddresses(ips);
        setSelectedIp((previous) =>
          previous && ips.includes(previous) ? previous : (ips[0] ?? ""),
        );
      }
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(localizeBackendError(cause));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!distribution?.running) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await caDistributionApi.distributionStatus();
        if (cancelled || !mountedRef.current) return;
        if (wasRunningRef.current && !next.running) {
          if (next.stopReason === "expired") {
            toast(t("settings.ca.distribution.expired"));
          } else if (next.stopReason === "stopped") {
            toast(t("settings.ca.distribution.stopped"));
          }
        }
        wasRunningRef.current = next.running;
        setDistribution(next);
      } catch (cause) {
        if (!cancelled && mountedRef.current) {
          setError(localizeBackendError(cause));
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [distribution?.running, t]);

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(t("settings.ca.copied"));
    } catch {
      toast(t("settings.ca.copyFailed"));
    }
  };

  const initialize = async () => {
    setConfirmInit(false);
    setBusy("init");
    setError(null);
    try {
      const view = await caDistributionApi.initialize();
      if (!mountedRef.current) return;
      setCa(view);
      const ips = await caDistributionApi.addresses();
      if (!mountedRef.current) return;
      setAddresses(ips);
      setSelectedIp((previous) =>
        previous && ips.includes(previous) ? previous : (ips[0] ?? ""),
      );
      toast(t("settings.ca.initialized"));
      recordBreadcrumb("privacy");
    } catch (cause) {
      if (mountedRef.current) {
        setError(localizeBackendError(cause));
        toastErr("web_access_ca_initialize", cause);
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const exportRoot = async () => {
    if (busy) return;
    let path: string | null = null;
    try {
      path = await saveDialog({
        title: t("settings.ca.exportTitle"),
        defaultPath: "moyu-root-ca.crt",
      });
    } catch {
      toast(t("settings.ca.exportFailed"));
      return;
    }
    if (typeof path !== "string" || !path) return;
    setBusy("export");
    setError(null);
    try {
      await caDistributionApi.exportRoot(path);
      if (!mountedRef.current) return;
      toast(t("settings.ca.exported"));
      recordBreadcrumb("privacy");
    } catch (cause) {
      if (mountedRef.current) {
        setError(localizeBackendError(cause));
        toastErr("web_access_ca_export_root", cause);
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const startDistribution = async () => {
    if (busy) return;
    if (!selectedIp) {
      toast(t("settings.ca.distribution.noAddress"));
      return;
    }
    setBusy("start");
    setError(null);
    try {
      const next = await caDistributionApi.start(selectedIp);
      if (!mountedRef.current) return;
      setDistribution(next);
      wasRunningRef.current = next.running;
      recordBreadcrumb("privacy");
    } catch (cause) {
      if (mountedRef.current) {
        setError(localizeBackendError(cause));
        toastErr("web_access_ca_distribution_start", cause);
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const stopDistribution = async () => {
    if (busy) return;
    setBusy("stop");
    setError(null);
    try {
      const next = await caDistributionApi.stop();
      if (!mountedRef.current) return;
      setDistribution(next);
      wasRunningRef.current = false;
      toast(t("settings.ca.distribution.stopped"));
      recordBreadcrumb("privacy");
    } catch (cause) {
      if (mountedRef.current) {
        setError(localizeBackendError(cause));
        toastErr("web_access_ca_distribution_stop", cause);
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const fingerprint =
    distribution?.running && distribution.rootFingerprintSha256
      ? distribution.rootFingerprintSha256
      : (ca?.rootFingerprintSha256 ?? null);
  const expires = expiryText(ca?.rootNotAfter ?? null, locale);
  const secondsLeft =
    distribution?.running && distribution.expiresAtUnixMs
      ? Math.max(
          0,
          Math.ceil((distribution.expiresAtUnixMs - Date.now()) / 1000),
        )
      : 0;

  return (
    <>
      <SettingsSection
        icon={Fingerprint}
        title={t("settings.ca.title")}
        description={t("settings.ca.description")}
      >
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : error && !ca ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t("settings.ca.loadError", { detail: error })}
            </span>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              onClick={() => void load()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : !ca?.initialized ? (
          <div className="space-y-3 rounded-2xl border border-border bg-background/60 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="warning">
                {t("settings.ca.badgeNotInitialized")}
              </Badge>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("settings.ca.notInitialized")}
            </p>
            <Button
              type="button"
              variant="pill-primary"
              size="pill-sm"
              disabled={busy !== null}
              onClick={() => setConfirmInit(true)}
            >
              {busy === "init" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="size-3.5" />
              )}
              {t("settings.ca.initialize")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {error ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  onClick={() => setError(null)}
                >
                  {t("common.close")}
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">
                {t("settings.ca.badgeInitialized")}
              </Badge>
              {expires ? (
                <span className="text-xs text-muted-foreground">
                  {t("settings.ca.expires", {
                    date: expires,
                    days: ca.rootDaysRemaining ?? 0,
                  })}
                </span>
              ) : null}
            </div>

            <div className="rounded-2xl border border-border bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {t("settings.ca.fingerprint")}
                </p>
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-sm"
                  disabled={!fingerprint}
                  onClick={() => fingerprint && void copyText(fingerprint)}
                >
                  <Copy className="size-3.5" />
                  {t("settings.ca.copyFingerprint")}
                </Button>
              </div>
              <code className="mt-2 block break-all rounded-xl border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                {fingerprint}
              </code>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t("settings.ca.fingerprintHint")}
              </p>
              <p className="mt-2 text-xs font-medium leading-relaxed text-warning">
                {t("settings.ca.verifyOnPhone")}
              </p>
              {ca.intermediateFingerprintSha256 ? (
                <details className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  <summary className="cursor-pointer select-none font-semibold">
                    {t("settings.ca.intermediateFingerprint")}
                  </summary>
                  <code className="mt-1 block break-all font-mono text-[11px]">
                    {ca.intermediateFingerprintSha256}
                  </code>
                </details>
              ) : null}
            </div>

            {ca.needsRootRotation ? (
              <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                {t("settings.ca.rotationWarning", {
                  days: ca.rootDaysRemaining ?? 0,
                })}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                disabled={busy !== null}
                onClick={() => void exportRoot()}
              >
                {busy === "export" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("settings.ca.export")}
              </Button>
            </div>

            <div className="rounded-2xl border border-border bg-background/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">
                  {t("settings.ca.distribution.title")}
                </p>
                <Badge variant={distribution?.running ? "success" : "muted"}>
                  {distribution?.running
                    ? t("settings.ca.distribution.running")
                    : t("settings.ca.distribution.stopped")}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t("settings.ca.distribution.description")}
              </p>
              {!distribution?.running &&
              distribution?.stopReason === "expired" ? (
                <p className="mt-2 text-xs leading-relaxed text-warning">
                  {t("settings.ca.distribution.expired")}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label
                  className="min-w-0 flex-1 text-xs font-medium"
                  htmlFor="ca-distribution-address"
                >
                  {t("settings.ca.distribution.address")}
                  <select
                    id="ca-distribution-address"
                    className="mt-1 h-9 w-full rounded-full border border-border bg-card px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    value={selectedIp}
                    disabled={busy !== null || distribution?.running === true}
                    onChange={(event) => setSelectedIp(event.target.value)}
                  >
                    {addresses.length === 0 ? (
                      <option value="">
                        {t("settings.ca.distribution.noAddress")}
                      </option>
                    ) : (
                      addresses.map((ip) => (
                        <option key={ip} value={ip}>
                          {ip}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                {distribution?.running ? (
                  <Button
                    type="button"
                    variant="pill-danger"
                    size="pill-sm"
                    disabled={busy !== null}
                    onClick={() => void stopDistribution()}
                  >
                    {busy === "stop" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {t("settings.ca.distribution.stop")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="pill-primary"
                    size="pill-sm"
                    disabled={busy !== null || !selectedIp}
                    onClick={() => void startDistribution()}
                  >
                    {busy === "start" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                    {t("settings.ca.distribution.start")}
                  </Button>
                )}
              </div>

              {distribution?.running && distribution.url ? (
                <div
                  className="mt-3 space-y-2 rounded-xl border border-border bg-muted/30 p-3"
                  aria-live="polite"
                >
                  <p className="text-xs font-semibold">
                    {t("settings.ca.distribution.url")}
                  </p>
                  <code className="block break-all font-mono text-[11px]">
                    {distribution.url}
                  </code>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="pill-ghost"
                      size="pill-sm"
                      onClick={() => void copyText(distribution.url ?? "")}
                    >
                      <Copy className="size-3.5" />
                      {t("common.copy")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t("settings.ca.distribution.expiresIn", {
                        seconds: secondsLeft,
                      })}
                    </span>
                  </div>
                </div>
              ) : null}

              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {t("settings.ca.distribution.securityNote")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("settings.ca.privateKeyNote")}
              </p>
            </div>
          </div>
        )}
      </SettingsSection>

      {confirmInit ? (
        <ConfirmDialog
          title={t("settings.ca.initializeConfirmTitle")}
          message={t("settings.ca.initializeConfirmMessage")}
          confirmText={t("settings.ca.initialize")}
          onConfirm={() => void initialize()}
          onCancel={() => setConfirmInit(false)}
        />
      ) : null}
    </>
  );
}
