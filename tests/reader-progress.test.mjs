// 阅读进度契约回归：0-based 页码、末屏收敛与百分比公式。
// 运行：node --experimental-strip-types --test tests/reader-progress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  progressPageFor,
  spreadFor,
  stepPage,
} from "../src/components/Reader/spread.ts";

test("双页奇偶偏移：封面后插入虚拟单页，当前跨页移动 ±1", () => {
  // RTL 封面单页：标准配对是 [1,2]（视觉 [2,1]），偏移后 [2,3]（视觉 [3,2]）。
  assert.deepEqual(spreadFor(2, 8, "double", "rtl", { coverOffset: true }), [2, 1]);
  assert.deepEqual(
    spreadFor(2, 8, "double", "rtl", { coverOffset: true, pageShift: true }),
    [3, 2],
  );
  // 偏移插入的虚拟单页独立成屏，翻页不会跳过它。
  assert.deepEqual(
    spreadFor(1, 8, "double", "rtl", { coverOffset: true, pageShift: true }),
    [1],
  );
  assert.equal(
    stepPage(0, 8, "double", "rtl", 1, { coverOffset: true, pageShift: true }),
    1,
  );
  assert.equal(
    stepPage(1, 8, "double", "rtl", 1, { coverOffset: true, pageShift: true }),
    2,
  );
  assert.equal(
    stepPage(2, 8, "double", "rtl", -1, { coverOffset: true, pageShift: true }),
    1,
  );
  // 非末屏进度页仍取当前锚点，不把偏移页误记成已读。
  assert.equal(
    progressPageFor(2, 8, "double", "rtl", {
      coverOffset: true,
      pageShift: true,
    }),
    2,
  );
});

test("双页奇偶偏移：LTR 从第 0 页之后开始，封面设置保持不变", () => {
  assert.deepEqual(spreadFor(0, 6, "double", "ltr"), [0, 1]);
  assert.deepEqual(
    spreadFor(0, 6, "double", "ltr", { coverOffset: false, pageShift: true }),
    [0],
  );
  assert.deepEqual(
    spreadFor(1, 6, "double", "ltr", { coverOffset: false, pageShift: true }),
    [1, 2],
  );
  assert.deepEqual(
    spreadFor(3, 6, "double", "ltr", { coverOffset: false, pageShift: true }),
    [3, 4],
  );
  // 页数为偶数时，偏移后最后一页单独成屏（不越界、不吞页）。
  assert.deepEqual(
    spreadFor(5, 6, "double", "ltr", { coverOffset: false, pageShift: true }),
    [5],
  );
});

test("双页奇偶偏移不拆散横向跨页大图", () => {
  const dims = new Map([
    [0, [1600, 900]],
    [1, [800, 1200]],
    [2, [1600, 900]],
    [3, [800, 1200]],
  ]);
  // 第 0 页已是宽页，偏移不再额外插入；宽页保持独占。
  assert.deepEqual(
    spreadFor(0, 4, "double", "ltr", {
      coverOffset: false,
      pageShift: true,
      dims,
    }),
    [0],
  );
  assert.deepEqual(
    spreadFor(2, 4, "double", "ltr", {
      coverOffset: false,
      pageShift: true,
      dims,
    }),
    [2],
  );
});
import {
  readPagesRead,
  readProgressPercent,
} from "../src/lib/progress.ts";

test("双页末屏（RTL，页数为奇数）落点收敛到 page_count-1", () => {
  // 501 页 RTL + 封面单页：最后一组是 [500, 499]（视觉左→右），
  // 组内最小页是 499；修复前 stepPage 会停在 499，永远差一页。
  assert.deepEqual(spreadFor(499, 501, "double", "rtl"), [500, 499]);
  assert.equal(stepPage(497, 501, "double", "rtl", 1), 500);
  assert.equal(progressPageFor(499, 501, "double", "rtl"), 500);
  assert.equal(progressPageFor(500, 501, "double", "rtl"), 500);
  // 末屏前一屏：[498, 497]，不含最后一页 → 不提前抬进度。
  assert.equal(progressPageFor(497, 501, "double", "rtl"), 497);
});

test("双页末屏（LTR）同样收敛到 page_count-1", () => {
  assert.deepEqual(spreadFor(2, 4, "double", "ltr"), [2, 3]);
  assert.equal(stepPage(0, 4, "double", "ltr", 1), 3);
  assert.equal(progressPageFor(2, 4, "double", "ltr"), 3);
});

test("非末屏跨页组的翻页语义保持不变", () => {
  // RTL 组 [4,3] 的最小页是 3：既不是末屏，就仍按历史语义落点。
  assert.equal(stepPage(1, 501, "double", "rtl", 1), 3);
  assert.equal(stepPage(3, 501, "double", "rtl", -1), 1);
  // LTR [0,1] 往前翻到 [2,3] 的组内最小页 2。
  assert.equal(stepPage(0, 500, "double", "ltr", 1), 2);
});

test("单页模式进度页 = 当前页", () => {
  assert.equal(progressPageFor(9, 10, "single", "rtl"), 9);
  assert.equal(progressPageFor(0, 10, "single", "rtl"), 0);
  assert.equal(progressPageFor(9, 1, "single", "rtl"), 0);
});

test("百分比公式：末页 = 100%，未开始 = 0%", () => {
  assert.equal(readProgressPercent(9, 10), 100);
  assert.equal(readProgressPercent(4, 10), 50);
  assert.equal(readProgressPercent(0, 10), 0);
  assert.equal(readProgressPercent(0, 0), 0);
});

test("单页书：现有契约无「读完」信号，保持 0%（不虚报）", () => {
  // current_page 合法值只有 0；last_opened_at 在入库时即写入、set_progress(0)
  // 又被 no-op 短路，任何启发式都会把「刚导入」误判成「已读完」。
  // 等后端新增 read_at/finished 标记后再放开这里。
  assert.equal(readProgressPercent(0, 1), 0);
  assert.equal(readPagesRead(0, 1), 0);
});

test("「已读 X/Y」是 1-based，未开始为 0", () => {
  assert.equal(readPagesRead(0, 10), 0);
  assert.equal(readPagesRead(1, 10), 2);
  assert.equal(readPagesRead(9, 10), 10);
  // 脏数据（越界）钳到页数上限。
  assert.equal(readPagesRead(99, 10), 10);
});
