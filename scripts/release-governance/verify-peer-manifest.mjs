#!/usr/bin/env node
/**
 * 校验发布接力时从另一通道携带的清单：
 * - 源 Release 的 rc-record.json 必须合法；
 * - 源通道必须与清单所属通道一致；
 * - 清单必须登记在源 RC 记录里，且字节摘要完全一致。
 *
 * 退出码：0 = 可接力；2 = 该 Release 不是目标对端通道/未登记清单（继续找下一个）；
 * 1 = 记录非法或摘要不一致（失败关闭）。
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, sha256File, validateRcRecord } from "./rc-record.mjs";

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

export function verifyPeerManifest({ record, manifest, channel, name }) {
  const problems = validateRcRecord(record);
  if (problems.length > 0) {
    return { code: 1, message: `源 Release 的 rc-record.json 非法：${problems.join("；")}` };
  }
  if (record.channel !== channel) {
    return { code: 2, message: `源 Release 不是目标对端通道：${record.channel} != ${channel}` };
  }
  const expected = (record.artifacts || []).find((item) => item.name === name);
  if (!expected) {
    return { code: 2, message: `源 Release 的 rc-record.json 未登记 ${name}` };
  }
  const actual = sha256File(manifest);
  if (actual !== expected.sha256) {
    return { code: 1, message: `${name} 摘要与源 RC 记录不一致：${actual} != ${expected.sha256}` };
  }
  return {
    code: 0,
    message: `${name} 已绑定源 RC 记录（${record.tag}）`,
    peer: { name, sha256: actual, sourceTag: record.tag },
  };
}

function main(argv) {
  const args = parseArgs(argv);
  for (const key of ["record", "manifest", "channel", "name"]) {
    if (!args[key]) {
      console.error(`[peer-manifest] 缺少参数 --${key}`);
      return 2;
    }
  }
  const result = verifyPeerManifest({
    record: readJsonFile(args.record),
    manifest: args.manifest,
    channel: args.channel,
    name: args.name,
  });
  if (result.code === 0) {
    if (args.out) {
      fs.writeFileSync(args.out, `${JSON.stringify(result.peer, null, 2)}\n`);
    }
    console.log(`[peer-manifest] OK ${result.message}`);
  } else console.error(`[peer-manifest] ${result.message}`);
  return result.code;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
