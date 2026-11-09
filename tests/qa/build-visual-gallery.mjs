#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assemble the Task 14-4 acceptance gallery.
 *
 * Inputs (all gitignored under tests/qa/reports/):
 *   visual-snapshots/desktop/manifest.json  — desktop captures + metrics
 *   visual-snapshots/mobile/*.png           — mobile captures
 *   visual-snapshots/mobile/mobile-metrics.json
 *
 * Output: visual-gallery.html with relative image paths so it can be opened
 * directly from disk without a server.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = path.join(root, "tests", "qa", "reports", "visual-snapshots");
const desktopDir = path.join(base, "desktop");
const mobileDir = path.join(base, "mobile");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const desktopManifest = readJson(path.join(desktopDir, "manifest.json"));
const mobileMetrics = readJson(path.join(mobileDir, "mobile-metrics.json"));
const desktopByName = new Map(
  (desktopManifest?.desktop || []).map((item) => [item.name, item]),
);

const sections = [
  {
    title: "桌面端 · 书库（默认皮肤）",
    note: "1440×900 @2x；Moyu 字标、海报墙、已读完角标",
    items: [
      ["desktop/library-default-light", "Light", "desktop/desktop-library-default-light.png"],
      ["desktop/library-default-dark", "Dark", "desktop/desktop-library-default-dark.png"],
    ],
  },
  {
    title: "桌面端 · 设置总览（五分区 + 即时保存）",
    note: "居中弹窗与即时落盘；无底部保存栏",
    items: [
      ["desktop/settings-overview-light", "Light", "desktop/desktop-settings-overview-light.png"],
      ["desktop/settings-overview-dark", "Dark", "desktop/desktop-settings-overview-dark.png"],
    ],
  },
  {
    title: "桌面端 · 设置二级弹窗（快捷键）",
    note: "Dialog 打开态；Escape 关闭由 architecture 套件断言",
    items: [
      ["desktop/settings-dialog-light", "Light", "desktop/desktop-settings-dialog-open-light.png"],
      ["desktop/settings-dialog-dark", "Dark", "desktop/desktop-settings-dialog-open-dark.png"],
    ],
  },
  {
    title: "桌面端 · 六语快照（西班牙语 / 日语）",
    note: "长词条不撑破胶囊与网格",
    items: [
      ["desktop/settings-i18n-es", "es", "desktop/desktop-settings-i18n-es.png"],
      ["desktop/settings-i18n-ja", "ja", "desktop/desktop-settings-i18n-ja.png"],
    ],
  },
  {
    title: "手机端 · 局域网书库（390×844 @2x）",
    note: "2~3 列海报网格、进度胶囊、配对后会话",
    items: [
      ["mobile/library-light", "Light", "mobile/mobile-web-library-light.png"],
      ["mobile/library-dark", "Dark", "mobile/mobile-web-library-dark.png"],
    ],
  },
  {
    title: "手机端 · 阅读器 HUD 与纯享态",
    note: "九宫格热区；HUD 触控热区 ≥40px；CLS=0",
    items: [
      ["mobile/reader-hud-open", "HUD 展开", "mobile/mobile-web-reader-hud-open.png"],
      ["mobile/reader-clean", "纯享", "mobile/mobile-web-reader-clean.png"],
    ],
  },
];

function exists(relative) {
  return fs.existsSync(path.join(base, relative));
}

function metricLine(relative) {
  const name = path.basename(relative);
  const desktop = desktopByName.get(name);
  if (desktop) {
    return `DOM ${desktop.domNodes} · 横向溢出 ${desktop.overflowX}px · 最小热区 ${desktop.minTarget ?? "n/a"}px · ${desktop.theme}`;
  }
  if (mobileMetrics && relative.startsWith("mobile/")) {
    return `视口 ${mobileMetrics.viewport} · HUD 最小热区 ${mobileMetrics.hudMinTarget ?? "n/a"}px · CLS ${mobileMetrics.cls ?? "n/a"} · revoke 401=${mobileMetrics.revokedSessionStatus ?? "n/a"}`;
  }
  return "指标缺失";
}

const cards = sections
  .map((section) => {
    const figures = section.items
      .map(([label, badge, relative]) => {
        const available = exists(relative);
        return `
          <figure class="shot ${available ? "" : "missing"}">
            <div class="shot-head"><span>${escapeHtml(badge)}</span><span class="path">${escapeHtml(label)}</span></div>
            ${
              available
                ? `<img src="visual-snapshots/${escapeHtml(relative)}" alt="${escapeHtml(section.title)} ${escapeHtml(badge)}" loading="lazy" />`
                : `<div class="placeholder">未捕获<br /><code>${escapeHtml(relative)}</code></div>`
            }
            <figcaption>${escapeHtml(metricLine(relative))}</figcaption>
          </figure>`;
      })
      .join("");
    return `
      <section class="group">
        <header><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.note)}</p></header>
        <div class="pair">${figures}</div>
      </section>`;
  })
  .join("");

const desktopCount = desktopManifest?.desktop?.length ?? 0;
const mobileCount = mobileMetrics ? 4 : 0;
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Moyu · 视觉验收画廊</title>
<style>
  :root { color-scheme: light; --ink:#09090b; --muted:#64748b; --line:#cbd5e1; --bg:#eff8ff; --card:#fff; --accent:#38a8f8; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; font-family: "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  h1 { margin:0 0 6px; font-size:26px; letter-spacing:-0.02em; }
  .lede { margin:0 0 28px; color:var(--muted); font-size:13px; }
  .badges { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 28px; }
  .badges span { border:1px solid var(--line); background:var(--card); border-radius:999px; padding:5px 12px; font-size:11px; font-weight:700; }
  .group { background:var(--card); border:1px solid var(--line); border-radius:24px; padding:20px; margin:0 0 24px; box-shadow:0 8px 0 0 #0f172a; }
  .group header { display:flex; flex-wrap:wrap; align-items:baseline; gap:10px 18px; margin:0 0 16px; }
  h2 { margin:0; font-size:15px; letter-spacing:-0.01em; }
  .group header p { margin:0; color:var(--muted); font-size:12px; }
  .pair { display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:18px; }
  .shot { margin:0; min-width:0; border:1px solid var(--line); border-radius:18px; overflow:hidden; background:#f8fafc; }
  .shot-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:9px 12px; border-bottom:1px solid var(--line); font-size:11px; font-weight:700; }
  .shot-head .path { color:var(--muted); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .shot img { display:block; width:100%; height:auto; max-height:720px; object-fit:contain; background:#fff; }
  .shot figcaption { padding:8px 12px; border-top:1px solid var(--line); color:var(--muted); font-size:10.5px; font-variant-numeric:tabular-nums; }
  .placeholder { display:grid; place-items:center; min-height:240px; color:var(--muted); font-size:12px; text-align:center; padding:24px; }
  .missing { border-style:dashed; }
  code { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:10px; }
  @media (max-width:720px) { body { padding:18px; } .pair { grid-template-columns:1fr; } }
</style>
</head>
<body>
  <h1>Moyu · 视觉验收画廊</h1>
  <p class="lede">生成于 ${escapeHtml(desktopManifest?.capturedAt || new Date().toISOString())}。桌面端 1440×900 @2x，手机端 390×844 @2x。全部图片位于 <code>tests/qa/reports/visual-snapshots/</code>（gitignored）。</p>
  <div class="badges">
    <span>桌面截图 ${desktopCount}</span>
    <span>手机截图 ${mobileCount}</span>
    <span>桌面最小热区 ${escapeHtml(String(desktopManifest?.desktop?.reduce((min, item) => Math.min(min, item.minTarget ?? Infinity), 44)))}px</span>
    <span>手机 HUD 最小热区 ${escapeHtml(String(mobileMetrics?.hudMinTarget ?? "n/a"))}px</span>
    <span>条漫滚动 CLS ${escapeHtml(String(mobileMetrics?.cls ?? "n/a"))}</span>
    <span>配对 revoke 后 401 ${escapeHtml(String(mobileMetrics?.revokedSessionStatus ?? "n/a"))}</span>
  </div>
  ${cards}
</body>
</html>`;

const out = path.join(base, "..", "visual-gallery.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, "utf8");
console.log(`Visual gallery: ${out}`);
console.log(
  `Desktop captures: ${desktopCount}; mobile metrics: ${mobileMetrics ? "present" : "missing"}`,
);
