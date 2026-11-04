import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpPage, waitForTarget } from "./lib/cdp.mjs";

// Only the disposable, loopback test browser ignores the test CA error.
// Neither the system trust store nor any normal browser profile is changed.
const targetUrl = process.env.MR_D4_TEST_URL;
assert.ok(targetUrl && /^https:\/\/127\.0\.0\.1:\d+\/#pair_[a-f0-9]{32}$/.test(targetUrl));
const chrome = process.env.MR_HEADLESS_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "moyu-real-tls-qa-"));
let child, page, cdpPort;
try {
  child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 150; i++) {
    try { cdpPort = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (cdpPort) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(cdpPort, "Chrome did not publish a CDP port");
  const target = await waitForTarget(cdpPort, (item) => item.url === "about:blank");
  page = await CdpPage.connect(target, cdpPort);
  await page.send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await page.send("Security.enable");
  await page.send("Security.setIgnoreCertificateErrors", {ignore: true});
  await page.send("Page.navigate", {url: targetUrl});
  const wait = async (expression) => {
    for (let i = 0; i < 200; i++) {
      try { if (await page.eval(expression)) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("browser condition timed out: " + expression);
  };
  await wait("document.querySelector('input') && document.querySelector('button.primary')");
  assert.equal(await page.eval("location.hash"), "");
  await page.eval("document.querySelector('input').value='Test browser'; document.querySelector('button.primary').click()");
  await wait("[...document.querySelectorAll('.book')].some(x=>x.textContent.includes('Synthetic Book'))");
  await page.eval("document.querySelector('.book').click()");
  await wait("document.querySelector('.tiles img')?.complete && document.querySelector('.tiles img')?.naturalWidth > 0 && document.querySelector('#tools')");
  assert.equal(await page.eval("document.querySelectorAll('.tiles > *').length"), 5, "1x10000 image must create five actual tiles");
  assert.equal(await page.eval("!!document.querySelector('.tiles .error')"), false);
  await page.eval("document.querySelector('#tools button.primary').click()");
  await wait("document.querySelector('#tools span')?.textContent.includes('2 / 2') && document.querySelector('.tiles img')?.naturalWidth > 0");
  console.log(`Browser PID ${child.pid}; CDP loopback port ${cdpPort}; real HTTPS pairing, image and progress flow passed.`);
} finally {
  if (page?.socket) page.socket.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  await fs.rm(profile, {recursive: true, force: true});
  console.log("Browser cleanup: owned process stopped; disposable profile removed.");
}
