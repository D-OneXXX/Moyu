import { Check } from "lucide-react";
import { useI18n } from "@/i18n";
import type { TagInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface Props {
  tag: TagInfo;
  /** 可交互模式：按钮 + aria-pressed。 */
  selected?: boolean;
  onClick?: () => void;
  /** 卡片上的只读微胶囊。 */
  compact?: boolean;
  className?: string;
}

/**
 * 21-1 标签胶囊：颜色来自后端校验过的 #RRGGBB，只作为描边/底色与圆点，
 * 文字始终使用主题前景色，保证双主题对比度。
 */
export default function TagChip({
  tag,
  selected,
  onClick,
  compact,
  className,
}: Props) {
  const { t } = useI18n();
  const tint = tag.color
    ? {
        borderColor: tag.color,
        backgroundColor: selected ? `${tag.color}33` : undefined,
      }
    : undefined;
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          !tag.color && "bg-primary",
        )}
        style={tag.color ? { backgroundColor: tag.color } : undefined}
      />
      <span className="min-w-0 truncate">{tag.name}</span>
      {selected ? <Check className="size-3 shrink-0" strokeWidth={3} /> : null}
    </>
  );
  const base = cn(
    "inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card text-foreground",
    compact ? "h-5 max-w-24 px-1.5 text-[10px] font-semibold" : "h-8 max-w-52 px-2.5 text-xs font-semibold",
    onClick &&
      "outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    selected && !tag.color && "border-primary bg-primary/10",
    className,
  );
  if (!onClick) {
    return (
      <span
        className={base}
        style={tint}
        title={tag.name}
        aria-label={t("tags.cardAria") + `: ${tag.name}`}
      >
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={!!selected}
      onClick={onClick}
      className={base}
      style={tint}
      title={tag.name}
    >
      {content}
    </button>
  );
}
