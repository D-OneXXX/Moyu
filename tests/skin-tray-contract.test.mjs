import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sanitizeStorage } from "../src/lib/storageSanitizer.ts";
import { BUILTIN_SKINS } from "../src/features/skin/registry.ts";
import { messages as webReaderMessages } from "../src/i18n/messages/webReader.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

class MemoryStorage {
  values = new Map();

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("built-in skins and the shortcut switch survive startup sanitization", () => {
  for (const skin of BUILTIN_SKINS) {
    const storage = new MemoryStorage();
    storage.setItem("mr-skin", skin.id);
    storage.setItem("mr-shortcuts-enabled", "0");
    sanitizeStorage(storage);
    assert.equal(storage.getItem("mr-skin"), skin.id);
    assert.equal(storage.getItem("mr-shortcuts-enabled"), "0");
  }

  const dirty = new MemoryStorage();
  dirty.setItem("mr-skin", "custom-123");
  dirty.setItem("mr-shortcuts-enabled", "yes");
  sanitizeStorage(dirty);
  assert.equal(dirty.getItem("mr-skin"), null);
  assert.equal(dirty.getItem("mr-shortcuts-enabled"), null);
});

test("backup preferences migrate the skin but never custom icon data", () => {
  const source = read("src/features/backup/preferences.ts");
  assert.match(source, /"mr-skin"/);
  assert.doesNotMatch(source, /"mr-brand-icon"/);
});

test("SQLite backup whitelist carries the close-to-tray preference", () => {
  const source = read("src-tauri/src/backup.rs");
  assert.match(source, /"close_to_tray"/);
});

test("tray icon failures have stable localized codes", () => {
  const localize = read("src/features/errors/localize.ts");
  const tray = read("src-tauri/src/tray.rs");
  for (const code of ["tray-icon-invalid", "tray-icon-too-large"]) {
    assert.match(tray, new RegExp(`"${code}"`));
    assert.match(localize, new RegExp(`code: "${code}"`));
  }
  assert.match(localize, /"error\.trayIconInvalid"/);
  const common = read("src/i18n/messages/common.ts");
  assert.equal(
    (common.match(/"error\.trayIconInvalid"/g) || []).length,
    6,
    "tray icon error text must exist in all six dictionaries",
  );
});

test("mobile web reader exposes six complete dictionaries", () => {
  const locales = Object.keys(webReaderMessages);
  assert.deepEqual(locales.sort(), ["en", "es", "ja", "ko", "zh-CN", "zh-TW"]);
  const base = webReaderMessages.en;
  for (const locale of locales) {
    const table = webReaderMessages[locale];
    assert.deepEqual(Object.keys(table).sort(), Object.keys(base).sort(), locale);
    for (const key of Object.keys(base)) {
      assert.equal(typeof table[key], "string", `${locale}.${key}`);
      assert.ok(table[key].trim().length > 0, `${locale}.${key} is empty`);
      const expected = [...base[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const actual = [...table[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(actual, expected, `${locale}.${key} placeholders`);
    }
  }
});
