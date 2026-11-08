import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BRAND_DISPLAY_NAME,
  LOCALES,
  RELEASE_ANCHORS,
  collectReleaseSurfaceViolations,
} from "../scripts/release-surface.mjs";

/**
 * static:release-surface 守卫的负向测试。
 *
 * 守卫的价值在于「漂移时必须失败」：这里逐条注入漂移样本，确认它真的会
 * 拦下来，而不是永远返回通过。
 */
function localeTable(overrides = {}) {
  const table = {
    "app.title": `${BRAND_DISPLAY_NAME} · Library`,
    "nav.brand": `${BRAND_DISPLAY_NAME} library`,
    ...overrides,
  };
  const messages = {};
  for (const locale of LOCALES) messages[locale] = { ...table };
  return messages;
}

function tauriConfig(overrides = {}) {
  return {
    productName: RELEASE_ANCHORS.productName,
    identifier: RELEASE_ANCHORS.identifier,
    mainBinaryName: RELEASE_ANCHORS.mainBinaryName,
    app: { windows: [{ title: BRAND_DISPLAY_NAME }] },
    ...overrides,
  };
}

test("a consistent surface passes the guard", () => {
  const violations = collectReleaseSurfaceViolations({
    localeMessages: localeTable(),
    tauriConfig: tauriConfig(),
  });
  assert.deepEqual(violations, []);
});

test("a drifted upgrade identity is rejected", () => {
  const violations = collectReleaseSurfaceViolations({
    localeMessages: localeTable(),
    tauriConfig: tauriConfig({ productName: "MoyuReader" }),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /productName/);
});

test("a drifted window title is rejected", () => {
  const violations = collectReleaseSurfaceViolations({
    localeMessages: localeTable(),
    tauriConfig: tauriConfig({
      app: { windows: [{ title: "MangaReader" }] },
    }),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /title/);
});

test("a locale that drops the brand name is rejected", () => {
  const messages = localeTable();
  messages.ko["nav.brand"] = "서재";
  const violations = collectReleaseSurfaceViolations({
    localeMessages: messages,
    tauriConfig: tauriConfig(),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ko/);
  assert.match(violations[0], /nav\.brand/);
});

test("a locale that still ships the old brand name is rejected", () => {
  const messages = localeTable();
  messages.es["app.title"] = `${BRAND_DISPLAY_NAME} · MangaReader`;
  const violations = collectReleaseSurfaceViolations({
    localeMessages: messages,
    tauriConfig: tauriConfig(),
  });
  assert.ok(violations.length >= 1);
  assert.match(violations[0], /MangaReader/);
});

test("a missing locale is rejected", () => {
  const messages = localeTable();
  delete messages.ja;
  const violations = collectReleaseSurfaceViolations({
    localeMessages: messages,
    tauriConfig: tauriConfig(),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ja/);
});
