import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useBrandIcon } from "@/features/brand/BrandIconProvider";
import type {
  BrandIconPreset,
  BrandIconSelection,
} from "@/features/brand/brandIcon";

/**
 * 主题驱动的品牌图标。
 *
 * 预设图标全部为项目原创内联 SVG，颜色来自 `--sh-*` / `--mi-*` token，
 * 因此深浅主题切换时不需要重新挂载；自定义图标以受控 data URL 展示。
 */

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
  book: BOOK_GLYPH,
  fish: FISH_GLYPH,
  moon: MOON_GLYPH,
  wave: WAVE_GLYPH,
};

interface AppBrandIconProps {
  /** 仅用于设置页预览；缺省时跟随全局偏好。 */
  selection?: BrandIconSelection;
  className?: string;
}

export default function AppBrandIcon({
  selection,
  className,
}: AppBrandIconProps) {
  const { selection: activeSelection } = useBrandIcon();
  const current = selection ?? activeSelection;

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
        fill="var(--mi-hard-shadow)"
      />
      <rect
        x="6"
        y="6"
        width="52"
        height="50"
        rx="16"
        fill="var(--sh-primary)"
        stroke="var(--sh-border)"
        strokeWidth="3"
      />
      {PRESET_GLYPHS[current.preset]}
    </svg>
  );
}
