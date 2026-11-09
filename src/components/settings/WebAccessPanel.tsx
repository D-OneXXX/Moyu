import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import {
  AlertTriangle,
  Check,
  Copy,
  Globe2,
  Loader2,
  Monitor,
  Play,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Square,
  Tablet,
  Unplug,
  UserX,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/SettingsSection";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toast } from "@/components/Toast";
import { localizeStableErrorCode } from "@/features/errors/localize";
import { useI18n, type MessageKey } from "@/i18n";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { useAppVisible } from "@/features/performance/visibility";
import { useWebAccess } from "@/features/web-access/useWebAccess";
import type {
  DeviceView,
  PendingClaimView,
  WebAccessPhase,
} from "@/features/web-access/types";

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

function phaseBadgeVariant(
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

function phaseLabelKey(phase: WebAccessPhase): MessageKey {
  return `settings.webAccess.phase.${phase}` as MessageKey;
}

/** Backend sentinel for an empty self-reported name; localize it for display. */
function displayDeviceName(
  name: string,
  translate: (key: MessageKey) => string,
): string {
  return name === "Unknown device"
    ? translate("settings.webAccess.unknownDevice")
    : name;
}

function stopReasonLabel(
  reason: string,
  translate: (key: MessageKey) => string,
): string {
  switch (reason) {
    case "stopped":
      return translate("settings.webAccess.stopReason.stopped");
    case "safe-mode":
      return translate("settings.webAccess.stopReason.safeMode");
    case "recovery":
      return translate("settings.webAccess.stopReason.recovery");
    case "exit":
      return translate("settings.webAccess.stopReason.exit");
    default:
      return translate("common.unknown");
  }
}

function FingerprintBlock({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string | null;
  copyLabel: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold">{label}</p>
        <Button
          type="button"
          variant="pill-ghost"
          size="pill-sm"
          className="whitespace-nowrap"
          disabled={!value}
          onClick={() => value && onCopy(value)}
        >
          <Copy className="size-3.5" />
          {copyLabel}
        </Button>
      </div>
      <code className="mt-1 block break-all rounded-xl border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
        {value ?? "—"}
      </code>
    </div>
  );
}

function ClaimRow({
  claim,
  nowMs,
  busy,
  busyTarget,
  onApprove,
  onDeny,
}: {
  claim: PendingClaimView;
  nowMs: number;
  busy: string | null;
  busyTarget: string | null;
  onApprove: (claim: PendingClaimView) => void;
  onDeny: (claimId: string) => void;
}) {
  const { t, formatDateTime } = useI18n();
  const approving = busy === "approve" && busyTarget === claim.claimId;
  const denying = busy === "deny" && busyTarget === claim.claimId;
  const secondsLeft = Math.max(
    0,
    Math.ceil((claim.expiresAtUnixMs - nowMs) / 1000),
  );
  const expired = secondsLeft === 0;
  return (
    <li className="rounded-xl border border-border bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words text-sm font-semibold">
          {displayDeviceName(claim.deviceName, t)}
        </span>
        <Badge variant="warning" className="whitespace-nowrap">
          {t("settings.webAccess.unverifiedDevice")}
        </Badge>
        <Badge variant={expired ? "warning" : "muted"} className="whitespace-nowrap">
          {expired
            ? t("settings.webAccess.claimExpired")
            : t("settings.webAccess.claimExpiresIn", { seconds: secondsLeft })}
        </Badge>
      </div>
      <p className="mt-1 break-all text-xs leading-relaxed text-muted-foreground">
        {t("settings.webAccess.sourceIp")}:{" "}
        <span className="font-mono">{claim.sourceIp}</span>
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settings.webAccess.receivedAt", {
          time: formatDateTime(claim.createdAtUnixMs, {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
        })}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="pill-primary"
          size="pill-sm"
          className="whitespace-nowrap"
          aria-label={`${t("settings.webAccess.approve")}: ${displayDeviceName(
            claim.deviceName,
            t,
          )}`}
          disabled={busy !== null || expired}
          onClick={() => onApprove(claim)}
        >
          {approving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          {t("settings.webAccess.approve")}
        </Button>
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          className="whitespace-nowrap"
          aria-label={`${t("settings.webAccess.cancelRequest")}: ${displayDeviceName(
            claim.deviceName,
            t,
          )}`}
          disabled={busy !== null}
          onClick={() => onDeny(claim.claimId)}
        >
          {denying ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <X className="size-3.5" />
          )}
          {t("settings.webAccess.cancelRequest")}
        </Button>
      </div>
    </li>
  );
}

/**
 * Settings → Privacy & security → Web Access.
 *
 * The panel never starts the listener, creates a pairing window, or approves a
 * claim on mount. Every start/pair/approve action is an explicit user click.
 * The pairing URL (the only place a pairing id exists) stays in React state:
 * it is not written to storage, logs, or analytics, and the QR image is
 * generated locally by `qrcode-generator` from that URL only.
 */
export default function WebAccessPanel() {
  const { t, formatDateTime } = useI18n();
  const { active: safeModeActive } = useSafeMode();
  // 最小化/隐藏到托盘时暂停 1s 倒计时；恢复可见后重新对时。
  const appVisible = useAppVisible();
  const {
    status,
    addresses,
    pairing,
    devices,
    loading,
    busy,
    busyTarget,
    error,
    refresh,
    refreshPairing,
    start,
    cancelStart,
    stop,
    startPairing,
    cancelPairing,
    approve,
    deny,
    revoke,
    clearError,
  } = useWebAccess();

  const [selectedIp, setSelectedIp] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [approveClaim, setApproveClaim] = useState<PendingClaimView | null>(
    null,
  );
  const [revokeDevice, setRevokeDevice] = useState<DeviceView | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setSelectedIp((previous) =>
      previous && addresses.some((address) => address.ip === previous)
        ? previous
        : (addresses[0]?.ip ?? ""),
    );
  }, [addresses]);

  const isPlain = status?.transport === "http";
  const pairingWindow = pairing?.window ?? null;
  const pairingUrl = pairingWindow?.url ?? null;
  const pairingExpiresAt = pairingWindow?.expiresAtUnixMs ?? null;
  const claims = pairing?.claims ?? [];
  const hasPairingWindowCountdown =
    !isPlain && pairingExpiresAt !== null && pairingExpiresAt > 0;
  const hasClaimCountdown = claims.length > 0;

  // Local countdown only: this timer never talks to the backend and is always
  // cleared when no pairing window or pending request needs it — or while the
  // window is minimized/hidden (防静默态每秒唤醒)。
  useEffect(() => {
    if (!appVisible) return;
    if (!hasPairingWindowCountdown && !hasClaimCountdown) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [appVisible, hasClaimCountdown, hasPairingWindowCountdown]);

  const secondsLeft =
    !hasPairingWindowCountdown || pairingExpiresAt === null
      ? 0
      : Math.max(0, Math.ceil((pairingExpiresAt - nowMs) / 1000));
  const pairingExpired = hasPairingWindowCountdown && secondsLeft === 0;

  const refreshedExpiredClaimsRef = useRef(new Set<string>());
  useEffect(() => {
    const activeIds = new Set(claims.map((claim) => claim.claimId));
    for (const claimId of refreshedExpiredClaimsRef.current) {
      if (!activeIds.has(claimId)) refreshedExpiredClaimsRef.current.delete(claimId);
    }
    const newlyExpired = claims.filter(
      (claim) =>
        claim.expiresAtUnixMs <= nowMs &&
        !refreshedExpiredClaimsRef.current.has(claim.claimId),
    );
    if (newlyExpired.length === 0) return;
    for (const claim of newlyExpired) {
      refreshedExpiredClaimsRef.current.add(claim.claimId);
    }
    void refreshPairing();
  }, [claims, nowMs, refreshPairing]);

  const qrImage = useMemo(() => {
    if (!pairingUrl || pairingExpired) return null;
    try {
      const qr = qrcode(0, "M");
      qr.addData(pairingUrl);
      qr.make();
      // qrcode-generator's margin is in pixels, not modules. 16 px at a
      // 4 px cell is a four-module quiet zone; the outer p-2 adds more white.
      const cellSize = 4;
      const margin = 16;
      return {
        dataUrl: qr.createDataURL(cellSize, margin),
        // Natural size: rendering 1:1 keeps every QR module crisp.
        size: qr.getModuleCount() * cellSize + margin * 2,
      };
    } catch {
      return null;
    }
  }, [pairingExpired, pairingUrl]);

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(t("settings.webAccess.copied"));
    } catch {
      toast(t("settings.webAccess.copyFailed"));
    }
  };

  const phase = normalizePhase(status?.phase ?? "error");
  // A display-only `error` can still own a listener (e.g. the leaf expired).
  // Offer stop in that case; a bind failure has no bound address and can be
  // retried with start instead.
  const canStop =
    phase === "enabled" ||
    phase === "stopping" ||
    (phase === "error" && status?.bindAddress != null);
  const canCancelStart = phase === "starting";
  // While enabled the pairing snapshot is authoritative; the status snapshot
  // only refreshes on state events, which claim creation does not emit.
  const pendingCount =
    phase === "enabled" ? claims.length : (status?.pendingClaimCount ?? 0);

  const onStart = () => {
    if (!selectedIp) return;
    void start(selectedIp);
  };

  const onApproveConfirm = () => {
    const claim = approveClaim;
    setApproveClaim(null);
    if (claim) void approve(claim.claimId);
  };

  const approveConfirmMessage = approveClaim
    ? `${t("settings.webAccess.approveConfirmMessage", {
        name: displayDeviceName(approveClaim.deviceName, t),
      })}${isPlain ? ` ${t("settings.webAccess.approvePlainHttpWarning")}` : ""}`
    : undefined;

  const onRevokeConfirm = () => {
    const device = revokeDevice;
    setRevokeDevice(null);
    if (device) void revoke(device.sessionId);
  };

  return (
    <>
      <div data-testid="settings-web-access">
        <SettingsSection
          icon={Globe2}
          title={t("settings.webAccess.title")}
          description={t("settings.webAccess.description")}
        >
        {loading && !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : !status ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-card p-3 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t("settings.webAccess.loadError", {
                detail: error ?? t("common.unknown"),
              })}
            </span>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="whitespace-nowrap"
              onClick={() => void refresh()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {error ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-card p-3 text-xs leading-relaxed text-destructive"
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  className="whitespace-nowrap"
                  onClick={clearError}
                >
                  {t("common.close")}
                </Button>
              </div>
            ) : null}

            {status.transport === "https" && !status.caInitialized ? (
              <div
                role="status"
                className="flex flex-wrap items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning"
              >
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("settings.webAccess.caRequired")}
                </span>
              </div>
            ) : null}

            {safeModeActive ? (
              <div
                role="status"
                className="flex flex-wrap items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning"
              >
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("settings.webAccess.safeModeBlocked")}
                </span>
              </div>
            ) : null}

            {status.transport !== "https" ? (
              <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                {t("settings.webAccess.httpWarning")}
              </div>
            ) : null}

            {/* Service status + bind controls */}
            <div className="rounded-lg border border-border/60 bg-card/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">
                  {t("settings.webAccess.statusTitle")}
                </p>
                <Badge
                  variant={phaseBadgeVariant(phase)}
                  className="whitespace-nowrap"
                >
                  {t(phaseLabelKey(phase))}
                </Badge>
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

              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">
                    {t("settings.webAccess.bindAddress")}
                  </dt>
                  <dd className="mt-0.5 break-all font-mono">
                    {status.bindAddress ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("settings.webAccess.port")}
                  </dt>
                  <dd className="mt-0.5 font-mono tabular-nums">
                    {status.port === null ? "—" : String(status.port)}
                  </dd>
                </div>
              </dl>

              <div className="mt-2 flex flex-wrap gap-2">
                <Badge
                  variant="secondary"
                  className="whitespace-nowrap tabular-nums"
                >
                  {t("settings.webAccess.deviceCount", {
                    count: status.deviceCount,
                  })}
                </Badge>
                <Badge
                  variant={pendingCount > 0 ? "warning" : "muted"}
                  className="whitespace-nowrap tabular-nums"
                >
                  {t("settings.webAccess.pendingCount", {
                    count: pendingCount,
                  })}
                </Badge>
              </div>

              {status.stopReason ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {t("settings.webAccess.stopReasonTitle")}
                  </span>
                  <Badge variant="muted" className="whitespace-nowrap">
                    {stopReasonLabel(status.stopReason, t)}
                  </Badge>
                </div>
              ) : null}

              {status.lastErrorCode ? (
                <p className="mt-3 rounded-xl border border-destructive/40 bg-card p-3 text-xs leading-relaxed text-destructive">
                  {t("settings.webAccess.lastError", {
                    detail: localizeStableErrorCode(status.lastErrorCode),
                  })}
                </p>
              ) : null}

              {status.transport === "https" ? <div className="mt-3 space-y-3">
                <FingerprintBlock
                  label={t("settings.webAccess.rootFingerprint")}
                  value={status.rootFingerprintSha256}
                  copyLabel={t("settings.webAccess.copyFingerprint")}
                  onCopy={(value) => void copyText(value)}
                />
                <FingerprintBlock
                  label={t("settings.webAccess.leafFingerprint")}
                  value={status.leafFingerprintSha256}
                  copyLabel={t("settings.webAccess.copyFingerprint")}
                  onCopy={(value) => void copyText(value)}
                />
              </div> : null}

              {status.leafNotAfter !== null ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.webAccess.leafExpires", {
                    date: formatDateTime(status.leafNotAfter * 1000, {
                      year: "numeric",
                      month: "short",
                      day: "2-digit",
                    }),
                  })}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label
                  className="min-w-0 flex-1 text-xs font-medium"
                  htmlFor="web-access-address"
                >
                  {t("settings.webAccess.address")}
                  <select
                    id="web-access-address"
                    className="mt-1 h-9 w-full rounded-full border border-border bg-card px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    value={selectedIp}
                    disabled={
                      busy !== null ||
                      loading ||
                      phase === "enabled" ||
                      phase === "starting" ||
                      phase === "stopping"
                    }
                    onChange={(event) => setSelectedIp(event.target.value)}
                  >
                    {addresses.length === 0 ? (
                      <option value="">
                        {t("settings.webAccess.noAddress")}
                      </option>
                    ) : (
                      addresses.map((address) => (
                        <option key={address.ip} value={address.ip}>
                          {`${address.ip} · ${address.interface}`}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                {canCancelStart ? (
                  <Button
                    type="button"
                    variant="pill-danger"
                    size="pill-sm"
                    className="whitespace-nowrap"
                    disabled={busy !== null && busy !== "start"}
                    onClick={cancelStart}
                  >
                    {busy === "start-cancel" || busy === "stop" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                    {busy === "start-cancel" || busy === "stop"
                      ? t("settings.webAccess.cancelingStart")
                      : t("settings.webAccess.cancelStart")}
                  </Button>
                ) : canStop ? (
                  <Button
                    type="button"
                    variant="pill-danger"
                    size="pill-sm"
                    className="whitespace-nowrap"
                    disabled={busy !== null || phase === "stopping"}
                    onClick={() => setConfirmStop(true)}
                  >
                    {phase === "stopping" || busy === "stop" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {phase === "stopping" || busy === "stop"
                      ? t("settings.webAccess.stopping")
                      : t("settings.webAccess.stop")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="pill-primary"
                    size="pill-sm"
                    className="whitespace-nowrap"
                    disabled={
                      busy !== null ||
                      loading ||
                      safeModeActive ||
                      !selectedIp
                    }
                    onClick={onStart}
                  >
                    {busy === "start" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                    {busy === "start"
                      ? t("settings.webAccess.starting")
                      : t("settings.webAccess.start")}
                  </Button>
                )}
              </div>
              {!canStop ? (
                <details className="mt-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t("settings.webAccess.startSecure")}</summary>
                  <p className="mt-2">{t("settings.webAccess.httpsRequiresCa")}</p>
                  {!status.caInitialized ? <p className="mt-2">{t("settings.webAccess.caRequired")}</p> : null}
                  <Button type="button" variant="pill" size="pill-sm" className="mt-2 whitespace-nowrap"
                    disabled={busy !== null || loading || safeModeActive || !selectedIp || !status.caInitialized}
                    onClick={() => void start(selectedIp, true)}>{t("settings.webAccess.startSecure")}</Button>
                </details>
              ) : null}
            </div>

            {/* Pairing window */}
            <div className="rounded-lg border border-border/60 bg-card/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <QrCode className="size-4 text-primary" />
                  {t("settings.webAccess.pairingTitle")}
                </p>
                {pairingWindow && !isPlain ? (
                  <Badge
                    variant={pairingExpired ? "warning" : "success"}
                    className="whitespace-nowrap"
                  >
                    {pairingExpired
                      ? t("settings.webAccess.pairingExpired")
                      : t("settings.webAccess.pairingCountdown", {
                          seconds: secondsLeft,
                        })}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t(isPlain ? "settings.webAccess.plainPairHint" : "settings.webAccess.pairingDescription")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("settings.webAccess.networkHint")}
              </p>

              {phase !== "enabled" ? (
                <p className="mt-3 rounded-xl border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.webAccess.notRunning")}
                </p>
              ) : pairingWindow ? (
                <div className="mt-3 space-y-3">
                  {pairingExpired ? null : (
                    <div className="flex flex-wrap items-start gap-4">
                      {qrImage ? (
                        <div className="shrink-0 rounded-xl border border-border bg-white p-2">
                          <img
                            src={qrImage.dataUrl}
                            alt={t("settings.webAccess.qrAlt")}
                            width={qrImage.size}
                            height={qrImage.size}
                            className="block"
                            decoding="async"
                          />
                        </div>
                      ) : null}
                      <div className="min-w-0 flex-1 space-y-2">
                        <code className="block select-all break-all rounded-xl border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                          {pairingWindow.url}
                        </code>
                        <Button
                          type="button"
                          variant="pill-ghost"
                          size="pill-sm"
                          className="whitespace-nowrap"
                          onClick={() => void copyText(pairingWindow.url)}
                        >
                          <Copy className="size-3.5" />
                          {t("settings.webAccess.copyUrl")}
                        </Button>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {t(isPlain ? "settings.webAccess.plainPairHint" : "settings.webAccess.qrHint")}
                        </p>
                        {!isPlain ? (
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {t("settings.webAccess.httpsRequiresCa")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  )}
                  {!isPlain ? <Button
                    type="button"
                    variant="pill"
                    size="pill-sm"
                    className="whitespace-nowrap"
                    disabled={busy !== null}
                    onClick={() => void cancelPairing()}
                  >
                    {busy === "pairing-cancel" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Unplug className="size-3.5" />
                    )}
                    {t("settings.webAccess.pairingCancel")}
                  </Button> : null}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="pill-primary"
                  size="pill-sm"
                  className="mt-3 whitespace-nowrap"
                  disabled={busy !== null || loading || safeModeActive}
                  onClick={() => void startPairing()}
                >
                  {busy === "pairing-start" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <QrCode className="size-3.5" />
                  )}
                  {t("settings.webAccess.pairingStart")}
                </Button>
              )}
            </div>

            {/* Pending claims: one explicit approval at a time, never bulk. */}
            {phase === "enabled" ? (
              <div
                className="rounded-lg border border-border/60 bg-card/40 p-3"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">
                    {t("settings.webAccess.claimsTitle")}
                  </p>
                  <Badge
                    variant={claims.length > 0 ? "warning" : "muted"}
                    className="whitespace-nowrap"
                  >
                    {t("settings.webAccess.claimCount", {
                      count: claims.length,
                    })}
                  </Badge>
                </div>
                {claims.length === 0 ? (
                  <p className="mt-2 rounded-xl border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.webAccess.claimsEmpty")}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {claims.map((claim) => (
                      <ClaimRow
                        key={claim.claimId}
                        claim={claim}
                        nowMs={nowMs}
                        busy={busy}
                        busyTarget={busyTarget}
                        onApprove={(claim) => setApproveClaim(claim)}
                        onDeny={(claimId) => void deny(claimId)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {/* Paired devices */}
            <div className="rounded-lg border border-border/60 bg-card/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">
                  {t("settings.webAccess.devicesTitle")}
                </p>
                <Badge
                  variant={devices.length > 0 ? "secondary" : "muted"}
                  className="whitespace-nowrap"
                >
                  {devices.length}
                </Badge>
              </div>
              {devices.length === 0 ? (
                <p className="mt-2 rounded-xl border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.webAccess.devicesEmpty")}
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {devices.map((device) => {
                    const PlatformIcon = device.platform.startsWith("iPadOS")
                      ? Tablet
                      : device.platform.startsWith("iOS") ||
                          device.platform.startsWith("Android")
                        ? Smartphone
                        : Monitor;
                    return (
                      <li
                        key={device.sessionId}
                        className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card/60 p-3"
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <span
                            className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-background/70 text-muted-foreground"
                            aria-hidden
                          >
                            <PlatformIcon className="size-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="break-words text-sm font-semibold">
                                {displayDeviceName(device.deviceName, t)}
                              </p>
                              <Badge variant="outline" className="whitespace-nowrap">
                                {device.platform}
                              </Badge>
                            </div>
                            {device.sourceIp ? (
                              <p className="mt-1 font-mono text-xs leading-relaxed text-muted-foreground">
                                {t("settings.webAccess.deviceIp", {
                                  ip: device.sourceIp,
                                })}
                              </p>
                            ) : null}
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              {t("settings.webAccess.deviceLastActive", {
                                date: formatDateTime(device.lastActiveAtUnixMs, {
                                  year: "numeric",
                                  month: "short",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }),
                              })}
                            </p>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {t("settings.webAccess.deviceIssued", {
                                date: formatDateTime(device.issuedAtUnixMs, {
                                  year: "numeric",
                                  month: "short",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }),
                              })}
                            </p>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {t("settings.webAccess.deviceExpires", {
                                date: formatDateTime(device.expiresAtUnixMs, {
                                  year: "numeric",
                                  month: "short",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }),
                              })}
                            </p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="pill-danger"
                          size="pill-sm"
                          className="whitespace-nowrap"
                          aria-label={`${t("settings.webAccess.revoke")}: ${displayDeviceName(
                            device.deviceName,
                            t,
                          )}`}
                          disabled={busy !== null}
                          onClick={() => setRevokeDevice(device)}
                        >
                          {busy === "revoke" && busyTarget === device.sessionId ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <UserX className="size-3.5" />
                          )}
                          {t("settings.webAccess.revoke")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 rounded-xl border border-border/60 bg-secondary/40 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
                {t("settings.webAccess.devicesMemoryNote")}
              </p>
            </div>

            <p className="rounded-xl border border-border/60 bg-secondary/40 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
              {t("settings.webAccess.securityNote")}
            </p>
            <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[10.5px] leading-relaxed text-warning">
              {t("settings.webAccess.networkHint")}
            </p>
          </div>
        )}
        </SettingsSection>
      </div>

      {confirmStop ? (
        <ConfirmDialog
          title={t("settings.webAccess.stopConfirmTitle")}
          message={t("settings.webAccess.stopConfirmMessage")}
          confirmText={t("settings.webAccess.stop")}
          onConfirm={() => {
            setConfirmStop(false);
            void stop();
          }}
          onCancel={() => setConfirmStop(false)}
        />
      ) : null}

      {approveClaim ? (
        <ConfirmDialog
          title={t("settings.webAccess.approveConfirmTitle")}
          message={approveConfirmMessage}
          confirmText={t("settings.webAccess.approve")}
          tone="primary"
          onConfirm={onApproveConfirm}
          onCancel={() => setApproveClaim(null)}
        />
      ) : null}

      {revokeDevice ? (
        <ConfirmDialog
          title={t("settings.webAccess.revokeConfirmTitle")}
          message={t("settings.webAccess.revokeConfirmMessage", {
            name: displayDeviceName(revokeDevice.deviceName, t),
          })}
          confirmText={t("settings.webAccess.revoke")}
          onConfirm={onRevokeConfirm}
          onCancel={() => setRevokeDevice(null)}
        />
      ) : null}
    </>
  );
}
