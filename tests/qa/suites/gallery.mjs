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

const VIEWPORT_LIMIT = { width: 1440, height: 900, deviceScaleFactor: 2 };
let VIEWPORT = { ...VIEWPORT_LIMIT };

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

/**
 * 21-1 acceptance fixtures for the gallery: mark a few books as favourites and
 * attach two visible tags. Commands are the real Tauri commands; no UI text is
 * faked. Idempotent so a rerun on the same QA data dir reuses the tags.
 */
async function seedLibraryHighlights(ctx) {
  const page = ctx.page;
  const targets = (ctx.books || [])
    .filter((book) => book.format !== "pdf")
    .slice(0, 3);
  if (targets.length === 0) {
    return { error: "no non-PDF fixture books" };
  }
  for (const book of targets) {
    await invoke(page, "set_book_favorite", {
      bookId: book.id,
      favorite: true,
    });
  }
  let tags = [];
  try {
    tags = await invoke(page, "list_tags");
  } catch {
    tags = [];
  }
  const ensureTag = async (name, color) => {
    const existing = tags.find((tag) => tag.name === name);
    if (existing) return existing.id;
    const created = await invoke(page, "create_tag", { name, color });
    tags.push(created);
    return created.id;
  };
  const featured = await ensureTag("精选", "#38A8F8");
  const ongoing = await ensureTag("连载", "#F59E0B");
  const artbook = await ensureTag("画集", "#8B5CF6");
  for (const [index, book] of targets.entries()) {
    await invoke(page, "set_book_tags", {
      bookId: book.id,
      tagIds: index % 2 === 0 ? [featured, ongoing] : [featured, artbook],
    });
  }
  return {
    favorites: targets.map((book) => book.id),
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
  };
}

/** Put favourites first so the star + tag pills are inside the first viewport. */
async function sortFavoritesFirst(ctx) {
  return ctx.page.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent.trim() === "收藏置顶",
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function openSkinGallery(ctx) {
  await ctx.goto("#/settings");
  await ctx.page.waitFor(`!!document.querySelector('[data-testid="settings-tab-general"]')`, {
    timeout: 15_000,
    label: "settings for skin gallery",
  });
  const opened = await ctx.page.eval(`(() => {
    const node = document.querySelector('[data-testid="skin-open"]');
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!opened) return false;
  await ctx.page.waitFor(
    `!!document.querySelector('[role="dialog"] [data-testid="skin-gallery"]')`,
    { timeout: 15_000, label: "skin gallery dialog" },
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  return true;
}

async function closeDialog(ctx) {
  await ctx.page.key("Escape").catch(() => {});
  await ctx.page
    .waitFor(`!document.querySelector('[role="dialog"]')`, {
      timeout: 3000,
      label: "dialog closed",
    })
    .catch(() => {});
}

async function selectSkin(ctx, id) {
  const selected = await ctx.page.eval(`(() => {
    const card = document.querySelector('[data-testid="skin-card-${id}"]');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  if (!selected) return false;
  await ctx.page
    .waitFor(
      `document.documentElement.dataset.mrSkin === ${JSON.stringify(id)}`,
      { timeout: 5000, label: `skin ${id}` },
    )
    .catch(() => {});
  return true;
}

export async function runGallerySuite(ctx, report) {
  const dir = outputDir(ctx.root);
  fs.mkdirSync(dir, { recursive: true });
  const captures = [];
  const page = ctx.page;

  // CDP viewport emulation larger than the real window makes the app look
  // clipped to anyone watching the QA window (the right edge is outside the
  // native client area). Cap the captured viewport to the actual window so the
  // screenshot and the visible UI describe the same layout.
  const native = await page
    .eval("({ width: window.innerWidth, height: window.innerHeight })")
    .catch(() => ({ width: VIEWPORT_LIMIT.width, height: VIEWPORT_LIMIT.height }));
  VIEWPORT = {
    ...VIEWPORT_LIMIT,
    width: Math.max(320, Math.min(VIEWPORT_LIMIT.width, Number(native.width) || 0)),
    height: Math.max(240, Math.min(VIEWPORT_LIMIT.height, Number(native.height) || 0)),
  };

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

  let highlightEvidence = null;
  try {
    highlightEvidence = await seedLibraryHighlights(ctx);
  } catch (error) {
    highlightEvidence = { error: String(error) };
  }

  for (const theme of ["light", "dark"]) {
    await ctx.setTheme(theme);
    await applyViewport(ctx.page);
    await waitForLibrary(ctx);
    captures.push(await capture(ctx.page, dir, `desktop-library-default-${theme}.png`));
  }

  for (const theme of ["light", "dark"]) {
    await ctx.setTheme(theme);
    await applyViewport(ctx.page);
    await waitForLibrary(ctx);
    await sortFavoritesFirst(ctx);
    await new Promise((resolve) => setTimeout(resolve, 400));
    captures.push(
      await capture(ctx.page, dir, `desktop-library-tags-favorites-${theme}.png`),
    );
  }

  for (const theme of ["light", "dark"]) {
    await ctx.setTheme(theme);
    await applyViewport(ctx.page);
    const opened = await openSkinGallery(ctx);
    if (!opened) continue;
    captures.push(
      await capture(ctx.page, dir, `desktop-skin-gallery-dialog-${theme}.png`),
    );
    const ink = await selectSkin(ctx, "ink");
    await closeDialog(ctx);
    if (ink) {
      await waitForLibrary(ctx);
      captures.push(
        await capture(ctx.page, dir, `desktop-library-framed-skin-${theme}.png`),
      );
    }
    // Reset to the default skin so the next theme starts from a known canvas.
    if (await openSkinGallery(ctx)) {
      await selectSkin(ctx, "default");
      await closeDialog(ctx);
    }
    await page.eval(`localStorage.removeItem("mr-skin"); true`).catch(() => {});
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
      const node = document.querySelector('[data-testid="shortcuts-open"]');
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (opened) {
      await ctx.page
        .waitFor(`!!document.querySelector('[role="dialog"]')`, {
          timeout: 5000,
          label: "settings dialog",
        })
        .catch(() => {});
      captures.push(await capture(ctx.page, dir, `desktop-settings-dialog-open-${theme}.png`));
      await ctx.page.key("Escape").catch(() => {});
      await ctx.page
        .waitFor(`!document.querySelector('[role="dialog"]')`, {
          timeout: 3000,
          label: "settings dialog closed",
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

  await ctx.setLocale("zh-CN");
  await page.eval(`localStorage.removeItem("mr-skin"); true`).catch(() => {});

  const manifest = {
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    finishedEvidence,
    highlightEvidence,
    desktop: captures,
    note:
      "桌面截图按当前窗口 CSS 视口（不超过 1440×900）× DPR 2 截取，避免模拟视口大于真实窗口造成右侧裁切；移动端截图由 tests/qa/web-reader-headless.mjs 在 390×844 / DPR 2 下截取。",
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  if (highlightEvidence?.error) {
    fail(report, {
      id: "gallery:library-highlights",
      suite: "gallery",
      layer: "e2e",
      title: "收藏与标签验收数据准备失败",
      severity: "P1",
      details: String(highlightEvidence.error),
      location: "tests/qa/suites/gallery.mjs",
    });
  }
  const details = `${captures.length} 张截图；DOM 节点 ${captures.map((item) => item.domNodes).join("/")}；横向溢出 ${captures.map((item) => item.overflowX).join("/")}px；最小热区 ${captures.map((item) => item.minTarget ?? "n/a").join("/")}px`;
  if (captures.length < 14) {
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
