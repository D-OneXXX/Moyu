/**
 * 阅读进度统一口径（前端唯一实现）。
 *
 * 后端契约：`books.current_page` 是 **0-based 页下标**，有效范围
 * `0 .. page_count - 1`，语义是「当前屏幕对应的页」。因此：
 *
 * - 已读页数 = `current_page + 1`；
 * - 百分比 = `Math.round(((current_page + 1) / page_count) * 100)`；
 * - `current_page === page_count - 1` ⇔ 100%（与 `get_last_read` 的
 *   `current_page + 1 < page_count` 未读完判定严格互补）。
 *
 * `current_page === 0` 一律视为「未开始」：
 * 单页书（`page_count === 1`）的合法页码只有 0，本可以理解为「唯一一页
 * 已读完」，但库里没有任何可信信号能区分「导入后从未打开」与「打开并
 * 读完」——`last_opened_at` 在入库时就会写入（用于最近打开排序），
 * `set_progress(0)` 又因字段无变化被 no-op 短路。用它做判定会让每本新
 * 导入的单页书立刻显示 100%，属于系统性虚报。
 *
 * 升级路径：后端新增独立的「读完」标记（如 `read_at` / `finished` 列，
 * 在 `page === page_count - 1` 首次达成时写入）后，再把该信号作为可选
 * 参数传入，单页书即可精确显示 100%，无需改动本公式。
 */
export function readProgressPercent(
  currentPage: number,
  pageCount: number,
): number {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return 0;
  const raw = Number.isFinite(currentPage) ? Math.floor(currentPage) : 0;
  const page = Math.min(Math.max(0, raw), pageCount - 1);
  if (page === 0) return 0;
  return Math.min(100, Math.round(((page + 1) / pageCount) * 100));
}

/** 「已读 X / Y 页」里的 X（1-based）；未开始时返回 0。 */
export function readPagesRead(
  currentPage: number,
  pageCount: number,
): number {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return 0;
  if (readProgressPercent(currentPage, pageCount) <= 0) return 0;
  const raw = Number.isFinite(currentPage) ? Math.floor(currentPage) : 0;
  return Math.min(pageCount, Math.max(0, raw) + 1);
}
