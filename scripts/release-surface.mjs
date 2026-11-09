/**
 * static:release-surface 守卫。
 *
 * 守住两类一旦漂移就会很难补救的锚点：
 *
 * 1. 升级身份锚点（`productName` / `identifier` / 主程序名）。
 *    这三项决定安装器如何识别旧版本；改动会让官方 Updater 认不出已装的
 *    程序，用户要么重复安装要么无法原地升级。
 * 2. 品牌展示名（窗口标题 + 六语字典）。
 *    展示名必须统一为 "Moyu"：首字母大写、其余小写。
 *
 * 该脚本既被 `npm run check:release-surface` 单独调用，也在 Vite 配置加载时
 * 执行一次，因此 `npm run dev` / `npm run build` 都会在漂移时直接失败。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { commonMessages } from "../src/i18n/messages/common.ts";

/** 升级身份锚点：与安装器、Updater 共用同一组值。 */
export const RELEASE_ANCHORS = {
  productName: "MangaReader",
  identifier: "com.local.manga-reader",
  mainBinaryName: "manga-reader-tauri",
};

/** 品牌展示名：首字母大写，其余小写。 */
export const BRAND_DISPLAY_NAME = "Moyu";

/** 六语字典：品牌名必须出现在每一种语言里。 */
export const LOCALES = ["zh-CN", "zh-TW", "en", "es", "ja", "ko"];

function readUtf8(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/**
 * 校验升级身份锚点与品牌展示名。
 *
 * @param {{ localeMessages: Record<string, Record<string, string>>, tauriConfig?: unknown }} input
 *   六语字典的运行时快照（key = 语言，value = 该语言的文案表）；
 *   `tauriConfig` 默认读取真实的 `src-tauri/tauri.conf.json`，测试可注入漂移样本。
 * @returns {string[]} 违规项；空数组表示全部通过。
 */
export function collectReleaseSurfaceViolations(input) {
  const violations = [];
  const tauri = input.tauriConfig ?? JSON.parse(readUtf8("../src-tauri/tauri.conf.json"));

  for (const [key, expected] of Object.entries(RELEASE_ANCHORS)) {
    const actual = tauri[key];
    if (actual !== expected) {
      violations.push(
        `src-tauri/tauri.conf.json: ${key} = ${JSON.stringify(actual)}（期望 ${JSON.stringify(expected)}）`,
      );
    }
  }

  const windows = Array.isArray(tauri.app?.windows) ? tauri.app.windows : [];
  for (const [index, window] of windows.entries()) {
    if (window.title !== BRAND_DISPLAY_NAME) {
      violations.push(
        `src-tauri/tauri.conf.json: app.windows[${index}].title = ${JSON.stringify(window.title)}（期望 ${JSON.stringify(BRAND_DISPLAY_NAME)}）`,
      );
    }
  }

  for (const locale of LOCALES) {
    const table = input.localeMessages?.[locale];
    if (!table) {
      violations.push(`缺少语言包：${locale}`);
      continue;
    }
    for (const key of ["app.title", "nav.brand"]) {
      const value = table[key];
      if (typeof value !== "string" || !value.startsWith(BRAND_DISPLAY_NAME)) {
        violations.push(
          `${locale} 的 ${key} = ${JSON.stringify(value)}（应以 ${BRAND_DISPLAY_NAME} 开头）`,
        );
      }
    }
    const stale = Object.entries(table).filter(([, value]) =>
      typeof value === "string" && value.includes("MangaReader"),
    );
    for (const [key, value] of stale) {
      violations.push(`${locale} 的 ${key} 仍包含旧品牌名：${JSON.stringify(value)}`);
    }
  }

  return violations;
}

/**
 * 读取六语字典并执行完整校验；失败时抛出带全部违规项的错误。
 */
export async function assertReleaseSurface() {
  const localeMessages = {};
  for (const locale of LOCALES) {
    localeMessages[locale] = commonMessages[locale] ?? {};
  }
  const violations = collectReleaseSurfaceViolations({ localeMessages });
  if (violations.length > 0) {
    throw new Error(
      `release-surface 守卫未通过：\n- ${violations.join("\n- ")}`,
    );
  }
  return true;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await assertReleaseSurface();
  console.log("release-surface 守卫通过：升级身份锚点与品牌展示名均未漂移。");
}
