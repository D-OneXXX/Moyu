import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Skin dormancy + framed gallery guard (Task 7 → Task 21-3).
 *
 * 本测试锁死两条契约：
 *
 *  1. 默认 `default` 仍是 0px 全屏、无背景/外框、零视觉变化；
 *  2. 从设置 →「界面皮肤与画框主题」展厅点击内置「纸墨画廊」后：
 *     - 立即自动保存 `mr-skin=ink`；
 *     - `--mr-skin-viewport-inset` 变为非零，画布背景/外框出现；
 *     - 背景与外框层 `pointer-events: none`，顶栏/搜索/书卡仍可命中；
 *     - 进入 `/reader/:id` 后视窗层不挂载，`--mr-skin-viewport-inset` 自动归零。
 *
 * 只做 DOM click + 几何测量：不注入系统输入，不抢焦点，不移动光标。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chrome =
  process.env.MR_HEADLESS_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const devPort = Number(process.env.MR_SKIN_QA_PORT || 1431);
const appUrl = `http://127.0.0.1:${devPort}/`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-skin-dormancy-"));

/**
 * IPC 桩。首次启动**不写** `mr-skin`，证明 default 的零视觉契约；
 * 页面内的展厅点击会真实写入 `mr-skin=ink`，无需重启即可验证。
 */
const STUB = `
(() => {
  try { localStorage.removeItem("mr-skin"); } catch (e) {}
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
    isFavorite: false,
    tags: [],
  });
  const books = [
    book("a".repeat(64), "Guard Volume One"),
    book("b".repeat(64), "Guard Volume Two"),
    book("c".repeat(64), "Guard Volume Three"),
  ];
  const features = new Proxy({}, { get: () => false });
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const installedFixture = {
    id: "fixture-skin",
    name: { en: "Fixture skin", "zh-CN": "夹具皮肤" },
    author: "QA",
    description: { en: "A local pack fixture.", "zh-CN": "本地皮肤包夹具。" },
    colorScheme: "both",
    tokens: {
      "--mr-skin-viewport-inset": "12px",
      "--mr-skin-surface-opacity": "0.86",
    },
    previewDataUrl: pixel,
  };
  let installed = [installedFixture];
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
    list_tags: () => [],
    list_installed_skins: () => installed,
    get_skin_bundle: (args) =>
      installed.some((item) => item.id === args.skinId)
        ? {
            ...installedFixture,
            backdrop: { dataUrl: pixel, width: 1, height: 1, bytes: 68 },
            frame: null,
            preview: { dataUrl: pixel, width: 1, height: 1, bytes: 68 },
          }
        : null,
    delete_skin_pack: (args) => {
      installed = installed.filter((item) => item.id !== args.skinId);
      return true;
    },
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

async function waitForEval(page, expression, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value = null;
  while (Date.now() < deadline) {
    value = await page.eval(expression);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return value;
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

/** 画框探针：几何 + 命中测试 + 画布层材质。 */
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
      text: (document.body.innerText || "").slice(0, 1200),
      rootHtml: (document.getElementById("root") || {}).innerHTML?.slice(0, 1600) || "",
    }))()`);
    diagnostics.events = page.events.slice(-12).map((event) => ({
      method: event.method,
      text:
        event.params?.args?.map((arg) => arg.value ?? arg.description).join(" ") ||
        event.params?.exceptionDetails?.exception?.description ||
        "",
    }));
    console.error("dormancy diagnostics:", JSON.stringify(diagnostics, null, 2));
  }
  assert.ok(probe?.present, "the content viewport must be mounted");
  assert.ok(
    probe.cards.length > 0,
    "the library must render cards so the guard can measure them",
  );

  /* ------------------------------------- 1. 默认极简仍是零视觉变化 */
  assert.equal(
    probe.inset,
    "0px",
    "the default skin must stay in pass-through mode (inset 0px)",
  );
  assert.equal(probe.skin, "default", "a fresh profile must start on default");
  assert.ok(
    Math.abs(probe.viewport.top) < 1 &&
      Math.abs(probe.viewport.left) < 1 &&
      Math.abs(probe.viewport.width - probe.windowRect.width) < 1 &&
      Math.abs(probe.viewport.height - probe.windowRect.height) < 1,
    `the default viewport must fill the window exactly: ${JSON.stringify(probe.viewport)}`,
  );
  assert.equal(
    probe.viewportRadius,
    "0px",
    "the default skin must not round the viewport corners",
  );
  assert.equal(
    probe.backdropImage,
    "none",
    "the default canvas backdrop must stay empty",
  );
  assert.equal(
    probe.frameImage,
    "none",
    "the default frame overlay must stay empty",
  );
  assert.equal(probe.backdropPointerEvents, "none");
  assert.equal(probe.framePointerEvents, "none");
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

  /* ------------------- 2. 展厅切换内置画框：非零 inset + 自动保存 */
  await page.eval(`location.hash = "#/settings"; true;`);
  const settingsButton = await waitForEval(
    page,
    `(() => {
      const button = document.querySelector('[data-testid="skin-open"]');
      if (!button) return null;
      button.click();
      return true;
    })()`,
    (value) => value === true,
    30_000,
  );
  assert.equal(settingsButton, true, "the skin gallery entry must exist in settings");

  const inkCard = await waitForEval(
    page,
    `(() => {
      const button = document.querySelector('[data-testid="skin-card-ink"]');
      if (!button) return null;
      button.click();
      return true;
    })()`,
    (value) => value === true,
    20_000,
  );
  assert.equal(inkCard, true, "the Ink Gallery preset card must be clickable");

  const framedProbe = await waitForEval(
    page,
    PROBE,
    (value) =>
      value?.present &&
      value.skin === "ink" &&
      value.inset !== "0px" &&
      value.inset.trim() !== "",
    20_000,
  );
  assert.equal(framedProbe?.skin, "ink", "clicking the gallery card must apply the skin");
  const insetValues = (framedProbe?.inset || "0px")
    .split(/\s+/)
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));
  assert.ok(
    insetValues.length > 0 && insetValues.every((value) => value > 0),
    `the framed preset must produce a non-zero inset: ${framedProbe?.inset}`,
  );
  assert.notEqual(
    framedProbe.backdropImage,
    "none",
    "the framed preset must paint a canvas backdrop",
  );
  assert.notEqual(
    framedProbe.frameImage,
    "none",
    "the framed preset must paint a frame overlay",
  );
  assert.equal(framedProbe.backdropPointerEvents, "none");
  assert.equal(framedProbe.framePointerEvents, "none");
  const persisted = await page.eval(`localStorage.getItem("mr-skin")`);
  assert.equal(persisted, "ink", "the skin choice must auto-save the lightweight id");

  /* 回到书库：关闭设置弹窗，同时证明选择已即时生效且控件未被画框层遮挡。 */
  await page.eval(`location.hash = "#/"; true;`);
  const framedLibrary = await waitForEval(
    page,
    PROBE,
    (value) =>
      value?.present &&
      value.skin === "ink" &&
      value.cards.length > 0 &&
      value.inset !== "0px",
    30_000,
  );
  assert.equal(framedLibrary?.present, true);
  assert.ok(
    framedLibrary.viewport.width < framedLibrary.windowRect.width - 20 &&
      framedLibrary.viewport.height < framedLibrary.windowRect.height - 20,
    `the framed viewport must shrink away from the canvas: ${JSON.stringify(framedLibrary.viewport)}`,
  );
  assert.ok(
    framedLibrary.viewport.left >= 20 &&
      framedLibrary.viewport.top >= 20,
    `the framed viewport must leave canvas on every side: ${JSON.stringify(framedLibrary.viewport)}`,
  );
  for (const [index, button] of framedLibrary.navButtons.entries()) {
    assert.ok(
      button.clickable,
      `framed top bar control #${index} must stay clickable: ${JSON.stringify(button)}`,
    );
  }
  assert.ok(framedLibrary.search?.clickable, "framed search must stay clickable");
  for (const [index, card] of framedLibrary.cards.entries()) {
    assert.ok(
      card.clickable,
      `framed library card #${index} must stay clickable: ${JSON.stringify(card)}`,
    );
  }

  /* ----------------------------------- 3. 阅读路由仍是全屏无边距 */
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
    "the reader route must not mount the framed viewport",
  );
  const readerInset = await waitForEval(
    page,
    `getComputedStyle(document.documentElement).getPropertyValue("--mr-skin-viewport-inset").trim()`,
    (value) => value === "0px",
    10_000,
  );
  assert.equal(
    readerInset,
    "0px",
    "entering /reader/:id must collapse the framed inset to 0px",
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

  /* -------- 4. 删除当前激活的本地包：安全回落 default（夹具替换 IPC） */
  await page.eval(`location.hash = "#/settings"; true;`);
  const reopened = await waitForEval(
    page,
    `(() => {
      const button = document.querySelector('[data-testid="skin-open"]');
      if (!button) return null;
      button.click();
      return Boolean(document.querySelector('[data-testid="skin-card-fixture-skin"]'));
    })()`,
    (value) => value === true,
    30_000,
  );
  assert.equal(reopened, true, "the installed fixture card must render in the gallery");

  const fixtureSelected = await waitForEval(
    page,
    `(() => {
      const button = document.querySelector('[data-testid="skin-card-fixture-skin"]');
      if (!button) return null;
      button.click();
      return true;
    })()`,
    (value) => value === true,
    20_000,
  );
  assert.equal(fixtureSelected, true);
  const fixtureProbe = await waitForEval(
    page,
    PROBE,
    (value) => value?.skin === "fixture-skin" && value.inset === "12px",
    15_000,
  );
  assert.equal(fixtureProbe?.skin, "fixture-skin");
  assert.equal(fixtureProbe?.inset, "12px");
  assert.equal(
    await page.eval(`localStorage.getItem("mr-skin")`),
    "fixture-skin",
  );

  const deleteButton = await waitForEval(
    page,
    `(() => {
      const button = document.querySelector('[data-testid="skin-delete-fixture-skin"]');
      if (!button) return null;
      button.click();
      return Boolean(document.querySelector('[role="alertdialog"]'));
    })()`,
    (value) => value === true,
    10_000,
  );
  assert.equal(deleteButton, true, "the local skin delete action must open a confirm dialog");

  const confirmed = await page.eval(`(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const buttons = dialog ? [...dialog.querySelectorAll("button")] : [];
    const button = buttons[buttons.length - 1];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(confirmed, true, "the confirm dialog must expose the delete action");

  const deleted = await waitForEval(
    page,
    `(() => ({
      cardGone: !document.querySelector('[data-testid="skin-card-fixture-skin"]'),
      skin: document.documentElement.dataset.mrSkin || "",
      inset: getComputedStyle(document.documentElement)
        .getPropertyValue("--mr-skin-viewport-inset").trim(),
      stored: localStorage.getItem("mr-skin"),
    }))()`,
    (value) =>
      value?.cardGone === true &&
      value.skin === "default" &&
      value.inset === "0px" &&
      value.stored === "default",
    20_000,
  );
  assert.equal(deleted?.cardGone, true, "the deleted pack card must disappear");
  assert.equal(deleted?.skin, "default", "deleting the active pack must fall back to default");
  assert.equal(deleted?.inset, "0px", "the fallback default must restore 0px inset");
  assert.equal(deleted?.stored, "default", "the fallback must persist mr-skin=default");

  await page.eval(`location.hash = "#/"; true;`);
  const restoredLibrary = await waitForEval(
    page,
    PROBE,
    (value) =>
      value?.present &&
      value.skin === "default" &&
      value.inset === "0px" &&
      value.cards.length > 0,
    30_000,
  );
  assert.equal(restoredLibrary?.present, true);
  assert.equal(restoredLibrary?.inset, "0px");

  console.log(
    "VERIFIED skin gallery guard: default stays at inset 0px with no backdrop/frame; switching to Ink auto-saves mr-skin=ink, paints a non-zero framed viewport with pointer-events:none layers and clickable controls; /reader/:id collapses to 0px and stays full-bleed; deleting the active local pack falls back to default/0px with mr-skin=default.",
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
