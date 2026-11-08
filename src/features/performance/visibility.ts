/**
 * 主窗可见性（最小化 / 隐藏到托盘 / 切到后台）。
 *
 * 静默空闲态必须停止一切非必要工作：装饰性动画、ResizeObserver 重算、
 * 缩略图与页面解码请求。WebView2 在窗口最小化或 `window.hide()` 后会把
 * document 置为 `hidden`，因此这里以 `document.visibilityState` 为唯一真源：
 * 失焦但仍然可见时用户还在看画面，不能冻结。
 */
import { useEffect, useState } from "react";

/** 同步读取当前可见性（事件回调 / 非 React 代码用）。 */
export function isAppVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/** 订阅可见性变化；隐藏时返回 false。 */
export function useAppVisible(): boolean {
  const [visible, setVisible] = useState(isAppVisible);
  useEffect(() => {
    const sync = () => setVisible(isAppVisible());
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

/**
 * 全局标记：`html[data-app-hidden="true"]` 时 CSS 暂停所有装饰性动画，
 * 避免最小化状态下 PixelPet / spinner 继续跑帧烧 CPU。
 */
export function installVisibilityFlag(): void {
  if (typeof document === "undefined") return;
  const apply = () => {
    document.documentElement.dataset.appHidden = isAppVisible()
      ? "false"
      : "true";
  };
  apply();
  document.addEventListener("visibilitychange", apply);
}
