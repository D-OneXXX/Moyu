import { messages } from "/reader-messages.js";
const preferred = navigator.language || "en";
let locale = preferred.startsWith("zh") ? /TW|HK|Hant/i.test(preferred) ? "zh-TW" : "zh-CN" : ["es", "ja", "ko"].find((x) => preferred.startsWith(x)) || "en";
const t = (n) => messages[locale][n];
const app = document.getElementById("app");
const actions = document.getElementById("header-actions");
let pairingContext = null;
let clampedProgressNotice = false;
let generation = 0, activeBook = null, revision = 0, page = 0, pageCount = 0, busy = false, conflict = null;
const breadcrumbs = [];
function recordBreadcrumb(kind) {
  breadcrumbs.push({ kind, at: (/* @__PURE__ */ new Date()).toISOString() });
  if (breadcrumbs.length > 20) breadcrumbs.shift();
}
let blobs = [], observer = null, queue = [], inflight = 0, controllers = [];
let layoutDims = null, layoutGeometryCache = null, savedScrollPct = -1;
let scrollSaveTimer = 0, scrollListener = null, scrollRestoreFrame = 0, scrollRestoreTimer = 0;
let pendingScrollPct = null, progressWriteChain = Promise.resolve();
let restoringScroll = false, restoringScrollY = null, scrollReady = false, lastScrollSaveAt = 0;
const WEBTOON_TILE_H = 2048, SCROLL_SAVE_INTERVAL_MS = 750, MAX_LAYOUT_CSS_HEIGHT = 16e6;
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(label, fn, cls) {
  const b = node("button", label, cls);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
function clearReader() {
  generation++;
  busy = false;
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = 0;
  if (scrollListener) window.removeEventListener("scroll", scrollListener);
  scrollListener = null;
  if (scrollRestoreFrame) cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = 0;
  if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = 0;
  pendingScrollPct = null;
  restoringScroll = false;
  restoringScrollY = null;
  scrollReady = false;
  if (observer) observer.disconnect();
  observer = null;
  for (const c of controllers) c.abort();
  controllers = [];
  queue = [];
  inflight = 0;
  for (const u of blobs) URL.revokeObjectURL(u);
  blobs = [];
}
function validatedLayout(layout, count) {
  const pages = layout?.pages;
  if (!Array.isArray(pages) || pages.length !== count) return null;
  for (let i = 0; i < pages.length; i++) {
    const d = pages[i];
    if (d?.index !== i || !Number.isSafeInteger(d.width) || !Number.isSafeInteger(d.height) || d.width < 1 || d.height < 1) return null;
  }
  return pages;
}
function layoutGeometry(tiles) {
  if (!layoutDims || !tiles) return null;
  const width = Math.max(1, Math.round(tiles.clientWidth || tiles.getBoundingClientRect().width));
  if (layoutGeometryCache?.width === width) return layoutGeometryCache;
  const pages = [];
  let total = 0;
  for (const d of layoutDims) {
    const height = Math.max(1, Math.round(d.height / d.width * width));
    pages.push({ start: total, height });
    total += height;
    if (!Number.isSafeInteger(total) || total > MAX_LAYOUT_CSS_HEIGHT) return null;
  }
  layoutGeometryCache = { width, total, pages };
  return layoutGeometryCache;
}
function currentBookScrollPct(tiles) {
  const geometry = layoutGeometry(tiles);
  const current = geometry?.pages[page];
  if (!geometry || !current) return null;
  const viewport = Math.max(1, window.innerHeight || 1);
  const pageRange = Math.max(0, current.height - viewport);
  if (pageRange <= 0) return null;
  const tilesTop = tiles.getBoundingClientRect().top + window.scrollY;
  const localTop = Math.min(pageRange, Math.max(0, window.scrollY - tilesTop));
  const bookRange = Math.max(1, geometry.total - viewport);
  const pct = Math.min(1, Math.max(0, (current.start + localTop) / bookRange));
  return Math.round(pct * 1e5) / 1e5;
}
function restoreBookScroll(tiles, pct, token) {
  if (!layoutGeometry(tiles)) return;
  if (scrollRestoreFrame) cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = requestAnimationFrame(() => {
    scrollRestoreFrame = requestAnimationFrame(() => {
      scrollRestoreFrame = 0;
      if (token !== generation || !activeBook) return;
      const geometry = layoutGeometry(tiles);
      const current = geometry?.pages[page];
      if (pct >= 0 && pct <= 1 && geometry && current) {
        const viewport = Math.max(1, window.innerHeight || 1);
        const globalTop = pct * Math.max(1, geometry.total - viewport);
        const localTop = Math.min(Math.max(0, current.height - viewport), Math.max(0, globalTop - current.start));
        const tilesTop = tiles.getBoundingClientRect().top + window.scrollY;
        restoringScroll = true;
        window.scrollTo(0, Math.max(0, tilesTop + localTop));
        restoringScrollY = window.scrollY;
        if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
        scrollRestoreTimer = setTimeout(() => {
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
  if (Number.isFinite(scrollPct) && scrollPct >= 0 && scrollPct <= 1) body.scrollPct = scrollPct;
  const write = progressWriteChain.catch(() => {}).then(async () => {
    if (token !== generation || !activeBook || conflict) return;
    body.baseRev = Number.isInteger(baseRev) ? baseRev : revision;
    const controller = new AbortController();
    controllers.push(controller);
    try {
      const result = await api("/api/books/" + activeBook.id + "/progress", {
        method: "PUT",
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (token !== generation) return;
      page = result.page;
      revision = result.rev;
      savedScrollPct = body.scrollPct ?? -1;
      lastScrollSaveAt = Date.now();
      conflict = null;
      return result;
    } catch (e) {
      if (token !== generation || e.name === "AbortError") return;
      if (e.code === "progress-conflict" && e.details) {
        recordBreadcrumb("progress_conflict");
        conflict = {
          desiredPage: nextPage,
          desiredScrollPct: body.scrollPct,
          currentPage: e.details.currentPage,
          currentRev: e.details.currentRev
        };
        renderTools();
      } else {
        showError(app, e);
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
  const token = generation;
  return queueProgressWrite(page, pct, null, token);
}
function scheduleScrollProgress(tiles) {
  if (restoringScroll) {
    if (restoringScrollY != null && Math.abs(window.scrollY - restoringScrollY) <= 2) return;
    restoringScroll = false;
    restoringScrollY = null;
    if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
    scrollRestoreTimer = 0;
  }
  if (!scrollReady || conflict || busy || !activeBook) return;
  const pct = currentBookScrollPct(tiles);
  if (pct == null) return;
  pendingScrollPct = pct;
  if (scrollSaveTimer) return;
  const wait = Math.max(0, SCROLL_SAVE_INTERVAL_MS - (Date.now() - lastScrollSaveAt));
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = 0;
    void flushScrollProgress();
  }, wait);
}
function showError(container, err, retry) {
  const code = err && err.code;
  const message = code === "pdf-source-unsupported" ? t(23) : code === "source-unsupported" ? t(18) : code === "unauthorized" ? t(22) : code === "image-failed" ? t(24) : code === "webtoon-too-large" ? t(27) : t(16);
  const box = node("div", message, "panel error");
  if (retry) box.append(" ", button(t(17), retry));
  container.append(box);
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options, headers: { ...options.method && options.method !== "GET" ? { "X-Moyu-Request": "1", "Content-Type": "application/json" } : {}, ...options.headers || {} } });
  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {
    }
    const err = new Error("request failed");
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return response.status === 204 ? null : response.json();
}
function header(signedIn = false) {
  actions.replaceChildren();
  const select = node("select");
  select.setAttribute("aria-label", t(25));
  for (const [value, label] of [["zh-CN", "\u7B80\u4F53\u4E2D\u6587"], ["zh-TW", "\u7E41\u9AD4\u4E2D\u6587"], ["en", "English"], ["es", "Espa\xF1ol"], ["ja", "\u65E5\u672C\u8A9E"], ["ko", "\uD55C\uAD6D\uC5B4"]]) {
    const option = node("option", label);
    option.value = value;
    select.append(option);
  }
  select.value = locale;
  select.addEventListener("change", () => {
    locale = select.value;
    document.documentElement.lang = locale;
    if (activeBook) renderReader();
    else if (pairingContext) pair(pairingContext);
    else start();
  });
  actions.append(select);
  if (signedIn) actions.append(button(t(10), async () => {
    try {
      await api("/api/session", { method: "DELETE" });
      recordBreadcrumb("sign_out");
      activeBook = null;
      start(false);
    } catch (e) {
      showError(app, e);
    }
  }));
  document.documentElement.lang = locale;
}
async function pair(pairingId) {
  pairingContext = pairingId;
  clearReader();
  activeBook = null;
  header();
  app.replaceChildren();
  const box = node("section", null, "panel");
  box.append(node("h1", t(1)));
  const input = node("input");
  input.setAttribute("aria-label", t(2));
  input.placeholder = t(2);
  input.maxLength = 64;
  const submit = button(t(3), async () => {
    recordBreadcrumb("pair_request");
    submit.disabled = true;
    input.disabled = true;
    actions.querySelector("select").disabled = true;
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const claimNonce = btoa(String.fromCharCode(...nonce)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    try {
      const claim = await api("/api/pair/claim", { method: "POST", body: JSON.stringify({ pairingId, deviceName: input.value, claimNonce }) });
      box.append(node("p", t(4)));
      while (true) {
        const status = await api("/api/pair/claim/" + encodeURIComponent(claim.claimId));
        if (status.state === "approved") {
          await api("/api/pair/claim/" + encodeURIComponent(claim.claimId) + "/consume", { method: "POST" });
          await library();
          return;
        }
        if (status.state !== "pending") throw new Error("ended");
      }
    } catch {
      box.append(node("p", t(5), "error"));
    }
  }, "primary");
  box.append(input, " ", submit);
  app.append(box);
}
async function requestLocalPair() {
  pairingContext = null;
  clearReader();
  const token = generation;
  activeBook = null;
  header();
  const select = actions.querySelector("select");
  if (select) select.disabled = true;
  const box = node("section", null, "panel");
  box.append(node("h1", t(1)), node("p", t(4)));
  app.replaceChildren(box);
  try {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const claimNonce = btoa(String.fromCharCode(...nonce)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const ua = navigator.userAgent || "";
    const deviceName = /iPhone|iPad/.test(ua) ? "iPhone / iPad" : /Android/.test(ua) ? "Android" : t(28);
    const claim = await api("/api/pair/claim", { method: "POST", body: JSON.stringify({ pairingId: "local", deviceName, claimNonce }) });
    while (token === generation) {
      const status = await api("/api/pair/claim/" + encodeURIComponent(claim.claimId));
      if (status.state === "approved") {
        await api("/api/pair/claim/" + encodeURIComponent(claim.claimId) + "/consume", { method: "POST" });
        if (token === generation) await library();
        return;
      }
      if (status.state !== "pending") throw new Error("ended");
    }
  } catch {
    if (token !== generation) return;
    if (select) select.disabled = false;
    box.replaceChildren(node("p", t(5), "error"), button(t(17), () => requestLocalPair()));
  }
}
async function start(autoPair = true) {
  pairingContext = null;
  clearReader();
  activeBook = null;
  header();
  app.replaceChildren(node("p", t(15)));
  try {
    await api("/api/session");
    await library();
  } catch (error) {
    if (location.protocol === "http:" && error?.code === "unauthorized") {
      if (autoPair) await requestLocalPair();
      else app.replaceChildren(button(t(3), () => requestLocalPair()));
    } else {
      app.replaceChildren(node("section", t(22), "panel"));
    }
  }
}

async function library(query = "", cursor = null, append = false) {
  pairingContext = null;
  if (!append) {
    clearReader();
    activeBook = null;
    header(true);
    app.replaceChildren();
    const section = node("section", null, "panel");
    section.append(node("h1", t(0)));
    const form = node("form", null, "stack");
    const input = node("input");
    input.type = "search";
    input.placeholder = t(6);
    input.setAttribute("aria-label", t(6));
    input.maxLength = 128;
    input.value = query;
    const submit = button(t(7), () => {
    }, "primary");
    submit.type = "submit";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      library(input.value.trim());
    });
    form.append(input, submit);
    section.append(form);
    app.append(section);
    const grid2 = node("div", null, "books");
    grid2.id = "books";
    app.append(grid2);
  }
  const grid = document.getElementById("books");
  const requestGeneration = generation;
  try {
    const params = new URLSearchParams({ limit: "40" });
    if (query) params.set("q", query);
    if (cursor) params.set("cursor", cursor);
    const result = await api("/api/books?" + params);
    if (requestGeneration !== generation) return;
    for (const book of result.items) {
      const card = button("", () => openBook(book), "book");
      const image = node("img");
      image.alt = "";
      image.loading = "lazy";
      if (book.thumbUrl && /^\/api\/books\/[a-f0-9]{64}\/thumb(?:\?[^#]*)?$/.test(book.thumbUrl)) image.src = book.thumbUrl;
      card.append(image, node("span", book.title));
      grid.append(card);
    }
    document.getElementById("more")?.remove();
    if (result.nextCursor) {
      const more = button(t(9), () => library(query, result.nextCursor, true));
      more.id = "more";
      app.append(more);
    }
    if (!grid.children.length) grid.append(node("p", t(8)));
  } catch (e) {
    showError(app, e, () => library(query));
  }
}
async function openBook(book) {
  recordBreadcrumb("open_book");
  clearReader();
  window.scrollTo(0, 0);
  const token = generation;
  activeBook = book;
  app.replaceChildren(node("p", t(15)));
  if (book.format === "pdf") {
    app.replaceChildren(button(t(11), () => library()), node("p", t(23), "panel"));
    return;
  }
  try {
    const progress = await api("/api/books/" + book.id + "/progress");
    if (token !== generation) return;
    if (!Number.isInteger(progress.pageCount) || progress.pageCount < 1) {
      const e = new Error("empty");
      e.code = "source-unsupported";
      throw e;
    }
    if (!Number.isInteger(progress.page) || progress.page < 0) throw new Error("invalid page");
    clampedProgressNotice = progress.page >= progress.pageCount;
    page = Math.min(progress.page, progress.pageCount - 1);
    pageCount = progress.pageCount;
    revision = progress.rev;
    let layout = null;
    try {
      layout = await api("/api/books/" + book.id + "/layout");
    } catch {
      layout = null;
    }
    if (token !== generation) return;
    layoutDims = validatedLayout(layout, pageCount);
    layoutGeometryCache = null;
    savedScrollPct = clampedProgressNotice || !Number.isFinite(progress.scrollPct) ? -1 : progress.scrollPct;
    conflict = null;
    renderReader();
  } catch (e) {
    if (token !== generation) return;
    app.replaceChildren(button(t(11), () => library()));
    showError(app, e);
  }
}
async function changePage(next, base = null, scrollPct = null) {
  if (busy || !activeBook || next < 0 || next >= pageCount) return;
  const token = generation;
  recordBreadcrumb("change_page");
  busy = true;
  renderTools();
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
      renderTools();
    }
  }
  if (!result || token !== generation) return;
  page = result.page;
  clampedProgressNotice = false;
  savedScrollPct = scrollPct == null ? -1 : scrollPct;
  pendingScrollPct = null;
  renderReader();
  window.scrollTo(0, 0);
}
function renderTools() {
  const tools = document.getElementById("tools");
  if (!tools) return;
  tools.replaceChildren();
  tools.append(button(t(11), () => library()));
  const prev = button(t(12), () => changePage(page - 1));
  prev.disabled = busy || page <= 0 || !!conflict;
  const next = button(t(13), () => changePage(page + 1), "primary");
  next.disabled = busy || page >= pageCount - 1 || !!conflict;
  tools.append(prev, node("span", `${t(14)} ${page + 1} / ${pageCount}`), next);
  if (conflict) {
    const box = node("div", t(19), "panel error");
    box.append(button(t(20), async () => {
      const token = generation;
      try {
        const current = await api("/api/books/" + activeBook.id + "/progress");
        if (token !== generation) return;
        page = Math.min(current.page, current.pageCount - 1);
        pageCount = current.pageCount;
        clampedProgressNotice = current.page >= current.pageCount;
        revision = current.rev;
        savedScrollPct = clampedProgressNotice || !Number.isFinite(current.scrollPct) ? -1 : current.scrollPct;
        conflict = null;
        renderReader();
      } catch (e) {
        if (token === generation) showError(app, e);
      }
    }), button(t(21), () => {
      const desired = conflict;
      conflict = null;
      void changePage(desired.desiredPage, desired.currentRev, desired.desiredScrollPct);
    }));
    tools.append(box);
  }
}
function tileAspectRatios(dim, requestedWidth, count) {
  if (!dim || dim.width < 1 || dim.height < 1 || count < 1) return null;
  const bucketWidth = Math.min(2160, Math.max(320, Math.floor((Math.min(2160, Math.max(320, requestedWidth)) + 32) / 64) * 64));
  const outputWidth = Math.min(dim.width, bucketWidth);
  const outputHeight = Math.max(1, Math.round(dim.height * outputWidth / dim.width));
  if (count > outputHeight) return null;
  const ratios = [];
  let previous = 0;
  for (let i = 1; i <= count; i++) {
    const pixelEnd = i === count ? outputHeight : Math.round(i * outputHeight / count);
    ratios.push(`${outputWidth} / ${Math.max(1, pixelEnd - previous)}`);
    previous = pixelEnd;
  }
  return ratios;
}
async function renderReader() {
  if (!activeBook) return;
  clearReader();
  const token = generation;
  header(true);
  app.replaceChildren();
  const title = node("h1", activeBook.title);
  const area = node("div", null, "reader");
  const tiles = node("div", null, "tiles");
  const tools = node("nav", null, "reader-tools");
  tools.id = "tools";
  area.append(title);
  if (clampedProgressNotice) area.append(node("p", t(26), "panel"));
  area.append(tiles, tools);
  app.append(area);
  renderTools();
  const restorePct = savedScrollPct;
  const width = Math.max(320, Math.min(2160, Math.round((window.innerWidth || 1080) * (window.devicePixelRatio || 1))));
  const base = "/api/books/" + activeBook.id + "/pages/" + page + "/tiles/";
  const controller = new AbortController();
  controllers.push(controller);
  try {
    let setImage = function(img2, blob, container, reservedAspectRatio) {
      img2.addEventListener("error", () => {
        if (token !== generation) return;
        img2.remove();
        const error = new Error("image-failed");
        error.code = "image-failed";
        showError(container, error, () => renderReader());
      }, { once: true });
      if (typeof reservedAspectRatio === "string") img2.style.aspectRatio = reservedAspectRatio;
      const u = URL.createObjectURL(blob);
      blobs.push(u);
      img2.src = u;
    }, pump = function() {
      while (token === generation && inflight < 2 && queue.length) {
        const part = queue.shift();
        inflight++;
        const c = new AbortController();
        controllers.push(c);
        fetch(base + part.dataset.tile + "?w=" + width, { credentials: "same-origin", cache: "no-store", signal: c.signal }).then((r) => {
          if (!r.ok) throw new Error("tile");
          return r.blob();
        }).then((blob) => {
          if (token === generation) {
            const image = node("img");
            image.alt = "";
            setImage(image, blob, part);
            part.replaceChildren(image);
            part.classList.remove("tile-pending");
          }
        }).catch((e) => {
          if (token === generation && e.name !== "AbortError") {
            part.classList.remove("tile-pending");
            showError(part, e, () => renderReader());
          }
        }).finally(() => {
          if (token === generation) {
            inflight--;
            pump();
          }
        });
      }
    };
    const first = await fetch(base + "0?w=" + width, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (!first.ok) {
      let data;
      try {
        data = await first.json();
      } catch {
      }
      const e = new Error("tile");
      e.code = data?.error?.code;
      throw e;
    }
    const count = Number(first.headers.get("X-Tile-Count"));
    if (!Number.isInteger(count) || count < 1 || count > 1e4) throw new Error("tile count");
    const dim = layoutDims?.[page];
    const reservedHeights = dim ? tileAspectRatios(dim, width, count) : null;
    let firstPart = null;
    if (reservedHeights?.length === count) {
      const parts = [];
      for (let i = 0; i < count; i++) {
        const part = node("div", null, "tile-pending");
        part.dataset.tile = String(i);
        part.style.width = "100%";
        part.style.height = "auto";
        part.style.aspectRatio = reservedHeights[i];
        parts.push(part);
      }
      tiles.replaceChildren(...parts);
      firstPart = parts[0];
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          queue.push(entry.target);
          pump();
        }
      }, { rootMargin: "800px" });
      for (let i = 1; i < parts.length; i++) observer.observe(parts[i]);
    }
    const firstBlob = await first.blob();
    if (token !== generation) return;
    const img = node("img");
    img.alt = "";
    setImage(img, firstBlob, firstPart || tiles, reservedHeights?.[0]);
    if (firstPart) {
      firstPart.replaceChildren(img);
      firstPart.classList.remove("tile-pending");
      if (layoutGeometry(tiles)) {
        scrollListener = () => scheduleScrollProgress(tiles);
        window.addEventListener("scroll", scrollListener, { passive: true });
        restoreBookScroll(tiles, restorePct, token);
      }
    } else {
      tiles.append(img);
    }
    if (!firstPart) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        queue.push(entry.target);
        pump();
      }
    }, { rootMargin: "800px" });
    for (let i = 1; i < count; i++) {
      const part = node("div", null, "tile-pending");
      part.dataset.tile = String(i);
      tiles.append(part);
      observer.observe(part);
    }
    }
  } catch (e) {
    if (token === generation && e.name !== "AbortError") showError(tiles, e, () => renderReader());
  }
}
const fragment = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
if (/^pair_[0-9a-f]{32}$/.test(fragment)) pair(fragment);
else start();
