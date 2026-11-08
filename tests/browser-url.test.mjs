import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/pages/Browser.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("Browser.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "normalizeUrl");
assert.ok(fn);
const js = ts.transpile(fn.getText(file), { target: ts.ScriptTarget.ES2022 });
const normalize = runInNewContext(js + "; normalizeUrl", { URL });

test("accepts host and port while rejecting non-web schemes", () => {
  assert.equal(normalize("localhost:3000/path"), "https://localhost:3000/path");
  assert.equal(normalize("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(normalize("file:///etc/passwd"), "");
  assert.equal(normalize("javascript:alert(1)"), "");
});
