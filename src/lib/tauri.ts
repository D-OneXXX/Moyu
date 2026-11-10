// Frozen invoke contract — mirrors src-tauri/src/lib.rs JSON shapes (camelCase).
import { invoke } from "@tauri-apps/api/core";
import {
  FEATURE_REGISTRY,
  emitFeaturesChanged,
  isFeatureEnabled,
  type FeatureFlags,
  type FeatureId,
} from "@/features/features";

export interface BookInfo {
  id: string;
  title: string;
  path: string;
  pageCount: number;
  currentPage: number;
  /** 最近一次**阅读进度发生变化**的时间（本地时间串）。打开书不改它。 */
  updatedAt: string;
  /** 最近一次**打开这本书**的时间（本地时间串）。 */
  lastOpenedAt: string;
  /** 进度修订号：进度每次变化 +1，供乐观并发控制。打开书不改它。 */
  progressRev: number;
  /** 本地源路径已不存在（NotFound）；在线书恒为 false，需重新指定位置。 */
  missing: boolean;
  /** 条漫滚动偏移百分比（0..1）；-1 = 无条漫阅读记录。 */
  scrollPct: number;
  /** local | generic_manga | anime（预留）。 */
  sourceType: string;
  /** 来源格式：image（图片目录 / ZIP / CBZ）| pdf（PDF 文档，仅识别与导入，尚不可阅读）。 */
  format: string;
  /** 条漫是否可用：本地 true；在线取决于清单尺寸。 */
  webtoonReady: boolean;
  /** 同一系列的标识；用于下一话解析。 */
  seriesId?: string | null;
  /** 系列标题。 */
  seriesTitle?: string | null;
  /** 章节序号。 */
  chapterIndex?: number | null;
  /** 下一话来源 URL；无则 null/缺省。 */
  nextUrl?: string | null;
}

/** ADR-018 冻结契约：桌面书库分页结果（游标 =(last_opened_at,id) base64url）。 */
export interface BooksPage {
  items: BookInfo[];
  nextCursor: string | null;
}

/**
 * ADR-032 冻结契约：书库合集计数（一次分组聚合，不含 BookInfo）。
 * `seriesCounts` / `localSeriesCounts` 为 `seriesId -> 章节数`；
 * 无合集（NULL/空 seriesId）的书只计入 `totalBooks`。
 */
export interface LibraryStats {
  totalBooks: number;
  seriesCounts: Record<string, number>;
  localSeriesCounts: Record<string, number>;
}

/** 在线图片提纯：被剔除的页面（保留原顺序，恢复时插回）。 */
export interface FilteredPage {
  url: string;
  width?: number | null;
  height?: number | null;
  reason: string;
  score: number;
  order: number;
  anchor?: {
    channel: string;
    messageId: number;
    photoIndex: number;
    refreshBase?: string | null;
  } | null;
  sha256?: string | null;
}

export interface OnlineFilterStats {
  siteProfiles: number;
  rules: number;
  blockedTotal: number;
  restoredTotal: number;
  lastUpdated?: string | null;
}

export type OnlineFilterRulePattern =
  | { kind: "urlTemplate"; template: string }
  | { kind: "exactUrl"; url: string }
  | { kind: "sha256"; hash: string }
  | { kind: "domClass"; value: string }
  | { kind: "size"; width: number; height: number };

export interface OnlineFilterRule {
  id: string;
  host: string;
  action: "block" | "allow";
  source: "user" | "learned" | "imported";
  pattern: OnlineFilterRulePattern;
  reason: string;
  createdAt: string;
  hits: number;
}

export type TelegramChapterKind = "telegraph" | "photos" | "document";

export interface TelegramDocument {
  url: string;
  filename: string;
  size?: number | null;
}

export interface TelegramChapter {
  id: string;
  title: string;
  url: string;
  messageId: number;
  pageCount?: number | null;
  kind: TelegramChapterKind;
  document?: TelegramDocument | null;
  grouped: boolean;
}

export interface TelegramChannel {
  channel: string;
  title: string;
  chapters: TelegramChapter[];
  before?: number | null;
  hasMore: boolean;
}

export interface PageEntry {
  index: number;
  name: string;
}

/** PDF 字节分块：把本地 PDF 按区间喂给前端 pdf.js。 */
export interface PdfChunk {
  /** 整个 PDF 文件的字节数（始终是真实大小，与请求区间无关）。 */
  total: number;
  /** 本次区间的原始字节（base64，无 data: 前缀）。 */
  data: string;
}

export interface PageImage {
  index: number;
  width: number;
  height: number;
  /** 源图原始尺寸（条漫建议/布局用）。 */
  origWidth: number;
  origHeight: number;
  mime: string;
  dataUrl: string;
}

/** 条漫布局：单页源图尺寸。 */
export interface PageDim {
  index: number;
  width: number;
  height: number;
}

/** 条漫切片目标高度（设备像素），与后端 pipeline::WEBTOON_TILE_H 一致。 */
export const WEBTOON_TILE_H = 2048;

export interface MemoryStats {
  processMb: number;
  cacheBytes: number;
  cacheLimitBytes: number;
  cachedPages: number;
  cachedThumbs: number;
  webtoonBytes: number;
  webtoonTiles: number;
  /** 统一磁盘缓存总占用（render + online 原图）。 */
  diskCacheBytes: number;
  /** 磁盘缓存上限（由 diskCacheBudgetMb 换算）。 */
  diskCacheLimitBytes: number;
  /** 磁盘缓存中渲染结果占用。 */
  renderCacheBytes: number;
  /** 磁盘缓存中在线原图占用。 */
  onlineCacheBytes: number;
}

export interface HeatDay {
  date: string;
  count: number;
}

export interface SeriesProgress {
  bookId: string;
  title: string;
  currentPage: number;
  pageCount: number;
}

export interface Dashboard {
  totalBooks: number;
  reading: number;
  /** 已开始且翻到最后一页的书数；pageCount=0 的书不计入。 */
  finished: number;
  todayPages: number;
  /** 累计阅读页数（reading_log 总和，包含已软删书的历史）。 */
  totalPagesRead: number;
  heatmap: HeatDay[];
  series: SeriesProgress[];
}

export interface BookDayPoint {
  bookId: string;
  date: string;
  pages: number;
}

export interface ScanResult {
  added: number;
  books: BookInfo[];
  errors: string[];
}

export interface ImportItemResult {
  path: string;
  /** added=已入库 / restored=恢复(进度保留) / skipped=已在书库中 / failed */
  status: string;
  message: string;
  book: BookInfo | null;
}

export interface ImportResult {
  items: ImportItemResult[];
  added: number;
  restored: number;
  skipped: number;
  failed: number;
}

export interface RemoveResult {
  removed: number;
  deletedFiles: number;
  errors: string[];
}

/**
 * 单实例直开队列中的一条请求（首次 CLI 启动 / 二次双击文件入队）。
 * `paths` 只用于展示 basename，不得原样落盘或写日志。
 */
export interface OpenWithRequest {
  paths: string[];
  /** 本次请求批量导入的成功 / 失败数量。 */
  imported: number;
  failed: number;
  /** 可立即打开的本地书；失败或被跳过时为 null。 */
  book: BookInfo | null;
  /** 后端失败代码（非中文原文）；成功时为 null。 */
  errorCode: string | null;
}

/** `clear_temp_cache` 结果：释放的字节数与删除的文件数。 */
export interface ClearCacheResult {
  bytesFreed: number;
  files: number;
}

export interface Settings {
  theme: string;
  /** 内存缓存预算（MB）。 */
  cacheBudgetMb: number;
  /** 统一磁盘缓存预算（MB，render + online 原图）。 */
  diskCacheBudgetMb: number;
  libraryDir: string;
  /** 可选大功能总开关；以 src/features/features.ts 为唯一前端注册表。 */
  features: FeatureFlags;
  /** 在线源 HTTP 代理（空=直连；http/https/socks5）。 */
  onlineProxy: string;
  /** 单本在线书页面下载并发（1-8）。 */
  onlineConcurrency: number;
  /** 手动请求头：JSON 对象或单行 Cookie；仅用于自建/授权源，明文存储。 */
  onlineHeaders: string;
  /** 关闭主窗口时隐藏到系统托盘（局域网阅读运行中始终拦截关闭）。 */
  closeToTray: boolean;
}

/** 在线源连通性探测结果（只解析清单，不写库）。 */
export interface OnlineProbe {
  ok: boolean;
  title: string;
  pageCount: number;
  elapsedMs: number;
  message: string;
}

/** 本地 OPDS 配置；密码永不回传，只暴露是否已保存。 */
export interface OpdsConfigView {
  enabled: boolean;
  url: string;
  /** 本机是否已存账号；账号本身永不下发前端。 */
  hasUsername: boolean;
  /** 本机是否已存密码；密码本身永不下发前端。 */
  hasPassword: boolean;
}

/** 保存配置；null 保留原值，空串表示清除。 */
export interface OpdsConfigInput {
  enabled: boolean;
  url: string;
  username: string | null;
  password: string | null;
}

export type OpdsArchiveKind = "zip" | "rar" | "auto";

/** 一个 OPDS 条目：可能可进入下一级、可下载，或两者都有。 */
export interface OpdsEntry {
  title: string;
  navigationUrl?: string | null;
  coverUrl?: string | null;
  downloadUrl?: string | null;
  mediaType: string;
  archive?: OpdsArchiveKind | null;
}

/** 一页 OPDS 1.2 Atom 目录。 */
export interface OpdsFeed {
  url: string;
  title: string;
  entries: OpdsEntry[];
  nextUrl?: string | null;
  prevUrl?: string | null;
}

/** 内嵌浏览器下载项（后端扫描应用下载目录）。 */
export interface BrowserDownload {
  path: string;
  name: string;
  size: number;
  modified: string;
  imported: boolean;
}

/** `browser-download` 事件载荷。 */
export interface BrowserDownloadEvent {
  path: string;
  name: string;
  imported: boolean;
  bookId: string | null;
}

/** 外部浏览器配对桥接状态（与后端 HandoffStatus 一致）。 */
export interface HandoffStatus {
  active: boolean;
  port: number;
  pairingToken: string;
  callbackUrl: string;
  receivedChapters: number;
  allowSessionHeaders: boolean;
  script: string;
}

// ---------- 功能开关镜像：同步读取 + 变更事件 ----------
// 设置的权威副本在 SQLite；这里维护 localStorage 镜像，让无法等待
// 异步 getSettings 的组件（阅读器/导航）能同步读取开关状态。

const EXP_WT_KEY = "mr-exp-wt";
const EXP_ONLINE_KEY = "mr-exp-online";

function applySettingsMirror(s: Settings) {
  try {
    for (const feature of FEATURE_REGISTRY) {
      localStorage.setItem(
        feature.mirrorKey,
        s.features[feature.settingKey] ? "1" : "0",
      );
    }
    // 旧键只用于降级/旧备份兼容；读侧新键优先。
    localStorage.setItem(EXP_WT_KEY, s.features.webtoon ? "1" : "0");
    localStorage.setItem(EXP_ONLINE_KEY, s.features.online ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

/** 同步读取条漫模式总开关（镜像）。 */
export function isWebtoonEnabled(): boolean {
  return isFeatureEnabled("webtoon");
}

/** 同步读取在线直读总开关（镜像）。 */
export function isOnlineEnabled(): boolean {
  return isFeatureEnabled("online");
}

/** 订阅设置变更（setSettings 成功后广播；回调里用 is*Enabled() 取最新值）。 */
export function onExperimentalChange(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener("mr-settings-changed", h);
  return () => window.removeEventListener("mr-settings-changed", h);
}

export const api = {
  // Tauri 2 参数键为驼峰(与 Rust snake_case 参数一一对应);单词参数两写等价。
  scanLibrary: (path: string) =>
    invoke<ScanResult>("scan_library", { path }),  // 导入书籍（文件/文件夹路径数组）：同路径去重（已在书库中），软删过的恢复并续读。
  importBooks: (paths: string[]) =>
    invoke<ImportResult>("import_books", { paths }),
  // 本地源路径丢失后的无损重定位：新 id = sha256(newPath)，进度/scrollPct/阅读日志由后端迁移。
  relocateBook: (bookId: string, newPath: string) =>
    invoke<BookInfo>("relocate_book", { bookId, newPath }),
  // 单实例直开队列：FIFO 取一条 pending 请求（无则 null）；前端需循环取到 null。
  takePendingOpen: () => invoke<OpenWithRequest | null>("take_pending_open"),
  // 移除（deleteSourceFiles=false，可逆）或删除源文件（true，不可逆+级联清理）。
  removeBooks: (ids: string[], deleteSourceFiles: boolean) =>
    invoke<RemoveResult>("remove_books", { ids, deleteSourceFiles }),
  listBooks: (query?: string) =>
    invoke<BookInfo[]>("list_books", { query: query ?? null }),
  // ADR-018：桌面书库分页，保持 last_opened_at 排序与 title+path 搜索。
  // 后端实现由 WS2 提供；此处仅冻结 invoke 参数与 limit 默认值。
  listBooksPage: (args: {
    query?: string | null;
    cursor?: string | null;
    limit?: number;
  } = {}) =>
    invoke<BooksPage>("list_books_page", {
      query: args.query ?? null,
      cursor: args.cursor ?? null,
      limit: args.limit ?? 60,
    }),
  // ADR-032：合集计数聚合（seriesId -> 章节数），替代搜索态全量 listBooks()。
  libraryStats: () => invoke<LibraryStats>("library_stats"),
  // ADR-034：「继续阅读」轻量查询（最近打开、已开始且未读完的一本）。
  getLastRead: (localOnly = false) =>
    invoke<BookInfo | null>("get_last_read", { localOnly }),
  getBook: (bookId: string) =>
    invoke<BookInfo>("get_book", { bookId }),
  listEntries: (bookId: string) =>
    invoke<PageEntry[]>("list_entries", { bookId }),
  getPage: (bookId: string, index: number, maxWidth?: number, maxHeight?: number) =>
    invoke<PageImage>("get_page", {
      bookId,
      index,
      maxWidth: maxWidth ?? null,
      maxHeight: maxHeight ?? null,
    }),
  getThumbnail: (bookId: string, maxSize?: number) =>
    invoke<PageImage>("get_thumbnail", { bookId, maxSize: maxSize ?? null }),
  // PDF（PDF-2）：按字节区间读取本地 PDF，喂给前端 pdf.js 解析。
  // length 会被后端钳制到 4 MiB；offset 越界返回空数据（视为 EOF）。
  getPdfChunk: (bookId: string, offset: number, length: number) =>
    invoke<PdfChunk>("get_pdf_chunk", { bookId, offset, length }),
  // 回写真实页数（PDF 导入时页数留 0）；只更新 books.page_count。
  setBookPageCount: (bookId: string, pageCount: number) =>
    invoke<void>("set_book_page_count", { bookId, pageCount }),
  // 写回前端渲染的 PDF 封面（裸 base64，JPEG/PNG）。
  putPdfThumbnail: (bookId: string, dataBase64: string) =>
    invoke<void>("put_pdf_thumbnail", { bookId, dataBase64 }),
  // 清空临时磁盘缓存（render + online 原图），返回释放体积与文件数。
  clearTempCache: () => invoke<ClearCacheResult>("clear_temp_cache"),
  getMemoryStats: () => invoke<MemoryStats>("get_memory_stats"),
  getDashboard: () => invoke<Dashboard>("get_dashboard"),
  // 逐日阅读页数：bookId=null 全局；Some(id) 只看该书。days 1..365。
  getReadingLog: (bookId: string | null, days: number) =>
    invoke<HeatDay[]>("get_reading_log", { bookId, days }),
  // 逐日逐书阅读页数（趋势堆叠图）。
  getReadingByBook: (days: number) =>
    invoke<BookDayPoint[]>("get_reading_by_book", { days }),
  setProgress: (bookId: string, page: number, scrollPct?: number) =>
    invoke<void>("set_progress", { bookId, page, scrollPct: scrollPct ?? null }),
  /** 记录「最近打开」：只写 last_opened_at，不动 updated_at / progress_rev / 阅读历史。 */
  markBookOpened: (bookId: string) => invoke<void>("mark_book_opened", { bookId }),
  clearPages: () => invoke<void>("clear_pages"),
  // 条漫：整话逐页源尺寸（header 解析）+ 单切片获取。
  getWebtoonLayout: (bookId: string) =>
    invoke<PageDim[]>("get_webtoon_layout", { bookId }),
  getWebtoonTile: (bookId: string, index: number, tile: number, maxWidth: number) =>
    invoke<PageImage>("get_webtoon_tile", { bookId, index, tile, maxWidth }),
  getSettings: () =>
    invoke<Settings>("get_settings").then((s) => {
      applySettingsMirror(s);
      return s;
    }),
  setSettings: (settings: Settings) =>
    invoke<Settings>("set_settings", { settings }).then((saved) => {
      applySettingsMirror(saved);
      window.dispatchEvent(new CustomEvent("mr-settings-changed"));
      return saved;
    }),
  /** Persist + apply the native tray menu language (6 dictionaries). */
  setTrayLocale: (locale: string) =>
    invoke<void>("tray_set_locale", { locale }),
  setFeatureEnabled: (feature: FeatureId, enabled: boolean) =>
    invoke<Settings>("set_feature_enabled", { feature, enabled }).then(
      (settings) => {
        applySettingsMirror(settings);
        emitFeaturesChanged();
        return settings;
      },
    ),
  resolveOnlineUrl: (url: string) =>
    invoke<BookInfo>("resolve_online_url", { url }),
  // OPDS 1.2 自建库：配置只存本地 SQLite，密码只写不读。
  getOpdsConfig: () => invoke<OpdsConfigView>("opds_get_config"),
  setOpdsConfig: (config: OpdsConfigInput) =>
    invoke<OpdsConfigView>("opds_set_config", { config }),
  testOpdsConnection: () =>
    invoke<OnlineProbe>("opds_test_connection"),
  browseOpds: (url?: string | null) =>
    invoke<OpdsFeed>("opds_browse", { url: url ?? null }),
  getOpdsCover: (url: string) =>
    invoke<PageImage>("opds_cover", { url }),
  downloadOpdsEntry: (url: string, title: string) =>
    invoke<BookInfo>("opds_download_entry", { url, title }),
  // 系统代理探测（只填入表单，不落库）。
  detectSystemProxy: () => invoke<string | null>("detect_system_proxy"),
  // 外部系统浏览器配对桥接：长驻监听，结果经 online-handoff-imported 回传。
  startBrowserHandoff: (allowSessionHeaders: boolean) =>
    invoke<HandoffStatus>("start_browser_handoff", { allowSessionHeaders }),
  stopBrowserHandoff: () => invoke<void>("stop_browser_handoff"),
  getBrowserHandoffStatus: () =>
    invoke<HandoffStatus>("get_browser_handoff_status"),
  // Telegram 公开频道/消息/Telegraph 直读（免登录，仅公开预览页）。
  resolveTelegramChannel: (url: string, before?: number | null) =>
    invoke<TelegramChannel>("resolve_telegram_channel", {
      url,
      before: before ?? null,
    }),
  downloadTelegramDocument: (url: string, filename: string) =>
    invoke<BookInfo>("download_telegram_document", { url, filename }),
  // 自学习提纯：统计、规则库、当前书被过滤页。
  getOnlineFilterStatus: () =>
    invoke<OnlineFilterStats>("get_online_filter_status"),
  listOnlineFilterRules: () =>
    invoke<OnlineFilterRule[]>("list_online_filter_rules"),
  exportOnlineFilterRules: () =>
    invoke<string>("export_online_filter_rules"),
  importOnlineFilterRules: (json: string) =>
    invoke<number>("import_online_filter_rules", { json }),
  resetOnlineFilterRules: () => invoke<void>("reset_online_filter_rules"),
  getFilteredPages: (bookId: string) =>
    invoke<FilteredPage[]>("get_filtered_pages", { bookId }),
  getFilteredPreview: (bookId: string, filteredIndex: number) =>
    invoke<PageImage>("get_filtered_preview", { bookId, filteredIndex }),
  markOnlinePageNonContent: (bookId: string, pageIndex: number) =>
    invoke<BookInfo>("mark_online_page_non_content", { bookId, pageIndex }),
  restoreOnlineFilteredPage: (bookId: string, filteredIndex: number) =>
    invoke<BookInfo>("restore_online_filtered_page", {
      bookId,
      filteredIndex,
    }),
  getSeriesBooks: (seriesId: string) =>
    invoke<BookInfo[]>("get_series_books", { seriesId }),
  getNextBook: (bookId: string) =>
    invoke<BookInfo | null>("get_next_book", { bookId }),
  // 会话级在线请求头（仅内存，不落库）。
  getSessionOnlineHeaders: () =>
    invoke<string | null>("get_session_online_headers"),
  setSessionOnlineHeaders: (value: string) =>
    invoke<void>("set_session_online_headers", { headers: value }),
  clearSessionOnlineHeaders: () =>
    invoke<void>("clear_session_online_headers"),
  // 内嵌浏览器（独立 WebviewWindow）：启动/导航、下载扫描与导入。
  openBrowserWindow: (url: string) =>
    invoke<void>("open_browser_window", { url }),
  navigateBrowser: (url: string) =>
    invoke<void>("navigate_browser", { url }),
  // Handoff 启停后刷新辅助浏览器顶部条（窗口不存在时静默成功）。
  syncBrowserToolbar: () => invoke<void>("sync_browser_toolbar"),
  listBrowserDownloads: () =>
    invoke<BrowserDownload[]>("list_browser_downloads"),
  importBrowserDownload: (path: string) =>
    invoke<string | null>("import_browser_download", { path }),
};
