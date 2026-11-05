import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledgeBase } from "./report.mjs";

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
