/**
 * NON_INTRUSIVE_ENGINEERING §3 / §13 的执行级别分类与授权门。
 *
 * 本地全量 QA 会打开可见 Tauri 窗口并通过 WebView2 CDP 控制界面，因此是 L3，
 * 必须先取得用户单独授权（`MR_QA_L3_AUTHORIZED=1`）。静态 QA 不启动应用、不监听
 * 端口，是 L1；托管 CI runner 没有用户交互桌面，是 L2，必须在工作流里显式声明
 * `MR_QA_EXECUTION_LEVEL=L2`，不能靠推断。
 *
 * 级别、授权来源、创建的进程/端口、清理结果与延后套件都会写入 QA JSON/Markdown
 * 报告，避免把未授权或未执行的检查记成 PASS。
 */

/** 需要拉起隔离应用（而不是只跑静态检查）的套件。run-qa.mjs 直接复用这份清单。 */
export const E2E_SUITE_IDS = Object.freeze([
  "visual",
  "reader",
  "pdf",
  "online",
  "opds",
  "cache",
  "privacy",
  "chaos",
  "architecture",
]);

/** 本地 L3 运行的唯一授权开关：只有值恰好为 "1" 才算授权。 */
export const L3_AUTHORIZATION_ENV = "MR_QA_L3_AUTHORIZED";
/** 运维显式声明执行环境（托管 CI 或专用隔离环境）的覆盖项。 */
export const EXECUTION_LEVEL_ENV = "MR_QA_EXECUTION_LEVEL";

const LEVELS = Object.freeze(["L0", "L1", "L2", "L3"]);

function normalizeOverride(env) {
  const raw = String(env[EXECUTION_LEVEL_ENV] ?? "").trim().toUpperCase();
  if (!raw) return null;
  if (!LEVELS.includes(raw)) {
    throw new Error(
      `${EXECUTION_LEVEL_ENV} 无效：${raw}；只允许 L1/L2/L3（QA 运行器不能声明 L0）`,
    );
  }
  if (raw === "L0") {
    throw new Error(
      `${EXECUTION_LEVEL_ENV}=L0 被拒绝：L0 是离线分析，不能用来执行 QA 运行器`,
    );
  }
  return raw;
}

/**
 * 把一次 QA 运行分类成 L0–L3，并给出是否已获授权。
 *
 * - `e2e: false`（只跑 static）→ L1，后台 CLI，无需授权。
 * - `e2e: true` 且 `CI=true` 或显式 `MR_QA_EXECUTION_LEVEL=L2` → L2，后台，无需授权。
 * - `e2e: true` 的本地默认 → L3，必须 `MR_QA_L3_AUTHORIZED=1`，否则拒绝。
 *
 * 非法或自相矛盾的声明一律 fail-closed 抛错，不静默降级。
 */
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
        `static-only QA 只能声明 L1；收到 ${EXECUTION_LEVEL_ENV}=${override}`,
      );
    }
    level = "L1";
    source = override ? EXECUTION_LEVEL_ENV : "static-only";
  } else if (override === "L1") {
    throw new Error(
      `${EXECUTION_LEVEL_ENV}=L1 被拒绝：启动应用与 WebView2 的 QA 至少是 L2`,
    );
  } else if (override) {
    level = override;
    source = EXECUTION_LEVEL_ENV;
  } else if (env.CI === "true") {
    level = "L2";
    source = "CI";
  } else {
    level = "L3";
    source = "local-default";
  }

  const required = level === "L3";
  const granted = !required || env[L3_AUTHORIZATION_ENV] === "1";

  return {
    level,
    backgroundOrInteractive: level === "L3" ? "interactive" : "background",
    authorization: {
      required,
      granted,
      source: required ? L3_AUTHORIZATION_ENV : source,
    },
    rationale:
      level === "L1"
        ? "静态检查不启动应用、不打开窗口、不监听端口"
        : level === "L2"
          ? "在托管 CI 或运维显式声明的隔离环境中执行，不控制用户桌面"
          : "本地全量 QA 会打开可见 Tauri 窗口并通过 CDP 控制 WebView2",
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

/** 未授权时的拒绝文案：必须说明缺哪个开关、以及 L2 的合法出路。 */
export function formatAuthorizationError(plan) {
  return [
    "拒绝执行 L3 QA：本地全量 QA 会打开可见 Tauri 窗口并通过 WebView2 CDP 控制界面。",
    "按 NON_INTRUSIVE_ENGINEERING §3，必须先取得用户单独授权，再设置",
    `${L3_AUTHORIZATION_ENV}=1 重新运行。`,
    "若在专用 VM 或无交互桌面的隔离环境中运行，可显式声明",
    `${EXECUTION_LEVEL_ENV}=L2。`,
    `当前级别：${plan.level}；授权：${plan.authorization.granted ? "granted" : "missing"}。`,
  ].join(" ");
}
