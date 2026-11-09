import type { ReactNode } from "react";

/**
 * 皮肤画布层（Task 7 · 画框包裹式）。
 *
 * 整片窗口就是一张主题美术画布：背景层与画框层铺满 100vw × 100vh，
 * 内容视窗作为「内嵌视窗」放在画布上，视窗的四周自然露出画布美术——
 * 角色与插画就画在这圈画框上，与视窗严丝合缝。
 *
 * 两层装饰都是 `pointer-events: none` 的绝对定位层：不参与布局，
 * 也不可能拦截点击、滚动条拖拽或顶栏命中测试。
 */
export default function SkinCanvasFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mr-skin-canvas" data-testid="skin-canvas-frame">
      <div
        aria-hidden="true"
        className="mr-skin-backdrop"
        data-testid="skin-canvas-backdrop"
      />
      <div
        aria-hidden="true"
        className="mr-skin-frame"
        data-testid="skin-canvas-frame-overlay"
      />
      {children}
    </div>
  );
}
