import fs from "node:fs";
import path from "node:path";
import { invoke } from "../lib/app.mjs";
import { fail, ok } from "../lib/report.mjs";

/**
 * Visual acceptance gallery (Task 14-4).
 *
 * Captures deterministic desktop views at 1440×900 with DPR 2. The mobile
 * views are produced by `tests/qa/web-reader-headless.mjs` with
 * `MR_QA_SCREENSHOT_DIR`; `tests/qa/build-visual-gallery.mjs` assembles both
 * sets into `tests/qa/reports/visual-gallery.html`.
 *
 * This suite launches the visible QA app (L3 locally) but never moves the
 * system cursor, steals focus or injects global hotkeys; all input goes
 * through WebView2 CDP.
 */

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };

function outputDir(root) {
  return path.join(root, "tests", "qa", "reports", "visual-snapshots", "desktop");
}

async function applyViewport(page) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
  });
}

async function metrics(page) {
  return page.eval(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const targets = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
      .filter((element) => element.getAttribute("aria-hidden") !== "true")
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      });
    const minTarget = targets.length
      ? Math.min(...targets.flatMap((item) => [item.width, item.height]))
      : null;
    const root = document.documentElement;
    return {
      domNodes: document.querySelectorAll("*").length,
      overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
      minTarget,
      targets: targets.length,
      theme: root.dataset.theme || "system",
      lang: root.lang,
    };
  })()`);
}

async function capture(page, dir, name) {
  await page.waitFor("!!document.querySelector('main') || !!document.querySelector('.reader-root')", {
    timeout: 10_000,
    label: name,
  });
  const stats = await metrics(page);
  const file = path.join(dir, name);
  await page.screenshot(file);
  return { name, file, ...stats };
}

async function waitForLibrary(ctx) {
  await ctx.goto("#/");
  await ctx.page.waitFor(
    `document.querySelectorAll('[role="button"][aria-label]').length > 0`,
    { timeout: 15_000, label: "library cards" },
  );
  // Give the lazy poster wall and backend thumbnails a deterministic settle
  // window so the gallery does not capture empty skeletons.
  await ctx.page
    .waitFor(
      `[...document.querySelectorAll('main img')].some((img) => img.complete && img.naturalWidth > 0)`,
      { timeout: 8000, label: "library thumbnails" },
    )
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

export async function runGallerySuite(ctx, report) {
  const dir = outputDir(ctx.root);
  fs.mkdirSync(dir, { recursive: true });
  const captures = [];
  const page = ctx.page;

  // Mark one fixture as finished so the library shows the 100% badge.
  const finishedCandidate =
    (ctx.books || []).find(
      (book) => book.title === "QA Long Webtoon" && book.pageCount > 1,
    ) ||
    (ctx.books || []).find(
      (book) => book.pageCount > 1 && book.sourceType === "local",
    );
  let finishedEvidence = null;
  if (finishedCandidate) {
    try {
      await invoke(page, "set_progress", {
        bookId: finishedCandidate.id,
        page: finishedCandidate.pageCount - 1,
        scrollPct: null,
      });
      const list = await invoke(page, "list_books", { query: null });
      const updated = list.find((book) => book.id === finishedCandidate.id);
      finishedEvidence = {
        id: finishedCandidate.id,
        expectedPage: finishedCandidate.pageCount - 1,
        actualPage: updated?.currentPage ?? null,
      };
    } catch (error) {
      finishedEvidence = { id: finishedCandidate.id, error: String(error) };
    }
  }

  await ctx.setLocale("zh-CN");
  // Flat + most-recent ordering keeps the finished fixture visible in the
  // first viewport instead of hiding it inside a series group.
  await page.eval(
    `localStorage.setItem("mr-library-group-series", "0"); localStorage.setItem("mr-library-source-filter", "all"); true`,
  );
  await applyViewport(ctx.page);

  for (const theme of ["light", "dark"]) {
    await ctx.setTheme(theme);
    await applyViewport(ctx.page);
    await waitForLibrary(ctx);
    captures.push(await capture(ctx.page, dir, `desktop-library-default-${theme}.png`));
  }

  for (const theme of ["light", "dark"]) {
    await ctx.setTheme(theme);
    await applyViewport(ctx.page);
    await ctx.goto("#/settings");
    await ctx.page.waitFor(`!!document.querySelector('[data-testid="settings-tab-general"]')`, {
      timeout: 15_000,
      label: "settings overview",
    });
    captures.push(await capture(ctx.page, dir, `desktop-settings-overview-${theme}.png`));
    const opened = await ctx.page.eval(`(() => {
      const node = document.querySelector('[data-testid="skin-open"]');
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (opened) {
      await ctx.page
        .waitFor(`!!document.querySelector('[data-slot="sheet-content"]')`, {
          timeout: 5000,
          label: "settings drawer",
        })
        .catch(() => {});
      captures.push(await capture(ctx.page, dir, `desktop-settings-drawer-open-${theme}.png`));
      await ctx.page.key("Escape").catch(() => {});
      await ctx.page
        .waitFor(`!document.querySelector('[data-slot="sheet-content"]')`, {
          timeout: 3000,
          label: "settings drawer closed",
        })
        .catch(() => {});
    }
  }

  for (const locale of ["es", "ja"]) {
    await ctx.setLocale(locale);
    await applyViewport(ctx.page);
    await ctx.setTheme("light");
    await applyViewport(ctx.page);
    await ctx.goto("#/settings");
    await ctx.page.waitFor(`!!document.querySelector('[data-testid="settings-tab-general"]')`, {
      timeout: 15_000,
      label: `settings ${locale}`,
    });
    captures.push(await capture(ctx.page, dir, `desktop-settings-i18n-${locale}.png`));
  }

  // Mascot / decoration skin last: set the preference and reload so
  // SkinProvider picks it up exactly as a real restart would. Keeping this
  // after the settings captures avoids carrying the skin into the overview.
  await ctx.setLocale("zh-CN");
  await page.eval(`localStorage.setItem("mr-skin", "ink-companion"); true`);
  await ctx.resetWorkspace();
  await applyViewport(ctx.page);
  for (const theme of ["light", "dark"]) {
    await ctx.setTheme(theme);
    await applyViewport(ctx.page);
    await waitForLibrary(ctx);
    captures.push(await capture(ctx.page, dir, `desktop-library-mascot-${theme}.png`));
  }
  await page.eval(`localStorage.removeItem("mr-skin"); true`).catch(() => {});

  const manifest = {
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    finishedEvidence,
    desktop: captures,
    note:
      "桌面截图由 WebView2 CDP 在 1440×900 / DPR 2 下截取；移动端截图由 tests/qa/web-reader-headless.mjs 在 390×844 / DPR 2 下截取。",
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  const details = `${captures.length} 张截图；DOM 节点 ${captures.map((item) => item.domNodes).join("/")}；横向溢出 ${captures.map((item) => item.overflowX).join("/")}px；最小热区 ${captures.map((item) => item.minTarget ?? "n/a").join("/")}px`;
  if (captures.length < 8) {
    fail(report, {
      id: "gallery:capture-count",
      suite: "gallery",
      layer: "e2e",
      title: "视觉验收截图不足",
      severity: "P1",
      details,
      location: "tests/qa/suites/gallery.mjs",
    });
    return;
  }
  ok(report, {
    id: "gallery:desktop-captures",
    suite: "gallery",
    layer: "e2e",
    title: "桌面端 1440×900 @2x 视觉快照与布局指标",
    details,
  });
}
