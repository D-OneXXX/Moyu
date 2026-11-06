#!/usr/bin/env node
/**
 * PR QA 范围分类器：决定一次 pull_request 需要跑哪些 QA 套件。
 *
 * 原则（fail-closed）：
 * - 纯文档/演示 → 只跑 static；
 * - 小型前端 → static + visual + architecture；
 * - 非高危 Rust → static + architecture + cache；
 * - 高危路径（reader / PDF / online / cache / DB / 更新 / 发布 / 工作流 / 依赖）、
 *   混合前后端、未知路径、空 diff → 全量（suite 为空，交给 qa-full）；
 * - Draft PR → 只跑 static；标记 ready_for_review 后会重新计算。
 *
 * 该脚本只做分类，不执行 QA，也不修改任何文件。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const QA_SUITES = [
  "static",
  "visual",
  "reader",
  "pdf",
  "online",
  "opds",
  "cache",
  "privacy",
  "chaos",
  "architecture",
];

export const QA_E2E_SUITES = new Set(
  QA_SUITES.filter((suite) => suite !== "static"),
);

const SUITE_DOCS = "static";
const SUITE_FRONTEND = "static,visual,architecture";
const SUITE_BACKEND = "static,architecture,cache";
const SUITE_FULL = "";

/** 高危路径：任何一条命中都必须走全量 QA。 */
const FULL_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^scripts\/release-governance\//,
  /^scripts\/release-smoke\//,
  /^scripts\/verify-updater-manifest\.mjs$/,
  /^scripts\/make-linux-critical-manifest\.mjs$/,
  /^src-tauri\/tauri(\.[a-z]+)?\.conf\.json$/,
  /^src-tauri\/(Cargo\.toml|Cargo\.lock|build\.rs)$/,
  /^src-tauri\/capabilities\//,
  /^src-tauri\/icons\//,
  /^src-tauri\/src\/(backup|browser|cache|cache_health|commands|db|diagnostics|disk_cache|lib|logging|main|opds|open_with|paths|pdf|pipeline|progress_service|read_service|render_cache|resilience|security|source|system_proxy|update|versioning|web_contract)(\.rs|\/|$)/,
  /^src-tauri\/src\/(ca|online|web_access)\//,
  /^src\/components\/Reader\//,
  /^src\/components\/(online|privacy|diagnostics)\//,
  /^src\/components\/settings\/(CaDistributionPanel|DataBackupPanel|OnlineFilterPanel|OpdsPanel|PrivacyPanel|UpdatesPanel|WebAccessPanel)\.tsx$/,
  /^src\/components\/library\/(OpdsBrowserDialog|RelocateDialog)\.tsx$/,
  /^src\/features\/(backup|diagnostics|import|online|openWith|pdf|privacy|recovery|resilience|safeMode|update|web-access)\//,
  /^src\/pages\/(Browser|Reader|Settings)\.tsx$/,
  /^src\/lib\/(storageSanitizer|tauri|webtoonGeometry|onlineLastTest)\.ts$/,
  /^src\/web\//,
  /^src\/recovery\//,
  /^vite\.config\./,
  /^tsconfig.*\.json$/,
  /^package(-lock)?\.json$/,
  /^tests\/qa\//,
];

/** 文档/演示/治理元数据：不启动 QA 应用，只跑 static。 */
const DOC_PATTERNS = [
  /^docs\//,
  /\.md$/i,
  /^README/i,
  /^LICENSE/i,
  /^NOTICE/i,
  /^public\/demo\//,
  /^tests\/demo\.test\.mjs$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.github\//,
  /^scripts\//,
  /^tests\//,
];

function normalize(file) {
  return String(file)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

function kindOf(file) {
  const path = normalize(file);
  if (!path) return "unknown";
  if (FULL_PATTERNS.some((pattern) => pattern.test(path))) return "full";
  if (DOC_PATTERNS.some((pattern) => pattern.test(path))) return "docs";
  if (path.startsWith("src-tauri/")) return "backend";
  if (path.startsWith("src/") || path.startsWith("public/") || path === "index.html") {
    return "frontend";
  }
  return "unknown";
}

function suiteRunsE2e(suite) {
  if (!suite) return true; // 空字符串表示全量
  return suite.split(",").some((item) => QA_E2E_SUITES.has(item));
}

/**
 * @param {string[]} files PR 改动的文件路径
 * @param {{ draft?: boolean }} [options]
 * @returns {{ mode: string, suite: string, runsE2e: boolean, reason: string }}
 */
export function classifyQaScope(files, { draft = false } = {}) {
  const normalized = (Array.isArray(files) ? files : []).map(normalize).filter(Boolean);

  if (draft) {
    return {
      mode: "draft",
      suite: SUITE_DOCS,
      runsE2e: suiteRunsE2e(SUITE_DOCS),
      reason: "Draft PR：只跑 static，标记 ready_for_review 后重新计算",
    };
  }

  if (normalized.length === 0) {
    return {
      mode: "full",
      suite: SUITE_FULL,
      runsE2e: true,
      reason: "空 diff / 无法判定：fail-closed 全量",
    };
  }

  const kinds = new Set(normalized.map(kindOf));
  const fullPath = normalized.find((file) => kindOf(file) === "full");
  if (fullPath) {
    return {
      mode: "full",
      suite: SUITE_FULL,
      runsE2e: true,
      reason: `高危路径：${fullPath}`,
    };
  }
  if (kinds.has("unknown")) {
    return {
      mode: "full",
      suite: SUITE_FULL,
      runsE2e: true,
      reason: `未知路径：${normalized.find((file) => kindOf(file) === "unknown")}`,
    };
  }

  const nonDocs = new Set([...kinds].filter((kind) => kind !== "docs"));
  if (nonDocs.size === 0) {
    return {
      mode: "docs",
      suite: SUITE_DOCS,
      runsE2e: false,
      reason: "仅文档/演示/治理元数据",
    };
  }
  if (nonDocs.size === 1 && nonDocs.has("frontend")) {
    return {
      mode: "frontend",
      suite: SUITE_FRONTEND,
      runsE2e: true,
      reason: "仅前端改动",
    };
  }
  if (nonDocs.size === 1 && nonDocs.has("backend")) {
    return {
      mode: "backend",
      suite: SUITE_BACKEND,
      runsE2e: true,
      reason: "仅非高危后端改动",
    };
  }

  return {
    mode: "full",
    suite: SUITE_FULL,
    runsE2e: true,
    reason: `混合范围：${[...kinds].join(",")}`,
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runGitDiff(base, head) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", `${base}...${head}`],
    { encoding: "utf8" },
  );
  return output.split(/\r?\n/).filter(Boolean);
}

function writeOutputs(result) {
  const lines = [
    `mode=${result.mode}`,
    `suite=${result.suite}`,
    `runs_e2e=${result.runsE2e}`,
    `reason=${result.reason}`,
  ];
  const outputPath = argValue("--github-output");
  if (outputPath) {
    fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
  }
  console.log(`[qa-scope] ${lines.join(" | ")}`);
}

function main() {
  const base = argValue("--base");
  const head = argValue("--head");
  if (!base || !head) {
    console.error("[qa-scope] 需要 --base <sha> 与 --head <sha>");
    process.exitCode = 1;
    return;
  }

  let files;
  try {
    files = runGitDiff(base, head);
  } catch (error) {
    console.error(`[qa-scope] 无法计算 ${base}...${head} 的 diff：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const draft = argValue("--draft") === "true";
  const result = classifyQaScope(files, { draft });
  writeOutputs(result);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
