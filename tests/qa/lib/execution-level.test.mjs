import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  E2E_SUITE_IDS,
  L3_AUTHORIZATION_ENV,
  classifyQaExecution,
  formatAuthorizationError,
} from "./execution-level.mjs";
import {
  createReport,
  writeJsonReport,
  writeMarkdownReport,
} from "./report.mjs";

const QA_LIB = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(QA_LIB, "..", "..", "..");

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

test("only the explicit environment flag authorizes a local L3 run", () => {
  const plan = classifyQaExecution({
    e2e: true,
    env: { [L3_AUTHORIZATION_ENV]: "1" },
  });
  assert.equal(plan.level, "L3");
  assert.equal(plan.authorization.granted, true);
  assert.equal(plan.authorization.source, L3_AUTHORIZATION_ENV);
  for (const value of ["0", "true", "yes", ""]) {
    const denied = classifyQaExecution({
      e2e: true,
      env: { [L3_AUTHORIZATION_ENV]: value },
    });
    assert.equal(denied.authorization.granted, false, `值 ${JSON.stringify(value)} 不得视为授权`);
  }
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
    () => classifyQaExecution({ e2e: true, env: { MR_QA_EXECUTION_LEVEL: "L9" } }),
    /MR_QA_EXECUTION_LEVEL/,
  );
  assert.throws(
    () => classifyQaExecution({ e2e: true, env: { MR_QA_EXECUTION_LEVEL: "L0" } }),
    /L0/,
  );
  assert.throws(
    () => classifyQaExecution({ e2e: true, env: { MR_QA_EXECUTION_LEVEL: "L1" } }),
    /L1/,
  );
  assert.throws(
    () => classifyQaExecution({ e2e: false, env: { MR_QA_EXECUTION_LEVEL: "L3" } }),
    /static/i,
  );
});

test("the authorization error explains the required flag and the L2 alternative", () => {
  const plan = classifyQaExecution({ e2e: true, env: {} });
  const message = formatAuthorizationError(plan);
  assert.match(message, /MR_QA_L3_AUTHORIZED=1/);
  assert.match(message, /MR_QA_EXECUTION_LEVEL=L2/);
  assert.match(message, /L3/);
});

test("the runner refuses an unauthorized GUI suite with exit code 2 before starting the app", () => {
  const env = { ...process.env };
  delete env[L3_AUTHORIZATION_ENV];
  delete env.MR_QA_EXECUTION_LEVEL;
  delete env.CI;
  const reportFile = path.join(REPO_ROOT, "tests/qa/reports/latest.json");
  const before = fs.existsSync(reportFile) ? fs.statSync(reportFile).mtimeMs : null;

  // 只做门禁判定：--suite=visual 属于 E2E，必须在 cleanArtifacts 与启动应用之前退出。
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "tests/qa/run-qa.mjs"), "--suite=visual"],
    { cwd: REPO_ROOT, encoding: "utf8", env, timeout: 60000 },
  );

  assert.equal(result.status, 2, `stderr=${result.stderr}`);
  assert.match(result.stderr, /MR_QA_L3_AUTHORIZED=1/);
  assert.doesNotMatch(result.stdout, /\[qa\] running/);
  assert.doesNotMatch(result.stdout, /Moyu QA/);
  const after = fs.existsSync(reportFile) ? fs.statSync(reportFile).mtimeMs : null;
  assert.equal(after, before, "未授权运行不得写出 QA 报告");
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
    assert.equal(json.execution.authorization.source, L3_AUTHORIZATION_ENV);
    assert.deepEqual(json.execution.processes, plan.processes);
    assert.deepEqual(json.execution.ports, [1420, 9334]);
    assert.equal(json.execution.cleanup, "completed");
    assert.deepEqual(json.execution.deferredSuites, []);
    assert.match(md, /执行级别：\*\*L3\*\*（interactive）/);
    assert.match(md, /授权：required=yes · granted=no · source=MR_QA_L3_AUTHORIZED/);
    assert.match(md, /创建进程：vite dev server/);
    assert.match(md, /监听端口：1420；9334/);
    assert.match(md, /清理结果：completed/);
    assert.match(md, /延后\/阻塞套件：无/);
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
    assert.match(md, new RegExp(`延后/阻塞套件：${E2E_SUITE_IDS.join("；")}`));
    assert.match(md, /清理结果：not-required/);
    assert.match(md, /监听端口：无/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
