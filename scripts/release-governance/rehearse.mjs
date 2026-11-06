#!/usr/bin/env node
/**
 * 发布链路**隔离演练**（不联网、不创建任何 GitHub 资源、不接触密钥）。
 *
 * 目的：在没有真实 Environment 审批、没有真实 Draft 的情况下，用进程内的假后端
 * 把 Phase 4 的发布状态机跑通，并断言「不该发生的路径一定不会发生」：
 *
 *  A. RC → Draft：候选只落成 **Draft**，不会直接变公开 Release；
 *  B. 审批绑定：审批令牌绑定「版本 + Commit + 制品 SHA-256 + 平台」，
 *     审批后替换制品 / 换版本 / 换平台 / 缺安装验证回执 → 一律拒绝发布；
 *  C. 失败恢复：发布中途失败时 Draft 保留、可安全重试，不产生重复 Release；
 *  D. 并发控制：同一「通道 + 标签」同时只允许一个发布在途；
 *  E. 更新清单安全：跨通道端点、未签名清单、清单结构非法 → 一律拒绝；
 *  F. 跨通道误发布：用 Windows 发布流程去发 Linux 标签 → 拒绝。
 *
 * 用法：node scripts/release-governance/rehearse.mjs [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHANNELS,
  buildRcRecord,
  collectCandidateArtifacts,
  parseTag,
  renderRcSummary,
  sha256Bytes,
  validateRcRecord,
  verifyPublishPreconditions,
} from "./rc-record.mjs";
import { verifyUpdaterManifest } from "../verify-updater-manifest.mjs";
import {
  CHANNEL_MANIFESTS,
  assessPublicationState,
  verifyManifestPresence,
} from "./publish-state.mjs";
import {
  INSTALL_EVIDENCE_KIND,
  SIGNATURE_EVIDENCE_KIND,
  verifyReleaseEvidence,
} from "./evidence.mjs";

const results = [];
let failures = 0;

function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail || "" });
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* 假后端：Draft / 发布 / 并发锁                                      */
/* ------------------------------------------------------------------ */

class FakeReleaseStore {
  constructor() {
    this.drafts = new Map();
    this.published = new Map();
    this.locks = new Set();
    this.publishCalls = 0;
    this.uploadCalls = 0;
    this.overwriteRejections = 0;
  }

  createDraft(record, assets) {
    if (this.drafts.has(record.tag) || this.published.has(record.tag)) {
      throw new Error(`Draft 已存在：${record.tag}`);
    }
    this.drafts.set(record.tag, { record, assets: new Map(assets), body: renderRcSummary(record) });
    return this.drafts.get(record.tag);
  }

  getDraft(tag) {
    return this.drafts.get(tag) || null;
  }

  /** 直接登记一条已公开 Release（历史发布 / 已完成的发布），供恢复运行场景使用。 */
  seedPublished(tag, record, assets) {
    if (this.drafts.has(tag) || this.published.has(tag)) {
      throw new Error(`Release 已存在：${tag}`);
    }
    this.published.set(tag, { record, assets: new Map(assets), body: renderRcSummary(record) });
    return this.published.get(tag);
  }

  /** 资产快照（name:sha256 排序）：用于断言重跑没有改写任何已发布字节。 */
  snapshot(tag) {
    const release = this.published.get(tag) || this.drafts.get(tag);
    if (!release) return null;
    return [...release.assets.entries()]
      .map(([name, bytes]) => `${name}:${sha256Bytes(bytes)}`)
      .sort();
  }

  /**
   * 恢复运行唯一允许的写入：新增一件缺失资产。
   * 已存在的资产即便字节相同也不重写；不同字节一律失败关闭（不允许覆盖已发布内容）。
   */
  uploadAsset(tag, name, bytes) {
    const release = this.published.get(tag);
    if (!release) throw new Error(`没有已公开的 Release：${tag}`);
    if (release.assets.has(name)) {
      if (sha256Bytes(release.assets.get(name)) !== sha256Bytes(bytes)) {
        this.overwriteRejections += 1;
        throw new Error(`拒绝覆盖已发布资产：${tag}/${name}`);
      }
      return "unchanged";
    }
    release.assets.set(name, bytes);
    this.uploadCalls += 1;
    return "added";
  }

  /**
   * 接力来源：只能是**已公开**的其它 Release，且清单摘要必须绑定到该 Release
   * 自己的 RC 记录；Draft 来源与未绑定字节一律不作为来源。
   */
  findPeerManifest(channel, tag) {
    const { peer } = CHANNEL_MANIFESTS[channel];
    for (const [sourceTag, release] of this.published) {
      if (sourceTag === tag) continue;
      const bytes = release.assets.get(peer);
      if (!bytes) continue;
      const artifact = (release.record.artifacts || []).find((item) => item.name === peer);
      if (!artifact || artifact.sha256 !== sha256Bytes(bytes)) continue;
      return { sourceTag, bytes };
    }
    return null;
  }

  /**
   * 发布后恢复运行：判定来自生产用的 publish-state.mjs。
   * - 已公开 → 永不重新公开；
   * - 只允许补缺失的对端清单；
   * - 缺自有清单等无法自愈的状态 → 返回 ok=false（工作流保持红色）。
   */
  rerunPublish({ tag, channel }) {
    const release = this.published.get(tag);
    if (!release) {
      throw new Error(`没有已公开的 Release：${tag}（恢复运行只处理已公开状态）`);
    }
    let state = assessPublicationState({
      isDraft: false,
      assets: [...release.assets.keys()],
      channel,
    });
    if (state.needPublish) throw new Error("已公开的 Release 不得重新公开");

    // 自有清单缺失不是可自愈状态：没有"再发一次"这条路，只能保持失败。
    if (!state.hasOwnManifest) {
      return {
        actions: [],
        ok: false,
        missing: verifyManifestPresence(state).missing,
        republished: false,
      };
    }

    const actions = [];
    if (state.needHandoff) {
      const peer = this.findPeerManifest(channel, tag);
      if (!peer) {
        throw new Error(
          `未找到可接力的对端清单 ${state.peerManifest}：来源必须已公开且清单绑定自身 RC 记录`,
        );
      }
      this.uploadAsset(tag, state.peerManifest, peer.bytes);
      actions.push(`handoff:${state.peerManifest}`);
      state = assessPublicationState({
        isDraft: false,
        assets: [...release.assets.keys()],
        channel,
      });
    }

    const presence = verifyManifestPresence(state);
    return { actions, ok: presence.ok, missing: presence.missing, republished: false };
  }

  /** 并发锁：同一 channel+tag 同时只允许一个发布在途。 */
  acquireLock(channel, tag) {
    const key = `${channel}:${tag}`;
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  releaseLock(channel, tag) {
    this.locks.delete(`${channel}:${tag}`);
  }

  publishDraft(tag, approval) {
    this.publishCalls += 1;
    const draft = this.drafts.get(tag);
    if (!draft) throw new Error(`没有可发布的 Draft：${tag}`);
    const digests = new Map();
    for (const [name, bytes] of draft.assets) digests.set(name, sha256Bytes(bytes));
    const verdict = verifyPublishPreconditions({
      record: draft.record,
      actualDigests: digests,
      attestation: approval?.attestation ?? null,
      channel: approval?.channel ?? draft.record.channel,
      commit: approval?.commit ?? draft.record.commit,
    });
    if (!verdict.ok) {
      throw new Error(`发布前校验拒绝：${verdict.problems.join(" | ")}`);
    }
    this.published.set(tag, draft);
    this.drafts.delete(tag);
    return draft;
  }
}

const REHEARSAL_BOOK_ID = "1".repeat(64);
const REHEARSAL_SNAPSHOT = "c".repeat(64);

/** 与安装脚本产出的 library 结构一致：数据库自检 + 进度 + 真实 IPC 回读。 */
function makeLibrary(overrides = {}) {
  return {
    quickCheck: "ok",
    schemaVersionBefore: 1,
    schemaVersionAfter: 1,
    bookCount: 1,
    readingLogRows: 2,
    readingLogPages: 3,
    books: [
      {
        id: REHEARSAL_BOOK_ID,
        title: "Release Smoke Book",
        pageCount: 3,
        currentPage: 2,
        scrollPct: 0.5,
        removed: 0,
        sourceType: "local",
      },
    ],
    ipc: {
      ok: true,
      source: "list_books",
      bookId: REHEARSAL_BOOK_ID,
      title: "Release Smoke Book",
      currentPage: 2,
      scrollPct: 0.5,
      bookCount: 1,
      checkedAt: new Date().toISOString(),
    },
    snapshotSha256: REHEARSAL_SNAPSHOT,
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 与安装脚本产出的 machine.provenance 一致：可核实的 GitHub Actions run。 */
function makeProvenance(overrides = {}) {
  return {
    kind: "github-actions",
    repository: "D-OneXXX/Moyu",
    runId: "1234567890",
    runUrl: "https://github.com/D-OneXXX/Moyu/actions/runs/1234567890",
    runnerName: "RUNNER-01",
    imageOs: "win22",
    imageVersion: "20261021.1.0",
    workflow:
      "D-OneXXX/Moyu/.github/workflows/release-install-verify.yml@refs/heads/main",
    actor: "D-OneXXX",
    runAttempt: "1",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAttestation(record, installerSha256, overrides = {}) {
  return {
    kind: "manga-reader.install-verification",
    version: record.version,
    commit: record.commit,
    platform: record.platform,
    // 与安装脚本产出的结构一致（唯一契约）：artifactName / artifactSha256。
    artifactName: "setup.exe",
    artifactSha256: installerSha256,
    expectedArtifactSha256: installerSha256,
    previousVersion: "0.17.1",
    previousArtifactName: "MangaReader_0.17.1_x64-setup.exe",
    previousArtifactSha256: "b".repeat(64),
    verdict: "PASS",
    checks: {
      freshInstall: "pass",
      upgrade: "pass",
      dataIntegrity: "pass",
      recovery: "pass",
      pdfReading: "pass",
      progressRestart: "pass",
      backupRestore: "pass",
      databaseRollback: "pass",
    },
    library: makeLibrary(),
    machine: {
      os: "Windows Server 2022",
      cleanEnvironment: true,
      image: "GitHub Actions windows-2022 20261021.1.0",
      host: "RUNNER-01",
      provenance: makeProvenance(),
    },
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeArtifacts() {
  const installer = Buffer.from("fake-nsis-installer-binary");
  const manifest = Buffer.from(
    JSON.stringify({
      version: "0.17.2",
      pub_date: new Date().toISOString(),
      platforms: { "windows-x86_64": { signature: "sig", url: "https://example.invalid/a.exe" } },
    }),
  );
  return [
    { name: "MangaReader_0.17.2_x64-setup.exe", bytes: installer },
    { name: "latest.json", bytes: manifest },
  ];
}

function expectThrow(id, fn, expectText) {
  let text = "";
  try {
    const verdict = fn();
    // 校验函数返回 {ok:false, problems}；抛异常的路径（如发布动作）也算拒绝。
    if (verdict && typeof verdict === "object" && verdict.ok === false) {
      text = (verdict.problems || []).join(" | ");
    } else {
      check(id, false, "本应被拒绝，却成功了");
      return;
    }
  } catch (error) {
    text = String(error.message || error);
  }
  check(id, text.includes(expectText), text.slice(0, 160));
}

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

const store = new FakeReleaseStore();
const tag = "v0.17.2";
const parsed = parseTag(tag);
const commit = "a".repeat(40);
const artifacts = makeArtifacts();
const record = buildRcRecord({
  tag,
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: artifacts.map((item) => ({
    name: item.name,
    sha256: sha256Bytes(item.bytes),
    size: item.bytes.length,
  })),
});

// A. RC → Draft
check("A1 RC 记录结构合法", validateRcRecord(record).length === 0, validateRcRecord(record).join(" | "));
const draft = store.createDraft(
  record,
  artifacts.map((item) => [item.name, item.bytes]),
);
check("A2 候选只落成 Draft，未公开", store.drafts.has(tag) && !store.published.has(tag));
check("A3 Draft 正文包含审批依据（版本/Commit/摘要）", draft.body.includes(record.commit) && draft.body.includes(record.artifacts[0].sha256));

// B. 审批绑定
const installerSha = sha256Bytes(artifacts[0].bytes);
const goodApproval = {
  channel: "windows",
  commit,
  attestation: makeAttestation(record, installerSha),
};
expectThrow("B1 缺安装验证回执 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: null }), "安装验证回执缺失");
expectThrow("B2 安装回执指向不同安装包 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, "b".repeat(64)) }), "摘要与候选制品不一致");
expectThrow("B3 版本不一致 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, installerSha, { version: "0.17.1" }) }), "回执版本与候选不一致");
expectThrow("B4 Commit 不一致 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, commit: "b".repeat(40) }), "Commit 不匹配");
expectThrow("B5 平台不一致 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, installerSha, { platform: "linux-x86_64" }) }), "回执平台与候选不一致");
expectThrow("B6 审批后替换制品 → 拒绝发布", () => {
  const draft2 = store.getDraft(tag);
  draft2.assets.set(artifacts[0].name, Buffer.from("tampered-binary"));
  store.publishDraft(tag, goodApproval);
}, "摘要不一致");
check("B7 篡改后仍无公开 Release", !store.published.has(tag));

// C. 失败恢复：模拟传输失败后重试
const draft3 = store.getDraft(tag);
draft3.assets.set(artifacts[0].name, artifacts[0].bytes);
let failedOnce = false;
try {
  store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, "c".repeat(64)) });
} catch {
  failedOnce = true;
}
check("C1 失败后 Draft 仍保留（可重试）", failedOnce && store.drafts.has(tag) && !store.published.has(tag));
const published = store.publishDraft(tag, goodApproval);
check("C2 重试成功且只产生一个 Release", store.published.size === 1 && published.record.rcId === record.rcId);

// D. 并发控制
const lockA = store.acquireLock("windows", tag);
const lockB = store.acquireLock("windows", tag);
check("D1 同一通道+标签的第二个发布被拒", lockA && !lockB);
store.releaseLock("windows", tag);
check("D2 释放后可再次获取锁", store.acquireLock("windows", tag));
store.releaseLock("windows", tag);

// E. 更新清单安全
const manifestProblems = verifyUpdaterManifest(
  {
    version: "0.17.2",
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { signature: "", url: "http://example.invalid/a.exe" } },
  },
  { expectVersion: "0.17.2", requirePlatform: "windows-x86_64" },
);
check("E1 未签名/非 https 清单被拒", manifestProblems.length >= 2, manifestProblems.join(" | "));
const wrongChannel = verifyUpdaterManifest(
  {
    version: "0.17.2",
    pub_date: new Date().toISOString(),
    platforms: { "linux-x86_64": { signature: "sig", url: "https://example.invalid/a" } },
  },
  { requirePlatform: "windows-x86_64" },
);
check("E2 清单缺少本通道平台项被拒", wrongChannel.some((p) => p.includes("windows-x86_64")));
check(
  "E3 通道端点互相独立",
  CHANNELS.windows.platform !== CHANNELS["linux-critical"].platform,
  `${CHANNELS.windows.platform} vs ${CHANNELS["linux-critical"].platform}`,
);

// F. 跨通道误发布
const linuxRecord = buildRcRecord({
  tag: "v0.17.2-linux-sec1",
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: [{ name: "app.AppImage", sha256: sha256Bytes(Buffer.from("appimage")) }],
});
expectThrow(
  "F1 用 Windows 流程发 Linux 标签 → 拒绝",
  () =>
    verifyPublishPreconditions({
      record: linuxRecord,
      actualDigests: new Map([["app.AppImage", sha256Bytes(Buffer.from("appimage"))]]),
      attestation: makeAttestation(linuxRecord, sha256Bytes(Buffer.from("appimage")), { platform: "linux-x86_64" }),
      channel: "windows",
      commit,
    }),
  "通道不匹配",
);
expectThrow(
  "F2 Linux 流程缺少对应平台回执 → 拒绝",
  () =>
    verifyPublishPreconditions({
      record: linuxRecord,
      actualDigests: new Map([["app.AppImage", sha256Bytes(Buffer.from("appimage"))]]),
      attestation: makeAttestation(linuxRecord, sha256Bytes(Buffer.from("appimage")), { platform: "windows-x86_64" }),
      channel: "linux-critical",
      commit,
    }),
  "回执平台与候选不一致",
);

// H. 演练候选不得发布
const rehearsalRecord = buildRcRecord({
  tag: "v0.0.0-rehearsal",
  commit,
  qa: { runId: "42", buildCommit: commit },
  artifacts: [{ name: "rehearsal-app-setup.exe", sha256: sha256Bytes(Buffer.from("rehearsal")) }],
});
expectThrow(
  "H1 演练候选（v0.0.0-rehearsal）→ 无条件拒绝发布",
  () =>
    verifyPublishPreconditions({
      record: rehearsalRecord,
      actualDigests: new Map([["rehearsal-app-setup.exe", sha256Bytes(Buffer.from("rehearsal"))]]),
      attestation: makeAttestation(rehearsalRecord, sha256Bytes(Buffer.from("rehearsal")), {
        version: "0.0.0",
      }),
      channel: "windows",
      commit,
    }),
  "演练候选",
);

// I. 发布证据门禁（签名验证 + 真实安装/升级验证）
const gateRecord = buildRcRecord({
  tag: "v0.17.2",
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: [
    { name: "MangaReader_0.17.2_x64-setup.exe", sha256: sha256Bytes(Buffer.from("installer")), size: 9 },
  ],
});
const gateDigest = sha256Bytes(Buffer.from("installer"));
const gateDigests = new Map([["MangaReader_0.17.2_x64-setup.exe", gateDigest]]);
const gateExpected = {
  version: "0.17.2",
  commit,
  platform: "windows-x86_64",
  artifactName: "MangaReader_0.17.2_x64-setup.exe",
  artifactSha256: gateDigest,
  publicKeyId: "67CB304460E08E4A",
  now: new Date().toISOString(),
};
const gateSignature = {
  kind: SIGNATURE_EVIDENCE_KIND,
  verdict: "PASS",
  version: gateExpected.version,
  commit,
  platform: gateExpected.platform,
  artifactName: gateExpected.artifactName,
  artifactSha256: gateDigest,
  publicKeyId: gateExpected.publicKeyId,
  verifiedBy: "minisign 0.12",
  verifiedAt: new Date().toISOString(),
};
const gateInstall = {
  kind: INSTALL_EVIDENCE_KIND,
  verdict: "PASS",
  version: gateExpected.version,
  commit,
  platform: gateExpected.platform,
  artifactName: gateExpected.artifactName,
  artifactSha256: gateDigest,
  expectedArtifactSha256: gateDigest,
  previousVersion: "0.17.1",
  previousArtifactName: "MangaReader_0.17.1_x64-setup.exe",
  previousArtifactSha256: "b".repeat(64),
  checks: {
    freshInstall: "pass",
    upgrade: "pass",
    dataIntegrity: "pass",
    recovery: "pass",
    pdfReading: "pass",
    progressRestart: "pass",
    backupRestore: "pass",
    databaseRollback: "pass",
  },
  library: makeLibrary(),
  machine: {
    os: "Windows Server 2022",
    cleanEnvironment: true,
    image: "GitHub Actions windows-2022 20261021.1.0",
    host: "RUNNER-01",
    provenance: makeProvenance(),
  },
  verifiedAt: new Date().toISOString(),
};

function mutateInstall(mutator) {
  const copy = structuredClone(gateInstall);
  mutator(copy);
  return copy;
}
const gate = (overrides = {}) =>
  verifyReleaseEvidence({
    record: gateRecord,
    digests: gateDigests,
    signatureEvidence: gateSignature,
    installEvidence: gateInstall,
    channel: "windows",
    commit,
    publicKeyId: gateExpected.publicKeyId,
    now: gateExpected.now,
    ...overrides,
  });
check("I1 证据齐备且绑定一致 → 放行", gate().ok, gate().problems.join(" | "));
check("I2 缺安装/升级验证证据 → 拒绝", !gate({ installEvidence: null }).ok);
check("I3 缺签名验证证据 → 拒绝", !gate({ signatureEvidence: null }).ok);
check(
  "I4 证据过期 → 拒绝",
  !gate({
    signatureEvidence: { ...gateSignature, verifiedAt: "2020-01-01T00:00:00.000Z" },
    installEvidence: { ...gateInstall, verifiedAt: "2020-01-01T00:00:00.000Z" },
  }).ok,
);
check(
  "I5 证据 Commit 与候选不一致 → 拒绝",
  !gate({ signatureEvidence: { ...gateSignature, commit: "f".repeat(40) } }).ok,
);
check(
  "I6 审批后替换制品 → 拒绝",
  !gate({ digests: new Map([["MangaReader_0.17.2_x64-setup.exe", sha256Bytes(Buffer.from("other"))]]) }).ok,
);
check(
  "I7 证据锚定的公钥与配置不一致 → 拒绝",
  !gate({ publicKeyId: "0000000000000000" }).ok,
);
check(
  "I8 安装证据未声明干净环境 → 拒绝",
  !gate({
    installEvidence: {
      ...gateInstall,
      machine: { os: "Windows 11", image: "shared-workstation", cleanEnvironment: false },
    },
  }).ok,
);
check(
  "I9 安装证据缺少 provenance → 拒绝",
  !gate({
    installEvidence: mutateInstall((evidence) => {
      delete evidence.machine.provenance;
    }),
  }).ok,
);
check(
  "I10 github-actions runUrl 与 runId 不一致 → 拒绝",
  !gate({
    installEvidence: mutateInstall((evidence) => {
      evidence.machine.provenance.runUrl =
        "https://github.com/D-OneXXX/Moyu/actions/runs/9999999999";
    }),
  }).ok,
);
check(
  "I11 升级后用户阅读进度缺失 → 拒绝",
  !gate({
    installEvidence: mutateInstall((evidence) => {
      evidence.library.books[0].currentPage = 0;
      evidence.library.ipc.currentPage = 0;
    }),
  }).ok,
);
check(
  "I12 expectedArtifactSha256 与安装包摘要不一致 → 拒绝",
  !gate({
    installEvidence: mutateInstall((evidence) => {
      evidence.expectedArtifactSha256 = "e".repeat(64);
    }),
  }).ok,
);
check(
  "I13 upgrade=pass 但缺 previousVersion → 拒绝",
  !gate({
    installEvidence: mutateInstall((evidence) => {
      delete evidence.previousVersion;
    }),
  }).ok,
);
check(
  "I14 旧共享宿主回执（无 provenance/library）→ 拒绝",
  !gate({
    installEvidence: {
      ...gateInstall,
      library: undefined,
      machine: { os: "Windows 11", cleanEnvironment: false },
    },
  }).ok,
);
// PDF 阅读 / 跨重启进度 / 备份恢复 / 数据库回滚：四项新门禁缺一即拒绝。
["pdfReading", "progressRestart", "backupRestore", "databaseRollback"].forEach(
  (key, index) => {
    check(
      `I${15 + index} 缺少 ${key} → 拒绝`,
      !gate({
        installEvidence: mutateInstall((evidence) => {
          delete evidence.checks[key];
        }),
      }).ok,
    );
  },
);

// J. 候选重跑安全：Draft 里已回填的治理文件不得污染下一次 RC 记录
const rerunDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-rehearsal-rerun-"));
const rerunPayloads = {
  "MangaReader_0.17.2_x64-setup.exe": Buffer.from("rerun-installer"),
  "latest.json": Buffer.from('{"version":"0.17.2"}'),
};
for (const [name, bytes] of Object.entries(rerunPayloads)) {
  fs.writeFileSync(path.join(rerunDir, name), bytes);
}
const cleanArtifacts = collectCandidateArtifacts(rerunDir);
for (const name of [
  "rc-record.json",
  "rc-summary.md",
  "signature-verification.json",
  "install-verification.json",
]) {
  fs.writeFileSync(path.join(rerunDir, name), Buffer.from(`${name}-bytes`));
}
const rerunArtifacts = collectCandidateArtifacts(rerunDir);
check(
  "J1 候选重跑（Draft 已有治理文件）→ 制品集合不变",
  JSON.stringify(rerunArtifacts) === JSON.stringify(cleanArtifacts) &&
    rerunArtifacts.every((item) => !/^(rc-|signature-|install-)/.test(item.name)),
  rerunArtifacts.map((item) => item.name).join(","),
);
const rerunRecord = buildRcRecord({
  tag,
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: rerunArtifacts,
});
const rerunDigests = new Map(
  Object.entries(rerunPayloads).map(([name, bytes]) => [name, sha256Bytes(bytes)]),
);
for (const name of [
  "rc-record.json",
  "rc-summary.md",
  "signature-verification.json",
  "install-verification.json",
]) {
  rerunDigests.set(name, sha256Bytes(Buffer.from(`${name}-bytes`)));
}
const rerunVerdict = verifyPublishPreconditions({
  record: rerunRecord,
  actualDigests: rerunDigests,
  attestation: makeAttestation(rerunRecord, sha256Bytes(rerunPayloads["MangaReader_0.17.2_x64-setup.exe"])),
  channel: "windows",
  commit,
});
check("J2 重跑后的 RC 记录仍能通过发布前摘要校验", rerunVerdict.ok, rerunVerdict.problems.join(" | "));
rerunDigests.set("unexpected.exe", sha256Bytes(Buffer.from("unexpected")));
const rerunRejected = verifyPublishPreconditions({
  record: rerunRecord,
  actualDigests: rerunDigests,
  attestation: makeAttestation(rerunRecord, sha256Bytes(rerunPayloads["MangaReader_0.17.2_x64-setup.exe"])),
  channel: "windows",
  commit,
});
check(
  "J3 治理文件之外的额外制品仍被拒绝",
  !rerunRejected.ok && rerunRejected.problems.some((problem) => problem.includes("记录之外的制品")),
  rerunRejected.problems.join(" | "),
);
fs.rmSync(rerunDir, { recursive: true, force: true });

// G. 标签命名约束
check("G1 常规通道拒绝 linux 后缀标签", parseTag("v0.17.2-linux-sec1")?.channel === "linux-critical");
check("G2 常规通道标签解析正确", parseTag("v0.17.2")?.channel === "windows");
check("G3 非法标签被拒", parseTag("v0.17.2-rc1") === null);

/* ------------------------------------------------------------------ */
/* K. 发布后恢复运行（成功或中断后重跑）                               */
/* ------------------------------------------------------------------ */

/**
 * 恢复运行必须同时满足两件事：
 *  1) 已公开的 Release 永不再公开一次，也不再改写任何既有资产；
 *  2) 只允许「新增缺失的另一通道清单」，其余无法自愈的状态一律失败关闭。
 * 这里的判定来源是生产用的 publish-state.mjs，而不是演练自造的布尔值。
 */

const peerManifest = Buffer.from(
  JSON.stringify({
    version: "0.16.0",
    platforms: { "linux-x86_64": { signature: "sig", url: "https://example.invalid/a.AppImage" } },
  }),
);
const prevLinuxTag = "v0.16.0-linux-sec1";
const prevLinuxRecord = buildRcRecord({
  tag: prevLinuxTag,
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: [
    {
      name: "latest-linux-critical.json",
      sha256: sha256Bytes(peerManifest),
      size: peerManifest.length,
    },
  ],
});
store.seedPublished(prevLinuxTag, prevLinuxRecord, [["latest-linux-critical.json", peerManifest]]);

// C2 之后 `tag` 已公开，但中断在接力之前：缺 latest-linux-critical.json。
const assetsAfterPublish = store.snapshot(tag);
const publishCallsAfterSuccess = store.publishCalls;
const uploadsBeforeRecovery = store.uploadCalls;

const k1 = store.rerunPublish({ tag, channel: "windows" });
check(
  "K1 发布成功后中断（缺对端清单）→ 重跑只补一件缺失资产",
  k1.ok &&
    JSON.stringify(k1.actions) === JSON.stringify(["handoff:latest-linux-critical.json"]) &&
    k1.republished === false,
  k1.actions.join(","),
);
check(
  "K2 恢复运行不重新公开、不改写任何已发布字节",
  store.publishCalls === publishCallsAfterSuccess &&
    store.uploadCalls === uploadsBeforeRecovery + 1 &&
    JSON.stringify(store.snapshot(tag).filter((item) => !item.startsWith("latest-linux-critical.json"))) ===
      JSON.stringify(assetsAfterPublish),
  `publish=${store.publishCalls} upload=${store.uploadCalls}`,
);

const k2 = store.rerunPublish({ tag, channel: "windows" });
check(
  "K3 恢复完成后的再次重跑 → 零写入且校验通过",
  k2.ok &&
    k2.actions.length === 0 &&
    store.uploadCalls === uploadsBeforeRecovery + 1 &&
    store.publishCalls === publishCallsAfterSuccess,
  k2.actions.join(","),
);

expectThrow("K4 已公开 Release 再次发布 → 拒绝", () => store.publishDraft(tag, goodApproval), "没有可发布的 Draft");
check(
  "K5 拒绝后资产与 Release 数量不变",
  JSON.stringify(store.snapshot(tag).filter((item) => !item.startsWith("latest-linux-critical.json"))) ===
    JSON.stringify(assetsAfterPublish) &&
    store.published.size === 2 &&
    store.uploadCalls === uploadsBeforeRecovery + 1,
  `${store.published.size} 个 Release`,
);

const peerDigestBefore = store.snapshot(tag).find((item) => item.startsWith("latest-linux-critical.json"));
expectThrow(
  "K6 覆盖已发布资产 → 拒绝（只允许新增缺失文件）",
  () => store.uploadAsset(tag, "latest-linux-critical.json", Buffer.from("tampered-peer-manifest")),
  "拒绝覆盖已发布资产",
);
check(
  "K7 覆盖被拒后资产字节未变",
  store.snapshot(tag).find((item) => item.startsWith("latest-linux-critical.json")) === peerDigestBefore,
  peerDigestBefore,
);

// Linux 通道镜像：已公开但缺 latest.json 时只补这一件，且来源必须是已公开 Release。
const linuxPeerManifest = Buffer.from(
  JSON.stringify({
    version: "0.17.0",
    platforms: { "linux-x86_64": { signature: "sig", url: "https://example.invalid/b.AppImage" } },
  }),
);
const linuxTag = "v0.17.0-linux-sec1";
const linuxPublishedRecord = buildRcRecord({
  tag: linuxTag,
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: [
    { name: "latest-linux-critical.json", sha256: sha256Bytes(linuxPeerManifest), size: linuxPeerManifest.length },
  ],
});
store.seedPublished(linuxTag, linuxPublishedRecord, [["latest-linux-critical.json", linuxPeerManifest]]);
const linuxAssetsBefore = store.snapshot(linuxTag);
const uploadsBeforeLinux = store.uploadCalls;
const k8 = store.rerunPublish({ tag: linuxTag, channel: "linux" });
check(
  "K8 Linux 通道同规则：只补 latest.json，不重新公开",
  k8.ok &&
    JSON.stringify(k8.actions) === JSON.stringify(["handoff:latest.json"]) &&
    store.uploadCalls === uploadsBeforeLinux + 1 &&
    JSON.stringify(store.snapshot(linuxTag).filter((item) => !item.startsWith("latest.json"))) ===
      JSON.stringify(linuxAssetsBefore),
  k8.actions.join(","),
);

// 对端清单只能来自已公开 Release：只有 Draft 形态的来源时必须失败关闭。
const draftOnlyStore = new FakeReleaseStore();
const draftSourceTag = "v0.17.5-linux-sec1";
const draftPeer = Buffer.from(
  JSON.stringify({
    version: "0.17.5",
    platforms: { "linux-x86_64": { signature: "sig", url: "https://example.invalid/c.AppImage" } },
  }),
);
draftOnlyStore.createDraft(
  buildRcRecord({
    tag: draftSourceTag,
    commit,
    qa: { runId: "1234567890", buildCommit: commit },
    artifacts: [{ name: "latest-linux-critical.json", sha256: sha256Bytes(draftPeer) }],
  }),
  [["latest-linux-critical.json", draftPeer]],
);
draftOnlyStore.seedPublished(
  tag,
  record,
  artifacts.map((item) => [item.name, item.bytes]),
);
expectThrow(
  "K9 对端来源仍是 Draft → 恢复运行失败关闭",
  () => draftOnlyStore.rerunPublish({ tag, channel: "windows" }),
  "未找到可接力的对端清单",
);
check(
  "K10 失败关闭后没有追加任何资产",
  draftOnlyStore.snapshot(tag).length === 2 && draftOnlyStore.uploadCalls === 0,
  draftOnlyStore.snapshot(tag).join(","),
);

// 已公开但缺**自己的**清单：不存在任何自动修好的路径，必须保持红色。
const ownMissingStore = new FakeReleaseStore();
ownMissingStore.seedPublished(
  tag,
  record,
  artifacts.filter((item) => item.name !== "latest.json").map((item) => [item.name, item.bytes]),
);
const k11 = ownMissingStore.rerunPublish({ tag, channel: "windows" });
check(
  "K11 已公开但缺自有清单 → 恢复运行判定不通过（不自愈、不重发）",
  k11.ok === false &&
    k11.actions.length === 0 &&
    k11.missing.includes("latest.json") &&
    ownMissingStore.publishCalls === 0,
  k11.missing.join(","),
);

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

const summary = {
  total: results.length,
  passed: results.length - failures,
  failed: failures,
  scenarios: ["A 候选→Draft", "B 审批绑定", "C 失败恢复", "D 并发控制", "E 清单安全", "F 跨通道", "G 标签约束", "H 演练不可发布", "I 证据门禁", "J 候选重跑安全"],
};
console.log("");
console.log("=== 发布链路隔离演练 ===");
console.log(`场景：${summary.scenarios.join(" / ")}`);
console.log(`通过：${summary.passed}/${summary.total}；失败：${summary.failed}`);

if (process.argv.includes("--json")) {
  const outDir = process.env.REHEARSAL_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "mr-rehearsal-"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "rehearsal.json"),
    JSON.stringify({ summary, results }, null, 2),
    "utf8",
  );
  console.log(`报告：${path.join(outDir, "rehearsal.json")}`);
}

process.exitCode = failures === 0 ? 0 : 1;
