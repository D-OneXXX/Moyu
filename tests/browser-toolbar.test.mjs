// L2 headless fixture：执行 browser.rs 注入的顶部交接条脚本。
// 只验证 DOM 收集、用户手势门与 handoff POST 载荷；不启动 Tauri GUI。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadToolbarScript() {
  const source = readFileSync(
    resolve("src-tauri/src/browser.rs"),
    "utf8",
  );
  const match = source.match(
    /const TOOLBAR_TEMPLATE: &str = r##"([\s\S]*?)"##;/,
  );
  assert.ok(match, "browser.rs 中应存在 TOOLBAR_TEMPLATE");
  const config = {
    callbackUrl: "http://127.0.0.1:18080/handoff?token=test-token",
    labels: {
      label: "Moyu handoff",
      back: "Back",
      forward: "Forward",
      reload: "Reload",
      importPage: "Import current page",
      importing: "Importing…",
      inactive: "Handoff not started",
      empty: "No loaded images on this page",
      imported: "Imported {n} chapter(s)",
      failed: "Import failed",
    },
  };
  return match[1].replace("__CONFIG__", JSON.stringify(config));
}

function makeElement(tag, byId, submitted) {
  const element = {
    tagName: tag,
    id: "",
    type: "",
    textContent: "",
    style: {},
    attributes: {},
    children: [],
    listeners: {},
    parentNode: null,
    disabled: false,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      register(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      unregister(child);
      return child;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    submit() {
      submitted.push(this);
    },
  };
  const register = (node) => {
    if (node.id) byId.set(node.id, node);
    node.children.forEach(register);
  };
  const unregister = (node) => {
    if (node.id) byId.delete(node.id);
    node.children.forEach(unregister);
  };
  return element;
}

function makeImage(url, naturalWidth = 800, naturalHeight = 600, attrs = {}) {
  return {
    complete: naturalWidth > 0,
    naturalWidth,
    naturalHeight,
    currentSrc: url,
    getAttribute: (name) =>
      Object.hasOwn(attrs, name) ? attrs[name] : name === "src" ? url : null,
  };
}

function runToolbar(script, options = {}) {
  const byId = new Map();
  const submitted = [];
  const documentElement = makeElement("html", byId, submitted);
  const images = options.images ?? [
    makeImage("https://cdn.example/loaded.jpg"),
    makeImage("https://cdn.example/logo.png", 128, 128),
    // 视口外但已加载：整页收集必须纳入。
    makeImage("https://cdn.example/offscreen.jpg"),
    // 具备高清原图属性：未解码也纳入，并按尺寸后缀归一到原图。
    makeImage("https://cdn.example/thumb-724x1024.jpg", 0, 0, {
      "data-orig-file": "https://cdn.example/orig.jpg",
    }),
    // 极小图标：既无高清属性也未达到 280px。
    makeImage("https://cdn.example/icon.png", 32, 32),
  ];
  const document = {
    readyState: "complete",
    title: "QA Page",
    documentElement,
    createElement: (tag) => makeElement(tag, byId, submitted),
    getElementById: (id) => byId.get(id) ?? null,
    getElementsByName: () => [],
    querySelectorAll: (selector) => (selector === "img" ? images : []),
    addEventListener: () => {},
  };
  const calls = [];
  const sandbox = {
    document,
    location: {
      protocol: "https:",
      href: "https://site.example/ch/1",
      origin: "https://site.example",
      reload: () => {},
    },
    history: {
      back: () => {
        sandbox.history.backCalls += 1;
      },
      forward: () => {
        sandbox.history.forwardCalls += 1;
      },
      backCalls: 0,
      forwardCalls: 0,
    },
    navigator: { userAgent: "MoyuTestUA" },
    innerWidth: 1000,
    innerHeight: 800,
    fetch: options.fetch ?? (async (url, request) => {
      calls.push({ url, options: request });
      return {
        ok: true,
        status: 200,
        json: async () => ({ books: [{ id: "b1", title: "QA" }] }),
      };
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (handler) => handler(),
    URL,
    Set,
    Promise,
    console,
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.runInNewContext(script, sandbox, { filename: "moyu-toolbar.js" });
  const bar = byId.get("moyu-handoff-bar");
  assert.ok(bar, "应注入顶部交接条");
  const importButton = bar.children.find(
    (child) => child.getAttribute("data-moyu-import") === "1",
  );
  const status = bar.children.find(
    (child) => child.getAttribute("data-moyu-status") === "1",
  );
  assert.ok(importButton, "应存在导入按钮");
  assert.ok(status, "应存在状态文本");
  return {
    bar,
    importButton,
    status,
    calls,
    sandbox,
    submitted,
    history: sandbox.history,
  };
}

test("toolbar collects the whole loaded document in order and posts handoff payload", async () => {
  const { importButton, status, calls } = runToolbar(loadToolbarScript());
  const click = importButton.listeners.click[0];
  await click({ isTrusted: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:18080/handoff?token=test-token",
  );
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.chapters[0].pages, [
    "https://cdn.example/loaded.jpg",
    "https://cdn.example/offscreen.jpg",
    "https://cdn.example/orig.jpg",
  ]);
  assert.equal(payload.chapters[0].url, "https://site.example/ch/1");
  assert.equal(payload.origin, "https://site.example");
  assert.equal(payload.userAgent, "MoyuTestUA");
  assert.equal(status.textContent, "Imported 1 chapter(s)");
});

test("toolbar falls back to a text/plain form when CSP blocks fetch", async () => {
  const { importButton, status, submitted } = runToolbar(loadToolbarScript(), {
    fetch: async () => {
      throw new TypeError("blocked by connect-src");
    },
  });
  await importButton.listeners.click[0]({ isTrusted: true });
  assert.equal(submitted.length, 1);
  const form = submitted[0];
  assert.equal(
    form.action,
    "http://127.0.0.1:18080/handoff?token=test-token",
  );
  assert.equal(form.method, "POST");
  assert.equal(form.enctype, "text/plain");
  const field = form.children[0];
  const payload = JSON.parse(field.value);
  assert.deepEqual(payload.chapters[0].pages, [
    "https://cdn.example/loaded.jpg",
    "https://cdn.example/offscreen.jpg",
    "https://cdn.example/orig.jpg",
  ]);
  assert.equal(status.textContent, "Imported 1 chapter(s)");
});

test("toolbar ignores synthetic clicks and navigation controls remain user-gated", async () => {
  const { bar, importButton, calls, history } = runToolbar(loadToolbarScript());
  const click = importButton.listeners.click[0];
  await click({ isTrusted: false });
  assert.equal(calls.length, 0);
  const backButton = bar.children.find((child) => child.textContent === "Back");
  assert.ok(backButton);
  await backButton.listeners.click[0]({ isTrusted: true });
  assert.equal(history.backCalls, 1);
});

test("toolbar source never reads cookies or Tauri IPC", () => {
  const script = loadToolbarScript();
  assert.ok(!script.includes("document.cookie"));
  assert.ok(!script.includes("__TAURI"));
});
