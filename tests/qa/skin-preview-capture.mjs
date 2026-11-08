import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Skin preview capture (Task 7 · framed viewport skinning).
 *
 * 无头 Chrome 打开真实的 Vite 开发服务器，启用「整页背景 + 视窗外框环绕
 * 装饰」皮肤后截取主界面真机效果：
 *
 *   desktop-library-framed-skin-dark.png
 *   desktop-library-framed-skin-light.png
 *
 * 只读渲染 + 截图：不注入任何输入，不抢焦点，不移动光标。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chrome =
  process.env.MR_HEADLESS_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const devPort = Number(process.env.MR_SKIN_QA_PORT || 1432);
const appUrl = `http://127.0.0.1:${devPort}/`;
const outputDir = path.join(root, "docs/previews");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-skin-shot-"));

/** 与皮肤视窗守卫测试共用同一套 IPC 桩，保证截图里的书库是真实渲染结果。 */
const STUB = `
(() => {
  try {
    localStorage.setItem("mr-skin", "framed");
    localStorage.setItem("mr-locale", "zh-CN");
  } catch (e) {}
  const book = (id, title, currentPage) => ({
    id,
    title,
    path: "C:/library/" + title + ".cbz",
    pageCount: 168,
    currentPage,
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
    book("a".repeat(64), "星海航线 01", 42),
    book("b".repeat(64), "星海航线 02", 17),
    book("c".repeat(64), "雨夜图书馆", 96),
    book("d".repeat(64), "蓝鲸与灯塔", 8),
    book("e".repeat(64), "夏日信笺", 63),
    book("f".repeat(64), "铁轨尽头的雪", 121),
    book("g".repeat(64), "夜行电车", 5),
    book("h".repeat(64), "玻璃海 03", 74),
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
      reading: 3,
      todayPages: 46,
      heatmap: [],
      series: [],
    }),
    list_books_page: () => ({ items: books, nextCursor: null }),
    library_stats: () => ({
      totalBooks: books.length,
      seriesCounts: {},
      localSeriesCounts: {},
    }),
    get_last_read: () => books[2],
    get_book: (args) => books.find((item) => item.id === args.bookId) || books[0],
    list_entries: () => [],
    get_webtoon_layout: () => null,
    get_thumbnail: () => {
      throw new Error("no cover in the preview fixture");
    },
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
      if (!message.id) return;
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

let vite, chromeChild, page, cdpPort;
try {
  await fs.mkdir(outputDir, { recursive: true });
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
      "--hide-scrollbars",
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
  // 2× 设备像素比：1280×800 视口出 2560×1600 的高清图。
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });

  for (const theme of ["dark", "light"]) {
    await page.send("Page.navigate", { url: appUrl });
    // 主题必须在首屏前落到 <html data-theme>，否则会闪白。
    await page.eval(`(() => {
      localStorage.setItem("mr-theme", "${theme}");
      document.documentElement.dataset.theme = "${theme}";
      return true;
    })()`);
    await page.send("Page.reload", { ignoreCache: true });

    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await page.eval(`(() => {
        const viewport = document.querySelector('[data-testid="content-viewport"]');
        const cards = document.querySelectorAll('[data-testid="library-card"]');
        if (!viewport || cards.length === 0) return false;
        const inset = getComputedStyle(document.documentElement)
          .getPropertyValue("--mr-skin-viewport-inset").trim();
        return inset !== "0px" && document.documentElement.dataset.theme === "${theme}";
      })()`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, `the framed skin must render in the ${theme} theme`);

    const capture = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const target_path = path.join(
      outputDir,
      `desktop-library-framed-skin-${theme}.png`,
    );
    await fs.writeFile(target_path, Buffer.from(capture.data, "base64"));
    const stat = await fs.stat(target_path);
    console.log(
      `captured ${target_path} (${Math.round(stat.size / 1024)} KiB)`,
    );
  }

  console.log(
    "VERIFIED skin preview capture: framed skin rendered in dark and light themes.",
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
