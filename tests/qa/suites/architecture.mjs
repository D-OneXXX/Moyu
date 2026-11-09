/**
 * 架构宪法 / 盲区防御回归（AGENTS.md §2 / §3 / §4.2 / §4.4）。
 *
 * 覆盖：
 *  A. §2.1 废弃路由静默重定向（未匹配路由不得白屏、不得留残 URL）；
 *  B. §2.2 本地持久化状态清洗（脏 localStorage 不得白屏，且不得误删主题/语言）；
 *  D. §4.4 全局快捷键输入态隔离（输入框内按键不得翻页/切页签/切模式）；
 *  E. §4.2 超高条漫（巨图先切后缩 + 单页渲染高度钳制 ≤ 8192）。
 *
 * 全部走隔离数据目录与本地 stub，不触碰真实用户数据、不访问真实外网。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { invokeSafe } from "../lib/app.mjs";
import { fail, note, ok } from "../lib/report.mjs";

/** data URL 指纹：只留 hash，绝不把图片字节写进报告。 */
function dataUrlHash(dataUrl) {
  return createHash("sha256")
    .update(String(dataUrl || ""))
    .digest("hex")
    .slice(0, 16);
}

/** 已下线 / 历史路径：必须静默 replace 回书库首页 "#/"。 */
const LEGACY_ROUTES = [
  "#/translator",
  "#/glossary",
  "#/status",
  "#/data",
  "#/ocr",
  "#/workbench",
  "#/library",
  "#/完全乱码路径",
];

/** 阅读器页码标签（[data-reader-hud] 里的 "n/total"）。 */
const PAGE_COUNTER = `(() => {
  for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (/^\\d+\\s*\\/\\s*\\d+$/.test(text)) return text;
  }
  return null;
})()`;

function pageNumberFromLabel(label) {
  const match = String(label || "").match(/(\d+)\s*\/\s*(\d+)/);
  return match ? { page: Number(match[1]), total: Number(match[2]) } : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 浏览器内可见性判定片段（复用同一套规则，避免隐藏节点误报）。 */
const VISIBLE_FN = `(el) => {
  if (!el) return false;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
}`;

/** 订阅未捕获异常与 console.error；返回 { errors, consoleErrors, stop }。 */
function watchPageErrors(page) {
  const errors = [];
  const consoleErrors = [];
  const offException = page.on("Runtime.exceptionThrown", (params) => {
    const details = params?.exceptionDetails;
    errors.push(
      details?.exception?.description ||
        details?.text ||
        JSON.stringify(params ?? {}).slice(0, 400),
    );
  });
  const offConsole = page.on("Runtime.consoleAPICalled", (params) => {
    if (params?.type !== "error") return;
    const text = (params.args || [])
      .map((arg) => arg?.value ?? arg?.description ?? arg?.type)
      .join(" ");
    consoleErrors.push(String(text).slice(0, 400));
  });
  return {
    errors,
    consoleErrors,
    stop() {
      offException();
      offConsole();
    },
  };
}

/* ------------------------------------------------------------------ */
/* A. 废弃路由静默重定向                                             */
/* ------------------------------------------------------------------ */
async function checkLegacyRoutes(ctx, report) {
  const page = ctx.page;
  const watcher = watchPageErrors(page);
  const results = [];

  for (const route of LEGACY_ROUTES) {
    const errorMark = watcher.errors.length;
    const consoleMark = watcher.consoleErrors.length;
    let redirected = false;
    try {
      await page.callFunction(
        "function(route) { location.hash = route; return location.hash; }",
        [route],
      );
      await page.waitFor('location.hash === "#/"', {
        timeout: 8000,
        label: `redirect ${route}`,
      });
      redirected = true;
      // 重定向后必须真的渲染出书库主区域（而不是短暂命中后再白屏）。
      await page.waitFor('!!document.getElementById("library-search-input")', {
        timeout: 8000,
        label: `library after ${route}`,
      });
    } catch {
      redirected = false;
    }
    const state = await page.eval(`(() => {
      const main = document.querySelector("main");
      return {
        hash: location.hash,
        hasMain: !!main,
        mainText: (main?.textContent || "").trim().length,
        mainHtml: (main?.innerHTML || "").trim().length,
        hasLibrarySearch: !!document.getElementById("library-search-input"),
        readerMounted: !!document.querySelector(".reader-root"),
        bodyText: (document.body?.textContent || "").trim().length,
      };
    })()`);
    results.push({
      route,
      redirected,
      ...state,
      exceptions: watcher.errors.slice(errorMark),
      consoleErrors: watcher.consoleErrors.slice(consoleMark),
    });
  }
  watcher.stop();

  const broken = results.filter(
    (item) =>
      !item.redirected ||
      item.hash !== "#/" ||
      !item.hasMain ||
      item.mainText === 0 ||
      item.mainHtml === 0 ||
      !item.hasLibrarySearch ||
      item.exceptions.length > 0 ||
      item.consoleErrors.length > 0,
  );

  if (broken.length) {
    fail(report, {
      id: "arch:legacy-route-redirect",
      suite: "architecture",
      layer: "e2e",
      title: "废弃路由未静默重定向回书库首页（或出现未捕获错误）",
      severity: "P1",
      details: JSON.stringify(broken, null, 2),
      location: "src/App.tsx / src/components/shell/AppShell.tsx",
      expected: LEGACY_ROUTES.map((route) => `${route} → #/`).join("；"),
      actual: broken
        .map(
          (item) =>
            `${item.route} → hash=${item.hash} main=${item.hasMain} text=${item.mainText} lib=${item.hasLibrarySearch} exc=${item.exceptions.length} console=${item.consoleErrors.length}`,
        )
        .join(" | "),
      rootCause:
        "路由白名单 / 通配兜底缺失，废弃深链落到未匹配路由（白屏）或抛未捕获异常",
      fix: "两套路由表都补 <Route path=\"*\" element={<Navigate to=\"/\" replace />} />，并确认废弃路径命中白名单兜底",
    });
  } else {
    ok(report, {
      id: "arch:legacy-route-redirect",
      suite: "architecture",
      layer: "e2e",
      title: "废弃路由静默重定向回书库首页（无未捕获错误、无白屏）",
      details: `${results.length} 条废弃路径全部 → #/，书库主区域非空`,
    });
  }

  await ctx.goto("#/");
  return results;
}

/* ------------------------------------------------------------------ */
/* B. 本地持久化状态清洗                                             */
/* ------------------------------------------------------------------ */
const STORAGE_PROBE = `(() => {
  const api = window.__mrStorageSanitizer;
  if (!api) return { ok: false, reason: "window.__mrStorageSanitizer 未挂载" };
  function makeStorage(seed) {
    const map = new Map(Object.entries(seed));
    return {
      get length() { return map.size; },
      key(i) { return Array.from(map.keys())[i] ?? null; },
      getItem(k) { return map.has(k) ? map.get(k) : null; },
      setItem(k, v) { map.set(k, String(v)); },
      removeItem(k) { map.delete(k); },
      dump() { return Object.fromEntries(map); },
    };
  }
  const dirtySeed = {
    "mr-theme": "dark-blue",
    "mr-locale": "xx-XX",
    "mr-exp-wt": "2",
    "mr-glossary-queue": "[1,2,3]",
    "mr-ocr-page-1": "{\\"a\\":1}",
    "mr-translator-job": "{\\"b\\":2}",
    "mr-update-prefs": "{坏 json",
    "mr-unknown-legacy": "1",
    "mr-sidecar-status": "ok",
  };
  const dirty = makeStorage(dirtySeed);
  const issues = api.collectStorageIssues(dirty);
  const summary = api.sanitizeStorage(dirty);
  const afterFirst = dirty.dump();
  const second = api.sanitizeStorage(dirty);
  const afterSecond = dirty.dump();

  const good = makeStorage({
    "mr-theme": "light",
    "mr-locale": "ja",
    "mr-reader-mode": "single",
    "mr-reader-dir": "ltr",
    "mr-privacy-ack": "2026-10:0",
  });
  const goodSummary = api.sanitizeStorage(good);
  const afterGood = good.dump();

  const lastReport = api.getLastSanitizeReport();
  return {
    ok: true,
    issues,
    summary,
    afterFirst,
    second,
    afterSecond,
    goodSummary,
    afterGood,
    lastReport,
    realTheme: localStorage.getItem("mr-theme"),
    realLocale: localStorage.getItem("mr-locale"),
    deprecatedPrefixes: api.DEPRECATED_PREFIXES,
    knownKeys: api.KNOWN_KEYS,
  };
})()`;

async function checkStorageSanitizer(ctx, report) {
  const page = ctx.page;
  let probe;
  try {
    probe = await page.eval(STORAGE_PROBE);
  } catch (error) {
    fail(report, {
      id: "arch:storage-sanitizer",
      suite: "architecture",
      layer: "e2e",
      title: "存储清洗 QA 入口不可用",
      severity: "P1",
      details: String(error),
      location: "src/lib/storageSanitizer.ts / src/main.tsx",
      rootCause: "window.__mrStorageSanitizer 未在挂载前安装",
      fix: "在 main.tsx 挂载前调用 installStorageSanitizerApi()",
    });
    return null;
  }

  if (!probe?.ok) {
    fail(report, {
      id: "arch:storage-sanitizer",
      suite: "architecture",
      layer: "e2e",
      title: "存储清洗 QA 入口不可用",
      severity: "P1",
      details: JSON.stringify(probe),
      location: "src/lib/storageSanitizer.ts / src/main.tsx",
      rootCause: "window.__mrStorageSanitizer 未在挂载前安装",
      fix: "在 main.tsx 挂载前调用 installStorageSanitizerApi()",
    });
    return null;
  }

  const dirtyKeys = [
    "mr-theme",
    "mr-locale",
    "mr-exp-wt",
    "mr-glossary-queue",
    "mr-ocr-page-1",
    "mr-translator-job",
    "mr-update-prefs",
    "mr-unknown-legacy",
    "mr-sidecar-status",
  ];
  const problems = [];

  // 1) 脏键必须全部被删。
  const notRemoved = dirtyKeys.filter(
    (key) => !probe.summary.removed.includes(key),
  );
  if (notRemoved.length) problems.push(`未被删除: ${notRemoved.join(", ")}`);
  const stillPresent = dirtyKeys.filter(
    (key) => Object.prototype.hasOwnProperty.call(probe.afterFirst, key),
  );
  if (stillPresent.length) problems.push(`仍残留于 storage: ${stillPresent.join(", ")}`);

  // 2) 合法键（主题 / 语言）绝不能被误删。
  if (probe.afterGood["mr-theme"] !== "light") {
    problems.push(`mr-theme 被误删/篡改: ${String(probe.afterGood["mr-theme"])}`);
  }
  if (probe.afterGood["mr-locale"] !== "ja") {
    problems.push(`mr-locale 被误删/篡改: ${String(probe.afterGood["mr-locale"])}`);
  }
  if (probe.goodSummary.removed.length > 0) {
    problems.push(`合法键被删: ${probe.goodSummary.removed.join(", ")}`);
  }
  if (probe.goodSummary.repaired.length > 0) {
    problems.push(`合法键被改写: ${probe.goodSummary.repaired.join(", ")}`);
  }
  if (probe.goodSummary.kept !== Object.keys(probe.afterGood).length) {
    problems.push(
      `kept 计数不符: kept=${probe.goodSummary.kept} 实际保留=${Object.keys(probe.afterGood).length}`,
    );
  }
  if (!["system", "light", "dark"].includes(String(probe.realTheme))) {
    problems.push(`真实 localStorage 主题被破坏: ${String(probe.realTheme)}`);
  }
  if (!["zh-CN", "zh-TW", "en", "es", "ja", "ko"].includes(String(probe.realLocale))) {
    problems.push(`真实 localStorage 语言被破坏: ${String(probe.realLocale)}`);
  }

  // 3) 幂等：第二次清洗必须 0 删除 0 修改。
  if (probe.second.removed.length > 0) {
    problems.push(`第二次清洗仍删除: ${probe.second.removed.join(", ")}`);
  }
  if (probe.second.repaired.length > 0) {
    problems.push(`第二次清洗仍改写: ${probe.second.repaired.join(", ")}`);
  }
  if (JSON.stringify(probe.afterFirst) !== JSON.stringify(probe.afterSecond)) {
    problems.push("两次清洗结果不一致（不幂等）");
  }

  // 4) 问题清单必须覆盖全部脏键。
  const issueKeys = probe.issues.map((issue) => issue.key);
  const missed = dirtyKeys.filter((key) => !issueKeys.includes(key));
  if (missed.length) problems.push(`collectStorageIssues 漏报: ${missed.join(", ")}`);

  // 5) 启动期清洗报告必须存在且形状正确。
  if (!probe.lastReport || typeof probe.lastReport.removedCount !== "number") {
    problems.push("getLastSanitizeReport() 未返回有效报告");
  }

  if (problems.length) {
    fail(report, {
      id: "arch:storage-sanitizer",
      suite: "architecture",
      layer: "e2e",
      title: "本地持久化状态清洗不完整或误删合法键",
      severity: "P1",
      details: problems.join(" | "),
      location: "src/lib/storageSanitizer.ts / src/main.tsx",
      expected:
        "废弃前缀键/非法枚举/坏 JSON/未知键全部删除；mr-theme=light 与 mr-locale=ja 必须保留；重复清洗 0 删除 0 修改",
      actual: problems.join(" | "),
      rootCause: "清洗规则表未覆盖废弃前缀，或白名单缺项导致合法键被删",
      fix: "补齐 DEPRECATED_KEY_PREFIXES 与 KEY_RULES；禁止对白名单键做删除",
    });
  } else {
    ok(report, {
      id: "arch:storage-sanitizer",
      suite: "architecture",
      layer: "e2e",
      title: "脏 localStorage 被清洗且合法主题/语言未被误删（幂等）",
      details: `删 ${probe.summary.removed.length} 键 / 保留 ${probe.goodSummary.kept} 合法键 / 二次清洗 0 变更`,
    });
  }
  return probe;
}

/* ------------------------------------------------------------------ */
/* D. 全局快捷键输入态隔离                                           */
/* ------------------------------------------------------------------ */
async function checkShortcutIsolation(ctx, report) {
  const page = ctx.page;
  const local = ctx.books.find((book) => book.title.includes("QA Local Folder"));
  if (!local) {
    fail(report, {
      id: "arch:shortcut-input-isolation",
      suite: "architecture",
      layer: "e2e",
      title: "缺少多页夹具，无法验证快捷键输入态隔离",
      severity: "P1",
      details: "QA Local Folder 未入库",
      location: "tests/qa/lib/fixtures.mjs",
    });
    return;
  }

  /* --- D0：先开一个阅读页签，给 Ctrl+数字 快捷键一个真实目标 --- */
  await ctx.goto(`#/reader/${encodeURIComponent(local.id)}`);
  await page.waitFor("!!document.querySelector('.reader-img')", {
    timeout: 15_000,
    label: "reader for tab",
  });
  await sleep(300);
  await ctx.goto("#/");

  /* --- D1：书库搜索框内按键不得触发全局动作 --- */
  const before = await invokeSafe(page, "list_books", { query: null });
  const focused = await page.eval(`(() => {
    const input = document.getElementById("library-search-input");
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  })()`);

  const steps = [];
  const snapshot = () =>
    page.eval(`(() => {
      const input = document.getElementById("library-search-input");
      return {
        activeId: document.activeElement?.id || "",
        value: input ? input.value : null,
        hash: location.hash,
        readerMounted: !!document.querySelector(".reader-root"),
        readerImages: document.querySelectorAll(".reader-img").length,
        doubleMode: !!document.querySelector(".reader-double"),
        webtoonMode: !!document.querySelector(".webtoon-scroll"),
        librarySearch: !!input,
      };
    })()`);
  const press = async (key, options) => {
    await page.key(key, options);
    await sleep(320);
    return snapshot();
  };

  if (!focused) {
    steps.push({ key: "focus", state: { activeId: "", value: null } });
  } else {
    steps.push({ key: "focus", state: { activeId: "library-search-input" } });
    steps.push({ key: "Space", state: await press(" ") });
    steps.push({ key: "ArrowRight", state: await press("ArrowRight") });
    steps.push({ key: "m", state: await press("m") });
    // 强守卫探针：Ctrl+2 是「切到第 1 个阅读页签」快捷键。
    // 若输入态豁免失效，焦点在搜索框时也会切页签（hash 变 #/reader/...）。
    steps.push({ key: "Ctrl+2", state: await press("2", { modifiers: 2 }) });
  }

  const after = await invokeSafe(page, "list_books", { query: null });
  const progressBefore = (before.value || []).map((b) => `${b.id}:${b.currentPage}`);
  const progressAfter = (after.value || []).map((b) => `${b.id}:${b.currentPage}`);

  const d1Problems = [];
  if (!focused) d1Problems.push("书库搜索框 #library-search-input 不存在或无法聚焦");
  for (const step of steps.filter((s) => s.key !== "focus")) {
    const state = step.state || {};
    if (state.activeId !== "library-search-input") {
      d1Problems.push(`${step.key}: 焦点丢失（activeElement=${state.activeId}）`);
    }
    if (state.hash !== "#/") {
      d1Problems.push(`${step.key}: 发生导航/切页签（hash=${state.hash}）`);
    }
    if (state.readerMounted || state.readerImages > 0) {
      d1Problems.push(`${step.key}: 误开阅读器（reader=${state.readerMounted}）`);
    }
    if (state.doubleMode || state.webtoonMode) {
      d1Problems.push(`${step.key}: 误切阅读模式（double=${state.doubleMode} webtoon=${state.webtoonMode}）`);
    }
  }
  // 空格必须真的落到输入框里（证明事件未被全局处理器吞掉）。
  const spaceStep = steps.find((s) => s.key === "Space");
  if (spaceStep && !String(spaceStep.state?.value ?? "").includes(" ")) {
    d1Problems.push(
      `Space 未写入搜索框（value=${JSON.stringify(spaceStep.state?.value)}）`,
    );
  }
  const mStep = steps.find((s) => s.key === "m");
  if (mStep && !String(mStep.state?.value ?? "").includes("m")) {
    d1Problems.push(`m 未写入搜索框（value=${JSON.stringify(mStep.state?.value)}）`);
  }
  if (JSON.stringify(progressBefore) !== JSON.stringify(progressAfter)) {
    d1Problems.push(
      `阅读进度发生变化（${progressBefore.join(",")} → ${progressAfter.join(",")}）`,
    );
  }

  /* --- D2：阅读器画布上 Space 必须正常翻页 --- */
  await ctx.goto(`#/reader/${encodeURIComponent(local.id)}`);
  await page.waitFor("!!document.querySelector('.reader-img')", {
    timeout: 15_000,
    label: "reader canvas",
  });
  await sleep(500);
  const beforeLabel = await page.eval(PAGE_COUNTER);
  const beforePage = pageNumberFromLabel(beforeLabel);
  await page.eval(`(() => {
    document.activeElement?.blur?.();
    document.body.focus?.();
    return true;
  })()`);
  await page.key(" ");
  await sleep(600);
  const afterLabel = await page.eval(PAGE_COUNTER);
  const afterPage = pageNumberFromLabel(afterLabel);

  const d2Problems = [];
  // 版式决定一次 Space 前进几页：单页 +1，双页 +2（跨页时同样成立）。
  // 这里按**当前实际渲染的页数**推断期望值，避免被上一个套件留下的双页版式误判。
  const spreadCount = await page.eval(
    "document.querySelectorAll('.reader-img').length",
  );
  const expectedDelta = Number(spreadCount) >= 2 ? 2 : 1;
  if (!beforePage || !afterPage) {
    d2Problems.push(`页码标签缺失: ${beforeLabel} → ${afterLabel}`);
  } else if (!(afterPage.page === beforePage.page + expectedDelta)) {
    d2Problems.push(
      `Space 未按预期翻页: ${beforeLabel} → ${afterLabel}（期望 +${expectedDelta}，同屏 ${spreadCount} 页）`,
    );
  }

  /* --- D3：阅读器内聚焦可编辑元素时，Space 必须被守卫拦下（不得翻页） --- */
  const guardBeforeLabel = await page.eval(PAGE_COUNTER);
  const guardBefore = pageNumberFromLabel(guardBeforeLabel);
  await page.eval(`(() => {
    let probe = document.getElementById("qa-guard-input");
    if (!probe) {
      probe = document.createElement("input");
      probe.id = "qa-guard-input";
      probe.type = "text";
      probe.style.position = "fixed";
      probe.style.left = "8px";
      probe.style.top = "8px";
      probe.style.zIndex = "9999";
      document.body.appendChild(probe);
    }
    probe.focus();
    return document.activeElement === probe;
  })()`);
  await page.key(" ");
  await sleep(600);
  const guardAfterLabel = await page.eval(PAGE_COUNTER);
  const guardAfter = pageNumberFromLabel(guardAfterLabel);
  const guardProbeValue = await page.eval(
    `document.getElementById("qa-guard-input")?.value ?? null`,
  );
  await page.eval(`(() => {
    document.getElementById("qa-guard-input")?.remove();
    document.activeElement?.blur?.();
    document.body.focus?.();
    return true;
  })()`);

  const d3Problems = [];
  if (!guardBefore || !guardAfter) {
    d3Problems.push(`页码标签缺失: ${guardBeforeLabel} → ${guardAfterLabel}`);
  } else if (guardAfter.page !== guardBefore.page) {
    d3Problems.push(
      `输入态未隔离：焦点在输入框时 Space 仍翻页（${guardBeforeLabel} → ${guardAfterLabel}）`,
    );
  }
  if (!String(guardProbeValue ?? "").includes(" ")) {
    d3Problems.push(
      `Space 未写入输入框（守卫吞掉了原生输入，value=${JSON.stringify(guardProbeValue)}）`,
    );
  }

  await ctx.goto("#/");

  if (d1Problems.length || d2Problems.length || d3Problems.length) {
    fail(report, {
      id: "arch:shortcut-input-isolation",
      suite: "architecture",
      layer: "e2e",
      title: "全局快捷键未做输入态隔离（输入框内误触发）或画布翻页失效",
      severity: "P1",
      details: JSON.stringify(
        { steps, d1Problems, d2Problems, d3Problems },
        null,
        2,
      ),
      location: "src/features/shortcuts/useGlobalShortcuts.ts / src/pages/Reader.tsx / src/components/shell/AppShell.tsx",
      expected:
        "搜索框内 Space/ArrowRight/m/Ctrl+2 不翻页、不切页签、不切模式、焦点不丢；阅读器画布 Space 正常翻页；阅读器内聚焦输入框时 Space 被守卫拦下",
      actual: [...d1Problems, ...d2Problems, ...d3Problems].join(" | "),
      rootCause:
        "快捷键处理器未走统一守卫（未检查 isEditableTarget / isImeComposing），或翻页键位被输入态误吞",
      fix: "全部快捷键改走 useGlobalShortcuts，并先判 isImeComposing → isEditableTarget",
    });
  } else {
    ok(report, {
      id: "arch:shortcut-input-isolation",
      suite: "architecture",
      layer: "e2e",
      title: "输入框内按键被隔离（不翻页/不切页签），阅读器画布 Space 正常翻页",
      details: `搜索框值=${JSON.stringify(mStep?.state?.value)}；画布 ${beforeLabel} → ${afterLabel}；输入态 ${guardBeforeLabel} → ${guardAfterLabel}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* E. 超高条漫（巨图防线）                                           */
/* ------------------------------------------------------------------ */
async function checkUltraTallWebtoon(ctx, report) {
  const page = ctx.page;
  const tall = ctx.books.find((book) => book.title.includes("QA Ultra Tall"));
  const expected = ctx.fixtures.expected;
  if (!tall) {
    fail(report, {
      id: "arch:ultra-tall-webtoon",
      suite: "architecture",
      layer: "e2e",
      title: "超高条漫夹具未入库，无法验证巨图防线",
      severity: "P1",
      details: "QA Ultra Tall Webtoon missing from list_books",
      location: "tests/qa/lib/fixtures.mjs",
    });
    return;
  }

  const problems = [];
  const evidence = { bookId: tall.id, title: tall.title };

  /* 1) 布局：源图尺寸必须是 800×21000（>8192 且能触发多片）。 */
  const layout = await invokeSafe(page, "get_webtoon_layout", { bookId: tall.id });
  evidence.layout = layout.ok ? layout.value : layout.error;
  if (!layout.ok || !Array.isArray(layout.value) || layout.value.length === 0) {
    problems.push("get_webtoon_layout 失败");
  } else {
    const first = layout.value[0];
    evidence.layoutFirst = first;
    if (Number(first.height) !== expected.ultraTallHeight) {
      problems.push(`源高 ${first.height} ≠ 夹具 ${expected.ultraTallHeight}`);
    }
    if (Number(first.height) <= 8192) {
      problems.push(`源高 ${first.height} 未超过 8192 纹理安全线`);
    }
  }

  /* 2) 单页模式：渲染高度必须被钳制到 ≤ MAX_SAFE_TEXTURE_H(8192)。 */
  const single = await invokeSafe(page, "get_page", {
    bookId: tall.id,
    index: 0,
    maxWidth: null,
    maxHeight: null,
  });
  evidence.single = single.ok
    ? {
        width: single.value?.width,
        height: single.value?.height,
        origWidth: single.value?.origWidth,
        origHeight: single.value?.origHeight,
      }
    : { error: single.error };
  if (!single.ok) {
    problems.push(`get_page 失败: ${single.error}`);
  } else {
    const height = Number(single.value?.height ?? 0);
    const origHeight = Number(single.value?.origHeight ?? 0);
    if (!(height > 0)) problems.push("get_page 返回高度为 0");
    if (!(height <= 8192)) {
      problems.push(`单页渲染高度 ${height} 超过纹理安全上限 8192`);
    }
    if (origHeight !== expected.ultraTallHeight) {
      problems.push(`单页 origHeight ${origHeight} ≠ 源高 ${expected.ultraTallHeight}`);
    }
  }

  /* 3) 条漫切片：必须切出多片，且每片高度 ≤ WEBTOON_TILE_H(2048)。 */
  const tiles = [];
  for (const tile of [0, 1]) {
    const result = await invokeSafe(page, "get_webtoon_tile", {
      bookId: tall.id,
      index: 0,
      tile,
      maxWidth: expected.ultraTallWidth,
    });
    tiles.push({
      tile,
      ok: result.ok,
      height: result.ok ? Number(result.value?.height ?? 0) : null,
      width: result.ok ? Number(result.value?.width ?? 0) : null,
      // 指纹用于证明「不同切片的内容确实不同」（纯色夹具会让这里恒等）。
      dataUrlHash: result.ok ? dataUrlHash(result.value?.dataUrl) : null,
      dataUrlLength: result.ok ? String(result.value?.dataUrl ?? "").length : null,
      error: result.ok ? null : result.error,
    });
  }
  evidence.tiles = tiles;
  if (!tiles[0].ok) problems.push(`切片 0 失败: ${tiles[0].error}`);
  if (!tiles[1].ok) problems.push(`切片 1 失败（巨图未被切成多片）: ${tiles[1].error}`);
  for (const item of tiles) {
    if (item.ok && item.height > 2048) {
      problems.push(`切片 ${item.tile} 高度 ${item.height} 超过 WEBTOON_TILE_H(2048)`);
    }
  }
  // 同一渲染宽度下，不同切片号必须返回**不同内容**：
  // 这条断言直接证明「巨图被切成多片」而不是「同一张图被重复渲染」。
  if (tiles[0].ok && tiles[1].ok && tiles[0].dataUrlHash === tiles[1].dataUrlHash) {
    problems.push(
      `切片 0 与切片 1 内容完全相同（hash=${tiles[0].dataUrlHash}）：巨图未被真正切分`,
    );
  }
  const outOfRange = await invokeSafe(page, "get_webtoon_tile", {
    bookId: tall.id,
    index: 0,
    tile: 999,
    maxWidth: expected.ultraTallWidth,
  });
  evidence.outOfRange = outOfRange.ok ? "unexpected success" : "rejected";
  if (outOfRange.ok) problems.push("越界切片号 999 竟然返回成功");

  /* 4) 前端条漫渲染：切片节点存在、图片 naturalWidth > 0（无黑块/白屏）。 */
  await page.eval(
    `(() => { localStorage.setItem("mr-wt-${tall.id}", "webtoon"); return true; })()`,
  );
  await ctx.goto(`#/reader/${encodeURIComponent(tall.id)}`);
  await page.waitFor("!!document.querySelector('.webtoon-stage')", {
    timeout: 25_000,
    label: "ultra tall webtoon stage",
  });
  await page.waitFor("!!document.querySelector('.webtoon-tile img')", {
    timeout: 25_000,
    label: "ultra tall webtoon tile",
  });
  await sleep(1200);

  // 诊断探针（仅测试侧记录，不改变产品行为与断言）：
  // hosted windows-2022 上出现「滚动已到底、DOM 却只有 1 张切片」，
  // 必须区分是 rAF/窗口同步停摆、切片请求未完成，还是 DOM 只更新了占位。
  const readSnapshot = () =>
    page.eval(`(() => {
      const scroller = document.querySelector(".webtoon-scroll");
      const hash = (src) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < src.length; i += 257) {
          h = Math.imul(h ^ src.charCodeAt(i), 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, "0");
      };
      const tileNodes = [...document.querySelectorAll(".webtoon-tile")];
      const imgs = [...document.querySelectorAll(".webtoon-tile img")];
      return {
        tiles: tileNodes.length,
        tileDetail: tileNodes.map((el) => {
          const img = el.querySelector("img");
          const rect = el.getBoundingClientRect();
          return {
            key: el.getAttribute("data-key"),
            styleTop: el.style.top,
            styleHeight: el.style.height,
            rectTop: Math.round(rect.top),
            rectHeight: Math.round(rect.height),
            hasImg: !!img,
            srcHash: img ? hash(img.src) : null,
            srcLength: img ? img.src.length : 0,
            complete: img ? img.complete : null,
            naturalWidth: img ? img.naturalWidth : null,
          };
        }),
        images: imgs.length,
        broken: imgs.filter((img) => !(img.complete && img.naturalWidth > 0)).length,
        // 用完整 data URL 去重：JPEG/PNG 的前 64 字符是相同头部，
        // 截断会把不同切片误判成同一张。
        srcs: imgs.map((img) => img.src),
        scrollTop: scroller ? scroller.scrollTop : 0,
        scrollHeight: scroller ? scroller.scrollHeight : 0,
        clientHeight: scroller ? scroller.clientHeight : 0,
        probe: window.__qaWt
          ? {
              scrollEvents: window.__qaWt.scrollEvents,
              rafTicks: window.__qaWt.rafTicks,
              elapsedMs: Math.round(performance.now() - window.__qaWt.startedAt),
            }
          : null,
        visibility: document.visibilityState,
        hidden: document.hidden,
        hasFocus: document.hasFocus(),
      };
    })()`);

  const envBefore = await page.eval(`(() => {
    const scroller = document.querySelector(".webtoon-scroll");
    window.__qaWt = { scrollEvents: 0, rafTicks: 0, startedAt: performance.now() };
    if (scroller) {
      scroller.addEventListener(
        "scroll",
        () => { window.__qaWt.scrollEvents += 1; },
        { capture: true, passive: true },
      );
    }
    const tick = () => {
      if (!window.__qaWt) return;
      window.__qaWt.rafTicks += 1;
      if (window.__qaWt.rafTicks < 200000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return {
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scroller: scroller
        ? {
            clientWidth: scroller.clientWidth,
            clientHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight,
            scrollTop: scroller.scrollTop,
          }
        : null,
      tiles: [...document.querySelectorAll(".webtoon-tile")].map((el) => ({
        key: el.getAttribute("data-key"),
        hasImg: !!el.querySelector("img"),
      })),
    };
  })()`);

  const seen = new Set();
  const seenHashes = new Set();
  const seenKeys = new Set();
  let brokenImages = 0;
  let totalTiles = 0;
  let scrollSteps = 0;
  let lastSnapshot = null;
  // CI 的 WebView2/图片解码明显慢于开发机：固定 sleep 会在第二片解码前
  // 就断言，造成假阴性。持续滚动并等待至少两片真正解码，超时仍按失败处理。
  const tileDeadline = Date.now() + 30_000;
  for (let index = 0; index < 40 && Date.now() < tileDeadline; index += 1) {
    const snapshot = await readSnapshot();
    lastSnapshot = snapshot;
    scrollSteps = index + 1;
    totalTiles = Math.max(totalTiles, snapshot.tiles);
    brokenImages = Math.max(brokenImages, snapshot.broken);
    for (const src of snapshot.srcs) seen.add(src);
    for (const tile of snapshot.tileDetail) {
      if (tile.srcHash) seenHashes.add(tile.srcHash);
      if (tile.key) seenKeys.add(tile.key);
    }
    if (seen.size >= 2 && brokenImages === 0) break;
    await page.eval(`(() => {
      const scroller = document.querySelector(".webtoon-scroll");
      if (!scroller) return false;
      scroller.scrollTop = Math.min(
        scroller.scrollHeight - scroller.clientHeight,
        scroller.scrollTop + Math.max(200, (scroller.scrollHeight - scroller.clientHeight) / 20),
      );
      // WebView2 在程序化 scrollTop 后偶发不派发 scroll；显式补一次，
      // 仍由真实滚动位置与图片解码断言，不改变产品行为。
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    })()`);
    await sleep(800);
  }

  // data URL 体积很大，报告只保留 hash/长度（完整 src 只用于去重）。
  const { srcs: _discardedSrcs, ...finalForEvidence } = lastSnapshot ?? {};

  const screenshotPath = path.join(
    ctx.artifactDir,
    "screens",
    `arch-ultra-tall-webtoon-${report.runId}.png`,
  );
  try {
    await page.screenshot(screenshotPath);
  } catch {
    /* 截图失败不影响断言结果 */
  }

  evidence.ui = {
    maxTilesInDom: totalTiles,
    distinctTileImages: seen.size,
    distinctTileHashes: seenHashes.size,
    distinctTileKeys: [...seenKeys],
    brokenImages,
    scrollSteps,
    images: finalForEvidence.images ?? 0,
    scrollTop: finalForEvidence.scrollTop ?? 0,
    scrollHeight: finalForEvidence.scrollHeight ?? 0,
    clientHeight: finalForEvidence.clientHeight ?? 0,
    envBefore,
    finalSnapshot: finalForEvidence,
    screenshot: screenshotPath,
  };

  if (totalTiles < 1) problems.push("条漫 DOM 未渲染任何切片节点（.webtoon-tile）");
  // 切片号必须真的推进过：只渲染一张切片不算「切成多片」。
  if (seenKeys.size < 2) {
    problems.push(
      `条漫 DOM 只出现过 ${seenKeys.size} 个切片节点（keys=${[...seenKeys].join(",")}）：巨图未被切成多片渲染`,
    );
  }
  if (seen.size < 2) {
    problems.push(
      `条漫只加载了 ${seen.size} 张切片，巨图未被切成多片渲染`,
    );
  }
  if (brokenImages > 0) {
    problems.push(`${brokenImages} 张切片 naturalWidth 为 0（黑块/白屏）`);
  }

  /* 5) 逻辑页 vs 物理切片：切片数量不得虚增总页数。 */
  const logicalProblems = [];
  const apiBooks = await invokeSafe(page, "list_books", { query: null });
  const apiTall = apiBooks.ok
    ? (apiBooks.value || []).find((book) => book.id === tall.id)
    : null;
  const logical = {
    apiPageCount: apiTall ? Number(apiTall.pageCount) : null,
    // 滚动到接近底部后，SQLite 持久化的必须是逻辑页 0，而不是切片号。
    persistedPage: apiTall ? Number(apiTall.currentPage ?? -1) : null,
    layoutLength:
      layout.ok && Array.isArray(layout.value) ? layout.value.length : null,
    tilesInDom: totalTiles,
    hud: null,
  };
  if (!apiBooks.ok) {
    logicalProblems.push(`list_books 失败: ${apiBooks.error}`);
  } else if (!apiTall) {
    logicalProblems.push("list_books 返回中找不到超高条漫");
  } else if (Number(apiTall.pageCount) !== expected.ultraTallPages) {
    logicalProblems.push(
      `书库 pageCount=${apiTall.pageCount} ≠ ${expected.ultraTallPages}`,
    );
  }
  if (
    apiTall &&
    !(
      Number(apiTall.currentPage ?? -1) >= 0 &&
      Number(apiTall.currentPage ?? -1) < expected.ultraTallPages
    )
  ) {
    logicalProblems.push(
      `SQLite currentPage=${apiTall.currentPage} 越界（单页超长图必须持久化逻辑页 0，不能写切片号）`,
    );
  }
  if (logical.layoutLength !== expected.ultraTallPages) {
    logicalProblems.push(
      `get_webtoon_layout 长度=${logical.layoutLength} ≠ ${expected.ultraTallPages}`,
    );
  }
  if (totalTiles <= 1) {
    logicalProblems.push(`物理切片只有 ${totalTiles} 片，无法验证切片不计页`);
  }
  const hud = await page.eval(`(() => {
    const hudNodes = [...document.querySelectorAll("[data-reader-hud]")];
    const text = hudNodes.map((el) => el.innerText || "").join("\\n");
    const counters = [...text.matchAll(/(\\d+)\\s*\\/\\s*(\\d+)/g)].map((match) => ({
      page: Number(match[1]),
      total: Number(match[2]),
    }));
    const sliders = [...document.querySelectorAll('[data-reader-hud] input[type="range"]')];
    return {
      text: text.slice(0, 400),
      counters,
      sliderCount: sliders.length,
      sliders: sliders.map((el) => ({
        max: Number(el.getAttribute("aria-valuemax") ?? el.getAttribute("max")),
        now: Number(el.getAttribute("aria-valuenow") ?? el.value),
      })),
    };
  })()`);
  logical.hud = hud;
  if (!hud.counters.length) {
    logicalProblems.push(
      `HUD 未显示页码计数（text=${JSON.stringify(hud.text.slice(0, 80))}）`,
    );
  }
  for (const counter of hud.counters) {
    if (counter.total !== expected.ultraTallPages) {
      logicalProblems.push(
        `HUD 分母=${counter.total} ≠ 逻辑页 ${expected.ultraTallPages}`,
      );
    }
  }
  if (hud.sliderCount === 0) {
    logicalProblems.push("HUD 缺少进度滑杆");
  } else if (!hud.sliders.some((slider) => slider.max === 100)) {
    logicalProblems.push(
      `条漫进度滑杆 max=${JSON.stringify(hud.sliders.map((slider) => slider.max))}，期望 100（百分比模式）`,
    );
  }
  const progressSliders = hud.sliders.filter((slider) => slider.max === 100);
  if (progressSliders.some((slider) => Number.isFinite(slider.now) && slider.now > 100)) {
    logicalProblems.push(
      `条漫进度滑杆 aria-valuenow 超出 100：${JSON.stringify(progressSliders)}`,
    );
  }

  if (logicalProblems.length) {
    fail(report, {
      id: "arch:webtoon-logical-pages",
      suite: "architecture",
      layer: "e2e",
      title: "条漫切片数量被计入逻辑页数（页码/滑杆虚增）",
      severity: "P1",
      details: JSON.stringify({ logicalProblems, logical }, null, 2),
      location: "src-tauri/src/pipeline.rs / src/components/Reader/Webtoon.tsx / src/pages/Reader.tsx",
      expected:
        "书库 pageCount=1、get_webtoon_layout=1；DOM 切片 >1 但 HUD 分母仍为 1，百分比滑杆 aria-valuemax=100",
      actual: logicalProblems.join(" | "),
      rootCause: "物理切片被当作阅读页写入 book.pageCount 或 HUD 进度",
      fix: "切片仅用于渲染，逻辑页数保持源页数（单页超长图 = 1）",
    });
  } else {
    ok(report, {
      id: "arch:webtoon-logical-pages",
      suite: "architecture",
      layer: "e2e",
      title: "条漫物理切片不计入逻辑页数（pageCount/layout/HUD 均为 1）",
      details: `API pageCount=${logical.apiPageCount}；layout=${logical.layoutLength}；DOM 切片=${totalTiles}；HUD=${JSON.stringify(
        hud.counters,
      )}；滑杆 max=${JSON.stringify(hud.sliders.map((slider) => slider.max))}`,
    });
  }

  await ctx.goto("#/");

  if (problems.length) {
    fail(report, {
      id: "arch:ultra-tall-webtoon",
      suite: "architecture",
      layer: "e2e",
      title: "超高条漫未按「先切后缩」渲染或单页高度未钳制",
      severity: "P1",
      details: JSON.stringify({ problems, evidence }, null, 2),
      location: "src-tauri/src/pipeline.rs / src/components/Reader/Webtoon.tsx",
      expected: `源高 ${expected.ultraTallHeight} 切成多片（每片 ≤2048、切片内容互不相同）、前端切片 naturalWidth>0、单页渲染高度 ≤8192`,
      actual: problems.join(" | "),
      rootCause:
        "切片未生效（仍整图直送 <img>）或单页路径缺少 MAX_SAFE_TEXTURE_H 钳制",
      fix: "条漫先切后缩 + 单页渲染等比压到 ≤MAX_SAFE_TEXTURE_H",
    });
  } else {
    ok(report, {
      id: "arch:ultra-tall-webtoon",
      suite: "architecture",
      layer: "e2e",
      title: "超高条漫切成多片渲染且单页高度被钳制到 8192 以内",
      details: `源 ${expected.ultraTallWidth}×${expected.ultraTallHeight}；单页高 ${evidence.single?.height}；API 切片指纹 ${tiles.map((item) => item.dataUrlHash).join("/")}；DOM 切片峰值 ${totalTiles}，切片节点 ${[...seenKeys].join(",")}，加载 ${seen.size} 张`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* F. 设置页 5 分区（general/network/storage/privacy/about）          */
/* ------------------------------------------------------------------ */
const EXPECTED_SETTINGS_TABS = ["general", "network", "storage", "privacy", "about"];

const SETTINGS_TABS_PROBE = `(() => {
  const visible = ${VISIBLE_FN};
  const triggers = [...document.querySelectorAll('[role="tab"]')].filter(visible);
  const list = document.querySelector('[data-slot="tabs-list"]');
  const allPanels = [...document.querySelectorAll('[role="tabpanel"]')];
  const panels = allPanels.filter(visible);
  const active = triggers.find((el) => el.getAttribute("aria-selected") === "true");
  const controls = active ? (active.getAttribute("aria-controls") || "") : "";
  // Read the panel owned by the selected trigger. Falling back to the first
  // visible panel can report the previous tab's content while Base UI swaps
  // panels, which turns a slow render into a false "tab content missing".
  const panel = (controls ? allPanels.find((el) => el.id === controls) : null) || panels[0] || null;
  const panelText = panel ? (panel.innerText || "") : "";
  return {
    count: triggers.length,
    tabs: triggers.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || "").trim(),
        selected: el.getAttribute("aria-selected") === "true",
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        id: el.getAttribute("id") || "",
        testid: el.getAttribute("data-testid") || "",
        dataValue: el.getAttribute("data-value") || el.getAttribute("value") || "",
        controls: el.getAttribute("aria-controls") || "",
      };
    }),
    list: list ? { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth } : null,
    innerWidth: window.innerWidth,
    panelCount: panels.length,
    panelAllCount: allPanels.length,
    panel: panel ? {
      textLength: panelText.trim().length,
      hasLanguage: !!panel.querySelector("#ui-language"),
      hasLibraryDir: !!panel.querySelector("#library-dir"),
      hasTheme: !!panel.querySelector("[aria-pressed]"),
      hasThemeCards: panel.querySelectorAll('[data-testid^="theme-card-"]').length,
      hasSettingsCard: !!panel.querySelector('[data-settings-section-card="true"]'),
      hasOnlineProxy: !!panel.querySelector("#online-proxy"),
      hasOnlineHeaders: !!panel.querySelector("#online-headers"),
      // #320 起预算滑杆直接在一级 storage 分区；旧 disk-cache-usage 摘要已移除。
      hasStorage: !!panel.querySelector("#disk-cache-budget"),
      hasPrivacyVersion: !!panel.querySelector('[data-testid="privacy-detail"]'),
      hasWebAccess: !!panel.querySelector('[data-testid="settings-web-access-summary"]'),
      hasDiagnostics: !!panel.querySelector('[data-testid="diagnostics-open"]'),
      hasUpdate: !!panel.querySelector("#update-check"),
    } : null,
    hash: location.hash,
  };
})()`;

const FIXED_TEXT_CJK_PROBE = `(() => {
  const visible = ${VISIBLE_FN};
  const CJK = /[\\u3400-\\u9fff]/;
  const hits = [];
  const collect = (el, where) => {
    if (!visible(el)) return;
    if (el.closest("[data-i18n-ignore], textarea, pre, code, script, style")) return;
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text && CJK.test(text)) hits.push({ where, text: text.slice(0, 100) });
  };
  document.querySelectorAll('[role="tab"]').forEach((el) => collect(el, "tab"));
  const panel = [...document.querySelectorAll('[role="tabpanel"]')].find(visible);
  if (panel) panel.querySelectorAll("h1,h2,h3").forEach((el) => collect(el, "heading"));
  return hits;
})()`;

function tabMatches(tab, token) {
  const haystack = `${tab.id} ${tab.testid} ${tab.dataValue}`.toLowerCase();
  return haystack.includes(String(token).toLowerCase());
}

function tabIndexFor(tabs, id) {
  if (id === "storage") {
    const storage = tabs.findIndex((tab) => tab.testid === "settings-tab-cache");
    if (storage >= 0) return storage;
  }
  const matched = tabs.findIndex((tab) => tabMatches(tab, id));
  if (matched >= 0) return matched;
  return EXPECTED_SETTINGS_TABS.indexOf(id);
}

function settingsMarker(id, panel) {
  if (!panel) return false;
  switch (id) {
    case "general":
      return (
        panel.hasThemeCards === 3 &&
        panel.hasSettingsCard &&
        (panel.hasLanguage || panel.hasLibraryDir || panel.hasTheme)
      );
    case "network":
      return panel.hasOnlineProxy && panel.hasOnlineHeaders;
    case "storage":
      return panel.hasStorage;
    case "privacy":
      return panel.hasPrivacyVersion;
    case "about":
      return panel.hasDiagnostics || panel.hasUpdate;
    default:
      return false;
  }
}

async function gotoAndReadSettings(ctx, hash) {
  await ctx.goto(hash);
  const page = ctx.page;
  try {
    await page.waitFor("!!document.querySelector('[role=tabpanel]')", {
      timeout: 15_000,
      label: `settings panel ${hash}`,
    });
  } catch {
    /* 下方 probe 会给出真实数量/内容，避免等待掩盖缺陷 */
  }
  await sleep(350);
  return { page, probe: await page.eval(SETTINGS_TABS_PROBE) };
}

async function clickSettingsTab(ctx, index, expectedId) {
  const page = ctx.page;
  await page.eval(
    `(() => { const visible = ${VISIBLE_FN}; const tabs = [...document.querySelectorAll('[role="tab"]')].filter(visible); if (!tabs[${index}]) return false; tabs[${index}].click(); return true; })()`,
  );
  await page
    .waitFor(
      `(() => { const visible = ${VISIBLE_FN}; const tabs = [...document.querySelectorAll('[role="tab"]')].filter(visible); return tabs[${index}]?.getAttribute("aria-selected") === "true"; })()`,
      { timeout: 5000, label: `settings tab ${index} selected` },
    )
    .catch(() => {});
  await sleep(300);
  let probe = await page.eval(SETTINGS_TABS_PROBE);
  // The panel swap can trail the selected state on a loaded WebView. Poll for
  // the expected marker instead of treating one fixed 300 ms sample as truth.
  const deadline = Date.now() + 5000;
  while (!settingsMarker(expectedId, probe.panel) && Date.now() < deadline) {
    await sleep(200);
    probe = await page.eval(SETTINGS_TABS_PROBE);
  }
  return probe;
}

async function checkSettingsTabs(ctx, report) {
  const problems = [];
  const evidence = [];
  for (const locale of ["zh-CN", "en", "es"]) {
    await ctx.setLocale(locale);
    const { probe } = await gotoAndReadSettings(ctx, "#/settings");
    const localeProblems = [];
    evidence.push({
      locale,
      count: probe.count,
      list: probe.list,
      tabs: probe.tabs.map((tab) => ({ text: tab.text, top: tab.top })),
    });

    if (probe.count !== EXPECTED_SETTINGS_TABS.length) {
      localeProblems.push(
        `role=tab 数量=${probe.count}，期望 ${EXPECTED_SETTINGS_TABS.length}`,
      );
    }
    const tops = probe.tabs.map((tab) => tab.top);
    if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 2) {
      localeProblems.push(`Tabs 换行（top 差 ${Math.max(...tops) - Math.min(...tops)}px）`);
    }
    if (probe.list && probe.list.scrollWidth > probe.list.clientWidth + 1) {
      localeProblems.push(
        `TabsList 横向溢出 scrollWidth=${probe.list.scrollWidth} > clientWidth=${probe.list.clientWidth}`,
      );
    }
    if (probe.tabs.some((tab) => tab.right > probe.innerWidth + 1)) {
      localeProblems.push("Tabs 右边缘超出视口");
    }

    const missingIds = [];
    if (!probe.tabs.some((tab) => tab.testid === "settings-tab-cache")) {
      missingIds.push("storage(settings-tab-cache)");
    }
    for (const id of EXPECTED_SETTINGS_TABS) {
      if (id === "storage") continue;
      if (!probe.tabs.some((tab) => tabMatches(tab, id))) missingIds.push(id);
    }
    if (missingIds.length) {
      localeProblems.push(`Tab 标识缺失：${missingIds.join(", ")}`);
    }

    for (const id of EXPECTED_SETTINGS_TABS) {
      const index = tabIndexFor(probe.tabs, id);
      if (index < 0 || index >= probe.tabs.length) {
        localeProblems.push(`${id}: 找不到可点击 trigger`);
        continue;
      }
      const clicked = await clickSettingsTab(ctx, index, id);
      const tab = clicked.tabs[index];
      if (!tab?.selected) {
        localeProblems.push(`${id}: 点击后未选中（aria-selected=${tab?.selected}）`);
      }
      if (!settingsMarker(id, clicked.panel)) {
        localeProblems.push(
          `${id}: 对应内容未出现（panel=${JSON.stringify(clicked.panel)}）`,
        );
      }
    }

    if (localeProblems.length) {
      problems.push(`${locale}: ${localeProblems.join("；")}`);
    }
  }

  if (problems.length) {
    fail(report, {
      id: "arch:settings-five-tabs",
      suite: "architecture",
      layer: "e2e",
      title: "设置页 5 分区（general/network/storage/privacy/about）回归失败",
      severity: "P1",
      details: JSON.stringify({ problems, evidence }, null, 2),
      location: "src/pages/Settings.tsx",
      expected:
        "恰好 5 个 role=tab（storage 保留 data-testid=settings-tab-cache）；TabsList 无横向溢出且 5 个 trigger 同一行；逐 Tab 内容与标识一致",
      actual: problems.join(" | "),
      rootCause: "设置页分区收敛不完整、标识漂移或长文案导致 Tabs 换行/溢出",
      fix: "按 general/network/storage/privacy/about 五分区重排；storage 保留 settings-tab-cache；胶囊 trigger 保持 whitespace-nowrap",
    });
  } else {
    ok(report, {
      id: "arch:settings-five-tabs",
      suite: "architecture",
      layer: "e2e",
      title: "设置页 5 分区单行胶囊且逐 Tab 内容对应（zh-CN/en/es）",
      details: evidence
        .map(
          (item) =>
            `${item.locale}: ${item.count} tabs，scroll=${item.list?.scrollWidth}/${item.list?.clientWidth}`,
        )
        .join("；"),
    });
  }
}

async function checkSettingsDeepLinks(ctx, report) {
  const cases = [
    { tab: "cache", id: "storage", marker: "hasStorage", selectedTestid: "settings-tab-cache" },
    { tab: "updates", id: "about", marker: "hasUpdate" },
    { tab: "privacy", id: "privacy", marker: "hasPrivacyVersion" },
  ];
  const problems = [];
  const evidence = [];

  for (const item of cases) {
    await ctx.goto(`#/settings?tab=${item.tab}`);
    let probe = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(attempt === 0 ? 350 : 400);
      probe = await ctx.page.eval(SETTINGS_TABS_PROBE);
      const selected = probe.tabs.filter((tab) => tab.selected);
      const markerOk = probe.panel?.[item.marker] === true;
      if (
        selected.length === 1 &&
        markerOk &&
        (item.selectedTestid
          ? selected[0].testid === item.selectedTestid
          : tabMatches(selected[0], item.id))
      ) {
        break;
      }
    }
    const selected = probe.tabs.filter((tab) => tab.selected);
    evidence.push({
      tab: item.tab,
      expected: item.id,
      selected: selected.map((tab) => ({
        text: tab.text,
        id: tab.id,
        testid: tab.testid,
        dataValue: tab.dataValue,
      })),
      panel: probe.panel,
      hash: probe.hash,
    });
    if (selected.length !== 1) {
      problems.push(`?tab=${item.tab}: 选中 trigger 数量=${selected.length}`);
      continue;
    }
    if (item.selectedTestid) {
      if (selected[0].testid !== item.selectedTestid) {
        problems.push(
          `?tab=${item.tab}: 选中 testid=${selected[0].testid || "(空)"}，期望 ${item.selectedTestid}`,
        );
      }
    } else if (!tabMatches(selected[0], item.id)) {
      problems.push(
        `?tab=${item.tab}: 选中 ${JSON.stringify({
          id: selected[0].id,
          testid: selected[0].testid,
          dataValue: selected[0].dataValue,
        })}，期望 ${item.id}`,
      );
    }
    if (probe.panel?.[item.marker] !== true) {
      problems.push(
        `?tab=${item.tab}: 对应内容未出现（${item.marker}=${probe.panel?.[item.marker]}）`,
      );
    }
  }

  if (problems.length) {
    fail(report, {
      id: "arch:settings-legacy-deeplink",
      suite: "architecture",
      layer: "e2e",
      title: "设置页旧深链未映射到新分区",
      severity: "P1",
      details: JSON.stringify({ problems, evidence }, null, 2),
      location: "src/pages/Settings.tsx",
      expected:
        "?tab=cache → storage（settings-tab-cache）；?tab=updates → about（诊断面板）；?tab=privacy → privacy",
      actual: problems.join(" | "),
      rootCause: "深链白名单只认旧 id，7→5 收敛后未做兼容映射",
      fix: "在 useSearchParams 初始状态与 effect 中把 cache/updates/online/support/reading 映射到新的 5 个 id",
    });
  } else {
    ok(report, {
      id: "arch:settings-legacy-deeplink",
      suite: "architecture",
      layer: "e2e",
      title: "旧深链 cache/updates/privacy 正确映射到 storage/about/privacy",
      details: evidence
        .map((item) => `?tab=${item.tab} → ${item.selected[0]?.text}`)
        .join("；"),
    });
  }
}

async function checkSettingsI18n(ctx, report) {
  await ctx.setLocale("en");
  const problems = [];
  const evidence = [];
  for (const [label, hash] of [
    ["about", "#/settings?tab=updates"],
    ["privacy", "#/settings?tab=privacy"],
  ]) {
    const { probe } = await gotoAndReadSettings(ctx, hash);
    await sleep(250);
    if (!probe.panel || probe.panel.textLength === 0) {
      problems.push(`${label}: 设置面板未渲染`);
      evidence.push({ label, hits: [], panel: probe.panel });
      continue;
    }
    const hits = await ctx.page.eval(FIXED_TEXT_CJK_PROBE);
    evidence.push({ label, hits });
    if (hits.length) {
      problems.push(`${label}: ${JSON.stringify(hits)}`);
    }
  }

  if (problems.length) {
    fail(report, {
      id: "arch:settings-i18n-fixed-text",
      suite: "architecture",
      layer: "e2e",
      title: "英文设置页固定文案仍含中文（about/privacy）",
      severity: "P1",
      details: JSON.stringify(evidence, null, 2),
      location: "src/pages/Settings.tsx / src/components/settings / src/components/diagnostics",
      expected: "en 下 Tab 标签与 h1/h2/h3 固定标题不含 CJK（动态路径/书名已排除）",
      actual: problems.join(" | "),
      rootCause: "5 分区收敛时新增区块文案未走六语字典",
      fix: "补齐 en/es/ja/ko 等字典并统一使用 t()",
    });
  } else {
    ok(report, {
      id: "arch:settings-i18n-fixed-text",
      suite: "architecture",
      layer: "e2e",
      title: "英文设置页 about/privacy 固定标题与 Tab 标签无中文残留",
      details: "仅检查 tab 标签与 h1/h2/h3；动态日志/路径排除在外",
    });
  }
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Task 14-3：装饰层点击穿透与设置二级抽屉遍历                       */
/* ------------------------------------------------------------------ */

async function checkDecorationLayerHitTest(ctx, report) {
  const page = ctx.page;
  await ctx.goto("#/");
  await page
    .waitFor(
      `!!document.querySelector('[data-testid="skin-canvas-frame"]')`,
      { timeout: 8000, label: "skin canvas frame" },
    )
    .catch(() => {});
  const probe = await page.eval(`(() => {
    const visible = ${VISIBLE_FN};
    const canvas = document.querySelector('[data-testid="skin-canvas-frame"]');
    if (!canvas) return { ok: false, reason: "skin-canvas-frame missing" };
    const backdrop = document.querySelector('[data-testid="skin-canvas-backdrop"]');
    const frame = document.querySelector('[data-testid="skin-canvas-frame-overlay"]');
    const targets = [];
    const add = (kind, element) => {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      targets.push({
        kind,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        element,
      });
    };
    for (const button of [...document.querySelectorAll("header button")].filter(visible).slice(0, 3)) {
      add("topbar-button", button);
    }
    add("library-search", document.getElementById("library-search-input"));
    add(
      "first-book-card",
      [...document.querySelectorAll('main [role="button"][aria-label]')].filter(visible)[0],
    );
    if (targets.length < 3) {
      return { ok: false, reason: "not enough hit-test targets", targets: targets.length };
    }
    const hits = targets.map((target) => {
      const hit = document.elementFromPoint(target.x, target.y);
      return {
        kind: target.kind,
        hitTag: hit ? hit.tagName : null,
        hitClass: hit ? String(hit.className || "").slice(0, 120) : null,
        inSkinOverlay: !!(
          hit &&
          (hit === backdrop ||
            hit === frame ||
            backdrop?.contains(hit) ||
            frame?.contains(hit))
        ),
        insideTarget: !!(hit && (hit === target.element || target.element.contains(hit))),
      };
    });
    return {
      ok: true,
      backdropPointer: backdrop ? getComputedStyle(backdrop).pointerEvents : null,
      framePointer: frame ? getComputedStyle(frame).pointerEvents : null,
      hits,
    };
  })()`);

  const problems = [];
  if (!probe?.ok) problems.push(probe?.reason || "皮肤画布探针失败");
  else {
    for (const [name, value] of [
      ["背景层", probe.backdropPointer],
      ["画框层", probe.framePointer],
    ]) {
      if (value !== null && value !== "none") {
        problems.push(`皮肤${name} pointer-events=${value}，必须为 none`);
      }
    }
    for (const hit of probe.hits) {
      if (hit.inSkinOverlay) problems.push(`${hit.kind} 命中皮肤画布覆盖层`);
      if (!hit.insideTarget) {
        problems.push(`${hit.kind} 未命中目标控件（${hit.hitTag}）`);
      }
    }
  }

  if (problems.length) {
    fail(report, {
      id: "arch:decoration-hit-test",
      suite: "architecture",
      layer: "e2e",
      title: "皮肤画布层拦截了顶栏/搜索/书卡点击",
      severity: "P1",
      details: JSON.stringify({ problems, probe }, null, 2),
      location: "src/components/shell/SkinCanvasFrame.tsx / ContentViewport.tsx",
      expected: "画布背景/画框 pointer-events:none；默认 dormant 不遮挡内容",
      actual: problems.join(" | "),
      rootCause: "画布覆盖层进入 pointer-events 或包裹了内容命中路径",
      fix: "保持背景层/画框层为 pointer-events:none 的绝对定位层",
    });
  } else {
    ok(report, {
      id: "arch:decoration-hit-test",
      suite: "architecture",
      layer: "e2e",
      title: "皮肤画布点击穿透：顶栏/搜索/书卡命中真实控件",
      details: `${probe.hits.length} 个命中点全部穿透；背景=${probe.backdropPointer ?? "none"} 画框=${probe.framePointer ?? "none"}`,
    });
  }

  await ctx.resetWorkspace().catch(() => {});
}

const SHEET_ENTRY_IDS = new Set([
  "skin-open",
  "shortcuts-open",
  "cache-detail-open",
  "diagnostics-open",
]);

async function checkSettingsSheets(ctx, report) {
  await ctx.setLocale("zh-CN");
  const watcher = watchPageErrors(ctx.page);
  const problems = [];
  const evidence = [];
  try {
    const { probe } = await gotoAndReadSettings(ctx, "#/settings");
    for (const id of EXPECTED_SETTINGS_TABS) {
      const index = tabIndexFor(probe.tabs, id);
      if (index < 0) continue;
      const clicked = await clickSettingsTab(ctx, index, id);
      if (!clicked.tabs[index]?.selected) continue;
      const entries = await ctx.page.eval(`(() => {
        const visible = ${VISIBLE_FN};
        return [...document.querySelectorAll('[data-testid$="-open"]')]
          .filter(visible)
          .map((node) => node.dataset.testid)
          .filter(Boolean);
      })()`);
      for (const testId of entries) {
        if (!SHEET_ENTRY_IDS.has(testId)) {
          evidence.push({ tab: id, testId, skipped: "native picker / not a sheet" });
          continue;
        }
        const errorMark = watcher.errors.length;
        const consoleMark = watcher.consoleErrors.length;
        const clickedEntry = await ctx.page.eval(`(() => {
          const node = [...document.querySelectorAll('[data-testid=${JSON.stringify(testId)}]')].find((item) => {
            const style = getComputedStyle(item);
            const rect = item.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
          if (!node) return false;
          node.click();
          return true;
        })()`);
        if (!clickedEntry) {
          problems.push(`${id}/${testId}: 入口不可点击`);
          continue;
        }
        const opened = await ctx.page
          .waitFor(
            `(() => { const node = document.querySelector('[data-slot="sheet-content"], [role="dialog"]'); if (!node) return false; const style = getComputedStyle(node); return style.display !== "none" && style.visibility !== "hidden"; })()`,
            { timeout: 5000, label: `${testId} sheet` },
          )
          .then(() => true)
          .catch(() => false);
        if (!opened) {
          problems.push(`${id}/${testId}: 点击后未出现二级 Sheet/Dialog`);
          continue;
        }
        const metrics = await ctx.page.eval(`(() => {
          const node = document.querySelector('[data-slot="sheet-content"], [role="dialog"]');
          const root = document.documentElement;
          if (!node) return { missing: true };
          const body = node.querySelector('[data-slot="sheet-header"]')?.parentElement || node;
          return {
            rootOverflow: root.scrollWidth - root.clientWidth,
            sheetOverflow: node.scrollWidth - node.clientWidth,
            bodyOverflow: body.scrollWidth - body.clientWidth,
            title: (node.querySelector('[data-slot="sheet-title"], h2, h3')?.textContent || "").trim().slice(0, 80),
          };
        })()`);
        if (metrics.rootOverflow > 1) {
          problems.push(`${id}/${testId}: 页面横向溢出 ${metrics.rootOverflow}px`);
        }
        if (metrics.sheetOverflow > 1) {
          problems.push(`${id}/${testId}: 抽屉横向溢出 ${metrics.sheetOverflow}px`);
        }
        if (metrics.bodyOverflow > 1) {
          problems.push(`${id}/${testId}: 抽屉正文横向溢出 ${metrics.bodyOverflow}px`);
        }
        await ctx.page.key("Escape");
        const closed = await ctx.page
          .waitFor(
            `!document.querySelector('[data-slot="sheet-content"], [role="dialog"]')`,
            { timeout: 3000, label: `${testId} sheet closed` },
          )
          .then(() => true)
          .catch(() => false);
        if (!closed) problems.push(`${id}/${testId}: Escape 未能关闭二级面板`);
        const newErrors = watcher.errors.slice(errorMark);
        const newConsole = watcher.consoleErrors.slice(consoleMark);
        if (newErrors.length || newConsole.length) {
          problems.push(
            `${id}/${testId}: 控制台错误 ${JSON.stringify([...newErrors, ...newConsole]).slice(0, 300)}`,
          );
        }
        evidence.push({ tab: id, testId, ...metrics, closed, newErrors, newConsole });
      }
    }
  } catch (error) {
    problems.push(`抽屉遍历异常：${error.message}`);
  } finally {
    watcher.stop();
  }

  if (problems.length) {
    fail(report, {
      id: "arch:settings-sheet-traversal",
      suite: "architecture",
      layer: "e2e",
      title: "设置二级 Sheet/Dialog 遍历出现溢出、报错或 Escape 失效",
      severity: "P1",
      details: JSON.stringify({ problems, evidence }, null, 2),
      location: "src/pages/Settings.tsx / src/components/settings/SettingsDetailSheet.tsx",
      expected: "每个轻入口可打开、无横向溢出、无控制台错误、Escape 可关闭",
      actual: problems.join(" | "),
      rootCause: "二级面板内容过长、缺少 min-w-0/truncate，或关闭事件未接线",
      fix: "修复溢出/报错并确保 Sheet 由 Base UI 统一处理 Escape",
    });
  } else {
    ok(report, {
      id: "arch:settings-sheet-traversal",
      suite: "architecture",
      layer: "e2e",
      title: "设置二级 Sheet/Dialog 全部可打开、无溢出、Escape 可关闭",
      details: `${evidence.filter((item) => !item.skipped).length} 个轻入口；跳过 ${evidence.filter((item) => item.skipped).length} 个原生选择器`,
    });
  }
}

export async function runArchitectureSuite(ctx, report) {
  await checkDecorationLayerHitTest(ctx, report);
  await checkSettingsSheets(ctx, report);
  await checkLegacyRoutes(ctx, report);
  await checkStorageSanitizer(ctx, report);
  await checkShortcutIsolation(ctx, report);
  await checkUltraTallWebtoon(ctx, report);
  await checkSettingsTabs(ctx, report);
  await checkSettingsDeepLinks(ctx, report);
  await checkSettingsI18n(ctx, report);
  note(
    report,
    "架构宪法回归：废弃路由重定向 / 存储清洗 / 快捷键输入态隔离 / 超高条漫（含逻辑页） / 设置 5 分区与深链 / 后置 i18n（隔离数据目录，本地 stub）",
  );
}
