import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledgeBase, updateKnowledgeBase } from "./report.mjs";

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
