#!/usr/bin/env node
/**
 * 正式发布身份闸门（Windows / Linux 共用）。
 *
 * 候选阶段可以不要求版本标签存在；正式发布阶段则必须满足：
 * - 目标标签已经由维护者在本轮授权后创建，且（解引用后）指向 RC 记录里的候选提交；
 * - Draft / Release 属于该标签，Draft 的 target_commitish 不得指向别的可变分支；
 * - 候选提交仍在 main 上，标签与 package.json 版本一致。
 *
 * 本模块只读取调用方已取得的 GitHub / Git 状态，不创建标签、不写 Release，
 * 也不提供任何绕过保护规则的路径。标签缺失时失败关闭，并提示维护者按授权流程创建。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateRcRecord, readJsonFile } from "./rc-record.mjs";

const HEX40 = /^[0-9a-f]{40}$/;
const LINUX_TAG = /^v(\d+\.\d+\.\d+)-linux-sec(\d+)$/;
const TAG_PATTERNS = {
  windows: /^v(\d+\.\d+\.\d+)$/,
  linux: LINUX_TAG,
  "linux-critical": LINUX_TAG,
};

/** 把 `gh release view --json isDraft,tagName,targetCommitish` 的结果转成内部状态。 */
export function parseReleaseView(data) {
  if (!data || typeof data !== "object" || typeof data.isDraft !== "boolean") {
    throw new Error("publish-release-state-invalid");
  }
  if (typeof data.tagName !== "string" || typeof data.targetCommitish !== "string") {
    throw new Error("publish-release-state-invalid");
  }
  return {
    state: data.isDraft ? "draft" : "published",
    tag: data.tagName,
    targetCommitish: data.targetCommitish,
  };
}

/**
 * @param {{
 *   tag: string,
 *   channel: "windows"|"linux",
 *   version: string,
 *   commit: string,
 *   onMain: boolean,
 *   tagState: {state:"missing"|"present", commit?: string},
 *   releaseState: {state:"draft"|"published", tag: string, targetCommitish: string},
 * }} input
 */
export function validatePublishIdentity({ tag, channel, version, commit, onMain, tagState, releaseState }) {
  const pattern = TAG_PATTERNS[channel];
  if (!pattern) throw new Error("publish-channel-invalid");
  const match = typeof tag === "string" ? tag.match(pattern) : null;
  if (!match) throw new Error("publish-tag-invalid");
  if (match[1] !== version) throw new Error("publish-version-mismatch");
  if (typeof commit !== "string" || !HEX40.test(commit)) throw new Error("publish-commit-invalid");
  if (onMain !== true) throw new Error("publish-not-on-main");

  if (!tagState || !["missing", "present"].includes(tagState.state)) {
    throw new Error("publish-tag-state-unknown");
  }
  if (tagState.state === "missing") {
    throw new Error(
      `publish-tag-missing: 标签 ${tag} 尚未创建。正式发布要求维护者在本轮单独授权后，` +
        `以受保护标签允许的身份在候选提交 ${commit} 创建标签；工作流不得用 GITHUB_TOKEN 创建标签，` +
        "也不得修改保护规则或扩大令牌权限。创建后重跑发布工作流。",
    );
  }
  if (tagState.commit !== commit) throw new Error("publish-tag-commit-mismatch");

  if (!releaseState || !["draft", "published"].includes(releaseState.state)) {
    throw new Error("publish-release-state-invalid");
  }
  if (releaseState.tag !== tag) throw new Error("publish-release-tag-mismatch");
  if (typeof releaseState.targetCommitish !== "string" || releaseState.targetCommitish.trim() === "") {
    throw new Error("publish-draft-target-invalid");
  }
  // Draft 必须绑定不可变的完整 SHA。已公开 Release 的 target_commitish 可能是
  // 历史分支名（旧版本流程），此时以不可变标签为唯一绑定，仅拒绝指向另一 SHA。
  if (releaseState.state === "draft" && releaseState.targetCommitish !== commit) {
    throw new Error("publish-draft-target-mismatch");
  }
  if (
    releaseState.state === "published" &&
    HEX40.test(releaseState.targetCommitish) &&
    releaseState.targetCommitish !== commit
  ) {
    throw new Error("publish-draft-target-mismatch");
  }

  return {
    tag,
    channel: channel === "linux" ? "linux-critical" : channel,
    version,
    commit,
    tagExists: true,
    releaseState: releaseState.state,
  };
}

function invoke(run, program, args) {
  const result = run(program, args, { encoding: "utf8", timeout: 30000 });
  if (result.error || typeof result.status !== "number") throw new Error("publish-command-failed");
  return result;
}

export function collectTagState({ tag, run = spawnSync }) {
  const baseRef = `refs/tags/${tag}`;
  const result = invoke(run, "git", ["ls-remote", "--exit-code", "origin", baseRef, `${baseRef}^{}`]);
  if (result.status === 2 && !String(result.stdout).trim() && !String(result.stderr).trim()) {
    return { state: "missing" };
  }
  if (result.status !== 0) throw new Error("publish-tag-state-unknown");

  const rows = String(result.stdout).trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
  const refs = new Map();
  for (const [sha, ref, extra] of rows) {
    if (extra !== undefined || !HEX40.test(sha) || ![baseRef, `${baseRef}^{}`].includes(ref) || refs.has(ref)) {
      throw new Error("publish-tag-state-unknown");
    }
    refs.set(ref, sha);
  }
  if (!refs.has(baseRef)) throw new Error("publish-tag-state-unknown");
  return { state: "present", commit: refs.get(`${baseRef}^{}`) ?? refs.get(baseRef) };
}

export function collectPublishIdentity({ tag, channel, record, release, run = spawnSync }) {
  const recordProblems = validateRcRecord(record);
  if (recordProblems.length > 0) {
    throw new Error(`publish-record-invalid: ${recordProblems.join("；")}`);
  }
  if (record.tag !== tag) throw new Error("publish-record-tag-mismatch");

  const commit = record.commit;
  const version = record.version;
  const ancestry = invoke(run, "git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
  if (ancestry.status !== 0 && ancestry.status !== 1) throw new Error("publish-ancestry-unknown");
  const tagState = collectTagState({ tag, run });
  const releaseState = parseReleaseView(release);
  return validatePublishIdentity({
    tag,
    channel,
    version,
    commit,
    onMain: ancestry.status === 0,
    tagState,
    releaseState,
  });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  for (const key of ["tag", "channel", "release-json", "record"]) {
    if (!args[key]) {
      console.error(`[publish-identity] 缺少参数 --${key}`);
      return 2;
    }
  }
  try {
    const record = readJsonFile(args.record);
    const release = readJsonFile(args["release-json"]);
    const identity = collectPublishIdentity({
      tag: args.tag,
      channel: args.channel,
      record,
      release,
    });
    if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(identity, null, 2)}\n`);
    console.log(
      `[publish-identity] OK ${identity.tag}：通道=${identity.channel} 提交=${identity.commit} ` +
        `状态=${identity.releaseState}（标签已存在并与候选提交一致）`,
    );
    return 0;
  } catch (error) {
    console.error(`[publish-identity] ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
