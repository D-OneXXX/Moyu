/**
 * 系统级应用图标（桌面快捷方式 / 任务栏 / 托盘）的安装流程。
 *
 * 职责边界：
 * - 前端只做「把选择栅格化成 PNG」与「把自定义图片的原始字节交出去」；
 * - `.ico` 的多尺寸编码、`.lnk` 的 Shell Link 改写、桌面图标缓存刷新，
 *   以及运行中窗口与托盘图标的同步，全部由 Rust 完成；
 * - 主界面左上角的品牌标识不在此流程内，永远是 0.19.1 原版。
 */
import {
  api,
  type DesktopIconInput,
  type DesktopIconState,
} from "@/lib/tauri";
import { APP_ICON_SOURCE_SIZE, renderAppIconPng } from "./trayIcon";
import type { BrandIconSelection } from "./brandIcon";

/**
 * 安装当前选择：预设走栅格化通道，自定义图片把原始字节交给后端，
 * 由后端统一校验大小上限与魔数。
 */
export async function installAppIcon(
  selection: BrandIconSelection,
): Promise<DesktopIconState> {
  if (selection.kind === "custom") {
    return api.installDesktopIcon({
      kind: "custom",
      dataUrl: selection.dataUrl,
    });
  }
  const dataUrl = await renderAppIconPng(selection, APP_ICON_SOURCE_SIZE);
  if (!dataUrl) throw new Error("desktop-icon-render-failed");
  const input: DesktopIconInput = {
    kind: "preset",
    preset: selection.preset,
    dataUrl,
  };
  return api.installDesktopIcon(input);
}

/** 读取后端记录的安装状态（预设 / 自定义、`.ico` 路径、快捷方式列表）。 */
export function readAppIconState(): Promise<DesktopIconState> {
  return api.getDesktopIconState();
}

/** 清除自定义图标，快捷方式回落到 EXE 自带图标。 */
export function resetAppIcon(): Promise<DesktopIconState> {
  return api.resetDesktopIcon();
}
