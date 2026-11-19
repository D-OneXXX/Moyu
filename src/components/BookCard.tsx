import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Check, Layers, Star } from "lucide-react";
import { useI18n } from "@/i18n";
import { api, type BookInfo } from "@/lib/tauri";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import TagChip from "@/components/library/TagChip";
import { cn } from "@/lib/utils";
import { readPagesRead, readProgressPercent } from "@/lib/progress";
import { useAppVisible } from "@/features/performance/visibility";

interface Props {
  book: BookInfo;
  /** 聚合卡片的同系列总话数（全局、未过滤口径）。 */
  seriesCount?: number;
  /** 多选模式：单击卡片 = 勾选，而不是打开详情。 */
  selectMode?: boolean;
  checked?: boolean;
  onToggleCheck?: (bookId: string) => void;
  /** 单击选中：传入封面矩形，便于上层做 shared-element。 */
  onSelect?: (bookId: string, originRect: DOMRect | null) => void;
  onOpen?: (bookId: string) => void;
  /** 源文件丢失：单击/双击/Enter 一律转去「重新指定位置」，绝不进入阅读。 */
  onMissing?: (bookId: string) => void;
  onContextMenu?: (e: React.MouseEvent, bookId: string) => void;
  /** 21-1：收藏星标（乐观更新由上层负责）。 */
  onToggleFavorite?: (bookId: string, favorite: boolean) => void;
  /** 延迟单击，留出双击判定窗口，避免详情 sheet 抢走第二次点击。 */
  deferSelect?: boolean;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * 冰蓝胶囊风格书卡：白色卡片 + 硬阴影 + 3:4 封面。
 * 单击详情、双击阅读、Shift+Enter 阅读；右键交给上层弹菜单。
 */
export default function BookCard({
  book,
  seriesCount,
  selectMode,
  checked,
  onToggleCheck,
  onSelect,
  onOpen,
  onMissing,
  onContextMenu,
  onToggleFavorite,
  deferSelect,
}: Props) {
  const { t, formatNumber } = useI18n();
  // 最小化/隐藏到托盘时暂停缩略图请求与解码（静默态零 IPC / 零解码）。
  const appVisible = useAppVisible();
  const [cover, setCover] = useState<string | null>(null);
  const [coverLoading, setCoverLoading] = useState(true);
  const [inView, setInView] = useState(false);
  const clickTimer = useRef<number>(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef("");
  const isSeries = !!book.seriesId && (seriesCount ?? 1) > 1;
  const missing = book.missing;

  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  // 封面缩略图只在卡片接近视口时才请求，避免大书库一次性打满 IPC + 解码。
  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // 主窗最小化/隐藏时不发缩略图请求、不解码；恢复可见后由 effect 重跑补上。
    if (!inView || !appVisible) return;
    if (loadedRef.current === book.id) return;
    let alive = true;
    let settled = false;
    loadedRef.current = book.id;
    setCover(null);
    setCoverLoading(true);
    const isPdf = book.format === "pdf";
    const finish = (dataUrl: string | null) => {
      if (!alive) return;
      settled = true;
      setCover(dataUrl);
      setCoverLoading(false);
    };
    api.getThumbnail(book.id, 512).then(
      (img) => finish(img.dataUrl),
      (error) => {
        if (!alive) return;
        // PDF：封面缺失不是错误——用 pdf.js 渲染首页并回写缓存。
        // 封面生成走模块级串行队列，整座书库同一时刻只开一份 PDF。
        // pdf 能力按需加载，不进入书卡片的首屏依赖图。
        if (isPdf) {
          void import("@/features/pdf").then(
            ({ ensurePdfCover, hasPdfErrorCode }) => {
              if (!alive) return;
              if (hasPdfErrorCode(error, "pdf-cover-missing")) {
                void ensurePdfCover(book.id).then(
                  (dataUrl) => finish(dataUrl),
                  () => finish(null),
                );
                return;
              }
              finish(null);
            },
            () => finish(null),
          );
          return;
        }
        finish(null);
      },
    );
    return () => {
      alive = false;
      // 被隐藏/卸载打断的请求不算“已加载”：恢复可见时允许重取（不留永久骨架）。
      if (!settled) loadedRef.current = "";
    };
  }, [book.id, book.format, inView, appVisible]);

  const pct = readProgressPercent(book.currentPage, book.pageCount);
  const readPages = readPagesRead(book.currentPage, book.pageCount);
  const totalPages = formatNumber(book.pageCount);
  const sub =
    readPages > 0
      ? t("card.readPages", {
          current: formatNumber(readPages),
          total: totalPages,
        })
      : t("card.notStarted", { total: totalPages });

  const clearPendingClick = () => {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = 0;
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    clearPendingClick();
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    // 源文件丢失：延迟到双击窗口之后再弹「重新指定位置」，
    // 避免第一次点击就把弹窗打开、第二次点击正好落在遮罩上把它关掉。
    if (missing) {
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = 0;
        onMissing?.(book.id);
      }, 240);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (deferSelect) {
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = 0;
        onSelect?.(book.id, rect);
      }, 240);
      return;
    }
    onSelect?.(book.id, rect);
  };

  const activate = (openReader: boolean) => {
    clearPendingClick();
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    if (missing) {
      onMissing?.(book.id);
      return;
    }
    if (openReader) onOpen?.(book.id);
    else onSelect?.(book.id, null);
  };

  const seriesLabel = isSeries
    ? t("card.seriesBadge", { count: formatNumber(seriesCount ?? 1) })
    : "";
  const ariaLabel = t("card.ariaLabel", {
    title: book.title,
    status:
      readPages > 0
        ? t("card.ariaStatusRead", {
            current: formatNumber(readPages),
            total: totalPages,
          })
        : t("card.ariaStatusNotStarted", { total: totalPages }),
    series: isSeries
      ? t("card.ariaSeries", { count: formatNumber(seriesCount ?? 1) })
      : "",
    online: book.sourceType !== "local" ? t("card.ariaOnline") : "",
    missing: missing ? t("card.ariaMissing") : "",
    hint: selectMode ? t("card.ariaHintSelect") : t("card.ariaHintOpen"),
  });

  return (
    <div
      ref={cardRef}
      className={cn(
        "group relative flex cursor-pointer select-none flex-col rounded-2xl border border-border bg-card p-2 shadow-card transition-all duration-200 ease-out hover:-translate-y-1 hover:shadow-hard",
        checked && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        FOCUS_RING,
      )}
      role="button"
      data-testid="library-card"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={selectMode ? !!checked : undefined}
      title={
        selectMode
          ? t("card.titleSelect", { title: book.title })
          : t("card.titleOpen", { title: book.title })
      }
      onClick={handleClick}
      onDoubleClick={() => {
        if (selectMode) return;
        clearPendingClick();
        if (missing) {
          onMissing?.(book.id);
          return;
        }
        onOpen?.(book.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate(e.shiftKey);
        } else if (e.key === " ") {
          e.preventDefault();
          activate(false);
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, book.id)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-border bg-muted">
        {coverLoading ? (
          <Skeleton className="absolute inset-0 rounded-xl" />
        ) : cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setCover(null)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <BookOpen className="size-7" strokeWidth={1.5} />
          </div>
        )}

        {selectMode && (
          <span
            className={cn(
              "absolute left-2 top-2 z-20 grid size-6 place-items-center rounded-full border-2 border-border shadow-hard-sm transition-colors",
              checked
                ? "bg-primary text-primary-foreground"
                : "bg-card/90 text-transparent",
            )}
            aria-hidden
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        )}

        {/* 21-1：收藏星标。未收藏时 hover/focus 浮现，已收藏常驻高亮；
            伪元素把热区扩到 >=44px，且 stopPropagation 不触发详情/阅读。 */}
        {!selectMode && (
          <button
            type="button"
            aria-pressed={book.isFavorite}
            aria-label={t(
              book.isFavorite ? "tags.favoriteAriaRemove" : "tags.favoriteAriaAdd",
              { title: book.title },
            )}
            title={t(
              book.isFavorite ? "tags.unfavoriteAction" : "tags.favoriteAction",
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleFavorite?.(book.id, !book.isFavorite);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute right-2 top-2 z-20 grid size-8 place-items-center rounded-full border border-border bg-card/95 shadow-hard-sm outline-none transition-all before:absolute before:-inset-1.5 before:content-[''] hover:scale-105 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              book.isFavorite
                ? "text-warning opacity-100"
                : "text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            <Star
              className={cn("size-4", book.isFavorite && "fill-current")}
              strokeWidth={2}
            />
          </button>
        )}

        {isSeries && (
          <Badge
            variant="outline"
            className="absolute bottom-2 left-2 z-10 max-w-[calc(100%_-_1rem)] border-border bg-card/90 px-2 py-0.5 text-[10px] font-semibold text-foreground shadow-hard-sm backdrop-blur-sm"
          >
            <Layers />
            <span className="min-w-0 truncate">{seriesLabel}</span>
          </Badge>
        )}

        {book.sourceType !== "local" && (
          <Badge
            variant="default"
            className={cn(
              "absolute right-2 z-10 shrink-0 whitespace-nowrap px-2 py-0.5 text-[10px] font-bold tracking-wide shadow-hard-sm",
              selectMode ? "top-2" : "top-11",
            )}
          >
            {t("source.url")}
          </Badge>
        )}

        {missing && (
          <Badge
            variant="warning"
            className="absolute bottom-2 right-2 z-10 max-w-[calc(100%_-_1rem)] border-border bg-warning/95 px-2 py-0.5 text-[10px] font-bold text-background shadow-hard-sm"
          >
            <AlertTriangle />
            <span className="min-w-0 truncate">{t("card.missing")}</span>
          </Badge>
        )}
      </div>

      <div className="min-w-0 px-1 pb-1 pt-2.5">
        <h3 className="truncate text-sm font-bold tracking-tight text-foreground">
          {book.title}
        </h3>
        <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
          {sub}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold tabular-nums text-muted-foreground">
            {t("card.progress", { percent: formatNumber(pct) })}
          </span>
        </div>

        {/* 21-1：最多 2 个标签微胶囊 + 余量提示。 */}
        {book.tags.length > 0 && (
          <div
            className="mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden"
            aria-label={t("tags.cardAria")}
          >
            {book.tags.slice(0, 2).map((tag) => (
              <TagChip key={tag.id} tag={tag} compact />
            ))}
            {book.tags.length > 2 && (
              <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold tabular-nums text-muted-foreground">
                {t("tags.more", { count: formatNumber(book.tags.length - 2) })}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
