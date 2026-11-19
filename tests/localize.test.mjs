import test from "node:test";
import assert from "node:assert/strict";
import {
  hasStableCode,
  isBareStableCode,
} from "../src/features/errors/stableCodes.ts";

test("hasStableCode matches Rust fullwidth stable codes", () => {
  assert.equal(
    hasStableCode("导入失败（archive-encrypted）", "archive-encrypted"),
    true,
  );
});

test("hasStableCode matches legacy halfwidth stable codes", () => {
  assert.equal(
    hasStableCode("failed (archive-encrypted)", "archive-encrypted"),
    true,
  );
});

test("isBareStableCode accepts only the exact kebab id", () => {
  assert.equal(isBareStableCode("skin-too-large", "skin-too-large"), true);
  assert.equal(isBareStableCode("  skin-too-large  ", "skin-too-large"), true);
  assert.equal(isBareStableCode("skin-too-large-extra", "skin-too-large"), false);
  assert.equal(
    isBareStableCode("图片超过 4 MiB（skin-too-large）", "skin-too-large"),
    false,
  );
});

test("hasStableCode requires exact code inside brackets", () => {
  assert.equal(hasStableCode("archive-encrypted", "archive-encrypted"), false);
  assert.equal(
    hasStableCode("（archive-encrypted-extra）", "archive-encrypted"),
    false,
  );
  assert.equal(hasStableCode("（other）", "archive-encrypted"), false);
});
