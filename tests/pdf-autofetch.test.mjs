import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("pdf document disables progressive auto-fetch", () => {
  const src = readFileSync(
    new URL("../src/features/pdf/document.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /disableAutoFetch:\s*true/);
  assert.doesNotMatch(src, /disableAutoFetch:\s*false/);
});
