/**
 * 一维虚拟列表的可见索引区间（半开 [start, end)）。
 * 书库网格按「行」调用：count 为总行数，rowHeight 为单行像素高度，
 * 调用方再把行区间换算成书卡索引区间。
 */
export interface WindowRange {
  start: number;
  end: number;
}

/**
 * 给定滚动位置计算应渲染的索引区间：
 * - count<=0 返回空区间；
 * - overscan 在可视区间上下各扩展若干行；
 * - start/end 始终钳制在 [0, count]，且 start<=end。
 * 纯函数，不依赖 DOM，便于单测覆盖首尾与滚动边界。
 */
export function libraryWindow(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan: number,
  count: number,
): WindowRange {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (total === 0) return { start: 0, end: 0 };
  const h = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const vp = Number.isFinite(viewport) && viewport > 0 ? viewport : h;
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const pad = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : 0;
  const firstVisible = Math.floor(top / h);
  const lastVisible = Math.ceil((top + vp) / h);
  const start = Math.min(total, Math.max(0, firstVisible - pad));
  const end = Math.min(total, Math.max(0, lastVisible + pad));
  return { start, end: Math.max(start, end) };
}
