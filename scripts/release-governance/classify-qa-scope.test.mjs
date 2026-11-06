import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyQaScope,
  QA_E2E_SUITES,
  QA_SUITES,
} from "./classify-qa-scope.mjs";

const cases = [
  {
    name: "纯文档：README + docs",
    files: ["README.md", "docs/TESTING.md"],
    expected: { mode: "docs", suite: "static", runsE2e: false },
  },
  {
    name: "离线演示与 demo 测试按文档处理",
    files: ["public/demo/index.html", "public/demo/demo.js", "tests/demo.test.mjs"],
    expected: { mode: "docs", suite: "static", runsE2e: false },
  },
  {
    name: "PR 模板、标签与 dependabot 属于文档",
    files: [
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/labels.json",
      ".github/dependabot.yml",
    ],
    expected: { mode: "docs", suite: "static", runsE2e: false },
  },
  {
    name: "普通治理脚本只跑 static",
    files: ["scripts/pr-governance.mjs", "scripts/release-contract.test.mjs"],
    expected: { mode: "docs", suite: "static", runsE2e: false },
  },
  {
    name: "普通页面与组件属于前端",
    files: [
      "src/pages/Library.tsx",
      "src/components/library/LibraryFilters.tsx",
      "src/components/ui/button.tsx",
    ],
    expected: {
      mode: "frontend",
      suite: "static,visual,architecture",
      runsE2e: true,
    },
  },
  {
    name: "六语字典与主题样式属于前端",
    files: ["src/i18n/messages/settings.ts", "src/index.css"],
    expected: {
      mode: "frontend",
      suite: "static,visual,architecture",
      runsE2e: true,
    },
  },
  {
    name: "设置外壳与主题 Provider 属于前端",
    files: [
      "src/components/settings/SettingsSection.tsx",
      "src/features/theme/ThemeProvider.tsx",
    ],
    expected: {
      mode: "frontend",
      suite: "static,visual,architecture",
      runsE2e: true,
    },
  },
  {
    name: "错误本地化与快捷键属于前端",
    files: [
      "src/features/errors/localize.ts",
      "src/features/shortcuts/useGlobalShortcuts.ts",
    ],
    expected: {
      mode: "frontend",
      suite: "static,visual,architecture",
      runsE2e: true,
    },
  },
  {
    name: "非高危 Rust（platform）只跑 architecture + cache",
    files: ["src-tauri/src/platform.rs"],
    expected: {
      mode: "backend",
      suite: "static,architecture,cache",
      runsE2e: true,
    },
  },
  {
    name: "非高危 Rust（state）只跑 architecture + cache",
    files: ["src-tauri/src/state.rs"],
    expected: {
      mode: "backend",
      suite: "static,architecture,cache",
      runsE2e: true,
    },
  },
  {
    name: "数据库/迁移属于全量",
    files: ["src-tauri/src/db.rs", "src-tauri/src/versioning.rs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "阅读器组件属于全量",
    files: ["src/components/Reader/Webtoon.tsx"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "设置页与更新面板属于全量",
    files: ["src/pages/Settings.tsx", "src/components/settings/UpdatesPanel.tsx"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "浏览器页属于全量",
    files: ["src/pages/Browser.tsx"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "PDF 与备份功能属于全量",
    files: ["src/features/pdf/render.ts", "src/features/backup/api.ts"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "条漫几何、IPC 封装属于全量",
    files: ["src/lib/webtoonGeometry.ts", "src/lib/tauri.ts"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "缓存与 OPDS 后端属于全量",
    files: ["src-tauri/src/render_cache.rs", "src-tauri/src/opds.rs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "Web Access 与日志脱敏属于全量",
    files: ["src-tauri/src/web_access/http.rs", "src-tauri/src/logging.rs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "Linux 发布配置属于全量",
    files: ["src-tauri/tauri.linux.conf.json"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "工作流与发布治理脚本属于全量",
    files: [".github/workflows/qa-l2.yml", "scripts/release-governance/qa-gate.mjs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "Linux 高危补丁清单脚本属于全量",
    files: ["scripts/make-linux-critical-manifest.mjs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "依赖与构建配置属于全量",
    files: ["package.json", "package-lock.json", "vite.config.ts"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "QA 测试框架改动属于全量",
    files: ["tests/qa/run-qa.mjs", "tests/qa/suites/reader.mjs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "文档 + 前端仍按前端",
    files: ["README.md", "src/pages/Library.tsx"],
    expected: {
      mode: "frontend",
      suite: "static,visual,architecture",
      runsE2e: true,
    },
  },
  {
    name: "文档 + 后端仍按后端",
    files: ["README.md", "src-tauri/src/platform.rs"],
    expected: {
      mode: "backend",
      suite: "static,architecture,cache",
      runsE2e: true,
    },
  },
  {
    name: "前后端混合按全量",
    files: ["src/pages/Library.tsx", "src-tauri/src/platform.rs"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "未知路径按全量",
    files: ["assets/unexpected.bin"],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "空 diff 按全量",
    files: [],
    expected: { mode: "full", suite: "", runsE2e: true },
  },
  {
    name: "Draft 只跑 static，即使包含前端",
    files: ["src/pages/Library.tsx"],
    draft: true,
    expected: { mode: "draft", suite: "static", runsE2e: false },
  },
  {
    name: "Draft 只跑 static，即使包含高危路径",
    files: ["src-tauri/src/db.rs"],
    draft: true,
    expected: { mode: "draft", suite: "static", runsE2e: false },
  },
];

for (const item of cases) {
  test(`classifyQaScope · ${item.name}`, () => {
    const result = classifyQaScope(item.files, { draft: Boolean(item.draft) });
    assert.equal(result.mode, item.expected.mode);
    assert.equal(result.suite, item.expected.suite);
    assert.equal(result.runsE2e, item.expected.runsE2e);
    if (result.suite) {
      for (const suite of result.suite.split(",")) {
        assert.ok(QA_SUITES.includes(suite), `未知 suite：${suite}`);
      }
    }
  });
}

test("classifyQaScope · runsE2e 与 suite 集合一致", () => {
  const frontend = classifyQaScope(["src/pages/Library.tsx"]);
  assert.equal(frontend.runsE2e, true);
  assert.ok(frontend.suite.split(",").some((suite) => QA_E2E_SUITES.has(suite)));

  const docs = classifyQaScope(["README.md"]);
  assert.equal(docs.runsE2e, false);
  assert.ok(docs.suite.split(",").every((suite) => !QA_E2E_SUITES.has(suite)));
});

test("classifyQaScope · 结果稳定且 suite 不重复", () => {
  const result = classifyQaScope(["src/pages/A.tsx", "src/pages/B.tsx"]);
  assert.equal(result.suite, "static,visual,architecture");
  assert.equal(new Set(result.suite.split(",")).size, result.suite.split(",").length);
});
