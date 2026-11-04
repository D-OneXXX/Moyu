import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  E2E_SUITE_IDS,
  classifyQaExecution,
  formatAuthorizationError,
} from "./execution-level.mjs";
import {
  createReport,
  writeJsonReport,
  writeMarkdownReport,
} from "./report.mjs";

test("static-only QA is L1 background and needs no authorization", () => {
  const plan = classifyQaExecution({ e2e: false, env: {} });
  assert.equal(plan.level, "L1");
  assert.equal(plan.backgroundOrInteractive, "background");
  assert.equal(plan.authorization.required, false);
  assert.equal(plan.authorization.granted, true);
  assert.deepEqual(plan.desktopInteraction, []);
  assert.deepEqual(plan.processes, []);
  assert.deepEqual(plan.ports, []);
  assert.deepEqual(plan.deferredSuites, E2E_SUITE_IDS);
});

test("local app-launching QA is L3 interactive and requires explicit authorization", () => {
  const plan = classifyQaExecution({ e2e: true, env: {}, cdpPort: 9444 });
  assert.equal(plan.level, "L3");
  assert.equal(plan.backgroundOrInteractive, "interactive");
  assert.equal(plan.authorization.required, true);
  assert.equal(plan.authorization.granted, false);
  assert.deepEqual(plan.ports, [1420, 9444]);
  assert.ok(plan.desktopInteraction.length > 0);
  assert.ok(plan.processes.length > 0);
  assert.deepEqual(plan.deferredSuites, []);
});

test("local L3 QA is authorized only by the explicit environment flag", () => {
  const plan = classifyQaExecution({
    e2e: true,
    env: { MR_QA_L3_AUTHORIZED: "1" },
  });
  assert.equal(plan.level, "L3");
  assert.equal(plan.authorization.granted, true);
  assert.equal(plan.authorization.source, "MR_QA_L3_AUTHORIZED");
});

test("hosted CI app-launching QA is L2 background", () => {
  const plan = classifyQaExecution({ e2e: true, env: { CI: "true" } });
  assert.equal(plan.level, "L2");
  assert.equal(plan.backgroundOrInteractive, "background");
  assert.equal(plan.authorization.required, false);
  assert.equal(plan.authorization.granted, true);
  assert.deepEqual(plan.desktopInteraction, []);
});

test("an operator may declare an isolated L2 environment explicitly", () => {
  const plan = classifyQaExecution({
    e2e: true,
    env: { MR_QA_EXECUTION_LEVEL: "L2" },
  });
  assert.equal(plan.level, "L2");
  assert.equal(plan.authorization.required, false);
  assert.equal(plan.authorization.source, "MR_QA_EXECUTION_LEVEL");
});

test("an explicit L3 override still requires authorization", () => {
  const plan = classifyQaExecution({
    e2e: true,
    env: { MR_QA_EXECUTION_LEVEL: "L3" },
  });
  assert.equal(plan.level, "L3");
  assert.equal(plan.authorization.granted, false);
});

test("invalid or impossible execution levels fail closed", () => {
  assert.throws(
    () =>
      classifyQaExecution({
        e2e: true,
        env: { MR_QA_EXECUTION_LEVEL: "L9" },
      }),
    /MR_QA_EXECUTION_LEVEL/,
  );
  assert.throws(
    () =>
      classifyQaExecution({
        e2e: true,
        env: { MR_QA_EXECUTION_LEVEL: "L0" },
      }),
    /L0/,
  );
  assert.throws(
    () =>
      classifyQaExecution({
        e2e: true,
        env: { MR_QA_EXECUTION_LEVEL: "L1" },
      }),
    /L1/,
  );
  assert.throws(
    () =>
      classifyQaExecution({
        e2e: false,
        env: { MR_QA_EXECUTION_LEVEL: "L3" },
      }),
    /static/i,
  );
});

test("the authorization error explains the required flag and L2 alternative", () => {
  const plan = classifyQaExecution({ e2e: true, env: {} });
  const message = formatAuthorizationError(plan);
  assert.match(message, /MR_QA_L3_AUTHORIZED=1/);
  assert.match(message, /MR_QA_EXECUTION_LEVEL=L2/);
  assert.match(message, /L3/);
});

test("QA JSON and Markdown reports carry the non-intrusive execution record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moyu-qa-report-"));
  try {
    const plan = classifyQaExecution({ e2e: true, env: {} });
    plan.cleanup = "completed";
    const report = createReport({
      root: "C:/repo",
      artifactDir: "C:/repo/tests/qa/artifacts/current",
      appVersion: "0.0.0",
      buildCommit: "deadbeef",
      execution: plan,
    });
    const jsonPath = path.join(dir, "latest.json");
    const mdPath = path.join(dir, "latest.md");
    writeJsonReport(report, jsonPath);
    writeMarkdownReport(report, mdPath);
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const md = fs.readFileSync(mdPath, "utf8");
    assert.equal(json.execution.level, "L3");
    assert.equal(json.execution.authorization.required, true);
    assert.equal(json.execution.authorization.granted, false);
    assert.equal(json.execution.cleanup, "completed");
    assert.match(md, /执行级别：\*\*L3\*\*（interactive）/);
    assert.match(md, /授权：required=yes · granted=no/);
    assert.match(md, /延后套件：无/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("static-only QA reports the deferred E2E suites instead of claiming coverage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moyu-qa-report-"));
  try {
    const plan = classifyQaExecution({ e2e: false, env: {} });
    const report = createReport({
      root: "C:/repo",
      artifactDir: "C:/repo/tests/qa/artifacts/current",
      appVersion: "0.0.0",
      buildCommit: "deadbeef",
      execution: plan,
    });
    const mdPath = path.join(dir, "latest.md");
    writeMarkdownReport(report, mdPath);
    const md = fs.readFileSync(mdPath, "utf8");
    assert.match(md, /执行级别：\*\*L1\*\*（background）/);
    assert.match(md, new RegExp(`延后套件：${E2E_SUITE_IDS.join("；")}`));
    assert.match(md, /清理结果：not-required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
