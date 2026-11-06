/**
 * Validate a candidate's immutable identity using already fetched evidence.
 * This module does not create tags, releases, or perform network requests.
 * A caller must classify a missing ref separately from network/API failures.
 */
export function validateCandidateIdentity({ tag, commit, onMain, tagState, releaseState, rehearsal = false }) {
  const normalTag = typeof tag === "string" && /^v\d+\.\d+\.\d+(?:-linux-sec\d+)?$/.test(tag);
  const rehearsalTag = typeof tag === "string" && /^v0\.0\.0-rehearsal\d*$/.test(tag);
  if (rehearsal === true ? !rehearsalTag : rehearsal !== false || !normalTag) {
    throw new Error("candidate-tag-invalid");
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("candidate-commit-invalid");
  }
  if (onMain !== true) throw new Error("candidate-not-on-main");
  if (!tagState || !["missing", "present"].includes(tagState.state)) {
    throw new Error("candidate-tag-state-unknown");
  }
  if (tagState.state === "present" && tagState.commit !== commit) {
    throw new Error("candidate-tag-commit-mismatch");
  }
  if (!releaseState || !["missing", "draft"].includes(releaseState.state)) {
    throw new Error("candidate-release-state-invalid");
  }
  if (releaseState.state === "draft") {
    if (releaseState.tag !== tag) throw new Error("candidate-draft-tag-mismatch");
    // GitHub ignores target_commitish for an existing tag. Without a tag,
    // require the immutable full SHA rather than a moving branch name.
    if (tagState.state === "missing" && releaseState.targetCommitish !== commit) {
      throw new Error("candidate-draft-target-mismatch");
    }
  }
  return { tag, commit, tagExists: tagState.state === "present", draftExists: releaseState.state === "draft" };
}
