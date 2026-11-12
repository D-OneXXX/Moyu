import { test } from "node:test";
import assert from "node:assert/strict";
import { workflow } from "./contract-helpers.mjs";

test("CI and QA share only the trusted debug cache key", () => {
  for (const name of ["ci.yml", "qa-l2.yml"]) {
    const text = workflow(name);
    assert.match(text, /prefix-key: v2-moyu-trusted-debug/);
    assert.match(text, /shared-key: desktop-debug-v1/);
    assert.match(text, /cache-bin: false/);
    assert.match(text, /ImageOS CARGO_BUILD_TARGET CARGO_ENCODED_RUSTFLAGS CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG/);
  }
  const ci = workflow("ci.yml");
  const qa = workflow("qa-l2.yml");
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /github\.event_name == 'workflow_dispatch' && github\.actor == github\.repository_owner/);
  assert.match(qa, /save-if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(ci, /push:\s*\n\s*branches: \[main\]/);
  assert.match(ci, /merge_group:/);
  assert.match(qa, /merge_group:/);
});
