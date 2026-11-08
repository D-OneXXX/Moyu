import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { sanitizeStorage } from "../src/lib/storageSanitizer.ts";

test("startup sanitization preserves skin and shortcut preferences", () => {
  const values = new Map([["mr-skin", "ink-companion"], ["mr-shortcuts-enabled", "0"]]);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  sanitizeStorage(storage);
  assert.equal(values.get("mr-skin"), "ink-companion");
  assert.equal(values.get("mr-shortcuts-enabled"), "0");
});

test("failed persistence keeps the shortcut switch disabled for this session", () => {
  const source = readFileSync(new URL("../src/features/shortcuts/preferences.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("preferences.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.filter((node) =>
    ts.isVariableStatement(node) ||
    (ts.isFunctionDeclaration(node) && ["read", "subscribe", "setShortcutsEnabled", "shortcutsEnabledNow"].includes(node.name?.text)),
  );
  const code = declarations.map((node) => node.getText(file)).join("\n").replaceAll("export function", "function");
  const window = new EventTarget();
  const localStorage = { getItem: () => "1", setItem: () => { throw new Error("quota"); } };
  const api = runInNewContext(ts.transpile(code) + "; ({ subscribe, setShortcutsEnabled, shortcutsEnabledNow })", {
    localStorage, window, Event,
  });
  let notifications = 0;
  const unsubscribe = api.subscribe(() => { notifications++; });
  api.setShortcutsEnabled(false);
  assert.equal(api.shortcutsEnabledNow(), false);
  assert.equal(notifications, 1);
  unsubscribe();
});
