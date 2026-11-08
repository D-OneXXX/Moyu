import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type {
  BrandIconPreset,
  BrandIconSelection,
} from "@/features/brand/brandIcon";

/**
 * 应用图标的展示组件（桌面 / 任务栏 / 托盘预设的预览）。
 *
 * 组件是纯展示的：图形完全由 `selection` 决定，不再读取任何偏好上下文。
 * 主界面左上角的品牌标识是 0.19.1 发布版的原版徽章，恒定渲染，
 * 不会被这里的任何偏好改写。
 */

/**
 * `moyu`：0.19.1 发布版左上角的原版徽章。
 * 路径与配色逐字沿用该版本（固定色，不随主题漂移）。
 */
const MOYU_GLYPH: ReactNode = (
  <g
    fill="#FFFFFF"
    stroke="#09090B"
    strokeWidth="3"
    strokeLinejoin="round"
  >
    <path d="M17 19C17 17.3431 18.3431 16 20 16H30C31.1046 16 32 16.8954 32 18V42C32 40.8954 31.1046 40 30 40H21L17 44V19Z" />
    <path d="M47 19C47 17.3431 45.6569 16 44 16H34C32.8954 16 32 16.8954 32 18V42C32 40.8954 32.8954 40 34 40H44C45.6569 40 47 38.6569 47 37V19Z" />
  </g>
);

const BOOK_GLYPH: ReactNode = (
  <g
    fill="var(--sh-primary-foreground)"
    stroke="var(--sh-border)"
    strokeWidth="2.6"
    strokeLinejoin="round"
  >
    <path d="M17 19C17 17.3431 18.3431 16 20 16H30C31.1046 16 32 16.8954 32 18V42C32 40.8954 31.1046 40 30 40H21L17 44V19Z" />
    <path d="M47 19C47 17.3431 45.6569 16 44 16H34C32.8954 16 32 16.8954 32 18V42C32 40.8954 32.8954 40 34 40H44C45.6569 40 47 38.6569 47 37V19Z" />
  </g>
);

const FISH_GLYPH: ReactNode = (
  <g
    fill="var(--sh-primary-foreground)"
    stroke="var(--sh-border)"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 32l9-7v14z" />
    <path d="M26 32c4-8 12-11 19-8 4 2 6 5 6 8s-2 6-6 8c-7 3-15 0-19-8Z" />
    <path d="M32 24c2-4 5-5 8-4" fill="none" />
    <circle cx="43" cy="30" r="2.2" fill="var(--sh-border)" stroke="none" />
    <circle cx="49" cy="21" r="1.6" fill="var(--sh-primary-foreground)" />
    <circle cx="52" cy="17" r="1.1" fill="var(--sh-primary-foreground)" />
  </g>
);

const MOON_GLYPH: ReactNode = (
  <g
    fill="var(--sh-primary-foreground)"
    stroke="var(--sh-border)"
    strokeWidth="2.6"
    strokeLinejoin="round"
  >
    <path d="M39 15c-10 2-17 10-17 20 0 8 5 14 13 17-4-4-6-9-6-15 0-9 4-17 12-21-1-1-1-1-2-1Z" />
    <path
      d="M46 20l1.4 4.2L52 26l-4.6 1.8L46 32l-1.4-4.2L40 26l4.6-1.8Z"
      fill="var(--sh-border)"
      stroke="none"
    />
  </g>
);

const WAVE_GLYPH: ReactNode = (
  <g
    fill="none"
    stroke="var(--sh-primary-foreground)"
    strokeWidth="3.6"
    strokeLinecap="round"
  >
    <path d="M18 26c4-4 8-4 12 0s8 4 12 0 8-4 12 0" />
    <path d="M18 35c4-4 8-4 12 0s8 4 12 0 8-4 12 0" />
    <path d="M18 44c4-4 8-4 12 0s8 4 12 0 8-4 12 0" />
  </g>
);

const PRESET_GLYPHS: Record<BrandIconPreset, ReactNode> = {
  moyu: MOYU_GLYPH,
  book: BOOK_GLYPH,
  fish: FISH_GLYPH,
  moon: MOON_GLYPH,
  wave: WAVE_GLYPH,
};

/** 徽章外框配色；`moyu` 用 0.19.1 的固定色，其余跟随主题 token。 */
const PRESET_FRAMES: Record<
  BrandIconPreset,
  { shadow: string; face: string; stroke: string }
> = {
  moyu: { shadow: "#09090B", face: "#38A8F8", stroke: "#09090B" },
  book: {
    shadow: "var(--mi-hard-shadow)",
    face: "var(--sh-primary)",
    stroke: "var(--sh-border)",
  },
  fish: {
    shadow: "var(--mi-hard-shadow)",
    face: "var(--sh-primary)",
    stroke: "var(--sh-border)",
  },
  moon: {
    shadow: "var(--mi-hard-shadow)",
    face: "var(--sh-primary)",
    stroke: "var(--sh-border)",
  },
  wave: {
    shadow: "var(--mi-hard-shadow)",
    face: "var(--sh-primary)",
    stroke: "var(--sh-border)",
  },
};

interface AppBrandIconProps {
  /** 要展示的图标；缺省即 0.19.1 原版徽章。 */
  selection?: BrandIconSelection;
  className?: string;
}

export default function AppBrandIcon({
  selection,
  className,
}: AppBrandIconProps) {
  const current = selection ?? { kind: "preset" as const, preset: "moyu" };

  if (current.kind === "custom") {
    return (
      <span
        aria-hidden="true"
        data-brand-icon="custom"
        className={cn(
          "grid size-8 shrink-0 place-items-center overflow-hidden rounded-2xl border-[3px] border-border bg-card shadow-hard",
          className,
        )}
      >
        <img
          src={current.dataUrl}
          alt=""
          draggable={false}
          className="size-full object-contain p-0.5"
        />
      </span>
    );
  }

  const frame = PRESET_FRAMES[current.preset];

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-brand-icon={current.preset}
      className={cn("size-8 shrink-0", className)}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="6"
        y="10"
        width="52"
        height="50"
        rx="16"
        fill={frame.shadow}
      />
      <rect
        x="6"
        y="6"
        width="52"
        height="50"
        rx="16"
        fill={frame.face}
        stroke={frame.stroke}
        strokeWidth="3"
      />
      {PRESET_GLYPHS[current.preset]}
    </svg>
  );
}
