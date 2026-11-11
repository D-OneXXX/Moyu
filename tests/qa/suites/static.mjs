import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fail, note, ok } from "../lib/report.mjs";

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 只提取 `steps:` 下的步骤文本（含 `run: |` 块），不把注释/on/job 级字段
 * 当成步骤内容。用于发布门禁的“步骤真实存在”断言。
 */
function yamlStepTexts(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*steps:\s*$/.test(line));
  if (start < 0) return null;
  let stepIndent = null;
  const steps = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const item = line.match(/^(\s*)-\s+(.*)$/);
    if (item) {
      const indent = item[1].length;
      if (stepIndent === null) stepIndent = indent;
      if (indent === stepIndent) {
        if (current) steps.push(current.join("\n"));
        current = [item[2]];
        continue;
      }
    }
    if (!current) continue;
    const nonEmpty = line.match(/^(\s*)\S/);
    if (
      nonEmpty &&
      nonEmpty[1].length < stepIndent &&
      !line.trim().startsWith("#")
    ) {
      steps.push(current.join("\n"));
      break;
    }
    current.push(line);
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

/**
 * Remove Rust line/block comments while keeping string literals and newlines.
 * Comments may legitimately document "无 sidecar"; only executable code should
 * trip the sidecar guard.
 */
function stripRustComments(source) {
  let out = "";
  let index = 0;
  let blockDepth = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "*" && next === "/") {
        blockDepth -= 1;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      blockDepth = 1;
      out += "  ";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const SIDECAR_PATTERNS = [
  {
    name: "Python 自启 Command",
    regex: /\bCommand\s*::\s*new\s*\(\s*"(?:python(?:3(?:\.\d+)?)?(?:\.exe)?|py)"\s*\)/i,
  },
  {
    name: "硬编码 8500 端口",
    regex: /\b8500\b/,
  },
  {
    name: "sidecar 进程启动",
    regex:
      /(?:\bCommand\s*::\s*new(?:_sidecar)?\s*\(\s*"[^"]*sidecar[^"]*"|\.sidecar\s*\(|\bsidecar\b[\s\S]{0,160}?\.(?:spawn|output|status)\s*\()/i,
  },
];

function scanSidecarSources(root) {
  const sourceRoot = path.join(root, "src-tauri", "src");
  if (!fs.existsSync(sourceRoot)) return [];
  const hits = [];
  for (const file of walk(sourceRoot)) {
    if (!file.endsWith(".rs")) continue;
    if (file.split(path.sep).includes("target")) continue;
    const code = stripRustComments(fs.readFileSync(file, "utf8"));
    for (const pattern of SIDECAR_PATTERNS) {
      const global = new RegExp(
        pattern.regex.source,
        pattern.regex.flags.includes("g")
          ? pattern.regex.flags
          : `${pattern.regex.flags}g`,
      );
      for (const match of code.matchAll(global)) {
        const line = code.slice(0, match.index).split("\n").length;
        hits.push({
          file: path.relative(root, file),
          line,
          name: pattern.name,
          snippet: match[0].replace(/\s+/g, " ").slice(0, 80),
        });
      }
    }
  }
  return hits;
}

function loadTsObject(source, exportName) {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exports = {};
  new Function("exports", "module", js)(exports, { exports });
  return exports[exportName];
}

function collectDictionary(root) {
  const dir = path.join(root, "src", "i18n", "messages");
  const merged = { "zh-CN": {}, "zh-TW": {}, en: {}, es: {}, ja: {}, ko: {} };
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const match = source.match(/export const (\w+Messages)\s*=\s*\{/);
    if (!match) continue;
    const table = loadTsObject(source, match[1]);
    for (const locale of Object.keys(merged)) {
      Object.assign(merged[locale], table[locale]);
    }
  }
  return merged;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[A-Za-z0-9_]+\}/g)]
    .map((match) => match[0])
    .sort()
    .join(",");
}

function sourceKeyUsages(root) {
  const files = walk(path.join(root, "src")).filter(
    (file) =>
      /\.(tsx?|jsx?)$/.test(file) &&
      !file.includes(`${path.sep}i18n${path.sep}`),
  );
  const keys = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    const pattern = /\b(?:t|translate)\(\s*"([^"]+)"/g;
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(pattern)) {
        const key = match[1];
        if (!keys.has(key)) keys.set(key, `${path.relative(root, file)}:${index + 1}`);
      }
    }
  }
  return keys;
}

function versionCheck(root) {
  return execFileSync(process.execPath, ["scripts/version-check.mjs", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
}

export async function runStaticSuite(ctx, report) {
  const { root } = ctx;

  try {
    const output = versionCheck(root);
    const parsed = JSON.parse(output);
    if (!parsed.ok) {
      fail(report, {
        id: "static:version-sync",
        suite: "static",
        layer: "unit",
        title: "三端版本号与前端注入应完全一致",
        severity: "P1",
        details: parsed.errors.map((error) => `${error.file}:${error.line}`).join(", "),
        expected: "package.json / tauri.conf.json / Cargo.toml / Cargo.lock / package-lock 一致",
        actual: "存在不一致",
        location: parsed.errors[0]
          ? `${parsed.errors[0].file}:${parsed.errors[0].line}`
          : "scripts/version-check.mjs:1",
        rootCause: "版本号被手工修改或构建未运行 version:check",
        fix: "npm run version:sync",
      });
    } else {
      ok(report, {
        id: "static:version-sync",
        suite: "static",
        layer: "unit",
        title: "三端版本号与前端注入完全一致",
        details: `v${parsed.expected}`,
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:version-sync",
      suite: "static",
      layer: "unit",
      title: "版本同步门禁无法执行",
      severity: "P0",
      details: error.message,
      location: "scripts/version-check.mjs",
      rootCause: "门禁脚本自身异常",
      fix: "修复脚本并重新运行",
    });
  }

  try {
    execFileSync(process.execPath, ["--test", "scripts/version.test.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    ok(report, {
      id: "static:version-mismatch-line",
      suite: "static",
      layer: "unit",
      title: "故意改错版本时能指出文件与行号",
      details: "fixture 中 tauri.conf.json 第 3 行不一致被捕获",
    });
  } catch (error) {
    fail(report, {
      id: "static:version-mismatch-line",
      suite: "static",
      layer: "unit",
      title: "版本不一致行号定位失败",
      severity: "P0",
      details: error.stdout || error.message,
      location: "scripts/version.test.mjs",
    });
  }

  // 滚动区高度契约：视口必须继承根节点 max-height，根节点负责裁剪。
  // 缺任一条，父级只有 max-height 时视口高度会退化为 auto，长列表就会
  // 冲出卡片压到相邻区块（回归：在线源规则列表）。
  const scrollAreaPath = path.join(root, "src", "components", "ui", "scroll-area.tsx");
  if (fs.existsSync(scrollAreaPath)) {
    const scrollAreaSource = fs.readFileSync(scrollAreaPath, "utf8");
    const missing = [];
    if (!scrollAreaSource.includes("max-h-[inherit]")) {
      missing.push("viewport 缺少 max-h-[inherit]");
    }
    if (!scrollAreaSource.includes("overflow-hidden")) {
      missing.push("root 缺少 overflow-hidden");
    }
    if (missing.length) {
      fail(report, {
        id: "static:scroll-area-bounds",
        suite: "static",
        layer: "ui",
        title: "滚动区缺少高度上限契约",
        severity: "P1",
        details: missing.join("; "),
        location: "src/components/ui/scroll-area.tsx",
        rootCause: "视口 height:100% 在 max-height 父级下退化为 auto，内容会溢出容器",
        fix: "视口继承 max-h-[inherit]，根节点补 overflow-hidden",
      });
    } else {
      ok(report, {
        id: "static:scroll-area-bounds",
        suite: "static",
        layer: "ui",
        title: "滚动区高度上限契约完整",
      });
    }
  }

  // PDF 导入入口：README 承诺「Add books」可选 PDF，文件选择器与重定位
  // 都必须把 pdf 当作文件源；否则用户只能拖拽导入，承诺与实现不一致。
  try {
    const librarySource = fs.readFileSync(
      path.join(root, "src", "pages", "Library.tsx"),
      "utf8",
    );
    const relocateSource = fs.readFileSync(
      path.join(root, "src", "components", "library", "RelocateDialog.tsx"),
      "utf8",
    );
    const localesSource = fs.readFileSync(
      path.join(root, "src", "i18n", "messages", "library.ts"),
      "utf8",
    );
    const problems = [];
    if (!/extensions:\s*\[[^\]]*"pdf"/.test(librarySource)) {
      problems.push("Library.tsx 的导入文件选择器未包含 pdf");
    }
    if (!/\\\.\(zip\|cbz\|pdf\)\$/.test(relocateSource)) {
      problems.push("RelocateDialog.tsx 未把 PDF 识别为文件源");
    }
    if (!/extensions:\s*\[[^\]]*"pdf"/.test(relocateSource)) {
      problems.push("RelocateDialog.tsx 的重定位选择器未包含 pdf");
    }
    const pdfFilterLabels = (
      localesSource.match(/"import\.filesFilter":\s*"[^"]*PDF/g) || []
    ).length;
    if (pdfFilterLabels < 6) {
      problems.push(`六语 filesFilter 提到 PDF 的只有 ${pdfFilterLabels}/6`);
    }
    if (problems.length) {
      fail(report, {
        id: "static:pdf-picker-filters",
        suite: "static",
        layer: "ui",
        title: "PDF 导入/重定位入口与六语文案必须包含 PDF",
        severity: "P1",
        details: problems.join("; "),
        location:
          "src/pages/Library.tsx / src/components/library/RelocateDialog.tsx",
        expected:
          "导入与重定位的文件选择器扩展名包含 pdf，六语 filesFilter 标注 PDF",
        actual: problems.join("; "),
        rootCause:
          "PDF-1 只接入了拖拽/IPC 导入，未覆盖 README 承诺的 Add books 文件选择器",
        fix: "把 pdf 加入文件选择器 extensions，并同步六语文案",
      });
    } else {
      ok(report, {
        id: "static:pdf-picker-filters",
        suite: "static",
        layer: "ui",
        title: "PDF 导入/重定位入口与六语文案包含 PDF",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:pdf-picker-filters",
      suite: "static",
      layer: "ui",
      title: "PDF 导入入口静态检查无法执行",
      severity: "P1",
      details: error.message,
      location: "src/pages/Library.tsx",
    });
  }

  let dictionary = {};
  try {
    dictionary = collectDictionary(root);
    const locales = Object.keys(dictionary);
    const base = dictionary["zh-CN"];
    const errors = [];
    for (const locale of locales) {
      const table = dictionary[locale] || {};
      for (const key of Object.keys(base)) {
        if (!(key in table)) errors.push(`${locale} missing ${key}`);
        else if (placeholders(table[key]) !== placeholders(base[key])) {
          errors.push(`${locale} placeholder mismatch ${key}`);
        } else if (!String(table[key]).trim()) errors.push(`${locale} empty ${key}`);
      }
      for (const key of Object.keys(table)) {
        if (!(key in base)) errors.push(`${locale} extra ${key}`);
      }
    }
    const usages = sourceKeyUsages(root);
    for (const [key, location] of usages) {
      if (!(key in base)) errors.push(`used key missing: ${key} @ ${location}`);
    }
    recordDictionaryResult(report, errors, Object.keys(base).length, locales.length);
  } catch (error) {
    fail(report, {
      id: "static:i18n-parity",
      suite: "static",
      layer: "unit",
      title: "六语种字典完整性与占位符一致",
      severity: "P1",
      details: error.message,
      location: "src/i18n/messages",
      rootCause: "字典模块无法解析或结构错误",
      fix: "修复字典并补齐键",
    });
  }

  try {
    const appSource = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
    const shellSource = fs.readFileSync(
      path.join(root, "src", "components", "shell", "AppShell.tsx"),
      "utf8",
    );
    const routes = [
      ...appSource.matchAll(/<Route\s+path="([^"]+)"/g),
      ...shellSource.matchAll(/<Route\s+path="([^"]+)"/g),
    ].map((match) => match[1]);
    const allowed = new Set(["/reader/:id", "/", "/browser", "/settings", "*"]);
    const ghost = routes.filter((route) => !allowed.has(route));
    if (ghost.length) {
      fail(report, {
        id: "static:removed-routes",
        suite: "static",
        layer: "static",
        title: "已移除模块不得残留前端路由",
        severity: "P1",
        details: ghost.join(", "),
        location: "src/App.tsx / src/components/shell/AppShell.tsx",
        expected: "仅保留书库、阅读器、浏览器、设置",
        actual: `发现 ${ghost.join(", ")}`,
      });
    } else {
      ok(report, {
        id: "static:removed-routes",
        suite: "static",
        layer: "static",
        title: "已移除模块无残留前端路由",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:removed-routes",
      suite: "static",
      layer: "static",
      title: "路由表静态检查失败",
      severity: "P2",
      details: error.message,
      location: "src/App.tsx",
    });
  }

  const removedPatterns = [
    "翻译工作台",
    "批量预翻译",
    "术语表",
    "选区翻译",
    "页 OCR 存档",
    "OCR 存档",
    "服务状态",
    "translation workbench",
    "batch translate",
    "glossary",
    "sidecar status",
  ];
  const runtimeRoots = [
    path.join(root, "src", "pages"),
    path.join(root, "src", "components"),
    path.join(root, "src", "features"),
    path.join(root, "src", "App.tsx"),
  ];
  const runtimeFiles = [];
  for (const target of runtimeRoots) {
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) runtimeFiles.push(...walk(target));
    else runtimeFiles.push(target);
  }
  const ghostHits = [];
  for (const file of runtimeFiles) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of removedPatterns) {
      if (source.toLowerCase().includes(pattern.toLowerCase())) {
        ghostHits.push(`${path.relative(root, file)} :: ${pattern}`);
      }
    }
  }
  if (ghostHits.length) {
    fail(report, {
      id: "static:removed-ui-text",
      suite: "static",
      layer: "static",
      title: "已砍掉模块不得残留前端可见入口/幽灵引用",
      severity: "P1",
      details: ghostHits.join(" | "),
      location: ghostHits[0].split(" :: ")[0],
      expected: "翻译工作台、术语表、OCR/批量翻译、独立服务状态页 100% 无入口",
      actual: ghostHits.join(", "),
      rootCause: "功能减法不彻底",
      fix: "删除残留 UI 文案/入口",
    });
  } else {
    ok(report, {
      id: "static:removed-ui-text",
      suite: "static",
      layer: "static",
      title: "已砍掉模块无前端可见入口",
    });
  }

  let sidecarHits = [];
  try {
    sidecarHits = scanSidecarSources(root);
  } catch (error) {
    sidecarHits = [
      {
        file: "src-tauri/src",
        line: 0,
        name: "扫描失败",
        snippet: String(error),
      },
    ];
  }
  if (sidecarHits.length) {
    fail(report, {
      id: "static:no-python-sidecar",
      suite: "static",
      layer: "static",
      title: "后端残留 Python/sidecar 进程自启痕迹",
      severity: "P1",
      details: sidecarHits
        .map((hit) => `${hit.file}:${hit.line} [${hit.name}] ${hit.snippet}`)
        .join(" | "),
      location: `${sidecarHits[0].file}:${sidecarHits[0].line}`,
      expected: "src-tauri/src 无 Command::new(python/python3)、8500 端口硬编码与 sidecar 启动调用",
      actual: sidecarHits.map((hit) => `${hit.file}:${hit.line} ${hit.name}`).join(", "),
      rootCause: "本地推理服务 sidecar 被重新引入或启动代码未清理",
      fix: "删除 Python 自启/8500 端口/sidecar 进程启动代码；注释说明不受影响",
    });
  } else {
    ok(report, {
      id: "static:no-python-sidecar",
      suite: "static",
      layer: "static",
      title: "后端无 Python/sidecar 进程自启痕迹",
      details: "注释已剥离；仅扫描可执行代码",
    });
  }

  const sidecarModule = path.join(root, "src-tauri", "src", "sidecar.rs");
  if (fs.existsSync(sidecarModule)) {
    fail(report, {
      id: "static:no-sidecar-module",
      suite: "static",
      layer: "static",
      title: "sidecar 模块文件仍存在",
      severity: "P1",
      details: path.relative(root, sidecarModule),
      location: path.relative(root, sidecarModule),
      expected: "src-tauri/src/sidecar.rs 不存在",
      actual: "文件存在",
      rootCause: "sidecar 模块未彻底移除",
      fix: "删除 sidecar.rs 及其 mod 声明",
    });
  } else {
    ok(report, {
      id: "static:no-sidecar-module",
      suite: "static",
      layer: "static",
      title: "sidecar 模块文件已移除",
      details: "src-tauri/src/sidecar.rs 不存在",
    });
  }

  const legacyStyles = ["theme.css", "ui.css", "v3.css"];
  const legacyFiles = legacyStyles.filter((name) =>
    fs.existsSync(path.join(root, "src", name)),
  );
  const sourceFiles = walk(path.join(root, "src"));
  const legacyImports = [];
  for (const file of sourceFiles) {
    if (!/\.(tsx?|jsx?|css)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const name of legacyStyles) {
      if (text.includes(`./${name}`) || text.includes(`/${name}`)) {
        legacyImports.push(`${path.relative(root, file)} -> ${name}`);
      }
    }
  }
  if (legacyFiles.length || legacyImports.length) {
    fail(report, {
      id: "static:legacy-styles",
      suite: "static",
      layer: "static",
      title: "旧版样式文件与引用必须净空",
      severity: "P2",
      details: [...legacyFiles, ...legacyImports].join(", "),
      location: legacyImports[0] || "src/index.css",
    });
  } else {
    ok(report, {
      id: "static:legacy-styles",
      suite: "static",
      layer: "static",
      title: "无 theme.css/ui.css/v3.css 残留",
    });
  }

  if (dictionary["zh-CN"]) {
    note(report, `字典共 ${Object.keys(dictionary["zh-CN"]).length} 个键 × 6 语种`);
  }

  checkCapabilityWall(root, report);
  checkWindowApiCapabilities(root, report);
  checkStorageWhitelist(root, report);
  checkStableErrorCodes(root, dictionary, report);
  checkWebReaderDictionaries(root, report);
  checkNumericTypography(root, report);
  checkUpdateChannelSource(root, report);
  checkWebtoonTextureGuard(root, report);
  checkProductionBundle(root, report);
  checkNoUnusedCustomProtocol(root, report);
  checkCsp(root, report);
  checkPostI18nHardcodedText(root, report);
  checkReleaseSurface(root, report);
  checkAntiMockGuards(root, report);
  checkActionsPinned(root, report);
  checkReleaseGovernance(root, report);
}

/* ------------------------------------------------------------------ */
/* §3.4 发布治理静态守卫（Phase 4）                                     */
/* ------------------------------------------------------------------ */

/**
 * 发布链路必须满足的硬约束（静态可验证部分）：
 *
 * 1. **没有任何 workflow 由 Tag 推送触发**——`push: tags:` 一旦出现，
 *    推送 `v*` 就会直接进入发版流水线（Phase 0 审计出的最高风险）。
 * 2. 发布相关 workflow 只能由 `workflow_dispatch` 手动触发。
 * 3. 发布（publish）workflow 必须声明 `environment:`（人工审批门禁）。
 * 4. 发布 workflow **不得**持有签名私钥（产物已在候选阶段签好名）。
 * 5. 不得存在 `skip_full_qa` / `releaseDraft: false` 之类的绕过开关。
 * 6. 发布 workflow 必须显式声明最小权限（工作流级 `contents: read`，
 *    需要写权限的 job 单独提升），不得使用 `permissions: write-all`。
 */
export function checkReleaseGovernance(root, report) {
  const dir = path.join(root, ".github", "workflows");
  const errors = [];
  const evidence = [];
  const publishFiles = ["release-publish.yml", "release-publish-linux.yml"];
  const candidateFiles = ["release-candidate.yml", "release-candidate-linux.yml"];

  if (!fs.existsSync(dir)) {
    fail(report, {
      id: "static:release-governance",
      suite: "static",
      layer: "static",
      title: "发布治理静态契约缺失",
      severity: "P1",
      details: ".github/workflows 目录不存在",
      location: ".github/workflows",
    });
    return;
  }

  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    // 1) 禁止 Tag 触发。
    if (/push:\s*\n\s*tags:/m.test(source)) {
      errors.push(`${name} 仍由 Tag 推送触发（必须改为 workflow_dispatch 手动触发）`);
    }
    if (/^\s*-\s*"?v\*/m.test(source) && /tags:/m.test(source)) {
      errors.push(`${name} 仍声明了 v* Tag 触发器`);
    }
    // 6) 权限收敛。
    if (/permissions:\s*write-all/.test(source)) {
      errors.push(`${name} 使用了 permissions: write-all`);
    }
    // 5) 绕过开关。
    for (const bypass of ["skip_full_qa", "releaseDraft: false", "skip_approval"]) {
      if (source.includes(bypass)) {
        errors.push(`${name} 含绕过开关 ${bypass}`);
      }
    }
  }

  // 2) 发布相关 workflow 必须手动触发。
  for (const name of [...publishFiles, ...candidateFiles]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      errors.push(`缺少发布工作流 ${name}`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("workflow_dispatch")) {
      errors.push(`${name} 必须由 workflow_dispatch 手动触发`);
    }
    if (!/permissions:\s*\n\s*contents:\s*read/.test(source)) {
      errors.push(`${name} 必须显式声明工作流级 permissions: contents: read`);
    }
  }

  // 3) 发布工作流必须有人工审批门禁；4) 不得持有签名私钥。
  for (const name of publishFiles) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (!/environment:\s*release-(windows|linux)/.test(source)) {
      errors.push(`${name} 必须声明 environment: release-*（人工审批门禁）`);
    }
    if (source.includes("TAURI_SIGNING_PRIVATE_KEY")) {
      errors.push(`${name} 不得引用签名私钥（产物已在候选阶段签名）`);
    }
    if (!source.includes("verify-draft.mjs")) {
      errors.push(`${name} 必须调用发布前绑定校验 verify-draft.mjs`);
    }
    // 强制验收：签名验证 + 真实安装/升级验证必须进发布链路，且无开关可绕。
    if (!source.includes("verify-evidence.mjs")) {
      errors.push(`${name} 必须调用发布证据总闸 verify-evidence.mjs`);
    }
    if (!source.includes("verify-signature.mjs")) {
      errors.push(`${name} 必须执行签名验证 verify-signature.mjs`);
    }
    if (!source.includes("install-verification.json")) {
      errors.push(`${name} 必须要求安装/升级验证证据 install-verification.json`);
    }
    // 发布门禁必须用 main 上的**当前**治理脚本执行：标签提交里的旧副本会让
    // 「候选创建后修过门禁脚本」的情形必然发布失败，只剩绕过门禁一条路。
    if (!source.includes("git checkout FETCH_HEAD -- scripts/")) {
      errors.push(
        `${name} 必须用 main 上的当前门禁脚本执行发布校验（git checkout FETCH_HEAD -- scripts/）`,
      );
    }
    for (const bypass of ["skip_evidence", "skip_signature", "skip_install", "SKIP_EVIDENCE"]) {
      if (source.includes(bypass)) {
        errors.push(`${name} 含证据绕过开关 ${bypass}`);
      }
    }
    if (!source.includes("rehearsal")) {
      errors.push(`${name} 必须显式拒绝演练标签（rehearsal）`);
    }
    evidence.push(`${name}: 手动触发 + environment 门禁 + 绑定校验`);
  }

  // 候选工作流必须持有签名私钥并产出 Draft。
  for (const name of candidateFiles) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("TAURI_SIGNING_PRIVATE_KEY")) {
      errors.push(`${name} 必须使用签名私钥构建候选制品`);
    }
    if (!source.includes("releaseDraft: true") && !source.includes("--draft")) {
      errors.push(`${name} 必须只创建 Draft（releaseDraft: true / --draft），不得直接公开`);
    }
    if (source.includes("releaseDraft: false")) {
      errors.push(`${name} 不得直接公开发布（releaseDraft: false）`);
    }
    if (!source.includes("rc-record.json")) {
      errors.push(`${name} 必须产出 rc-record.json（审批依据）`);
    }
    // 隔离演练模式：只允许 v0.0.0-rehearsal，产物带前缀且永不发布。
    // 目前只在 Windows 候选工作流提供（NSIS 安装验证是正式发布的强制条件）。
    if (name === "release-candidate.yml" && !source.includes("rehearsal")) {
      errors.push(`${name} 必须提供隔离演练模式（rehearsal），否则无法做非正式发布演练`);
    }
    evidence.push(`${name}: 构建签名 → Draft + rc-record`);
  }

  // 7) 安装/升级验证必须声明「干净环境」：共享宿主上的回执不能满足发布强制条件。
  //    契约与产出脚本两侧都要有，缺任一侧门禁都会失效。
  const installScript = path.join(
    root,
    "scripts",
    "release-smoke",
    "windows-install-upgrade.ps1",
  );
  const evidenceModule = path.join(
    root,
    "scripts",
    "release-governance",
    "evidence.mjs",
  );
  const rcModule = path.join(root, "scripts", "release-governance", "rc-record.mjs");
  for (const [label, file, needle] of [
    ["安装验证脚本", installScript, "cleanEnvironment"],
    ["证据契约 evidence.mjs", evidenceModule, "cleanEnvironment"],
    ["回执契约 rc-record.mjs", rcModule, "cleanEnvironment"],
  ]) {
    if (!fs.existsSync(file)) {
      errors.push(`缺少${label}：${path.relative(root, file)}`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes(needle)) {
      errors.push(
        `${label} 必须要求安装证据声明干净环境（cleanEnvironment）：${path.relative(root, file)}`,
      );
    }
  }

  // 8) 干净环境必须可核实：provenance / 合成书库+进度+IPC / 精确制品摘要，
  //    并且 hosted 验证工作流只做只读下载与验证。
  if (fs.existsSync(installScript)) {
    const source = fs.readFileSync(installScript, "utf8");
    for (const marker of [
      "ExpectedSha256",
      "expectedArtifactSha256",
      "previousArtifactSha256",
      "cleanEnvironment",
      "provenance",
      "imageVersion",
      "library",
      "list_books",
      "MergeFrom",
    ]) {
      if (!source.includes(marker)) {
        errors.push(`安装验证脚本缺少可核实证据标记 ${marker}`);
      }
    }
  }
  const installVerifyWorkflow = path.join(dir, "release-install-verify.yml");
  if (!fs.existsSync(installVerifyWorkflow)) {
    errors.push("缺少干净 VM 安装验证工作流 release-install-verify.yml");
  } else {
    const source = fs.readFileSync(installVerifyWorkflow, "utf8");
    for (const marker of [
      "workflow_dispatch",
      "runs-on: windows-2022",
      "CleanEnvironment",
      "prepare-candidate.mjs",
      "library-ui-check.mjs",
      "install-verification.json",
      "verify-evidence.mjs",
      "Attach verified install evidence to Draft",
    ]) {
      if (!source.includes(marker)) {
        errors.push(`release-install-verify.yml 缺少 ${marker}`);
      }
    }
    if (/push:\s*\n\s*tags:/m.test(source)) {
      errors.push("release-install-verify.yml 不得由 Tag 推送触发");
    }
    const secretRefs = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    );
    const disallowed = [...new Set(secretRefs.filter((name) => name !== "GITHUB_TOKEN"))];
    if (disallowed.length > 0) {
      errors.push(`release-install-verify.yml 不得引用非默认 Secret：${disallowed.join(", ")}`);
    }
    // 安装验证只允许把**已核验的安装回执**附到 Draft；不得修改/删除/发布 Release。
    const uploadLines = [...source.matchAll(/gh release\s+upload\s+([^\n`]+)/g)].map(
      (match) => match[1].trim(),
    );
    if (uploadLines.length > 1) {
      errors.push("release-install-verify.yml 只允许一次 Release 上传（install-verification.json）");
    }
    for (const line of uploadLines) {
      if (!/install-verification\.json/.test(line)) {
        errors.push(`release-install-verify.yml 不得上传其他资产：${line}`);
      }
    }
    if (/gh release\s+(edit|delete)|--draft=false/i.test(source)) {
      errors.push("release-install-verify.yml 不得修改/删除/发布 Release");
    }
    evidence.push(
      "release-install-verify.yml: workflow_dispatch + windows-2022 + 只读下载 + 单次上传安装回执",
    );
  }
  const linuxInstallVerifyWorkflow = path.join(dir, "release-install-verify-linux.yml");
  if (!fs.existsSync(linuxInstallVerifyWorkflow)) {
    errors.push("缺少干净 Linux 安装验证工作流 release-install-verify-linux.yml");
  } else {
    const source = fs.readFileSync(linuxInstallVerifyWorkflow, "utf8");
    for (const marker of [
      "workflow_dispatch",
      "runs-on: ubuntu-22.04",
      "prepare-candidate-linux.mjs",
      "linux-install-check.mjs",
      "linux-pdf-runtime.mjs",
      "linux-install-evidence.mjs",
      "verify-evidence.mjs",
      "--channel linux-critical",
      "--experimental-sqlite",
      'apt-get install -y "./previous/',
      'apt-get install -y "./candidate/',
      "install-verification.json",
      "verify-signature.mjs",
    ]) {
      if (!source.includes(marker)) {
        errors.push(`release-install-verify-linux.yml 缺少 ${marker}`);
      }
    }
    if (/push:\s*\n\s*tags:/m.test(source)) {
      errors.push("release-install-verify-linux.yml 不得由 Tag 推送触发");
    }
    // Draft Release 只对具备写权限的令牌可见；权限是这个工作流唯一需要 write
    // 的地方，行为仍然是只读——下面的守卫禁止任何 Release 写入。
    if (!/permissions:\s*\n\s*contents:\s*write/.test(source)) {
      errors.push(
        "release-install-verify-linux.yml 必须声明 contents: write（否则看不到 Draft）",
      );
    }
    if (!/仅用于让令牌可见 \*\*Draft\*\* Release/.test(source)) {
      errors.push("release-install-verify-linux.yml 必须注明 contents: write 只用于 Draft 可见性");
    }
    const secretRefs = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    );
    const disallowed = [...new Set(secretRefs.filter((name) => name !== "GITHUB_TOKEN"))];
    if (disallowed.length > 0) {
      errors.push(
        `release-install-verify-linux.yml 不得引用非默认 Secret：${disallowed.join(", ")}`,
      );
    }
    // 写权限只为可见 Draft；不得出现任何 Release / API 写操作。
    if (/gh release\s+(create|upload|edit|delete)|--draft=false/i.test(source)) {
      errors.push("release-install-verify-linux.yml 不得创建/上传/修改/发布 Release");
    }
    if (/\bgh api\b(?![^\n]*(--method|-X)\s*(GET|HEAD)\b)/.test(source)) {
      errors.push("release-install-verify-linux.yml 不得调用 gh api 写方法");
    }
    if (/\bmethod:\s*(POST|PATCH|PUT|DELETE)\b/i.test(source)) {
      errors.push("release-install-verify-linux.yml 不得以 POST/PATCH/PUT/DELETE 调用 API");
    }
    evidence.push(
      "release-install-verify-linux.yml: workflow_dispatch + ubuntu-22.04 + 只读下载 + 真实 deb 安装/升级/PDF/备份证据",
    );
  }
  const linuxPublishPath = path.join(dir, "release-publish-linux.yml");
  if (fs.existsSync(linuxPublishPath)) {
    const source = fs.readFileSync(linuxPublishPath, "utf8");
    if (!source.includes("verify-provenance.mjs")) {
      errors.push("release-publish-linux.yml 必须在线核验 Linux 安装证据 provenance");
    }
    if (!source.includes("release-install-verify-linux.yml")) {
      errors.push("release-publish-linux.yml 的 provenance 必须指向 Linux 安装验证工作流");
    }
    if (!/actions:\s*read/.test(source)) {
      errors.push("release-publish-linux.yml 必须声明 actions: read");
    }
  }
  const windowsPublishPath = path.join(dir, "release-publish.yml");
  if (fs.existsSync(windowsPublishPath)) {
    const source = fs.readFileSync(windowsPublishPath, "utf8");
    if (!source.includes("verify-provenance.mjs")) {
      errors.push("release-publish.yml 必须在线核验安装证据 provenance");
    }
    if (!source.includes("--require-github-actions")) {
      errors.push(
        "release-publish.yml 必须强制 GitHub-hosted 干净环境证据（与 Linux 通道一致）",
      );
    }
    if (!source.includes("Audit deployment approval boundary")) {
      errors.push("release-publish.yml 必须记录触发者与 deployment 审批人的边界审计");
    }
    if (!/actions:\s*read/.test(source)) {
      errors.push("release-publish.yml 必须声明 actions: read（读取 run 审批/运行来源）");
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:release-governance",
      suite: "static",
      layer: "static",
      title: "发布治理静态契约被破坏（Tag 触发 / 缺审批门禁 / 存在绕过开关）",
      severity: "P1",
      details: errors.join(" | "),
      location: ".github/workflows",
      expected:
        "无 Tag 触发的发布工作流；手动触发 + environment 审批门禁 + 发布前绑定校验；无跳过 QA/审批的开关",
      actual: errors.join(" | "),
      rootCause: "新增或修改发版工作流时引入了 Tag 触发、宽松权限或绕过开关",
      fix: "按内部发布治理文档（维护者本地维护）恢复：dispatch 触发 + environment + verify-draft 绑定校验",
    });
  } else {
    ok(report, {
      id: "static:release-governance",
      suite: "static",
      layer: "static",
      title: "发布治理静态契约成立（无 Tag 触发 / 有审批门禁 / 无绕过开关）",
      details: evidence.join("；"),
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3.3 GitHub Actions 供应链固定守卫                                  */
/* ------------------------------------------------------------------ */

/**
 * 所有 `uses:` 必须固定到 40 位 commit SHA（可带版本注释）。
 *
 * 理由：浮动 tag（`@v4` / `@stable`）可以在无人 review 的情况下改变被执行的
 * 代码；固定 SHA 后，升级必须走一次显式提交（同时保留版本注释可读性）。
 */
export function checkActionsPinned(root, report) {
  const dir = path.join(root, ".github", "workflows");
  const errors = [];
  const evidence = [];
  if (!fs.existsSync(dir)) {
    fail(report, {
      id: "static:actions-pinned",
      suite: "static",
      layer: "static",
      title: "GitHub Actions 未固定到 commit SHA",
      severity: "P1",
      details: ".github/workflows 目录不存在",
      location: ".github/workflows",
      expected: "所有 uses: 固定到 40 位 SHA",
      actual: "目录缺失",
    });
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    let count = 0;
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/uses:\s*([^\s#]+)/);
      if (!match) continue;
      const ref = match[1];
      // 本地可复用工作流 / 本地 action（`./...`）与调用方是同一个 commit，
      // 不存在"版本漂移"的问题，因此不能要求 40 位 SHA。
      if (ref.startsWith("./")) continue;
      count += 1;
      const sha = ref.match(/@([0-9a-f]{40})$/);
      if (!sha) {
        errors.push(`${name}: ${ref} 未固定到 40 位 commit SHA`);
      }
    }
    if (count > 0) evidence.push(`${name}: ${count} 处 uses 已固定`);
  }
  if (errors.length) {
    fail(report, {
      id: "static:actions-pinned",
      suite: "static",
      layer: "static",
      title: "GitHub Actions 未固定到 commit SHA",
      severity: "P1",
      details: errors.join(" | "),
      location: ".github/workflows",
      expected: "所有 uses: 固定到 40 位 commit SHA（保留版本注释）",
      actual: errors.join(" | "),
      rootCause: "新增或升级 workflow 时使用了浮动 tag/分支引用",
      fix: "把 uses 改为 <action>@<40 位 SHA> # <版本>",
    });
  } else {
    ok(report, {
      id: "static:actions-pinned",
      suite: "static",
      layer: "static",
      title: "GitHub Actions 全部固定到 commit SHA",
      details: evidence.join("；"),
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3.2 更新通道唯一事实源守卫                                         */
/* ------------------------------------------------------------------ */

/**
 * 更新通道的端点与公钥只能来自构建期写进二进制的 `tauri.conf.json
 * plugins.updater`。设置页签名徽章（`get_app_info`）与隐私安全自检
 * （`security_audit`）必须读同一份配置。
 *
 * 0.17.0 / 0.17.1 的事故：自检卡读的是已下线的旧补丁通道（编译期 MR_UPDATE_PUBKEY +
 * 本机遗留清单地址），正式版必然显示「尚未配置更新清单地址 / 签名公钥：未启用」
 * 的假告警。本守卫把「唯一事实源」写成硬契约，防止回归。
 */
export function checkUpdateChannelSource(root, report) {
  const errors = [];
  const read = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      errors.push(`缺少 ${relative}`);
      return "";
    }
    return fs.readFileSync(file, "utf8");
  };

  const updateRs = read("src-tauri/src/update.rs");
  const securityRs = read("src-tauri/src/security.rs");
  const privacyApi = read("src/features/privacy/api.ts");
  const updateTypes = read("src/features/update/types.ts");
  const sanitizer = read("src/lib/storageSanitizer.ts");

  // 1) 提取器与唯一读取点必须存在。
  if (!updateRs.includes("NativeUpdaterConfig")) {
    errors.push("update.rs 缺少 NativeUpdaterConfig（更新通道配置提取器）");
  }
  if (!updateRs.includes("from_tauri_config")) {
    errors.push("update.rs 缺少 from_tauri_config（未从运行时 Tauri 配置读取更新通道）");
  }
  if (!securityRs.includes("from_tauri_config")) {
    errors.push(
      "security.rs 的自检未读取构建期更新通道配置（正式版会出现未配置/未签名假告警）",
    );
  }

  // 2) 自检不得回退到旧补丁通道的单一事实源。
  if (securityRs.includes("update_key_configured")) {
    errors.push("security.rs 仍在用旧补丁通道的 update_key_configured 判定签名");
  }
  if (securityRs.includes("manifest_url")) {
    errors.push("security.rs 仍在读本机遗留清单地址 manifest_url");
  }
  if (/manifestUrl\s*[:=]/.test(privacyApi)) {
    errors.push("privacy/api.ts 仍在向 security_audit 传本机更新源地址");
  }

  // 3) 已下线的遗留偏好不得复活。
  if (updateTypes.includes("mr-update-prefs") || updateTypes.includes("manifestUrl")) {
    errors.push("features/update/types.ts 仍在读写旧补丁通道的本机偏好");
  }
  if (!/DEPRECATED_KEY_PREFIXES[\s\S]*?"mr-update-prefs"/.test(sanitizer)) {
    errors.push("storageSanitizer.ts 未把 mr-update-prefs 登记为废弃键");
  }

  if (errors.length) {
    fail(report, {
      id: "static:update-channel-source",
      suite: "static",
      layer: "static",
      title: "更新通道未收敛到构建期唯一事实源",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/src/security.rs / src/features/privacy/api.ts",
      expected:
        "端点与公钥只来自 tauri.conf.json plugins.updater；自检与徽章共用 NativeUpdaterConfig",
      actual: errors.join(" | "),
      rootCause: "自检改读了已下线的旧补丁通道，正式版出现「未配置 / 未签名」假告警",
      fix: "按 AGENTS.md §4.1 用 update::NativeUpdaterConfig::from_tauri_config 统一读取",
    });
  } else {
    ok(report, {
      id: "static:update-channel-source",
      suite: "static",
      layer: "static",
      title: "更新通道端点与公钥收敛到构建期唯一事实源",
      details: "自检与签名徽章共用 NativeUpdaterConfig，旧补丁通道偏好已下线",
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3.1 CSP 无条件守卫                                               */
/* ------------------------------------------------------------------ */

/**
 * 生产 CSP 不得为空。审计要求即使没有自定义 URI 协议，也必须验证
 * default/script/img/connect/style 五个关键指令；null/缺失直接红灯。
 */
export function checkCsp(root, report) {
  let csp = null;
  try {
    csp = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    )?.app?.security?.csp;
  } catch {
    csp = null;
  }
  const value = typeof csp === "string" ? csp.trim() : "";
  const problems = [];
  if (!value) {
    problems.push("app.security.csp 为空或缺失");
  } else {
    const directives = {
      "default-src": /(?:^|;)\s*default-src\s+[^;]*'self'/,
      "script-src": /(?:^|;)\s*script-src\s+[^;]*'self'/,
      "img-src": /(?:^|;)\s*img-src\s+[^;]*'self'[^;]*\bdata:/,
      "connect-src-self": /(?:^|;)\s*connect-src\s+[^;]*'self'/,
      "connect-src-ipc": /(?:^|;)\s*connect-src\s+[^;]*\bipc:/,
      "connect-src-host": /(?:^|;)\s*connect-src\s+[^;]*(?:tauri\.localhost|ipc\.localhost)/,
      "style-src": /(?:^|;)\s*style-src\s+[^;]*'self'[^;]*'unsafe-inline'/,
    };
    for (const [name, regex] of Object.entries(directives)) {
      if (!regex.test(value)) problems.push(`CSP 缺少 ${name} 关键指令`);
    }
    // Linux（tauri://localhost）下 PDF.js 的 CMap / 标准字体走同源 fetch，
    // 必须由 'self' 放行；除此之外 connect-src 只允许 IPC 与本地 tauri 源，
    // 任何通配符、外部 origin 或 scheme 级放行都必须被拒绝（防止静默放宽）。
    const connect = (value.match(/(?:^|;)\s*connect-src\s+([^;]*)/)?.[1] || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const allowedConnect = new Set([
      "'self'",
      "ipc:",
      "http://ipc.localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ]);
    const extraConnect = connect.filter((token) => !allowedConnect.has(token));
    if (extraConnect.length) {
      problems.push(`connect-src 出现未批准来源：${extraConnect.join(" ")}`);
    }
  }

  if (problems.length) {
    fail(report, {
      id: "static:csp",
      suite: "static",
      layer: "static",
      title: "生产 CSP 缺失或关键指令不完整",
      severity: "P1",
      details: problems.join(" | "),
      location: "src-tauri/tauri.conf.json",
      expected:
        "app.security.csp 至少包含 default-src 'self'、script-src 'self'、img-src 'self' data:、connect-src 'self' + ipc: + tauri/ipc.localhost、style-src 'self' 'unsafe-inline'；connect-src 不得出现通配符或外部来源",
      actual: value || "null/missing",
      rootCause: "CSP 被置空，或收紧时漏掉 IPC/data URL/内联样式关键来源",
      fix: "按内部技术文档的 CSP 基线恢复（维护者本地维护）；devCsp 单独放行 Vite，不要放宽生产 csp",
    });
  } else {
    ok(report, {
      id: "static:csp",
      suite: "static",
      layer: "static",
      title: "生产 CSP 非空且覆盖 IPC/data URL/内联样式",
      details: value,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §2.3 发行级长尾体验：文件关联 / 备份 / Updater / 单实例           */
/* ------------------------------------------------------------------ */

/**
 * 守卫 0.16.0 的发行面：文件关联、备份命令、官方 Updater 公钥/endpoint、
 * 签名 CI、主窗专属 capability，以及三个用户入口文件。
 * 只做静态契约检查，不启动应用；运行期行为由 Rust 单测 + 真机冒烟覆盖。
 */
function isGitHubLatestEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.endsWith("/latest.json")
    );
  } catch {
    return false;
  }
}

export function checkReleaseSurface(root, report) {
  const errors = [];
  const read = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      errors.push(`缺少 ${relative}`);
      return "";
    }
    return fs.readFileSync(file, "utf8");
  };
  const parseJson = (relative) => {
    try {
      return JSON.parse(read(relative));
    } catch (error) {
      errors.push(`${relative} 不是合法 JSON: ${error.message}`);
      return null;
    }
  };

  const conf = parseJson("src-tauri/tauri.conf.json");
  if (conf) {
    // 升级身份：NSIS 的卸载/升级键、快捷方式与文件关联都依赖这两个值。
    // 一旦改名，旧版本的桌面快捷方式、.cbz 关联和自动更新继承会断链。
    if (conf.productName !== "MangaReader") {
      errors.push(`productName 必须固定为 MangaReader（当前 ${conf.productName}）`);
    }
    if (conf.identifier !== "com.local.manga-reader") {
      errors.push(
        `identifier 必须固定为 com.local.manga-reader（当前 ${conf.identifier}）`,
      );
    }
    if (conf.mainBinaryName !== "manga-reader-tauri") {
      errors.push(
        `mainBinaryName 必须固定为 manga-reader-tauri（当前 ${conf.mainBinaryName}）`,
      );
    }

    const expectedTargets = ["nsis", "deb", "rpm", "appimage"];
    const targets = Array.isArray(conf.bundle?.targets)
      ? conf.bundle.targets
      : [];
    if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) {
      errors.push(
        `bundle.targets 必须锁定为 ${JSON.stringify(expectedTargets)}（当前 ${JSON.stringify(targets)}）`,
      );
    }
    if (targets.includes("msi")) {
      errors.push("bundle.targets 不得包含 msi：Windows 只发布 NSIS");
    }

    const associations = Array.isArray(conf.bundle?.fileAssociations)
      ? conf.bundle.fileAssociations
      : [];
    const extensions = associations.flatMap((entry) =>
      Array.isArray(entry?.ext) ? entry.ext : [],
    );
    for (const ext of ["cbz", "zip"]) {
      if (!extensions.includes(ext)) {
        errors.push(`bundle.fileAssociations 缺少 .${ext}`);
      }
    }

    const nsis = conf.bundle?.windows?.nsis;
    if (!nsis || typeof nsis !== "object") {
      errors.push("bundle.windows.nsis 缺失");
    } else {
      if (nsis.installMode !== "both") {
        errors.push("bundle.windows.nsis.installMode 必须为 both");
      }
      if (nsis.compression !== "lzma") {
        errors.push("bundle.windows.nsis.compression 必须为 lzma");
      }
      if (nsis.displayLanguageSelector !== true) {
        errors.push("bundle.windows.nsis.displayLanguageSelector 必须为 true");
      }
      const expectedLanguages = [
        "SimpChinese",
        "TradChinese",
        "English",
        "Spanish",
        "Japanese",
        "Korean",
      ];
      if (JSON.stringify(nsis.languages) !== JSON.stringify(expectedLanguages)) {
        errors.push(
          `bundle.windows.nsis.languages 必须为 ${JSON.stringify(expectedLanguages)}`,
        );
      }
    }

    if (conf.bundle?.createUpdaterArtifacts !== true) {
      errors.push("bundle.createUpdaterArtifacts 必须为 true");
    }
    if (
      typeof conf.plugins?.updater?.pubkey !== "string" ||
      conf.plugins.updater.pubkey.trim().length < 32
    ) {
      errors.push("plugins.updater.pubkey 缺失或过短");
    }
    const endpoints = Array.isArray(conf.plugins?.updater?.endpoints)
      ? conf.plugins.updater.endpoints
      : [];
    if (
      !endpoints.some(
        (endpoint) =>
          typeof endpoint === "string" && isGitHubLatestEndpoint(endpoint),
      )
    ) {
      errors.push("plugins.updater.endpoints 缺少 GitHub latest.json");
    }
    if (conf.plugins?.updater?.windows?.installMode !== "passive") {
      errors.push("plugins.updater.windows.installMode 必须为 passive");
    }
  }

  const updaterCapability = parseJson("src-tauri/capabilities/updater.json");
  if (updaterCapability) {
    const windows = Array.isArray(updaterCapability.windows)
      ? updaterCapability.windows
      : [];
    const permissions = Array.isArray(updaterCapability.permissions)
      ? updaterCapability.permissions
      : [];
    if (windows.length !== 1 || windows[0] !== "main") {
      errors.push("updater.json 只能覆盖 main 窗口");
    }
    // WebView 不得直连官方更新插件：check/install 只能经自研代理命令。
    if (permissions.includes("updater:default")) {
      errors.push(
        "updater.json 不得授予 updater:default（检查/安装只走 check_native_update / install_native_update 代理命令）",
      );
    }
    if (
      permissions.some(
        (permission) =>
          String(permission).startsWith("updater:") ||
          String(permission).startsWith("process:"),
      )
    ) {
      errors.push(
        "updater.json 不得声明 updater:* / process:* 权限（代理命令 + 自研 restart_app）",
      );
    }
  }

  // 官方更新通道的代理契约：前端不再 import 插件，只调用两个自研命令；
  // 两个命令在 lib.rs 注册，且 updater_gate 必须先过 FeatureId::Updates 门卫。
  const nativeUpdateSource = read("src/features/update/native.ts");
  const libSourceForUpdater = read("src-tauri/src/lib.rs");
  if (nativeUpdateSource.includes("@tauri-apps/plugin-updater")) {
    errors.push(
      "native.ts 不得 import @tauri-apps/plugin-updater（WebView 无 updater 权限）",
    );
  }
  for (const command of ["check_native_update", "install_native_update"]) {
    if (!nativeUpdateSource.includes(`"${command}"`)) {
      errors.push(`native.ts 未调用代理命令 ${command}`);
    }
    if (!libSourceForUpdater.includes(`updater_gate::${command}`)) {
      errors.push(`lib.rs 未注册 updater_gate::${command}`);
    }
  }
  const updaterGateSource = read("src-tauri/src/updater_gate.rs");
  if (!updaterGateSource.includes("FeatureId::Updates")) {
    errors.push("updater_gate 未调用 FeatureId::Updates 门卫");
  }
  for (const command of ["check_native_update", "install_native_update"]) {
    const gateIndex = updaterGateSource.indexOf(`pub async fn ${command}`);
    const gateCallIndex = updaterGateSource.indexOf(
      "open_updates(&flags)",
      gateIndex,
    );
    const updaterIndex = updaterGateSource.indexOf(".updater()", gateIndex);
    if (gateIndex < 0 || gateCallIndex < 0) {
      errors.push(`${command} 未先调用 open_updates 门卫`);
    } else if (updaterIndex >= 0 && updaterIndex < gateCallIndex) {
      errors.push(`${command} 在门卫之前访问了 updater`);
    }
  }

  // Phase 4：发布链路拆成「候选（Draft）→ 发布（审批后公开）」，双通道各自独立。
  const windowsCandidate = read(".github/workflows/release-candidate.yml");
  const windowsPublish = read(".github/workflows/release-publish.yml");
  const linuxCandidate = read(".github/workflows/release-candidate-linux.yml");
  const linuxPublish = read(".github/workflows/release-publish-linux.yml");

  const windowsCandidateSteps = yamlStepTexts(windowsCandidate);
  const windowsCandidateText = windowsCandidateSteps
    ? windowsCandidateSteps.join("\n")
    : "";
  if (!windowsCandidateSteps || windowsCandidateSteps.length === 0) {
    errors.push("release-candidate.yml 未解析到 steps");
  }
  for (const marker of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "MR_BUILD_ORIGIN: official",
    "npx tsc --noEmit",
    "cargo test --lib",
    "npm run build",
    // 候选只落成 Draft，并产出审批依据。
    "releaseDraft: true",
    "uploadUpdaterJson: true",
    "rc-record.json",
    // QA 证据按 run id 绑定到候选 Commit。
    "qa_run_id",
    "verify-updater-manifest.mjs",
    // 候选必须自动产出签名验证回执（install-verify 从 Draft 读取）。
    "Verify candidate signature",
    "fetch-minisign.mjs",
    "verify-signature.mjs",
    "signature-verification.json",
    // 候选不得改写已公开发布的 Release（与 Linux 通道一致）。
    "Refuse to touch a published release",
    'gh release view "$TAG" --json isDraft',
    // 发布正文可由维护者随候选写入，避免公开占位文本。
    "release_notes",
  ]) {
    if (!windowsCandidateText.includes(marker)) {
      errors.push(`release-candidate.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of [
    "windows-2022",
    "workflow_dispatch",
    "environment: release-windows",
    "contents: read",
    "contents: write",
  ]) {
    if (!windowsCandidate.includes(marker)) {
      errors.push(`release-candidate.yml 缺少 ${marker}`);
    }
  }
  if (/releaseDraft:\s*false/.test(windowsCandidate)) {
    errors.push("release-candidate.yml 不得直接公开发布（只能创建 Draft）");
  }

  const windowsPublishSteps = yamlStepTexts(windowsPublish);
  const windowsPublishText = windowsPublishSteps ? windowsPublishSteps.join("\n") : "";
  if (!windowsPublishSteps || windowsPublishSteps.length === 0) {
    errors.push("release-publish.yml 未解析到 steps");
  }
  for (const marker of [
    "verify-draft.mjs",
    "gh release edit",
    "--draft=false",
    "verify-updater-manifest.mjs",
    "latest-linux-critical.json",
  ]) {
    if (!windowsPublishText.includes(marker)) {
      errors.push(`release-publish.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of ["workflow_dispatch", "environment: release-windows"]) {
    if (!windowsPublish.includes(marker)) {
      errors.push(`release-publish.yml 缺少 ${marker}`);
    }
  }
  if (windowsPublish.includes("TAURI_SIGNING_PRIVATE_KEY")) {
    errors.push("release-publish.yml 不得持有签名私钥（产物已在候选阶段签名）");
  }

  const linuxCandidateSteps = yamlStepTexts(linuxCandidate);
  const linuxCandidateText = linuxCandidateSteps ? linuxCandidateSteps.join("\n") : "";
  if (!linuxCandidateSteps || linuxCandidateSteps.length === 0) {
    errors.push("release-candidate-linux.yml 未解析到 steps");
  }
  for (const marker of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "latest-linux-critical.json",
    "MR_BUILD_ORIGIN: official",
    "make-linux-critical-manifest.mjs",
    "npx tsc --noEmit",
    "cargo test --lib",
    "npm run build",
    "--config src-tauri/tauri.linux.conf.json",
    "--draft",
    "rc-record.json",
    "qa_run_id",
    "verify-updater-manifest.mjs",
    "release-notes.mjs",
    "release_notes",
  ]) {
    if (!linuxCandidateText.includes(marker)) {
      errors.push(`release-candidate-linux.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of [
    "ubuntu-22.04",
    "workflow_dispatch",
    "environment: release-linux",
    "contents: read",
    "contents: write",
  ]) {
    if (!linuxCandidate.includes(marker)) {
      errors.push(`release-candidate-linux.yml 缺少 ${marker}`);
    }
  }

  const linuxPublishSteps = yamlStepTexts(linuxPublish);
  const linuxPublishText = linuxPublishSteps ? linuxPublishSteps.join("\n") : "";
  if (!linuxPublishSteps || linuxPublishSteps.length === 0) {
    errors.push("release-publish-linux.yml 未解析到 steps");
  }
  for (const marker of [
    "verify-draft.mjs",
    "gh release edit",
    "--draft=false",
    "verify-updater-manifest.mjs",
    "linux-x86_64",
  ]) {
    if (!linuxPublishText.includes(marker)) {
      errors.push(`release-publish-linux.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of ["workflow_dispatch", "environment: release-linux"]) {
    if (!linuxPublish.includes(marker)) {
      errors.push(`release-publish-linux.yml 缺少 ${marker}`);
    }
  }
  if (linuxPublish.includes("TAURI_SIGNING_PRIVATE_KEY")) {
    errors.push("release-publish-linux.yml 不得持有签名私钥（产物已在候选阶段签名）");
  }

  // Linux 端 updater 端点必须独立指向高危补丁通道（平台专属配置覆盖）。
  const linuxConf = parseJson("src-tauri/tauri.linux.conf.json");
  if (linuxConf) {
    const endpoints = Array.isArray(linuxConf.plugins?.updater?.endpoints)
      ? linuxConf.plugins.updater.endpoints
      : [];
    if (
      !endpoints.some((endpoint) =>
        typeof endpoint === "string" ? endpoint.endsWith("latest-linux-critical.json") : false,
      )
    ) {
      errors.push("tauri.linux.conf.json 的 updater 端点必须指向 latest-linux-critical.json");
    }
  }

  // Linux 发布链必须真的应用平台 overlay：overlay 文件存在不等于被使用。
  // 少了 --config，Linux 产物会带着 Windows 的 latest.json 端点，
  // 更新功能对 Linux 客户端形同虚设。
  if (linuxCandidateText && !linuxCandidateText.includes("--config src-tauri/tauri.linux.conf.json")) {
    errors.push(
      "release-candidate-linux.yml 的 tauri build 必须带 --config src-tauri/tauri.linux.conf.json",
    );
  }
  // 无预建标签的 Draft 必须绑定完整固定提交，并在写入前重新验证远端状态；
  // 步骤顺序和错误分支由 workflow-contract.test.mjs 进一步约束。
  if (linuxCandidateText && (
    !/gh release create "\$TAG" --target "\$COMMIT" --draft/.test(linuxCandidateText) ||
    !linuxCandidateText.includes("Re-check candidate identity before Draft write") ||
    !linuxCandidateText.includes("candidate-evidence.mjs") ||
    !linuxCandidateText.includes("COMMIT: ${{ steps.identity.outputs.commit }}")
  )) {
    errors.push("release-candidate-linux.yml 的 Draft 必须绑定已验证提交并在写入前复核身份");
  }
  // AppImage 的 minisign 签名必须作为 Release 资产发布：清单里虽然内嵌了签名，
  // 但缺了 .sig 资产，用户就无法手动验签（Windows 通道同样发布 .exe.sig）。
  if (linuxCandidateText && !linuxCandidateText.includes("appimage/*.AppImage.sig")) {
    errors.push("release-candidate-linux.yml 必须上传 appimage/*.AppImage.sig");
  }

  // 常规 CI 必须覆盖 main 与 PR，且门禁步骤真实存在于 steps 内。
  // Linux / Windows 门禁已合并为单个 matrix 工作流 ci.yml；两个必需检查名
  // 由 matrix 的 name 逐字产出，分支保护按这个上下文名匹配，改名即失效。
  for (const [file, markers, requiredNames] of [
    [
      ".github/workflows/ci.yml",
      [
        "cargo clippy",
        "-D warnings",
        "--test e2e_stage1",
        "--test memory_budget",
        "cargo audit",
        "npm audit",
        "npx tsc --noEmit",
        "cargo test --lib",
        "tests/qa/run-qa.mjs",
      ],
      [
        "cargo check + frontend build (ubuntu-22.04)",
        "tsc + cargo test + static QA (windows-latest)",
      ],
    ],
  ]) {
    const source = read(file);
    const steps = yamlStepTexts(source);
    const body = steps ? steps.join("\n") : "";
    if (!/branches:\s*\[[^\]]*main[^\]]*\]/.test(source)) {
      errors.push(`${file} 的 push/PR 分支未覆盖 main`);
    }
    if (!steps || steps.length === 0) {
      errors.push(`${file} 未解析到 steps`);
    }
    for (const marker of markers) {
      if (!body.includes(marker)) {
        errors.push(`${file} 的 steps 缺少 ${marker}`);
      }
    }
    for (const name of requiredNames ?? []) {
      if (!source.includes(name)) {
        errors.push(`${file} 缺少分支保护必需检查名 ${name}`);
      }
    }
  }

  // 双端锁定：CI 与打包配置不得出现 macOS 残留（runner / darwin / icns）。
  const workflowsDir = path.join(root, ".github", "workflows");
  if (fs.existsSync(workflowsDir)) {
    for (const file of fs.readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"))) {
      const source = read(path.join(".github", "workflows", file));
      for (const pattern of ["macos-", "aarch64-apple-darwin", "x86_64-apple-darwin"]) {
        if (source.includes(pattern)) {
          errors.push(`${file} 含 macOS 构建残留 ${pattern}`);
        }
      }
    }
  }
  if (fs.existsSync(path.join(root, "src-tauri", "icons", "icon.icns"))) {
    errors.push("src-tauri/icons/icon.icns 仍存在（macOS 图标残留）");
  }

  const lib = read("src-tauri/src/lib.rs");
  for (const command of [
    "commands::relocate_book",
    "open_with::take_pending_open",
    "backup::export_backup",
    "backup::import_backup",
    "update::restart_app",
  ]) {
    if (!lib.includes(command)) {
      errors.push(`lib.rs 未注册 ${command}`);
    }
  }

  for (const entry of [
    "src/components/library/RelocateDialog.tsx",
    "src/components/settings/DataBackupPanel.tsx",
    "src/features/openWith/OpenWithBridge.tsx",
  ]) {
    if (!fs.existsSync(path.join(root, entry))) {
      errors.push(`缺少用户入口 ${entry}`);
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:release-surface",
      suite: "static",
      layer: "static",
      title: "发行级长尾体验的静态契约不完整",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/tauri.conf.json",
      expected:
        "文件关联 .cbz/.zip、createUpdaterArtifacts、plugins.updater、签名 CI、主窗 updater 代理命令（无 updater:default）、五个命令与三个用户入口齐全",
      actual: errors.join(" | "),
      rootCause: "新增发行能力时漏改配置、命令注册或权限文件",
      fix: "按内部发布与技术文档（维护者本地维护）补齐缺失项",
    });
  } else {
    ok(report, {
      id: "static:release-surface",
      suite: "static",
      layer: "static",
      title: "文件关联/备份/Updater/单实例静态契约齐全",
      details: "tauri.conf + tauri.linux.conf + 双发版流水线 + 命令注册 + 三个入口文件",
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3 Tauri 2 权限能力墙                                             */
/* ------------------------------------------------------------------ */

/** 真实窗口标签：主窗 / 独立恢复窗 / 内嵌浏览器窗。 */
const REQUIRED_WINDOW_LABELS = ["main", "recovery", "browser"];

/** 过宽权限黑名单：全量 fs / shell / process 一律禁止。 */
const FORBIDDEN_PERMISSION_PATTERNS = [
  { name: "fs 全量权限", regex: /^fs:/ },
  { name: "shell 权限", regex: /^shell:/ },
  { name: "process 权限", regex: /^process:/ },
  { name: "http 权限", regex: /^http:/ },
];

export function checkCapabilityWall(root, report) {
  const dir = path.join(root, "src-tauri", "capabilities");
  const defaultFile = path.join(dir, "default.json");
  const errors = [];
  let defaultCapability = null;

  if (!fs.existsSync(defaultFile)) {
    fail(report, {
      id: "static:capability-wall",
      suite: "static",
      layer: "static",
      title: "Tauri 能力墙文件缺失",
      severity: "P1",
      details: "src-tauri/capabilities/default.json 不存在",
      location: "src-tauri/capabilities/default.json",
      expected: "default.json 覆盖 main/recovery/browser 三个窗口标签",
      actual: "文件缺失",
    });
    return;
  }

  const capabilityFiles = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));

  for (const file of capabilityFiles) {
    let capability = null;
    try {
      capability = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`${path.basename(file)} 不是合法 JSON: ${error.message}`);
      continue;
    }
    if (file === defaultFile) defaultCapability = capability;
    const permissions = Array.isArray(capability.permissions)
      ? capability.permissions
      : [];
    for (const permission of permissions) {
      for (const pattern of FORBIDDEN_PERMISSION_PATTERNS) {
        if (pattern.regex.test(String(permission))) {
          errors.push(
            `${path.basename(file)} 含过宽权限 ${permission}（${pattern.name}）`,
          );
        }
      }
    }
    const windows = Array.isArray(capability.windows) ? capability.windows : [];
    if (windows.length === 0) {
      errors.push(`${path.basename(file)} 未声明任何窗口标签`);
    }
  }

  if (defaultCapability) {
    const windows = Array.isArray(defaultCapability.windows)
      ? defaultCapability.windows
      : [];
    const missing = REQUIRED_WINDOW_LABELS.filter(
      (label) => !windows.includes(label),
    );
    if (missing.length) {
      errors.push(`default.json 的 windows 缺少 ${missing.join(",")}`);
    }
    // 恢复窗使用 @tauri-apps/api/window 的 setTitle() 同步原生标题时，
    // 必须显式声明 core:window:allow-set-title（core:default 不包含）。
    const recoverySource = path.join(root, "src", "recovery", "RecoveryApp.tsx");
    const recoveryUsesSetTitle =
      fs.existsSync(recoverySource) &&
      /\bsetTitle\s*\(/.test(fs.readFileSync(recoverySource, "utf8"));
    if (recoveryUsesSetTitle) {
      const permissions = Array.isArray(defaultCapability.permissions)
        ? defaultCapability.permissions
        : [];
      if (!permissions.includes("core:window:allow-set-title")) {
        errors.push(
          "RecoveryApp 使用 setTitle()，但 default.json 缺少 core:window:allow-set-title",
        );
      }
    }
    // 恢复窗 / 浏览器窗的真实标签必须与 Rust 常量一致。
    const rustSources = ["resilience.rs", "browser.rs"]
      .map((name) => path.join(root, "src-tauri", "src", name))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const labelMatch = rustSources.match(
      /const\s+(?:RECOVERY|BROWSER)_LABEL\s*:\s*&str\s*=\s*"([^"]+)"/g,
    );
    for (const match of labelMatch || []) {
      const label = match.match(/"([^"]+)"/)?.[1];
      if (!label) continue;
      const covered = capabilityFiles.some((file) => {
        const capability = JSON.parse(fs.readFileSync(file, "utf8"));
        return (capability.windows || []).includes(label);
      });
      if (!covered) {
        errors.push(`窗口标签 ${label} 未被任何 capability 覆盖`);
      }
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:capability-wall",
      suite: "static",
      layer: "static",
      title: "Tauri 能力墙缺失窗口标签或声明了过宽权限",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/capabilities/default.json",
      expected:
        "default.json 的 windows = [main, recovery, browser]；权限只允许 core:window:allow-* / opener:default / dialog:default 等真实调用项",
      actual: errors.join(" | "),
      rootCause: "新增窗口未补齐 capability，或声明了 fs/shell/process 全量权限",
      fix: "补齐 windows 数组；删除过宽权限，改用精确 allow-* 授权",
    });
  } else {
    ok(report, {
      id: "static:capability-wall",
      suite: "static",
      layer: "static",
      title: "能力墙覆盖 main/recovery/browser 且无过宽权限",
      details: `检查 ${capabilityFiles.length} 个 capability 文件`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §2.2 存储清洗白名单必须覆盖前端实际使用的全部 mr-* 键            */
/* ------------------------------------------------------------------ */
function collectMrLiterals(root) {
  const found = new Map();
  const srcRoot = path.join(root, "src");
  const skip = path.join("lib", "storageSanitizer.ts");
  for (const file of walk(srcRoot)) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    if (path.normalize(file).endsWith(skip)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/"(mr-[A-Za-z0-9_-]+)"/g)) {
      const key = match[1];
      if (!found.has(key)) {
        found.set(key, path.relative(root, file));
      }
    }
  }
  return found;
}

export function checkStorageWhitelist(root, report) {
  const sanitizerPath = path.join(root, "src", "lib", "storageSanitizer.ts");
  const errors = [];
  let known = [];
  let dynamic = [];
  let deprecated = [];
  if (fs.existsSync(sanitizerPath)) {
    const source = fs.readFileSync(sanitizerPath, "utf8");
    known = loadTsObject(source, "KNOWN_STORAGE_KEYS") || [];
    dynamic = loadTsObject(source, "DYNAMIC_KEY_PREFIXES") || [];
    deprecated = loadTsObject(source, "DEPRECATED_KEY_PREFIXES") || [];
  } else {
    errors.push("缺少 src/lib/storageSanitizer.ts");
  }

  // 非存储用途的 mr-* 标识（事件名 / 状态名 / 广播名），不属于 localStorage 键。
  const nonStorage = new Set([
    // 皮肤画框/内容视窗的 CSS 类名，不是 localStorage 键。
    "mr-skin-viewport",
    "mr-skin-canvas",
    "mr-skin-backdrop",
    "mr-skin-frame",
    "mr-focus-library-search",
    "mr-online-handoff-state",
    "mr-online-last-test-updated",
    "mr-online-library-refresh",
    "mr-privacy-open",
    "mr-settings-changed",
    "mr-settings-updated",
    "mr-shortcuts-preference",
    "mr-storage-sanitized",
    // sessionStorage 键：生命周期仅限当前窗口会话，不参与启动 localStorage 清洗。
    "mr-scroll-positions",
    "mr-scroll-restore",
  ]);

  const used = collectMrLiterals(root);
  for (const [key, file] of used) {
    if (nonStorage.has(key)) continue;
    if (deprecated.some((prefix) => key.startsWith(prefix))) {
      errors.push(`${file}: 仍在使用已废弃键 ${key}`);
      continue;
    }
    if (known.includes(key)) continue;
    if (dynamic.some((prefix) => key.startsWith(prefix))) continue;
    errors.push(
      `${file}: ${key} 未登记到存储清洗白名单，启动清洗时会被当作未知键删除`,
    );
  }

  if (errors.length) {
    fail(report, {
      id: "static:storage-whitelist",
      suite: "static",
      layer: "static",
      title: "前端 localStorage 键未与存储清洗白名单对齐",
      severity: "P1",
      details: errors.join(" | "),
      location: "src/lib/storageSanitizer.ts",
      expected:
        "src/ 下出现的每个 mr-* 键都必须在 KNOWN_STORAGE_KEYS / DYNAMIC_KEY_PREFIXES 中登记",
      actual: errors.join(" | "),
      rootCause: "新增 localStorage 键时没有同步清洗器白名单，用户状态会在启动时被静默删除",
      fix: "把新键登记进 storageSanitizer.ts 的 KEY_RULES（或加入 DYNAMIC 前缀）",
    });
  } else {
    ok(report, {
      id: "static:storage-whitelist",
      suite: "static",
      layer: "static",
      title: "前端存储键与清洗白名单完全对齐",
      details: `扫描 ${used.size} 个 mr-* 标识`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §4.2 超高分辨率条漫纹理安全线                                     */
/* ------------------------------------------------------------------ */
export function checkWebtoonTextureGuard(root, report) {
  const pipelineFile = path.join(root, "src-tauri", "src", "pipeline.rs");
  const errors = [];
  let details = "";

  if (!fs.existsSync(pipelineFile)) {
    fail(report, {
      id: "static:webtoon-texture-guard",
      suite: "static",
      layer: "static",
      title: "图片管线源文件缺失",
      severity: "P1",
      details: "src-tauri/src/pipeline.rs 不存在",
      location: "src-tauri/src/pipeline.rs",
    });
    return;
  }

  const source = fs.readFileSync(pipelineFile, "utf8");
  const safeMatch = source.match(
    /pub const MAX_SAFE_TEXTURE_H\s*:\s*u32\s*=\s*(\d+)\s*;/,
  );
  const sliceMatch = source.match(
    /pub const MAX_SLICE_H\s*:\s*u32\s*=\s*(\d+)\s*;/,
  );
  const tileMatch = source.match(
    /pub const WEBTOON_TILE_H\s*:\s*u32\s*=\s*(\d+)\s*;/,
  );

  if (!safeMatch) {
    errors.push("pipeline.rs 未定义 MAX_SAFE_TEXTURE_H");
  } else if (Number(safeMatch[1]) < 4096) {
    errors.push(`MAX_SAFE_TEXTURE_H=${safeMatch[1]} < 4096`);
  }
  if (!sliceMatch) {
    errors.push("pipeline.rs 未定义 MAX_SLICE_H");
  } else if (Number(sliceMatch[1]) < 2048) {
    errors.push(`MAX_SLICE_H=${sliceMatch[1]} < 2048`);
  }
  if (!tileMatch) {
    errors.push("pipeline.rs 未定义 WEBTOON_TILE_H");
  }
  // 钳制必须真的被单页渲染路径使用，而不只是定义了常量。
  if (safeMatch && !/safe_fit\(|clamp_texture_safe\(/.test(source)) {
    errors.push("MAX_SAFE_TEXTURE_H 未被 safe_fit/clamp_texture_safe 使用");
  }
  if (!/render_webtoon_tiles/.test(source)) {
    errors.push("pipeline.rs 缺少 render_webtoon_tiles（条漫先切后缩入口）");
  }

  // 前后端切片高度常量必须一致（AGENTS.md §4.2）。
  const tauriFile = path.join(root, "src", "lib", "tauri.ts");
  if (fs.existsSync(tauriFile)) {
    const tsSource = fs.readFileSync(tauriFile, "utf8");
    const tsMatch = tsSource.match(
      /export const WEBTOON_TILE_H\s*=\s*(\d+)\s*;/,
    );
    if (!tsMatch) {
      errors.push("src/lib/tauri.ts 未导出 WEBTOON_TILE_H");
    } else if (tileMatch && Number(tsMatch[1]) !== Number(tileMatch[1])) {
      errors.push(
        `切片高度常量不一致：Rust=${tileMatch[1]} vs TS=${tsMatch[1]}`,
      );
    } else {
      details = `WEBTOON_TILE_H=${tileMatch ? tileMatch[1] : "?"}`;
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:webtoon-texture-guard",
      suite: "static",
      layer: "static",
      title: "超高条漫纹理安全线常量缺失或前后端不一致",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/src/pipeline.rs",
      expected:
        "MAX_SAFE_TEXTURE_H ≥ 4096、MAX_SLICE_H ≥ 2048、WEBTOON_TILE_H 前后端一致",
      actual: errors.join(" | "),
      rootCause: "巨图防线常量被删除/改名或前后端漂移",
      fix: "恢复常量并保持 pipeline.rs 与 src/lib/tauri.ts 同值",
    });
  } else {
    ok(report, {
      id: "static:webtoon-texture-guard",
      suite: "static",
      layer: "static",
      title: "超高条漫纹理安全线常量齐备且前后端一致",
      details: `MAX_SAFE_TEXTURE_H=${safeMatch ? safeMatch[1] : "?"}，MAX_SLICE_H=${
        sliceMatch ? sliceMatch[1] : "?"
      }，${details}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Task 14-1：稳定错误码、Web Reader 六语与数字排版物理标尺           */
/* ------------------------------------------------------------------ */

/**
 * Rust 侧出现、但不属于用户可见错误码的字面量。
 * 新增错误必须进 localize.ts；只有事件名 / HTTP 头 / 诊断计数 / 测试夹具
 * 才能进入本清单，避免“未映射错误码”被静默放过。
 */
const NON_UI_RUST_CODE_LITERALS = new Map([
  ["browser-download", "下载完成事件名"],
  ["cached-errors", "缓存诊断计数键"],
  ["content-type", "HTTP 头名"],
  ["error-boundary", "诊断分类名"],
  ["mr-startup-recovery", "启动恢复事件名"],
  ["mr-ui-watchdog", "UI 看门狗事件名"],
  ["opds-book", "OPDS 条目缺省标题"],
  ["page-errors", "页面诊断计数键"],
  ["req-1", "更新测试夹具标识"],
  ["ring-test", "日志测试标记"],
  ["sec-fetch-site", "HTTP 头名"],
  ["series-1", "命令测试夹具标识"],
  ["unknown-sid", "Windows ACL 诊断标记"],
  ["web-access-tray-error", "托盘错误事件名"],
]);

export function checkStableErrorCodes(root, dictionary, report) {
  const localizePath = path.join(root, "src", "features", "errors", "localize.ts");
  const errors = [];
  try {
    const source = fs.readFileSync(localizePath, "utf8");
    const entries = [
      ...source.matchAll(/code:\s*"([^"]+)",\s*key:\s*"([^"]+)"/g),
    ].map((match) => ({ code: match[1], key: match[2] }));
    if (entries.length === 0) errors.push("localize.ts 未解析到任何错误码映射");
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.code)) errors.push(`重复错误码 ${entry.code}`);
      seen.add(entry.code);
      for (const locale of ["zh-CN", "zh-TW", "en", "es", "ja", "ko"]) {
        if (!(entry.key in (dictionary[locale] || {}))) {
          errors.push(`${entry.code} -> ${entry.key} 缺少 ${locale} 文案`);
        }
      }
    }

    const rustCodes = new Map();
    for (const file of walk(path.join(root, "src-tauri", "src")).filter((item) =>
      item.endsWith(".rs"),
    )) {
      const raw = fs.readFileSync(file, "utf8");
      const lines = stripRustComments(raw).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // 只扫描错误返回语境，避免把普通文案 / 路径 / 事件负载当成错误码。
        if (!/(?:Err\(|map_err|to_string|error|Error|code|Code|return)/.test(line)) {
          continue;
        }
        for (const match of line.matchAll(
          /"([a-z][a-z0-9]*(?:-[a-z0-9]+){1,6})"/g,
        )) {
          const code = match[1];
          if (!rustCodes.has(code)) {
            rustCodes.set(code, `${path.relative(root, file)}:${index + 1}`);
          }
        }
      }
    }
    for (const [code, location] of rustCodes) {
      if (seen.has(code) || NON_UI_RUST_CODE_LITERALS.has(code)) continue;
      errors.push(`${code} 未在 localize.ts 注册（${location}）`);
    }
  } catch (error) {
    errors.push(`错误码扫描失败：${error.message}`);
  }

  if (errors.length) {
    fail(report, {
      id: "static:stable-error-codes",
      suite: "static",
      layer: "static",
      title: "Rust 稳定错误码未完整映射到六语本地化表",
      severity: "P1",
      details: errors.slice(0, 30).join(" | "),
      location: "src/features/errors/localize.ts",
      expected:
        "每个用户可见 kebab-case 错误码都有 localize 映射，且 key 在六套字典中存在",
      actual: errors.join(" | "),
      rootCause: "新增错误码未同步 localize.ts 或六语字典",
      fix: "登记错误码与六语文案；事件名/HTTP 头/诊断键才可加入 NON_UI 清单",
    });
  } else {
    ok(report, {
      id: "static:stable-error-codes",
      suite: "static",
      layer: "static",
      title: "Rust 稳定错误码与六语 localize 映射完整",
      details: "扫描 Rust 错误语境与 localize 映射",
    });
  }
}

export function checkWebReaderDictionaries(root, report) {
  const file = path.join(root, "src", "i18n", "messages", "webReader.ts");
  const errors = [];
  try {
    const table = loadTsObject(fs.readFileSync(file, "utf8"), "messages");
    const locales = Object.keys(table || {});
    const expected = ["zh-CN", "zh-TW", "en", "es", "ja", "ko"];
    for (const locale of expected) {
      if (!table?.[locale]) errors.push(`缺少 ${locale} 字典`);
    }
    const base = table?.["en"] || {};
    for (const locale of locales) {
      const current = table[locale] || {};
      for (const key of Object.keys(base)) {
        if (!(key in current)) errors.push(`${locale} missing ${key}`);
        else if (!String(current[key]).trim()) errors.push(`${locale} empty ${key}`);
        else if (placeholders(current[key]) !== placeholders(base[key])) {
          errors.push(`${locale} placeholder mismatch ${key}`);
        }
      }
      for (const key of Object.keys(current)) {
        if (!(key in base)) errors.push(`${locale} extra ${key}`);
      }
    }
  } catch (error) {
    errors.push(`webReader 字典解析失败：${error.message}`);
  }

  if (errors.length) {
    fail(report, {
      id: "static:web-reader-i18n",
      suite: "static",
      layer: "static",
      title: "移动 Web Reader 六语字典不完整",
      severity: "P1",
      details: errors.slice(0, 30).join(" | "),
      location: "src/i18n/messages/webReader.ts",
      expected: "zh-CN / zh-TW / en / es / ja / ko 键名与占位符完全一致",
      actual: errors.join(" | "),
      rootCause: "新增移动端提示语只写了一种语言，或占位符不一致",
      fix: "补齐六语键并使用相同 {placeholder}",
    });
  } else {
    ok(report, {
      id: "static:web-reader-i18n",
      suite: "static",
      layer: "static",
      title: "移动 Web Reader 六语字典键名与占位符一致",
    });
  }
}

/**
 * 动态数字组件的静态物理标尺。
 *
 * 只扫描 UI 目录中含数字展示信号的 tsx；纯逻辑文件与 toast 文案文件
 * 明确列入 allowlist，避免把“代码里出现 pageCount”误判成排版缺陷。
 */
const NUMERIC_UI_ALLOWLIST = new Map([
  [
    "src/components/Reader/Webtoon.tsx",
    "pageCount 仅用于预取/滚动逻辑，页码由 ProgressScrubber 渲染",
  ],
  [
    "src/components/settings/DataBackupPanel.tsx",
    "数字仅进入一次性 toast 文案，不构成持久列宽抖动",
  ],
]);
const NUMERIC_UI_PATTERN =
  /currentPage|pageCount|progressPercent|scrollPct|toFixed\(|formatNumber\(|formatBytes|readPercent|deviceCount|totalBooks|cacheUsage|cachedBytes/;

export function checkNumericTypography(root, report) {
  const errors = [];
  for (const dir of ["src/components", "src/pages"]) {
    for (const file of walk(path.join(root, dir)).filter((item) =>
      item.endsWith(".tsx"),
    )) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      const source = fs.readFileSync(file, "utf8");
      if (!NUMERIC_UI_PATTERN.test(source)) continue;
      if (source.includes("tabular-nums")) continue;
      if (NUMERIC_UI_ALLOWLIST.has(relative)) continue;
      errors.push(`${relative} 渲染动态数字但缺少 tabular-nums`);
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:numeric-typography",
      suite: "static",
      layer: "static",
      title: "动态数字排版缺少 tabular-nums",
      severity: "P2",
      details: errors.join(" | "),
      location: "src/components / src/pages",
      expected: "页码、百分比、字节数、设备数等动态数字使用 tabular-nums",
      actual: errors.join(" | "),
      rootCause: "新增数字展示时沿用比例字形，数值变化会导致横向抖动",
      fix: "给数字节点添加 tabular-nums；纯逻辑文件请加入明确 allowlist",
    });
  } else {
    ok(report, {
      id: "static:numeric-typography",
      suite: "static",
      layer: "static",
      title: "动态数字组件均使用 tabular-nums",
    });
  }
}

const WINDOW_API_PERMISSIONS = new Map([
  ["setTitle", "core:window:allow-set-title"],
  ["minimize", "core:window:allow-minimize"],
  ["toggleMaximize", "core:window:allow-toggle-maximize"],
  ["close", "core:window:allow-close"],
  ["isMaximized", "core:window:allow-is-maximized"],
  ["startDragging", "core:window:allow-start-dragging"],
  ["hide", "core:window:allow-hide"],
  ["show", "core:window:allow-show"],
  ["setIcon", "core:window:allow-set-icon"],
]);

/**
 * 前端真实调用的 Window API 必须逐项出现在 capability 中。
 * Tray / set_icon 若走自研 Rust 命令则不经过 ACL；只有前端直接调用
 * `getCurrentWindow().method()` 时才要求补权限。
 */
export function checkWindowApiCapabilities(root, report) {
  const capabilityPath = path.join(
    root,
    "src-tauri",
    "capabilities",
    "default.json",
  );
  const errors = [];
  try {
    const capability = JSON.parse(fs.readFileSync(capabilityPath, "utf8"));
    const permissions = new Set(
      Array.isArray(capability.permissions) ? capability.permissions : [],
    );
    for (const file of walk(path.join(root, "src")).filter((item) =>
      /\.(tsx?|jsx?)$/.test(item),
    )) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("getCurrentWindow")) continue;
      for (const [method, permission] of WINDOW_API_PERMISSIONS) {
        const used = new RegExp(`\\.${method}\\s*\\(`).test(source);
        if (used && !permissions.has(permission)) {
          errors.push(
            `${path.relative(root, file)} 调用 ${method}() 但缺少 ${permission}`,
          );
        }
      }
    }
  } catch (error) {
    errors.push(`窗口能力扫描失败：${error.message}`);
  }

  if (errors.length) {
    fail(report, {
      id: "static:window-api-capabilities",
      suite: "static",
      layer: "static",
      title: "前端 Window API 调用与 capability 不一致",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/capabilities/default.json",
      expected: "每个 getCurrentWindow().method() 都有精确 core:window:allow-* 权限",
      actual: errors.join(" | "),
      rootCause: "新增窗口 API 调用未补 capability，或声明了未使用的权限",
      fix: "按真实调用补齐 allow-*；自研 Rust 托盘/图标命令不需要 ACL",
    });
  } else {
    ok(report, {
      id: "static:window-api-capabilities",
      suite: "static",
      layer: "static",
      title: "前端 Window API 与 capability 精确对齐",
    });
  }
}

function recordDictionaryResult(report, errors, keys, locales) {
  if (errors.length) {
    fail(report, {
      id: "static:i18n-parity",
      suite: "static",
      layer: "unit",
      title: "六语种字典完整性与占位符一致",
      severity: "P1",
      details: errors.slice(0, 20).join(" | "),
      expected: "所有键存在且占位符一致",
      actual: errors.slice(0, 20).join(" | "),
      location: "src/i18n/messages",
      rootCause: "新增文案未补齐或占位符改写",
      fix: "按包名补齐六语种并校验 {variables}",
    });
  } else {
    ok(report, {
      id: "static:i18n-parity",
      suite: "static",
      layer: "unit",
      title: "六语种字典完整性与占位符一致",
      details: `${keys} keys × ${locales} locales`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §6 生产构建：不得携带 sidecar / externalBin / 资源外挂            */
/* ------------------------------------------------------------------ */

function nonEmptyBundleEntry(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function checkProductionBundle(root, report) {
  const errors = [];
  let conf = null;
  try {
    conf = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    );
  } catch (error) {
    fail(report, {
      id: "static:production-bundle",
      suite: "static",
      layer: "static",
      title: "生产构建清单无法解析",
      severity: "P1",
      details: String(error),
      location: "src-tauri/tauri.conf.json",
    });
    return;
  }

  const bundle = conf?.bundle || {};
  if (nonEmptyBundleEntry(bundle.externalBin)) {
    errors.push(`bundle.externalBin 非空：${JSON.stringify(bundle.externalBin)}`);
  }
  if (nonEmptyBundleEntry(bundle.resources)) {
    errors.push(`bundle.resources 非空：${JSON.stringify(bundle.resources)}`);
  }

  let scripts = {};
  try {
    scripts = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ).scripts || {};
  } catch (error) {
    errors.push(`package.json 无法解析：${error.message}`);
  }
  const sidecarScriptPatterns = [
    { name: "python 启动", regex: /(^|[^a-z])python(?:3(?:\.\d+)?)?(?:\.exe)?([^a-z]|$)/i },
    { name: "sidecar 启动", regex: /\bsidecar\b/i },
    { name: "OCR 服务", regex: /(^|[^a-z])ocr([^a-z]|$)/i },
    { name: "8500 端口", regex: /\b8500\b/ },
  ];
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${String(command)}`;
    for (const pattern of sidecarScriptPatterns) {
      if (pattern.regex.test(text)) {
        errors.push(`npm script "${name}" 含 ${pattern.name}：${command}`);
      }
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:production-bundle",
      suite: "static",
      layer: "static",
      title: "生产构建携带 sidecar/外部资源痕迹",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/tauri.conf.json / package.json",
      expected:
        "bundle.externalBin / bundle.resources 为空或不存在；npm scripts 不拉起 Python/OCR sidecar、不监听 8500",
      actual: errors.join(" | "),
      rootCause: "生产构建配置重新引入了外部二进制或 sidecar 启动脚本",
      fix: "删除 externalBin/resources 条目与 python/ocr 启动脚本",
    });
  } else {
    ok(report, {
      id: "static:production-bundle",
      suite: "static",
      layer: "static",
      title: "生产构建不含 externalBin/resources 与 sidecar 启动脚本",
      details: `bundle 键：${Object.keys(bundle).join(", ") || "空"}；scripts=${Object.keys(scripts).length}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §4.3 自定义图片协议：要么完全不存在，要么有编解码测试 + CSP      */
/* ------------------------------------------------------------------ */

/** 去掉 JS/TS 注释但保留字符串，避免文档性注释误报。 */
function stripJsComments(source) {
  let out = "";
  let index = 0;
  let inString = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === inString) inString = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "  ";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function collectProtocolHits(root) {
  const patterns = [/register_uri_scheme_protocol/, /manga-proxy:\/\//];
  const hits = [];
  const rustRoot = path.join(root, "src-tauri", "src");
  if (fs.existsSync(rustRoot)) {
    for (const file of walk(rustRoot).filter((name) => name.endsWith(".rs"))) {
      const code = stripRustComments(fs.readFileSync(file, "utf8"));
      for (const pattern of patterns) {
        for (const match of code.matchAll(
          new RegExp(pattern.source, "g"),
        )) {
          hits.push({
            file: path.relative(root, file),
            line: code.slice(0, match.index).split("\n").length,
            snippet: match[0],
          });
        }
      }
    }
  }
  const frontRoot = path.join(root, "src");
  if (fs.existsSync(frontRoot)) {
    for (const file of walk(frontRoot).filter((name) => /\.(tsx?|jsx?|mjs)$/.test(name))) {
      const code = stripJsComments(fs.readFileSync(file, "utf8"));
      for (const pattern of patterns) {
        for (const match of code.matchAll(
          new RegExp(pattern.source, "g"),
        )) {
          hits.push({
            file: path.relative(root, file),
            line: code.slice(0, match.index).split("\n").length,
            snippet: match[0],
          });
        }
      }
    }
  }
  return hits;
}

function collectRustTestSources(root) {
  const sourceRoot = path.join(root, "src-tauri", "src");
  if (!fs.existsSync(sourceRoot)) return [];
  const sources = [];
  for (const file of walk(sourceRoot).filter((name) => name.endsWith(".rs"))) {
    const source = fs.readFileSync(file, "utf8");
    const index = source.indexOf("#[cfg(test)]");
    if (index >= 0) sources.push(source.slice(index));
  }
  return sources;
}

export function checkNoUnusedCustomProtocol(root, report) {
  let hits = [];
  try {
    hits = collectProtocolHits(root);
  } catch (error) {
    fail(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "自定义协议扫描失败",
      severity: "P2",
      details: String(error),
      location: "src / src-tauri/src",
    });
    return;
  }

  if (hits.length === 0) {
    ok(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "无 manga-proxy 自定义协议（图片经命令通道）",
      details: "未发现 register_uri_scheme_protocol / manga-proxy:// 引用",
    });
    note(report, "图片经命令通道，无需自定义协议（static:no-custom-protocol）");
    return;
  }

  const testSources = collectRustTestSources(root);
  const testRoot = path.join(root, "tests");
  if (fs.existsSync(testRoot)) {
    for (const file of walk(testRoot).filter((name) => /\.(mjs|js|ts)$/.test(name))) {
      testSources.push(fs.readFileSync(file, "utf8"));
    }
  }
  const combinedTests = testSources.join("\n");
  const hasProtocolTest =
    /manga-proxy|register_uri_scheme_protocol/i.test(combinedTests) &&
    /\bencode\b/i.test(combinedTests) &&
    /\bdecode\b/i.test(combinedTests) &&
    /\bassert|expect\(|deepEqual|strictEqual/i.test(combinedTests);

  let csp = null;
  try {
    csp = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    )?.app?.security?.csp;
  } catch {
    csp = null;
  }
  const hasCsp = typeof csp === "string" && csp.trim().length > 0;

  const problems = [];
  if (!hasProtocolTest) {
    problems.push("缺少自定义协议的编码/解码测试（需同时包含 encode/decode 与断言）");
  }
  if (!hasCsp) {
    problems.push("tauri.conf.json app.security.csp 为空，自定义协议缺少 CSP 约束");
  }

  if (problems.length) {
    fail(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "自定义图片协议缺少编解码测试或 CSP 配置",
      severity: "P1",
      details: `${problems.join(" | ")}；命中：${hits
        .map((hit) => `${hit.file}:${hit.line}`)
        .join(", ")}`,
      location: `${hits[0].file}:${hits[0].line}`,
      expected:
        "manga-proxy 协议要么完全不存在；存在时必须有 encode/decode round-trip 测试与非空 CSP",
      actual: problems.join(" | "),
      rootCause: "绕过命令通道直接注册自定义协议，且缺少配套安全/回归约束",
      fix: "恢复图片命令通道；如确需自定义协议，补编解码测试并配置 CSP",
    });
  } else {
    ok(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "自定义图片协议具备编解码测试与 CSP 约束",
      details: `${hits.length} 处协议引用，CSP 已配置`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §1.2 设置/诊断/隐私/恢复窗：不得残留硬编码 JSX 文案              */
/* ------------------------------------------------------------------ */

const HARDCODED_TEXT_DIRS = [
  path.join("src", "components", "settings"),
  path.join("src", "components", "diagnostics"),
  path.join("src", "components", "privacy"),
  path.join("src", "recovery"),
];

/** 设置页主体（5 分区标题/说明）同样属于本轮后置 i18n 覆盖范围。 */
const HARDCODED_TEXT_FILES = [path.join("src", "pages", "Settings.tsx")];

/** 技术缩写/专有名词/单位：不视为待翻译的硬编码文案。 */
const ALLOWED_UI_TOKENS = new Set([
  "MB",
  "KB",
  "GB",
  "AI",
  "URL",
  "UA",
  "HTTP",
  "HTTPS",
  "CPU",
  "API",
  "TXT",
  "JSON",
  "SHA",
  "Rust",
  "Tauri",
  "Windows",
  "PowerShell",
  "SmartScreen",
  "MangaReader",
  "GitHub",
  "WebView",
  "WebView2",
  "SQLite",
  "Vite",
  "MSI",
  "NSIS",
  "localhost",
  "127.0.0.1",
]);

function suspiciousHardcodedText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/[\u3400-\u9fff]/.test(value)) return value;
  const words = value.match(/[A-Za-z]{2,}/g) || [];
  const suspicious = words.filter(
    (word) =>
      !ALLOWED_UI_TOKENS.has(word) &&
      // 全大写缩写（SHA/MB/URL…）视为技术标识，不误报。
      !/^[A-Z][A-Z0-9]*$/.test(word),
  );
  return suspicious.length ? value : null;
}

export function checkPostI18nHardcodedText(root, report) {
  const hits = [];
  const missingDirs = [];
  const files = [];
  for (const dir of HARDCODED_TEXT_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) {
      missingDirs.push(dir);
      continue;
    }
    files.push(...walk(full).filter((name) => name.endsWith(".tsx")));
  }
  for (const relative of HARDCODED_TEXT_FILES) {
    const full = path.join(root, relative);
    if (fs.existsSync(full)) files.push(full);
    else missingDirs.push(relative);
  }
  for (const file of files) {
    {
      const source = fs.readFileSync(file, "utf8");
      let ast = null;
      try {
        ast = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
      } catch (error) {
        hits.push({
          file: path.relative(root, file),
          line: 1,
          kind: "parse-error",
          text: String(error),
        });
        continue;
      }
      const visit = (node) => {
        if (ts.isJsxText(node)) {
          const text = suspiciousHardcodedText(node.text);
          if (text) {
            hits.push({
              file: path.relative(root, file),
              line:
                ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              kind: "jsx-text",
              text: text.slice(0, 100),
            });
          }
        }
        if (
          ts.isJsxAttribute(node) &&
          /^(aria-label|title)$/.test(node.name.getText(ast))
        ) {
          const initializer = node.initializer;
          if (initializer && ts.isStringLiteral(initializer)) {
            const text = suspiciousHardcodedText(initializer.text);
            if (text) {
              hits.push({
                file: path.relative(root, file),
                line:
                  ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                kind: node.name.getText(ast),
                text: text.slice(0, 100),
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }

  if (hits.length) {
    fail(report, {
      id: "static:post-i18n-hardcode",
      suite: "static",
      layer: "static",
      title: "设置/诊断/隐私/恢复窗仍含硬编码可见文案",
      severity: "P1",
      details: hits
        .slice(0, 20)
        .map((hit) => `${hit.file}:${hit.line} [${hit.kind}] ${JSON.stringify(hit.text)}`)
        .join(" | "),
      location: `${hits[0].file}:${hits[0].line}`,
      expected:
        "JSX 文本节点与 aria-label/title 字符串统一走 t()；仅允许技术缩写/单位",
      actual: hits
        .slice(0, 20)
        .map((hit) => `${hit.file}:${hit.line} ${hit.text}`)
        .join(", "),
      rootCause: "新增分区时直接写入中英文文案，未走六语字典",
      fix: "改用 useI18n().t(key)，并同步六语字典",
    });
  } else {
    ok(report, {
      id: "static:post-i18n-hardcode",
      suite: "static",
      layer: "static",
      title: "设置/诊断/隐私/恢复窗无硬编码 JSX 文案",
      details: `扫描 ${files.length} 个文件（${
        HARDCODED_TEXT_DIRS.length
      } 个目录 + Settings.tsx）${
        missingDirs.length ? `（缺失：${missingDirs.join(", ")}）` : ""
      }`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 反 Mock 审计：关键算法必须有真实函数调用与断言                     */
/* ------------------------------------------------------------------ */

const ANTI_MOCK_AREAS = [
  {
    name: "自然序",
    file: path.join("src-tauri", "src", "commands.rs"),
    definition: /fn\s+natural_cmp(?:_path)?\s*\(/,
    symbol: "natural_cmp_path",
    testSymbols: ["natural_cmp", "natural_cmp_path"],
  },
  {
    name: "日志脱敏",
    file: path.join("src-tauri", "src", "diagnostics.rs"),
    definition: /fn\s+sanitize_text\s*\(/,
    symbol: "sanitize_text",
    testSymbols: ["sanitize_text"],
  },
  {
    name: "在线提纯",
    file: path.join("src-tauri", "src", "online", "filter.rs"),
    definition: /fn\s+filter_candidates\s*\(/,
    symbol: "filter_candidates",
    testSymbols: ["filter_candidates"],
  },
  {
    name: "条漫切片",
    file: path.join("src-tauri", "src", "pipeline.rs"),
    definition: /fn\s+render_webtoon_tiles\s*\(/,
    symbol: "render_webtoon_tiles",
    testSymbols: ["render_webtoon_tiles"],
  },
  {
    name: "进度事务",
    file: path.join("src-tauri", "src", "db.rs"),
    definition: /fn\s+set_progress\s*\(/,
    symbol: "set_progress",
    testSymbols: ["set_progress"],
  },
  {
    name: "重定位历史",
    file: path.join("src-tauri", "src", "db.rs"),
    definition: /fn\s+relocate_book\s*\(/,
    symbol: "relocate_book",
    testSymbols: ["relocate_book"],
  },
  {
    name: "NO_PROXY",
    file: path.join("src-tauri", "src", "online", "http.rs"),
    definition: /fn\s+no_proxy_matches\s*\(/,
    symbol: "no_proxy_matches",
    testSymbols: ["no_proxy_matches"],
  },
];

export function checkAntiMockGuards(root, report) {
  const errors = [];
  const evidence = [];
  const rustRoot = path.join(root, "src-tauri", "src");
  const prodSources = [];
  const testSources = [];

  if (fs.existsSync(rustRoot)) {
    for (const file of walk(rustRoot).filter((name) => name.endsWith(".rs"))) {
      const source = fs.readFileSync(file, "utf8");
      const index = source.indexOf("#[cfg(test)]");
      prodSources.push(index >= 0 ? source.slice(0, index) : source);
      if (index >= 0) testSources.push(source.slice(index));
    }
  }
  const allProd = prodSources.join("\n");
  const allTests = testSources.join("\n");

  for (const area of ANTI_MOCK_AREAS) {
    const file = path.join(root, area.file);
    if (!fs.existsSync(file)) {
      errors.push(`${area.name}：缺少 ${area.file}`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    const index = source.indexOf("#[cfg(test)]");
    const prod = index >= 0 ? source.slice(0, index) : source;
    const tests = index >= 0 ? source.slice(index) : "";
    if (!area.definition.test(prod)) {
      errors.push(`${area.name}：${area.file} 缺少生产函数定义`);
    }
    if (!tests) {
      errors.push(`${area.name}：${area.file} 缺少 #[cfg(test)] 测试`);
    } else {
      const mentionsReal = area.testSymbols.some((symbol) =>
        new RegExp(`\\b${symbol}\\s*\\(`).test(tests),
      );
      if (!mentionsReal) {
        errors.push(
          `${area.name}：测试未调用真实函数（${area.testSymbols.join("/")}）`,
        );
      }
      if (!/\bassert(?:_eq|_ne)?!\s*\(/.test(tests)) {
        errors.push(`${area.name}：测试缺少断言`);
      }
    }
    const stripped = allProd.replace(
      new RegExp(`fn\\s+${area.symbol}\\s*\\(`, "g"),
      "",
    );
    const calls = (
      stripped.match(new RegExp(`\\b${area.symbol}\\s*\\(`, "g")) || []
    ).length;
    if (calls < 1) {
      errors.push(
        `${area.name}：生产路径未调用 ${area.symbol}（疑似仅剩 mock/常量）`,
      );
    }
    evidence.push(`${area.name}: 生产调用 ${calls} 次`);
  }

  // QA 套件不得用 mock 替换 Tauri invoke。
  const overrideHits = [];
  const testsRoot = path.join(root, "tests");
  if (fs.existsSync(testsRoot)) {
    for (const file of walk(testsRoot).filter((name) => /\.(tsx?|jsx?|mjs)$/.test(name))) {
      const source = fs.readFileSync(file, "utf8");
      if (/__TAURI_INTERNALS__\s*\.\s*invoke\s*=/.test(source)) {
        overrideHits.push(path.relative(root, file));
      }
    }
  }
  if (overrideHits.length) {
    errors.push(`QA 套件替换了真实 invoke：${overrideHits.join(", ")}`);
  }

  if (errors.length) {
    fail(report, {
      id: "static:anti-mock-guards",
      suite: "static",
      layer: "static",
      title: "关键算法只有 mock/常量而缺少真实调用与断言",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/src",
      expected:
        "自然序、脱敏、在线过滤、条漫切片都有真实生产调用 + #[cfg(test)] 断言；QA 不得替换 invoke",
      actual: errors.join(" | "),
      rootCause: "测试以假常量替代真实函数，或关键算法被 mock 化",
      fix: "恢复真实函数断言；禁止在 QA 中覆写 __TAURI_INTERNALS__.invoke",
    });
  } else {
    ok(report, {
      id: "static:anti-mock-guards",
      suite: "static",
      layer: "static",
      title: "自然序/脱敏/在线过滤/条漫切片均有真实调用与断言",
      details: evidence.join("；"),
    });
  }

  try {
    const errors = [];
    const distributionFile = path.join(
      root,
      "src-tauri",
      "src",
      "web_access",
      "ca_distribution.rs",
    );
    const distributionSource = fs.readFileSync(distributionFile, "utf8");
    const testModule = distributionSource.indexOf("#[cfg(test)]\nmod tests");
    const production = stripRustComments(
      testModule >= 0
        ? distributionSource.slice(0, testModule)
        : distributionSource,
    );
    for (const forbidden of [
      "read_active_root_key",
      "read_root_generation_key",
      "key_pem",
      "root.key",
      "PRIVATE KEY",
    ]) {
      if (production.includes(forbidden)) {
        errors.push(`CA 分发生产路径出现私钥符号：${forbidden}`);
      }
    }
    if (/\/api\//.test(production)) {
      errors.push("CA 分发出现 /api/ 数据路由");
    }
    for (const route of ["/pair", "/books", "/session", "/devices"]) {
      if (production.includes(`"${route}`)) {
        errors.push(`CA 分发出现非证书路由：${route}`);
      }
    }
    if (!production.includes('const CA_DISTRIBUTION_PATH: &str = "/ca.crt";')) {
      errors.push("缺少唯一 /ca.crt 路由常量");
    }
    if (/Access-Control-Allow/i.test(production)) {
      errors.push("CA 分发不得返回 CORS 头");
    }
    if (!/#\[cfg\(test\)\]\s*pub\(crate\) fn for_test/.test(distributionSource)) {
      errors.push("for_test 未用 #[cfg(test)] 隔离");
    }

    const commandsSource = fs.readFileSync(
      path.join(
        root,
        "src-tauri",
        "src",
        "web_access",
        "ca_distribution_commands.rs",
      ),
      "utf8",
    );
    for (const forbidden of [
      "web_access_pairing_",
      "web_access_start",
      "web_access_start_plain",
      "web_access_stop",
      "web_access_devices_list",
      "web_access_device_revoke",
    ]) {
      if (commandsSource.includes(forbidden)) {
        errors.push(`G1 命令出现 D1b 命令：${forbidden}`);
      }
    }

    const libSource = fs.readFileSync(
      path.join(root, "src-tauri", "src", "lib.rs"),
      "utf8",
    );
    if (/CaDistributionRuntime[\s\S]{0,200}\.start/.test(libSource)) {
      errors.push("lib.rs 启动路径调用了 CA 分发服务");
    }

    const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const cargoSource = fs.readFileSync(
      path.join(root, "src-tauri", "Cargo.toml"),
      "utf8",
    );
    // D1b intentionally uses exactly one local QR renderer. G1 itself still
    // must not grow QR code; the only allowed frontend package is
    // qrcode-generator (MIT, no network/telemetry/CDN) and it must be noticed.
    if (
      /react-qr|qrcode\.react|qr-code-styling|qrcode-terminal/i.test(
        packageSource,
      ) ||
      /qrcode/i.test(cargoSource)
    ) {
      errors.push("引入了未批准的 QR 依赖（仅允许 qrcode-generator）");
    }
    if (packageSource.includes("qrcode-generator")) {
      const notices = fs.readFileSync(
        path.join(root, "THIRD_PARTY_NOTICES.md"),
        "utf8",
      );
      if (!/qrcode-generator[^\n]*MIT/i.test(notices)) {
        errors.push("qrcode-generator 缺少 MIT NOTICE");
      }
    }

    if (errors.length) {
      fail(report, {
        id: "static:g1-ca-distribution",
        suite: "static",
        layer: "static",
        title: "G1 CA 分发保持单路由、无私钥与无启动接线",
        severity: "P1",
        details: errors.join(" | "),
        location: "src-tauri/src/web_access/ca_distribution*.rs",
        expected:
          "只服务 /ca.crt；生产路径不读取私钥；setup 不启动；D1b 命令不进入 G1；QR 仅允许 qrcode-generator(MIT) 且记录 NOTICE",
        actual: errors.join(" | "),
        rootCause: "G1 边界被破坏或主密钥进入分发路径",
        fix: "恢复单路由、公开 PEM 快照与显式启动边界",
      });
    } else {
      ok(report, {
        id: "static:g1-ca-distribution",
        suite: "static",
        layer: "static",
        title: "G1 CA 分发保持单路由、无私钥与无启动接线",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:g1-ca-distribution",
      suite: "static",
      layer: "static",
      title: "G1 CA 分发静态边界检查",
      severity: "P1",
      details: error.message,
      location: "src-tauri/src/web_access/ca_distribution*.rs",
      rootCause: "静态守卫无法读取 G1 文件",
      fix: "确认 G1 文件存在且命名稳定",
    });
  }

  try {
    const errors = [];
    const tlsSource = stripRustComments(
      fs.readFileSync(
        path.join(root, "src-tauri", "src", "web_access", "tls.rs"),
        "utf8",
      ),
    );
    const renewalSource = stripRustComments(
      fs.readFileSync(
        path.join(root, "src-tauri", "src", "web_access", "tls_renewal.rs"),
        "utf8",
      ),
    );
    const libSource = stripRustComments(
      fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8"),
    );

    for (const forbidden of [
      "leaves/",
      "std::fs::write",
      "tokio::fs::write",
      "File::create",
      "tauri::command",
    ]) {
      if (tlsSource.includes(forbidden) || renewalSource.includes(forbidden)) {
        errors.push(`G2 TLS 生产路径出现叶持久化/命令接线：${forbidden}`);
      }
    }
    if (
      /leaf\.key(?![_A-Za-z0-9])/.test(tlsSource) ||
      /leaf\.key(?![_A-Za-z0-9])/.test(renewalSource)
    ) {
      errors.push("G2 TLS 生产路径出现叶 key 文件引用");
    }
    for (const forbidden of [
      "start_tls_server",
      "TlsServerHandle",
      "renew_now",
      "reload_after_root_rotation",
    ]) {
      if (libSource.includes(forbidden)) {
        errors.push(`lib.rs 出现 G2 生产接线：${forbidden}`);
      }
    }

    if (errors.length) {
      fail(report, {
        id: "static:g2-tls-renewal-boundary",
        suite: "static",
        layer: "static",
        title: "G2 续期保持仅内存叶与无生产接线",
        severity: "P1",
        details: errors.join(" | "),
        location: "src-tauri/src/web_access/tls*.rs；src-tauri/src/lib.rs",
        expected: "叶私钥不落盘；G2 不注册命令、不在启动路径接线",
        actual: errors.join(" | "),
        rootCause: "G2 边界被破坏",
        fix: "恢复只内存叶与 library/test-only 边界",
      });
    } else {
      ok(report, {
        id: "static:g2-tls-renewal-boundary",
        suite: "static",
        layer: "static",
        title: "G2 续期保持仅内存叶与无生产接线",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:g2-tls-renewal-boundary",
      suite: "static",
      layer: "static",
      title: "G2 TLS 续期静态边界检查",
      severity: "P1",
      details: error.message,
      location: "src-tauri/src/web_access/tls*.rs；src-tauri/src/lib.rs",
      rootCause: "静态守卫无法读取 G2 文件",
      fix: "确认 G2 文件存在且命名稳定",
    });
  }

  try {
    const errors = [];
    const webAccessRoot = path.join(root, "src-tauri", "src", "web_access");
    const readProduction = (name) => {
      const source = fs.readFileSync(path.join(webAccessRoot, name), "utf8").replace(/\r\n/g, "\n");
      // Exclude only the #[cfg(test)] mod tests block; cfg(test) helper
      // constructors before it are still part of the reviewed surface.
      const index = source.indexOf("#[cfg(test)]\nmod tests");
      return stripRustComments(index >= 0 ? source.slice(0, index) : source);
    };
    const routerSource = readProduction("router.rs");
    const runtimeSource = readProduction("runtime.rs");
    const commandsSource = readProduction("commands.rs");
    const eventsSource = readProduction("events.rs");
    const tlsSource = readProduction("tls.rs");
    const libSource = stripRustComments(
      fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8"),
    );
    const resilienceSource = stripRustComments(
      fs.readFileSync(
        path.join(root, "src-tauri", "src", "resilience.rs"),
        "utf8",
      ),
    );

    // The production router must contain no data-route literals: it mounts
    // health + pair and delegates the data plane only through the injected
    // provider. Its authority derives from the actual bound socket, never from
    // a request or setting.
    for (const forbidden of [
      "/api/books",
      "/api/pages",
      "/api/tiles",
      "/api/layout",
      "/api/progress",
      "/api/session",
      "/api/devices",
      "/api/thumbnails",
      "/api/search",
    ]) {
      if (routerSource.includes(forbidden)) {
        errors.push(`生产 pair router 出现数据路由：${forbidden}`);
      }
    }
    for (const required of [
      'pub(crate) const HEALTH_PATH: &str = "/api/health";',
      'pub(crate) const CLAIM_ROUTE: &str = "/api/pair/claim";',
      "AllowedAuthority::from_socket_addr",
      "RequestGuard::for_authority",
    ]) {
      if (!routerSource.includes(required)) {
        errors.push(`生产 pair router 缺少冻结边界：${required}`);
      }
    }
    if (/Access-Control-Allow/i.test(routerSource)) {
      errors.push("生产 pair router 返回了 CORS 头");
    }
    if (/tauri::command|AppHandle|Emitter|logging::|println!|eprintln!/.test(routerSource)) {
      errors.push("生产 pair router 出现命令/事件/日志接线");
    }
    // Reject any additional /api route literal; the pair surface is frozen.
    const allowedRoutes = new Set([
      "/api/health",
      "/api/pair/claim",
      "/api/pair/claim/",
    ]);
    for (const match of routerSource.matchAll(/"(\/api\/[^"]*)"/g)) {
      if (!allowedRoutes.has(match[1])) {
        errors.push(`生产 pair router 出现未批准路由：${match[1]}`);
      }
    }
    // PairingEventView lives in runtime.rs; scan its exact fields rather than
    // only the events.rs sink.
    const eventStruct =
      runtimeSource.match(/struct PairingEventView[\s\S]*?\n}/)?.[0] ?? "";
    if (
      !eventStruct ||
      /pairing_id|pairingId|claim_secret|claimSecret|token_hash|\btoken\b/.test(
        eventStruct,
      )
    ) {
      errors.push("PairingEventView 字段含 pairingId/claimSecret/token 或结构缺失");
    }
    if (/tauri::|AppHandle|Emitter|logging::|println!|eprintln!/.test(runtimeSource)) {
      errors.push("WebAccessRuntime 直接依赖 Tauri 或打印日志");
    }
    if (/logging::|println!|eprintln!/.test(commandsSource)) {
      errors.push("D1b 命令出现日志/打印接线");
    }
    if (/pairing_id|pairingId|claim_secret|claimSecret|token_hash/.test(eventsSource)) {
      errors.push("D1b 事件载荷出现 pairingId/claimSecret/token");
    }

    // The listener may only be started by the runtime's explicit start path.
    if (!runtimeSource.includes("start_tls_server_with(")) {
      errors.push("WebAccessRuntime 未使用注入 handler 的 TLS 工厂");
    }
    if (/start_tls_server\s*\(/.test(libSource)) {
      errors.push("lib.rs 启动路径直接启动 TLS");
    }
    if (/\.start\s*\(/.test(libSource)) {
      errors.push("lib.rs 出现 Web Access 启动调用（setup 必须只 manage）");
    }
    if (!/phase:\s*Phase::Disabled/.test(runtimeSource)) {
      errors.push("WebAccessRuntime 默认阶段不是 Disabled");
    }
    if ((runtimeSource.match(/\.start_window\s*\(/g) || []).length !== 1) {
      errors.push("pairing window 只能在显式 pairing_start 中创建一次");
    }

    const d1bCommands = [
      "web_access_status",
      "web_access_addresses",
      "web_access_start",
      "web_access_stop",
      "web_access_pairing_start",
      "web_access_pairing_state",
      "web_access_pairing_approve",
      "web_access_pairing_deny",
      "web_access_pairing_cancel",
      "web_access_devices_list",
      "web_access_device_revoke",
    ];
    for (const command of d1bCommands) {
      if (!libSource.includes(`web_access::commands::${command}`)) {
        errors.push(`lib.rs 未注册 D1b 命令：${command}`);
      }
    }
    // 退出路径通过 stop_for_exit 封装 StopReason::Exit；两者任一都视为已接线。
    if (
      !libSource.includes("StopReason::Exit") &&
      !libSource.includes("stop_for_exit(")
    ) {
      errors.push("退出路径未停止 Web Access");
    }
    if (
      !resilienceSource.includes("StopReason::Recovery") ||
      !resilienceSource.includes("StopReason::SafeMode")
    ) {
      errors.push("恢复窗/安全模式未停止 Web Access");
    }

    // Frontend: no credentials in storage, no QR/claim logging, no data fetch.
    const frontendFiles = [
      path.join(root, "src", "features", "web-access", "types.ts"),
      path.join(root, "src", "features", "web-access", "api.ts"),
      path.join(root, "src", "features", "web-access", "useWebAccess.ts"),
      path.join(root, "src", "components", "settings", "WebAccessPanel.tsx"),
    ];
    for (const file of frontendFiles) {
      if (!fs.existsSync(file)) {
        errors.push(`缺少 D1b 前端文件：${path.relative(root, file)}`);
        continue;
      }
      const source = stripJsComments(fs.readFileSync(file, "utf8"));
      if (/localStorage|sessionStorage/.test(source)) {
        errors.push(`${path.basename(file)} 持久化了 Web Access 状态`);
      }
      if (/\bfetch\s*\(|axios|XMLHttpRequest/.test(source)) {
        errors.push(`${path.basename(file)} 绕过 IPC 直接请求网络`);
      }
      if (/console\.(log|debug|info|warn|error)\([^)]*(pair|claim|qr|token)/i.test(source)) {
        errors.push(`${path.basename(file)} 输出了配对/凭据日志`);
      }
      if (/\b(pairingId|claimSecret|token_hash)\b/.test(source)) {
        errors.push(`${path.basename(file)} 暴露了 pairingId/claimSecret/token`);
      }
    }
    const panelFile = path.join(
      root,
      "src",
      "components",
      "settings",
      "WebAccessPanel.tsx",
    );
    if (
      fs.existsSync(panelFile) &&
      !fs
        .readFileSync(panelFile, "utf8")
        .includes("qrcode-generator")
    ) {
      errors.push("Web Access 面板未使用经审查的本地 QR 渲染器");
    }
    const privacyFile = path.join(
      root,
      "src",
      "components",
      "settings",
      "PrivacyPanel.tsx",
    );
    const settingsPageFile = path.join(root, "src", "pages", "Settings.tsx");
    const privacySource = fs.existsSync(privacyFile)
      ? fs.readFileSync(privacyFile, "utf8")
      : "";
    const settingsSource = fs.existsSync(settingsPageFile)
      ? fs.readFileSync(settingsPageFile, "utf8")
      : "";
    // Task 8 起 Web Access 收敛为「摘要卡 + 二级抽屉」：面板挂在
    // Settings 的 WebAccessSummaryCard 内，不再直接塞进 PrivacyPanel。
    const mountedInSummary =
      settingsSource.includes("<WebAccessSummaryCard") &&
      settingsSource.includes("<WebAccessPanel");
    const mountedInPrivacy = privacySource.includes("<WebAccessPanel");
    if (!mountedInSummary && !mountedInPrivacy) {
      errors.push("Web Access 面板未挂载到 PrivacyPanel 或摘要卡二级抽屉");
    }

    const packageSource = fs.readFileSync(
      path.join(root, "package.json"),
      "utf8",
    );
    if (!packageSource.includes('"qrcode-generator"')) {
      errors.push("package.json 缺少 qrcode-generator");
    }
    if (/react-qr|qrcode\.react|qr-code-styling|qrcode-terminal/i.test(packageSource)) {
      errors.push("引入了未批准的 QR 渲染器");
    }

    if (errors.length) {
      fail(report, {
        id: "static:d1b-control-plane",
        suite: "static",
        layer: "static",
        title: "D1b 生产 router 无数据路由字面量、默认 Disabled、无秘密",
        severity: "P1",
        details: errors.join(" | "),
        location:
          "src-tauri/src/web_access/{router,runtime,commands,events}.rs + src/features/web-access + PrivacyPanel",
        expected:
          "生产 router 自身只保留 health+pair 字面量；数据面委派由 static:d2-data-routes 单独约束；authority 来自实际绑定地址；默认 Disabled；恢复/安全模式/退出停止；前端不持久化凭据",
        actual: errors.join(" | "),
        rootCause: "D1b 边界被破坏或控制面被自动启动",
        fix: "恢复 pair-only router、显式启动与无持久化凭据的边界",
      });
    } else {
      ok(report, {
        id: "static:d1b-control-plane",
        suite: "static",
        layer: "static",
        title: "D1b 生产 router 无数据路由字面量、默认 Disabled、无秘密",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:d1b-control-plane",
      suite: "static",
      layer: "static",
      title: "D1b 控制面静态边界检查",
      severity: "P1",
      details: error.message,
      location: "src-tauri/src/web_access + src/features/web-access",
      rootCause: "静态守卫无法读取 D1b 文件",
      fix: "确认 D1b 文件存在且命名稳定",
    });
  }

  try {
    const errors = [];
    const readSource = (relative) =>
      fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
    // Production surface only: cut the `#[cfg(test)] mod tests` block so
    // test-only URL literals and SQL seeds never satisfy (or trip) the guard.
    const productionOnly = (source) => {
      const index = source.indexOf("#[cfg(test)]\nmod tests");
      return stripRustComments(index >= 0 ? source.slice(0, index) : source);
    };
    const readProduction = (name) =>
      productionOnly(readSource(path.join("src-tauri", "src", "web_access", name)));

    const dataSource = readProduction("data.rs");
    const dataAppSource = readProduction("data_app.rs");
    const sessionAuthSource = readProduction("session_auth.rs");
    const routerSource = readProduction("router.rs");
    const runtimeSource = readProduction("runtime.rs");
    const tlsSource = readProduction("tls.rs");
    const readServiceSource = productionOnly(
      readSource(path.join("src-tauri", "src", "read_service.rs")),
    );
    // The desktop layout command lives in the top-level commands module, not
    // in web_access/commands.rs.
    const desktopCommandsSource = stripRustComments(
      readSource(path.join("src-tauri", "src", "commands.rs")),
    );
    const libSource = stripRustComments(
      readSource(path.join("src-tauri", "src", "lib.rs")),
    );

    // 1. Only GET reaches the data plane; no verb is matched as a route.
    if (/Method::(POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/.test(dataSource)) {
      errors.push("data.rs 解析/接受非 GET 方法");
    }
    if (!/if\s+method\s*!=\s*Method::GET/.test(dataSource)) {
      errors.push("data.rs 缺少显式 Method::GET 门");
    }
    if (/method\.as_str\(\)|method\.to_string\(\)/.test(dataSource)) {
      errors.push("data.rs 使用字符串方法比较，可能绕过 GET 门");
    }

    // 2. Exactly the eight frozen GET shapes (Books + seven segment arms).
    const dataFlat = dataSource.replace(/\s+/g, " ");
    if (
      !dataFlat.includes('strip_prefix("/api/books")') ||
      !dataFlat.includes("if rest.is_empty()")
    ) {
      errors.push("data.rs 缺少 /api/books 根路由解析");
    }
    for (const arm of [
      '[id] => Some(Self::Book',
      '[id, "thumb"] => Some(Self::Thumb',
      '[id, "pages"] => Some(Self::Pages',
      '[id, "pages", index] => Some(Self::Page',
      '[id, "layout"] => Some(Self::Layout',
      '[id, "progress"] => Some(Self::Progress',
      '[id, "pages", index, "tiles", tile] => Some(Self::Tile',
    ]) {
      if (!dataFlat.includes(arm)) {
        errors.push(`data.rs 缺少只读路由形状：${arm}`);
      }
    }
    const armStart = dataSource.indexOf("match segments.as_slice()");
    const armEnd = dataSource.indexOf("_ => None,", armStart);
    if (armStart < 0 || armEnd < 0) {
      errors.push("data.rs 缺少 segments 匹配块");
    } else {
      const armBlock = dataSource.slice(armStart, armEnd);
      const armCount = (armBlock.match(/=> Some\(Self::/g) || []).length;
      if (armCount !== 7) {
        errors.push(`data.rs 路径分支数量应为 7，实际 ${armCount}`);
      }
    }

    // 3. Only /api/books may appear as a data route literal.
    for (const match of dataSource.matchAll(/"([^"]*\/api\/[^"]*)"/g)) {
      if (match[1] !== "/api/books") {
        errors.push(`data.rs 出现未批准路由字面量：${match[1]}`);
      }
    }
    if (routerSource.includes("/api/books")) {
      errors.push("router.rs 出现 /api/books 字面量（数据面必须经注入委派）");
    }

    // 4. Filesystem and SQLite access belongs to read_service, never here.
    for (const token of [
      "rusqlite",
      "Connection::",
      "std::fs",
      "std::path",
      "Path::new",
      "library.db",
      "render_cache",
      "online_cache",
    ]) {
      for (const [label, source] of [
        ["data.rs", dataSource],
        ["data_app.rs", dataAppSource],
      ]) {
        if (source.includes(token)) {
          errors.push(`${label} 直接访问文件系统/SQLite：${token}`);
        }
      }
    }

    // 5. No CORS anywhere on the data/auth surface.
    for (const [label, source] of [
      ["data.rs", dataSource],
      ["data_app.rs", dataAppSource],
      ["session_auth.rs", sessionAuthSource],
    ]) {
      if (/Access-Control-Allow/i.test(source)) {
        errors.push(`${label} 返回了 CORS 头`);
      }
    }

    // 6. No Referer-based auth and no query credential parameters on the
    //    entire data/auth surface.
    for (const [label, source] of [
      ["data.rs", dataSource],
      ["data_app.rs", dataAppSource],
      ["session_auth.rs", sessionAuthSource],
    ]) {
      if (/\bReferer\b/i.test(source)) {
        errors.push(`${label} 使用 Referer 鉴权`);
      }
      for (const literal of [
        '"token"',
        '"secret"',
        '"access_token"',
        '"session_token"',
      ]) {
        if (source.includes(literal)) {
          errors.push(`${label} 出现查询凭据字面量：${literal}`);
        }
      }
    }

    // 6b. Range is not implemented: no RFC 7233 response surface may appear.
    for (const [label, source] of [
      ["data.rs", dataSource],
      ["data_app.rs", dataAppSource],
    ]) {
      if (/Content-Range|Accept-Ranges|StatusCode::PARTIAL_CONTENT|\bRANGE\b/.test(source)) {
        errors.push(`${label} 出现了未批准的 Range/206 支持`);
      }
    }

    // 6c. Transport hardening must stay wired: no keep-alive and bounded
    //     global/per-IP connections; excess peers are dropped by TCP.
    if (!tlsSource.includes(".keep_alive(false)")) {
      errors.push("tls.rs 未关闭 keep-alive");
    }
    for (const constant of [
      "MAX_ACTIVE_CONNECTIONS: usize = 32",
      "MAX_ACTIVE_CONNECTIONS_PER_IP: usize = 8",
    ]) {
      if (!tlsSource.includes(constant)) {
        errors.push(`tls.rs 缺少连接上限常量：${constant}`);
      }
    }
    if (!tlsSource.includes("drop(stream)")) {
      errors.push("tls.rs 未在连接上限超限时丢弃 TCP 连接");
    }

    // 7. Authentication is the single gate and runs before the conditional
    //    cache probe; no direct token-store bypass is allowed.
    if (!dataSource.includes("authenticate_request(request, &self.service)")) {
      errors.push("data.rs 未在 handler 中调用 authenticate_request");
    }
    if (/\bSessionStore\b/.test(dataSource) || dataSource.includes("session_token(")) {
      errors.push("data.rs 绕过 authenticate_request 直接读会话令牌");
    }
    const authIndex = dataSource.indexOf("authenticate_request(request, &self.service)");
    const conditionalIndex = dataSource.indexOf("contains_key(IF_NONE_MATCH)");
    if (
      authIndex < 0 ||
      conditionalIndex < 0 ||
      authIndex > conditionalIndex
    ) {
      errors.push("data.rs 的 IF_NONE_MATCH 探测未在认证之后");
    }

    // 8. Web layout is read-only; the desktop command keeps meta persistence.
    if (!/layout_sync_bounded\s*\(\s*state\s*,\s*id\s*,\s*false\s*,\s*Some\s*\(\s*MAX_WEB_PAGES/.test(readServiceSource)) {
      errors.push("read_service 的 layout_read_only 未以 persist_online=false 且受页数上限约束调用");
    }
    if (/layout_sync\s*\([^;]*?,\s*true\s*\)/.test(readServiceSource)) {
      errors.push("read_service 出现 layout_sync(..., true) Web 持久化调用");
    }
    if (readServiceSource.includes("db::set_progress")) {
      errors.push("read_service 生产路径调用了 db::set_progress");
    }
    if (/\b(?:(?:UPDATE\s+\w+\s+SET)|(?:INSERT\s+INTO)|(?:DELETE\s+FROM))\b/i.test(readServiceSource)) {
      errors.push("read_service 生产路径出现写 SQL");
    }
    if (!desktopCommandsSource.includes("layout_sync(&st, &bid, true)")) {
      errors.push("桌面 layout 命令未保留 layout_sync(..., true) 持久化");
    }

    // 9. The runtime stays Disabled and mounts the data plane once, inside the
    //    explicit start path.
    if (!/phase:\s*Phase::Disabled/.test(runtimeSource)) {
      errors.push("WebAccessRuntime 默认阶段不是 Disabled");
    }
    const withDataCount = (runtimeSource.match(/PairingHttp::with_data\s*\(/g) || [])
      .length;
    if (withDataCount !== 1) {
      errors.push(`PairingHttp::with_data 应出现 1 次，实际 ${withDataCount}`);
    }
    const startIndex = runtimeSource.indexOf("async fn start_inner");
    const withDataIndex = runtimeSource.indexOf("PairingHttp::with_data");
    let startBodyEnd = -1;
    if (startIndex >= 0) {
      const bodyStart = runtimeSource.indexOf("{", startIndex);
      let depth = 0;
      for (let cursor = bodyStart; cursor < runtimeSource.length; cursor += 1) {
        if (runtimeSource[cursor] === "{") depth += 1;
        else if (runtimeSource[cursor] === "}") {
          depth -= 1;
          if (depth === 0) {
            startBodyEnd = cursor;
            break;
          }
        }
      }
    }
    if (
      startIndex < 0 ||
      withDataIndex < 0 ||
      startBodyEnd < 0 ||
      withDataIndex < startIndex ||
      withDataIndex > startBodyEnd
    ) {
      errors.push("PairingHttp::with_data 未唯一挂载在 start_inner 内");
    }
    if (!routerSource.includes("self.data.as_ref()")) {
      errors.push("router.rs 缺少 self.data.as_ref() 受控委派");
    }

    // 10. No library-side start; the runtime owns the only listener start.
    if (/\.start\s*\(/.test(libSource)) {
      errors.push("lib.rs 出现 Web Access 启动调用");
    }
    if (/start_tls_server\s*\(/.test(libSource)) {
      errors.push("lib.rs 启动路径直接启动 TLS");
    }

    // 11. No write/mutation route literal may reach the data plane.
    for (const route of [
      "/api/session",
      "/api/settings",
      "/api/scan",
      "/api/books/import",
      "/api/backup",
      "/api/relocate",
      "/api/delete",
      "/api/books/{id}/file",
    ]) {
      for (const [label, source] of [
        ["data.rs", dataSource],
        ["data_app.rs", dataAppSource],
        ["router.rs", routerSource],
      ]) {
        if (source.includes(route)) {
          errors.push(`${label} 出现写/会话路由字面量：${route}`);
        }
      }
    }

    // 12. The stable error code is mapped exactly once.
    const unsupportedCount = (dataSource.match(/"source-unsupported"/g) || []).length;
    if (unsupportedCount !== 1) {
      errors.push(`data.rs "source-unsupported" 映射应唯一，实际 ${unsupportedCount}`);
    }

    if (errors.length) {
      fail(report, {
        id: "static:d2-data-routes",
        suite: "static",
        layer: "static",
        title: "D2 数据面仅八条只读 GET、会话认证、无文件/SQL/CORS/Range/写路由",
        severity: "P1",
        details: errors.join(" | "),
        location:
          "src-tauri/src/web_access/{data,data_app,session_auth,router,runtime,tls}.rs + src-tauri/src/{read_service,commands,lib}.rs",
        expected:
          "data.rs 只暴露八条 GET 形状且仅在 authenticate_request 之后探测缓存；数据面不触文件/SQL/CORS/Referer/Range/写路由；Web layout 不落盘；tls keep_alive(false) 且连接上限 32/8 以 TCP 断开；runtime 默认 Disabled 且只在 start_inner 挂载一次数据面",
        actual: errors.join(" | "),
        rootCause: "D2 只读数据面边界被破坏",
        fix: "恢复八条只读 GET 路由、认证先于条件探测与 read_service-only 的读写分工",
      });
    } else {
      ok(report, {
        id: "static:d2-data-routes",
        suite: "static",
        layer: "static",
        title: "D2 数据面仅八条只读 GET、会话认证、无文件/SQL/CORS/Range/写路由",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:d2-data-routes",
      suite: "static",
      layer: "static",
      title: "D2 数据面静态边界检查",
      severity: "P1",
      details: error.message,
      location: "src-tauri/src/web_access/data*.rs；src-tauri/src/read_service.rs",
      rootCause: "静态守卫无法读取 D2 文件",
      fix: "确认 D2 文件存在且命名稳定",
    });
  }

  try {
    const errors = [];
    const readSource = (relative) =>
      fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
    const productionOnly = (source) => {
      const index = source.indexOf("#[cfg(test)]\nmod tests");
      return stripRustComments(index >= 0 ? source.slice(0, index) : source);
    };
    const writeSource = productionOnly(
      readSource(path.join("src-tauri", "src", "web_access", "progress_write.rs")),
    );
    const writeAppSource = productionOnly(
      readSource(
        path.join("src-tauri", "src", "web_access", "progress_write_app.rs"),
      ),
    );
    const serviceSource = productionOnly(
      readSource(path.join("src-tauri", "src", "progress_service.rs")),
    );
    const modSource = readSource(
      path.join("src-tauri", "src", "web_access", "mod.rs"),
    );
    const routerSource = productionOnly(
      readSource(path.join("src-tauri", "src", "web_access", "router.rs")),
    );
    const runtimeSource = productionOnly(
      readSource(path.join("src-tauri", "src", "web_access", "runtime.rs")),
    );
    const libSource = readSource(path.join("src-tauri", "src", "lib.rs"));
    const sessionAuthSource = productionOnly(
      readSource(path.join("src-tauri", "src", "web_access", "session_auth.rs")),
    );

    // 1. Exactly one write route, and it is PUT.
    const routeLiterals = [
      ...writeSource.matchAll(/"([^"]*\/api\/[^"]*)"/g),
    ].map((match) => match[1]);
    if (
      routeLiterals.length !== 1 ||
      routeLiterals[0] !== "/api/books/"
    ) {
      errors.push(
        `写路由字面量应唯一为 /api/books/，实际 ${JSON.stringify(routeLiterals)}`,
      );
    }
    const putCount = (writeSource.match(/Method::PUT/g) || []).length;
    if (putCount !== 1) {
      errors.push(`Method::PUT 应出现 1 次，实际 ${putCount}`);
    }
    for (const method of ["POST", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      if (writeSource.includes(`Method::${method}`)) {
        errors.push(`写面出现未批准方法 Method::${method}`);
      }
    }
    for (const token of [
      'strip_prefix("/api/books/")',
      "split_once('/')",
      'suffix != "progress"',
      "parse_book_id",
      "request.uri().query().is_some()",
    ]) {
      if (!writeSource.includes(token)) {
        errors.push(`写路由缺少形状守卫：${token}`);
      }
    }

    // 2. The handler must use the shared contract and provider, never SQL/FS.
    for (const token of [
      "progress_response(",
      "next_action(",
      ".write_progress(",
    ]) {
      if (!writeSource.includes(token)) {
        errors.push(`写面缺少契约调用：${token}`);
      }
    }
    if ((writeSource.match(/progress_response\(/g) || []).length !== 1) {
      errors.push("progress_response 必须恰好调用一次");
    }
    if ((writeSource.match(/next_action\(/g) || []).length !== 1) {
      errors.push("next_action 必须恰好调用一次");
    }
    if (
      writeSource.includes("set_progress_cas") ||
      writeSource.includes("db::set_progress")
    ) {
      errors.push("HTTP 写面不得直接调用数据库进度函数");
    }
    for (const token of [
      "rusqlite",
      "Connection::",
      "std::fs",
      "std::path",
      "library.db",
      "render_cache",
      "online_cache",
    ]) {
      if (writeSource.includes(token)) {
        errors.push(`HTTP 写面直接访问文件系统/SQLite：${token}`);
      }
    }

    // 3. Authentication must precede body reading; body is capped and timed out.
    const authCall = writeSource.indexOf("authenticate_request(&request");
    const bodyCall = writeSource.indexOf("read_limited_body(request");
    if (authCall < 0 || bodyCall < 0 || authCall > bodyCall) {
      errors.push("写面未在读取 body 之前完成认证");
    }
    if (
      !writeSource.includes("MAX_PROGRESS_BODY_BYTES: usize = 4 * 1024")
    ) {
      errors.push("写面缺少 4 KiB body 上限");
    }
    if (!writeSource.includes("BODY_READ_TIMEOUT")) {
      errors.push("写面缺少 body 读取超时");
    }
    if (!writeSource.includes("spawn_blocking")) {
      errors.push("写面未在 spawn_blocking 中调用 provider");
    }
    if (
      !writeSource.includes("application/json") ||
      !writeSource.includes("is_json_content_type")
    ) {
      errors.push("写面缺少 application/json Content-Type 校验");
    }
    if (!writeSource.includes("deny_unknown_fields")) {
      errors.push("写 DTO 未拒绝未知字段");
    }

    // 4. Refresh only after a successful, actually-changed CAS.
    if (
      !writeSource.includes(
        "if status == ProgressStatus::Ok && progress_changed",
      )
    ) {
      errors.push("写面未把刷新限制为成功且进度实际变化");
    }
    if (
      !writeSource.includes(
        "NextAction::Continue { next_base_rev } if next_base_rev != base_rev",
      )
    ) {
      errors.push("刷新条件未由 next_action 的 rev 差推导");
    }
    if ((writeSource.match(/apply_refresh_cookie\(/g) || []).length !== 1) {
      errors.push("apply_refresh_cookie 必须恰好调用一次");
    }
    if (!/apply_refresh_cookie\([^;]*"PUT"[^;]*true/s.test(writeSource)) {
      errors.push("写面刷新未传 PUT/true");
    }
    if (!writeSource.includes("self.guard.check(&request)")) {
      errors.push("写面缺少 Host/Origin/Sec-Fetch/X-Moyu 守卫");
    }
    if (!writeSource.includes("SessionWriteGate")) {
      errors.push("写面缺少每会话并发门");
    }
    if (!writeSource.includes("MAX_RATE_BUCKETS")) {
      errors.push("写面限流桶缺少上界");
    }

    // 5. Service owns DB rules; the app adapter only forwards.
    if ((serviceSource.match(/set_progress_cas_checked\(/g) || []).length !== 1) {
      errors.push("写服务必须恰好调用一次事务内校验的 set_progress_cas_checked");
    }
    if (!serviceSource.includes("get_active_book")) {
      errors.push("写服务未校验 active 书");
    }
    const dbSource = productionOnly(readSource(path.join("src-tauri", "src", "db.rs")));
    const checked = dbSource.slice(dbSource.indexOf("fn set_progress_cas_checked"));
    const begin = checked.indexOf('BEGIN IMMEDIATE');
    const validate = checked.indexOf('validate(conn)');
    const update = checked.indexOf('UPDATE books SET current_page');
    if (begin < 0 || validate <= begin || update <= validate ||
        !/set_progress_cas_checked\([\s\S]*?\|conn\|[\s\S]*?get_active_book/.test(serviceSource)) {
      errors.push("进度页数与状态校验必须位于 CAS 写事务中");
    }
    if (
      !serviceSource.includes("BOOK_FORMAT_PDF") ||
      !serviceSource.includes("row.page_count == 0") ||
      !serviceSource.includes("page >= row.page_count")
    ) {
      errors.push("写服务缺少 PDF/页数上界校验");
    }
    if (
      !serviceSource.includes("pct.is_finite()") ||
      !serviceSource.includes("(0.0..=1.0).contains(&pct)")
    ) {
      errors.push("写服务缺少 scrollPct 有限性与范围校验");
    }
    if (!writeAppSource.includes("progress_service::write_progress")) {
      errors.push("AppProgress 未转发到写服务");
    }
    if (
      !modSource.includes("progress_write") ||
      !modSource.includes("progress_write_app") ||
      !modSource.includes("AppProgress")
    ) {
      errors.push("mod.rs 未挂载或导出 D3 写面模块");
    }

    // 6. Runtime wiring: mount once inside start_inner, never at construction.
    if (!routerSource.includes("self.progress.as_ref()")) {
      errors.push("router.rs 未委派写面 provider");
    }
    if (!routerSource.includes("progress.handle(request")) {
      errors.push("router.rs 未在 data 之后调用写面 handler");
    }
    if ((runtimeSource.match(/router\.with_progress\s*\(/g) || []).length !== 2 ||
        !runtimeSource.includes("async fn start_plain")) {
      errors.push("HTTPS 和用户启用的 HTTP 模式各应挂载写面一次");
    }
    if (!runtimeSource.includes("factory_progress")) {
      errors.push("runtime 未克隆写面 provider 到 factory");
    }
    if (!libSource.includes("AppProgress::new")) {
      errors.push("lib.rs 未构造写面 provider");
    }
    if ((libSource.match(/\.with_progress\s*\(/g) || []).length !== 1) {
      errors.push("lib.rs 应恰好挂载写面一次");
    }
    if (/\.start\s*\(/.test(libSource)) {
      errors.push("lib.rs 不得在初始化阶段启动监听");
    }

    // 7. No CORS, Referer fallback, or URL token on the write surface.
    for (const [label, source] of [
      ["progress_write.rs", writeSource],
      ["progress_write_app.rs", writeAppSource],
      ["progress_service.rs", serviceSource],
      ["session_auth.rs", sessionAuthSource],
    ]) {
      if (/Access-Control-Allow/i.test(source)) {
        errors.push(`${label} 返回了 CORS 头`);
      }
      if (/\bReferer\b/i.test(source)) {
        errors.push(`${label} 使用 Referer`);
      }
      for (const literal of [
        '"token"',
        '"secret"',
        '"access_token"',
        '"session_token"',
      ]) {
        if (source.includes(literal)) {
          errors.push(`${label} 出现查询凭据字面量：${literal}`);
        }
      }
    }

    if (errors.length) {
      fail(report, {
        id: "static:d3-progress-route",
        suite: "static",
        layer: "static",
        title: "D3 写面仅一条 PUT 进度路由、认证先行、body 有界、刷新受控",
        severity: "P1",
        details: errors.join(" | "),
        location:
          "src-tauri/src/web_access/{progress_write,progress_write_app,mod,session_auth}.rs + src-tauri/src/progress_service.rs",
        expected:
          "唯一 PUT /api/books/{id}/progress；先认证再读 body；4 KiB 上限与 5 s 超时；只调用 WebProgressWrite；使用 progress_response/next_action；仅 200 且进度实际变化才刷新；无 SQL/FS/CORS/Referer/URL token",
        actual: errors.join(" | "),
        rootCause: "D3 写面安全边界被破坏",
        fix: "恢复唯一 PUT 路由、认证先行、body 上限/超时、共享契约与受控刷新",
      });
    } else {
      ok(report, {
        id: "static:d3-progress-route",
        suite: "static",
        layer: "static",
        title: "D3 写面仅一条 PUT 进度路由、认证先行、body 有界、刷新受控",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:d3-progress-route",
      suite: "static",
      layer: "static",
      title: "D3 写面静态边界检查",
      severity: "P1",
      details: error.message,
      location:
        "src-tauri/src/web_access/progress_write*.rs + src-tauri/src/progress_service.rs",
      rootCause: "静态守卫无法读取 D3 文件",
      fix: "确认 D3 文件存在且命名稳定",
    });
  }

  // Cross-plane invariants: control-flow order, resource ceilings, route
  // allowlists, refresh containment, runtime injection and test registration.
  // The guard fails closed if any relationship is missing or reordered.
  try {
    const errors = [];
    const read = (relative) =>
      fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
    const productionOnly = (source) => {
      const index = source.indexOf("#[cfg(test)]\nmod tests");
      return stripRustComments(index >= 0 ? source.slice(0, index) : source);
    };
    const webFile = (name) =>
      productionOnly(read(path.join("src-tauri", "src", "web_access", name)));

    const plain = webFile("plain.rs");
    const data = webFile("data.rs");
    const dataApp = webFile("data_app.rs");
    const sessionAuth = webFile("session_auth.rs");
    const write = webFile("progress_write.rs");
    const writeApp = webFile("progress_write_app.rs");
    const service = productionOnly(
      read(path.join("src-tauri", "src", "progress_service.rs")),
    );
    const readService = productionOnly(
      read(path.join("src-tauri", "src", "read_service.rs")),
    );
    const webContract = productionOnly(
      read(path.join("src-tauri", "src", "web_contract.rs")),
    );
    const router = webFile("router.rs");
    const runtime = webFile("runtime.rs");
    const httpSource = webFile("http.rs");
    const tlsSource = webFile("tls.rs");
    const libSource = read(path.join("src-tauri", "src", "lib.rs"));
    const modSource = read(
      path.join("src-tauri", "src", "web_access", "mod.rs"),
    );
    const writeRaw = read(
      path.join("src-tauri", "src", "web_access", "progress_write.rs"),
    );
    const testsRaw = read(
      path.join("src-tauri", "src", "web_access", "tests.rs"),
    );
    const dataTestsRaw = read(
      path.join("src-tauri", "src", "web_access", "data_tests.rs"),
    );

    const order = (source, tokens, label) => {
      let last = -1;
      for (const token of tokens) {
        const index = source.indexOf(token);
        if (index < 0) {
          errors.push(`${label}：缺少 ${token}`);
          return;
        }
        if (index < last) {
          errors.push(`${label}：${token} 顺序错误`);
          return;
        }
        last = index;
      }
    };
    const matchingBrace = (source, open) => {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = open; i < source.length; i += 1) {
        const c = source[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') {
          inString = true;
        } else if (c === "{") {
          depth += 1;
        } else if (c === "}") {
          depth -= 1;
          if (depth === 0) return i;
        }
      }
      return -1;
    };
    const insideBlock = (source, ifToken, callToken, message) => {
      const ifIndex = source.indexOf(ifToken);
      if (ifIndex < 0) {
        errors.push(`${message}：缺少条件块`);
        return;
      }
      const open = source.indexOf("{", ifIndex);
      const end = open < 0 ? -1 : matchingBrace(source, open);
      const call = source.indexOf(callToken);
      if (open < 0 || end < 0 || call < 0 || call <= open || call >= end) {
        errors.push(`${message}：调用不在条件块内`);
      }
    };
    const functionEnd = (source, token) => {
      const start = source.indexOf(token);
      if (start < 0) return -1;
      const open = source.indexOf("{", start);
      return open < 0 ? -1 : matchingBrace(source, open);
    };
    const inFunction = (source, fnToken, token) => {
      const start = source.indexOf(fnToken);
      const end = functionEnd(source, fnToken);
      const index = source.indexOf(token);
      return start >= 0 && end > start && index > start && index < end;
    };

    // D2: parse -> per-IP limit -> authentication -> query parse -> blocking
    // provider. Authentication must also precede the conditional cache probe.
    order(
      data,
      [
        "DataRoute::parse(",
        "self.limiter.check(",
        "authenticate_request(request",
        "route.into_call(",
        "spawn_blocking",
        "call.execute(",
      ],
      "D2 读面调用顺序",
    );
    if (
      data.indexOf("authenticate_request(request") >
      data.indexOf("contains_key(IF_NONE_MATCH)")
    ) {
      errors.push("D2 条件探测未在认证之后");
    }
    insideBlock(
      data,
      "if response.status() == StatusCode::OK || response.status() == StatusCode::NOT_MODIFIED",
      "self.apply_refresh(",
      "D2 会话刷新必须在成功/304 分支",
    );
    for (const token of [
      "VARY",
      "PRIVATE_NO_CACHE",
      "NO_STORE",
      "ETAG",
      "not_modified",
      "etag_matches",
    ]) {
      if (!data.includes(token)) {
        errors.push(`D2 缺少缓存/验证器不变量：${token}`);
      }
    }
    if (/\bpublic\b/.test(data)) {
      errors.push("D2 出现 public 缓存");
    }
    if (!/Self::Layout\(dims\)\s*=>\s*json_response\([\s\S]*?PRIVATE_NO_CACHE/.test(data)) {
      errors.push("布局缓存必须重新验证，避免重扫后继续使用旧布局");
    }
    for (const [label, source] of [
      ["data.rs", data],
      ["data_app.rs", dataApp],
    ]) {
      for (const token of [
        "rusqlite",
        "Connection::",
        "std::fs",
        "std::path",
        "library.db",
        "render_cache",
        "online_cache",
        "db::set_progress",
        "set_progress_cas",
      ]) {
        if (source.includes(token)) {
          errors.push(`${label} 触碰写/SQL/文件系统：${token}`);
        }
      }
    }
    if (readService.includes("db::set_progress")) {
      errors.push("read_service 生产路径调用桌面 set_progress");
    }
    if (
      /\b(?:(?:UPDATE\s+\w+\s+SET)|(?:INSERT\s+INTO)|(?:DELETE\s+FROM))\b/i.test(
        readService,
      )
    ) {
      errors.push("read_service 生产路径出现写 SQL");
    }
    if (data.includes("Method::PUT")) {
      errors.push("D2 data.rs 出现 Method::PUT");
    }
    if (router.includes("/api/books")) {
      errors.push("router.rs 出现 /api/books 字面量");
    }

    // D2 resource ceilings.
    for (const [label, source, tokens] of [
      [
        "http.rs",
        httpSource,
        [
          "HEADER_LIMIT: usize = 8 * 1024",
          "HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10)",
          "HTTP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(65)",
          "PAIR_HANDLER_TIMEOUT: Duration = Duration::from_secs(10)",
          "DATA_HANDLER_TIMEOUT: Duration = Duration::from_secs(60)",
        ],
      ],
      [
        "data.rs",
        data,
        [
          "RENDER_GATE: usize = 2",
          "SESSION_IN_FLIGHT: usize = 6",
          "METADATA_PER_WINDOW: u32 = 120",
          "IMAGE_PER_WINDOW: u32 = 120",
          "TILE_PER_WINDOW: u32 = 600",
          "MAX_RATE_BUCKETS: usize = 1024",
        ],
      ],
      [
        "tls.rs",
        tlsSource,
        [
          "MAX_ACTIVE_CONNECTIONS: usize = 32",
          "MAX_ACTIVE_CONNECTIONS_PER_IP: usize = 8",
          ".keep_alive(false)",
          "drop(stream)",
        ],
      ],
    ]) {
      for (const token of tokens) {
        if (!source.includes(token)) {
          errors.push(`${label} 缺少资源上限：${token}`);
        }
      }
    }
    if (!httpSource.includes("SocketAddr::V4(addr) = addr")) {
      errors.push("authority 未显式拒绝 IPv6");
    }

    // D3: guard -> exact route -> per-IP limit -> authentication -> media type
    // -> bounded body -> session gate -> blocking CAS -> contract -> refresh.
    order(
      write,
      [
        "self.guard.check(&request)",
        "ProgressWriteRoute::parse(",
        "self.limiter.check(",
        "authenticate_request(&request",
        "is_json_content_type(&request)",
        "read_limited_body(request",
        "self.sessions.gate(",
        "spawn_blocking",
        "progress_response(",
        "next_action(",
        "progress_http_response(",
        "apply_refresh_cookie(&self.service",
      ],
      "D3 写面调用顺序",
    );
    insideBlock(
      write,
      "if status == ProgressStatus::Ok && progress_changed",
      "apply_refresh_cookie(",
      "D3 会话刷新必须在成功且 changed 分支",
    );
    if (
      !write.includes(
        "NextAction::Continue { next_base_rev } if next_base_rev != base_rev",
      )
    ) {
      errors.push("D3 刷新条件未由 next_action 的 rev 差推导");
    }
    if ((write.match(/apply_refresh_cookie\(/g) || []).length !== 1) {
      errors.push("D3 apply_refresh_cookie 必须恰好调用一次");
    }
    if (!/apply_refresh_cookie\([^;]*"PUT"[^;]*true/s.test(write)) {
      errors.push("D3 刷新未传 PUT/true");
    }
    if (write.includes("SET_COOKIE")) {
      errors.push("D3 写面直接操作 Set-Cookie");
    }

    // D3 route allowlist and body constraints.
    const routeLiterals = [...write.matchAll(/"([^"]*\/api\/[^"]*)"/g)].map(
      (match) => match[1],
    );
    if (
      routeLiterals.length !== 1 ||
      routeLiterals[0] !== "/api/books/"
    ) {
      errors.push(
        `D3 写路由字面量应唯一为 /api/books/，实际 ${JSON.stringify(routeLiterals)}`,
      );
    }
    if ((write.match(/Method::PUT/g) || []).length !== 1) {
      errors.push("D3 Method::PUT 应出现 1 次");
    }
    for (const method of ["POST", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      if (write.includes(`Method::${method}`)) {
        errors.push(`D3 写面出现未批准方法 Method::${method}`);
      }
    }
    for (const token of [
      'strip_prefix("/api/books/")',
      "split_once('/')",
      'suffix != "progress"',
      "parse_book_id",
      "request.uri().query().is_some()",
      "MAX_PROGRESS_BODY_BYTES: usize = 4 * 1024",
      "read_limited_body(request, MAX_PROGRESS_BODY_BYTES)",
      "BODY_READ_TIMEOUT: Duration = Duration::from_secs(5)",
      "WRITE_HANDLER_TIMEOUT: Duration = Duration::from_secs(10)",
      "WRITE_PER_WINDOW: u32 = 120",
      "SESSION_IN_FLIGHT: usize = 2",
      "MAX_RATE_BUCKETS: usize = 1024",
      "is_json_content_type",
      "application/json",
      "deny_unknown_fields",
      "base_rev",
      "scroll_pct",
    ]) {
      if (!write.includes(token)) {
        errors.push(`D3 写面缺少不变量：${token}`);
      }
    }
    if (write.includes("rusqlite") || write.includes("Connection::")) {
      errors.push("D3 HTTP 写面直接访问 SQLite");
    }
    if (write.includes("set_progress_cas") || write.includes("db::set_progress")) {
      errors.push("D3 HTTP 写面直接调用数据库进度函数");
    }
    for (const token of ["std::fs", "std::path", "library.db", "render_cache", "online_cache"]) {
      if (write.includes(token) || writeApp.includes(token)) {
        errors.push(`D3 写面直接访问文件系统：${token}`);
      }
    }

    // The explicitly enabled HTTP listener keeps peer, resource and cookie boundaries.
    for (const token of ["is_private_lan_ipv4", "MAX_ACTIVE_CONNECTIONS", "ConnectionLimiter", "HEADER_READ_TIMEOUT", "HTTP_CONNECTION_TIMEOUT", "moyul_session", "moyul_claim", "inbound_cookies", "outbound_cookies"]) {
      if (!plain.includes(token)) errors.push(`HTTP 局域网监听缺少不变量：${token}`);
    }
    if (!inFunction(runtime.slice(runtime.indexOf("async fn start_plain")), "async fn start_plain", "ensure_online_allowed")) {
      errors.push("HTTP 模式未在启动锁内检查安全模式");
    }
    if (!router.includes("self.open_pairing") || !/self\.service\s*\.claim_open\s*\(/.test(router)) {
      errors.push("HTTP 模式缺少受控设备申请入口");
    }

    // D3 service owns the database rules; the adapter only forwards.
    if ((service.match(/set_progress_cas_checked\(/g) || []).length !== 1) {
      errors.push("D3 写服务必须恰好调用一次事务内校验的 set_progress_cas_checked");
    }
    for (const token of [
      "get_active_book",
      "BOOK_FORMAT_PDF",
      "row.page_count == 0",
      "page >= row.page_count",
      "pct.is_finite()",
      "(0.0..=1.0).contains(&pct)",
    ]) {
      if (!service.includes(token)) {
        errors.push(`D3 写服务缺少校验：${token}`);
      }
    }
    if (!writeApp.includes("progress_service::write_progress")) {
      errors.push("D3 AppProgress 未转发到写服务");
    }
    if (
      !webContract.includes("ERROR_PROGRESS_CONFLICT") ||
      !webContract.includes("ERROR_BOOK_NOT_FOUND") ||
      !webContract.includes("progress_response") ||
      !webContract.includes("next_action")
    ) {
      errors.push("D3 共享契约缺少进度映射/错误码");
    }
    for (const token of [
      '"rev"',
      '"page"',
      '"updatedAt"',
      '"currentPage"',
      '"currentRev"',
      "no-store",
    ]) {
      if (!write.includes(token)) {
        errors.push(`D3 响应契约缺少字段/缓存头：${token}`);
      }
    }

    // D3 surface must not add CORS, Referer fallback or URL credentials.
    for (const [label, source] of [
      ["progress_write.rs", write],
      ["progress_write_app.rs", writeApp],
      ["progress_service.rs", service],
      ["session_auth.rs", sessionAuth],
    ]) {
      if (/Access-Control-Allow/i.test(source)) {
        errors.push(`${label} 返回了 CORS 头`);
      }
      if (/\bReferer\b/i.test(source)) {
        errors.push(`${label} 使用 Referer`);
      }
      for (const literal of [
        '"token"',
        '"secret"',
        '"access_token"',
        '"session_token"',
      ]) {
        if (source.includes(literal)) {
          errors.push(`${label} 出现查询凭据字面量：${literal}`);
        }
      }
    }

    // Runtime and library boundaries: default Disabled, mount once inside
    // start_inner, never start during app initialization.
    if (!/phase:\s*Phase::Disabled/.test(runtime)) {
      errors.push("Runtime 默认阶段不是 Disabled");
    }
    if ((runtime.match(/PairingHttp::with_data\s*\(/g) || []).length !== 1) {
      errors.push("Runtime 的 with_data 应恰好出现一次");
    }
    if ((runtime.match(/router\.with_progress\s*\(/g) || []).length !== 2 ||
        !inFunction(runtime.slice(runtime.indexOf("async fn start_plain")), "async fn start_plain", "router.with_progress")) {
      errors.push("HTTPS 和 HTTP 模式必须分别挂载写面");
    }
    if (!inFunction(runtime, "async fn start_inner", "PairingHttp::with_data")) {
      errors.push("with_data 未在 start_inner 内挂载");
    }
    if (!inFunction(runtime, "async fn start_inner", "router.with_progress")) {
      errors.push("with_progress 未在 start_inner 内挂载");
    }
    if (!router.includes("self.progress.as_ref()")) {
      errors.push("router.rs 未委派写面 provider");
    }
    if (!router.includes("progress.handle(request")) {
      errors.push("router.rs 未在 data 之后调用写面 handler");
    }
    if (!libSource.includes("AppProgress::new")) {
      errors.push("lib.rs 未构造写面 provider");
    }
    if ((libSource.match(/\.with_progress\s*\(/g) || []).length !== 1) {
      errors.push("lib.rs 应恰好挂载写面一次");
    }
    if (/\.start\s*\(/.test(libSource) || /start_tls_server\s*\(/.test(libSource)) {
      errors.push("lib.rs 在初始化阶段启动监听");
    }

    // Test registration: the named D2/D3 regression suites must exist and
    // must not be silently skipped.
    if (
      !modSource.includes("#[cfg(test)]\nmod data_tests;") ||
      !modSource.includes("#[cfg(test)]\nmod tests;")
    ) {
      errors.push("web_access 测试模块未注册");
    }
    for (const name of [
      "real_tls_progress_write_cas_auth_and_guards",
      "real_tls_progress_body_limit_transaction_failure_and_removed",
      "real_tls_progress_pdf_is_415",
    ]) {
      if (!testsRaw.includes(`async fn ${name}`)) {
        errors.push(`缺少真实 TLS 回归测试：${name}`);
      }
    }
    for (const name of [
      "all_read_routes_leave_book_progress_and_log_unchanged",
      "conditional_page_304_does_not_write_any_state",
      "put_is_404_without_a_progress_provider",
      "put_is_served_when_progress_is_mounted_and_reads_still_work",
    ]) {
      if (!dataTestsRaw.includes(`async fn ${name}`)) {
        errors.push(`缺少 D2/D3 路由回归测试：${name}`);
      }
    }
    for (const name of [
      "put_writes_and_rev_handoff",
      "stale_base_rev_is_409_and_changes_nothing",
      "noop_does_not_refresh_session_or_touch_updated_at",
      "changed_write_refreshes_session",
      "second_changed_write_within_hour_does_not_refresh_again",
    ]) {
      if (!writeRaw.includes(`async fn ${name}`)) {
        errors.push(`缺少 D3 写面回归测试：${name}`);
      }
    }
    for (const [label, source] of [
      ["progress_write.rs", writeRaw],
      ["tests.rs", testsRaw],
      ["data_tests.rs", dataTestsRaw],
    ]) {
      if (source.includes("#[ignore]")) {
        errors.push(`${label} 含被忽略的测试`);
      }
    }

    if (errors.length) {
      fail(report, {
        id: "static:d2-d3-security-invariants",
        suite: "static",
        layer: "static",
        title: "D2/D3 控制流顺序、资源上限、刷新门、接线与测试注册",
        severity: "P1",
        details: errors.join(" | "),
        location:
          "src-tauri/src/web_access/{data,progress_write,router,runtime,http,tls,session_auth,data_tests}.rs + src-tauri/src/{progress_service,read_service,web_contract,lib}.rs",
        expected:
          "D2：parse→限流→认证→query→blocking provider，认证先于条件探测，刷新仅在成功/304；D3：guard→路由→限流→认证→Content-Type→有界 body→会话门→blocking CAS→progress_response→next_action→受控刷新；资源上限、无 SQL/FS/CORS/Referer/token、默认 Disabled、start_inner 单次挂载、测试已注册且未 ignore",
        actual: errors.join(" | "),
        rootCause: "D2/D3 安全控制流或治理边界被破坏",
        fix: "恢复调用顺序、资源上限、刷新门、runtime 注入与测试注册",
      });
    } else {
      ok(report, {
        id: "static:d2-d3-security-invariants",
        suite: "static",
        layer: "static",
        title: "D2/D3 控制流顺序、资源上限、刷新门、接线与测试注册",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:d2-d3-security-invariants",
      suite: "static",
      layer: "static",
      title: "D2/D3 跨面安全不变量检查",
      severity: "P1",
      details: error.message,
      location:
        "src-tauri/src/web_access + src-tauri/src/{progress_service,read_service,web_contract,lib}.rs",
      rootCause: "静态守卫无法读取 D2/D3 文件",
      fix: "确认 D2/D3 文件存在且命名稳定",
    });
  }

  try {
    const errors = [];
    const read = (relative) =>
      fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
    const settings = read("src/pages/Settings.tsx");
    const developer = read("src/components/settings/DeveloperFeaturePanel.tsx");
    const summary = read("src/components/settings/WebAccessSummaryCard.tsx");
    const panel = read("src/components/settings/WebAccessPanel.tsx");
    const runtime = read("src-tauri/src/web_access/runtime.rs");
    const tray = read("src-tauri/src/tray.rs");
    const technical = read("docs/TECHNICAL.md");

    if (!settings.includes("<DeveloperFeaturePanel")) {
      errors.push("设置页未挂载开发者功能总控面板");
    }
    if (!/api\.setFeatureEnabled\s*\(/.test(settings)) {
      errors.push("开发者功能开关未走 set_feature_enabled 唯一写通道");
    }
    if (!settings.includes("FEATURE_REGISTRY") || !settings.includes("resetFeatureGates")) {
      errors.push("恢复默认模块配置未遍历 FEATURE_REGISTRY 或缺少实现");
    }
    if (/setSettings\s*\(\s*\{[^}]*features/s.test(developer)) {
      errors.push("开发者面板试图用 set_settings 修改 features");
    }
    for (const feature of ["webAccess", "opds", "backup", "updates"]) {
      if (!settings.includes(`feature="${feature}"`)) {
        errors.push(`设置页缺少 ${feature} 功能禁用占位`);
      }
    }
    if (!settings.includes('feature="diagnostics"') && !read("src/components/settings/PrivacyPanel.tsx").includes('feature="diagnostics"')) {
      errors.push("诊断面板缺少功能禁用占位");
    }
    const summaryClose = settings.indexOf("</WebAccessSummaryCard>");
    const opdsMount = settings.indexOf("<OpdsPanel");
    if (summaryClose !== -1 && opdsMount !== -1 && opdsMount < summaryClose) {
      errors.push("OPDS 面板仍被嵌套在 Web Access 门卫/摘要卡内");
    }
    if (!summary.includes("WebAccessProvider")) {
      errors.push("Web Access 摘要未提供单一共享控制器");
    }
    if (!panel.includes("useWebAccessController") || panel.includes("useWebAccess()")) {
      errors.push("Web Access 高级面板未复用共享控制器");
    }
    if (!/StopReason::Stopped \| StopReason::SafeMode/.test(runtime)) {
      errors.push("安全模式停止 Web Access 时未广播状态事件");
    }
    if (!/runtime\.start\(|start_plain\(/.test(tray) || !/runtime\.stop\(/.test(tray)) {
      errors.push("托盘菜单未接线 Web Access 启停");
    }
    const stalePhrases = [
      "本切片只交付",
      "不注册任何 Tauri 命令",
      "当前没有系统托盘",
      "本地分支待合并",
      "G2 仍为 library/test-only",
      "D1b 控制面与生产监听未开始",
      "尚未接入 `lib.rs`",
    ];
    for (const phrase of stalePhrases) {
      if (technical.includes(phrase)) {
        errors.push(`TECHNICAL.md 仍含过期表述：${phrase}`);
      }
    }
    for (const required of [
      "开发者功能总控",
      "FeatureDisabledNotice",
      "WebAccessProvider",
      "web_access_start_plain",
      "StopReason::SafeMode",
    ]) {
      if (!technical.includes(required)) {
        errors.push(`TECHNICAL.md 缺少当前实现事实：${required}`);
      }
    }

    if (errors.length) {
      fail(report, {
        id: "static:feature-gate-and-doc-sync",
        suite: "static",
        layer: "static",
        title: "开发者门卫、可恢复占位、共享 Web Access 状态与文档同步",
        severity: "P1",
        details: errors.join(" | "),
        location:
          "src/pages/Settings.tsx + src/components/settings/DeveloperFeaturePanel.tsx + src/features/web-access + docs/TECHNICAL.md",
        expected:
          "9 项门卫经 set_feature_enabled 写入；业务入口降级为 FeatureDisabledNotice；OPDS 不再嵌套在 Web Access 内；摘要与高级面板共享控制器；安全模式停止广播；TECHNICAL.md 无过期表述",
        actual: errors.join(" | "),
        rootCause: "功能门卫与远程书库设置再次交叉耦合，或文档回退到历史状态",
        fix: "恢复开发者总控/占位/共享控制器接线，并就地更新 TECHNICAL.md",
      });
    } else {
      ok(report, {
        id: "static:feature-gate-and-doc-sync",
        suite: "static",
        layer: "static",
        title: "开发者门卫、可恢复占位、共享 Web Access 状态与文档同步",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:feature-gate-and-doc-sync",
      suite: "static",
      layer: "static",
      title: "开发者门卫与文档同步静态检查",
      severity: "P1",
      details: error.message,
      location: "src/pages/Settings.tsx + docs/TECHNICAL.md",
      rootCause: "静态守卫无法读取设置页或技术文档",
      fix: "确认相关文件存在且命名稳定",
    });
  }
}
