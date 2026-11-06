import { spawnSync } from "node:child_process";
import { validateCandidateIdentity } from "./candidate-identity.mjs";
import { classifyReleaseView } from "./release-guard.mjs";

// Commands are executed without a shell. Callers must fetch origin/main and
// its history first; an incomplete history fails ancestry validation closed.
export function collectCandidateEvidence({ tag, commit, rehearsal = false, requireDraft = false, run = spawnSync }) {
  if (typeof tag !== "string" || !/^v[0-9A-Za-z.-]+$/.test(tag)) throw new Error("candidate-tag-invalid");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("candidate-commit-invalid");
  const invoke = (program, args) => {
    const result = run(program, args, { encoding: "utf8", timeout: 30000 });
    if (result.error || typeof result.status !== "number") throw new Error("candidate-command-failed");
    return result;
  };
  const ancestry = invoke("git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
  if (ancestry.status !== 0 && ancestry.status !== 1) throw new Error("candidate-ancestry-unknown");
  const baseRef = `refs/tags/${tag}`;
  const tagResult = invoke("git", ["ls-remote", "--exit-code", "origin", baseRef, `${baseRef}^{}`]);
  let tagState;
  if (tagResult.status === 2 && !String(tagResult.stdout).trim() && !String(tagResult.stderr).trim()) {
    tagState = { state: "missing" };
  } else if (tagResult.status === 0) {
    const rows = String(tagResult.stdout).trim().split(/\r?\n/).map((line) => line.split(/\s+/));
    const refs = new Map();
    for (const [sha, ref, extra] of rows) {
      if (extra !== undefined || !/^[0-9a-f]{40}$/.test(sha) || ![baseRef, `${baseRef}^{}`].includes(ref) || refs.has(ref)) {
        throw new Error("candidate-tag-state-unknown");
      }
      refs.set(ref, sha);
    }
    if (!refs.has(baseRef)) throw new Error("candidate-tag-state-unknown");
    tagState = { state: "present", commit: refs.get(`${baseRef}^{}`) ?? refs.get(baseRef) };
  } else throw new Error("candidate-tag-state-unknown");

  const release = invoke("gh", ["release", "view", tag, "--json", "isDraft,tagName,targetCommitish"]);
  let releaseState;
  if (release.status === 0) {
    let data;
    try { data = JSON.parse(release.stdout); } catch { throw new Error("candidate-release-state-invalid"); }
    if (data.isDraft !== true || typeof data.tagName !== "string" || typeof data.targetCommitish !== "string") {
      throw new Error("candidate-release-state-invalid");
    }
    releaseState = { state: "draft", tag: data.tagName, targetCommitish: data.targetCommitish };
  } else if (classifyReleaseView({ status: release.status, stdout: release.stdout, stderr: release.stderr }) === "missing") {
    releaseState = { state: "missing" };
  } else throw new Error("candidate-release-state-invalid");

  const identity = validateCandidateIdentity({ tag, commit, onMain: ancestry.status === 0, tagState, releaseState, rehearsal });
  if (requireDraft && !identity.draftExists) throw new Error("candidate-draft-required");
  return identity;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  try {
    const result = collectCandidateEvidence({
      tag: process.env.CANDIDATE_TAG,
      commit: process.env.CANDIDATE_COMMIT,
      rehearsal: process.env.CANDIDATE_REHEARSAL === "true",
      requireDraft: process.env.CANDIDATE_REQUIRE_DRAFT === "true",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`[candidate-evidence] ${error.message}`);
    process.exitCode = 1;
  }
}
