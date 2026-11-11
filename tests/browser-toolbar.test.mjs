// L2 headless fixture：执行 browser.rs 注入的顶部交接条脚本。
// 只验证整页 DOM 收集、URL 优先级、用户手势门与 handoff 载荷；不启动 Tauri GUI。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadToolbarScript() {
  const source = readFileSync(resolve("src-tauri/src/browser.rs"), "utf8");
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
      empty: "No content images found",
      imported: "Imported {n} chapter(s)",
      submitted: "Submitted for import",
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
    name: "",
    value: "",
    method: "",
    action: "",
    target: "",
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

function makeImage(
  url,
  {
    attrs = {},
    currentSrc = url,
    naturalWidth = 800,
    naturalHeight = 600,
    chrome = false,
    noise = false,
    anchor = null,
  } = {},
) {
  return {
    complete: true,
    naturalWidth,
    naturalHeight,
    currentSrc,
    getAttribute(name) {
      if (Object.hasOwn(attrs, name)) return attrs[name];
      return name === "src" ? url : null;
    },
    closest(selector) {
      if (selector.includes("a[href]")) return anchor;
      if (chrome && selector.includes("header")) return { tagName: "HEADER" };
      if (noise && selector.includes("jp-relatedposts")) {
        return { tagName: "DIV" };
      }
      return null;
    },
  };
}

function wpImages() {
  const anchor = (href) => ({
    getAttribute: (name) => (name === "href" ? href : null),
  });
  return [
    makeImage("https://wp.example/uploads/cover.jpg", {
      attrs: { width: "400", height: "600" },
      naturalWidth: 400,
      naturalHeight: 600,
    }),
    makeImage("https://wp.example/uploads/pages/001-724x1024.jpg", {
      attrs: {
        "data-orig-file": "https://wp.example/uploads/pages/001-original.jpg",
        srcset:
          "https://wp.example/uploads/pages/001-724x1024.jpg 724w, https://wp.example/uploads/pages/001-original.jpg 1024w",
        width: "724",
        height: "1024",
      },
      naturalWidth: 724,
      naturalHeight: 1024,
    }),
    makeImage("https://wp.example/uploads/pages/002-thumb-300x200.jpg", {
      anchor: anchor("https://wp.example/pages/002-full.jpg"),
      attrs: { width: "300", height: "200" },
      naturalWidth: 300,
      naturalHeight: 200,
    }),
    makeImage("https://wp.example/uploads/pages/003.jpg", {
      attrs: { width: "800", height: "1200" },
    }),
    // 同一页的缩略图后出现：身份去重必须保留前面的原图。
    makeImage("https://wp.example/uploads/pages/003-724x1024.jpg", {
      attrs: { width: "724", height: "1024" },
      naturalWidth: 724,
      naturalHeight: 1024,
    }),
    makeImage("https://wp.example/uploads/logo.png", {
      chrome: true,
      naturalWidth: 128,
      naturalHeight: 128,
      attrs: { width: "128", height: "128" },
    }),
    makeImage("https://wp.example/uploads/related-01.jpg", {
      noise: true,
      attrs: { width: "800", height: "1200" },
    }),
    makeImage("https://wp.example/uploads/icon.png", {
      naturalWidth: 32,
      naturalHeight: 32,
      attrs: { width: "32", height: "32" },
    }),
  ];
}

function runToolbar(script, { images = [], fetchImpl } = {}) {
  const byId = new Map();
  const documentElement = makeElement("html", byId);
  const forms = [];
  const document = {
    readyState: "complete",
    title: "QA WP Gallery",
    documentElement,
    body: documentElement,
    createElement: (tag) => {
      const element = makeElement(tag, byId);
      if (tag === "form") {
        forms.push(element);
        element.submit = () => {
          element.submitted = true;
        };
      }
      return element;
    },
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: (selector) => (selector === "img" ? images : []),
    addEventListener: () => {},
  };
  const calls = [];
  const sandbox = {
    document,
    location: {
      protocol: "https:",
      href: "https://wp.example/series-chapter-03/",
      origin: "https://wp.example",
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
    fetch:
      fetchImpl ??
      (async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({ books: [{ id: "b1", title: "QA" }] }),
        };
      }),
    URL,
    Set,
    Promise,
    console,
    setTimeout: () => {},
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
    forms,
    sandbox,
    history: sandbox.history,
  };
}

const EXPECTED_PAGES = [
  "https://wp.example/uploads/cover.jpg",
  "https://wp.example/uploads/pages/001-original.jpg",
  "https://wp.example/pages/002-full.jpg",
  "https://wp.example/uploads/pages/003.jpg",
];

test("toolbar collects full-document content images in DOM order", async () => {
  const { importButton, status, calls } = runToolbar(loadToolbarScript(), {
    images: wpImages(),
  });
  const click = importButton.listeners.click[0];
  await click({ isTrusted: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:18080/handoff?token=test-token",
  );
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.chapters[0].pages, EXPECTED_PAGES);
  assert.equal(payload.chapters[0].url, "https://wp.example/series-chapter-03/");
  assert.equal(payload.origin, "https://wp.example");
  assert.equal(payload.userAgent, "MoyuTestUA");
  assert.equal(status.textContent, "Imported 1 chapter(s)");
});

test("toolbar falls back to hidden form POST when fetch is CSP-blocked", async () => {
  const { importButton, status, calls, forms } = runToolbar(
    loadToolbarScript(),
    {
      images: wpImages(),
      fetchImpl: () => {
        throw new TypeError("blocked by CSP connect-src");
      },
    },
  );
  const click = importButton.listeners.click[0];
  await click({ isTrusted: true });
  assert.equal(calls.length, 0);
  assert.equal(forms.length, 1);
  const form = forms[0];
  assert.equal(String(form.method).toUpperCase(), "POST");
  assert.equal(form.action, "http://127.0.0.1:18080/handoff?token=test-token");
  const payloadInput = form.children.find((child) => child.name === "payload");
  assert.ok(payloadInput, "回退表单必须带 payload 隐藏字段");
  const payload = JSON.parse(payloadInput.value);
  assert.deepEqual(payload.chapters[0].pages, EXPECTED_PAGES);
  assert.equal(form.submitted, true);
  assert.equal(status.textContent, "Submitted for import");
});

test("toolbar ignores synthetic clicks and navigation controls remain user-gated", async () => {
  const { bar, importButton, calls, history } = runToolbar(loadToolbarScript(), {
    images: wpImages(),
  });
  const click = importButton.listeners.click[0];
  await click({ isTrusted: false });
  assert.equal(calls.length, 0);
  const backButton = bar.children.find((child) => child.textContent === "Back");
  assert.ok(backButton);
  await backButton.listeners.click[0]({ isTrusted: true });
  assert.equal(history.backCalls, 1);
});

test("toolbar source never reads cookies or Tauri IPC and never uses viewport gating", () => {
  const script = loadToolbarScript();
  assert.ok(!script.includes("document.cookie"));
  assert.ok(!script.includes("__TAURI"));
  assert.ok(!script.includes("getBoundingClientRect"));
  assert.ok(!script.includes("innerHeight"));
  assert.ok(script.includes("querySelectorAll('img')"));
  assert.ok(script.includes("data-orig-file"));
  assert.ok(script.includes("payload"));
});
