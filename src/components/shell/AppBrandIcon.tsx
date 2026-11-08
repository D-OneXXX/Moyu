/**
 * 主界面左上角的品牌标识。
 *
 * 这是 0.19.1 发布版的原版徽章：路径与配色逐字沿用该版本，固定不随主题
 * 漂移，也不提供任何替换入口。
 *
 * 边界（刻意与系统图标解耦）：
 * - 本组件只负责**主界面 UI 内部**的那一枚图标；
 * - 桌面快捷方式 / 任务栏 / 系统托盘的图标恒为随包构建资源
 *   （`src-tauri/icons/`），与本组件不联动、不互相同步；
 * - 两者是两套独立设计，任何一侧的变化都不应波及另一侧。
 */
export default function AppBrandIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-brand-icon="moyu"
      className={className ?? "size-8 shrink-0"}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="6" y="10" width="52" height="50" rx="16" fill="#09090B" />
      <rect
        x="6"
        y="6"
        width="52"
        height="50"
        rx="16"
        fill="#38A8F8"
        stroke="#09090B"
        strokeWidth="3"
      />
      <g fill="#FFFFFF" stroke="#09090B" strokeWidth="3" strokeLinejoin="round">
        <path d="M17 19C17 17.3431 18.3431 16 20 16H30C31.1046 16 32 16.8954 32 18V42C32 40.8954 31.1046 40 30 40H21L17 44V19Z" />
        <path d="M47 19C47 17.3431 45.6569 16 44 16H34C32.8954 16 32 16.8954 32 18V42C32 40.8954 32.8954 40 34 40H44C45.6569 40 47 38.6569 47 37V19Z" />
      </g>
    </svg>
  );
}
