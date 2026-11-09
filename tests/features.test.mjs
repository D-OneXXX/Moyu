import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const registrySource = read("src/features/features.ts");
const rustSource = read("src-tauri/src/features.rs");
const messages = [
  "src/i18n/messages/settings.ts",
  "src/i18n/messages/common.ts",
  "src/i18n/messages/opds.ts",
  "src/i18n/messages/updates.ts",
  "src/i18n/messages/resilience.ts",
]
  .map(read)
  .join("\n");

const registry = [
  ...registrySource.matchAll(
    /id:\s*"([^"]+)"[\s\S]*?settingKey:\s*"([^"]+)"[\s\S]*?mirrorKey:\s*"([^"]+)"[\s\S]*?defaultEnabled:\s*(true|false)[\s\S]*?titleKey:\s*"([^"]+)"[\s\S]*?descriptionKey:\s*"([^"]+)"/g,
  ),
].map((match) => ({
  id: match[1],
  settingKey: match[2],
  mirrorKey: match[3],
  defaultEnabled: match[4] === "true",
  titleKey: match[5],
  descriptionKey: match[6],
}));

test("registry has 9 unique features", () => {
  assert.equal(registry.length, 9);
  assert.equal(new Set(registry.map((feature) => feature.id)).size, 9);
  assert.equal(new Set(registry.map((feature) => feature.mirrorKey)).size, 9);
});

test("rust enum matches registry ids", () => {
  const block = rustSource.match(/pub enum FeatureId\s*\{([\s\S]*?)\}/)[1];
  const variants = [...block.matchAll(/^\s*([A-Z][A-Za-z0-9]*),/gm)].map(
    (match) => match[1],
  );
  const camel = (value) => value[0].toLowerCase() + value.slice(1);
  assert.deepEqual(
    variants.map(camel).sort(),
    registry.map((feature) => feature.id).sort(),
  );
});

test("defaults match contract", () => {
  const expected = {
    webtoon: true,
    online: false,
    browser: true,
    pdf: true,
    opds: true,
    webAccess: true,
    updates: true,
    backup: true,
    diagnostics: true,
  };
  for (const feature of registry) {
    assert.equal(feature.defaultEnabled, expected[feature.id], feature.id);
  }
});

test("mirror keys are registered in storage sanitizer", () => {
  const sanitizer = read("src/lib/storageSanitizer.ts");
  for (const feature of registry) {
    assert.match(
      sanitizer,
      new RegExp(`"${feature.mirrorKey}"`),
      feature.mirrorKey,
    );
  }
});

test("title and description keys exist in six languages", () => {
  for (const feature of registry) {
    for (const key of [feature.titleKey, feature.descriptionKey]) {
      const count = messages.split(`"${key}"`).length - 1;
      assert.equal(count, 6, `${key} expected 6 locale entries, got ${count}`);
    }
  }
});
