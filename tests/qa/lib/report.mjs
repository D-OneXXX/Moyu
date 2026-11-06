import fs from "node:fs";
import path from "node:path";

const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"];
const DAY_MS = 86_400_000;
const DEFAULT_STALE_AFTER_DAYS = 7;

function parseRunTimestamp(value) {
  const runId = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(
    String(value || ""),
  );
  if (runId) {
    const [, year, month, day, hour, minute, second, millis] = runId;
    return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 超过阈值未复验的 open 台账条目标记为 stale：保留原始 open 状态与历史，
 * 但在报告中与活跃 P0/P1 分开，避免“全绿 + 历史 P0”同时出现。
 */
export function markStaleDefects(
  kb,
  { now = Date.now(), staleAfterDays = DEFAULT_STALE_AFTER_DAYS } = {},
) {
  const days = Number(staleAfterDays);
  const effectiveDays =
    Number.isFinite(days) && days > 0 ? days : DEFAULT_STALE_AFTER_DAYS;
  const threshold = effectiveDays * DAY_MS;
  for (const entry of kb.defects || []) {
    if (entry.status !== "open") {
      delete entry.stale;
      delete entry.staleSince;
      delete entry.staleAfterDays;
      continue;
    }
    const seenAt = parseRunTimestamp(entry.lastSeen);
    if (seenAt === null) {
      entry.stale = false;
      delete entry.staleSince;
      delete entry.staleAfterDays;
      continue;
    }
    entry.stale = now - seenAt > threshold;
    if (entry.stale) {
      entry.staleSince ??= new Date(now).toISOString();
      entry.staleAfterDays = effectiveDays;
    } else {
      delete entry.staleSince;
      delete entry.staleAfterDays;
    }
  }
  kb.staleAfterDays = effectiveDays;
  return kb;
}

/**
 * 套件成功执行至结尾时写入的完成记录：与 `${suite.id}:crashed` 同 ID，
 * 让曾经崩溃过的台账条目在下一次成功运行后自动关闭。
 */
export function suiteCompletionCheck(suite) {
  return {
    id: `${suite.id}:crashed`,
    suite: suite.id,
    layer: "infrastructure",
    title:
      suite.id === "pdf"
        ? "PDF 完整套件运行至结尾且未中断"
        : `${suite.title || suite.id} 执行至结尾未中断`,
    pass: true,
  };
}

/**
 * `execution` 是 NON_INTRUSIVE_ENGINEERING §13 要求的执行记录
 * （级别 / 授权来源 / 进程 / 端口 / 清理结果 / 延后套件）。
 */
export function createReport({
  root,
  artifactDir,
  appVersion,
  buildCommit,
  execution = null,
}) {
  return {
    schema: 1,
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    root,
    artifactDir,
    appVersion,
    buildCommit,
    execution,
    checks: [],
    defects: [],
    notes: [],
  };
}

export function record(report, check) {
  const entry = {
    id: check.id,
    suite: check.suite,
    layer: check.layer || "integration",
    title: check.title,
    status: check.pass ? "pass" : "fail",
    severity: check.pass ? null : check.severity || "P2",
    details: check.details ?? "",
    location: check.location ?? "",
    repro: check.repro ?? "",
    expected: check.expected ?? "",
    actual: check.actual ?? "",
    rootCause: check.rootCause ?? "",
    fix: check.fix ?? "",
    evidence: check.evidence ?? null,
  };
  report.checks.push(entry);
  if (!check.pass) report.defects.push(entry);
  return entry;
}

export function ok(report, meta) {
  return record(report, { ...meta, pass: true });
}

export function fail(report, meta) {
  return record(report, { ...meta, pass: false });
}

export function note(report, text) {
  report.notes.push(text);
}

export function summarize(report) {
  const total = report.checks.length;
  const passed = report.checks.filter((check) => check.status === "pass").length;
  const failed = total - passed;
  const coverage = [...new Set(report.checks.map((check) => check.layer))];
  const bySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      report.defects.filter((defect) => defect.severity === severity).length,
    ]),
  );
  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? 0 : (passed / total) * 100,
    coverage,
    bySeverity,
  };
}

export function writeJsonReport(report, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
}

function issueBlock(issue, index) {
  return [
    `### ${issue.severity} · ${issue.id} — ${issue.title}`,
    "",
    `- **精确位置**：\`${issue.location || "未定位"}\``,
    `- **复现路径**：\`${issue.repro || issue.details || "见自动化用例"}\``,
    `- **预期行为**：${issue.expected || "符合需求规范"}`,
    `- **实际错误行为**：${issue.actual || issue.details || "断言失败"}`,
    `- **直指根因与修复方案**：${issue.rootCause || issue.details || "见证据"}${
      issue.fix ? `\n  修复建议：${issue.fix}` : ""
    }`,
    "",
  ].join("\n");
}

export function writeMarkdownReport(report, file, kb = null) {
  const summary = summarize(report);
  const blocking = report.defects
    .filter((issue) => issue.severity === "P0" || issue.severity === "P1")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const cosmetic = report.defects
    .filter((issue) => issue.severity === "P2" || issue.severity === "P3")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  // QA 台账的真实字段是 defects；历史 backlog 字段不存在，读取它会让
  // 静态缺陷恒为 0，已登记的 open P0/P1 在报告里完全消失。
  const staticOpen = (kb?.defects || []).filter((issue) => issue.status === "open");
  const activeOpen = staticOpen.filter((issue) => !issue.stale);
  const staleOpen = staticOpen.filter((issue) => issue.stale);
  const staticBlocking = activeOpen
    .filter((issue) => issue.severity === "P0" || issue.severity === "P1")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staleBlocking = staleOpen
    .filter((issue) => issue.severity === "P0" || issue.severity === "P1")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staticCosmetic = activeOpen
    .filter((issue) => issue.severity === "P2" || issue.severity === "P3")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staleCosmetic = staleOpen
    .filter((issue) => issue.severity === "P2" || issue.severity === "P3")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staticBySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      activeOpen.filter((issue) => issue.severity === severity).length,
    ]),
  );
  const staleBySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      staleOpen.filter((issue) => issue.severity === severity).length,
    ]),
  );
  const staleAfterDays = kb?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  // 执行级别与授权记录：未执行的套件必须在这里显式出现，不能被当成 PASS。
  const execution = report.execution || null;
  const executionLines = execution
    ? [
        "### 执行级别与非侵入式记录",
        "",
        `- 执行级别：**${execution.level}**（${execution.backgroundOrInteractive}）`,
        `- 判定依据：${execution.rationale}`,
        `- 授权：required=${execution.authorization?.required ? "yes" : "no"} · granted=${execution.authorization?.granted ? "yes" : "no"} · source=${execution.authorization?.source || "UNKNOWN"}`,
        `- 桌面/系统交互：${execution.desktopInteraction?.length ? execution.desktopInteraction.join("；") : "无"}`,
        `- 创建进程：${execution.processes?.length ? execution.processes.join("；") : "无"}`,
        `- 监听端口：${execution.ports?.length ? execution.ports.join("；") : "无"}`,
        `- 清理结果：${execution.cleanup || "UNKNOWN"}`,
        `- 延后/阻塞套件：${execution.deferredSuites?.length ? execution.deferredSuites.join("；") : "无"}`,
        `- 资源限制：${execution.resourceLimits || "UNKNOWN"}`,
        "",
      ]
    : [];
  const lines = [
    "# Moyu QA 审计报告",
    "",
    `- 运行编号：${report.runId}`,
    `- 版本：v${report.appVersion} (${report.buildCommit})`,
    `- 应用数据：隔离目录；未触碰现有用户数据`,
    `- 开始/结束：${report.startedAt} / ${report.finishedAt || "进行中"}`,
    "",
    "## 1. 测试总览",
    "",
    `- 通过率：**${summary.passed}/${summary.total}（${summary.passRate.toFixed(1)}%）**`,
    `- 覆盖层级：${summary.coverage.join(" / ") || "无"}`,
    `- 运行时缺陷：P0=${summary.bySeverity.P0} · P1=${summary.bySeverity.P1} · P2=${summary.bySeverity.P2} · P3=${summary.bySeverity.P3}`,
    `- 静态审计 backlog：${activeOpen.length} 条（P0=${staticBySeverity.P0} · P1=${staticBySeverity.P1} · P2=${staticBySeverity.P2} · P3=${staticBySeverity.P3}，尚未全部自动化）`,
    `- 陈旧待复验：${staleOpen.length} 条（P0=${staleBySeverity.P0} · P1=${staleBySeverity.P1} · P2=${staleBySeverity.P2} · P3=${staleBySeverity.P3}，超过 ${staleAfterDays} 天未复验，不计入活跃 backlog）`,
    `- 回归用例：${report.knowledgeBase?.regressions ?? 0} 条记忆，新增 ${report.knowledgeBase?.newRegressions ?? 0} 条`,
    "",
    ...executionLines,
    "## 2. 阻塞与严重缺陷直指（P0 / P1）",
    "",
    "### 自动化运行",
    "",
    blocking.length ? blocking.map(issueBlock).join("\n") : "未发现 P0 / P1 缺陷。",
    "",
    ...(staticBlocking.length
      ? [
          "### 台账中尚未关闭的 P0 / P1（来源与现状须逐项核实）",
          "",
          staticBlocking.map(issueBlock).join("\n"),
          "",
        ]
      : []),
    ...(staleBlocking.length
      ? [
          `### 陈旧台账（超过 ${staleAfterDays} 天未复验，不计入活跃 P0 / P1）`,
          "",
          staleBlocking
            .map(
              (issue) =>
                `- **${issue.severity} · ${issue.id}** — ${issue.title}（最后复验：${issue.lastSeen || "UNKNOWN"}）`,
            )
            .join("\n"),
          "",
        ]
      : []),
    "## 3. 视觉排版与交互瑕疵（P2 / P3）",
    "",
    cosmetic.length ? cosmetic.map(issueBlock).join("\n") : "未发现运行时 P2 / P3 缺陷。",
    "",
    ...(staticCosmetic.length
      ? [
          "### 台账中尚未关闭的 P2 / P3（来源与现状须逐项核实）",
          "",
          staticCosmetic.map(issueBlock).join("\n"),
          "",
        ]
      : []),
    ...(staleCosmetic.length
      ? [`- 陈旧 P2 / P3：${staleCosmetic.length} 条，不计入活跃瑕疵。`, ""]
      : []),
    "## 4. 测试记忆库更新记录",
    "",
    report.knowledgeBase?.added?.length
      ? report.knowledgeBase.added.map((entry) => `- ${entry}`).join("\n")
      : "- 本次没有新增回归模式。",
    "",
    "## 附：失败用例明细",
    "",
    report.defects.length
      ? report.defects
          .map(
            (issue) =>
              `- [${issue.severity}] ${issue.id} / ${issue.suite} — ${issue.title}${
                issue.location ? ` @ ${issue.location}` : ""
              }`,
          )
          .join("\n")
      : "- 无",
    "",
  ];
  const notes = report.notes || [];
  if (notes.length) {
    lines.push("## 附：环境与执行备注", "", ...notes.map((text) => `- ${text}`), "");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

export function loadKnowledgeBase(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      schema: 1,
      updatedAt: null,
      regressions: [],
      defects: [],
    };
  }
}

export function updateKnowledgeBase(kb, report, options = {}) {
  const added = [];
  const byTest = new Map((kb.regressions || []).map((entry) => [entry.testId, entry]));
  const defectByTest = new Map((kb.defects || []).map((entry) => [entry.testId, entry]));
  // Only close a QA-generated issue when its exact test actually ran and all
  // observations for that ID passed. Static and unexecuted findings stay open.
  const checkResults = new Map();
  for (const check of report.checks || []) {
    const previous = checkResults.get(check.id) ?? true;
    checkResults.set(check.id, previous && check.status === "pass");
  }
  for (const [id, passed] of checkResults) {
    const issue = defectByTest.get(id);
    if (passed && issue?.status === "open" && byTest.get(id)?.source === "qa-run") {
      issue.status = "closed";
      issue.resolvedAt = report.runId;
    }
  }
  for (const defect of report.defects) {
    if (!byTest.has(defect.id)) {
      const regression = {
        id: `REG-${defect.id}`,
        testId: defect.id,
        area: defect.suite,
        trigger: defect.repro || defect.details || defect.title,
        addedAt: new Date().toISOString(),
        source: "qa-run",
      };
      kb.regressions.push(regression);
      byTest.set(defect.id, regression);
      added.push(`新增 ${regression.id}（${defect.title}）`);
    }
    if (!defectByTest.has(defect.id)) {
      const entry = {
        id: defect.id,
        testId: defect.id,
        title: defect.title,
        severity: defect.severity,
        status: "open",
        location: defect.location,
        trigger: defect.repro || defect.details || defect.title,
        expected: defect.expected,
        actual: defect.actual,
        rootCause: defect.rootCause,
        fix: defect.fix,
        firstSeen: report.runId,
        lastSeen: report.runId,
      };
      kb.defects.push(entry);
      defectByTest.set(defect.id, entry);
    } else {
      const entry = defectByTest.get(defect.id);
      entry.lastSeen = report.runId;
      if (byTest.get(defect.id)?.source === "qa-run") entry.status = "open";
      entry.severity = defect.severity;
      entry.location = defect.location || entry.location;
    }
  }
  kb.updatedAt = new Date().toISOString();
  kb.schema = kb.schema || 1;
  kb.regressions = kb.regressions || [];
  kb.defects = kb.defects || [];
  markStaleDefects(kb, options);
  report.knowledgeBase = {
    regressions: kb.regressions.length,
    newRegressions: added.length,
    added,
  };
  return kb;
}
