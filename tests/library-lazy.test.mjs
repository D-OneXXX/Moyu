import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const app = read("src/App.tsx");
const shell = read("src/components/shell/AppShell.tsx");
const card = read("src/components/BookCard.tsx");

// 只匹配「静态 from 导入」；动态 import("...") 不算违规。
const STATIC_READER = /^\s*import\s+[^;]*?\bReader\b[^;]*?from\s+["'][^"']*pages\/Reader["'];?\s*$/m;
const STATIC_PDF = /^\s*import\s+[^;]*?from\s+["']@\/features\/pdf["'];?\s*$/m;

test("App.tsx 不得静态 import Reader（必须 React.lazy）", () => {
  assert.equal(
    STATIC_READER.test(app),
    false,
    "Reader 是最重的页面，静态 import 会把它打进首屏包",
  );
  assert.match(
    app,
    /lazy\(\s*\(\)\s*=>\s*import\(["']\.\/pages\/Reader["']\)\s*\)/,
    "必须存在 lazy(() => import('./pages/Reader'))",
  );
});

test("BookCard 不得静态 import @/features/pdf（必须动态 import）", () => {
  assert.equal(
    STATIC_PDF.test(card),
    false,
    "PDF 封面渲染能力不应进入书卡片的首屏依赖",
  );
  assert.match(
    card,
    /import\(["']@\/features\/pdf["']\)/,
    "PDF 封面分支必须改为动态 import",
  );
});

test("两套路由表都有 Suspense 边界且 fallback 走 t()", () => {
  assert.match(app, /<Suspense\b/, "App.tsx  immersive 分支缺 Suspense");
  assert.match(shell, /<Suspense\b/, "AppShell 外壳分支缺 Suspense");
  for (const [name, src] of [
    ["App.tsx", app],
    ["AppShell.tsx", shell],
  ]) {
    assert.match(
      src,
      /\bt\(\s*["']common\.loading["']\s*\)/,
      `${name} 的 fallback 文案必须走 t()，不得硬编码中英文`,
    );
  }
});

test("四路由与 * 兜底在两套路由表保持不变", () => {
  const countWildcard = (src) =>
    (src.match(/<Route\s+path="\*"/g) || []).length;
  assert.equal(countWildcard(app), 1, "App.tsx 的 * 兜底必须保留");
  assert.equal(countWildcard(shell), 1, "AppShell.tsx 的 * 兜底必须保留");
  for (const [name, src] of [
    ["App.tsx", app],
    ["AppShell.tsx", shell],
  ]) {
    const routes = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const route of routes) {
      assert.ok(
        ["/reader/:id", "/", "/browser", "/settings", "*"].includes(route),
        `${name} 出现非授权路由 ${route}`,
      );
    }
  }
});
