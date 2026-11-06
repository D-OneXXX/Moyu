import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectPublishIdentity,
  parseReleaseView,
  validatePublishIdentity,
} from "./publish-identity.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const sha256 = "c".repeat(64);

function record(overrides = {}) {
  return {
    kind: "manga-reader.release-candidate",
    rehearsal: false,
    version: "0.19.1",
    tag: "v0.19.1",
    commit,
    channel: "windows",
    platform: "windows-x86_64",
    qa: { runId: "123", buildCommit: commit },
    artifacts: [{ name: "Moyu_0.19.1_x64-setup.exe", sha256, size: 1 }],
    ...overrides,
  };
}

function valid(overrides = {}) {
  return {
    tag: "v0.19.1",
    channel: "windows",
    version: "0.19.1",
    commit,
    onMain: true,
    tagState: { state: "present", commit },
    releaseState: { state: "draft", tag: "v0.19.1", targetCommitish: commit },
    ...overrides,
  };
}

function fakeRun({ ancestry = 0, tagSha = commit, missingTag = false, tag = "v0.19.1" } = {}) {
  return (program, args) => {
    assert.equal(program, "git");
    if (args[0] === "merge-base") return { status: ancestry, stdout: "", stderr: "" };
    if (args[0] === "ls-remote") {
      if (missingTag) return { status: 2, stdout: "", stderr: "" };
      const ref = `refs/tags/${tag}`;
      return {
        status: 0,
        stdout: `${tagSha}\t${ref}\n${tagSha}\t${ref}^{}\n`,
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
}

test("正式发布要求标签已存在并指向候选提交（Windows 与 Linux）", () => {
  assert.deepEqual(validatePublishIdentity(valid()), {
    tag: "v0.19.1",
    channel: "windows",
    version: "0.19.1",
    commit,
    tagExists: true,
    releaseState: "draft",
  });
  assert.equal(
    validatePublishIdentity(
      valid({
        tag: "v0.19.1-linux-sec1",
        channel: "linux-critical",
        releaseState: { state: "draft", tag: "v0.19.1-linux-sec1", targetCommitish: commit },
      }),
    ).channel,
    "linux-critical",
  );
});

test("标签缺失时失败关闭，并给出维护者受控创建标签的说明", () => {
  assert.throws(
    () => validatePublishIdentity(valid({ tagState: { state: "missing" } })),
    (error) =>
      /publish-tag-missing/.test(error.message) &&
      error.message.includes(commit) &&
      error.message.includes("维护者") &&
      error.message.includes("不得用 GITHUB_TOKEN"),
  );
});

test("标签指向别的提交、标签与通道不匹配、版本不一致都必须拒绝", () => {
  assert.throws(() => validatePublishIdentity(valid({ tagState: { state: "present", commit: otherCommit } })), /publish-tag-commit-mismatch/);
  assert.throws(() => validatePublishIdentity(valid({ tag: "v0.19.1-linux-sec1" })), /publish-tag-invalid/);
  assert.throws(() => validatePublishIdentity(valid({ version: "0.19.0" })), /publish-version-mismatch/);
});

test("Draft 的 target_commitish 必须是完整候选 SHA，不得是可变分支", () => {
  assert.throws(
    () => validatePublishIdentity(valid({ releaseState: { state: "draft", tag: "v0.19.1", targetCommitish: "main" } })),
    /publish-draft-target-mismatch/,
  );
  assert.throws(
    () => validatePublishIdentity(valid({ releaseState: { state: "draft", tag: "v0.19.1", targetCommitish: otherCommit } })),
    /publish-draft-target-mismatch/,
  );
});

test("已公开 Release 的幂等重跑以不可变标签绑定；另一 SHA 仍拒绝", () => {
  assert.equal(
    validatePublishIdentity(valid({ releaseState: { state: "published", tag: "v0.19.1", targetCommitish: "main" } }))
      .releaseState,
    "published",
  );
  assert.throws(
    () =>
      validatePublishIdentity(
        valid({ releaseState: { state: "published", tag: "v0.19.1", targetCommitish: otherCommit } }),
      ),
    /publish-draft-target-mismatch/,
  );
});

test("Release 状态、标签名与 commit / main 归属均失败关闭", () => {
  assert.throws(() => validatePublishIdentity(valid({ onMain: false })), /publish-not-on-main/);
  assert.throws(() => validatePublishIdentity(valid({ commit: "main" })), /publish-commit-invalid/);
  assert.throws(
    () => validatePublishIdentity(valid({ releaseState: { state: "missing", tag: "v0.19.1", targetCommitish: commit } })),
    /publish-release-state-invalid/,
  );
  assert.throws(
    () => validatePublishIdentity(valid({ releaseState: { state: "draft", tag: "v0.19.2", targetCommitish: commit } })),
    /publish-release-tag-mismatch/,
  );
  assert.throws(
    () => validatePublishIdentity(valid({ releaseState: { state: "draft", tag: "v0.19.1", targetCommitish: "" } })),
    /publish-draft-target-invalid/,
  );
  assert.throws(() => validatePublishIdentity(valid({ tagState: { state: "unknown" } })), /publish-tag-state-unknown/);
});

test("gh release view 输出必须结构完整", () => {
  assert.deepEqual(parseReleaseView({ isDraft: true, tagName: "v0.19.1", targetCommitish: commit }), {
    state: "draft",
    tag: "v0.19.1",
    targetCommitish: commit,
  });
  for (const data of [
    null,
    {},
    { isDraft: "true", tagName: "v0.19.1", targetCommitish: commit },
    { isDraft: true, targetCommitish: commit },
    { isDraft: true, tagName: "v0.19.1" },
  ]) {
    assert.throws(() => parseReleaseView(data), /publish-release-state-invalid/);
  }
});

test("collectPublishIdentity 读取 RC 记录并复核标签、main 归属与 Draft 绑定", () => {
  const identity = collectPublishIdentity({
    tag: "v0.19.1",
    channel: "windows",
    record: record(),
    release: { isDraft: true, tagName: "v0.19.1", targetCommitish: commit },
    run: fakeRun(),
  });
  assert.equal(identity.commit, commit);
  assert.equal(identity.releaseState, "draft");

  assert.throws(
    () =>
      collectPublishIdentity({
        tag: "v0.19.1",
        channel: "windows",
        record: record(),
        release: { isDraft: true, tagName: "v0.19.1", targetCommitish: commit },
        run: fakeRun({ missingTag: true }),
      }),
    /publish-tag-missing/,
  );
  assert.throws(
    () =>
      collectPublishIdentity({
        tag: "v0.19.1",
        channel: "windows",
        record: record(),
        release: { isDraft: true, tagName: "v0.19.1", targetCommitish: commit },
        run: fakeRun({ tagSha: otherCommit }),
      }),
    /publish-tag-commit-mismatch/,
  );
  assert.throws(
    () =>
      collectPublishIdentity({
        tag: "v0.19.1",
        channel: "windows",
        record: record(),
        release: { isDraft: true, tagName: "v0.19.1", targetCommitish: commit },
        run: fakeRun({ ancestry: 1 }),
      }),
    /publish-not-on-main/,
  );
});

test("RC 记录的标签、提交或 QA 绑定不一致时拒绝", () => {
  assert.throws(
    () =>
      collectPublishIdentity({
        tag: "v0.19.1",
        channel: "windows",
        record: record({
          tag: "v0.19.1-linux-sec1",
          channel: "linux-critical",
          platform: "linux-x86_64",
        }),
        release: { isDraft: true, tagName: "v0.19.1", targetCommitish: commit },
        run: fakeRun(),
      }),
    /publish-record-tag-mismatch/,
  );
  assert.throws(
    () =>
      collectPublishIdentity({
        tag: "v0.19.1",
        channel: "windows",
        record: record({ qa: { runId: "123", buildCommit: otherCommit } }),
        release: { isDraft: true, tagName: "v0.19.1", targetCommitish: commit },
        run: fakeRun(),
      }),
    /publish-record-invalid/,
  );
});

test("CLI：本地标签存在时通过，标签被删除后失败关闭", (t) => {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).error) {
    t.skip("当前环境缺少 git，跳过发布身份 CLI 接线测试");
    return;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const script = path.join(repoRoot, "scripts", "release-governance", "publish-identity.mjs");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-publish-identity-"));
  const remote = path.join(workDir, "remote.git");
  const repo = path.join(workDir, "repo");
  const git = (cwd, args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr || result.stdout}`);
    return result;
  };

  try {
    git(workDir, ["init", "--bare", "--quiet", remote]);
    git(workDir, ["init", "--quiet", repo]);
    git(repo, ["config", "user.name", "Moyu Test"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(repo, "package.json"), '{"version":"0.19.1"}\n');
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "--quiet", "-m", "candidate"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "--quiet", "-u", "origin", "main"]);
    git(repo, ["tag", "-a", "v0.19.1", "-m", "release"]);
    git(repo, ["push", "--quiet", "origin", "v0.19.1"]);
    const commit = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

    const candidateRecord = record({ commit, qa: { runId: "123", buildCommit: commit } });
    fs.writeFileSync(path.join(repo, "record.json"), `${JSON.stringify(candidateRecord, null, 2)}\n`);
    fs.writeFileSync(
      path.join(repo, "release.json"),
      `${JSON.stringify({ isDraft: true, tagName: "v0.19.1", targetCommitish: commit })}\n`,
    );

    const run = () =>
      spawnSync(
        process.execPath,
        [
          script,
          "--tag",
          "v0.19.1",
          "--channel",
          "windows",
          "--release-json",
          "release.json",
          "--record",
          "record.json",
          "--out",
          "identity.json",
        ],
        { cwd: repo, encoding: "utf8" },
      );

    const ok = run();
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "identity.json"), "utf8")).commit, commit);

    git(remote, ["tag", "-d", "v0.19.1"]);
    const missing = run();
    assert.notEqual(missing.status, 0, "标签被删除后 CLI 必须失败关闭");
    assert.match(missing.stderr, /publish-tag-missing/);
    assert.match(missing.stderr, /维护者/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
