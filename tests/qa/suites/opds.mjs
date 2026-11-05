import { invoke, invokeSafe } from "../lib/app.mjs";
import { fail, ok } from "../lib/report.mjs";

function pageCount(book) {
  return book?.page_count ?? book?.pageCount ?? 0;
}

function isDataImage(value) {
  return /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(value || "");
}

/**
 * OPDS 1.2 isolated acceptance:
 * - Komga-shaped catalog with Basic auth;
 * - root → library → chapter, cover proxying and CBZ download;
 * - the downloaded chapter is readable through the normal page pipeline;
 * - switching the configured URL to a Kavita-shaped catalog needs no code change;
 * - cross-origin and invalid URLs fail closed.
 */
export async function runOpdsSuite(ctx, report) {
  const page = ctx.page;
  const fixture = ctx.onlineFixture;
  const opds = fixture?.opds;
  if (!opds) {
    fail(report, {
      id: "opds:fixture-missing",
      suite: "opds",
      layer: "infrastructure",
      title: "OPDS 隔离夹具未启动",
      severity: "P0",
      location: "tests/qa/lib/online-fixture.mjs",
    });
    return;
  }

  const downloaded = [];
  try {
    const komgaUrl = `${fixture.origin}${opds.komgaRoot}`;
    const saved = await invoke(page, "opds_set_config", {
      config: {
        enabled: true,
        url: komgaUrl,
        username: opds.username,
        password: opds.password,
      },
    });
    const serializedConfig = JSON.stringify(saved);
    const configOk =
      saved.enabled === true &&
      saved.url === komgaUrl &&
      saved.username === opds.username &&
      saved.hasPassword === true &&
      !serializedConfig.includes(opds.password);
    if (!configOk) {
      fail(report, {
        id: "opds:config-local",
        suite: "opds",
        layer: "integration",
        title: "OPDS 配置未正确落库或密码回传给了前端",
        severity: "P1",
        details: serializedConfig,
        location: "src-tauri/src/opds.rs / opds_get_config",
        expected: "enabled=true、URL/用户名正确、hasPassword=true、响应不含密码",
        actual: serializedConfig,
      });
    } else {
      ok(report, {
        id: "opds:config-local",
        suite: "opds",
        layer: "integration",
        title: "OPDS 配置仅本地保存，密码不回传前端",
      });
    }

    const root = await invoke(page, "opds_browse", { url: null });
    const rootOk =
      root.title === "QA Komga Catalog" &&
      Array.isArray(root.entries) &&
      root.entries.length === 2 &&
      typeof root.entries[0]?.navigationUrl === "string";
    if (!rootOk) {
      fail(report, {
        id: "opds:komga-root",
        suite: "opds",
        layer: "integration",
        title: "Komga 形状根目录未列出两个书库",
        severity: "P1",
        details: JSON.stringify(root),
        location: "src-tauri/src/opds.rs feed_view",
      });
    } else {
      ok(report, {
        id: "opds:komga-root",
        suite: "opds",
        layer: "integration",
        title: "Komga 形状根目录列出书库",
        details: root.title,
      });
    }

    const library = await invoke(page, "opds_browse", {
      url: root.entries[0].navigationUrl,
    });
    const libraryOk =
      library.title === "QA Library One" &&
      library.entries.length === 2 &&
      typeof library.entries[0]?.coverUrl === "string" &&
      typeof library.entries[0]?.downloadUrl === "string" &&
      library.entries[0]?.archive === "zip" &&
      typeof library.nextUrl === "string";
    if (!libraryOk) {
      fail(report, {
        id: "opds:komga-library",
        suite: "opds",
        layer: "integration",
        title: "书库目录未列出章节/封面/下载/翻页",
        severity: "P1",
        details: JSON.stringify(library),
        location: "src-tauri/src/opds.rs feed_view",
      });
    } else {
      ok(report, {
        id: "opds:komga-library",
        suite: "opds",
        layer: "integration",
        title: "书库目录列出章节、封面、下载与翻页",
        details: `${library.entries.length} 章 · next=${library.nextUrl}`,
      });
    }

    const page2 = await invoke(page, "opds_browse", { url: library.nextUrl });
    const page2Ok =
      page2.title.includes("Page 2") && page2.entries.length === 1;
    if (!page2Ok) {
      fail(report, {
        id: "opds:pagination",
        suite: "opds",
        layer: "integration",
        title: "OPDS 下一页未返回第二页目录",
        severity: "P2",
        details: JSON.stringify(page2),
        location: "src-tauri/src/opds.rs feed_view",
      });
    } else {
      ok(report, {
        id: "opds:pagination",
        suite: "opds",
        layer: "integration",
        title: "OPDS next 链接可翻页",
      });
    }

    const cover = await invoke(page, "opds_cover", {
      url: library.entries[0].coverUrl,
    });
    if (!isDataImage(cover?.dataUrl) || cover.width <= 0 || cover.height <= 0) {
      fail(report, {
        id: "opds:cover",
        suite: "opds",
        layer: "integration",
        title: "OPDS 封面未由后端代理为可显示图片",
        severity: "P2",
        details: JSON.stringify({
          mime: cover?.mime,
          width: cover?.width,
          height: cover?.height,
          prefix: cover?.dataUrl?.slice(0, 32),
        }),
        location: "src-tauri/src/commands.rs opds_cover",
        expected: "data:image/...;base64 且宽高 > 0",
        actual: cover?.mime,
      });
    } else {
      ok(report, {
        id: "opds:cover",
        suite: "opds",
        layer: "integration",
        title: "OPDS 封面经同源代理缩放后返回",
        details: `${cover.width}×${cover.height} ${cover.mime}`,
      });
    }

    const first = await invoke(page, "opds_download_entry", {
      url: library.entries[0].downloadUrl,
      title: library.entries[0].title,
    });
    downloaded.push(first.id);
    const pathOk =
      typeof first.path === "string" &&
      /[\\/]downloads[\\/]opds[\\/]/.test(first.path) &&
      first.sourceType === "local" &&
      first.title === "QA Chapter 001";
    if (pageCount(first) !== 2 || !pathOk) {
      fail(report, {
        id: "opds:download-import",
        suite: "opds",
        layer: "integration",
        title: "OPDS 章节未下载到本地缓存并进入书库",
        severity: "P1",
        details: JSON.stringify({
          pageCount: pageCount(first),
          sourceType: first.sourceType,
          title: first.title,
          path: first.path,
        }),
        location: "src-tauri/src/opds.rs download_archive / commands.rs",
        expected: "2 页、sourceType=local、路径位于 downloads/opds",
        actual: `${pageCount(first)} 页 · ${first.sourceType} · ${first.path}`,
      });
    } else {
      ok(report, {
        id: "opds:download-import",
        suite: "opds",
        layer: "integration",
        title: "OPDS 章节下载到本地 OPDS 目录并入库",
        details: `${first.title} · ${pageCount(first)} 页`,
      });
    }

    const read = await invokeSafe(page, "get_page", {
      bookId: first.id,
      index: 0,
      maxWidth: 480,
      maxHeight: 720,
    });
    if (!read.ok || !isDataImage(read.value?.dataUrl)) {
      fail(report, {
        id: "opds:read-pipeline",
        suite: "opds",
        layer: "integration",
        title: "OPDS 下载章节无法进入现有阅读管线",
        severity: "P1",
        details: JSON.stringify({
          error: read.ok ? null : read.error,
          prefix: read.value?.dataUrl?.slice(0, 32),
        }),
        location: "src-tauri/src/commands.rs get_page",
      });
    } else {
      ok(report, {
        id: "opds:read-pipeline",
        suite: "opds",
        layer: "integration",
        title: "OPDS 下载章节经现有阅读管线读出页面",
        details: `${read.value.width}×${read.value.height}`,
      });
    }

    // Frontend wiring: the library button opens the dialog and lists entries.
    try {
      const opened = await page.eval(`(() => {
        const button = document.querySelector('[data-testid="opds-open"]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      const dialog = await page.waitFor(
        `document.querySelector('[data-testid="opds-dialog"]') !== null`,
        { timeout: 8000 },
      );
      const entries = await page.waitFor(
        `document.querySelectorAll('[data-testid="opds-entry"]').length >= 1`,
        { timeout: 8000 },
      );
      if (!opened || !dialog || !entries) {
        fail(report, {
          id: "opds:library-ui",
          suite: "opds",
          layer: "ui",
          title: "书库页远程书库对话框未显示目录",
          severity: "P2",
          details: JSON.stringify({ opened, dialog, entries }),
          location: "src/pages/Library.tsx / OpdsBrowserDialog.tsx",
        });
      } else {
        ok(report, {
          id: "opds:library-ui",
          suite: "opds",
          layer: "ui",
          title: "书库页远程书库对话框打开并列出目录",
        });
      }
      const entered = await page.eval(`(() => {
        const button = document.querySelector('[data-testid="opds-entry-open"]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      const chapters = await page.waitFor(
        `document.querySelectorAll('[data-testid="opds-entry-download"]').length >= 2`,
        { timeout: 8000 },
      );
      const coverImages = await page.waitFor(
        `document.querySelectorAll('[data-testid="opds-entry"] img').length >= 1`,
        { timeout: 8000 },
      );
      if (!entered || !chapters || !coverImages) {
        fail(report, {
          id: "opds:library-ui-chapters",
          suite: "opds",
          layer: "ui",
          title: "远程书库 UI 未列出章节或封面",
          severity: "P2",
          details: JSON.stringify({ entered, chapters, coverImages }),
          location: "src/components/library/OpdsBrowserDialog.tsx",
        });
      } else {
        ok(report, {
          id: "opds:library-ui-chapters",
          suite: "opds",
          layer: "ui",
          title: "远程书库 UI 列出章节并显示封面",
        });
      }
      const closed = await page.eval(`(() => {
        const button = document.querySelector('[data-testid="opds-close"]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      const gone = closed
        ? await page
            .waitFor(
              `document.querySelector('[data-testid="opds-dialog"]') === null`,
              { timeout: 5000 },
            )
            .catch(() => false)
        : false;
      if (!gone) {
        fail(report, {
          id: "opds:library-ui-close",
          suite: "opds",
          layer: "ui",
          title: "远程书库对话框无法关闭",
          severity: "P2",
          details: JSON.stringify({ closed, gone }),
          location: "src/components/library/OpdsBrowserDialog.tsx",
        });
      }
    } catch (error) {
      fail(report, {
        id: "opds:library-ui",
        suite: "opds",
        layer: "ui",
        title: "书库页远程书库 UI 检查失败",
        severity: "P2",
        details: String(error?.message || error),
        location: "src/pages/Library.tsx / OpdsBrowserDialog.tsx",
      });
    }

    // Switch to a Kavita-shaped catalog by configuration only.
    await invoke(page, "opds_set_config", {
      config: {
        enabled: true,
        url: `${fixture.origin}${opds.kavitaRoot}`,
        username: "",
        password: "",
      },
    });
    const kavitaRoot = await invoke(page, "opds_browse", { url: null });
    if (kavitaRoot.title !== "QA Kavita Catalog") {
      fail(report, {
        id: "opds:server-switch",
        suite: "opds",
        layer: "integration",
        title: "仅改配置切换 OPDS 服务失败",
        severity: "P1",
        details: JSON.stringify(kavitaRoot),
        location: "src-tauri/src/opds.rs load_runtime / commands.rs",
      });
    } else {
      ok(report, {
        id: "opds:server-switch",
        suite: "opds",
        layer: "integration",
        title: "仅改配置切换到 Kavita 形状目录",
        details: kavitaRoot.title,
      });
    }
    const kavitaLibrary = await invoke(page, "opds_browse", {
      url: kavitaRoot.entries[0].navigationUrl,
    });
    const kavitaChapter = kavitaLibrary.entries[0];
    const second = await invoke(page, "opds_download_entry", {
      url: kavitaChapter.downloadUrl,
      title: kavitaChapter.title,
    });
    downloaded.push(second.id);
    if (pageCount(second) !== 2 || second.title !== "QA Kavita Chapter") {
      fail(report, {
        id: "opds:kavita-download",
        suite: "opds",
        layer: "integration",
        title: "Kavita 形状章节未下载入库",
        severity: "P1",
        details: JSON.stringify({
          pageCount: pageCount(second),
          title: second.title,
        }),
        location: "src-tauri/src/opds.rs download_archive",
      });
    } else {
      ok(report, {
        id: "opds:kavita-download",
        suite: "opds",
        layer: "integration",
        title: "Kavita 形状章节下载并入库",
        details: `${second.title} · ${pageCount(second)} 页`,
      });
    }

    // Settings panel smoke: the network tab renders the OPDS card and reads
    // the saved Kavita URL back from the local config.
    try {
      await page.navigateHash("#/settings?tab=network");
      const panel = await page.waitFor(
        `document.querySelector('[data-testid="opds-url"]') !== null`,
        { timeout: 8000 },
      );
      const value = panel
        ? await page.eval(
            `document.querySelector('[data-testid="opds-url"]').value`,
          )
        : "";
      if (!panel || !String(value).includes("/api/opds/qa-key/catalog")) {
        fail(report, {
          id: "opds:settings-ui",
          suite: "opds",
          layer: "ui",
          title: "设置页 OPDS 卡片未显示已保存地址",
          severity: "P2",
          details: JSON.stringify({ panel, value }),
          location: "src/components/settings/OpdsPanel.tsx",
        });
      } else {
        ok(report, {
          id: "opds:settings-ui",
          suite: "opds",
          layer: "ui",
          title: "设置页 OPDS 卡片显示已保存地址",
        });
      }
      await page.navigateHash("#/");
      await page.waitFor(
        `document.querySelector('[data-testid="opds-open"]') !== null`,
        { timeout: 8000 },
      );
    } catch (error) {
      fail(report, {
        id: "opds:settings-ui",
        suite: "opds",
        layer: "ui",
        title: "设置页 OPDS 卡片 UI 检查失败",
        severity: "P2",
        details: String(error?.message || error),
        location: "src/components/settings/OpdsPanel.tsx",
      });
    }

    const crossOrigin = await invokeSafe(page, "opds_browse", {
      url: "http://127.0.0.1:1/catalog",
    });
    if (crossOrigin.ok || !String(crossOrigin.error).includes("opds-cross-origin")) {
      fail(report, {
        id: "opds:cross-origin",
        suite: "opds",
        layer: "security",
        title: "OPDS 跨源浏览未被拒绝",
        severity: "P1",
        details: JSON.stringify(crossOrigin),
        location: "src-tauri/src/opds.rs same_origin_link",
        expected: "opds-cross-origin",
      });
    } else {
      ok(report, {
        id: "opds:cross-origin",
        suite: "opds",
        layer: "security",
        title: "OPDS 跨源浏览被拒绝",
      });
    }

    const invalid = await invokeSafe(page, "opds_set_config", {
      config: {
        enabled: true,
        url: "file:///tmp/catalog.xml",
        username: "",
        password: null,
      },
    });
    if (invalid.ok || !String(invalid.error).includes("opds-url-invalid")) {
      fail(report, {
        id: "opds:invalid-url",
        suite: "opds",
        layer: "security",
        title: "非法 OPDS 地址未被拒绝",
        severity: "P1",
        details: JSON.stringify(invalid),
        location: "src-tauri/src/opds.rs validate_config_url",
        expected: "opds-url-invalid",
      });
    } else {
      ok(report, {
        id: "opds:invalid-url",
        suite: "opds",
        layer: "security",
        title: "非法 OPDS 地址被拒绝",
      });
    }
  } catch (error) {
    fail(report, {
      id: "opds:crashed",
      suite: "opds",
      layer: "integration",
      title: "OPDS 套件意外中断",
      severity: "P1",
      details: String(error?.stack || error),
      location: "tests/qa/suites/opds.mjs",
    });
  } finally {
    // Best-effort cleanup: remove downloaded books and disable the source.
    try {
      if (downloaded.length > 0) {
        await invoke(page, "remove_books", {
          ids: downloaded,
          deleteSourceFiles: true,
        });
      }
    } catch {
      /* isolated QA data dir; cleanup failure is not a product defect */
    }
    try {
      await invoke(page, "opds_set_config", {
        config: {
          enabled: false,
          url: "",
          username: "",
          password: "",
        },
      });
    } catch {
      /* ignore */
    }
  }
}
