import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

test("reader back restores library scroll and navigates home", () => {
  const source = readFileSync(new URL("../src/pages/Reader.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "backToLibrary") declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(declaration?.initializer);
  const calls = [];
  const callback = runInNewContext(ts.transpile(declaration.initializer.getText(file)), {
    useCallback: (fn) => fn,
    requestScrollRestore: (path) => calls.push(["restore", path]),
    nav: (path) => calls.push(["navigate", path]),
  });
  callback();
  assert.deepEqual(calls, [["restore", "/"], ["navigate", "/"]]);
});
