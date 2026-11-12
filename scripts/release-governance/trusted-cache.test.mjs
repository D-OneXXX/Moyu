import { test } from "node:test";
import assert from "node:assert/strict";
import { workflow } from "./contract-helpers.mjs";

test("PR and main Rust caches have explicit scoped keys and release isolation", () => {
  for (const name of ["ci.yml", "qa-l2.yml"]) {
    const text = workflow(name);
    assert.match(text, /actions\/cache\/restore@/);
    assert.match(text, /actions\/cache\/save@/);
    assert.match(text, /moyu-v3-/);
    assert.match(text, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/);
    assert.match(text, /github\.event\.pull_request\.head\.sha \|\| github\.sha/);
    assert.match(text, /-main-/);
    assert.match(text, /github\.event_name != 'merge_group'/);
    assert.match(text, /CARGO_INCREMENTAL: 0/);
    assert.match(text, /merge_group:/);
  }
  const full = workflow("qa-full.yml");
  assert.match(full, /prefix-key: v3-release-qa-trusted/);
  assert.match(full, /steps\.source\.outputs\.sha == github\.sha/);
  assert.match(full, /github\.ref == 'refs\/heads\/main'/);
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    assert.doesNotMatch(workflow(name), /moyu-v3-/);
  }
});
