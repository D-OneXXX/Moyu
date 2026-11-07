import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryWindow } from "../src/lib/libraryWindow.ts";

test("visible range follows scrollTop", () => {
  // 1000 行、每行 100px、视口 300px：初始可见 0..3，滚到 500px 变成 5..8。
  assert.deepEqual(libraryWindow(0, 300, 100, 0, 1000), { start: 0, end: 3 });
  assert.deepEqual(libraryWindow(500, 300, 100, 0, 1000), {
    start: 5,
    end: 8,
  });
  assert.deepEqual(libraryWindow(1000, 300, 100, 0, 1000), {
    start: 10,
    end: 13,
  });
  const a = libraryWindow(0, 300, 100, 0, 1000);
  const b = libraryWindow(900, 300, 100, 0, 1000);
  assert.ok(b.start > a.start && b.end > a.end, "区间必须随滚动整体下移");
});

test("overscan extends the range on both edges", () => {
  assert.deepEqual(libraryWindow(500, 300, 100, 2, 1000), {
    start: 3,
    end: 10,
  });
  // 首部 overscan 不得把 start 推成负数。
  assert.deepEqual(libraryWindow(0, 300, 100, 3, 1000), {
    start: 0,
    end: 6,
  });
  const plain = libraryWindow(450, 240, 80, 0, 500);
  const padded = libraryWindow(450, 240, 80, 4, 500);
  assert.ok(padded.start <= plain.start, "上界应向外扩展");
  assert.ok(padded.end >= plain.end, "下界应向外扩展");
});

test("count=0 yields an empty range", () => {
  assert.deepEqual(libraryWindow(0, 300, 100, 2, 0), { start: 0, end: 0 });
  assert.deepEqual(libraryWindow(900, 300, 100, 5, 0), { start: 0, end: 0 });
});

test("range is clamped to [0, count] at both ends", () => {
  // 滚到远超末尾：start/end 都钳到 count，且 start <= end。
  const tail = libraryWindow(200000, 300, 100, 2, 1000);
  assert.deepEqual(tail, { start: 1000, end: 1000 });
  // 负滚动位置按 0 处理。
  assert.deepEqual(libraryWindow(-500, 300, 100, 2, 1000), {
    start: 0,
    end: 5,
  });
  // 小 count：end 不得超过总数。
  assert.deepEqual(libraryWindow(0, 300, 100, 2, 2), { start: 0, end: 2 });
  assert.deepEqual(libraryWindow(500, 300, 100, 2, 5), { start: 3, end: 5 });
  assert.ok(tail.start >= 0 && tail.end <= 1000, "区间始终落在 [0, count]");
});
