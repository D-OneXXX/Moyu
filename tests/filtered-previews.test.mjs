import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

test("old preview requests cannot overwrite a changed item list", async () => {
  const source = readFileSync(new URL("../src/components/Reader/FilteredPagesSheet.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("FilteredPagesSheet.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (!effect && ts.isCallExpression(node) && node.expression.getText(file) === "useEffect") effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(effect);
  let state = null;
  const requests = [];
  const context = {
    open: true, bookId: "book", items: [{ url: "old" }],
    api: { getFilteredPreview: () => new Promise((resolve) => requests.push(resolve)) },
    setPreviewState: (update) => { state = typeof update === "function" ? update(state) : update; },
    Promise,
  };
  const start = runInNewContext(ts.transpile("(" + effect.getText(file) + ")"), context);
  const cleanup = start();
  cleanup();
  context.items = [{ url: "new" }];
  start();
  requests[1]({ dataUrl: "new-image" });
  requests[0]({ dataUrl: "old-image" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.previews[0], "new-image");
});
