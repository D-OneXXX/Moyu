import { api } from "@/lib/tauri";
import { ONLINE_FEATURE } from "@/features/features";

/**
 * 「在线 URL 直读」的启用入口与错误识别。
 *
 * 背景：在线直读是一个**可选大功能**，关闭时后端命令返回稳定码
 * `feature-disabled`。前端在这类错误旁必须给出「立即开启」的下一步，
 * 否则用户只看到一句无法自解的死提示（v0.19.x 的回归就是这个）。
 */

/** 后端「功能未启用」稳定码。 */
export const FEATURE_DISABLED_CODE = "feature-disabled";

/** 错误里是否带「功能未启用」稳定码。 */
export function isFeatureDisabledError(error: unknown): boolean {
  return (
    typeof error === "string" && error.includes(FEATURE_DISABLED_CODE)
  );
}

/**
 * 立即开启在线直读。
 *
 * 成功后 `set_feature_enabled` 会同步 localStorage 镜像并广播
 * `mr-settings-changed`，因此各页面的 `isOnlineEnabled()` 读数立刻变 true，
 * 之后重试解析即可通过后端的功能门。
 */
export async function enableOnlineDirect(): Promise<boolean> {
  try {
    await api.setFeatureEnabled(ONLINE_FEATURE.id, true);
    return true;
  } catch {
    return false;
  }
}
