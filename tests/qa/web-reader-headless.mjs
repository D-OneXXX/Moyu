import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CdpPage, waitForTarget } from "./lib/cdp.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reader = path.join(root, "src-tauri/src/web_access/reader");
const chrome = process.env.MR_HEADLESS_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-web-reader-qa-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2WQAAAABJRU5ErkJggg==", "base64");
const id = "a".repeat(64);
let paired = false, writes = 0, lastWrite = null;
let progressState = { page: 0, pageCount: 3, scrollPct: -1, rev: 4 };
const assets = /* @__PURE__ */ new Map([
  ["/", [path.join(reader, "index.html"), "text/html"]],
  ["/reader.js", [path.join(reader, "reader.js"), "text/javascript"]],
  ["/reader.css", [path.join(reader, "reader.css"), "text/css"]],
  ["/reader-messages.js", [path.join(root, "src/i18n/messages/webReader.ts"), "text/javascript"]]
]);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (assets.has(url.pathname)) {
    const [file, type] = assets.get(url.pathname);
    res.writeHead(200, { "content-type": type, "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" });
    res.end(await fs.readFile(file));
    return;
  }
  if (url.pathname === "/reader-theme.css") {
    const css = await fs.readFile(path.join(root, "src/index.css"), "utf8");
    const tokens = (marker) => css.split(marker)[1].split("}")[0].split("\n").map(s=>s.trim()).filter(s=>s.startsWith("--sh-")).join("");
    res.writeHead(200, {"content-type":"text/css"});
    res.end(`:root{${tokens(":root {")}}@media(prefers-color-scheme:dark){:root{${tokens('[data-theme="dark"] {')}}}`);
    return;
  }
  const json = (status, data) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "POST" && url.pathname === "/api/pair/claim") {
    let raw = "";
    for await (const c of req) raw += c;
    const claim = JSON.parse(raw);
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
    if (paired) json(200, { deviceName: "test" });
    else json(401, { error: { code: "unauthorized" } });
    return;
  }
  if (url.pathname === "/api/books") {
    json(200, { items: [{ id, title: "Demo", thumbUrl: `/api/books/${id}/thumb`, format: "image" }, { id: "c".repeat(64), title: "PDF demo", format: "pdf" }, { id: "e".repeat(64), title: "Faulty", format: "image" }, { id: "f".repeat(64), title: "Shorter", format: "image" }, { id: "b".repeat(64), title: "Large", format: "image" }], nextCursor: null });
    return;
  }
  if (/^\/api\/books\/[a-f0-9]{64}\/layout$/.test(url.pathname)) {
    const bookId = url.pathname.split("/")[3];
    const count = bookId === "f".repeat(64) ? 2 : 3;
    const height = bookId === "e".repeat(64) ? 3000 : 6400;
    json(200, { pages: Array.from({ length: count }, (_, index) => ({ index, width: 640, height })) });
    return;
  }
  if (url.pathname.endsWith("/thumb")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
    return;
  }
  if (url.pathname.endsWith("/progress") && req.method === "GET") {
    json(200, url.pathname.includes("f".repeat(64)) ? { page: 5, pageCount: 2, scrollPct: -1, rev: 4 } : { ...progressState });
    return;
  }
  if (url.pathname.endsWith("/progress") && req.method === "PUT") {
    assert.equal(req.headers["x-moyu-request"], "1");
    let raw = "";
    for await (const c of req) raw += c;
    lastWrite = JSON.parse(raw);
    writes++;
    if (writes === 1) {
      progressState = { page: 2, pageCount: 3, scrollPct: 0.4, rev: 7 };
      json(409, { error: { code: "progress-conflict", details: { currentPage: 2, currentRev: 7 } } });
    } else {
      progressState = { page: lastWrite.page, pageCount: 3, scrollPct: lastWrite.scrollPct ?? -1, rev: progressState.rev + 1 };
      json(200, { page: progressState.page, rev: progressState.rev });
    }
    return;
  }
  if (url.pathname.includes("/tiles/")) {
    if (url.pathname.includes("b".repeat(64))) { json(422, {error: {code: "webtoon-too-large"}}); return; }
    const faulty = url.pathname.includes("e".repeat(64));
    if (faulty && url.pathname.endsWith("/tiles/1")) { json(500, {error: {code: "internal"}}); return; }
    res.writeHead(200, { "content-type": "image/png", "x-tile-count": faulty ? "2" : "1", "x-tile-height": "2048" });
    res.end(png);
    return;
  }
  json(404, { error: { code: "not-found" } });
});
let child, page, port, cdpPort;
try {
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (err) => err ? reject(err) : resolve()));
  port = server.address().port;
  child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/#pair_${"b".repeat(32)}`], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 150; i++) {
    try {
      cdpPort = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      if (cdpPort) break;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(cdpPort, "Chrome did not publish a CDP port");
  const target = await waitForTarget(cdpPort, (entry) => entry.url.includes(`127.0.0.1:${port}`));
  page = await CdpPage.connect(target, cdpPort);
  await page.send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  const wait = async (expr) => {
    for (let i = 0; i < 100; i++) {
      if (await page.eval(expr)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Timed out: " + expr);
  };
  await wait("document.querySelector('input') && document.querySelector('button.primary')");
  assert.equal(await page.eval("location.hash"), "");
  await page.eval("document.querySelector('input').value='Phone'; document.querySelector('button.primary').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Demo'))");
  await page.eval("document.querySelector('.book').click()");
  await wait("document.querySelector('.tiles img') && document.querySelector('#tools')");
  const capture = await page.send("Page.captureScreenshot", {format: "png"});
  await fs.writeFile(path.join(profile, "web-reader-headless.png"), Buffer.from(capture.data, "base64"));
  await page.eval("document.querySelector('#tools button.primary').click()");
  await wait("document.querySelector('#tools .error') !== null");
  assert.deepEqual(lastWrite, { page: 1, baseRev: 4 });
  await page.eval("document.querySelector('#tools .error button:last-child').click()");
  await wait("document.querySelector('#tools span')?.textContent.includes('2 / 3')");
  assert.deepEqual(lastWrite, { page: 1, baseRev: 7 });
  assert.equal(writes, 2);
  await page.eval("const tiles=document.querySelector('.tiles'); window.scrollTo(0, tiles.getBoundingClientRect().top + window.scrollY + 1100)");
  await new Promise((resolve) => setTimeout(resolve, 1e3));
  assert.equal(writes, 3, "long-page scrolling is saved after the throttle interval");
  assert.equal(lastWrite.page, 1);
  assert.equal(lastWrite.baseRev, 8);
  assert.equal(typeof lastWrite.scrollPct, "number");
  assert.ok(lastWrite.scrollPct > 0 && lastWrite.scrollPct < 1);
  const savedY = await page.eval("window.scrollY");
  assert.ok(savedY > 0, "the saved long-page position is below the page top");
  await page.eval("document.querySelector('#tools button').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Demo'))");
  await page.send("Emulation.setDeviceMetricsOverride", {width: 520, height: 844, deviceScaleFactor: 1, mobile: true});
  await page.eval("document.querySelector('.book').click()");
  const expectedAtNewWidth = `(()=>{const tiles=document.querySelector('.tiles');if(!tiles)return false;const width=tiles.clientWidth;const pageHeight=Math.round(6400/640*width);const total=pageHeight*3;const top=${lastWrite.scrollPct}*Math.max(1,total-window.innerHeight);const local=Math.min(Math.max(0,pageHeight-window.innerHeight),Math.max(0,top-pageHeight));return Math.abs(window.scrollY-(tiles.getBoundingClientRect().top+window.scrollY+local))<3})()`;
  await wait("document.querySelector('.tiles img') && " + expectedAtNewWidth);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(writes, 3, "programmatic restore does not create another progress write");
  await page.eval("window.scrollBy(0,120)");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(writes, 4, "a user scroll after restore is saved");
  await page.eval("window.scrollBy(0,90)");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await page.eval("document.querySelector('#tools button').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Demo'))");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(writes, 4, "leaving the reader clears the trailing progress timer");
  await page.eval("document.querySelector('.book').click()");
  await wait("document.querySelector('.tiles img')");
  for (const language of ["zh-CN", "zh-TW", "en", "es", "ja", "ko"]) {
    await page.eval(`document.querySelector('select').value=${JSON.stringify(language)}; document.querySelector('select').dispatchEvent(new Event('change'))`);
    await wait(`document.documentElement.lang===${JSON.stringify(language)} && document.querySelector('.tiles img')`);
  }
  await page.eval("document.querySelector('select').value='en'; document.querySelector('select').dispatchEvent(new Event('change'))");
  await wait("document.documentElement.lang==='en' && document.querySelector('#tools')");
  await page.eval("document.querySelector('#tools button').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('PDF demo'))");
  await page.eval("[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('PDF demo')).click()");
  await wait("document.querySelector('#app').textContent.includes('PDF reading is not available')");
  await page.eval("document.querySelector('#app button').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Faulty'))");
  await page.eval("[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('Faulty')).click()");
  await wait("document.querySelector('.tiles > div .error button') !== null");
  await page.eval("document.querySelector('#tools button').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Shorter'))");
  await page.eval("[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('Shorter')).click()");
  await wait("document.querySelector('#tools span')?.textContent.includes('2 / 2') && document.querySelector('.reader .panel')?.textContent.includes('beyond the end')");
  assert.equal(writes, 4, "opening a shortened book must not silently write progress");
  await page.eval("document.querySelector('#tools button').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Large'))");
  await page.eval("[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('Large')).click()");
  await wait("document.querySelector('.tiles .error')?.textContent.includes('too large to process safely')");
  console.log("VERIFIED simulated browser flow with page-level progress recovery and throttled CAS writes.");
} finally {
  if (page?.socket) page.socket.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5e3))]);
  }
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
  console.log(`L2 resources: mock HTTP 127.0.0.1:${port ?? "not-started"}; owned headless Chrome PID ${child?.pid ?? "not-started"}; CDP ${cdpPort ?? "not-started"}.`);
  console.log("Cleanup: owned Chrome stopped, mock server closed, temporary browser profile removed.");
}
