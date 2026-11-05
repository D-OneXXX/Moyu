import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "demo");
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const script = fs.readFileSync(path.join(dir, "demo.js"), "utf8");

test("demo labels exist in all six languages", () => {
  const start = script.indexOf("let language");
  assert.notEqual(start, -1);
  const { keys, translations } = vm.runInNewContext(
    `${script.slice(0, start)}; ({ keys, translations })`,
  );
  const required = [...html.matchAll(/data-i18n(?:-aria|-alt)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(required.length > 0);
  for (const locale of ["zh-CN", "zh-TW", "en", "es", "ja", "ko"]) {
    const values = translations[locale];
    assert.equal(values?.length, keys.length, locale);
    for (const key of required) {
      const index = keys.indexOf(key);
      assert.ok(index >= 0 && typeof values[index] === "string" && values[index].trim(), `${locale}:${key}`);
    }
  }
});

test("demo scripts, styles, images and example archives are locally available", () => {
  for (const [, ref] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
    assert.ok(fs.existsSync(path.join(dir, ref)), ref);
  }
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i);
  for (const name of ["sky-station", "rain-cafe", "orbital-garden"]) {
    assert.ok(fs.statSync(path.join(dir, "assets", `${name}.png`)).size > 0);
    assert.ok(fs.statSync(path.join(dir, "assets", `${name}.cbz`)).size > 0);
  }
});

test("sample archives contain their matching cover and ordered story pages", () => {
  const expected = {
    "sky-station": ["sky-cover", "sky-station"],
    "rain-cafe": ["rain-cover", "rain-cafe"],
    "orbital-garden": ["orbital-cover", "orbital-garden"],
    "europa-echo": ["europa-cover", "europa-01", "europa-02", "europa-03", "europa-04"],
  };
  for (const [book, pages] of Object.entries(expected)) {
    const zip = fs.readFileSync(path.join(dir, "assets", `${book}.cbz`));
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0, `${book}: end of archive`);
    assert.equal(zip.readUInt16LE(end + 10), pages.length, book);
    let position = zip.readUInt32LE(end + 16);
    for (const [index, page] of pages.entries()) {
      assert.equal(zip.readUInt32LE(position), 0x02014b50, `${book}: central directory`);
      assert.equal(zip.readUInt16LE(position + 10), 0, `${book}: stored image`);
      const size = zip.readUInt32LE(position + 24);
      const nameLength = zip.readUInt16LE(position + 28);
      const extraLength = zip.readUInt16LE(position + 30);
      const commentLength = zip.readUInt16LE(position + 32);
      const local = zip.readUInt32LE(position + 42);
      const name = zip.subarray(position + 46, position + 46 + nameLength).toString();
      assert.equal(name, `${String(index).padStart(3, "0")}.png`);
      assert.equal(zip.readUInt32LE(local), 0x04034b50, `${book}: local header`);
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      assert.deepEqual(zip.subarray(data, data + size), fs.readFileSync(path.join(dir, "assets", `${page}.png`)), `${book}:${name}`);
      position += 46 + nameLength + extraLength + commentLength;
    }
  }
});

test("demo reader switches books, bounds page turns, and renders a continuous story", () => {
  class Element {
    constructor(dataset = {}) { this.dataset = dataset; this.listeners = {}; this.attrs = {}; this.children = []; this.hidden = false; this.disabled = false; this.classList = { toggle: () => {} }; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attrs[name] = value; }
    replaceChildren(...children) { this.children = children; }
    click() { if (!this.disabled) this.listeners.click?.({ target: this }); }
  }
  const named = Object.fromEntries(["#current-page", "#page-stack", "#reading-area", "#previous-page", "#next-page", "#page-count", "#current-title"].map((name) => [name, new Element()]));
  const books = ["sky", "rain", "space", "europa"].map((book) => new Element({ book }));
  const modes = ["page", "scroll"].map((mode) => new Element({ mode }));
  const document = {
    documentElement: { dataset: {} },
    querySelector: (selector) => named[selector],
    querySelectorAll: (selector) => selector === "[data-book]" ? books : selector === "[data-mode]" ? modes : [],
    createElement: () => new Element(),
  };
  const window = {}; window.parent = window;
  vm.runInNewContext(script, { document, window, localStorage: { getItem: () => null }, navigator: { language: "en" } });
  books[3].click();
  assert.equal(named["#page-count"].textContent, "1 / 5");
  assert.equal(named["#previous-page"].disabled, true);
  for (let i = 0; i < 5; i++) named["#next-page"].click();
  assert.equal(named["#page-count"].textContent, "5 / 5");
  assert.equal(named["#next-page"].disabled, true);
  assert.equal(named["#current-page"].src, "./assets/europa-04.png");
  named["#previous-page"].click();
  assert.equal(named["#page-count"].textContent, "4 / 5");
  modes[1].click();
  assert.equal(named["#page-stack"].children.length, 5);
  assert.equal(named["#previous-page"].hidden, true);
  assert.deepEqual(named["#page-stack"].children.map((p) => p.src), ["europa-cover", "europa-01", "europa-02", "europa-03", "europa-04"].map((p) => `./assets/${p}.png`));
  books[0].click();
  modes[0].click();
  assert.equal(named["#page-count"].textContent, "1 / 2");
  let prevented = false;
  named["#reading-area"].listeners.keydown({ target: named["#reading-area"], key: "ArrowRight", isComposing: false, keyCode: 39, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(named["#page-count"].textContent, "2 / 2");
});
