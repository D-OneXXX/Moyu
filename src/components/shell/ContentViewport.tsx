import type { ReactNode } from "react";

/**
 * 内容视窗（Task 7 · 画框包裹式）。
 *
 * 内缩边距由 `--mr-skin-viewport-inset`（top right bottom left）控制：
 * 极简模式是 `0px`，全屏铺满；启用画框皮肤时自动收缩，让出外围画框，
 * 同时获得圆角、毛玻璃底色与画框投影。
 *
 * 沉浸式阅读路由不会挂载这一层（视窗不存在），阅读面天然是全屏无边距。
 */
export default function ContentViewport({ children }: { children: ReactNode }) {
  return (
    <div className="mr-skin-viewport" data-testid="content-viewport">
      {children}
    </div>
  );
}
