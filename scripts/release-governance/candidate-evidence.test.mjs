import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCandidateEvidence } from "./candidate-evidence.mjs";

const commit = "a".repeat(40);
const tag = "v0.19.1";
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const absentTag = { status: 2, stdout: "", stderr: "" };
const absentRelease = { status: 1, stdout: "", stderr: "release not found" };
const makeRun = (ancestry, tags, release) => {
  const calls = [];
  return Object.assign((program, args) => {
    calls.push([program, args]);
    return program === "gh" ? release : args[0] === "merge-base" ? ancestry : tags;
  }, { calls });
};

test("missing tag and missing draft are separately established", () => {
  const run = makeRun(ok(), absentTag, absentRelease);
  assert.deepEqual(collectCandidateEvidence({ tag, commit, run }), { tag, commit, tagExists: false, draftExists: false });
  assert.equal(run.calls.length, 3);
  assert.deepEqual(run.calls[1][1].slice(0, 3), ["ls-remote", "--exit-code", "origin"]);
});

test("annotated tags use the peeled commit instead of the tag object", () => {
  const refs = `${"b".repeat(40)}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`;
  const draft = ok(JSON.stringify({ isDraft: true, tagName: tag, targetCommitish: "main" }));
  const result = collectCandidateEvidence({ tag, commit, run: makeRun(ok(), ok(refs), draft) });
  assert.equal(result.tagExists, true);
  assert.equal(result.draftExists, true);
});

test("network and authentication failures are never treated as missing", () => {
  assert.throws(() => collectCandidateEvidence({ tag, commit, run: makeRun(ok(), { status: 128, stdout: "", stderr: "network down" }, absentRelease) }), /candidate-tag-state-unknown/);
  assert.throws(() => collectCandidateEvidence({ tag, commit, run: makeRun(ok(), absentTag, { status: 1, stdout: "", stderr: "HTTP 403" }) }), /candidate-release-state-invalid/);
  assert.throws(() => collectCandidateEvidence({ tag, commit, run: makeRun(ok(), absentTag, ok("not-json")) }), /candidate-release-state-invalid/);
});

test("a draft without a tag must use the exact commit and public releases fail", () => {
  for (const metadata of [
    { isDraft: true, tagName: tag, targetCommitish: "main" },
    { isDraft: false, tagName: tag, targetCommitish: commit },
  ]) assert.throws(() => collectCandidateEvidence({ tag, commit, run: makeRun(ok(), absentTag, ok(JSON.stringify(metadata))) }));
});

test("unexpected, duplicated, and missing ref lines fail closed", () => {
  for (const refs of [
    `${commit}\trefs/tags/other\n`,
    `${commit}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}\n`,
    `${commit}\trefs/tags/${tag}^{}\n`,
  ]) assert.throws(() => collectCandidateEvidence({ tag, commit, run: makeRun(ok(), ok(refs), absentRelease) }), /candidate-tag-state-unknown/);
});
