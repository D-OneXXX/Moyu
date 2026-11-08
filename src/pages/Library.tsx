import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookMarked,
  BookOpen,
  BookX,
  Check,
  Cloud,
  FolderPlus,
  ListChecks,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useI18n, translate } from "@/i18n";
import { useDropImport } from "@/features/import/DropImportProvider";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";
import { recordBreadcrumb } from "@/features/resilience";
import { useAppVisible, isAppVisible } from "@/features/performance/visibility";
import {
  api,
  type BookInfo,
  type Dashboard,
  type LibraryStats,
} from "@/lib/tauri";
import { sourceDisplay } from "@/lib/sourceDisplay";
import { LIBRARY_REFRESH_EVENT } from "@/lib/events";
import { libraryWindow } from "@/lib/libraryWindow";
import { Button } from "@/components/ui/button";
import BookCard from "@/components/BookCard";
import BookDetailSheet from "@/components/BookDetailSheet";
import ContextMenu from "@/components/ContextMenu";
import ConfirmDialog from "@/components/ConfirmDialog";
import ErrorState from "@/components/ErrorState";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";
import { localizeBackendError } from "@/features/errors/localize";
import {
  isFeatureEnabled,
  useFeatureEnabled,
} from "@/features/features";
import LibraryFilters, {
  type SortMode,
  type SourceFilter,
} from "@/components/library/LibraryFilters";
import LibrarySearch from "@/components/library/LibrarySearch";
import LibrarySelectionBar from "@/components/library/LibrarySelectionBar";
import LibrarySkeleton from "@/components/library/LibrarySkeleton";
import RelocateDialog from "@/components/library/RelocateDialog";
import OpdsBrowserDialog from "@/components/library/OpdsBrowserDialog";

const GROUP_KEY = "mr-library-group-series";
const FILTER_KEY = "mr-library-source-filter";
/** ADR-018：书库分页每页 60 本；DOM 只渲染视口附近的行。 */
const PAGE_SIZE = 60;
/** 网格列间距（与 grid gap-4 一致）与卡片非封面部分的估算高度。 */
const GRID_GAP = 16;
const CARD_CHROME = 88;
const FALLBACK_ROW_HEIGHT = 320;
/** 视口上下各多渲染的行数，吸收行高估算误差与快速滚动。 */
const OVERSCAN_ROWS = 3;

interface CtxMenuState {
  x: number;
  y: number;
  bookId: string;
}

function readGrouping(): boolean {
  try {
    const raw = localStorage.getItem(GROUP_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* 忽略隐私模式下的存储异常 */
  }
  return true;
}

function readSourceFilter(): SourceFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw === "all" || raw === "local" || raw === "online") return raw;
  } catch {
    /* 忽略 */
  }
  return "all";
}

/** 后端中文详情只在中文界面直出；其余语言走稳定码/泛化本地化。 */
function notifyError(cmd: string, error: unknown): void {
  toastErr(cmd, error);
}

/**
 * 书库主页（`/`）— 冰蓝胶囊浅色画布：
 * 大标题 + 胶囊搜索 + 分段筛选 + 书卡网格 + 详情 Sheet。
 * 导入、拖放、多选、右键菜单与在线直读门控保持既有行为。
 */
export default function LibraryPage() {
  const nav = useNavigate();
  const ws = useWorkspace();
  const { t, locale, formatNumber } = useI18n();
  const { active: safeMode } = useSafeMode();
  const opdsEnabled = useFeatureEnabled("opds");
  // 最小化/隐藏时跳过网格度量重算，恢复可见后重算一次。
  const appVisible = useAppVisible();
  const [groupSeries, setGroupSeries] = useState(readGrouping);
  // 方案 C：默认「最近打开」（后端按 last_opened_at 排序）；可切「最近阅读」。
  const [sortMode, setSortMode] = useState<SortMode>("recentOpened");
  const [sourceFilter, setSourceFilter] = useState(readSourceFilter);
  const [dash, setDash] = useState<Dashboard | null>(null);
  // ADR-032：后端聚合的合集计数；命令失败时为 null，回落本地已加载页计数。
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [allBooks, setAllBooks] = useState<BookInfo[]>([]);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // ADR-018 分页游标：null 表示已到末页；search 变化时 reload 覆盖为首页游标。
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  /** 查询代际：搜索/刷新期间到达的过期分页响应一律丢弃。 */
  const loadSeqRef = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  // 窗口化：滚动位置 + 网格列数/单行高度（ResizeObserver 实测宽度估算）。
  const gridRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, viewport: 600 });
  const [metrics, setMetrics] = useState({
    columns: 2,
    rowHeight: FALLBACK_ROW_HEIGHT,
  });

  // 详情 Sheet：保留书籍快照，列表刷新时用最新数据覆盖展示。
  const [selectedBook, setSelectedBook] = useState<BookInfo | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 远程书库（OPDS）：只读目录，下载后进入现有阅读管线。
  const [opdsOpen, setOpdsOpen] = useState(false);
  // 失效路径重定位引导（不进入 Reader，先让用户重新指定位置）。
  const [relocatingBook, setRelocatingBook] = useState<BookInfo | null>(null);

  // 多选 + 右键菜单 + 删除确认
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BookInfo[] | null>(null);

  // 导入由应用级 Provider 统一管理：任意页面拖放都可用，单飞锁跨路由生效。
  const { importPaths, importing } = useDropImport();

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_KEY, groupSeries ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  }, [groupSeries]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, sourceFilter);
    } catch {
      /* 忽略 */
    }
  }, [sourceFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const reload = useCallback(async (q: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    try {
      const [d, page, libraryStats] = await Promise.all([
        api.getDashboard(),
        api.listBooksPage(
          q.length > 0
            ? { query: q, limit: PAGE_SIZE }
            : { limit: PAGE_SIZE },
        ),
        // ADR-032：合集计数走一次分组聚合，搜索态不再取全库列表。
        api.libraryStats().catch(() => null),
      ]);
      // 慢请求晚到：直接丢弃，绝不覆盖更新的搜索结果。
      if (seq !== loadSeqRef.current) return;
      setDash(d);
      setBooks(page.items);
      setCursor(page.nextCursor);
      setStats(libraryStats);
      setAllBooks(page.items);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(localizeBackendError(e));
      notifyError("list_books_page", e);
      setCursor(null);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(debounced);
  }, [debounced, reload]);

  // 卸载即作废在途请求，避免组件销毁后仍写入状态。
  useEffect(() => () => {
    loadSeqRef.current += 1;
  }, []);

  // 协同配对回传导入完成 / 其他页面触发刷新。
  useEffect(() => {
    const refresh = () => void reload(debounced);
    window.addEventListener(LIBRARY_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_REFRESH_EVENT, refresh);
  }, [debounced, reload]);

  const visibleBooks = useMemo(() => {
    const localOnly = safeMode
      ? books.filter((book) => book.sourceType === "local")
      : books;
    const filtered =
      sourceFilter === "all"
        ? localOnly
        : localOnly.filter(
            (book) =>
              (book.sourceType === "local") === (sourceFilter === "local"),
          );
    // 方案 C：后端默认按「最近打开」（last_opened_at）排序；
    // 「最近阅读」需要按 updated_at 重排（后端只提供一种顺序）。
    if (sortMode !== "recentRead") return filtered;
    return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [books, sourceFilter, safeMode, sortMode]);

  const accessibleAllBooks = useMemo(
    () =>
      safeMode
        ? allBooks.filter((book) => book.sourceType === "local")
        : allBooks,
    [allBooks, safeMode],
  );

  // ADR-032：合集计数优先用后端聚合映射（全局口径，搜索/筛选不改变总话数）；
  // `safeMode` 取全局本地口径 `localSeriesCounts`。命令不可用时回落到
  // 已加载页的本地计数，保证旧后端/离线仍能显示。
  const seriesCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const remote = stats
      ? safeMode
        ? stats.localSeriesCounts
        : stats.seriesCounts
      : null;
    if (remote) {
      // 后端已把 series_id trim 并丢弃空白键，这里直接按映射取值。
      for (const [sid, count] of Object.entries(remote)) counts.set(sid, count);
      return counts;
    }
    for (const book of accessibleAllBooks) {
      const sid = book.seriesId?.trim();
      if (sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
    return counts;
  }, [stats, safeMode, accessibleAllBooks]);

  const displayBooks = useMemo(() => {
    if (!groupSeries) {
      return visibleBooks.map((book) => {
        const sid = book.seriesId?.trim();
        return { book, seriesCount: sid ? seriesCounts.get(sid) ?? 1 : 1 };
      });
    }

    // 方案 C：代表卡取「当前排序键最大」的那本——最近打开模式看
    // lastOpenedAt，最近阅读模式看 updatedAt。
    const rank = (b: BookInfo) =>
      sortMode === "recentRead" ? b.updatedAt : b.lastOpenedAt || b.updatedAt;
    const groups = new Map<string, { book: BookInfo; filteredCount: number }>();
    for (const book of visibleBooks) {
      const sid = book.seriesId?.trim();
      const key = sid ? `series:${sid}` : `book:${book.id}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { book, filteredCount: 1 });
      } else {
        existing.filteredCount += 1;
        if (rank(book) > rank(existing.book)) existing.book = book;
      }
    }
    return [...groups.entries()].map(([key, group]) => {
      const sid = key.startsWith("series:") ? key.slice("series:".length) : "";
      return {
        book: group.book,
        seriesCount: sid ? seriesCounts.get(sid) ?? group.filteredCount : 1,
      };
    });
  }, [visibleBooks, groupSeries, sortMode, seriesCounts]);

  // 追加下一页：游标驱动，search 重置由 reload 完成；loadingMoreRef 防止
  // 哨兵在单页在途期间重复触发。
  const loadNextPage = useCallback(async () => {
    if (cursor === null || loadingMoreRef.current) return;
    const seq = loadSeqRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await api.listBooksPage({
        query: debounced.length > 0 ? debounced : null,
        cursor,
        limit: PAGE_SIZE,
      });
      // 期间发生过搜索/刷新：这一页属于旧查询，追加会污染新列表。
      if (seq !== loadSeqRef.current) return;
      setBooks((prev) => [...prev, ...page.items]);
      // ADR-032：`allBooks` 统一为「已加载页」累积（搜索态也只累积搜索页）。
      setAllBooks((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (seq === loadSeqRef.current) notifyError("list_books_page", e);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [cursor, debounced]);

  // 网格列数与单行高度：ResizeObserver 读实际宽度，按 3:4 封面估算行高；
  // overscan 吸收估算误差，避免硬编码响应式断点。
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // 主窗最小化/隐藏时不读 computedStyle、不重算行高（静默态零布局抖动）。
      if (!isAppVisible()) return;
      const cols = Math.max(
        1,
        getComputedStyle(grid)
          .gridTemplateColumns.split(" ")
          .filter(Boolean).length,
      );
      const cardW = (grid.clientWidth - (cols - 1) * GRID_GAP) / cols;
      const rowH = cardW * (4 / 3) + CARD_CHROME + GRID_GAP;
      setMetrics({
        columns: cols,
        rowHeight: rowH > 0 ? rowH : FALLBACK_ROW_HEIGHT,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    measure();
    return () => observer.disconnect();
  }, [displayBooks.length, loading, loadError, appVisible]);

  // 滚动位置：AppShell 的 <main> 是真实滚动容器，向上查找最近的
  // overflow-y 容器；rAF 节流，避免每个 scroll 事件都同步 setState。
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let scroller: HTMLElement | null = grid.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      scroller = scroller.parentElement;
    }
    const scrollTarget: EventTarget = scroller ?? window;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const gridTop = grid.getBoundingClientRect().top;
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          setScroll({
            top: Math.max(0, rect.top - gridTop),
            viewport: scroller.clientHeight,
          });
        } else {
          setScroll({
            top: Math.max(0, -gridTop),
            viewport: window.innerHeight,
          });
        }
      });
    };
    scrollTarget.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [displayBooks.length, loading, loadError]);

  const rowCount = Math.ceil(displayBooks.length / metrics.columns);
  const { start, end } = libraryWindow(
    scroll.top,
    scroll.viewport,
    metrics.rowHeight,
    OVERSCAN_ROWS,
    rowCount,
  );
  const itemStart = start * metrics.columns;
  const itemEnd = Math.min(displayBooks.length, end * metrics.columns);
  const windowedBooks = useMemo(
    () => displayBooks.slice(itemStart, itemEnd),
    [displayBooks, itemStart, itemEnd],
  );

  const hasMore = cursor !== null;

  // 底部哨兵接近视口时自动追加下一页；按钮仍保留为键盘/读屏的显式入口。
  useEffect(() => {
    if (!hasMore || loading) return;
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadNextPage();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadNextPage]);

  const checkedBooks = useMemo(
    () => visibleBooks.filter((book) => checkedIds.has(book.id)),
    [visibleBooks, checkedIds],
  );
  const checkedHasLocal = checkedBooks.some((book) => book.sourceType === "local");
  const checkedHasOnline = checkedBooks.some((book) => book.sourceType !== "local");
  const batchDeleteLabel =
    checkedHasLocal && checkedHasOnline
      ? t("library.deleteMixed")
      : checkedHasOnline
        ? t("library.deleteOnline")
        : t("library.deleteLocal");

  // 搜索/来源筛选变化后，已勾选但不再可见的书不应继续留在批量集合里。
  useEffect(() => {
    setCheckedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(
        [...prev].filter((id) =>
          visibleBooks.some((book) => book.id === id),
        ),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [visibleBooks]);

  // 选中的书从刷新结果里消失（被删除/查询变化）时关闭详情 Sheet。
  useEffect(() => {
    if (!selectedBook || loading) return;
    if (!visibleBooks.some((book) => book.id === selectedBook.id)) {
      setSheetOpen(false);
      setSelectedBook(null);
    }
  }, [visibleBooks, selectedBook, loading]);

  const sheetBook = useMemo(() => {
    if (!selectedBook) return null;
    return (
      books.find((book) => book.id === selectedBook.id) ??
      allBooks.find((book) => book.id === selectedBook.id) ??
      selectedBook
    );
  }, [books, allBooks, selectedBook]);

  const detailSeriesBooks = useMemo(() => {
    const sid = selectedBook?.seriesId?.trim();
    if (!sid) return undefined;
    const list = accessibleAllBooks.filter((book) => book.seriesId?.trim() === sid);
    if (list.length === 0) return undefined;
    return [...list].sort((a, b) => {
      const ai = a.chapterIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.chapterIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return (
        a.title.localeCompare(b.title, locale, {
          numeric: true,
          sensitivity: "base",
        }) || a.updatedAt.localeCompare(b.updatedAt)
      );
    });
  }, [accessibleAllBooks, selectedBook, locale]);

  const commitSearch = useCallback(() => {
    setDebounced(query.trim());
  }, [query]);

  const openDetail = useCallback((book: BookInfo) => {
    setSelectedBook(book);
    setSheetOpen(true);
  }, []);

  const findBook = useCallback(
    (bookId: string) =>
      books.find((item) => item.id === bookId) ??
      allBooks.find((item) => item.id === bookId) ??
      null,
    [books, allBooks],
  );

  const openRelocate = useCallback((book: BookInfo) => {
    setSheetOpen(false);
    setSelectedBook(null);
    setRelocatingBook(book);
  }, []);

  const onCardSelect = useCallback(
    (bookId: string) => {
      const book = findBook(bookId);
      if (!book) return;
      if (book.missing) {
        openRelocate(book);
        return;
      }
      openDetail(book);
    },
    [findBook, openDetail, openRelocate],
  );

  const openReader = useCallback(
    (bookId: string, page?: number) => {
      const book = findBook(bookId);
      if (book?.missing) {
        openRelocate(book);
        return;
      }
      setSheetOpen(false);
      // BookDetailSheet 契约：page 为 1-based 页码，直接映射到 Reader 的 ?page=。
      const suffix =
        typeof page === "number" && Number.isFinite(page)
          ? `?page=${Math.max(1, Math.round(page))}`
          : "";
      nav(`/reader/${encodeURIComponent(bookId)}${suffix}`);
    },
    [findBook, nav, openRelocate],
  );

  const onRelocated = useCallback(
    (updated: BookInfo) => {
      const previousId = relocatingBook?.id;
      if (previousId) ws.replaceTab(previousId, updated.id);
      setRelocatingBook(null);
      toast(t("relocate.success", { title: updated.title }));
      void reload(debounced);
      // 重定位是用户显式动作：直接进入阅读器，后端已保留原进度。
      nav(`/reader/${encodeURIComponent(updated.id)}`);
    },
    [debounced, nav, reload, relocatingBook, t, ws],
  );

  const toggleCheck = useCallback((bookId: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setCheckedIds(new Set());
  }, []);

  const toggleSelectMode = useCallback(() => {
    if (selectMode) {
      exitSelectMode();
      return;
    }
    setSheetOpen(false);
    setSelectMode(true);
  }, [selectMode, exitSelectMode]);

  // 添加文件：文件对话框（zip / cbz / pdf 多选）→ 每个压缩包或 PDF = 一本书。
  const onAddFiles = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        title: translate("import.filesTitle"),
        filters: [
          {
            name: translate("import.filesFilter"),
            extensions: ["zip", "cbz", "pdf"].filter(
              (ext) => ext !== "pdf" || isFeatureEnabled("pdf"),
            ),
          },
        ],
      });
      const paths =
        typeof picked === "string"
          ? [picked]
          : Array.isArray(picked)
            ? picked
            : [];
      if (paths.length > 0) recordBreadcrumb("archiveImport");
      await importPaths(paths);
    } catch {
      toast(translate("import.pickerUnavailable"));
    }
  }, [importPaths]);

  // 添加文件夹：目录对话框（可多选）→ 选中的文件夹内容构成一本书。
  const onAddFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: true,
        title: translate("import.folderTitle"),
      });
      const paths =
        typeof picked === "string"
          ? [picked]
          : Array.isArray(picked)
            ? picked
            : [];
      if (paths.length > 0) recordBreadcrumb("folderImport");
      await importPaths(paths);
    } catch {
      toast(translate("import.folderPickerUnavailable"));
    }
  }, [importPaths]);

  /* ---------- 移除记录 / 删除源文件（语义与旧版完全一致） ---------- */
  const doRemove = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      try {
        const result = await api.removeBooks(ids, false);
        toast(
          translate("library.removed", {
            count: formatNumber(result.removed),
          }),
        );
        if (selectedBook && ids.includes(selectedBook.id)) {
          setSheetOpen(false);
          setSelectedBook(null);
        }
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        notifyError("remove_books", e);
      }
    },
    [debounced, formatNumber, reload, selectedBook],
  );

  const onRemoveMissing = useCallback(
    (book: BookInfo) => {
      setRelocatingBook(null);
      void doRemove([book.id]);
    },
    [doRemove],
  );

  const doDelete = useCallback(
    async (targets: BookInfo[]) => {
      if (targets.length === 0) return;
      const ids = targets.map((book) => book.id);
      const onlineCount = targets.filter(
        (book) => book.sourceType !== "local",
      ).length;
      const localCount = targets.length - onlineCount;
      try {
        const result = await api.removeBooks(ids, true);
        if (result.errors.length > 0) {
          notifyError("remove_books", result.errors[0]);
        }
        if (onlineCount > 0 && localCount === 0) {
          toast(
            translate("library.deletedOnlineOnly", {
              count: formatNumber(onlineCount),
            }),
          );
        } else if (onlineCount > 0) {
          toast(
            translate("library.deletedMixed", {
              files: formatNumber(result.deletedFiles),
              count: formatNumber(onlineCount),
            }),
          );
        } else {
          toast(
            result.deletedFiles > 0
              ? translate("library.deletedLocal", {
                  files: formatNumber(result.deletedFiles),
                })
              : translate("library.deletedNone"),
          );
        }
        if (selectedBook && ids.includes(selectedBook.id)) {
          setSheetOpen(false);
          setSelectedBook(null);
        }
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        notifyError("remove_books", e);
      }
    },
    [debounced, formatNumber, reload, selectedBook],
  );

  const doDeleteConfirmed = useCallback(async () => {
    const targets = confirmDelete;
    setConfirmDelete(null);
    if (!targets || targets.length === 0) return;
    await doDelete(targets);
  }, [confirmDelete, doDelete]);

  const ctxBook = ctxMenu
    ? books.find((book) => book.id === ctxMenu.bookId) ??
      allBooks.find((book) => book.id === ctxMenu.bookId) ??
      null
    : null;

  const deleteTargets = confirmDelete;
  const deletePages =
    deleteTargets?.reduce((total, book) => total + book.pageCount, 0) ?? 0;
  const deleteLocal =
    deleteTargets?.filter((book) => book.sourceType === "local") ?? [];
  const deleteOnline =
    deleteTargets?.filter((book) => book.sourceType !== "local") ?? [];
  const deleteMixed = deleteLocal.length > 0 && deleteOnline.length > 0;

  const totalBooks = safeMode
    ? accessibleAllBooks.length
    : dash?.totalBooks ?? stats?.totalBooks ?? allBooks.length;
  const readingCount = dash?.reading ?? 0;
  const todayPages = dash?.todayPages ?? 0;
  const emptyMessage =
    debounced.length > 0
      ? t("library.emptySearch")
      : sourceFilter !== "all"
        ? t("library.emptyFilter")
        : t("library.emptyLibrary");

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1500px] px-5 pb-24 pt-4 sm:px-8">
      <header className="flex w-full min-w-0 flex-col gap-5">
        {safeMode ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-border bg-secondary px-4 py-3 shadow-hard-sm"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-warning text-background shadow-hard-sm">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-extrabold">{t("safeMode.libraryNoticeTitle")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("safeMode.libraryNoticeBody")}
              </p>
            </div>
          </div>
        ) : null}
        <div className="flex w-full min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              {t("nav.library")}
            </h1>
            <p className="mt-1.5 text-sm tabular-nums text-muted-foreground">
              {t("library.summary", {
                total: formatNumber(totalBooks),
                reading: formatNumber(readingCount),
                today: formatNumber(todayPages),
              })}
            </p>
          </div>

          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {/* 本地导入唯一入口对：导入文件夹 / 导入压缩包（另支持整窗拖拽）。 */}
            <Button
              variant="pill-primary"
              size="pill"
              onClick={() => void onAddFolder()}
              title={t("library.addFolderTitle")}
              disabled={importing !== null}
            >
              <FolderPlus />
              {t("library.addFolder")}
            </Button>
            <Button
              variant="pill"
              size="pill"
              onClick={() => void onAddFiles()}
              title={t("library.addBooksTitle")}
              disabled={importing !== null}
            >
              <Plus />
              {t("library.addBooks")}
            </Button>
            {!safeMode && opdsEnabled ? (
              <Button
                variant="pill"
                size="pill"
                onClick={() => setOpdsOpen(true)}
                title={t("opds.libraryButtonTitle")}
                data-testid="opds-open"
              >
                <Cloud />
                {t("opds.libraryButton")}
              </Button>
            ) : null}
            <Button
              variant={selectMode ? "pill-primary" : "pill"}
              size="pill"
              onClick={toggleSelectMode}
              aria-pressed={selectMode}
              title={t("library.manageTitle")}
            >
              {selectMode ? <Check /> : <ListChecks />}
              {selectMode ? t("library.done") : t("library.manage")}
            </Button>
          </div>
        </div>

        <LibrarySearch
          value={query}
          onChange={setQuery}
          onCommit={commitSearch}
        />
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <LibraryFilters
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          groupSeries={groupSeries}
          onGroupSeriesChange={setGroupSeries}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          <span className="whitespace-nowrap tabular-nums" aria-live="polite">
            {groupSeries
              ? t(
                  displayBooks.length === 1
                    ? "library.countGroupsOne"
                    : "library.countGroups",
                  { count: formatNumber(displayBooks.length) },
                )
              : t(
                  displayBooks.length === 1
                    ? "library.countBooksOne"
                    : "library.countBooks",
                  { count: formatNumber(displayBooks.length) },
                )}
          </span>
        </div>
      </div>

      <section className="mt-6" aria-busy={loading}>
        {loadError !== null ? (
          <ErrorState
            message={t("library.loadFailed", {
              error: loadError || t("common.error"),
            })}
            onRetry={() => void reload(debounced)}
          />
        ) : loading && books.length === 0 ? (
          <LibrarySkeleton />
        ) : visibleBooks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-10 text-center shadow-hard-sm">
            <PixelPet mode="empty" message={emptyMessage} />
            {/* 空状态不再重复渲染导入按钮：顶栏右侧是唯一导入入口。 */}
            <p className="mt-4 text-xs text-muted-foreground">
              {t("library.dragHint")}
            </p>
          </div>
        ) : (
          <>
            <div
              ref={gridRef}
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
            >
              {start > 0 && (
                <div
                  data-window-spacer
                  aria-hidden
                  style={{
                    gridColumn: "1 / -1",
                    height: start * metrics.rowHeight,
                  }}
                />
              )}
              {windowedBooks.map(({ book, seriesCount }) => (
                <BookCard
                  key={book.id}
                  book={book}
                  seriesCount={seriesCount}
                  selectMode={selectMode}
                  checked={checkedIds.has(book.id)}
                  onToggleCheck={toggleCheck}
                  onContextMenu={(e, bookId) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, bookId });
                  }}
                  onSelect={onCardSelect}
                  onOpen={openReader}
                  onMissing={(bookId) => {
                    const book = findBook(bookId);
                    if (book) openRelocate(book);
                  }}
                  deferSelect
                />
              ))}
              {end < rowCount && (
                <div
                  data-window-spacer
                  aria-hidden
                  style={{
                    gridColumn: "1 / -1",
                    height: (rowCount - end) * metrics.rowHeight,
                  }}
                />
              )}
            </div>
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <Button
                  variant="pill"
                  size="pill"
                  disabled={loadingMore}
                  onClick={() => void loadNextPage()}
                >
                  <Plus />
                  {t("library.loadMore", {
                    count: formatNumber(PAGE_SIZE),
                  })}
                </Button>
              </div>
            )}
            <div ref={loadMoreRef} className="h-px w-full" aria-hidden />
            {!selectMode && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t("library.cardHint")}
              </p>
            )}
          </>
        )}
      </section>

      {selectMode && (
        <LibrarySelectionBar
          count={checkedBooks.length}
          deleteLabel={batchDeleteLabel}
          onRemove={() =>
            void doRemove(checkedBooks.map((book) => book.id))
          }
          onDelete={() => setConfirmDelete(checkedBooks)}
          onCancel={exitSelectMode}
        />
      )}

      {ctxMenu && ctxBook && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: t("menu.details"),
              icon: <BookOpen />,
              onSelect: () => openDetail(ctxBook),
            },
            {
              label: ctxBook.missing
                ? t("relocate.choose")
                : t("menu.continue"),
              icon: <BookMarked />,
              onSelect: () =>
                ctxBook.missing
                  ? openRelocate(ctxBook)
                  : openReader(ctxBook.id),
            },
            {
              label: t("menu.remove"),
              icon: <BookX />,
              onSelect: () => void doRemove([ctxBook.id]),
            },
            {
              label:
                ctxBook.sourceType === "local"
                  ? t("menu.deleteLocal")
                  : t("menu.deleteOnline"),
              danger: true,
              icon: <Trash2 />,
              onSelect: () => setConfirmDelete([ctxBook]),
            },
          ]}
        />
      )}

      {/* 删除源文件 / 彻底移除：二次确认，路径与文件名均已脱敏。 */}
      {deleteTargets && deleteTargets.length > 0 && (
        <ConfirmDialog
          title={t(
            deleteMixed
              ? "confirm.titleMixed"
              : deleteOnline.length > 0
                ? "confirm.titleOnline"
                : "confirm.titleLocal",
            {
              count: formatNumber(deleteTargets.length),
              pages: formatNumber(deletePages),
            },
          )}
          message={
            deleteMixed
              ? t("confirm.messageMixed", {
                  local: formatNumber(deleteLocal.length),
                  online: formatNumber(deleteOnline.length),
                })
              : deleteOnline.length > 0
                ? t("confirm.messageOnline")
                : t("confirm.messageLocal")
          }
          // 隐私：在线清单 URL 可能带临时 query token / hash / userinfo，
          // 复用 sourceDisplay 的脱敏结果，确认框不直出 b.path。
          paths={deleteTargets.map((book) => {
            const source = sourceDisplay(book);
            return t("confirm.pathLine", {
              source: t(
                source.kind === "local" ? "source.local" : "source.url",
              ),
              name: source.text,
              pages: formatNumber(book.pageCount),
            });
          })}
          confirmText={t(
            deleteMixed
              ? "confirm.confirmMixed"
              : deleteOnline.length > 0
                ? "confirm.confirmOnline"
                : "confirm.confirmLocal",
          )}
          onConfirm={() => void doDeleteConfirmed()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      <BookDetailSheet
        book={sheetBook}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        seriesBooks={detailSeriesBooks}
        onRead={(book, page) => openReader(book.id, page)}
        onRemove={(book) => void doRemove([book.id])}
        onRelocate={openRelocate}
        // Destructive source deletion goes through the shared confirm dialog.
        onDelete={(book) => setConfirmDelete([book])}
      />

      <RelocateDialog
        book={relocatingBook}
        open={relocatingBook !== null}
        onOpenChange={(next) => {
          if (!next) setRelocatingBook(null);
        }}
        onRelocated={onRelocated}
        onRemove={onRemoveMissing}
      />

      <OpdsBrowserDialog
        open={opdsEnabled && opdsOpen}
        onOpenChange={setOpdsOpen}
        onOpenBook={(book) => openReader(book.id)}
        onGoSettings={() => nav("/settings?tab=network")}
      />

    </div>
  );
}
