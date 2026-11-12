import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTelegramSize,
  isTelegramDocumentLoginRequired,
  parseTelegramDocumentGate,
  telegramClientUrl,
  telegramMessageWebUrl,
} from "../src/features/online/telegramGate.ts";

const sample =
  "检测到 Telegram 频道文件附件（chapter.rar，128.5 MB）。受 Telegram 官方限制，文件附件需登录账号后下载 {\"filename\":\"chapter.rar\",\"size\":134742016}（telegram-document-login-required）";

test("login-required errors carry filename and size without parsing Chinese prose", () => {
  assert.equal(isTelegramDocumentLoginRequired(sample), true);
  const gate = parseTelegramDocumentGate(sample);
  assert.deepEqual(gate, { filename: "chapter.rar", size: 134742016 });
});

test("halfwidth code and missing details degrade to a safe filename", () => {
  assert.deepEqual(
    parseTelegramDocumentGate("download blocked (telegram-document-login-required)"),
    { filename: "telegram-file", size: null },
  );
  assert.equal(parseTelegramDocumentGate("other error"), null);
  assert.equal(parseTelegramDocumentGate(null), null);
});

test("Telegram client links are derived only from public message URLs", () => {
  assert.equal(
    telegramClientUrl("https://t.me/sample_channel/2931?single"),
    "tg://resolve?domain=sample_channel&post=2931",
  );
  assert.equal(
    telegramClientUrl("https://t.me/s/sample_channel/2931"),
    "tg://resolve?domain=sample_channel&post=2931",
  );
  assert.equal(
    telegramClientUrl("tg://resolve?domain=sample_channel&post=42"),
    "tg://resolve?domain=sample_channel&post=42",
  );
  assert.equal(telegramClientUrl("https://example.com/a/1"), null);
  assert.equal(telegramClientUrl("https://t.me/sample_channel"), null);
});

test("tg:// message links normalize to a t.me page for the built-in browser", () => {
  assert.equal(
    telegramMessageWebUrl("tg://resolve?domain=sample_channel&post=2931"),
    "https://t.me/sample_channel/2931",
  );
  assert.equal(
    telegramMessageWebUrl("https://t.me/s/sample_channel/2931?single"),
    "https://t.me/sample_channel/2931",
  );
  assert.equal(telegramMessageWebUrl("tg://resolve?domain=sample_channel"), null);
  assert.equal(telegramMessageWebUrl("https://t.me/sample_channel"), null);
});

test("sizes are formatted for the six-language guide", () => {
  assert.equal(formatTelegramSize(134742016), "129 MB");
  assert.equal(formatTelegramSize(1024), "1.0 KB");
  assert.equal(formatTelegramSize(null), "");
});
