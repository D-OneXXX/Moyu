# 01 · 实时热状态（公开源码快照版）

> 最后更新：2026-11-09T00:55:00+08:00
> 分支 / 基线 HEAD：`feat/319-moyu-brand-skin-online`（待推送）/ `9df9e3e`（`origin/main`）
> 状态：**GREEN**
> 证据：本轮 `tsc --noEmit`、`cargo check --all-targets`、`npm run test:rust`（925 passed / 0 failed / 2 ignored）、
> `npm run build`、`npm run format:check`、`npm run test:web`（7 passed）、`npm run test:static`（6 passed）、
> `npm run check:release-surface`、`npm run test:skin`（皮肤预留态零副作用守卫）、`npm run test:online`
> （在线直读全链路守卫）全部通过。
> 边界：真实外网解析（t.me / telegra.ph 等）未在本机执行（需要真实网络与站点可达）；
> 桌面/任务栏/托盘图标不再被任何代码改写，`src-tauri/icons/` 为唯一来源。

## 1. 里程碑（模块级）

- [x] Task 3：品牌展示名收敛为单一常量 `BRAND_DISPLAY_NAME`，六语与原生窗口标题统一为 Moyu
- [x] Task 3：左上角标识固化为 0.19.1 原版内联 SVG（固定配色、无替换入口）
- [x] Task 3：**图标双端解耦**——系统图标恒为随包构建资源，删除全部图标自定义链路
- [x] Task 3：`static:release-surface` 守卫 + 6 条负向测试（守住升级身份锚点与品牌名）
- [x] Task 7：画框换肤转为**预留态**（dormant），默认零视觉变化，容器与 token 底座就位
- [x] Task 7：皮肤预留态零副作用守卫 + `desktop-library-default-[dark|light].png` 基准截图
- [x] Task 5B：在线直读开关回到卡片上，关闭态提供「立即开启」出口
- [x] Task 5B：地址选择由「一刀切拒绝」改为「筛出可直连地址」，公网 IPv4 优先
- [x] Task 5B：安全模式阻断补稳定码 `safe-mode-blocked` + 误判回归单测
- [x] Task 5B：在线直读全链路守卫（开关即时生效 / 出口可用 / 地址栏分流）

## 2. 当前精确断点（Active Breakpoint）

- 当前文件：工作区干净；本轮 8 个提交已 rebase 到 `origin/main`（`9df9e3e`）之上。
- rebase / merge 冲突处理：`tray.rs` 采「图标恒为构建资源」；`resilience.rs` 采上游的
  async 实现与 `web-access-safe-mode` / `safe-mode-unavailable` 稳定码，
  只额外抽出可注入路径的同步内核以便单测；`localize.ts` 采上游错误码表；
  设置页整体采上游 #320 版本（在线开关已由上游恢复，本 PR 只补共享常量与测试钩子）。
- 上游并行落地情况：#291 已登记 `mr-skin` 清洗规则、#320 已恢复在线直读开关并重写
  设置页——本 PR 与之重叠的部分已收敛为最小补丁，重复实现一律删除。
- 最后完成：Task 3 / Task 7 / Task 5B 的实现、验证与文档（ADR-036）。
- **Next Immediate Action**：在真实网络下复核 t.me / telegra.ph 与普通漫画站点的直读可达性
  （本机未做外网访问验证）。
- 阻塞项：无。

## 2.1 开发热更新回路（当前正在运行）

后台托管下 `npm run tauri dev` 不可靠：`tauri dev` 在 stdin EOF 时自行退出，并在退出时
连带清理 `beforeDevCommand` 起的 vite，只留下被 detach 的应用进程（表现为「窗口在、但前端不热更新」）。
当前改成两条独立链路，各自独立存活：

| 链路 | 启动方式 | 职责 |
|---|---|---|
| vite（前端 HMR） | `node node_modules/vite/bin/vite.js --port 1420 --strictPort` | 前端改动秒级热替换，WebView 不重载 |
| tauri CLI（Rust 热重载） | `tail -f /dev/null \| node node_modules/@tauri-apps/cli/tauri.js dev --config '{"build":{"beforeDevCommand":""},"identifier":"com.local.manga-reader.dev"}' --no-dev-server-wait` | 监听 `src-tauri/`，改动后重编译并重启应用 |

要点：
- `tail -f /dev/null |` 给 CLI 喂一条永不 EOF 的 stdin，否则它会自退；
- `--config` 覆盖 `beforeDevCommand` 是为了不和独立 vite 抢 1420（`strictPort` 会直接失败）；
- `--config` 覆盖 `identifier` 为 `com.local.manga-reader.dev`：dev 实例与正式版
  **互斥锁、app_data_dir 全部隔离**（`%APPDATA%\com.local.manga-reader.dev`），
  正式版的 `%APPDATA%\com.local.manga-reader`（含 library.db）不被 dev 触碰，两边可同时运行；
- VERIFIED：CSS 改动 → vite 日志 `hmr update /src/index.css`；Rust 改动 → 应用 PID 变化并自动重启。

## 3. FIXME / TODO（代码桩与未完结标记）

- 换肤预留态：`--mr-skin-*` token 与 `SkinCanvasFrame` / `ContentViewport` 已就位，
  内置 `framed` 皮肤标记为 `dormant`（不会被持久化偏好自动启用）；未来由代码注入美术包启用。
- 自定义整页背景持久化上限 1.8M 字符（localStorage 配额）；超限时仅本次会话生效。
- 未做：把自定义背景交给 Rust 落盘以绕开 localStorage 配额。
- 未验证：真实外网下的在线直读可达性（本机未发起外网请求）。

## 4. 工作区快照（接手者必看）

- 新增：`src/features/online/direct.ts`（在线启用入口与错误识别）、
  `tests/qa/skin-dormancy-guard.mjs`、`tests/qa/online-direct-chain-guard.mjs`、
  `docs/previews/desktop-library-default-{dark,light}.png`。
- 删除：`src-tauri/src/desktop_icon.rs` 与整个应用图标偏好链路
  （`features/brand/{brandIcon,BrandIconProvider,appIcon,trayIcon}.ts`）、
  `src/components/shell/ThemeDecorationLayer.tsx`（漂浮挂件层）与 `.mr-decoration-*`。
- 改动：`src-tauri/tauri.conf.json` **未改**（productName / identifier / mainBinaryName / bundle.icon
  全部保持）；`Cargo.toml` 已回退到原有 feature 集合，Cargo.lock 无新增第三方包。
- 禁止用 `git stash` / `git checkout --` / 强制推送清理工作区。

## 5. 本轮验证（L0–L2）

- VERIFIED：`npx tsc --noEmit` → 通过
- VERIFIED：`cargo check --all-targets --offline` → 通过
- VERIFIED：`npm run test:rust` → 925 passed / 0 failed / 2 ignored
- VERIFIED：`npm run build` → 通过（chunk >500 kB 警告为既有问题）
- VERIFIED：`npm run format:check` → 通过
- VERIFIED：`npm run test:web` → 7 passed
- VERIFIED：`npm run test:static` → 6 passed（release-surface 负向测试）
- VERIFIED：`npm run check:release-surface` → 通过
- VERIFIED：`npm run test:skin` → 通过（皮肤预留态：inset 0px、无背景无外框、无遮挡、
  故意写入 `mr-skin=framed` 也不激活、阅读路由全屏）
- VERIFIED：`npm run test:online` → 通过（开关即时生效 / 关闭态有「立即开启」出口 /
  地址栏按 URL 类型分流到 resolve_online_url 与 resolve_telegram_channel / 解析后跳进阅读器）
- UNKNOWN：真实外网直读可达性；真实桌面/任务栏/托盘图标（已无任何代码改写它们）
- 未创建常驻进程/端口；未进行桌面交互；未移动光标或抢焦点。

## 6. 当前目标与范围

- 本轮目标：Task 3（品牌文案与图标双端解耦）、Task 7（画框换肤预留态）、
  Task 5B（在线直读开关断链与 v0.19.x 网络回归）。
- 范围：未改升级身份锚点；未引入新第三方依赖；未新增外部网络请求；生产 CSP 未变。
