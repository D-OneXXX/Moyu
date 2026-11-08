import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Skin Viewport Guard (Task 7 · framed viewport skinning).
 *
 * 用无头 Chrome 打开真实的 Vite 开发服务器，启用「画框包裹」皮肤后断言：
 *  1. 内容视窗确实向内收缩（非零 `--mr-skin-viewport-inset`）；
 *  2. 顶栏按钮、搜索框、书库卡片 100% 落在视窗可视区域内；
 *  3. 这些元素在视窗内仍然 100% 可点击（命中测试落在元素自身或其后代）；
 *  4. 进入 `/reader/:id` 后自动恢复全屏无边距阅读视图（视窗层不挂载、
 *     内缩边距归零、阅读面铺满整个窗口）。
 *
 * 断言全部在页面内用 `Runtime.evaluate` 完成，不做任何真实输入注入：
 * 只读几何与命中测试，不抢焦点、不移动光标。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chrome =
  process.env.MR_HEADLESS_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const devPort = Number(process.env.MR_SKIN_QA_PORT || 1431);
const appUrl = `http://127.0.0.1:${devPort}/`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-skin-guard-"));

/** 注入页面的 Tauri IPC 桩：让主界面在没有原生壳的情况下也能渲染完整书库。 */
const STUB = `
(() => {
  try { localStorage.setItem("mr-skin", "framed"); } catch (e) {}
  const book = (id, title) => ({
    id,
    title,
    path: "C:/library/" + title + ".cbz",
    pageCount: 120,
    currentPage: 12,
    updatedAt: "2026-11-08T00:00:00Z",
    lastOpenedAt: "2026-11-08T00:00:00Z",
    progressRev: 3,
    missing: false,
    scrollPct: -1,
    sourceType: "local",
    format: "image",
    webtoonReady: false,
  });
  const books = [
    book("a".repeat(64), "Guard Volume One"),
    book("b".repeat(64), "Guard Volume Two"),
    book("c".repeat(64), "Guard Volume Three"),
  ];
  const features = new Proxy({}, { get: () => false });
  const handlers = {
    get_db_health: () => ({ ok: true, errorCode: null, dataDir: "C:/moyu" }),
    get_safe_mode_state: () => ({ active: false, reason: null, activatedAt: null }),
    get_settings: () => ({
      theme: "system",
      cacheBudgetMb: 2048,
      diskCacheBudgetMb: 2048,
      libraryDir: "",
      features,
      onlineProxy: "",
      onlineConcurrency: 2,
      onlineHeaders: "",
      closeToTray: false,
    }),
    get_dashboard: () => ({
      totalBooks: books.length,
      reading: 1,
      todayPages: 24,
      heatmap: [],
      series: [],
    }),
    list_books_page: () => ({ items: books, nextCursor: null }),
    library_stats: () => ({
      totalBooks: books.length,
      seriesCounts: {},
      localSeriesCounts: {},
    }),
    get_last_read: () => books[0],
    get_book: (args) => books.find((item) => item.id === args.bookId) || books[0],
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
      const handler = handlers[cmd];
      if (handler) return handler(args || {});
      return null;
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
      userGesture: false,
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

/** 视窗几何与命中测试（页面内执行，返回结构化结果）。 */
const PROBE = `(() => {
  const root = document.documentElement;
  const viewport = document.querySelector('[data-testid="content-viewport"]');
  const inset = getComputedStyle(root)
    .getPropertyValue("--mr-skin-viewport-inset")
    .trim();
  const windowRect = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  if (!viewport) {
    return { present: false, inset, windowRect };
  }
  const rect = viewport.getBoundingClientRect();
  const describe = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const visible =
      box.width > 0 &&
      box.height > 0 &&
      box.top >= rect.top - 0.5 &&
      box.bottom <= rect.bottom + 0.5 &&
      box.left >= rect.left - 0.5 &&
      box.right <= rect.right + 0.5;
    const clickable = Boolean(
      hit && (element === hit || element.contains(hit) || hit.contains(element)),
    );
    return {
      visible,
      clickable,
      hitTag: hit ? hit.tagName : null,
      box: {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
      },
    };
  };
  const navButtons = Array.from(
    document.querySelectorAll("header nav a, header nav button"),
  );
  const search = document.getElementById("library-search-input");
  const cards = Array.from(
    document.querySelectorAll('[data-testid="library-card"]'),
  );
  return {
    present: true,
    inset,
    windowRect,
    viewport: {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    },
    navButtons: navButtons.map(describe),
    search: describe(search),
    cards: cards.map(describe),
  };
})()`;

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
  await page.send("Page.navigate", { url: appUrl });

  // 等主界面挂载：视窗层出现，并且书库卡片已经渲染。
  const deadline = Date.now() + 45_000;
  let probe = null;
  while (Date.now() < deadline) {
    probe = await page.eval(PROBE);
    if (probe?.present && probe.cards.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!probe?.present) {
    const diagnostics = await page.eval(`(() => ({
      url: location.href,
      rootHtml: (document.getElementById("root") || {}).innerHTML?.slice(0, 800) || "",
      bodyText: (document.body.innerText || "").slice(0, 400),
    }))()`);
    console.error("viewport diagnostics:", JSON.stringify(diagnostics, null, 2));
    for (const event of page.events) {
      if (
        event.method === "Runtime.exceptionThrown" ||
        event.method === "Log.entryAdded" ||
        event.method === "Runtime.consoleAPICalled"
      ) {
        console.error(
          `[page ${event.method}]`,
          JSON.stringify(event.params).slice(0, 600),
        );
      }
    }
  }
  assert.ok(probe?.present, "the content viewport must be mounted");
  assert.ok(
    probe.cards.length > 0,
    "the library must render cards so the guard can measure them",
  );

  /* ------------------------------------------------ 1. framed skin engaged */
  assert.notEqual(
    probe.inset,
    "0px",
    "the framed skin must inset the content viewport",
  );
  assert.ok(
    probe.viewport.left > 0 &&
      probe.viewport.top > 0 &&
      probe.viewport.right < probe.windowRect.width &&
      probe.viewport.bottom < probe.windowRect.height,
    `the viewport must shrink inside the canvas: ${JSON.stringify(probe.viewport)}`,
  );

  /* --------------------------------- 2. controls stay inside the viewport */
  assert.ok(probe.navButtons.length > 0, "the top bar must expose buttons");
  for (const [index, button] of probe.navButtons.entries()) {
    assert.ok(button, `top bar control #${index} must be measurable`);
    assert.ok(
      button.visible,
      `top bar control #${index} must be fully inside the viewport: ${JSON.stringify(button)}`,
    );
    assert.ok(
      button.clickable,
      `top bar control #${index} must stay clickable: ${JSON.stringify(button)}`,
    );
  }
  assert.ok(probe.search, "the library search box must exist");
  assert.ok(
    probe.search.visible,
    `the search box must be fully inside the viewport: ${JSON.stringify(probe.search)}`,
  );
  assert.ok(
    probe.search.clickable,
    `the search box must stay clickable: ${JSON.stringify(probe.search)}`,
  );
  for (const [index, card] of probe.cards.entries()) {
    assert.ok(
      card.visible,
      `library card #${index} must be fully inside the viewport: ${JSON.stringify(card)}`,
    );
    assert.ok(
      card.clickable,
      `library card #${index} must stay clickable: ${JSON.stringify(card)}`,
    );
  }

  /* ----------------------------------- 3. reader route is full-bleed */
  await page.eval(
    `location.hash = "#/reader/${"a".repeat(64)}"; true;`,
  );
  const readerDeadline = Date.now() + 30_000;
  let readerProbe = null;
  while (Date.now() < readerDeadline) {
    readerProbe = await page.eval(PROBE);
    // 等路由切换与皮肤 effect 都落定：视窗层卸载 + 内缩边距归零。
    if (readerProbe && !readerProbe.present && readerProbe.inset === "0px") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    readerProbe && !readerProbe.present,
    "the reader route must not mount the framed content viewport",
  );
  assert.equal(
    readerProbe.inset,
    "0px",
    "the reader route must reset the viewport inset to 0px",
  );
  const readerSurface = await page.eval(`(() => {
    const root = document.getElementById("root");
    const child = root && root.firstElementChild;
    if (!child) return null;
    const rect = child.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    };
  })()`);
  assert.ok(readerSurface, "the reader surface must be mounted");
  assert.ok(
    readerSurface.width >= readerSurface.windowWidth - 1 &&
      readerSurface.height >= readerSurface.windowHeight - 1,
    `the reader must cover the whole window: ${JSON.stringify(readerSurface)}`,
  );

  console.log(
    "VERIFIED skin viewport guard: framed skin insets the viewport, top bar / search / library cards stay visible and clickable, /reader/:id returns to a full-bleed reader.",
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
