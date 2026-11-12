/**
 * Telegram 文件附件需要登录时，Rust 侧返回稳定码，并在括号内的 JSON 里附带
 * 文件名与体积。这里只解析该结构化片段，不依赖中文正文，避免非中文界面
 * 只能显示泛化错误。
 */
export interface TelegramDocumentGate {
  filename: string;
  size: number | null;
}

const CODE = "telegram-document-login-required";

export function isTelegramDocumentLoginRequired(input: unknown): boolean {
  if (typeof input !== "string") return false;
  return input.includes(`（${CODE}）`) || input.includes(`(${CODE})`);
}

export function parseTelegramDocumentGate(
  input: unknown,
): TelegramDocumentGate | null {
  if (typeof input !== "string" || !isTelegramDocumentLoginRequired(input)) {
    return null;
  }
  const match = input.match(/\{[^{}]*"filename"[^{}]*\}/);
  if (match) {
    try {
      const value: unknown = JSON.parse(match[0]);
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const filename =
          typeof record.filename === "string" && record.filename.trim()
            ? record.filename.trim()
            : "telegram-file";
        const size =
          typeof record.size === "number" && Number.isFinite(record.size)
            ? record.size
            : null;
        return { filename, size };
      }
    } catch {
      /* 回落到通用文件名 */
    }
  }
  return { filename: "telegram-file", size: null };
}

/**
 * 把公开消息链接转换为系统 Telegram 客户端链接。
 * 支持 `https://t.me/{channel}/{post}`、`/s/{channel}/{post}` 与
 * `tg://resolve?domain=...&post=...`。
 */
/**
 * 把单条消息链接统一为可打开的内嵌浏览器地址。
 * `tg://resolve?domain=x&post=1` → `https://t.me/x/1`。
 */
export function telegramMessageWebUrl(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("tg://resolve?")) {
    const params = new URLSearchParams(value.slice("tg://resolve?".length));
    const domain = params.get("domain")?.trim();
    const post = params.get("post")?.trim();
    if (!domain || !post || !/^\d+$/.test(post)) return null;
    return `https://t.me/${encodeURIComponent(domain)}/${post}`;
  }
  try {
    const url = new URL(value);
    if (!["t.me", "telegram.me"].includes(url.hostname.toLowerCase())) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "s") segments.shift();
    if (!segments[0] || !segments[1] || !/^\d+$/.test(segments[1])) {
      return null;
    }
    return `https://t.me/${encodeURIComponent(segments[0])}/${segments[1]}`;
  } catch {
    return null;
  }
}

export function telegramClientUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("tg://resolve?")) {
    const params = new URLSearchParams(value.slice("tg://resolve?".length));
    const domain = params.get("domain")?.trim();
    if (!domain) return null;
    const post = params.get("post")?.trim();
    return post
      ? `tg://resolve?domain=${encodeURIComponent(domain)}&post=${encodeURIComponent(post)}`
      : `tg://resolve?domain=${encodeURIComponent(domain)}`;
  }
  try {
    const url = new URL(value);
    if (!["t.me", "telegram.me"].includes(url.hostname.toLowerCase())) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "s") segments.shift();
    const channel = segments[0];
    const post = segments[1];
    if (!channel || !post || !/^\d+$/.test(post)) return null;
    return `tg://resolve?domain=${encodeURIComponent(channel)}&post=${encodeURIComponent(post)}`;
  } catch {
    return null;
  }
}

export function formatTelegramSize(size: number | null): string {
  if (size == null || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
