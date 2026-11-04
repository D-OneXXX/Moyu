import { messages } from "/reader-messages.js";
const preferred = navigator.language || "en";
let locale = preferred.startsWith("zh") ? /TW|HK|Hant/i.test(preferred) ? "zh-TW" : "zh-CN" : ["es", "ja", "ko"].find((x) => preferred.startsWith(x)) || "en";
const t = (n) => messages[locale][n];
const app = document.getElementById("app");
const actions = document.getElementById("header-actions");
let pairingContext = null;
let generation = 0, activeBook = null, revision = 0, page = 0, pageCount = 0, busy = false, conflict = null;
const breadcrumbs = [];
function recordBreadcrumb(kind) {
  breadcrumbs.push({ kind, at: (/* @__PURE__ */ new Date()).toISOString() });
  if (breadcrumbs.length > 20) breadcrumbs.shift();
}
let blobs = [], observer = null, queue = [], inflight = 0, controllers = [];
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
  if (observer) observer.disconnect();
  observer = null;
  for (const c of controllers) c.abort();
  controllers = [];
  queue = [];
  inflight = 0;
  for (const u of blobs) URL.revokeObjectURL(u);
  blobs = [];
}
function showError(container, err, retry) {
  const code = err && err.code;
  const message = code === "pdf-source-unsupported" ? t(23) : code === "source-unsupported" ? t(18) : code === "unauthorized" ? t(22) : code === "image-failed" ? t(24) : t(16);
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
      start();
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
async function start() {
  pairingContext = null;
  clearReader();
  activeBook = null;
  header();
  app.replaceChildren(node("p", t(15)));
  try {
    await api("/api/session");
    await library();
  } catch {
    app.replaceChildren(node("section", t(22), "panel"));
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
    page = progress.page;
    pageCount = progress.pageCount;
    revision = progress.rev;
    conflict = null;
    renderReader();
  } catch (e) {
    if (token !== generation) return;
    app.replaceChildren(button(t(11), () => library()));
    showError(app, e);
  }
}
async function changePage(next, base = revision) {
  if (busy || !activeBook || next < 0 || next >= pageCount) return;
  const token = generation;
  recordBreadcrumb("change_page");
  busy = true;
  renderTools();
  try {
    const result = await api("/api/books/" + activeBook.id + "/progress", { method: "PUT", body: JSON.stringify({ page: next, baseRev: base }) });
    if (token !== generation) return;
    page = result.page;
    revision = result.rev;
    conflict = null;
    renderReader();
    window.scrollTo(0, 0);
  } catch (e) {
    if (token !== generation) return;
    if (e.code === "progress-conflict" && e.details) {
      recordBreadcrumb("progress_conflict");
      conflict = { desired: next, ...e.details };
      renderTools();
    } else {
      renderTools();
      showError(app, e);
    }
  } finally {
    if (token === generation) {
      busy = false;
      renderTools();
    }
  }
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
    box.append(button(t(20), () => {
      page = conflict.currentPage;
      revision = conflict.currentRev;
      conflict = null;
      renderReader();
    }), button(t(21), () => changePage(conflict.desired, conflict.currentRev)));
    tools.append(box);
  }
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
  area.append(title, tiles, tools);
  app.append(area);
  renderTools();
  const width = Math.max(320, Math.min(2160, Math.round((window.innerWidth || 1080) * (window.devicePixelRatio || 1))));
  const base = "/api/books/" + activeBook.id + "/pages/" + page + "/tiles/";
  const controller = new AbortController();
  controllers.push(controller);
  try {
    let setImage = function(img2, blob, container) {
      img2.addEventListener("error", () => {
        if (token !== generation) return;
        img2.remove();
        const error = new Error("image-failed");
        error.code = "image-failed";
        showError(container, error, () => renderReader());
      }, { once: true });
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
    const firstBlob = await first.blob();
    if (token !== generation) return;
    const img = node("img");
    img.alt = "";
    setImage(img, firstBlob, tiles);
    tiles.append(img);
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
  } catch (e) {
    if (token === generation && e.name !== "AbortError") showError(tiles, e, () => renderReader());
  }
}
const fragment = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
if (/^pair_[0-9a-f]{32}$/.test(fragment)) pair(fragment);
else start();
