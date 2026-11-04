/**
 * NON_INTRUSIVE_ENGINEERING §3 / §13 的执行级别分类。
 *
 * 本地全量 QA 会打开可见 Tauri 窗口并通过 WebView2 CDP 控制界面，因此是 L3，
 * 必须先取得用户单独授权。静态 QA 不启动应用，是 L1。托管 CI runner 是 L2。
 * 级别和授权状态会写入 QA JSON/Markdown 报告，避免把未授权或未执行的检查
 * 记成 PASS。
 */

export const E2E_SUITE_IDS = Object.freeze([
  "visual",
  "reader",
  "pdf",
  "online",
  "cache",
  "privacy",
  "chaos",
  "architecture",
]);

const LEVELS = Object.freeze(["L0", "L1", "L2", "L3"]);

function normalizeOverride(env) {
  const raw = String(env.MR_QA_EXECUTION_LEVEL ?? "").trim().toUpperCase();
  if (!raw) return null;
  if (!LEVELS.includes(raw)) {
    throw new Error(
      `MR_QA_EXECUTION_LEVEL 无效：${raw}；只允许 L1/L2/L3（QA 运行不能声明 L0）`,
    );
  }
  if (raw === "L0") {
    throw new Error(
      "MR_QA_EXECUTION_LEVEL=L0 被拒绝：L0 是离线分析，不能用来执行 QA 运行器",
    );
  }
  return raw;
}

export function classifyQaExecution({ e2e, env = process.env, cdpPort = 9334 } = {}) {
  if (typeof e2e !== "boolean") {
    throw new TypeError("classifyQaExecution 需要明确的 e2e 布尔值");
  }
  const override = normalizeOverride(env);

  let level;
  let source;
  if (!e2e) {
    if (override && override !== "L1") {
      throw new Error(
        `static-only QA 只能声明 L1；收到 MR_QA_EXECUTION_LEVEL=${override}`,
      );
    }
    level = "L1";
    source = override ? "MR_QA_EXECUTION_LEVEL" : "static-only";
  } else {
    if (override === "L1") {
      throw new Error(
        "MR_QA_EXECUTION_LEVEL=L1 被拒绝：启动应用与 WebView2 的 QA 至少是 L2",
      );
    }
    if (override) {
      level = override;
      source = "MR_QA_EXECUTION_LEVEL";
    } else if (env.CI === "true") {
      level = "L2";
      source = "CI";
    } else {
      level = "L3";
      source = "local-default";
    }
  }

  const required = level === "L3";
  const granted = !required || env.MR_QA_L3_AUTHORIZED === "1";

  return {
    level,
    backgroundOrInteractive: level === "L3" ? "interactive" : "background",
    authorization: {
      required,
      granted,
      source: required ? "MR_QA_L3_AUTHORIZED" : source,
    },
    rationale:
      level === "L1"
        ? "静态检查不启动应用、不打开窗口、不监听端口"
        : level === "L2"
          ? "在托管 CI 或运维声明的隔离环境中执行，不控制用户桌面"
          : "本地全量 QA 会打开可见 Tauri 窗口并控制 WebView2",
    desktopInteraction:
      level === "L3"
        ? [
            "visible Tauri window",
            "WebView2 CDP automation",
            "visual suite native window positioning",
          ]
        : [],
    processes: e2e
      ? ["vite dev server (127.0.0.1:1420)", "Tauri QA app", "online fixture"]
      : [],
    ports: e2e ? [1420, cdpPort] : [],
    resourceLimits: e2e
      ? "single suite at a time; isolated data directories; cleanup only owned resources"
      : "no app, no listener, no desktop interaction",
    cleanup: e2e ? "pending" : "not-required",
    deferredSuites: e2e ? [] : [...E2E_SUITE_IDS],
  };
}

export function formatAuthorizationError(plan) {
  return [
    "拒绝执行 L3 QA：本地全量 QA 会打开可见 Tauri 窗口并通过 WebView2 CDP 控制界面。",
    "按 NON_INTRUSIVE_ENGINEERING §3，必须先取得用户单独授权，再设置",
    "MR_QA_L3_AUTHORIZED=1 重新运行。",
    "若在专用 VM 或无交互桌面的隔离环境中运行，可显式声明",
    "MR_QA_EXECUTION_LEVEL=L2。",
    `当前级别：${plan.level}；授权：${plan.authorization.granted ? "granted" : "missing"}。`,
  ].join(" ");
}
