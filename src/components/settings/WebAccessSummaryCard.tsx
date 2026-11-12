import { useMemo, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import {
  Copy,
  Globe2,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  SettingRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import { toast } from "@/components/Toast";
import { useI18n } from "@/i18n";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import {
  useWebAccessController,
  WebAccessProvider,
} from "@/features/web-access/WebAccessContext";
import { pickPreferredLanAddress } from "@/features/web-access/address";
import type { WebAccessPhase } from "@/features/web-access/types";

const PHASES: readonly string[] = [
  "disabled",
  "starting",
  "enabled",
  "stopping",
  "error",
];

function normalizePhase(phase: string): WebAccessPhase {
  return PHASES.includes(phase) ? (phase as WebAccessPhase) : "error";
}

function phaseVariant(
  phase: WebAccessPhase,
): "muted" | "warning" | "success" | "destructive" {
  switch (phase) {
    case "enabled":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "muted";
  }
}

/**
 * First-level LAN card.
 *
 * Keeps exactly what a user needs at a glance — state, a quick toggle, the
 * access URL with its QR, and the paired-device count. Everything else
 * (bind address, pairing window, pending claims, device list, CA lifecycle)
 * lives in the secondary centered dialog rendered as `children`.
 *
 * The card owns the single `WebAccessProvider`; the advanced dialog consumes
 * the same controller instead of opening a second independent status stream.
 */
export default function WebAccessSummaryCard({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <WebAccessProvider>
      <WebAccessSummaryCardBody>{children}</WebAccessSummaryCardBody>
    </WebAccessProvider>
  );
}

function WebAccessSummaryCardBody({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { active: safeMode } = useSafeMode();
  const {
    status,
    addresses,
    devices,
    loading,
    busy,
    error,
    refresh,
    start,
    cancelStart,
    stop,
  } = useWebAccessController();

  const phase = normalizePhase(status?.phase ?? "disabled");
  const running = phase === "enabled" || phase === "starting";
  const transport = status?.transport === "https" ? "https" : "http";
  const preferredIp = pickPreferredLanAddress(addresses);
  const accessUrl =
    status?.bindAddress && status.port
      ? `${transport}://${status.bindAddress}:${status.port}/`
      : null;

  const qrImage = useMemo(() => {
    if (!accessUrl) return null;
    try {
      const qr = qrcode(0, "M");
      qr.addData(accessUrl);
      qr.make();
      return { dataUrl: qr.createDataURL(4, 8), size: qr.getModuleCount() * 4 + 16 };
    } catch {
      return null;
    }
  }, [accessUrl]);

  const onToggle = (next: boolean) => {
    if (next) {
      if (preferredIp) void start(preferredIp, false);
      return;
    }
    if (phase === "starting") {
      cancelStart();
      return;
    }
    void stop();
  };

  const copyUrl = async () => {
    if (!accessUrl) return;
    try {
      await navigator.clipboard.writeText(accessUrl);
      toast(t("settings.webAccess.copied"));
    } catch {
      toast(t("settings.webAccess.copyFailed"));
    }
  };

  return (
    <SettingsSection
      icon={Globe2}
      title={t("settings.webAccess.title")}
      description={t("settings.webAccess.description")}
      summary={
        <div className="space-y-3" data-testid="settings-web-access-summary">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={phaseVariant(phase)}
              className="whitespace-nowrap"
              data-testid="web-access-summary-phase"
            >
              {t(`settings.webAccess.phase.${phase}` as "settings.webAccess.phase.enabled")}
            </Badge>
            {safeMode ? (
              <Badge variant="warning" className="whitespace-nowrap">
                <ShieldAlert className="size-3" aria-hidden />
                {t("safeMode.badgeActive")}
              </Badge>
            ) : null}
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("settings.webAccess.pairedDevices", {
                count: status?.deviceCount ?? devices.length,
              })}
            </span>
            <Button
              type="button"
              variant="pill-ghost"
              size="pill-sm"
              className="ml-auto whitespace-nowrap"
              disabled={loading || busy !== null}
              onClick={() => void refresh()}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t("settings.webAccess.refresh")}
            </Button>
          </div>

          {accessUrl ? (
            <div className="flex items-start gap-3 rounded-xl border border-border bg-background/60 p-3">
              {qrImage ? (
                <span className="shrink-0 rounded-lg border border-border bg-white p-1">
                  <img
                    src={qrImage.dataUrl}
                    alt={t("settings.webAccess.qrAlt")}
                    width={qrImage.size}
                    height={qrImage.size}
                    decoding="async"
                    className="block size-16"
                  />
                </span>
              ) : (
                <span className="grid size-16 shrink-0 place-items-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                  <QrCode className="size-5" aria-hidden />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {t("settings.webAccess.accessUrlLabel")}
                </p>
                <p className="mt-0.5 truncate font-mono text-xs" title={accessUrl}>
                  {accessUrl}
                </p>
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-sm"
                  className="mt-1 whitespace-nowrap"
                  onClick={() => void copyUrl()}
                >
                  <Copy className="size-3.5" />
                  {t("settings.webAccess.copyUrl")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
              {t("settings.webAccess.quickHint")}
            </p>
          )}

          {error ? (
            <p role="alert" className="line-clamp-2 break-words text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
      rows={
        <SettingRow
          title={t("settings.webAccess.quickToggle")}
          description={t("settings.webAccess.quickToggleHint")}
          badge={
            transport === "https" ? (
              <Badge variant="secondary" className="whitespace-nowrap">
                <ShieldCheck className="size-3" aria-hidden /> HTTPS
              </Badge>
            ) : undefined
          }
        >
          <Switch
            checked={running}
            data-testid="web-access-quick-toggle"
            disabled={
              loading ||
              safeMode ||
              (busy !== null && busy !== "start" && busy !== "stop") ||
              (!running && addresses.length === 0)
            }
            aria-label={t("settings.webAccess.quickToggle")}
            onCheckedChange={onToggle}
          />
        </SettingRow>
      }
      disclosure={{
        title: t("settings.webAccess.openAdvanced"),
        description: t("settings.webAccess.description"),
        triggerLabel: t("settings.webAccess.openAdvanced"),
        triggerHint: t("settings.webAccess.openAdvancedHint"),
        testId: "web-access-advanced",
      }}
    >
      {children}
    </SettingsSection>
  );
}
