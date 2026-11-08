import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/web/CapabilityProbe.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("CapabilityProbe.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "visits") callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(callback);
const js = ts.transpile("(" + callback.getText(file) + ")");

test("visit counter tolerates storage reads and writes that throw", () => {
  assert.equal(runInNewContext(js, { localStorage: {
    getItem() { throw Error("denied"); }, setItem() {},
  } })(), 1);
  assert.equal(runInNewContext(js, { localStorage: {
    getItem() { return "3"; }, setItem() { throw Error("denied"); },
  } })(), 4);
  let saved;
  assert.equal(runInNewContext(js, { localStorage: {
    getItem: () => "3", setItem: (_, value) => { saved = value; },
  } })(), 4);
  assert.equal(saved, "4");
});
