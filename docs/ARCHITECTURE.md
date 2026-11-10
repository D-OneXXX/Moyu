# Architecture overview

Moyu is a local-first desktop application built with Tauri 2, Rust, React, TypeScript,
and SQLite. This document is the English overview of how the application behaves and where
your data lives.

## Design goals

- Keep the library, reading progress, rules, and statistics on the local machine.
- Make network access user-initiated: online reading, update checks, and browser navigation.
- Keep destructive actions explicit and recoverable.
- Preserve progress when files move or a source disappears.
- Prefer deterministic, testable Rust code for parsing, caching, persistence, and security
  boundaries.

## Runtime shape

```text
main WebView (React)
  │  Tauri IPC
  ├─ SQLite library.db
  ├─ source/import pipeline
  ├─ render + online cache
  └─ online fetch / filtering

recovery WebView (React)
  └─ resilience + database recovery UI

browser WebView
  └─ user navigation; no IPC capability
```

- The **main** window hosts the library, reader, browser entry, and settings.
- The **recovery** window is an independent window used when the main window or database needs
  recovery. It never silently replaces the main window.
- The **browser** window is isolated from application IPC and accepts only `http` / `https`
  navigation. It must not navigate back to the application’s local origin.
- A W7-TLS transport library can serve a TLS health check using a locally issued leaf
  certificate when explicitly started by code. Application startup, commands, and UI do not
  start it, and it exposes no pairing, session, or library data route in this slice.

## Local data

- Library metadata, progress, statistics, settings, and filter rules live in SQLite under
  Tauri’s `app_data_dir`.
- Database connections use WAL, a busy timeout, foreign keys, and normal synchronous mode.
- Related settings keys commit in one immediate SQLite transaction. Cache/settings memory
  changes happen only after commit; disabling an optional feature persists its gate before
  runtime cleanup.
- Dashboard totals are aggregate SQL: library size, in-progress, finished, and cumulative
  pages read do not materialize `books` rows. Series counts ignore malformed `meta_json`
  rows for grouping while still counting them as single books.
- Missing setting keys use defaults, but SQL read failures and normalization failures propagate.
  Startup and backup recovery publish a database connection only after settings load and repair
  succeed; the settings repair batch commits atomically.
- `DbSlot` guards are held only while reading or writing SQLite. Large metadata parsing,
  sorting, and filesystem checks run after an owned row snapshot leaves the lock, but remain
  inside `spawn_blocking`.
- Synchronous filesystem, SQLite, and image decode work is dispatched through Tokio's
  `spawn_blocking` pool from commands and lifecycle callbacks. Tauri setup waits for required
  startup work; exit caps Web Access stop and WAL checkpoint waits at ten seconds each.
- Browser download destination callbacks only construct a sanitized path with a process-local
  sequence and randomized suffix in memory; the WebView API provides no asynchronous exclusive
  reservation hook. The download directory is prepared before the browser window opens, and
  file validation, import, and permission changes run on the blocking pool. The local handoff
  listener keeps a dedicated thread for its synchronous socket loop and sends chapter parsing
  and database writes to the blocking pool.
- Schema versions move forward only; migrations and startup checks are part of the boot path.
- Rendered pages and online images share a bounded disk cache under `app_cache_dir`. Cache
  cleanup removes derived data only, never `library.db` or reading progress. Only rendered
  output participates in automatic LRU; persistent online originals are shown separately in
  Settings, with a selective cleanup for finished or 30-day-inactive online books.
- Online page dimensions are first probed from a 256 KiB header. A fresh desktop decode writes
  the real full-page width/height back to that page's `meta_json` (meta-only update, progress
  and timestamps untouched); the webtoon view applies the corrected ratio with scroll-anchored
  reflow so the visible center does not jump. Web read-only paths never write metadata.
- Missing source files are marked and can be relocated. Relocation preserves progress,
  webtoon position, and reading statistics.

## Import and reading

- Local sources are image folders, ZIP, and CBZ. Entry names are decoded with a
  display/lookup split so legacy encodings do not reorder or lose pages.
- Local PDF documents are a separate source format (`books.format = "pdf"`). They are never
  decoded through the ZIP/image pipeline: the backend only serves bounded byte ranges of the
  file, and the frontend renders pages with a bundled PDF engine inside the application window.
- PDF rendering is fully local. Embedded document scripts are not executed, the engine cannot
  make the application fetch external resources, and password-protected documents are rejected
  with an explicit message instead of a password prompt.
- Page and chapter ordering is natural, numeric-aware, and stable across mixed extensions,
  nested folders, and leading zeroes.
- The reader offers single-page, double-page, RTL/LTR, and continuous webtoon layouts.
- Very tall webtoon images are sliced into bounded tiles before rendering; the frontend
  stitches them in order. A failed tile has a visible failure state, not an empty gap.
- Full-image fallback decodes (WebP, GIF, interlaced PNG, and oversized non-banded images)
  are capped at two concurrent expansions by a process-wide gate; banded PNG rows and JPEG
  IDCT paths bypass it.
- Telegram archive attachments stream to a sibling `.part` file in 64 KiB chunks with a
  256 MiB hard cap, then fsync, ZIP/RAR magic validation, and an atomic rename. The
  attachment is never buffered whole in memory. Browser downloads are written directly by
  the WebView, and OPDS archives use the existing streaming download path.
- Progress writes update the book row and reading log in one transaction.

## Online reading and the browser

- Online reading starts from a URL the user explicitly provides. There are no bundled manga
  sources or background crawlers.
- Fetches go through the Rust backend so request headers, redirects, SSRF checks, filtering,
  and caching are consistent.
- **Online direct reading is an optional feature** (`experimental_online`). It is toggled with a
  switch that lives on the “online URL direct reading” card in the network settings; the same
  switch also appears in the feature list. Both write the flag through the same command, so
  the setting takes effect immediately and is never stale. When the feature is off, the browser
  page offers an “enable now” action next to the error instead of a dead end.
- The backend gate reads the in-memory feature snapshot, which is updated in the same write
  that persists the flag. A safe-mode session blocks online access with the stable code
  `safe-mode-blocked`.
- **Address selection**: a hostname may resolve to several addresses. Only addresses that pass
  the blocked-range list (loopback, private, link-local, CGNAT, cloud metadata) are kept, and a
  public IPv4 is preferred over IPv6. A host that publishes both a public IPv4 and a private
  IPv6 therefore still connects, instead of being rejected as a whole. The connection uses
  exactly the validated addresses, so a blocked address is never contacted.
- The TLS server name stays the original hostname even when the socket is pinned to a
  validated IP, so certificate verification is unaffected.
- Session request headers are scoped by origin and can be kept in memory only. They are never
  written to SQLite, logs, diagnostics, or backups.
- The embedded browser is for user-driven navigation and download handoff. It has no IPC
  capability and cannot navigate to the application’s local origin.
- Online image filtering uses layered signals (URL/DOM, dimensions, sequence clustering, and
  site profiles). It is not a substitute for the user’s responsibility for the content they
  access.

## Privacy and diagnostics

- No account, cloud sync, or library upload flow exists.
- Diagnostics and prompt generation redact local paths, book names, session headers, and
  token-like query values before display or export.
- Backups contain a sanitized database snapshot and an explicit allowlist of preferences.
  They exclude image caches, online headers, proxies, cookies, filter events, and internal
  version markers.
- The application does not start a Python sidecar or background service.

## Updates

- Update checks are manual. The application does not silently restart, switch reading modes,
  or replace a running binary in memory.
- Windows follows the regular GitHub Releases channel and NSIS installer. Linux follows the
  critical-fix channel (deb/rpm/AppImage). System package installs are not replaced in place.
- Update manifests and artifacts are verified with the configured Tauri updater key. The
  Windows installer is not Authenticode-signed; the updater signature is a separate control.
- The updater plugin stays registered for Rust-side use, but the webview holds no updater
  capability. The check and install steps are app-owned proxy commands
  (`check_native_update` / `install_native_update`); both consult the `updates` feature
  switch before touching the updater, so a console caller cannot bypass the switch. Install
  replays the manifest returned by the check (`restore_update`), rejects a version that no
  longer matches, and still requires the package signature to bind the announced version.

## Security boundaries

- `src-tauri/capabilities/` grants only the permissions used by the main, recovery, and
  browser windows.
- The production CSP restricts scripts, styles, images, and IPC connections; the development
  CSP is relaxed only for the Vite dev server.
- Online URL and redirect handling rejects loopback, private, link-local, and metadata
  addresses in release builds.
- The repository’s static QA suite guards the capability surface, CSP profile, route fallbacks,
  storage sanitization, and other long-lived invariants. The Web Access pairing UI is covered by
  an automated DOM integration suite that drives the real panel while replacing only the
  `web_access_*` control-plane IPC; real phone/TLS pairing remains a separately authorized L3
  check and is never implied by the mocked run.

## Brand, icons, and skins

- The brand display name is a single constant (`src/features/brand/brand.ts`). The native window
  title, the document title, and the six dictionaries all read it, and the
  `static:release-surface` guard (`scripts/release-surface.mjs`, also run by the Vite config)
  fails the build when it drifts.
- The upgrade identity anchors (`productName`, `identifier`, `mainBinaryName`) are guarded by
  the same check: they decide how the installer recognizes an existing installation.
- **Two independent icon surfaces, deliberately not synchronized:**
  - the brand mark inside the main UI (top-left of the shell) is the 0.19.1 artwork, drawn
    inline with fixed colors and offered no replacement entry point;
  - the desktop shortcut, taskbar, and system tray icons always come from the bundled build
    resources (`src-tauri/icons/`), and the tray never reads a user-supplied image.
  Changing one side must never affect the other, and neither side is user-customizable.
- The skin system is a **reserved (dormant) framed-viewport layout**, not an overlay system:
  - `SkinCanvasFrame` paints the full-window canvas (theme background, artwork, outer frame);
  - `ContentViewport` holds the library, browser, and settings, inset by
    `--mr-skin-viewport-inset` (`top right bottom left`), with radius, glass surface, and shadow;
  - the reserved state ships with `--mr-skin-viewport-inset: 0px`, no backdrop image, and no
    frame overlay, so the current build looks exactly like the plain minimal UI;
  - dormant skin definitions are never activated from the persisted preference; a future art
    pack is injected explicitly in code (`addSkin` + `setSkin`) and only then applies;
  - there are no floating sprites above the content: artwork belongs to the canvas and is only
    visible outside the viewport, so it can never cover text or list items;
  - the immersive reader route drops the viewport entirely and renders full-bleed;
  - skin assets are either bundled files under `public/skins/` or `data:` URLs produced by the
    Rust validator, so the production CSP (`img-src 'self' data:`) is never widened.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | React UI, reader, settings, i18n, diagnostics, and resilience |
| `src-tauri/src/` | Rust commands, database, import/render pipeline, online fetch, security, updates |
| `src-tauri/capabilities/` | Tauri permission boundaries per window |
| `tests/qa/` | Static, behavioral, visual, privacy, cache, online, and chaos checks |
| `docs/` | Public architecture overview and build assets |
| `scripts/` | Version, build, and release helpers |

Verification commands are listed under **Development** in the README.
