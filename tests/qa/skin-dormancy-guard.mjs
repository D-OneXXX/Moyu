import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Skin dormancy guard (Task 7 · framed viewport reservation).
 *
 * 「画框包裹式」换肤在本版本是**预留态**：容器结构与 CSS 变量接口都已就位，
 * 但默认 100% 不启用。本测试锁死这个契约：
 *
 *  1. 默认 `--mr-skin-viewport-inset: 0px`——视窗铺满窗口，不产生多余边距；
 *  2. 即使 localStorage 里残留一个预留皮肤 id，启动也**不会**启用它
 *     （测试故意写入 `mr-skin=framed`）；
 *  3. 画布背景层与外框层没有背景图、不拦截命中测试，不遮挡任何内容；
 *  4. 进入 `/reader/:id` 后视窗层不挂载，阅读面铺满整个窗口。
 *
 * 只读渲染 + 几何测量：不注入输入，不抢焦点，不移动光标。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chrome =
  process.env.MR_HEADLESS_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const devPort = Number(process.env.MR_SKIN_QA_PORT || 1431);
const appUrl = `http://127.0.0.1:${devPort}/`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-skin-dormancy-"));

/**
 * IPC 桩。关键点：这里**故意**写入 `mr-skin=framed`（一个预留态皮肤），
 * 用来证明它不会被自动启用。
 */
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
      diskCacheMb: 2048,
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

/** 预留态探针：几何 + 命中测试 + 画布层材质。 */
const PROBE = `(() => {
  const root = document.documentElement;
  const viewport = document.querySelector('[data-testid="content-viewport"]');
  const canvas = document.querySelector('[data-testid="skin-canvas-frame"]');
  const backdrop = document.querySelector('[data-testid="skin-canvas-backdrop"]');
  const frame = document.querySelector('[data-testid="skin-canvas-frame-overlay"]');
  const styleOf = (el) => (el ? getComputedStyle(el) : null);
  const base = {
    inset: getComputedStyle(root)
      .getPropertyValue("--mr-skin-viewport-inset").trim(),
    skin: root.dataset.mrSkin || "",
    backdropImage: styleOf(backdrop)?.backgroundImage || "",
    backdropPointerEvents: styleOf(backdrop)?.pointerEvents || "",
    frameImage: styleOf(frame)?.backgroundImage || "",
    framePointerEvents: styleOf(frame)?.pointerEvents || "",
    canvasPosition: styleOf(canvas)?.position || "",
    windowRect: { width: window.innerWidth, height: window.innerHeight },
  };
  if (!viewport) return { present: false, ...base };
  const rect = viewport.getBoundingClientRect();
  const describe = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    const visible =
      box.width > 0 &&
      box.height > 0 &&
      box.top >= -0.5 &&
      box.bottom <= window.innerHeight + 0.5 &&
      box.left >= -0.5 &&
      box.right <= window.innerWidth + 0.5;
    const clickable = Boolean(
      hit && (element === hit || element.contains(hit) || hit.contains(element)),
    );
    return {
      visible,
      clickable,
      hitTag: hit ? hit.tagName : null,
      hitTestId: hit ? hit.getAttribute("data-testid") : null,
    };
  };
  return {
    present: true,
    ...base,
    viewport: {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    },
    viewportRadius: styleOf(viewport)?.borderTopLeftRadius || "",
    navButtons: Array.from(
      document.querySelectorAll("header nav a, header nav button"),
    ).map(describe),
    search: describe(document.getElementById("library-search-input")),
    cards: Array.from(
      document.querySelectorAll('[data-testid="library-card"]'),
    ).map(describe),
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
    }))()`);
    console.error("dormancy diagnostics:", JSON.stringify(diagnostics, null, 2));
  }
  assert.ok(probe?.present, "the content viewport must be mounted");
  assert.ok(
    probe.cards.length > 0,
    "the library must render cards so the guard can measure them",
  );

  /* ------------------------------------- 1. 预留态默认透传（零内缩） */
  assert.equal(
    probe.inset,
    "0px",
    "the reserved skin must stay in pass-through mode (inset 0px)",
  );
  assert.equal(
    probe.skin,
    "default",
    "a dormant skin id must never be activated on startup",
  );

  /* ------------------------- 2. 视窗铺满窗口，不产生多余边距与圆角 */
  assert.ok(
    Math.abs(probe.viewport.top) < 1 &&
      Math.abs(probe.viewport.left) < 1 &&
      Math.abs(probe.viewport.width - probe.windowRect.width) < 1 &&
      Math.abs(probe.viewport.height - probe.windowRect.height) < 1,
    `the viewport must fill the window exactly: ${JSON.stringify(probe.viewport)}`,
  );
  assert.equal(
    probe.viewportRadius,
    "0px",
    "the reserved skin must not round the viewport corners",
  );

  /* ---------------------- 3. 画布层无背景图、不拦截命中测试（零遮挡） */
  assert.equal(
    probe.backdropImage,
    "none",
    "the canvas backdrop must stay empty in the reserved state",
  );
  assert.equal(
    probe.frameImage,
    "none",
    "the frame overlay must stay empty in the reserved state",
  );
  assert.equal(probe.backdropPointerEvents, "none");
  assert.equal(probe.framePointerEvents, "none");

  /* ------------------------------------- 4. 交互元素完全不受遮挡 */
  assert.ok(probe.navButtons.length > 0, "the top bar must expose buttons");
  for (const [index, button] of probe.navButtons.entries()) {
    assert.ok(
      button.visible,
      `top bar control #${index} must be visible: ${JSON.stringify(button)}`,
    );
    assert.ok(
      button.clickable,
      `top bar control #${index} must stay clickable: ${JSON.stringify(button)}`,
    );
  }
  assert.ok(probe.search, "the library search box must exist");
  assert.ok(probe.search.visible, "the search box must be visible");
  assert.ok(probe.search.clickable, "the search box must stay clickable");
  for (const [index, card] of probe.cards.entries()) {
    assert.ok(card.visible, `library card #${index} must be visible`);
    assert.ok(card.clickable, `library card #${index} must stay clickable`);
  }

  /* ----------------------------------- 5. 阅读路由仍是全屏无边距 */
  await page.eval(`location.hash = "#/reader/${"a".repeat(64)}"; true;`);
  const readerDeadline = Date.now() + 30_000;
  let readerProbe = null;
  while (Date.now() < readerDeadline) {
    readerProbe = await page.eval(PROBE);
    if (readerProbe && !readerProbe.present) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    readerProbe && !readerProbe.present,
    "the reader route must not mount the reserved viewport",
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
    "VERIFIED skin dormancy guard: reserved frame stays at inset 0px with no backdrop/frame and no occlusion; dormant skin ids never auto-activate; /reader/:id stays full-bleed.",
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
