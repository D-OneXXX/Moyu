import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  SettingRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import { toast, toastErr } from "@/components/Toast";
import {
  FEATURE_REGISTRY,
  featureDefinition,
  type FeatureDefinition,
  type FeatureFlags,
  type FeatureId,
} from "@/features/features";

export interface DeveloperFeaturePanelProps {
  features: FeatureFlags;
  busy: FeatureId | null;
  safeMode: boolean;
  resetting: boolean;
  onToggle: (feature: FeatureDefinition, enabled: boolean) => void;
  onReset: () => void;
}

/**
 * 内置开发者功能总控：9 项模块门卫的唯一可视入口。
 *
 * 只通过 `api.setFeatureEnabled` 写入；不使用会忽略 `features` 字段的
 * `set_settings`。切换后用后端返回的权威 Settings 刷新设置页与全局上下文。
 */
export default function DeveloperFeaturePanel({
  features,
  busy,
  safeMode,
  resetting,
  onToggle,
  onReset,
}: DeveloperFeaturePanelProps) {
  const { t } = useI18n();
  const enabledCount = FEATURE_REGISTRY.filter(
    (feature) => features[feature.settingKey],
  ).length;
  const locked = safeMode || busy !== null || resetting;

  return (
    <div>
      <SettingsSection
        icon={Wrench}
        title={t("developer.title")}
        description={t("developer.description")}
        action={
          <Badge variant="outline" className="shrink-0 whitespace-nowrap">
            {t("developer.badge")}
          </Badge>
        }
        summary={
          <div className="space-y-2" data-testid="developer-feature-summary">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="whitespace-nowrap tabular-nums">
                {t("developer.summary", { count: enabledCount })}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t("developer.openHint")}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("developer.warning")}
            </p>
          </div>
        }
        disclosure={{
          title: t("developer.title"),
          description: t("developer.description"),
          triggerLabel: t("developer.open"),
          triggerHint: t("developer.openHint"),
          width: "lg",
          testId: "developer-feature-open",
        }}
      >
        <div data-testid="developer-feature-panel" className="space-y-3">
          {safeMode ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning"
            >
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{t("developer.safeMode")}</span>
            </div>
          ) : null}

          <div className="space-y-2">
            {FEATURE_REGISTRY.map((feature) => {
              const enabled = features[feature.settingKey];
              return (
                <SettingRow
                  key={feature.id}
                  title={t(feature.titleKey)}
                  description={`${t(feature.descriptionKey)} · ${t(
                    feature.subsystemKey,
                  )}`}
                  badge={
                    <Badge variant={enabled ? "success" : "muted"}>
                      {enabled ? t("developer.gateOn") : t("developer.gateOff")}
                    </Badge>
                  }
                >
                  <Switch
                    checked={enabled}
                    disabled={locked}
                    data-testid={`developer-feature-${feature.id}`}
                    aria-label={`${t("developer.title")}: ${t(feature.titleKey)}`}
                    onCheckedChange={(next) => onToggle(feature, next)}
                  />
                </SettingRow>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-secondary/40 px-4 py-3">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              {t("developer.toggleHint")}
            </p>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="whitespace-nowrap"
              data-testid="developer-feature-reset"
              disabled={locked}
              onClick={onReset}
            >
              {resetting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="size-3.5" aria-hidden />
              )}
              {resetting ? t("developer.resetting") : t("developer.reset")}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

/**
 * 业务区域的可恢复停用条：不卸载入口、不发后端查询，只展示状态与一键启用。
 *
 * Settings 页传入 `onEnable` 以便把返回的权威 Settings 同步回表单；其它页面
 * 不传时直接调用 `setFeatureEnabled`，由 `mr-settings-changed` 通知全局上下文。
 */
export function FeatureDisabledNotice({
  feature,
  onEnable,
  className,
  actions,
}: {
  feature: FeatureId;
  onEnable?: () => Promise<boolean | void> | boolean | void;
  className?: string;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const definition = featureDefinition(feature);
  if (!definition) return null;

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = onEnable
        ? await onEnable()
        : ((await api.setFeatureEnabled(feature, true)), true);
      if (result === false) return;
      if (!onEnable) {
        toast(
          t("featureGate.enabledToast", {
            feature: t(definition.titleKey),
          }),
        );
      }
    } catch (error) {
      toastErr("set_feature_enabled", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid={`feature-disabled-${feature}`}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border bg-secondary/40 px-4 py-3",
        className,
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-hard-sm">
        <ShieldAlert className="size-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 break-words text-xs leading-5 text-muted-foreground">
        {t("featureGate.disabledBar", {
          feature: t(definition.titleKey),
        })}
      </p>
      {actions}
      <Button
        type="button"
        variant="pill-primary"
        size="pill-sm"
        className="whitespace-nowrap"
        data-testid={`feature-enable-${feature}`}
        disabled={busy}
        onClick={() => void enable()}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <ArrowRight className="size-3.5" aria-hidden />
        )}
        {busy ? t("featureGate.enabling") : t("featureGate.enable")}
      </Button>
    </div>
  );
}

/** 整页停用态：/browser 等独立路由使用，绝不挂载可能发 IPC 的业务组件。 */
export function FeatureDisabledPage({ feature }: { feature: FeatureId }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const definition = featureDefinition(feature);
  if (!definition) return null;
  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-10 sm:px-8"
      data-testid={`feature-disabled-page-${feature}`}
    >
      <div className="rounded-2xl border border-border bg-card p-6 shadow-hard">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
            <ShieldAlert className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold tracking-tight">
              {t("featureGate.pageTitle")}
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t("featureGate.pageBody")}
            </p>
          </div>
        </div>
        <div className="mt-5">
          <FeatureDisabledNotice
            feature={feature}
            actions={
              <Button
                type="button"
                variant="pill"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={() => navigate("/settings?tab=about")}
              >
                {t("featureGate.openDeveloper")}
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
