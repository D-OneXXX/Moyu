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

  const custom = new MemoryStorage();
  custom.setItem("mr-skin", "custom-123");
  custom.setItem("mr-shortcuts-enabled", "yes");
  sanitizeStorage(custom);
  assert.equal(
    custom.getItem("mr-skin"),
    "custom-123",
    "custom pack ids use the same lowercase kebab shape",
  );
  assert.equal(custom.getItem("mr-shortcuts-enabled"), null);

  const tooLong = new MemoryStorage();
  tooLong.setItem("mr-skin", "x".repeat(65));
  sanitizeStorage(tooLong);
  assert.equal(tooLong.getItem("mr-skin"), null);

  for (const invalid of ["Ink", "../ink", "ink/card", "ink skin"]) {
    const storage = new MemoryStorage();
    storage.setItem("mr-skin", invalid);
    sanitizeStorage(storage);
    assert.equal(storage.getItem("mr-skin"), null, invalid);
  }

  // Task 21-3: images live in app_data/skins; the legacy data-URL key must die.
  const legacy = new MemoryStorage();
  legacy.setItem("mr-skin-custom", JSON.stringify({ id: "custom-123" }));
  sanitizeStorage(legacy);
  assert.equal(legacy.getItem("mr-skin-custom"), null);
});

test("built-in presets are framed without floating artwork", () => {
  assert.equal(BUILTIN_SKINS[0].id, "default");
  assert.equal(BUILTIN_SKINS[0].tokens["--mr-skin-viewport-inset"], undefined);
  for (const skin of BUILTIN_SKINS.slice(1)) {
    assert.match(
      skin.tokens["--mr-skin-viewport-inset"],
      /^(\d+px)( \d+px){0,3}$/,
      skin.id,
    );
    assert.notEqual(skin.tokens["--mr-skin-viewport-inset"], "0px", skin.id);
    assert.ok(skin.tokens["--mr-skin-backdrop-image"], skin.id);
    assert.ok(skin.tokens["--mr-skin-frame-overlay"], skin.id);
    assert.equal(skin.backdrop, undefined, "built-ins must stay CSS-only");
    assert.equal(skin.frame, undefined, "built-ins must stay CSS-only");
  }
  const registry = read("src/features/skin/registry.ts");
  assert.doesNotMatch(registry, /\.svg/i);
  assert.doesNotMatch(registry, /floating|mascot/i);
});

test("backup preferences migrate skin and shortcut preferences", () => {
  const source = read("src/features/backup/preferences.ts");
  assert.match(source, /"mr-skin"/);
  assert.match(source, /"mr-shortcuts-enabled"/);
  assert.doesNotMatch(source, /"mr-brand-icon"/);
});

test("SQLite backup whitelist carries the close-to-tray preference", () => {
  const source = read("src-tauri/src/backup.rs");
  assert.match(source, /"close_to_tray"/);
});

test("backup confirmation failures have localized codes", () => {
  const localize = read("src/features/errors/localize.ts");
  assert.match(localize, /code: "backup-requires-confirmation"/);
  assert.match(localize, /"error\.backupRequiresConfirmation"/);
  const common = read("src/i18n/messages/common.ts");
  assert.equal(
    (common.match(/"error\.backupRequiresConfirmation"/g) || []).length,
    6,
    "backup confirmation text must exist in all six dictionaries",
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
