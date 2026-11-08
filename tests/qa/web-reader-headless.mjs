import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * D4 Web Reader end-to-end QA (headless Chrome over CDP).
 *
 * Covers the mobile-first rebuild: library grid + progress capsules, nine-grid
 * tap zones, HUD show/hide, paged/webtoon switching, tile skeletons, pinch
 * zoom, conflict resolution, throttled CAS progress writes, scroll restore
 * across a width change, six locales, and the three failure surfaces
 * (PDF / bad tile / oversized webtoon).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reader = path.join(root, "src-tauri/src/web_access/reader");
const chrome =
  process.env.MR_HEADLESS_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-web-reader-qa-"));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2WQAAAABJRU5ErkJggg==",
  "base64",
);
const id = "a".repeat(64);
let paired = false;
let sessionRequests = 0;
let localClaimRequests = 0;
let writes = 0;
let lastWrite = null;
let progressState = { page: 0, pageCount: 3, scrollPct: -1, rev: 4 };

async function waitForTarget(port, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (entry) => entry.type === "page" && predicate(entry),
        );
        if (target) return target;
      }
    } catch {
      /* browser is still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the isolated headless browser target.");
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
    await this.send("Log.enable");
  }
  send(method, params = {}) {
    if (!this.socket) return Promise.reject(new Error("CDP is not connected."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 10_000);
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

const assets = new Map([
  ["/", [path.join(reader, "index.html"), "text/html"]],
  ["/reader.js", [path.join(reader, "reader.js"), "text/javascript"]],
  ["/reader.css", [path.join(reader, "reader.css"), "text/css"]],
  [
    "/reader-messages.js",
    [path.join(root, "src/i18n/messages/webReader.ts"), "text/javascript"],
  ],
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (assets.has(url.pathname)) {
    const [file, type] = assets.get(url.pathname);
    res.writeHead(200, {
      "content-type": type,
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    res.end(await fs.readFile(file));
    return;
  }
  if (url.pathname === "/reader-theme.css") {
    const css = await fs.readFile(path.join(root, "src/index.css"), "utf8");
    const tokens = (marker) =>
      css
        .split(marker)[1]
        .split("}")[0]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("--sh-"))
        .join("");
    res.writeHead(200, { "content-type": "text/css" });
    res.end(
      `:root{${tokens(":root {")}}[data-theme="dark"]{${tokens('[data-theme="dark"] {')}}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${tokens('[data-theme="dark"] {')}}}`,
    );
    return;
  }
  const json = (status, data) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  if (req.method === "POST" && url.pathname === "/api/pair/claim") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const claim = JSON.parse(raw);
    if (claim.pairingId === "local") {
      localClaimRequests += 1;
      json(403, { error: { code: "pairing-unavailable" } });
      return;
    }
    assert.match(claim.pairingId, /^pair_[a-f0-9]{32}$/);
    assert.match(claim.claimNonce, /^[a-zA-Z0-9_-]{22}$/);
    assert.equal(req.headers["x-moyu-request"], "1");
    json(202, { claimId: "claim_123" });
    return;
  }
  if (url.pathname === "/api/pair/claim/claim_123") {
    json(200, { state: "approved" });
    return;
  }
  if (url.pathname === "/api/pair/claim/claim_123/consume") {
    paired = true;
    json(200, { state: "consumed" });
    return;
  }
  if (url.pathname === "/api/session") {
    sessionRequests += 1;
    if (paired) json(200, { deviceName: "test" });
    else json(401, { error: { code: "unauthorized" } });
    return;
  }
  if (url.pathname === "/api/books") {
    const base = {
      pageCount: 3,
      currentPage: 0,
      progressRev: 4,
      scrollPct: -1,
      updatedAt: "2026-11-08T00:00:00Z",
      sourceType: "local",
      missing: false,
    };
    json(200, {
      items: [
        { ...base, id, title: "Demo", format: "image", thumbUrl: `/api/books/${id}/thumb` },
        { ...base, id: "c".repeat(64), title: "PDF demo", format: "pdf" },
        { ...base, id: "e".repeat(64), title: "Faulty", format: "image" },
        { ...base, id: "f".repeat(64), title: "Shorter", format: "image", currentPage: 2 },
        { ...base, id: "b".repeat(64), title: "Large", format: "image" },
      ],
      nextCursor: null,
    });
    return;
  }
  if (/^\/api\/books\/[a-f0-9]{64}\/layout$/.test(url.pathname)) {
    const bookId = url.pathname.split("/")[3];
    const count = bookId === "f".repeat(64) ? 2 : 3;
    const height = bookId === "e".repeat(64) ? 3000 : 6400;
    json(200, {
      pages: Array.from({ length: count }, (_, index) => ({
        index,
        width: 640,
        height,
      })),
    });
    return;
  }
  if (url.pathname.endsWith("/thumb")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
    return;
  }
  if (url.pathname.endsWith("/progress") && req.method === "GET") {
    json(
      200,
      url.pathname.includes("f".repeat(64))
        ? { page: 5, pageCount: 2, scrollPct: -1, rev: 4 }
        : { ...progressState },
    );
    return;
  }
  if (url.pathname.endsWith("/progress") && req.method === "PUT") {
    assert.equal(req.headers["x-moyu-request"], "1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    lastWrite = JSON.parse(raw);
    writes += 1;
    if (writes === 1) {
      progressState = { page: 2, pageCount: 3, scrollPct: 0.4, rev: 7 };
      json(409, {
        error: {
          code: "progress-conflict",
          details: { currentPage: 2, currentRev: 7 },
        },
      });
    } else {
      progressState = {
        page: lastWrite.page,
        pageCount: 3,
        scrollPct: lastWrite.scrollPct ?? -1,
        rev: progressState.rev + 1,
      };
      json(200, { page: progressState.page, rev: progressState.rev });
    }
    return;
  }
  if (/^\/api\/books\/[a-f0-9]{64}\/pages\/\d+$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
    return;
  }
  if (url.pathname.includes("/tiles/")) {
    if (url.pathname.includes("b".repeat(64))) {
      json(422, { error: { code: "webtoon-too-large" } });
      return;
    }
    const faulty = url.pathname.includes("e".repeat(64));
    if (faulty && url.pathname.endsWith("/tiles/1")) {
      json(500, { error: { code: "internal" } });
      return;
    }
    res.writeHead(200, {
      "content-type": "image/png",
      "x-tile-count": faulty ? "2" : "1",
      "x-tile-height": "2048",
    });
    res.end(png);
    return;
  }
  json(404, { error: { code: "not-found" } });
});

let child, page, port, cdpPort;
try {
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve())),
  );
  port = server.address().port;
  child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/`,
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
      /* not published yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(cdpPort, "Chrome did not publish a CDP port");
  const target = await waitForTarget(cdpPort, (entry) =>
    entry.url.includes(`127.0.0.1:${port}`),
  );
  page = await CdpPage.connect(target);
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const wait = async (expression, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await page.eval(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out: " + expression);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shotDir = process.env.MR_QA_SCREENSHOT_DIR;
  const shot = async (name) => {
    const capture = await page.send("Page.captureScreenshot", { format: "png" });
    if (shotDir) {
      await fs.mkdir(shotDir, { recursive: true });
      await fs.writeFile(path.join(shotDir, name), Buffer.from(capture.data, "base64"));
    }
  };

  /* An unauthenticated HTTP start requests local pairing and displays failure. */
  await wait("document.querySelector('.pair-card .notice-error') !== null");
  assert.equal(sessionRequests, 1, "boot checks the session");
  assert.equal(localClaimRequests, 1, "401 requests local pairing");
  assert.equal(await page.eval("document.querySelectorAll('.card').length"), 0);
  assert.ok(await page.eval("document.querySelector('.pair-card button') !== null"));
  // A hash-only navigation would not reboot the app (boot clears and consumes
  // the fragment once); add a query so this is a fresh document navigation.
  await page.send("Page.navigate", {
    url: `http://127.0.0.1:${port}/?pair=1#pair_${"b".repeat(32)}`,
  });

  /* ---------------------------------------------------------------- pairing */
  await wait("document.querySelector('#pair-name') && document.querySelector('#pair-submit')");
  assert.equal(await page.eval("location.hash"), "");
  await page.eval(`
    document.querySelector('#pair-name').value = 'Phone';
    document.querySelector('#pair-submit').click();
  `);

  /* ---------------------------------------------------------------- library */
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Demo'))");
  assert.equal(
    await page.eval("document.querySelectorAll('.grid .card').length"),
    5,
    "the poster grid renders every book",
  );
  assert.ok(
    await page.eval("getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length >= 2"),
    "mobile grid is at least two columns",
  );
  assert.ok(
    await page.eval("!!document.querySelector('.card .poster img')"),
    "cover thumbnails render inside the poster frame",
  );
  await shot("library.png");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(120);
  await shot("library@2x.png");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  assert.equal(
    await page.eval("getComputedStyle(document.querySelector('.search-clear')).display"),
    "none",
    "the clear button stays hidden while the query is empty",
  );
  assert.ok(
    await page.eval("document.querySelectorAll('.bar-actions > *').length >= 3"),
    "language, theme and refresh controls share the header row",
  );
  await page.eval("document.querySelector('[data-testid=theme-cycle]').click()");
  await page.eval("document.querySelector('[data-testid=theme-cycle]').click()");
  await wait("document.documentElement.dataset.theme === 'dark'");
  await shot("library-dark.png");
  await page.eval("document.querySelector('[data-testid=theme-cycle]').click()");
  await wait("!document.documentElement.dataset.theme");

  /* ------------------------------------------------------------ open reader */
  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('Demo')).click()");
  await wait("document.querySelector('.reader') && document.querySelector('.tiles img')");
  assert.equal(await page.eval("document.querySelector('.pager').textContent.trim()"), "1 / 3");
  assert.equal(
    await page.eval("document.querySelector('.reader').dataset.mode"),
    "webtoon",
    "a 10:1 page defaults to webtoon mode",
  );
  assert.equal(
    await page.eval("document.querySelectorAll('.tapzones .zone').length"),
    9,
    "nine-grid tap zones are mounted",
  );
  assert.equal(
    await page.eval("getComputedStyle(document.querySelector('.tapzones')).pointerEvents"),
    "auto",
  );

  /* --------------------------------------------------- HUD toggle via centre */
  await page.eval(`document.querySelector('.tapzones .zone[data-row="1"][data-col="1"]').click()`);
  await wait("document.querySelector('.hud-bottom').dataset.hidden === 'true'");
  await page.eval(`document.querySelector('.tapzones .zone[data-row="1"][data-col="1"]').click()`);
  await wait("document.querySelector('.hud-bottom').dataset.hidden === 'false'");

  await shot("reader-webtoon.png");

  /* ------------------------------------------------ paged mode + tap zones */
  await page.eval("document.querySelector('[data-testid=mode-toggle]').click()");
  await wait("document.querySelector('.reader').dataset.mode === 'paged' && document.querySelector('.page-img')");
  assert.equal(
    await page.eval("document.querySelectorAll('.page-shell').length"),
    1,
    "paged mode renders exactly one page surface",
  );
  await shot("reader-paged.png");

  /* ------------------------------------------- tap zone → 409 → conflict UI */
  await page.eval(`document.querySelector('.tapzones .zone[data-row="1"][data-col="2"]').click()`);
  await wait("document.querySelector('#conflict-save') && document.querySelector('#conflict-save').closest('.sheet').dataset.open === 'true'");
  assert.deepEqual(lastWrite, { page: 1, baseRev: 4 }, "the first page turn writes {page, baseRev}");
  await page.eval("document.querySelector('#conflict-use').click()");
  await wait("document.querySelector('.pager').textContent.trim() === '3 / 3'");

  /* ------------------------------------------- left tap zone → CAS retry */
  await page.eval(`document.querySelector('.tapzones .zone[data-row="1"][data-col="0"]').click()`);
  await wait("document.querySelector('.pager').textContent.trim() === '2 / 3'");
  assert.deepEqual(lastWrite, { page: 1, baseRev: 7 }, "the retry carries the other device's revision");
  assert.equal(writes, 2);

  /* --------------------------------------------- back to webtoon + scrolling */
  await page.eval("document.querySelector('[data-testid=mode-toggle]').click()");
  await wait("document.querySelector('.reader').dataset.mode === 'webtoon' && document.querySelector('.tiles img')");
  await sleep(450);
  await page.eval("const s = document.querySelector('.stage'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })); s.scrollTo(0, 1100)");
  await sleep(1100);
  assert.equal(writes, 3, "long-page scrolling is saved after the throttle interval");
  assert.equal(lastWrite.page, 1);
  assert.equal(lastWrite.baseRev, 8);
  assert.equal(typeof lastWrite.scrollPct, "number");
  assert.ok(lastWrite.scrollPct > 0 && lastWrite.scrollPct < 1);
  const savedY = await page.eval("document.querySelector('.stage').scrollTop");
  assert.ok(savedY > 0, "the saved long-page position is below the page top");

  /* ------------------------------------- back to library, reopen at 520 px */
  await page.eval("document.querySelector('.hud-top button').click()");
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Demo'))");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 520,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('Demo')).click()");
  const expectedAtNewWidth = `(() => {
    const stage = document.querySelector('.stage');
    const tiles = document.querySelector('.tiles');
    if (!tiles || !stage) return false;
    const width = tiles.clientWidth;
    const pageHeight = Math.round(6400 / 640 * width);
    const total = pageHeight * 3;
    const top = ${lastWrite.scrollPct} * Math.max(1, total - stage.clientHeight);
    const local = Math.min(Math.max(0, pageHeight - stage.clientHeight), Math.max(0, top - pageHeight));
    return Math.abs(stage.scrollTop - local) < 3;
  })()`;
  await wait("document.querySelector('.tiles img') && " + expectedAtNewWidth);
  const pendingHeight = await page.eval(
    "document.querySelector('.tiles .tile-pending')?.getBoundingClientRect().height ?? null",
  );
  assert.ok(
    pendingHeight == null || pendingHeight > 844,
    "reserved tile placeholders keep their predicted aspect-ratio height",
  );
  await sleep(900);
  assert.equal(writes, 3, "programmatic restore does not create another progress write");
  await page.eval("document.querySelector('.stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })); document.querySelector('.stage').scrollBy(0, 120)");
  await sleep(1100);
  assert.equal(writes, 4, "a user scroll after restore is saved");

  /* ------------------------------------------- leaving clears the timer */
  await page.eval("document.querySelector('.stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 90 })); document.querySelector('.stage').scrollBy(0, 90)");
  await page.eval("document.querySelector('.hud-top button').click()");
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Demo'))");
  const writesAtLeave = writes;
  await sleep(1000);
  assert.equal(
    writes,
    writesAtLeave,
    "leaving the reader clears the trailing progress timer",
  );

  /* ------------------------------------------------------------- six locales */
  for (const language of ["zh-CN", "zh-TW", "en", "es", "ja", "ko"]) {
    await page.eval(`(() => {
      const select = document.querySelector('.lang-select');
      select.value = ${JSON.stringify(language)};
      select.dispatchEvent(new Event('change'));
    })()`);
    await wait(`document.documentElement.lang === ${JSON.stringify(language)} && document.querySelectorAll('.card').length > 0`);
  }
  await page.eval(`(() => {
    const select = document.querySelector('.lang-select');
    select.value = 'en';
    select.dispatchEvent(new Event('change'));
  })()`);
  await wait("document.documentElement.lang === 'en' && document.querySelectorAll('.card').length > 0");

  /* -------------------------------------------------------------- failures */
  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('PDF demo')).click()");
  await wait("document.querySelector('#app').textContent.includes('PDF reading is not available')");
  await page.eval("document.querySelector('#app button').click()");
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Faulty'))");

  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('Faulty')).click()");
  await wait("document.querySelector('.tile')");
  await page.eval("document.querySelector('.stage').scrollTo(0, 4000)");
  await wait("document.querySelector('.tile .notice-error') !== null");

  await page.eval("document.querySelector('.hud-top button').click()");
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Shorter'))");
  const writesBeforeShorter = writes;
  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('Shorter')).click()");
  await wait("document.querySelector('.pager')?.textContent.trim() === '2 / 2'");
  assert.equal(
    await page.eval("document.querySelector('.toast').dataset.open"),
    "true",
    "a clamped page shows the notice toast",
  );
  assert.equal(
    writes,
    writesBeforeShorter,
    "opening a shortened book must not silently write progress",
  );

  await page.eval("document.querySelector('.hud-top button').click()");
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Large'))");
  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('Large')).click()");
  await wait("document.querySelector('.tiles .notice-error')?.textContent.includes('too large to process safely')");

  /* ------------------------------------------------------------ pinch zoom */
  await page.eval("document.querySelector('.hud-top button').click()");
  await wait("[...document.querySelectorAll('.card')].some(x => x.textContent.includes('Demo'))");
  await page.eval("[...document.querySelectorAll('.card')].find(x => x.textContent.includes('Demo')).click()");
  await wait("document.querySelector('.tiles img') && document.querySelector('.reader').dataset.mode === 'webtoon'");
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await page.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 120, y: 400, id: 1 },
      { x: 300, y: 400, id: 2 },
    ],
  });
  await page.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 70, y: 400, id: 1 },
      { x: 350, y: 400, id: 2 },
    ],
  });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await wait(
    "parseFloat(getComputedStyle(document.querySelector('.reader')).getPropertyValue('--r-zoom')) > 1.3",
  );

  /* --------------------------------------------------------------- errors */
  const exceptions = page.events.filter(
    (event) =>
      event.method === "Runtime.exceptionThrown" &&
      !String(event.params?.exceptionDetails?.text || "").includes("ResizeObserver"),
  );
  assert.deepEqual(
    exceptions.map((event) => event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text),
    [],
    "the reader must not throw during the whole flow",
  );

  console.log(
    "VERIFIED D4 web reader: nine-grid taps, HUD, webtoon tiles, CAS conflict, scroll restore, 6 locales, failure surfaces.",
  );
} finally {
  if (page?.socket) page.socket.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5e3))]);
  }
  await new Promise((resolve) => server.close(resolve));
  // Chrome can release profile handles a moment after the parent exits. Retry
  // briefly and never let cleanup mask the test's original result.
  let profileRemoved = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(profile, { recursive: true, force: true });
      profileRemoved = true;
      break;
    } catch (error) {
      if (attempt === 5) {
        console.warn(
          `Cleanup warning: temporary profile not removed (${profile}): ${error.code || error.message}`,
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  console.log(`L2 resources: mock HTTP 127.0.0.1:${port ?? "not-started"}; owned headless Chrome PID ${child?.pid ?? "not-started"}; CDP ${cdpPort ?? "not-started"}.`);
  console.log(
    `Cleanup: owned Chrome stopped, mock server closed, temporary browser profile ${profileRemoved ? "removed" : "cleanup deferred"}.`,
  );
}
