import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
// @ts-expect-error type error without @types/node package
import { execFileSync } from "node:child_process";
// @ts-expect-error type error without @types/node package
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error JS module without type declarations
import { assertReleaseSurface } from "./scripts/release-surface.mjs";

const host = process.env.TAURI_DEV_HOST;

/**
 * PDF.js 静态资源（cmaps / standard_fonts）。
 *
 * PDF.js 需要按 URL 前缀拉取 CMap 与标准字体表；这些文件随 npm 依赖分发，
 * 既有构建不会自动拷贝。开发期用中间件直接从 node_modules 供给，
 * 构建期在 bundle 落盘后复制到 `dist/pdf-assets/`，保证生产包完全离线。
 *
 * 只暴露 cmaps 与 standard_fonts：wasm（openjpeg/jbig2/qcms）与 quickjs-eval
 * 沙箱不随附——wasm 需要放宽 CSP 的 'wasm-unsafe-eval'，且 PDF 内嵌脚本
 * 沙箱与「不执行文档脚本」的安全要求冲突。
 */
const PDF_ASSET_URL_PREFIX = "/pdf-assets";
const PDF_ASSET_DIRS: readonly string[] = ["cmaps", "standard_fonts"];

const MIME_BY_EXT: Record<string, string> = {
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function pdfAssetsPlugin(): Plugin {
  const sourceRoot = fileURLToPath(
    new URL("./node_modules/pdfjs-dist", import.meta.url),
  );
  return {
    name: "moyu:pdf-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? "";
        if (!rawUrl.startsWith(`${PDF_ASSET_URL_PREFIX}/`)) {
          next();
          return;
        }
        // 去掉查询串（?v=… 之类），只保留资源相对路径。
        const requestPath = decodeURIComponent(
          rawUrl.slice(PDF_ASSET_URL_PREFIX.length + 1).split("?")[0] ?? "",
        );
        const target = resolve(sourceRoot, requestPath);
        // 只允许读取 pdfjs-dist 目录内的受控子目录，杜绝路径穿越。
        // 注意：不能用字符串前缀比较——Windows 上 resolve() 产出的是反斜杠路径，
        // 与硬编码的 "/" 前缀永远匹配不上（会让 /pdf-assets/** 全部 404）。
        const rel = relative(sourceRoot, target);
        const allowed =
          !!rel &&
          !rel.startsWith("..") &&
          !isAbsolute(rel) &&
          PDF_ASSET_DIRS.includes(rel.split(sep)[0] ?? "");
        if (!allowed || !existsSync(target) || !statSync(target).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          MIME_BY_EXT[extname(target)] ?? "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-cache");
        res.end(readFileSync(target));
      });
    },
    closeBundle() {
      const outDir = fileURLToPath(new URL("./dist", import.meta.url));
      for (const dir of PDF_ASSET_DIRS) {
        const from = resolve(sourceRoot, dir);
        if (!existsSync(from)) continue;
        cpSync(from, resolve(outDir, "pdf-assets", dir), { recursive: true });
      }
    },
  };
}

/**
 * 构建期 chunk 预算（Task 21-4）。
 *
 * Vite 的 500 kB 警告以 chunk 为单位，PDF.js 单文件魔改不动（pdf.min 约
 * 0.55 MB，worker 是异步资产），不足以指导首屏优化。这里直接把所有
 * 非 PDF 的 JS chunk 卡在 500 kB 以内：主入口、Settings、Browser、Reader
 * 与 UI vendor 超限都会让构建失败，而不是只打一行 warning。
 */
function chunkBudgetPlugin(): Plugin {
  const budget = 500 * 1024;
  return {
    name: "moyu:chunk-budget",
    apply: "build",
    // generateBundle 里的 code 仍是预压缩产物；用 writeBundle 读取落盘后的
    // 真实字节数，避免“账面 560 kB、实际 745 kB”的假通过。
    writeBundle(options, bundle) {
      const outDir =
        options.dir ?? fileURLToPath(new URL("./dist", import.meta.url));
      const offenders: string[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        // PDF.js 是异步懒加载的第三方单文件构建，单独预算。
        if (/pdf/i.test(output.fileName)) continue;
        const bytes = statSync(resolve(outDir, output.fileName)).size;
        if (bytes > budget) {
          offenders.push(
            `${output.fileName} ${(bytes / 1024).toFixed(1)} kB`,
          );
        }
      }
      if (offenders.length > 0) {
        this.error(
          `非 PDF chunk 超过 500 kB 预算：${offenders.join(", ")}。请拆分路由或 manualChunks。`,
        );
      }
    },
  };
}

/**
 * QA-only seam for the Web Access pairing harness.
 *
 * The QA suite must exercise the real React panel and timers without replacing
 * `__TAURI_INTERNALS__.invoke` (the static anti-mock guard forbids that, and
 * Tauri makes the property non-configurable). Instead, only the dev server
 * aliases the web-access API module to a control-plane fixture. The fixture
 * delegates to the real invoke unless the suite installs
 * `window.__QA_WEB_ACCESS__`, so other suites sharing this Vite instance are
 * unaffected. Production builds never enable this plugin.
 */
function qaWebAccessFixturePlugin(): Plugin {
  const fixture = fileURLToPath(
    new URL("./tests/qa/lib/web-access-api-fixture.mjs", import.meta.url),
  );
  return {
    name: "moyu:qa-web-access-fixture",
    enforce: "pre",
    apply: "serve",
    resolveId(source, importer) {
      if (process.env.MR_QA_WEB_ACCESS_FIXTURE !== "1") return null;
      if (source !== "./api") return null;
      const normalized = (importer ?? "").replace(/\\/g, "/");
      if (!normalized.endsWith("/src/features/web-access/useWebAccess.ts")) {
        return null;
      }
      return fixture;
    },
  };
}

function projectVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("package.json version is required");
  }
  return manifest.version;
}

function readUtf8(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/**
 * 公开快照不再携带独立的版本检查脚本，但版本单一事实源仍必须成立。
 * 在 Vite 配置加载时校验 package.json、Tauri 配置、Cargo 与 lockfile 一致，
 * 任何不一致直接阻断 dev/build。
 */
function assertVersionConsistency(): void {
  const expected = projectVersion();
  const errors: string[] = [];

  const tauri = JSON.parse(readUtf8("./src-tauri/tauri.conf.json")) as {
    version?: unknown;
  };
  if (tauri.version !== expected) {
    errors.push(`src-tauri/tauri.conf.json: ${String(tauri.version)}`);
  }

  const cargoToml = readUtf8("./src-tauri/Cargo.toml");
  const packageSection =
    cargoToml.split(/^\s*\[/m).find((section) => section.startsWith("package]")) ?? "";
  const cargoVersion = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (cargoVersion !== expected) {
    errors.push(`src-tauri/Cargo.toml: ${cargoVersion ?? "<missing>"}`);
  }

  const cargoLock = readUtf8("./src-tauri/Cargo.lock");
  const lockBlock =
    cargoLock
      .split("[[package]]")
      .find((block) => /name\s*=\s*"manga-reader-tauri"/.test(block)) ?? "";
  const cargoLockVersion = lockBlock.match(/version\s*=\s*"([^"]+)"/)?.[1];
  if (cargoLockVersion !== expected) {
    errors.push(`src-tauri/Cargo.lock: ${cargoLockVersion ?? "<missing>"}`);
  }

  const packageLock = JSON.parse(readUtf8("./package-lock.json")) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };
  if (packageLock.version !== expected) {
    errors.push(`package-lock.json: ${String(packageLock.version)}`);
  }
  if (packageLock.packages?.[""]?.version !== expected) {
    errors.push(
      `package-lock.json packages[""]: ${String(packageLock.packages?.[""]?.version)}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Version mismatch with package.json ${expected}: ${errors.join(", ")}`,
    );
  }
}

function buildCommit(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        encoding: "utf8",
      },
    ).trim();
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "local";
  }
}

assertVersionConsistency();
// static:release-surface：升级身份锚点与品牌展示名一旦漂移，dev/build 直接失败。
await assertReleaseSurface();
const appVersion = projectVersion();
const gitCommit = buildCommit();

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_COMMIT__: JSON.stringify(gitCommit),
  },
  // Tailwind v4 走 Vite 插件；v3 页面用工具类，旧页面继续用 ui.css 的类。
  plugins: [
    qaWebAccessFixturePlugin(),
    react(),
    tailwindcss(),
    pdfAssetsPlugin(),
    chunkBudgetPlugin(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // PDF.js 单个 bundle 约 0.55 MB，且永远异步加载；非 PDF chunk 由
    // chunkBudgetPlugin 单独按 500 kB 强制校验，不依赖 Vite 的软警告。
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        recovery: fileURLToPath(new URL("./recovery.html", import.meta.url)),
        // Web Access 独立入口（W2 / BLK-2 验证原型）。
        // 刻意与桌面入口分离：不共享 Provider 栈，不引入任何 Tauri IPC 依赖。
        web: fileURLToPath(new URL("./web.html", import.meta.url)),
      },
      output: {
        // 路由级 lazy 之外，把跨入口共享的框架/图标/PDF 拆成稳定缓存组：
        // 首屏主入口只保留书库与壳层，冷启动不必下载设置/浏览器/阅读器。
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          // 六语字典体积大且几乎全部页面都会用到。按消息域拆成稳定缓存组，
          // 避免单个 i18n chunk 超过预算；类型导入会在编译期擦除，不增加包体。
          if (path.includes("/src/i18n/messages/")) {
            const domain =
              path.split("/src/i18n/messages/")[1]?.replace(/\.ts$/, "") ??
              "misc";
            return `messages-${domain}`;
          }
          if (path.includes("/src/i18n/locales/")) return "i18n-locales";
          if (!path.includes("node_modules")) return;
          if (path.includes("/pdfjs-dist/")) return "pdfjs";
          if (path.includes("/lucide-react/")) return "lucide";
          if (
            path.includes("/@base-ui/") ||
            path.includes("/@floating-ui/") ||
            path.includes("/@radix-ui/")
          ) {
            return "ui-vendor";
          }
          if (
            path.includes("/react-dom/") ||
            path.includes("/react/") ||
            path.includes("/scheduler/") ||
            path.includes("/react-router") ||
            path.includes("/@remix-run/")
          ) {
            return "react-vendor";
          }
          return;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: [
        "**/src-tauri/**",
        "**/tests/qa/artifacts/**",
        "**/tests/qa/fixtures/**",
      ],
    },
  },
}));
