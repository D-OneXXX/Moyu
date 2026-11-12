import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Online direct-read chain guard (Task 5B).
 *
 * 覆盖用户报告的完整断链：
 *  1. 「设置 → 网络与在线源 → 在线 URL 直读」卡片上有**可直接点击**的开关；
 *  2. 打开开关会立即调用 `set_feature_enabled("online", true)`，界面实时反映；
 *  3. 关闭状态下在 `/browser` 顶部唯一地址栏提交 URL，会出现**带「立即开启」出口**的
 *     提示（不再是死胡同）；点它会真的开启功能并立刻放行解析；
 *  4. 开启后地址栏对普通漫画 URL 走 `resolve_online_url`、对 Telegram 链接走
 *     `resolve_telegram_channel`，并跳进阅读器。
 *
 * 用无头 Chrome 跑真实的 React 界面；IPC 用可记录的桩，断言的是**前端接线**
 * （哪个命令被调用、参数是什么、界面是否跳转），不依赖外部网络。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chrome =
  process.env.MR_HEADLESS_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const devPort = Number(process.env.MR_ONLINE_QA_PORT || 1433);
const appUrl = `http://127.0.0.1:${devPort}/`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-online-chain-"));

/** 可记录的 IPC 桩：把每次 invoke 记进 window.__mrCalls。 */
const STUB = `
(() => {
  const calls = [];
  window.__mrCalls = calls;
  const state = { online: false };
  const features = () => ({
    webtoon: true,
    online: state.online,
    browser: true,
    pdf: true,
    opds: true,
    webAccess: false,
    updates: true,
    backup: true,
    diagnostics: true,
  });
  const book = (id, title) => ({
    id,
    title,
    path: "C:/library/" + title + ".cbz",
    pageCount: 3,
    currentPage: 0,
    updatedAt: "2026-11-08T00:00:00Z",
    lastOpenedAt: "2026-11-08T00:00:00Z",
    progressRev: 1,
    missing: false,
    scrollPct: -1,
    sourceType: "online",
    format: "image",
    webtoonReady: false,
  });
  const handlers = {
    get_db_health: () => ({ ok: true, errorCode: null, dataDir: "C:/moyu" }),
    get_safe_mode_state: () => ({ active: false, reason: null, activatedAt: null }),
    get_settings: () => ({
      theme: "system",
      cacheBudgetMb: 2048,
      diskCacheBudgetMb: 2048,
      libraryDir: "",
      features: features(),
      onlineProxy: "",
      onlineConcurrency: 2,
      onlineHeaders: "",
      closeToTray: false,
    }),
    set_feature_enabled: (args) => {
      state.online = !!args.enabled;
      return handlers.get_settings();
    },
    set_settings: () => handlers.get_settings(),
    get_dashboard: () => ({
      totalBooks: 0,
      reading: 0,
      todayPages: 0,
      heatmap: [],
      series: [],
    }),
    list_books_page: () => ({ items: [], nextCursor: null }),
    library_stats: () => ({
      totalBooks: 0,
      seriesCounts: {},
      localSeriesCounts: {},
    }),
    get_last_read: () => null,
    resolve_online_url: (args) => {
      if (!state.online) {
        throw "在线直读已在设置中关闭（feature-disabled）";
      }
      return book("d".repeat(64), "Parsed " + args.url);
    },
    resolve_telegram_channel: (args) => {
      if (!state.online) {
        throw "在线直读已在设置中关闭（feature-disabled）";
      }
      const base = {
        channel: "example_channel",
        title: "Test Channel",
        before: null,
        hasMore: false,
      };
      if (args.query) {
        return { ...base, chapters: [], query: args.query };
      }
      return {
        ...base,
        chapters: [
          {
            id: "example_channel/100",
            title: "第01话",
            url: "https://t.me/example_channel/100",
            messageId: 100,
            pageCount: 4,
            kind: "photos",
            grouped: false,
            viaInline: true,
            tags: ["#漫画"],
          },
          {
            id: "example_channel/200",
            title: "目录",
            url: "https://t.me/example_channel/200",
            messageId: 200,
            pageCount: null,
            kind: "index",
            grouped: false,
            links: [
              { url: "https://telegra.ph/A", title: "第 1 话" },
              { url: "https://t.me/example_channel/201", title: "第 2 话" },
            ],
          },
        ],
      };
    },
    resolve_online_urls: (args) =>
      (args.urls || []).map((url) => ({
        url,
        ok: true,
        title: "ok",
        book: book("e".repeat(64), "ok"),
      })),
    resolve_online_batch: () => [],
    get_app_info: () => ({
      version: "0.19.1",
      currentVersion: "0.19.1",
      notes: "",
      pubDate: "",
      downloadUrl: "",
    }),
    get_online_filter_status: () => ({
      siteProfiles: 0,
      rules: 0,
      blockedTotal: 0,
      restoredTotal: 0,
      lastUpdated: null,
    }),
    list_online_filter_rules: () => [],
    get_opds_config: () => ({
      enabled: false,
      url: "",
      hasUsername: false,
      hasPassword: false,
    }),
    web_access_status: () => ({ running: false, port: 0 }),
    get_memory_stats: () => ({
      totalBytes: 1024,
      renderCacheBytes: 0,
      onlineCacheBytes: 0,
      dbBytes: 0,
    }),
    get_db_health: () => ({ ok: true, errorCode: null, dataDir: "C:/moyu" }),
    list_entries: () => [],
    get_webtoon_layout: () => null,
    get_memory_stats: () => ({
      totalBytes: 1024,
      renderCacheBytes: 0,
      onlineCacheBytes: 0,
      dbBytes: 0,
    }),
  };
  let callbackId = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback(callback) {
      const id = callbackId++;
      window["_" + id] = callback;
      return id;
    },
    unregisterCallback(id) {
      delete window["_" + id];
    },
    convertFileSrc(filePath) {
      return filePath;
    },
    async invoke(cmd, args) {
      calls.push({ cmd, args: args || {} });
      const handler = handlers[cmd];
      // 未显式建模的命令一律给空数组：列表型命令拿到 null 会让设置页崩。
      if (!handler) return [];
      return handler(args || {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    async registerListener() {
      return 1;
    },
    async unregisterListener() {},
  };
})();
`;

async function waitForHttp(url, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {
      /* dev server is still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForTarget(port, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (entry) => entry.type === "page" && entry.webSocketDebuggerUrl,
        );
        if (target) return target;
      }
    } catch {
      /* browser is still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the headless browser target.");
}

class CdpPage {
  constructor(target) {
    this.target = target;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
  }
  static async connect(target) {
    const page = new CdpPage(target);
    await page.open();
    return page;
  }
  async open() {
    if (typeof WebSocket !== "function") {
      throw new Error("Node.js with global WebSocket support is required.");
    }
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("CDP WebSocket connection failed.")),
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }
  send(method, params = {}) {
    if (!this.socket) return Promise.reject(new Error("CDP is not connected."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Page evaluation failed.",
      );
    }
    return result.result?.value;
  }
}

let vite, chromeChild, page, cdpPort;
try {
  vite = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/vite/bin/vite.js"),
      "--port",
      String(devPort),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    { cwd: root, stdio: "ignore", windowsHide: true },
  );
  await waitForHttp(appUrl);

  chromeChild = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  for (let i = 0; i < 150; i += 1) {
    try {
      cdpPort = Number(
        (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
      );
      if (cdpPort) break;
    } catch {
      /* CDP port not published yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(cdpPort, "Chrome did not publish a CDP port");

  const target = await waitForTarget(cdpPort);
  page = await CdpPage.connect(target);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const wait = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await page.eval(expression)) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const snapshot = await page.eval(`(() => ({
      url: location.href,
      tabs: Array.from(document.querySelectorAll('[data-testid^="settings-tab-"]')).map(
        (el) => el.getAttribute("data-testid") + ":" + el.getAttribute("data-selected"),
      ),
      text: (document.body.innerText || "").slice(0, 600),
    }))()`);
    console.error("wait diagnostics:", JSON.stringify(snapshot, null, 2));
    for (const event of page.events) {
      if (event.method === "Runtime.consoleAPICalled" && event.params?.type === "error") {
        const text = (event.params.args || [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ");
        console.error("[console.error]", text.slice(0, 1200));
      }
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const calls = () => page.eval("window.__mrCalls || []");

  /* -------------------------------- 1. 设置页的开关就在「在线 URL 直读」卡片里 */
  // 深链直接落到「网络与在线源」分区（设置页支持 ?tab=network）。
  await page.send("Page.navigate", { url: `${appUrl}#/settings?tab=network` });
  await wait(
    `document.querySelector('[data-testid="online-direct-switch"]') !== null`,
  );
  const switchState = await page.eval(`(() => {
    const el = document.querySelector('[data-testid="online-direct-switch"]');
    if (!el) {
      return {
        missing: true,
        url: location.href,
        text: (document.body.innerText || "").slice(0, 400),
      };
    }
    return {
      checked: el.getAttribute("aria-checked") === "true",
      disabled:
        el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("data-disabled"),
    };
  })()`);
  if (switchState.missing) {
    console.error("switch diagnostics:", JSON.stringify(switchState, null, 2));
    for (const event of page.events) {
      if (event.method === "Runtime.exceptionThrown") {
        console.error(
          "[page exception]",
          JSON.stringify(event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text).slice(0, 900),
        );
      }
    }
    throw new Error("the online direct-read switch vanished before it could be read");
  }
  assert.equal(
    switchState.checked,
    false,
    "the online direct-read switch must start in the off state",
  );
  assert.equal(switchState.disabled, false, "the switch must be clickable");

  /* ------------------------------- 2. 打开开关 → 立刻写库并实时反映 */
  await page.eval(`document.querySelector('[data-testid="online-direct-switch"]').click(); true;`);
  await wait(`(() => {
    const el = document.querySelector('[data-testid="online-direct-switch"]');
    return el && el.getAttribute("aria-checked") === "true";
  })()`);
  const enabled = await calls();
  const setCalls = enabled.filter((call) => call.cmd === "set_feature_enabled");
  assert.equal(setCalls.length, 1, "the switch must write the feature flag once");
  assert.equal(setCalls[0].args.feature, "online");
  assert.equal(setCalls[0].args.enabled, true);

  /* ------------- 3. 开启后地址栏解析普通漫画 URL，并跳进阅读器 */
  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    return true;
  })()`);
  await page.send("Page.navigate", { url: `${appUrl}#/browser` });
  await wait(`document.getElementById("browser-url-input") !== null`);
  await page.eval(`(() => {
    const input = document.getElementById("browser-url-input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "https://example.com/gallery/01");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form?.requestSubmit?.();
    return true;
  })()`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some((call) => call.cmd === "resolve_online_url");
  })()`);
  const resolved = await calls();
  const resolveCall = resolved.find((call) => call.cmd === "resolve_online_url");
  assert.ok(resolveCall, "the address bar must reach resolve_online_url");
  assert.equal(
    resolveCall.args.url,
    "https://example.com/gallery/01",
    "the address bar must forward the entered URL verbatim",
  );
  await wait(`location.hash.startsWith("#/reader/")`);

  /* --------------------- 4. 关掉开关后提交地址 → 有「立即开启」出口 */
  await page.send("Page.navigate", { url: `${appUrl}#/settings?tab=network` });
  await wait(
    `document.querySelector('[data-testid="online-direct-switch"]') !== null`,
  );
  await page.eval(`document.querySelector('[data-testid="online-direct-switch"]').click(); true;`);
  await wait(`(() => {
    const el = document.querySelector('[data-testid="online-direct-switch"]');
    return el && el.getAttribute("aria-checked") === "false";
  })()`);
  const offCalls = await calls();
  const offWrite = offCalls.find(
    (call) => call.cmd === "set_feature_enabled" && call.args.enabled === false,
  );
  assert.ok(offWrite, "the switch must also be able to turn the feature off");

  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    return true;
  })()`);
  await page.send("Page.navigate", { url: `${appUrl}#/browser` });
  await wait(`document.getElementById("browser-url-input") !== null`);
  await page.eval(`(() => {
    const input = document.getElementById("browser-url-input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "https://example.com/gallery/01");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form?.requestSubmit?.();
    return true;
  })()`);
  await wait(
    `document.querySelector('[data-testid="browser-enable-online"]') !== null`,
  );
  const blockedCalls = await calls();
  assert.equal(
    blockedCalls.filter((call) => call.cmd === "resolve_online_url").length,
    0,
    "a disabled feature must not reach the backend resolver",
  );

  /* -------------------- 5. 点「立即开启」→ 开启功能并立刻放行解析 */
  await page.eval(`document.querySelector('[data-testid="browser-enable-online"]').click(); true;`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some((call) => call.cmd === "set_feature_enabled" && call.args.enabled === true);
  })()`);
  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    const input = document.getElementById("browser-url-input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "https://example.com/gallery/01");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form?.requestSubmit?.();
    return true;
  })()`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some((call) => call.cmd === "resolve_online_url");
  })()`);
  const afterEnable = await calls();
  assert.ok(
    afterEnable.some((call) => call.cmd === "resolve_online_url"),
    "the retry after enabling must reach the resolver",
  );

  /* --------------------- 5. Telegram 链接走 resolve_telegram_channel */
  // 上一步解析成功后已跳进阅读器；Telegram 用例需要回到浏览器页。
  await page.send("Page.navigate", { url: `${appUrl}#/browser` });
  await wait(`document.getElementById("browser-url-input") !== null`);
  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    const input = document.getElementById("browser-url-input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "https://t.me/example_channel");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form?.requestSubmit?.();
    return true;
  })()`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some((call) => call.cmd === "resolve_telegram_channel");
  })()`);
  const telegramCalls = await calls();
  const telegramCall = telegramCalls.find(
    (call) => call.cmd === "resolve_telegram_channel",
  );
  assert.ok(telegramCall, "a Telegram link must reach resolve_telegram_channel");
  assert.equal(telegramCall.args.url, "https://t.me/example_channel");

  /* ------------- 6. Telegram 面板：内联徽标 / #标签搜索 / 目录批量导入 */
  await wait(
    `document.querySelectorAll('[data-testid="telegram-chapter"]').length === 2`,
  );
  const panelState = await page.eval(`(() => ({
    search: !!document.querySelector('[data-testid="telegram-search-input"]'),
    tag: !!document.querySelector('[data-testid="telegram-tag"]'),
    inlineBadge: document.querySelectorAll('[data-testid="telegram-inline-badge"]').length,
    indexImportAll: !!document.querySelector('[data-testid="telegram-index-import-all"]'),
  }))()`);
  assert.ok(panelState.search, "the channel panel must expose the search box");
  assert.ok(panelState.tag, "public #tags must render as filter buttons");
  assert.equal(
    panelState.inlineBadge,
    1,
    "an inline-button chapter must be marked as readable",
  );
  assert.ok(
    panelState.indexImportAll,
    "an index post must offer one-click batch import",
  );

  // 点击 #标签 → 重新请求同一频道，query 为带 # 的原文。
  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    document.querySelector('[data-testid="telegram-tag"]').click();
    return true;
  })()`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some(
      (call) => call.cmd === "resolve_telegram_channel" && call.args.query === "#漫画",
    );
  })()`);
  await wait(
    `document.querySelector('[data-testid="telegram-search-clear"]') !== null`,
  );

  // 清除搜索 → 回到完整章节列表。
  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    document.querySelector('[data-testid="telegram-search-clear"]').click();
    return true;
  })()`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some(
      (call) => call.cmd === "resolve_telegram_channel" && call.args.query == null,
    );
  })()`);
  await wait(
    `document.querySelectorAll('[data-testid="telegram-chapter"]').length === 2`,
  );

  // 展开目录并一次性导入全部链接 → 同一 seriesTitle。
  await page.eval(`(() => {
    window.__mrCalls.length = 0;
    document.querySelector('[data-testid="telegram-index-toggle"]').click();
    return true;
  })()`);
  await wait(
    `document.querySelector('[data-testid="telegram-index-links"]') !== null`,
  );
  await page.eval(`(() => {
    document.querySelector('[data-testid="telegram-index-import-all"]').click();
    return true;
  })()`);
  await wait(`(() => {
    const calls = window.__mrCalls || [];
    return calls.some((call) => call.cmd === "resolve_online_urls");
  })()`);
  const indexCalls = await calls();
  const indexCall = indexCalls.find((call) => call.cmd === "resolve_online_urls");
  assert.ok(indexCall, "the index post must reach resolve_online_urls");
  assert.equal(indexCall.args.seriesTitle, "目录");
  assert.deepEqual(indexCall.args.urls, [
    "https://telegra.ph/A",
    "https://t.me/example_channel/201",
  ]);

  console.log(
    "VERIFIED online chain guard: the online switch writes the flag instantly, the disabled state offers an enable-now escape, and the browser address bar dispatches HTML/JSON URLs to resolve_online_url and Telegram links to resolve_telegram_channel.",
  );
  console.log(
    "VERIFIED Telegram panel: inline-button chapters are marked readable, #tags re-query the channel, and an index post imports every public chapter with one seriesTitle.",
  );
  console.log(
    `L2 resources: vite 127.0.0.1:${devPort}; owned headless Chrome PID ${chromeChild?.pid ?? "not-started"}; CDP ${cdpPort ?? "not-started"}.`,
  );
} finally {
  if (page?.socket) page.socket.close();
  for (const child of [chromeChild, vite]) {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5e3))]);
    }
  }
  await fs.rm(profile, { recursive: true, force: true });
  console.log("Cleanup: owned Chrome and Vite stopped, temporary browser profile removed.");
}
