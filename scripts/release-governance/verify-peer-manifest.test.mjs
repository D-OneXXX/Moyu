import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRcRecord, sha256Bytes } from "./rc-record.mjs";
import { verifyPeerManifest } from "./verify-peer-manifest.mjs";

const commit = "a".repeat(40);

function fixture(channel = "linux-critical") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-peer-manifest-"));
  const name = channel === "windows" ? "latest.json" : "latest-linux-critical.json";
  const data = Buffer.from(JSON.stringify({ version: "0.19.1", notes: "peer" }));
  fs.writeFileSync(path.join(dir, name), data);
  const record = buildRcRecord({
    tag: channel === "windows" ? "v0.19.1" : "v0.19.1-linux-sec1",
    commit,
    channel,
    platform: channel === "windows" ? "windows-x86_64" : "linux-x86_64",
    qa: { runId: "123", buildCommit: commit },
    artifacts: [{ name, sha256: sha256Bytes(data), size: data.length }],
  });
  return { dir, name, record, manifest: path.join(dir, name) };
}

test("对端清单必须属于源通道且摘要匹配", () => {
  const { record, manifest, name } = fixture("linux-critical");
  const result = verifyPeerManifest({ record, manifest, channel: "linux-critical", name });
  assert.equal(result.code, 0);
  assert.equal(result.message, `${name} 已绑定源 RC 记录（v0.19.1-linux-sec1）`);
  assert.equal(result.peer.name, name);
  assert.equal(result.peer.sourceTag, "v0.19.1-linux-sec1");
  assert.match(result.peer.sha256, /^[0-9a-f]{64}$/);
});

test("摘要被替换时必须失败关闭", () => {
  const { dir, record, name } = fixture("linux-critical");
  const manifest = path.join(dir, name);
  fs.writeFileSync(manifest, "tampered");
  const result = verifyPeerManifest({ record, manifest, channel: "linux-critical", name });
  assert.equal(result.code, 1);
  assert.match(result.message, /摘要与源 RC 记录不一致/);
});

test("通道不符或清单未登记时返回可继续状态，记录损坏则失败", () => {
  const { record, manifest, name } = fixture("windows");
  assert.equal(verifyPeerManifest({ record, manifest, channel: "linux-critical", name }).code, 2);
  assert.equal(
    verifyPeerManifest({ record, manifest, channel: "windows", name: "latest-linux-critical.json" }).code,
    2,
  );
  const broken = { ...record, artifacts: [] };
  const result = verifyPeerManifest({ record: broken, manifest, channel: "windows", name });
  assert.equal(result.code, 1);
  assert.match(result.message, /rc-record.json 非法/);
});
