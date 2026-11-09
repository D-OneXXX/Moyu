import { messages } from "/reader-messages.js";

/* ==========================================================================
 * Moyu · D4 LAN Web Reader (mobile-first)
 *
 * The desktop app serves this file, the stylesheet and the message table under
 * a strict CSP (`default-src 'none'`, no inline script/style). Everything here
 * therefore builds DOM through the DOM API, never through `innerHTML` with
 * server data, and never loads a third-party asset.
 *
 * Reading contract (unchanged):
 *  - progress lives at PUT /api/books/{id}/progress with {page, scrollPct?, baseRev?};
 *  - a stale baseRev answers 409 `progress-conflict` and must be resolved by a
 *    human choice, never silently;
 *  - webtoon pages are served as ≤1024 tiles of 2048 px (server cap: 128 MiB),
 *    so the client keeps skeletons + lazy loading instead of one huge image.
 * ========================================================================== */

/* ------------------------------------------------------------------ i18n */

const LOCALES = ["zh-CN", "zh-TW", "en", "es", "ja", "ko"];

function detectLocale() {
  const candidates =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || "en"];
  for (const raw of candidates) {
    const tag = String(raw);
    if (/^zh\b/i.test(tag)) {
      return /TW|HK|MO|Hant/i.test(tag) ? "zh-TW" : "zh-CN";
    }
    const base = tag.split("-")[0].toLowerCase();
    if (base === "en" || base === "es" || base === "ja" || base === "ko") {
      return base;
    }
  }
  return "en";
}

let locale = detectLocale();

function t(key, vars) {
  const table = messages[locale] || messages.en;
  let text = table[key] ?? messages.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split("{" + name + "}").join(String(value));
    }
  }
  return text;
}

function applyLocale() {
  document.documentElement.lang = locale;
}

/* ----------------------------------------------------------------- prefs */

const PREF_KEY = "mr-web-reader-prefs";
const PREF_DEFAULTS = {
  mode: "auto", // auto | paged | webtoon
  theme: "auto", // auto | light | dark
  bg: "auto", // auto | paper | night
  brightness: 1, // 0.3 .. 1
};

function readPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    const mode = ["auto", "paged", "webtoon"].includes(raw.mode) ? raw.mode : "auto";
    const theme = ["auto", "light", "dark"].includes(raw.theme) ? raw.theme : "auto";
    const bg = ["auto", "paper", "night"].includes(raw.bg) ? raw.bg : "auto";
    const brightness =
      typeof raw.brightness === "number" && raw.brightness >= 0.3 && raw.brightness <= 1
        ? raw.brightness
        : 1;
    return { mode, theme, bg, brightness };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

let prefs = readPrefs();

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* Private mode: preferences stay in memory for this session. */
  }
}

function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
}

function applyBackground() {
  document.documentElement.dataset.bg = prefs.bg;
}

function applyBrightness() {
  document.documentElement.style.setProperty(
    "--r-dim",
    String(Math.round((1 - prefs.brightness) * 100) / 100),
  );
}

function applyPreferences() {
  applyTheme();
  applyBackground();
  applyBrightness();
}

applyPreferences();
applyLocale();

/* ------------------------------------------------------------------- dom */

const app = document.getElementById("app");
const layers = document.getElementById("layers");
const live = document.getElementById("live");

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  back: ["M15 18l-6-6 6-6"],
  prev: ["M15 18l-6-6 6-6"],
  next: ["M9 18l6-6-6-6"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  book: [
    "M4 19.5A2.5 2.5 0 0 1 6.5 17H20",
    "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  ],
  scroll: ["M4 6h16", "M4 12h16", "M4 18h16"],
  sun: [
    "M12 2v2",
    "M12 20v2",
    "M4.9 4.9l1.4 1.4",
    "M17.7 17.7l1.4 1.4",
    "M2 12h2",
    "M20 12h2",
    "M4.9 19.1l1.4-1.4",
    "M17.7 6.3l1.4-1.4",
    "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  ],
  contrast: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 3v18"],
  close: ["M18 6L6 18", "M6 6l12 12"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  image: ["M4 5h16v14H4z", "M4 15l4-4 4 4 3-3 5 5"],
  check: ["M20 6L9 17l-5-5"],
  device: ["M4 6h16v10H4z", "M2 20h20"],
  zoom: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M11 8v6", "M8 11h6", "M21 21l-4.3-4.3"],
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function iconButton(name, label, onClick, testId) {
  const button = el("button", {
    class: "iconbtn",
    type: "button",
    "aria-label": label,
    title: label,
  });
  if (testId) button.dataset.testid = testId;
  button.append(icon(name));
  button.addEventListener("click", onClick);
  return button;
}

function announce(text) {
  if (!live) return;
  live.textContent = "";
  window.setTimeout(() => {
    live.textContent = text;
  }, 30);
}

/* ----------------------------------------------------------------- state */

let generation = 0;
let screen = "boot";
let activeBook = null;
let page = 0;
let pageCount = 0;
let revision = 0;
let busy = false;
let conflict = null;
let clampedProgressNotice = false;

let layoutDims = null;
let layoutGeometryCache = null;
let savedScrollPct = -1;
let scrollSaveTimer = 0;
let scrollListener = null;
let scrollRestoreFrame = 0;
let scrollRestoreTimer = 0;
let pendingScrollPct = null;
let progressWriteChain = Promise.resolve();
let restoringScroll = false;
let restoringScrollY = null;
let scrollReady = false;
let lastScrollSaveAt = 0;

let blobs = [];
let controllers = [];

const SCROLL_SAVE_INTERVAL_MS = 750;
const MAX_LAYOUT_CSS_HEIGHT = 16e6;

let libSeq = 0;
let libQuery = "";
let libCursor = null;
let libLoading = false;
let libSentinelObserver = null;
let libScrollY = 0;

/* reader dom */
let readerEl = null;
let stageEl = null;
let viewEl = null;
let dimEl = null;
let zonesEl = null;
let topHud = null;
let bottomHud = null;
let titleEl = null;
let pagerEl = null;
let scrubberEl = null;
let modeButton = null;
let bgButton = null;
let prevButton = null;
let nextButton = null;
let endcapEl = null;

let pageAbort = null;
let tileObserver = null;
let viewBlobs = [];
let viewControllers = [];
const aspectHints = new Map();
let pagedCache = new Map();
let pageToken = 0;

let hudTimer = 0;
let hudVisible = true;
let zoom = 1;
/**
 * Progress is only persisted after a real user gesture on the stage. A
 * programmatic restore (or a layout reflow while the image decodes) must never
 * overwrite the stored scroll percentage — opening on a narrow phone would
 * otherwise reset a desktop reader's position to the top of the page.
 */
let userScrolled = false;

let tocOpen = false;
let displayOpen = false;
let tocSheet = null;
let displaySheet = null;
let conflictSheet = null;
let scrimEl = null;

let pushedReader = false;
let toastEl = null;
let toastTimer = 0;

/* --------------------------------------------------------------- transport */

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (method !== "GET") {
    headers["X-Moyu-Request"] = "1";
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers,
  });
  if (!response.ok) throw await apiError(response);
  return response.status === 204 ? null : response.json();
}

async function apiError(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON error */
  }
  const error = new Error((data && data.error && data.error.code) || "request-failed");
  error.code = data && data.error ? data.error.code : undefined;
  error.details = data && data.error ? data.error.details : undefined;
  error.status = response.status;
  return error;
}

function errorText(error) {
  const code = error && error.code;
  if (code === "pdf-source-unsupported") return t("pdfUnsupported");
  if (code === "source-unsupported") return t("sourceUnsupported");
  if (code === "unauthorized") return t("connectionFailed");
  if (code === "image-failed") return t("imageFailed");
  if (code === "webtoon-too-large") return t("imageTooLarge");
  return t("loadFailed");
}

function errorNotice(error, retry) {
  const box = el("div", { class: "notice notice-error", role: "alert" }, [
    el("p", { text: errorText(error) }),
  ]);
  if (retry) {
    box.append(
      el("button", {
        class: "btn",
        type: "button",
        text: t("retry"),
        onclick: retry,
      }),
    );
  }
  return box;
}

function toast(message) {
  if (!toastEl) {
    toastEl = el("div", { class: "toast", role: "status" });
    layers.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.dataset.open = "true";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.dataset.open = "false";
    toastTimer = 0;
  }, 1800);
}

/* ------------------------------------------------------------ page layout */

function validatedLayout(layout, count) {
  const pages = layout && layout.pages;
  if (!Array.isArray(pages) || pages.length !== count) return null;
  for (let i = 0; i < pages.length; i += 1) {
    const dim = pages[i];
    if (
      !dim ||
      dim.index !== i ||
      !Number.isSafeInteger(dim.width) ||
      !Number.isSafeInteger(dim.height) ||
      dim.width < 1 ||
      dim.height < 1
    ) {
      return null;
    }
  }
  return pages;
}

function layoutGeometry() {
  if (!layoutDims || !tilesEl()) return null;
  const node = tilesEl();
  const width = Math.max(
    1,
    Math.round(node.clientWidth || node.getBoundingClientRect().width),
  );
  if (layoutGeometryCache && layoutGeometryCache.width === width) {
    return layoutGeometryCache;
  }
  const pages = [];
  let total = 0;
  for (const dim of layoutDims) {
    const height = Math.max(1, Math.round((dim.height / dim.width) * width));
    pages.push({ start: total, height });
    total += height;
    if (!Number.isSafeInteger(total) || total > MAX_LAYOUT_CSS_HEIGHT) return null;
  }
  layoutGeometryCache = { width, total, pages };
  return layoutGeometryCache;
}

function tilesEl() {
  return viewEl ? viewEl.querySelector(".tiles") : null;
}

function effectiveMode() {
  if (prefs.mode === "paged" || prefs.mode === "webtoon") return prefs.mode;
  const dim = layoutDims && layoutDims[page];
  const ratio = dim ? dim.height / dim.width : aspectHints.get(page);
  if (!ratio) return "paged";
  // A single logical page taller than ~1.6 screens is a webtoon strip.
  return ratio > 1.6 ? "webtoon" : "paged";
}

function tileAspectRatios(dim, requestedWidth, count) {
  if (!dim || dim.width < 1 || dim.height < 1 || count < 1) return null;
  const bucketWidth = Math.min(
    2160,
    Math.max(320, Math.floor((Math.min(2160, Math.max(320, requestedWidth)) + 32) / 64) * 64),
  );
  const outputWidth = Math.min(dim.width, bucketWidth);
  const outputHeight = Math.max(1, Math.round((dim.height * outputWidth) / dim.width));
  if (count > outputHeight) return null;
  const ratios = [];
  let previous = 0;
  for (let i = 1; i <= count; i += 1) {
    const pixelEnd = i === count ? outputHeight : Math.round((i * outputHeight) / count);
    ratios.push(`${outputWidth} / ${Math.max(1, pixelEnd - previous)}`);
    previous = pixelEnd;
  }
  return ratios;
}

function renderWidth() {
  return Math.max(
    320,
    Math.min(2160, Math.round((window.innerWidth || 1080) * (window.devicePixelRatio || 1))),
  );
}

/* -------------------------------------------------------------- progress */

function currentScrollPct() {
  const node = tilesEl();
  const geometry = layoutGeometry();
  const current = geometry && geometry.pages[page];
  if (!node || !geometry || !current) return null;
  const viewport = Math.max(1, stageEl ? stageEl.clientHeight : window.innerHeight || 1);
  const pageRange = Math.max(0, current.height - viewport);
  if (pageRange <= 0) return null;
  const localTop = Math.min(pageRange, Math.max(0, stageEl.scrollTop));
  const bookRange = Math.max(1, geometry.total - viewport);
  const pct = Math.min(1, Math.max(0, (current.start + localTop) / bookRange));
  return Math.round(pct * 1e5) / 1e5;
}

function restoreScroll(pct, token) {
  const node = tilesEl();
  if (!node || !layoutGeometry()) return;
  if (scrollRestoreFrame) cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = requestAnimationFrame(() => {
    scrollRestoreFrame = requestAnimationFrame(() => {
      scrollRestoreFrame = 0;
      if (token !== generation || !activeBook) return;
      const geometry = layoutGeometry();
      const current = geometry && geometry.pages[page];
      if (pct >= 0 && pct <= 1 && geometry && current && stageEl) {
        const viewport = Math.max(1, stageEl.clientHeight || 1);
        const globalTop = pct * Math.max(1, geometry.total - viewport);
        const localTop = Math.min(
          Math.max(0, current.height - viewport),
          Math.max(0, globalTop - current.start),
        );
        restoringScroll = true;
        stageEl.scrollTop = Math.max(0, localTop);
        restoringScrollY = stageEl.scrollTop;
        if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
        scrollRestoreTimer = window.setTimeout(() => {
          restoringScroll = false;
          restoringScrollY = null;
          scrollRestoreTimer = 0;
        }, 300);
      }
      scrollReady = true;
    });
  });
}

function queueProgressWrite(nextPage, scrollPct, baseRev, token) {
  const body = { page: nextPage };
  if (Number.isFinite(scrollPct) && scrollPct >= 0 && scrollPct <= 1) {
    body.scrollPct = scrollPct;
  }
  const write = progressWriteChain.catch(() => {}).then(async () => {
    if (token !== generation || !activeBook || conflict) return;
    body.baseRev = Number.isInteger(baseRev) ? baseRev : revision;
    const controller = new AbortController();
    controllers.push(controller);
    try {
      const result = await api(`/api/books/${activeBook.id}/progress`, {
        method: "PUT",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (token !== generation) return;
      page = result.page;
      revision = result.rev;
      savedScrollPct = body.scrollPct ?? -1;
      lastScrollSaveAt = Date.now();
      conflict = null;
      return result;
    } catch (error) {
      if (token !== generation || (error && error.name === "AbortError")) return;
      if (error.code === "progress-conflict" && error.details) {
        conflict = {
          desiredPage: nextPage,
          desiredScrollPct: body.scrollPct,
          currentPage: error.details.currentPage,
          currentRev: error.details.currentRev,
        };
        openConflictSheet();
      } else {
        toast(errorText(error));
      }
    } finally {
      controllers = controllers.filter((item) => item !== controller);
    }
  });
  progressWriteChain = write;
  return write;
}

function flushScrollProgress() {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = 0;
  if (pendingScrollPct == null || !activeBook || conflict) return progressWriteChain;
  const pct = pendingScrollPct;
  pendingScrollPct = null;
  return queueProgressWrite(page, pct, null, generation);
}

function scheduleScrollProgress() {
  if (restoringScroll) {
    if (restoringScrollY != null && stageEl && Math.abs(stageEl.scrollTop - restoringScrollY) <= 2) {
      return;
    }
    restoringScroll = false;
    restoringScrollY = null;
    if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
    scrollRestoreTimer = 0;
  }
  if (!userScrolled || !scrollReady || conflict || busy || !activeBook) return;
  const pct = currentScrollPct();
  if (pct == null) return;
  pendingScrollPct = pct;
  if (scrollSaveTimer) return;
  const wait = Math.max(0, SCROLL_SAVE_INTERVAL_MS - (Date.now() - lastScrollSaveAt));
  scrollSaveTimer = window.setTimeout(() => {
    scrollSaveTimer = 0;
    void flushScrollProgress();
  }, wait);
}

/* Best-effort flush when the phone closes the tab mid-scroll. */
window.addEventListener("pagehide", () => {
  if (!activeBook || pendingScrollPct == null || conflict) return;
  try {
    fetch(`/api/books/${activeBook.id}/progress`, {
      method: "PUT",
      keepalive: true,
      credentials: "same-origin",
      headers: { "X-Moyu-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        page,
        scrollPct: pendingScrollPct,
        baseRev: revision,
      }),
    });
  } catch {
    /* The page is going away; nothing else to do. */
  }
});

/* ---------------------------------------------------------------- cleanup */

function revokeViewBlobs() {
  for (const url of viewBlobs) URL.revokeObjectURL(url);
  viewBlobs = [];
}

function teardownView() {
  pageToken += 1;
  if (pageAbort) {
    pageAbort.abort();
    pageAbort = null;
  }
  for (const controller of viewControllers) controller.abort();
  viewControllers = [];
  if (tileObserver) {
    tileObserver.disconnect();
    tileObserver = null;
  }
  if (scrollListener && stageEl) {
    stageEl.removeEventListener("scroll", scrollListener);
    scrollListener = null;
  }
  revokeViewBlobs();
  if (viewEl) viewEl.replaceChildren();
  endcapEl = null;
  userScrolled = false;
}

function closeSheets(force = false) {
  if (!force && conflict && conflictSheet && conflictSheet.dataset.open === "true") return;
  tocOpen = false;
  displayOpen = false;
  if (tocSheet) tocSheet.dataset.open = "false";
  if (displaySheet) displaySheet.dataset.open = "false";
  if (conflictSheet) conflictSheet.dataset.open = "false";
  if (scrimEl) scrimEl.dataset.open = "false";
  if (readerEl) setHud(true, false);
}

function clearReader() {
  generation += 1;
  busy = false;
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = 0;
  if (scrollRestoreFrame) cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = 0;
  if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = 0;
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = 0;
  pendingScrollPct = null;
  restoringScroll = false;
  restoringScrollY = null;
  scrollReady = false;
  teardownView();
  for (const controller of controllers) controller.abort();
  controllers = [];
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs = [];
  for (const entry of pagedCache.values()) URL.revokeObjectURL(entry.url);
  pagedCache = new Map();
  aspectHints.clear();
  zoom = 1;
  closeSheets();
  if (readerEl) {
    document.documentElement.classList.remove("reader-open");
    readerEl = null;
  }
  stageEl = null;
  viewEl = null;
  titleEl = null;
  pagerEl = null;
  scrubberEl = null;
  modeButton = null;
  bgButton = null;
  prevButton = null;
  nextButton = null;
  topHud = null;
  bottomHud = null;
  zonesEl = null;
  dimEl = null;
  endcapEl = null;
}

/* ================================================================= library */

function mountLibraryShell() {
  const bar = el("div", { class: "bar" }, [
    el("div", { class: "bar-brand" }, [
      el("span", { class: "brand-dot" }, icon("book")),
      el("div", { class: "bar-brand-text" }, [
        el("h1", { class: "bar-title", text: t("library") }),
        el("span", { class: "bar-sub" }),
      ]),
    ]),
    el("div", { class: "bar-actions" }, [
      el("select", {
        class: "lang-select",
        "aria-label": t("language"),
        onchange: (event) => {
          const next = event.currentTarget.value;
          if (!LOCALES.includes(next)) return;
          locale = next;
          applyLocale();
          start();
        },
      }, LOCALES.map((value) =>
        el("option", {
          value,
          text: { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", es: "Español", ja: "日本語", ko: "한국어" }[value],
        }),
      )),
      (() => {
        const order = ["auto", "light", "dark"];
        const button = el("button", {
          class: "iconbtn",
          type: "button",
          "data-testid": "theme-cycle",
        });
        const paint = () => {
          const value = prefs.theme;
          button.replaceChildren(icon(value === "dark" ? "moon" : value === "light" ? "sun" : "contrast"));
          button.setAttribute(
            "aria-label",
            `${t("theme")}: ${value === "dark" ? t("themeDark") : value === "light" ? t("themeLight") : t("themeAuto")}`,
          );
          button.title = button.getAttribute("aria-label");
        };
        paint();
        button.addEventListener("click", () => {
          const index = order.indexOf(prefs.theme);
          prefs.theme = order[(index + 1) % order.length];
          savePrefs();
          applyTheme();
          paint();
        });
        return button;
      })(),
      iconButton("refresh", t("retry"), () => start(), "lib-refresh"),
    ]),
  ]);
  const barSelect = bar.querySelector("select");
  if (barSelect) barSelect.value = locale;

  const searchField = el("div", { class: "search-field" }, [
    icon("search"),
    el("input", {
      id: "lib-search",
      type: "search",
      inputmode: "search",
      autocomplete: "off",
      maxlength: "128",
      placeholder: t("search"),
      "aria-label": t("search"),
    }),
  ]);
  const clearButton = el("button", {
    class: "search-clear",
    type: "button",
    "aria-label": t("close"),
    hidden: true,
  }, icon("close"));
  searchField.append(clearButton);
  const searchForm = el("form", { class: "searchbar", role: "search" }, [
    searchField,
    el("button", { class: "btn", type: "submit", text: t("search") }),
  ]);
  const grid = el("div", { class: "grid", id: "books" });
  const sentinel = el("div", { class: "sentinel" });

  const input = searchField.querySelector("input");
  input.value = libQuery;
  clearButton.hidden = libQuery.length === 0;
  input.addEventListener("input", () => {
    clearButton.hidden = input.value.length === 0;
  });
  clearButton.addEventListener("click", () => {
    input.value = "";
    clearButton.hidden = true;
    libQuery = "";
    void loadLibrary({ reset: true });
    input.focus();
  });
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    libQuery = input.value.trim();
    void loadLibrary({ reset: true });
    input.blur();
  });

  app.replaceChildren(el("div", { class: "lib" }, [bar, searchForm, grid, sentinel]));
  return { grid, sentinel, barSub: bar.querySelector(".bar-sub") };
}

function skeletonCards(count = 6) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(
      el("div", { class: "card card-skeleton", "aria-hidden": "true" }, [
        el("div", { class: "poster skeleton" }),
        el("div", { class: "card-title skeleton", style: { height: "14px" } }),
      ]),
    );
  }
  return cards;
}

function readLabel(book) {
  if (!Number.isInteger(book.pageCount) || book.pageCount < 2) return "";
  if (book.currentPage >= book.pageCount - 1) return t("readComplete");
  const fraction =
    Math.max(0, book.currentPage + (book.scrollPct >= 0 ? book.scrollPct : 0)) /
    book.pageCount;
  const percent = Math.min(99, Math.max(0, Math.round(fraction * 100)));
  if (percent === 0) return t("readUnread");
  return t("readPercent", { percent });
}

function bookCard(book) {
  const poster = el("div", { class: "poster" });
  poster.append(
    el("span", { class: "poster-fallback" }, icon("image")),
  );
  if (book.thumbUrl && /^\/api\/books\/[a-f0-9]{64}\/thumb(?:\?[^#]*)?$/.test(book.thumbUrl)) {
    const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("load", () => {
      img.dataset.loaded = "true";
    });
    img.addEventListener("error", () => img.remove());
    img.src = book.thumbUrl;
    poster.append(img);
  }

  const label = readLabel(book);
  if (book.missing) {
    poster.append(el("span", { class: "badge badge-missing", text: t("missing") }));
  } else if (label && label !== t("readUnread")) {
    poster.append(
      el("span", {
        class: "badge" + (label === t("readComplete") ? " badge-done" : ""),
        text: label,
      }),
    );
  }

  const progressText = label || t("readUnread");
  const card = el("button", {
    class: "card",
    type: "button",
    "aria-label": `${book.title}, ${progressText}`,
  }, [poster, el("span", { class: "card-title", text: book.title })]);
  card.addEventListener("click", () => void openBook(book));
  return card;
}

async function loadLibrary({ reset = false } = {}) {
  if (libLoading) return;
  libLoading = true;
  const token = ++libSeq;
  const grid = document.getElementById("books");
  const sentinel = document.querySelector(".sentinel");
  const barSub = document.querySelector(".bar-sub");

  if (reset) {
    libCursor = null;
    if (grid) grid.replaceChildren(...skeletonCards());
  }
  if (sentinel) sentinel.textContent = t("loadingMore");

  try {
    const params = new URLSearchParams({ limit: "40" });
    if (libQuery) params.set("q", libQuery);
    if (libCursor) params.set("cursor", libCursor);
    const result = await api(`/api/books?${params}`);
    if (token !== libSeq) return;
    if (reset && grid) grid.replaceChildren();
    const target = document.getElementById("books");
    if (!target) return;
    for (const book of result.items) target.append(bookCard(book));
    libCursor = result.nextCursor || null;
    if (barSub) barSub.textContent = t("totalBooks", { count: target.children.length });
    if (!target.children.length) {
      target.append(
        el("div", { class: "empty" }, [icon("image"), el("p", { text: t("noBooks") })]),
      );
    }
    if (sentinel) {
      sentinel.replaceChildren();
      if (libCursor) {
        sentinel.append(
          el("button", {
            class: "btn",
            type: "button",
            text: t("loadMore"),
            onclick: () => void loadLibrary(),
          }),
        );
      } else if (target.children.length) {
        sentinel.textContent = t("noMore");
      }
    }
  } catch (error) {
    if (token !== libSeq) return;
    if (grid) grid.replaceChildren();
    if (grid) grid.append(errorNotice(error, () => void loadLibrary({ reset: true })));
    if (sentinel) sentinel.replaceChildren();
  } finally {
    if (token === libSeq) libLoading = false;
  }
}

async function library({ restoreScroll = false } = {}) {
  screen = "library";
  activeBook = null;
  closeSheets(true);
  clearReader();
  document.documentElement.classList.remove("reader-open");
  app.replaceChildren(el("p", { class: "notice", text: t("loading") }));
  const { sentinel } = mountLibraryShell();
  if (libSentinelObserver) libSentinelObserver.disconnect();
  if (sentinel && typeof IntersectionObserver === "function") {
    libSentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && libCursor && !libLoading) {
          void loadLibrary();
        }
      },
      { rootMargin: "600px 0px" },
    );
    libSentinelObserver.observe(sentinel);
  }
  await loadLibrary({ reset: true });
  if (restoreScroll) {
    requestAnimationFrame(() => window.scrollTo(0, libScrollY));
  }
}

/* ================================================================= pairing */

async function pair(pairingId) {
  screen = "pair";
  clearReader();
  activeBook = null;
  app.replaceChildren(
    el("div", { class: "pair" }, [
      el("section", { class: "pair-card" }, [
        el("span", { class: "pair-icon" }, icon("device")),
        el("h1", { text: t("pairDevice") }),
        el("p", { text: t("approveOnDesktop") }),
        el("input", {
          class: "field",
          id: "pair-name",
          maxlength: "64",
          placeholder: t("deviceName"),
          "aria-label": t("deviceName"),
          autocomplete: "off",
        }),
        el("button", {
          class: "btn btn-primary btn-block",
          type: "button",
          id: "pair-submit",
          text: t("requestPairing"),
        }),
      ]),
    ]),
  );
  const input = document.getElementById("pair-name");
  const submit = document.getElementById("pair-submit");
  const card = app.querySelector(".pair-card");
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    input.disabled = true;
    const token = generation;
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const claimNonce = btoa(String.fromCharCode(...nonce))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    try {
      const claim = await api("/api/pair/claim", {
        method: "POST",
        body: JSON.stringify({ pairingId, deviceName: input.value, claimNonce }),
      });
      card.append(el("p", { text: t("approveOnDesktop") }));
      for (;;) {
        const status = await api(`/api/pair/claim/${encodeURIComponent(claim.claimId)}`);
        if (token !== generation) return;
        if (status.state === "approved") {
          await api(`/api/pair/claim/${encodeURIComponent(claim.claimId)}/consume`, {
            method: "POST",
          });
          await library();
          return;
        }
        if (status.state !== "pending") throw new Error("ended");
      }
    } catch {
      if (token !== generation) return;
      card.append(el("p", { class: "notice-error", text: t("pairingFailed") }));
      submit.disabled = false;
      input.disabled = false;
    }
  });
}

async function requestLocalPair() {
  if (screen === "pair") return;
  clearReader();
  activeBook = null;
  screen = "pair";
  const token = generation;
  app.replaceChildren(
    el("div", { class: "pair" }, [
      el("section", { class: "pair-card" }, [
        el("span", { class: "pair-icon" }, icon("device")),
        el("h1", { text: t("pairDevice") }),
        el("p", { text: t("approveOnDesktop") }),
      ]),
    ]),
  );
  const card = app.querySelector(".pair-card");
  try {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const claimNonce = btoa(String.fromCharCode(...nonce))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const ua = navigator.userAgent || "";
    const deviceName = /iPhone|iPad/.test(ua)
      ? "iPhone / iPad"
      : /Android/.test(ua)
        ? "Android"
        : t("webBrowser");
    const claim = await api("/api/pair/claim", {
      method: "POST",
      body: JSON.stringify({ pairingId: "local", deviceName, claimNonce }),
    });
    while (token === generation) {
      const status = await api(`/api/pair/claim/${encodeURIComponent(claim.claimId)}`);
      if (status.state === "approved") {
        await api(`/api/pair/claim/${encodeURIComponent(claim.claimId)}/consume`, {
          method: "POST",
        });
        if (token === generation) await library();
        return;
      }
      if (status.state !== "pending") throw new Error("ended");
    }
  } catch {
    if (token !== generation) return;
    card.replaceChildren(
      el("p", { class: "notice-error", text: t("pairingFailed") }),
      el("button", {
        class: "btn btn-primary btn-block",
        type: "button",
        text: t("retry"),
        onclick: () => void requestLocalPair(),
      }),
    );
  }
}

async function start() {
  screen = "boot";
  clearReader();
  activeBook = null;
  app.replaceChildren(el("p", { class: "notice", text: t("loading") }));
  try {
    await api("/api/session");
    await library();
  } catch (error) {
    if (location.protocol === "http:" && error && error.code === "unauthorized") {
      await requestLocalPair();
    } else {
      app.replaceChildren(
        el("div", { class: "pair" }, [
          el("section", { class: "pair-card" }, [
            el("h1", { text: t("connectionFailed") }),
            el("button", {
              class: "btn btn-primary btn-block",
              type: "button",
              text: t("retry"),
              onclick: () => void start(),
            }),
          ]),
        ]),
      );
    }
  }
}

/* ============================================================== reader hud */

function setHud(visible, autoHide = true) {
  hudVisible = visible;
  if (topHud) topHud.dataset.hidden = String(!visible);
  if (bottomHud) bottomHud.dataset.hidden = String(!visible);
  if (hudTimer) {
    clearTimeout(hudTimer);
    hudTimer = 0;
  }
  if (visible && autoHide) {
    hudTimer = window.setTimeout(() => {
      hudTimer = 0;
      if (!tocOpen && !displayOpen && !conflict) setHud(false, false);
    }, 3800);
  }
}

function toggleHud() {
  setHud(!hudVisible);
}

function keepHudAlive() {
  if (hudVisible) setHud(true);
}

function pagerText(current, total) {
  return t("pageOf", { current: String(current), total: String(total) });
}

function updateHud() {
  if (!readerEl) return;
  if (titleEl) titleEl.textContent = activeBook ? activeBook.title : "";
  if (pagerEl) pagerEl.textContent = pagerText(Math.min(page + 1, pageCount), pageCount);
  if (scrubberEl) {
    scrubberEl.max = String(Math.max(1, pageCount));
    scrubberEl.value = String(Math.min(page + 1, pageCount));
    scrubberEl.disabled = pageCount <= 1 || busy || !!conflict;
  }
  if (prevButton) prevButton.disabled = busy || !!conflict || page <= 0;
  if (nextButton) nextButton.disabled = busy || !!conflict || page >= pageCount - 1;
  if (modeButton) {
    const mode = effectiveMode();
    modeButton.replaceChildren(icon(mode === "webtoon" ? "scroll" : "book"));
    modeButton.append(el("span", { text: mode === "webtoon" ? t("modeWebtoon") : t("modePaged") }));
    modeButton.setAttribute(
      "aria-label",
      `${t(mode === "webtoon" ? "modePaged" : "modeWebtoon")}`,
    );
  }
  if (bgButton) {
    bgButton.replaceChildren(icon("contrast"));
    bgButton.append(
      el("span", {
        text: prefs.bg === "paper" ? t("bgPaper") : prefs.bg === "night" ? t("bgNight") : t("bgAuto"),
      }),
    );
    bgButton.setAttribute(
      "aria-label",
      `${t("background")}: ${prefs.bg === "paper" ? t("bgPaper") : prefs.bg === "night" ? t("bgNight") : t("bgAuto")}`,
    );
  }
  readerEl.dataset.mode = effectiveMode();
}

function buildHud() {
  prevButton = el("button", {
    class: "hud-btn",
    type: "button",
    "aria-label": t("previous"),
    title: t("previous"),
  }, icon("back"));
  prevButton.addEventListener("click", () => goPage(-1));

  nextButton = el("button", {
    class: "hud-btn",
    type: "button",
    "aria-label": t("next"),
    title: t("next"),
  }, icon("next"));
  nextButton.addEventListener("click", () => goPage(1));

  titleEl = el("h1", { class: "hud-title" });

  topHud = el("header", { class: "hud hud-top" }, [
    el("button", {
      class: "hud-btn",
      type: "button",
      "aria-label": t("backToLibrary"),
      title: t("backToLibrary"),
      onclick: exitToLibrary,
    }, icon("back")),
    el("div", { class: "hud-title-wrap" }, [titleEl]),
    el("button", {
      class: "hud-btn",
      type: "button",
      "aria-label": t("toc"),
      title: t("toc"),
      onclick: openToc,
    }, icon("list")),
  ]);

  pagerEl = el("span", { class: "pager", "data-testid": "pager" });
  scrubberEl = el("input", {
    class: "scrubber",
    type: "range",
    min: "1",
    max: "1",
    step: "1",
    value: "1",
    "aria-label": t("page"),
  });
  scrubberEl.addEventListener("input", () => {
    keepHudAlive();
    if (pagerEl) pagerEl.textContent = pagerText(scrubberEl.value, pageCount);
  });
  scrubberEl.addEventListener("change", () => {
    const target = Number(scrubberEl.value) - 1;
    if (Number.isInteger(target) && target !== page) void changePage(target);
  });

  modeButton = el("button", {
    class: "hud-action",
    type: "button",
    "data-testid": "mode-toggle",
  });
  modeButton.addEventListener("click", () => {
    keepHudAlive();
    prefs.mode = effectiveMode() === "webtoon" ? "paged" : "webtoon";
    savePrefs();
    resetZoom();
    renderPageView();
  });

  bgButton = el("button", {
    class: "hud-action",
    type: "button",
    "data-testid": "bg-toggle",
  });
  bgButton.addEventListener("click", () => {
    keepHudAlive();
    prefs.bg = prefs.bg === "auto" ? "paper" : prefs.bg === "paper" ? "night" : "auto";
    savePrefs();
    applyBackground();
    updateHud();
  });

  const brightnessButton = el("button", {
    class: "hud-action",
    type: "button",
    "aria-label": t("brightness"),
  }, [icon("sun"), el("span", { text: t("display") })]);
  brightnessButton.addEventListener("click", () => openDisplay());

  const tocButton = el("button", {
    class: "hud-action",
    type: "button",
    "aria-label": t("toc"),
  }, [icon("list"), el("span", { text: t("toc") })]);
  tocButton.addEventListener("click", openToc);

  bottomHud = el("div", { class: "hud hud-bottom" }, [
    el("div", { class: "scrub-row" }, [prevButton, scrubberEl, pagerEl, nextButton]),
    el("div", { class: "hud-actions" }, [
      modeButton,
      brightnessButton,
      bgButton,
      tocButton,
      el("span", { class: "hud-spacer" }),
    ]),
  ]);
}

function buildTapZones() {
  zonesEl = el("div", { class: "tapzones", "aria-hidden": "true" });
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const zone = el("div", { class: "zone", "data-row": String(row), "data-col": String(col) });
      zone.addEventListener("click", () => onZone(row, col));
      zonesEl.append(zone);
    }
  }
}

function onZone(row, col) {
  if (!activeBook) return;
  if (effectiveMode() === "webtoon") {
    // Scrolling already moves through the strip; a tap only reveals the HUD.
    toggleHud();
    return;
  }
  if (row === 1 && col === 1) {
    toggleHud();
    return;
  }
  if (col === 0) {
    goPage(-1);
    return;
  }
  if (col === 2) {
    goPage(1);
    return;
  }
  if (row === 0) {
    goPage(-1);
    return;
  }
  if (row === 2) {
    goPage(1);
  }
}

/* ================================================================= reader */

function mountReader() {
  screen = "reader";
  document.documentElement.classList.add("reader-open");
  app.replaceChildren();
  readerEl = el("section", { class: "reader", "data-mode": "paged" });
  stageEl = el("div", { class: "stage", "data-testid": "stage" });
  viewEl = el("div", { class: "view" });
  stageEl.append(viewEl);
  dimEl = el("div", { class: "dim" });
  buildTapZones();
  buildHud();
  buildSheets();
  readerEl.append(stageEl, dimEl, zonesEl, topHud, bottomHud);
  app.append(readerEl);
  readerEl.style.setProperty("--r-zoom", String(zoom));
  bindStageGestures();
  bindScrollIntent();
  updateHud();
  setHud(true);
}

function bindScrollIntent() {
  const mark = () => {
    userScrolled = true;
  };
  stageEl.addEventListener("touchstart", mark, { passive: true });
  stageEl.addEventListener("wheel", mark, { passive: true });
  stageEl.addEventListener("pointerdown", mark, { passive: true });
}

function bindStageGestures() {
  let pinch = null;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  readerEl.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2) return;
      const [a, b] = event.touches;
      pinch = {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        zoom,
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
    },
    { passive: true },
  );

  readerEl.addEventListener(
    "touchmove",
    (event) => {
      if (!pinch || event.touches.length !== 2) return;
      if (effectiveMode() !== "webtoon") return;
      event.preventDefault();
      const [a, b] = event.touches;
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch.distance < 8) return;
      applyZoom(pinch.zoom * (distance / pinch.distance), pinch.y, pinch.x);
    },
    { passive: false },
  );

  readerEl.addEventListener(
    "touchend",
    (event) => {
      if (event.touches.length > 0) return;
      pinch = null;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      const now = Date.now();
      if (now - lastTapAt < 300 && Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 44) {
        lastTapAt = 0;
        if (effectiveMode() === "webtoon") {
          applyZoom(zoom > 1.05 ? 1 : 2, touch.clientY, touch.clientX);
        }
        return;
      }
      lastTapAt = now;
      lastTapX = touch.clientX;
      lastTapY = touch.clientY;
    },
    { passive: true },
  );

}

function onKeyDown(event) {
  if (screen !== "reader") return;
  const target = event.target;
  if (target && target.closest && target.closest("input, select, textarea")) return;
  switch (event.key) {
    case "ArrowLeft":
      event.preventDefault();
      goPage(-1);
      break;
    case "ArrowRight":
      event.preventDefault();
      goPage(1);
      break;
    case "Escape":
      if (tocOpen || displayOpen || conflictSheet?.dataset.open === "true") closeSheets();
      else setHud(!hudVisible);
      break;
    case "t":
    case "T":
      openToc();
      break;
    case "m":
    case "M":
      prefs.mode = effectiveMode() === "webtoon" ? "paged" : "webtoon";
      savePrefs();
      resetZoom();
      renderPageView();
      break;
    case "h":
    case "H":
      toggleHud();
      break;
    default:
      break;
  }
}

function resetZoom() {
  zoom = 1;
  if (readerEl) readerEl.style.setProperty("--r-zoom", "1");
  layoutGeometryCache = null;
}

function applyZoom(next, clientY, clientX) {
  if (!readerEl || !stageEl) return;
  const clamped = Math.min(3, Math.max(1, Math.round(next * 100) / 100));
  if (Math.abs(clamped - zoom) < 0.01) return;
  const rect = stageEl.getBoundingClientRect();
  const offsetY = (clientY ?? rect.top + rect.height / 2) - rect.top;
  const offsetX = (clientX ?? rect.left + rect.width / 2) - rect.left;
  const focalY = offsetY + stageEl.scrollTop;
  const focalX = offsetX + stageEl.scrollLeft;
  const ratio = clamped / zoom;
  zoom = clamped;
  readerEl.style.setProperty("--r-zoom", String(zoom));
  layoutGeometryCache = null;
  scrollReady = false;
  const stage = stageEl;
  requestAnimationFrame(() => {
    if (!stage) return;
    // Width-based zoom (not transform) keeps the scroll height honest.
    stage.scrollTop = Math.max(0, focalY * ratio - offsetY);
    stage.scrollLeft = zoom > 1 ? Math.max(0, focalX * ratio - offsetX) : 0;
    if (stage === stageEl) scrollReady = true;
  });
}

function renderPageView() {
  if (!activeBook || !viewEl) return;
  teardownView();
  const token = generation;
  const mode = effectiveMode();
  readerEl.dataset.mode = mode;
  viewEl.dataset.mode = mode;
  updateHud();
  const dim = layoutDims && layoutDims[page];
  if (mode === "webtoon") mountTiles(token, dim);
  else mountPagedPage(token);
}

/* -------------------------------------------------------------- paged view */

async function fetchPageUrl(index, signal) {
  const width = renderWidth();
  const key = `${index}@${width}`;
  const hit = pagedCache.get(key);
  if (hit) {
    pagedCache.delete(key);
    pagedCache.set(key, hit);
    return hit.url;
  }
  const response = await fetch(
    `/api/books/${activeBook.id}/pages/${index}?w=${width}`,
    { credentials: "same-origin", cache: "no-store", signal },
  );
  if (!response.ok) throw await apiError(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  pagedCache.set(key, { url });
  while (pagedCache.size > 4) {
    const oldest = pagedCache.keys().next().value;
    const entry = pagedCache.get(oldest);
    if (entry) URL.revokeObjectURL(entry.url);
    pagedCache.delete(oldest);
  }
  return url;
}

function preloadNeighbour(index) {
  if (index < 0 || index >= pageCount || !activeBook) return;
  fetchPageUrl(index, null).catch(() => {});
}

async function mountPagedPage(token) {
  const myToken = pageToken;
  const shell = el("div", { class: "page-shell" });
  const skeleton = el("div", { class: "page-skeleton skeleton" });
  shell.append(skeleton);
  viewEl.append(shell);
  const controller = new AbortController();
  pageAbort = controller;
  try {
    const url = await fetchPageUrl(page, controller.signal);
    if (token !== generation || myToken !== pageToken || !viewEl) return;
    const img = el("img", {
      class: "page-img",
      alt: "",
      decoding: "async",
      draggable: "false",
    });
    img.addEventListener("load", () => skeleton.remove(), { once: true });
    img.addEventListener("error", () => {
      if (token !== generation) return;
      shell.replaceChildren();
      shell.append(errorNotice({ code: "image-failed" }, () => renderPageView()));
    });
    img.src = url;
    // The URL is owned by `pagedCache` (revoked on book close), so it must not
    // enter `viewBlobs` — otherwise a page turn would revoke a cached copy.
    shell.append(img);
    scrollReady = true;
    img.addEventListener(
      "load",
      () => {
        if (!img.naturalWidth || !img.naturalHeight) return;
        aspectHints.set(page, img.naturalHeight / img.naturalWidth);
        if (prefs.mode === "auto" && effectiveMode() === "webtoon") {
          resetZoom();
          renderPageView();
        }
      },
      { once: true },
    );
    window.setTimeout(() => {
      if (myToken === pageToken) {
        preloadNeighbour(page + 1);
        preloadNeighbour(page - 1);
      }
    }, 120);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    if (token !== generation) return;
    shell.replaceChildren();
    shell.append(errorNotice(error, () => renderPageView()));
  } finally {
    if (pageAbort === controller) pageAbort = null;
  }
}

/* ------------------------------------------------------------ webtoon view */

function mountTiles(token, dim) {
  const myToken = pageToken;
  const tiles = el("div", { class: "tiles" });
  viewEl.append(tiles);
  const width = renderWidth();
  const base = `/api/books/${activeBook.id}/pages/${page}/tiles/`;
  let inflight = 0;
  const queue = [];
  let loaded = 0;

  const pump = () => {
    while (token === generation && inflight < 3 && queue.length) {
      const part = queue.shift();
      inflight += 1;
      const controller = new AbortController();
      viewControllers.push(controller);
      fetch(`${base}${part.dataset.tile}?w=${width}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error("tile");
          return response.blob();
        })
        .then((blob) => {
          if (token !== generation || myToken !== pageToken) return;
          const url = URL.createObjectURL(blob);
          viewBlobs.push(url);
          const img = el("img", { alt: "", decoding: "async" });
          img.addEventListener(
            "load",
            () => {
              part.classList.remove("tile-pending");
              if (part.dataset.reserved !== "true") {
                part.style.aspectRatio = "";
                part.style.minHeight = "";
              }
              part.replaceChildren(img);
              loaded += 1;
              if (loaded >= tiles.children.length) appendEndcap();
            },
            { once: true },
          );
          img.src = url;
        })
        .catch((error) => {
          if (token !== generation || myToken !== pageToken) return;
          if (error && error.name === "AbortError") return;
          part.classList.remove("tile-pending");
          part.replaceChildren(errorNotice({ code: "image-failed" }, () => renderPageView()));
        })
        .finally(() => {
          if (token === generation && myToken === pageToken) {
            inflight -= 1;
            pump();
          }
          viewControllers = viewControllers.filter((item) => item !== controller);
        });
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        queue.push(entry.target);
        pump();
      }
    },
    { root: stageEl, rootMargin: "1600px 0px" },
  );
  tileObserver = observer;

  (async () => {
    const controller = new AbortController();
    pageAbort = controller;
    try {
      const first = await fetch(`${base}0?w=${width}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!first.ok) throw await apiError(first);
      const count = Number(first.headers.get("X-Tile-Count"));
      if (!Number.isInteger(count) || count < 1 || count > 10000) {
        throw new Error("tile-count");
      }
      if (token !== generation || myToken !== pageToken) return;
      const ratios = tileAspectRatios(dim, width, count);
      const parts = [];
      for (let i = 0; i < count; i += 1) {
        const part = el("div", { class: "tile tile-pending" });
        part.dataset.tile = String(i);
        if (ratios && ratios[i]) {
          part.style.aspectRatio = ratios[i];
          part.dataset.reserved = "true";
        } else {
          part.style.minHeight = i === 0 ? "70vh" : "50vh";
        }
        parts.push(part);
      }
      tiles.replaceChildren(...parts);
      for (let i = 1; i < count; i += 1) observer.observe(parts[i]);

      const firstBlob = await first.blob();
      if (token !== generation || myToken !== pageToken) return;
      const url = URL.createObjectURL(firstBlob);
      viewBlobs.push(url);
      const image = el("img", { alt: "", decoding: "async" });
      image.addEventListener(
        "load",
        () => {
          parts[0].classList.remove("tile-pending");
          if (parts[0].dataset.reserved !== "true") {
            parts[0].style.aspectRatio = "";
            parts[0].style.minHeight = "";
          }
          parts[0].replaceChildren(image);
          loaded += 1;
          if (loaded >= parts.length) appendEndcap();
        },
        { once: true },
      );
      image.src = url;

      scrollListener = () => scheduleScrollProgress();
      stageEl.addEventListener("scroll", scrollListener, { passive: true });
      if (layoutGeometry()) restoreScroll(savedScrollPct, token);
      else scrollReady = true;
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (token !== generation) return;
      tiles.replaceChildren();
      tiles.append(errorNotice(error, () => renderPageView()));
    } finally {
      if (pageAbort === controller) pageAbort = null;
    }
  })();
}

function appendEndcap() {
  if (!viewEl || endcapEl || !activeBook) return;
  if (page >= pageCount - 1) {
    endcapEl = el("div", { class: "endcap" }, [el("span", { text: t("readComplete") })]);
  } else {
    endcapEl = el("div", { class: "endcap" }, [
      el("span", { text: t("endOfPage") }),
      el("button", {
        class: "btn",
        type: "button",
        text: t("continueNext"),
        onclick: () => goPage(1),
      }),
    ]);
  }
  viewEl.append(endcapEl);
}

/* -------------------------------------------------------------- page turn */

function goPage(delta) {
  if (!activeBook || busy || conflict) return;
  const next = Math.min(pageCount - 1, Math.max(0, page + delta));
  if (next === page) return;
  void changePage(next);
}

async function changePage(next, base = null, scrollPct = null) {
  if (busy || !activeBook || next < 0 || next >= pageCount) return;
  const token = generation;
  busy = true;
  updateHud();
  let result = null;
  try {
    if (base == null && !conflict) {
      await flushScrollProgress();
      await progressWriteChain;
      if (token !== generation || conflict) return;
    }
    pendingScrollPct = null;
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = 0;
    result = await queueProgressWrite(next, scrollPct, base, token);
  } finally {
    if (token === generation) {
      busy = false;
      updateHud();
    }
  }
  if (!result || token !== generation) return;
  page = result.page;
  clampedProgressNotice = false;
  savedScrollPct = scrollPct == null ? -1 : scrollPct;
  pendingScrollPct = null;
  resetZoom();
  renderPageView();
  if (stageEl) stageEl.scrollTop = 0;
  announce(pagerText(page + 1, pageCount));
}

/* ------------------------------------------------------------------ sheets */

function buildSheets() {
  scrimEl = el("div", { class: "scrim" });
  scrimEl.addEventListener("click", closeSheets);

  tocSheet = el("section", { class: "sheet", "data-open": "false", "aria-label": t("tocTitle") }, [
    el("div", { class: "sheet-grip" }),
    el("div", { class: "sheet-head" }, [
      el("h2", { text: t("tocTitle") }),
      el("button", {
        class: "iconbtn",
        type: "button",
        "aria-label": t("close"),
        onclick: closeSheets,
      }, icon("close")),
    ]),
    el("div", { class: "sheet-body", id: "toc-body" }),
  ]);

  displaySheet = el("section", { class: "sheet", "data-open": "false", "aria-label": t("display") }, [
    el("div", { class: "sheet-grip" }),
    el("div", { class: "sheet-head" }, [
      el("h2", { text: t("display") }),
      el("button", {
        class: "iconbtn",
        type: "button",
        "aria-label": t("close"),
        onclick: closeSheets,
      }, icon("close")),
    ]),
    el("div", { class: "sheet-body", id: "display-body" }),
  ]);

  conflictSheet = el("section", {
    class: "sheet",
    "data-open": "false",
    "aria-label": t("progressConflict"),
  }, [
    el("div", { class: "sheet-grip" }),
    el("div", { class: "sheet-head" }, [el("h2", { text: t("progressConflict") })]),
    el("div", { class: "sheet-body" }, [
      el("p", { class: "notice", text: t("progressConflict") }),
      el("button", {
        class: "btn btn-primary btn-block",
        type: "button",
        text: t("useOtherPage"),
        id: "conflict-use",
      }),
      el("button", {
        class: "btn btn-block",
        type: "button",
        text: t("saveThisPage"),
        id: "conflict-save",
      }),
    ]),
  ]);

  readerEl.append(scrimEl, tocSheet, displaySheet, conflictSheet);
  conflictSheet.querySelector("#conflict-use").addEventListener("click", useOtherDevice);
  conflictSheet.querySelector("#conflict-save").addEventListener("click", saveThisPage);
}

function openToc() {
  if (!tocSheet) return;
  renderToc();
  closeSheets(true);
  tocOpen = true;
  tocSheet.dataset.open = "true";
  scrimEl.dataset.open = "true";
  setHud(false, false);
}

function renderToc() {
  const body = tocSheet.querySelector("#toc-body");
  if (!body) return;
  const input = el("input", {
    type: "number",
    min: "1",
    max: String(Math.max(1, pageCount)),
    value: String(page + 1),
    "aria-label": t("jumpTo"),
    inputmode: "numeric",
  });
  const jump = () => {
    const target = Number(input.value);
    if (!Number.isInteger(target)) return;
    const index = Math.min(pageCount - 1, Math.max(0, target - 1));
    closeSheets();
    if (index !== page) void changePage(index);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jump();
    }
  });

  const grid = el("div", { class: "toc-grid" });
  const start = Math.max(0, page - 40);
  const end = Math.min(pageCount, page + 160);
  for (let i = start; i < end; i += 1) {
    const item = el("button", {
      class: "toc-item",
      type: "button",
      text: String(i + 1),
      "aria-label": `${t("page")} ${i + 1}`,
    });
    if (i === page) item.dataset.current = "true";
    item.addEventListener("click", () => {
      closeSheets();
      if (i !== page) void changePage(i);
    });
    grid.append(item);
  }

  body.replaceChildren(
    el("div", { class: "toc-jump" }, [
      el("span", { class: "display-label", text: t("jumpTo") }),
      input,
      el("button", { class: "btn", type: "button", text: t("go"), onclick: jump }),
    ]),
    grid,
    el("p", {
      class: "toc-hint",
      text: `${t("page")} 1–${pageCount} · ${t("tapHint")}`,
    }),
  );
}

function openDisplay() {
  if (!displaySheet) return;
  renderDisplay();
  closeSheets(true);
  displayOpen = true;
  displaySheet.dataset.open = "true";
  scrimEl.dataset.open = "true";
  setHud(false, false);
}

function segmented(options, active, onPick) {
  const group = el("div", { class: "seg", role: "group" });
  for (const [value, label] of options) {
    const button = el("button", {
      class: "seg-btn",
      type: "button",
      text: label,
      "aria-pressed": String(value === active),
    });
    button.addEventListener("click", () => onPick(value));
    group.append(button);
  }
  return group;
}

function renderDisplay() {
  const body = displaySheet.querySelector("#display-body");
  if (!body) return;

  const brightness = el("input", {
    class: "brightness-range",
    type: "range",
    min: "30",
    max: "100",
    step: "1",
    value: String(Math.round(prefs.brightness * 100)),
    "aria-label": t("brightness"),
  });
  brightness.addEventListener("input", () => {
    prefs.brightness = Number(brightness.value) / 100;
    applyBrightness();
    savePrefs();
  });

  const bgSeg = segmented(
    [
      ["auto", t("bgAuto")],
      ["paper", t("bgPaper")],
      ["night", t("bgNight")],
    ],
    prefs.bg,
    (value) => {
      prefs.bg = value;
      savePrefs();
      applyBackground();
      updateHud();
      renderDisplay();
    },
  );

  const themeSeg = segmented(
    [
      ["auto", t("themeAuto")],
      ["light", t("themeLight")],
      ["dark", t("themeDark")],
    ],
    prefs.theme,
    (value) => {
      prefs.theme = value;
      savePrefs();
      applyTheme();
      renderDisplay();
    },
  );

  body.replaceChildren(
    el("div", { class: "display-row" }, [
      el("span", { class: "display-label" }, [icon("sun"), el("span", { text: t("brightness") })]),
      el("div", { class: "display-control" }, [brightness]),
    ]),
    el("div", { class: "display-row" }, [
      el("span", { class: "display-label" }, [icon("contrast"), el("span", { text: t("background") })]),
      el("div", { class: "display-control" }, [bgSeg]),
    ]),
    el("div", { class: "display-row" }, [
      el("span", { class: "display-label" }, [icon("book"), el("span", { text: t("theme") })]),
      el("div", { class: "display-control" }, [themeSeg]),
    ]),
    el("p", { class: "toc-hint", text: `${t("tapHint")} ${t("zoomHint")}` }),
  );
}

function openConflictSheet() {
  if (!conflictSheet) return;
  closeSheets(true);
  conflictSheet.dataset.open = "true";
  scrimEl.dataset.open = "true";
  setHud(false, false);
  updateHud();
}

async function useOtherDevice() {
  if (!conflict || !activeBook) return;
  const token = generation;
  try {
    const current = await api(`/api/books/${activeBook.id}/progress`);
    if (token !== generation) return;
    page = Math.min(current.page, current.pageCount - 1);
    pageCount = current.pageCount;
    clampedProgressNotice = current.page >= current.pageCount;
    revision = current.rev;
    savedScrollPct =
      clampedProgressNotice || !Number.isFinite(current.scrollPct) ? -1 : current.scrollPct;
    conflict = null;
    closeSheets(true);
    renderPageView();
  } catch (error) {
    if (token === generation) toast(errorText(error));
  }
}

function saveThisPage() {
  if (!conflict) return;
  const desired = conflict;
  conflict = null;
  closeSheets(true);
  void changePage(desired.desiredPage, desired.currentRev, desired.desiredScrollPct);
}

/* ------------------------------------------------------------ entry points */

async function openBook(book) {
  screen = "reader";
  clearReader();
  const token = generation;
  activeBook = book;
  pageCount = 0;
  conflict = null;
  clampedProgressNotice = false;
  libScrollY = window.scrollY;
  app.replaceChildren(el("p", { class: "notice", text: t("loading") }));

  if (book.format === "pdf") {
    app.replaceChildren(
      el("div", { class: "pair" }, [
        el("section", { class: "pair-card" }, [
          el("h1", { text: t("pdfUnsupported") }),
          el("button", {
            class: "btn btn-primary btn-block",
            type: "button",
            text: t("backToLibrary"),
            onclick: () => void library({ restoreScroll: true }),
          }),
        ]),
      ]),
    );
    return;
  }

  try {
    const progress = await api(`/api/books/${book.id}/progress`);
    if (token !== generation) return;
    if (!Number.isInteger(progress.pageCount) || progress.pageCount < 1) {
      throw Object.assign(new Error("empty"), { code: "source-unsupported" });
    }
    if (!Number.isInteger(progress.page) || progress.page < 0) {
      throw new Error("invalid page");
    }
    clampedProgressNotice = progress.page >= progress.pageCount;
    page = Math.min(progress.page, progress.pageCount - 1);
    pageCount = progress.pageCount;
    revision = progress.rev;

    let layout = null;
    try {
      layout = await api(`/api/books/${book.id}/layout`);
    } catch {
      layout = null;
    }
    if (token !== generation) return;
    layoutDims = validatedLayout(layout, pageCount);
    layoutGeometryCache = null;
    savedScrollPct =
      clampedProgressNotice || !Number.isFinite(progress.scrollPct) ? -1 : progress.scrollPct;

    mountReader();
    renderPageView();
    if (!pushedReader) {
      pushedReader = true;
      history.pushState({ mr: "reader" }, "");
    }
    if (clampedProgressNotice) toast(t("clampedNotice"));
  } catch (error) {
    if (token !== generation) return;
    activeBook = null;
    app.replaceChildren(
      el("div", { class: "pair" }, [
        el("section", { class: "pair-card" }, [
          el("h1", { text: errorText(error) }),
          el("button", {
            class: "btn btn-primary btn-block",
            type: "button",
            text: t("backToLibrary"),
            onclick: () => void library({ restoreScroll: true }),
          }),
        ]),
      ]),
    );
  }
}

function exitToLibrary() {
  if (pushedReader) {
    pushedReader = false;
    history.back();
    return;
  }
  void library({ restoreScroll: true });
}

window.addEventListener("popstate", () => {
  if (screen !== "reader") return;
  pushedReader = false;
  void library({ restoreScroll: true });
});

window.addEventListener("keydown", onKeyDown);

let resizeTimer = 0;
let lastViewportWidth = window.innerWidth;
window.addEventListener("resize", () => {
  const width = window.innerWidth;
  const changed = Math.abs(width - lastViewportWidth) >= 24;
  lastViewportWidth = width;
  if (!changed || screen !== "reader" || !readerEl) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = 0;
    if (screen !== "reader" || !readerEl) return;
    const pct = currentScrollPct();
    if (pct != null) savedScrollPct = pct;
    layoutGeometryCache = null;
    renderPageView();
  }, 280);
});

/* ------------------------------------------------------------------ boot */

const fragment = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
if (typeof window.__moyuBooted === "function") window.__moyuBooted();
if (/^pair_[0-9a-f]{32}$/.test(fragment)) void pair(fragment);
else void start();
