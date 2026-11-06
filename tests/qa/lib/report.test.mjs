import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadKnowledgeBase,
  suiteCompletionCheck,
  updateKnowledgeBase,
  writeMarkdownReport,
} from "./report.mjs";

test("missing knowledge base starts empty; malformed data fails without overwriting it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moyu-kb-"));
  try {
    const file = path.join(dir, "kb.json");
    assert.deepEqual(loadKnowledgeBase(file).defects, []);
    fs.writeFileSync(file, "{broken", "utf8");
    assert.throws(() => loadKnowledgeBase(file), SyntaxError);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only an executed passing QA case closes its own finding; failures reopen it", () => {
  const kb = { regressions: [{testId: "a", source: "qa-run"}, {testId: "b", source: "static"}], defects: [{testId: "a", status: "open"}, {testId: "b", status: "open"}, {testId: "c", status: "open"}] };
  const report = {runId: "first", checks: [{id: "a", status: "pass"}, {id: "b", status: "pass"}], defects: []};
  updateKnowledgeBase(kb, report);
  assert.deepEqual(kb.defects.map((d) => d.status), ["closed", "open", "open"]);
  updateKnowledgeBase(kb, {runId: "second", checks: [{id: "a", status: "fail"}], defects: [{id: "a", severity: "P1"}]});
  assert.equal(kb.defects[0].status, "open");
});

test("stale open defects are separated from the active backlog", () => {
  const kb = {
    schema: 1,
    updatedAt: null,
    regressions: [],
    defects: [
      {
        id: "old-p0",
        testId: "old-p0",
        title: "old",
        severity: "P0",
        status: "open",
        lastSeen: "2026-10-01T00-00-00-000Z",
      },
      {
        id: "recent-p1",
        testId: "recent-p1",
        title: "recent",
        severity: "P1",
        status: "open",
        lastSeen: "2026-11-06T00-00-00-000Z",
      },
      {
        id: "closed-p0",
        testId: "closed-p0",
        title: "closed",
        severity: "P0",
        status: "closed",
        lastSeen: "2026-10-01T00-00-00-000Z",
      },
    ],
  };
  updateKnowledgeBase(
    kb,
    { runId: "2026-11-07T00-00-00-000Z", checks: [], defects: [] },
    { now: Date.parse("2026-11-07T00:00:00Z"), staleAfterDays: 7 },
  );
  assert.equal(kb.defects[0].stale, true);
  assert.equal(kb.defects[1].stale, false);
  assert.equal(kb.defects[2].stale, undefined);

  const report = {
    runId: "2026-11-07T00-00-00-000Z",
    appVersion: "0.0.0",
    buildCommit: "test",
    startedAt: "2026-11-07T00:00:00Z",
    finishedAt: "2026-11-07T00:01:00Z",
    checks: [],
    defects: [],
    notes: [],
    knowledgeBase: {},
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moyu-report-"));
  try {
    const file = path.join(dir, "report.md");
    writeMarkdownReport(report, file, kb);
    const text = fs.readFileSync(file, "utf8");
    const [active, stale] = text.split("### 陈旧台账");
    assert.match(text, /静态审计 backlog：1 条/);
    assert.match(text, /陈旧待复验：1 条/);
    assert.doesNotMatch(active, /old-p0/);
    assert.match(stale, /old-p0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("suite completion check closes a previous :crashed ledger entry", () => {
  const check = suiteCompletionCheck({ id: "architecture", title: "架构宪法回归" });
  assert.equal(check.id, "architecture:crashed");
  assert.equal(check.suite, "architecture");
  assert.equal(check.pass, true);
  assert.match(check.title, /架构宪法回归/);
  assert.equal(
    suiteCompletionCheck({ id: "pdf", title: "PDF 渲染、进度与安全策略" }).title,
    "PDF 完整套件运行至结尾且未中断",
  );

  const kb = {
    regressions: [{ testId: "architecture:crashed", source: "qa-run" }],
    defects: [
      {
        id: "architecture:crashed",
        testId: "architecture:crashed",
        title: "架构宪法回归 执行中断",
        severity: "P0",
        status: "open",
        lastSeen: "2026-11-06T20-53-36-431Z",
      },
    ],
  };
  updateKnowledgeBase(
    kb,
    {
      runId: "2026-11-07T00-00-00-000Z",
      checks: [{ id: "architecture:crashed", status: "pass" }],
      defects: [],
    },
    { now: Date.parse("2026-11-07T00:00:00Z") },
  );
  assert.equal(kb.defects[0].status, "closed");
});
