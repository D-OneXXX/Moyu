import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCandidateIdentity } from "./candidate-identity.mjs";

const commit = "a".repeat(40);
const base = () => ({ tag: "v0.19.1", commit, onMain: true, tagState: { state: "missing" }, releaseState: { state: "missing" } });

test("candidate can be bound to a full main commit before a tag exists", () => {
  assert.deepEqual(validateCandidateIdentity(base()), { tag: "v0.19.1", commit, tagExists: false, draftExists: false });
});

test("an absent tag requires an existing draft to target the same immutable SHA", () => {
  const input = base();
  input.releaseState = { state: "draft", tag: input.tag, targetCommitish: commit };
  assert.equal(validateCandidateIdentity(input).draftExists, true);
  input.releaseState.targetCommitish = "main";
  assert.throws(() => validateCandidateIdentity(input), /candidate-draft-target-mismatch/);
});

test("an existing tag must point to the exact candidate commit", () => {
  const input = base();
  input.tagState = { state: "present", commit };
  assert.equal(validateCandidateIdentity(input).tagExists, true);
  input.tagState.commit = "b".repeat(40);
  assert.throws(() => validateCandidateIdentity(input), /candidate-tag-commit-mismatch/);
});

test("unknown states, published releases, mutable refs, and non-main commits fail closed", () => {
  for (const patch of [
    { tagState: { state: "unknown" } },
    { releaseState: { state: "published" } },
    { commit: "main" },
    { onMain: false },
    { tag: "v0.19.1; echo invalid" },
  ]) assert.throws(() => validateCandidateIdentity({ ...base(), ...patch }));
});

test("an existing draft must belong to the requested tag", () => {
  const input = base();
  input.releaseState = { state: "draft", tag: "v0.19.2", targetCommitish: commit };
  assert.throws(() => validateCandidateIdentity(input), /candidate-draft-tag-mismatch/);
});

test("rehearsal labels require an explicit rehearsal mode", () => {
  const input = { ...base(), tag: "v0.0.0-rehearsal2" };
  assert.throws(() => validateCandidateIdentity(input), /candidate-tag-invalid/);
  assert.equal(validateCandidateIdentity({ ...input, rehearsal: true }).tag, input.tag);
  assert.throws(() => validateCandidateIdentity({ ...base(), rehearsal: true }), /candidate-tag-invalid/);
});
