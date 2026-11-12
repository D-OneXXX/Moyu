import { useEffect, useState } from "react";
import type { MessageKey } from "@/i18n";

/**
 * 可选大功能的唯一前端注册表。
 *
 * - 设置页「功能开关」卡片、入口判断、localStorage 镜像都从这里取值；
 * - 字段名与 Rust `FeatureFlags` / `FeatureId` 的 camelCase 表示一致；
 * - 默认值必须与 Rust `FeatureFlags::default` 保持同步。
 */
export interface FeatureFlags {
  webtoon: boolean;
  online: boolean;
  browser: boolean;
  pdf: boolean;
  opds: boolean;
  webAccess: boolean;
  updates: boolean;
  backup: boolean;
  diagnostics: boolean;
}

export type FeatureId = keyof FeatureFlags;

export interface FeatureDefinition {
  id: FeatureId;
  settingKey: FeatureId;
  mirrorKey: string;
  defaultEnabled: boolean;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  /** 开发者面板展示的关联子系统说明。 */
  subsystemKey: MessageKey;
}

/**
 * 「在线 URL 直读」开关。
 *
 * 它同时出现在「常规 → 功能开关」列表与「网络与在线源 → 在线 URL 直读」卡片里，
 * 两处共用**同一条持久化路径**（`set_feature_enabled`），因此不存在
 * “面板在另一个分区、用户找不到入口”的死胡同。
 */
export const ONLINE_FEATURE: FeatureDefinition = {
  id: "online",
  settingKey: "online",
  mirrorKey: "mr-feature-online",
  defaultEnabled: true,
  titleKey: "settings.online.enableTitle",
  descriptionKey: "settings.online.enableDescription",
  subsystemKey: "developer.subsystem.online",
};

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [
  {
    id: "webtoon",
    settingKey: "webtoon",
    mirrorKey: "mr-feature-webtoon",
    defaultEnabled: true,
    titleKey: "settings.experimental.webtoonTitle",
    descriptionKey: "settings.experimental.webtoonDescription",
    subsystemKey: "developer.subsystem.webtoon",
  },
  ONLINE_FEATURE,
  {
    id: "browser",
    settingKey: "browser",
    mirrorKey: "mr-feature-browser",
    defaultEnabled: true,
    titleKey: "nav.browser",
    descriptionKey: "settings.features.browser.description",
    subsystemKey: "developer.subsystem.browser",
  },
  {
    id: "pdf",
    settingKey: "pdf",
    mirrorKey: "mr-feature-pdf",
    defaultEnabled: true,
    titleKey: "settings.features.pdf.title",
    descriptionKey: "settings.features.pdf.description",
    subsystemKey: "developer.subsystem.pdf",
  },
  {
    id: "opds",
    settingKey: "opds",
    mirrorKey: "mr-feature-opds",
    defaultEnabled: true,
    titleKey: "opds.settings.title",
    descriptionKey: "opds.settings.description",
    subsystemKey: "developer.subsystem.opds",
  },
  {
    id: "webAccess",
    settingKey: "webAccess",
    mirrorKey: "mr-feature-web-access",
    defaultEnabled: true,
    titleKey: "settings.webAccess.title",
    descriptionKey: "settings.webAccess.description",
    subsystemKey: "developer.subsystem.webAccess",
  },
  {
    id: "updates",
    settingKey: "updates",
    mirrorKey: "mr-feature-updates",
    defaultEnabled: true,
    titleKey: "updates.title",
    descriptionKey: "updates.description",
    subsystemKey: "developer.subsystem.updates",
  },
  {
    id: "backup",
    settingKey: "backup",
    mirrorKey: "mr-feature-backup",
    defaultEnabled: true,
    titleKey: "settings.backup.title",
    descriptionKey: "settings.backup.description",
    subsystemKey: "developer.subsystem.backup",
  },
  {
    id: "diagnostics",
    settingKey: "diagnostics",
    mirrorKey: "mr-feature-diagnostics",
    defaultEnabled: true,
    titleKey: "support.title",
    descriptionKey: "support.description",
    subsystemKey: "developer.subsystem.diagnostics",
  },
];

export function featureDefinition(id: FeatureId): FeatureDefinition | undefined {
  return FEATURE_REGISTRY.find((item) => item.id === id);
}

const LEGACY_MIRRORS: Partial<Record<FeatureId, string>> = {
  online: "mr-exp-online",
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.fromEntries(
  FEATURE_REGISTRY.map((feature) => [feature.id, feature.defaultEnabled]),
) as unknown as FeatureFlags;

/**
 * 后端返回的权威功能开关快照（进程内存，不落 localStorage）。
 *
 * `get_settings` / `set_settings` / `set_feature_enabled` 成功后都会刷新它，
 * 因此业务组件在挂载前读取的就是“内存里的 settings.features”，不必等异步
 * IPC，也不会把上一轮 localStorage 镜像当成最新状态。未加载前才回落到镜像
 * 与默认值，保证首屏仍可同步渲染。
 */
let liveFeatures: FeatureFlags | null = null;

export function setLiveFeatureFlags(flags: FeatureFlags | null): void {
  liveFeatures = flags ? { ...flags } : null;
}

/** 已加载的权威快照；启动早期为 null。 */
export function readLiveFeatureFlags(): FeatureFlags | null {
  return liveFeatures ? { ...liveFeatures } : null;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function isFeatureEnabled(id: FeatureId): boolean {
  if (liveFeatures) return liveFeatures[id] === true;
  const feature = FEATURE_REGISTRY.find((item) => item.id === id);
  if (!feature) return false;
  const raw = readRaw(feature.mirrorKey);
  if (raw === "0" || raw === "1") return raw === "1";
  const legacyKey = LEGACY_MIRRORS[id];
  if (legacyKey) {
    const legacy = readRaw(legacyKey);
    if (legacy === "0" || legacy === "1") return legacy === "1";
  }
  // 条漫旧镜像不可信：旧版本从未真正接线，缺省保持开启。
  return feature.defaultEnabled;
}

export function readFeatureFlags(): FeatureFlags {
  if (liveFeatures) return { ...liveFeatures };
  return Object.fromEntries(
    FEATURE_REGISTRY.map((feature) => [feature.id, isFeatureEnabled(feature.id)]),
  ) as unknown as FeatureFlags;
}

export function emitFeaturesChanged(): void {
  window.dispatchEvent(new CustomEvent("mr-settings-changed"));
}

function subscribeFeatureSync(sync: () => void): () => void {
  window.addEventListener("mr-settings-changed", sync);
  window.addEventListener("mr-settings-updated", sync);
  return () => {
    window.removeEventListener("mr-settings-changed", sync);
    window.removeEventListener("mr-settings-updated", sync);
  };
}

export function useFeatureEnabled(id: FeatureId): boolean {
  const [enabled, setEnabled] = useState(() => isFeatureEnabled(id));
  useEffect(() => {
    const sync = () => setEnabled(isFeatureEnabled(id));
    sync();
    return subscribeFeatureSync(sync);
  }, [id]);
  return enabled;
}

export function useFeatureFlags(): FeatureFlags {
  const [flags, setFlags] = useState(readFeatureFlags);
  useEffect(() => {
    const sync = () => setFlags(readFeatureFlags());
    sync();
    return subscribeFeatureSync(sync);
  }, []);
  return flags;
}
