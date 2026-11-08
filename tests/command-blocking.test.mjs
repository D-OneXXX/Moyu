import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-036 契约守卫：async 命令里的 SQLite/磁盘阻塞工作必须走 blocking()
//（tokio::task::spawn_blocking），不得直接占用 async 执行器线程。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commands = readFileSync(join(root, "src-tauri/src/commands.rs"), "utf8");

function fnBody(name) {
  const start = commands.indexOf(`pub async fn ${name}(`);
  assert.ok(start >= 0, `缺少命令 ${name}`);
  const next = commands.indexOf("\n#[tauri::command]", start + 1);
  return commands.slice(start, next === -1 ? undefined : next);
}

for (const name of [
  "get_dashboard",
  "library_stats",
  "list_books",
  "list_books_page",
]) {
  test(`${name} 的阻塞 DB 工作走 blocking()`, () => {
    const body = fnBody(name);
    assert.match(
      body,
      /blocking\(\s*move \|\|/,
      `${name} 必须用 blocking(move || …) 卸载阻塞查询`,
    );
    assert.equal(
      /state\.db\.with/.test(body),
      false,
      `${name} 不得在 async 线程直接 state.db.with`,
    );
  });
}
