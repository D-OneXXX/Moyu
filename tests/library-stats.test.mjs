import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-032 契约守卫：合集计数改由 `library_stats` 聚合命令提供，
// 搜索态不得再调用 `api.listBooks()` 取全库。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const api = read("src/lib/tauri.ts");
const library = read("src/pages/Library.tsx");

test("tauri.ts 暴露 library_stats 命令封装与 LibraryStats 类型", () => {
  assert.match(
    api,
    /invoke<LibraryStats>\(\s*["']library_stats["']\s*\)/,
    "api 必须封装 invoke<LibraryStats>('library_stats')",
  );
  assert.match(
    api,
    /export\s+interface\s+LibraryStats\b/,
    "tauri.ts 必须导出 LibraryStats 接口",
  );
});

test("LibraryStats 字段保持 camelCase 契约", () => {
  const start = api.indexOf("interface LibraryStats");
  assert.ok(start >= 0, "缺少 interface LibraryStats");
  const body = api.slice(start, api.indexOf("}", start) + 1);
  for (const key of ["totalBooks", "seriesCounts", "localSeriesCounts"]) {
    assert.match(body, new RegExp(`\\b${key}\\b`), `缺字段 ${key}`);
  }
  for (const snake of ["total_books", "series_counts", "local_series_counts"]) {
    assert.equal(
      body.includes(snake),
      false,
      `不得把 snake_case 字段 ${snake} 泄漏到前端类型`,
    );
  }
});

test("Library.tsx 搜索态不得再取全量 listBooks()", () => {
  assert.equal(
    library.includes("api.listBooks("),
    false,
    "合集计数必须走 library_stats 聚合，搜索态取全库会逐书 stat + 序列化",
  );
});

test("Library.tsx 改用 libraryStats() 并区分本地映射", () => {
  assert.match(
    library,
    /api\.libraryStats\(\s*\)/,
    "reload 必须以 api.libraryStats() 计算合集计数",
  );
  assert.match(
    library,
    /localSeriesCounts/,
    "safeMode 必须使用 localSeriesCounts（全局本地口径）",
  );
});
