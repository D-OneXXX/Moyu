import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centerAnchor,
  reflowScrollTop,
  shouldCorrectPageDims,
  webtoonTileCount,
} from "../src/lib/webtoonGeometry.ts";

test("tile count follows actual non-upscaled output geometry", () => {
  const cases = [
    [1, 10000, 320, 5],
    [400, 10000, 800, 5],
    [7, 928, 448, 1],
    [800, 9000, 400, 3],
    [100, 2048, 100, 1],
    [100, 2049, 100, 2],
    [0, 100, 800, 1],
  ];
  for (const [width, height, renderWidth, expected] of cases) {
    assert.equal(webtoonTileCount(width, height, renderWidth, 2048), expected);
  }
});

/** 纯页高序列 → 条漫布局几何（起点前缀和）。 */
function strip(heights) {
  const pages = [];
  let acc = 0;
  for (const dispH of heights) {
    pages.push({ start: acc, dispH });
    acc += dispH;
  }
  return { pages, total: acc };
}

test("corrected page above the viewport shifts scrollTop by exactly the delta", () => {
  const before = strip([1000, 1000, 1000]);
  const after = strip([1200, 1000, 1000]); // 第 0 页被纠正 +200
  const top = 1200; // 视口中心落在第 1 页
  const vh = 1000;
  const target = reflowScrollTop(before, after, top, vh);
  assert.equal(target - top, 200, "above-viewport 纠正必须等效 scrollTop += deltaHeight");
});

test("corrected page below the viewport leaves scrollTop unchanged", () => {
  const before = strip([1000, 1000, 1000]);
  const after = strip([1000, 1000, 3000]); // 第 2 页在视口下方被纠正
  const top = 500;
  const vh = 1000;
  assert.equal(reflowScrollTop(before, after, top, vh), top);
});

test("center anchor (page + fraction) is preserved across the reflow", () => {
  const before = strip([800, 1600, 900]);
  const after = strip([800, 2400, 900]);
  const top = 700;
  const vh = 900;
  const oldAnchor = centerAnchor(before, top, vh);
  const target = reflowScrollTop(before, after, top, vh);
  const newAnchor = centerAnchor(after, target, vh);
  assert.equal(newAnchor.page, oldAnchor.page);
  assert.ok(Math.abs(newAnchor.frac - oldAnchor.frac) < 1e-9);
  // 页级进度（current_page）不因几何纠正而漂移。
  assert.equal(newAnchor.page, 1);
});

test("reflow clamps at top and bottom edges", () => {
  const before = strip([1000, 1000, 1000]);
  const after = strip([2000, 1000, 1000]);
  const vh = 1000;
  assert.equal(reflowScrollTop(before, after, 0, vh), 0, "贴顶保持贴顶");
  // 底部：旧 maxTop = 2000，新 total = 4000 → 新 maxTop = 3000。
  assert.equal(reflowScrollTop(before, after, 2000, vh), 3000, "贴底保持贴底");
  // 内容比视口还短：唯一合法位置是 0。
  const short = strip([300]);
  assert.equal(reflowScrollTop(short, strip([600]), 0, 1000), 0);
});

test("reflow without an old layout keeps the clamped position", () => {
  const after = strip([1000, 5000]);
  assert.equal(reflowScrollTop(null, after, 400, 1000), 400);
  assert.equal(reflowScrollTop(null, after, 9999, 1000), 5000);
});

test("page dim correction ignores placeholders and L2 slice-shaped junk", () => {
  const base = {
    origWidth: 800,
    origHeight: 12000,
    tileWidth: 1088,
    tileHeight: 2048,
    currentWidth: 800,
    currentHeight: 12000,
  };
  // 零值/负数/NaN：一律忽略。
  for (const [w, h] of [
    [0, 12000],
    [800, 0],
    [Number.NaN, 12000],
  ]) {
    assert.equal(
      shouldCorrectPageDims({ ...base, origWidth: w, origHeight: h }),
      false,
    );
  }
  // L2 兜底：整页尺寸被写成了单片成品像素框（宽 = 渲染宽、高 = 2048）。
  assert.equal(
    shouldCorrectPageDims({
      ...base,
      origWidth: 1088,
      origHeight: 2048,
      currentWidth: 0,
      currentHeight: 0,
    }),
    false,
  );
});

test("page dim correction accepts invalid dims and real ratio changes only", () => {
  const base = {
    origWidth: 800,
    origHeight: 12000,
    tileWidth: 1088,
    tileHeight: 2048,
    currentWidth: 800,
    currentHeight: 12000,
  };
  // 当前为占位 (0,0)：接受真实解码尺寸。
  assert.equal(
    shouldCorrectPageDims({ ...base, currentWidth: 0, currentHeight: 0 }),
    true,
  );
  // 比例相同（只有轻微缩放误差）：不动。
  assert.equal(
    shouldCorrectPageDims({
      ...base,
      origWidth: 400,
      origHeight: 6000,
      tileWidth: 400,
      tileHeight: 2048,
    }),
    false,
  );
  // 比例真的变了（占位按 1:2.5 兜底，实际是长图）：纠正。
  assert.equal(
    shouldCorrectPageDims({ ...base, currentHeight: 2000 }),
    true,
  );
});
