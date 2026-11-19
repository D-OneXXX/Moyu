import { Clock, History, Layers, LayoutGrid, Star, Tags } from "lucide-react";
import { useI18n } from "@/i18n";
import type { TagInfo } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SourceFilter = "all" | "local" | "online";

/** 阅读状态快速筛选：与搜索、来源筛选、合集模式可叠加。 */
export type ReadingFilter = "all" | "unread" | "reading" | "finished";

/** 方案 C + 21-1：书库排序方式（全部由后端游标排序，前端不再重排）。 */
export type SortMode = "recentOpened" | "recentRead" | "favoritesFirst";

interface Props {
  sourceFilter: SourceFilter;
  onSourceFilterChange: (filter: SourceFilter) => void;
  readingFilter: ReadingFilter;
  onReadingFilterChange: (filter: ReadingFilter) => void;
  groupSeries: boolean;
  onGroupSeriesChange: (grouped: boolean) => void;
  sortMode: SortMode;
  onSortModeChange: (mode: SortMode) => void;
  /** 21-1：收藏与标签筛选。 */
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  tags: TagInfo[];
  tagId: number | null;
  onTagIdChange: (tagId: number | null) => void;
  onManageTags: () => void;
}

const CHIP =
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-4 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const CHIP_ON =
  "border-border bg-primary text-primary-foreground shadow-hard-sm";
const CHIP_OFF = "text-muted-foreground hover:bg-accent hover:text-foreground";

/** 来源分段胶囊 + 阅读状态 + 收藏/标签 + 合集/排序，全部保留可访问的 aria-pressed。 */
export default function LibraryFilters({
  sourceFilter,
  onSourceFilterChange,
  readingFilter,
  onReadingFilterChange,
  groupSeries,
  onGroupSeriesChange,
  sortMode,
  onSortModeChange,
  favoriteOnly,
  onFavoriteOnlyChange,
  tags,
  tagId,
  onTagIdChange,
  onManageTags,
}: Props) {
  const { t, formatNumber } = useI18n();
  const sourceOptions: { key: SourceFilter; label: string }[] = [
    { key: "all", label: t("common.all") },
    { key: "local", label: t("source.local") },
    { key: "online", label: t("source.online") },
  ];
  const readingOptions: { key: ReadingFilter; label: string }[] = [
    { key: "all", label: t("common.all") },
    { key: "unread", label: t("library.readingUnread") },
    { key: "reading", label: t("library.readingInProgress") },
    { key: "finished", label: t("library.readingFinished") },
  ];
  const tagItems = [
    { value: "all", label: t("tags.all") },
    ...tags.map((tag) => ({
      value: String(tag.id),
      label: `${tag.name} (${formatNumber(tag.bookCount)})`,
    })),
  ];

  return (
    <>
      <div
        role="group"
        aria-label={t("library.sourceFilterAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        {sourceOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={sourceFilter === option.key}
            onClick={() => onSourceFilterChange(option.key)}
            className={cn(
              CHIP,
              sourceFilter === option.key ? CHIP_ON : CHIP_OFF,
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div
        role="group"
        aria-label={t("library.readingFilterAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        {readingOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={readingFilter === option.key}
            onClick={() => onReadingFilterChange(option.key)}
            className={cn(
              CHIP,
              readingFilter === option.key ? CHIP_ON : CHIP_OFF,
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* 21-1：收藏 + 标签筛选（服务端筛选，跨分页也完整）。 */}
      <div
        role="group"
        aria-label={t("tags.filterAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        <button
          type="button"
          aria-pressed={favoriteOnly}
          onClick={() => onFavoriteOnlyChange(!favoriteOnly)}
          className={cn(CHIP, favoriteOnly ? CHIP_ON : CHIP_OFF)}
        >
          <Star
            className={cn("size-3.5", favoriteOnly && "fill-current")}
            strokeWidth={2}
          />
          {t("tags.favoriteOnly")}
        </button>
        <Select
          items={tagItems}
          value={tagId === null ? "all" : String(tagId)}
          onValueChange={(value) => {
            if (value === "all") {
              onTagIdChange(null);
              return;
            }
            const next = Number(value);
            onTagIdChange(Number.isFinite(next) && next > 0 ? next : null);
          }}
        >
          <SelectTrigger
            aria-label={t("tags.filterAria")}
            className="h-8 w-auto min-w-[7.5rem] max-w-48 rounded-full border-transparent bg-transparent px-3 text-xs font-semibold tabular-nums shadow-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tagItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="pill-ghost"
          size="pill-icon-sm"
          className="text-muted-foreground"
          aria-label={t("tags.manage")}
          title={t("tags.manageTitle")}
          onClick={onManageTags}
        >
          <Tags />
        </Button>
      </div>

      <div
        role="group"
        aria-label={t("library.groupAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        <button
          type="button"
          aria-pressed={groupSeries}
          onClick={() => onGroupSeriesChange(true)}
          title={t("library.groupSeriesTitle")}
          className={cn(CHIP, groupSeries ? CHIP_ON : CHIP_OFF)}
        >
          <Layers className="size-3.5" />
          {t("library.groupSeries")}
        </button>
        <button
          type="button"
          aria-pressed={!groupSeries}
          onClick={() => onGroupSeriesChange(false)}
          title={t("library.flatTitle")}
          className={cn(CHIP, groupSeries ? CHIP_OFF : CHIP_ON)}
        >
          <LayoutGrid className="size-3.5" />
          {t("library.flat")}
        </button>
      </div>

      <div
        role="group"
        aria-label={t("library.sortAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        <button
          type="button"
          aria-pressed={sortMode === "recentOpened"}
          onClick={() => onSortModeChange("recentOpened")}
          className={cn(CHIP, sortMode === "recentOpened" ? CHIP_ON : CHIP_OFF)}
        >
          <Clock className="size-3.5" />
          {t("library.sortRecentOpened")}
        </button>
        <button
          type="button"
          aria-pressed={sortMode === "recentRead"}
          onClick={() => onSortModeChange("recentRead")}
          className={cn(CHIP, sortMode === "recentRead" ? CHIP_ON : CHIP_OFF)}
        >
          <History className="size-3.5" />
          {t("library.sortRecentRead")}
        </button>
        <button
          type="button"
          aria-pressed={sortMode === "favoritesFirst"}
          onClick={() => onSortModeChange("favoritesFirst")}
          className={cn(
            CHIP,
            sortMode === "favoritesFirst" ? CHIP_ON : CHIP_OFF,
          )}
        >
          <Star
            className={cn(
              "size-3.5",
              sortMode === "favoritesFirst" && "fill-current",
            )}
          />
          {t("tags.sortFavoritesFirst")}
        </button>
      </div>
    </>
  );
}
