import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const state = readFileSync(new URL("../src-tauri/src/state.rs", import.meta.url), "utf8");

test("sysinfo/chrono/tokio/jpeg-decoder use minimal features", () => {
  for (const dep of ["sysinfo", "chrono", "tokio", "jpeg-decoder"]) {
    const line = cargo
      .split("\n")
      .find((l) => l.startsWith(dep + " =") || l.startsWith(dep + "="));
    assert.ok(line && line.includes("default-features = false"), dep);
  }
});

test("AppState drops the unused reqwest::Client http field", () => {
  assert.ok(
    !/pub\s+http\s*:\s*reqwest::Client/.test(state),
    "state.rs must not declare the AppState.http field",
  );
});
