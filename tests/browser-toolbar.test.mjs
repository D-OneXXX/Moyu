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
      empty: "No loaded images in viewport",
      imported: "Imported {n} chapter(s)",
      failed: "Import failed",
    },
  };
  return match[1].replace("__CONFIG__", JSON.stringify(config));
}

function makeElement(tag, byId) {
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

function makeImage(url, rect, naturalWidth = 800, naturalHeight = 600) {
  return {
    complete: true,
    naturalWidth,
    naturalHeight,
    currentSrc: url,
    getBoundingClientRect: () => rect,
    getAttribute: (name) => (name === "src" ? url : null),
  };
}

function runToolbar(script) {
  const byId = new Map();
  const documentElement = makeElement("html", byId);
  const images = [
    makeImage("https://cdn.example/loaded.jpg", {
      width: 800,
      height: 600,
      top: 10,
      left: 0,
      right: 800,
      bottom: 610,
    }),
    makeImage(
      "https://cdn.example/logo.png",
      { width: 128, height: 128, top: 0, left: 0, right: 128, bottom: 128 },
      128,
      128,
    ),
    makeImage("https://cdn.example/offscreen.jpg", {
      width: 800,
      height: 600,
      top: 900,
      left: 0,
      right: 800,
      bottom: 1500,
    }),
  ];
  const document = {
    readyState: "complete",
    title: "QA Page",
    documentElement,
    createElement: (tag) => makeElement(tag, byId),
    getElementById: (id) => byId.get(id) ?? null,
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
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ books: [{ id: "b1", title: "QA" }] }),
      };
    },
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
  return { bar, importButton, status, calls, sandbox, history: sandbox.history };
}

test("toolbar collects only loaded viewport images and posts handoff payload", async () => {
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
  ]);
  assert.equal(payload.chapters[0].url, "https://site.example/ch/1");
  assert.equal(payload.origin, "https://site.example");
  assert.equal(payload.userAgent, "MoyuTestUA");
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
