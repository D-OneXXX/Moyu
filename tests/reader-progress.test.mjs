// 阅读进度契约回归：0-based 页码、末屏收敛与百分比公式。
// 运行：node --experimental-strip-types --test tests/reader-progress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  progressPageFor,
  spreadFor,
  stepPage,
} from "../src/components/Reader/spread.ts";
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
