import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BRAND_ICON_PRESETS,
  BRAND_ICON_STORAGE_KEY,
  DEFAULT_BRAND_ICON,
  MAX_CUSTOM_ICON_DATA_URL_CHARS,
  clearBrandIconSelection,
  isBrandIconSelection,
  readBrandIconSelection,
  writeBrandIconSelection,
} from "../src/features/brand/brandIcon.ts";
import {
  sanitizeStorage,
} from "../src/lib/storageSanitizer.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

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

test("brand icon presets are unique and default to the open book", () => {
  assert.deepEqual(
    [...BRAND_ICON_PRESETS],
    ["book", "fish", "moon", "wave"],
  );
  assert.equal(new Set(BRAND_ICON_PRESETS).size, BRAND_ICON_PRESETS.length);
  assert.deepEqual(DEFAULT_BRAND_ICON, { kind: "preset", preset: "book" });
});

test("selection validator accepts presets and raster data URLs only", () => {
  assert.equal(
    isBrandIconSelection({ kind: "preset", preset: "fish" }),
    true,
  );
  assert.equal(
    isBrandIconSelection({ kind: "custom", dataUrl: PNG_DATA_URL }),
    true,
  );
  assert.equal(
    isBrandIconSelection({ kind: "preset", preset: "unknown" }),
    false,
  );
  assert.equal(
    isBrandIconSelection({
      kind: "custom",
      dataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
    }),
    false,
  );
  assert.equal(
    isBrandIconSelection({
      kind: "custom",
      dataUrl: `data:image/png;base64,${"A".repeat(
        MAX_CUSTOM_ICON_DATA_URL_CHARS,
      )}`,
    }),
    false,
  );
  assert.equal(isBrandIconSelection({ kind: "custom" }), false);
  assert.equal(isBrandIconSelection(null), false);
});

test("read/write/clear round-trip uses localStorage-shaped storage", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readBrandIconSelection(storage), DEFAULT_BRAND_ICON);

  const custom = { kind: "custom", dataUrl: PNG_DATA_URL };
  assert.equal(writeBrandIconSelection(custom, storage), true);
  assert.deepEqual(readBrandIconSelection(storage), custom);

  storage.setItem(BRAND_ICON_STORAGE_KEY, "{broken");
  assert.deepEqual(readBrandIconSelection(storage), DEFAULT_BRAND_ICON);

  storage.setItem(
    BRAND_ICON_STORAGE_KEY,
    JSON.stringify({ kind: "preset", preset: "nope" }),
  );
  assert.deepEqual(readBrandIconSelection(storage), DEFAULT_BRAND_ICON);

  assert.equal(clearBrandIconSelection(storage), true);
  assert.equal(storage.getItem(BRAND_ICON_STORAGE_KEY), null);
  assert.deepEqual(readBrandIconSelection(storage), DEFAULT_BRAND_ICON);
});

test("brand icon preference is registered in the storage sanitizer", () => {
  const sanitizer = read("src/lib/storageSanitizer.ts");
  assert.match(sanitizer, /"mr-brand-icon"/);
  assert.match(sanitizer, /canonicalBrandIcon/);
});

test("storage sanitizer keeps valid brand icons and drops invalid schemas", () => {
  const storage = new MemoryStorage();
  const valid = JSON.stringify({ kind: "custom", dataUrl: PNG_DATA_URL });
  storage.setItem(BRAND_ICON_STORAGE_KEY, valid);
  sanitizeStorage(storage);
  assert.equal(storage.getItem(BRAND_ICON_STORAGE_KEY), valid);

  storage.setItem(
    BRAND_ICON_STORAGE_KEY,
    JSON.stringify({
      kind: "custom",
      dataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
    }),
  );
  sanitizeStorage(storage);
  assert.equal(storage.getItem(BRAND_ICON_STORAGE_KEY), null);
});

test("BrandLogo renders the dynamic AppBrandIcon and the Moyu wordmark", () => {
  const logo = read("src/components/shell/BrandLogo.tsx");
  assert.match(logo, /AppBrandIcon/);
  assert.match(logo, /Mo<span className="text-primary">yu<\/span>/);
  assert.doesNotMatch(logo, /MangaReader/);
});

test("window title is Moyu while installer identity stays MangaReader", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(conf.productName, "MangaReader");
  assert.equal(conf.identifier, "com.local.manga-reader");
  assert.equal(conf.mainBinaryName, "manga-reader-tauri");
  assert.equal(conf.app.windows[0].title, "Moyu");
  assert.equal(conf.bundle.fileAssociations[0].description, "Moyu Comic Archive");
  assert.equal(conf.bundle.fileAssociations[1].description, "Moyu ZIP Archive");
  assert.match(read("src/components/shell/AppShell.tsx"), /setTitle\("Moyu"\)/);
});

test("six language blocks expose every brand icon key", () => {
  const messages = read("src/i18n/messages/settings.ts");
  const keys = [
    "settings.brandIcon.title",
    "settings.brandIcon.description",
    "settings.brandIcon.current",
    "settings.brandIcon.groupLabel",
    "settings.brandIcon.presetBook",
    "settings.brandIcon.presetFish",
    "settings.brandIcon.presetMoon",
    "settings.brandIcon.presetWave",
    "settings.brandIcon.upload",
    "settings.brandIcon.replace",
    "settings.brandIcon.reset",
    "settings.brandIcon.customActive",
    "settings.brandIcon.hint",
    "settings.brandIcon.errorType",
    "settings.brandIcon.errorSize",
    "settings.brandIcon.errorDimension",
    "settings.brandIcon.errorRead",
    "settings.brandIcon.errorSave",
  ];
  for (const key of keys) {
    const escaped = key.replace(/\./g, "\\.");
    const count = (messages.match(new RegExp(`"${escaped}"`, "g")) ?? []).length;
    assert.equal(count, 6, `${key} 必须覆盖六套语言`);
  }
});
