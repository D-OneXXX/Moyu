import test from "node:test";
import assert from "node:assert/strict";
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
