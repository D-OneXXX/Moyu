# 00 · 架构宪章与红线（STATIC / READ-ONLY · 公开源码快照版）

> 适用仓库：`D-OneXXX/Moyu` 公开源码快照（`origin/main`）
> 生效日期：2026-11-07
> 本文件面向公开源码快照，只固化产品行为、源码约束与接力规则。
> 完整工程红线、QA 套件、发布审批与内部脚本位于维护者的完整开发仓，不随公开仓提供；公开仓文档不得依赖这些缺失文件。
>
> **权威顺序**：项目所有者当前明确指令 > 本文件 > `README.md` / `README.en.md` > `docs/ARCHITECTURE.md` > `02_DECISIONS_AND_PITFALLS.md` > `01_STATE.md`。
>
> **修改规则**：仅项目所有者可批准修改本文件。任何修改必须先在 `02_DECISIONS_AND_PITFALLS.md` 追加 ADR，再改本文件并更新生效日期。Agent 在日常开发中不得改写本文件。

---

## 1. 产品与工程目标

- 产品：Moyu，本地优先、零遥测、零静默副作用的 Windows/Linux 桌面漫画阅读器。
- 技术形态：Tauri 2 桌面壳 + React 前端 + Rust 核心 + 本地 SQLite。
- 数据主权：书库、进度、统计、设置默认只存本机；任何上传、遥测、后台刷新都必须有用户显式动作。
- 交付目标：可安装、可升级、可恢复、可诊断；不牺牲用户数据与隐私换取便利。
- 当前版本：以 `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 为事实源；§2 的版本是初始化基线，用于识别漂移，不是锁定值。

---

## 2. 技术栈与依赖限制

| 层 | 技术基线 | 事实源 |
|---|---|---|
| 桌面壳 | Tauri 2.x（CLI 2.x、插件 2.x；Updater 2.14.1） | `src-tauri/Cargo.toml`、`tauri.conf.json` |
| 前端 | React 19.3 + React DOM 19.3 + React Router 7.18 | `package.json` |
| 语言 | TypeScript `~5.8.3`，`strict`、`noUnusedLocals`、`noUnusedParameters` | `tsconfig.json` |
| 构建 | Vite 6.4 + `@vitejs/plugin-react` 4.3 | `package.json`、`vite.config.ts` |
| 样式 | Tailwind CSS 4.3 + `@tailwindcss/vite` 4.3；token 以 `src/index.css` 的 `--sh-*` 为准 | `src/index.css` |
| UI 基元 | shadcn / Base UI / lucide / CVA | `src/components/ui/` |
| 后端 | Rust edition 2021，MSRV 1.90，stable 工具链 | `src-tauri/Cargo.toml` |
| 数据库 | SQLite，`rusqlite` 0.41（bundled），WAL | `src-tauri/src/db.rs` |
| PDF | `pdfjs-dist` 6.5，仅前端本地渲染 | `package.json`、`src/features/pdf/` |
| 网络 | Rust 侧 `reqwest` 0.12（rustls）/ `ureq` 2；不得引入 OpenSSL 运行时依赖 | `src-tauri/Cargo.toml` |
| 运行时 | Node.js 22+ | `README.md` / `README.en.md` |
| 打包 | Windows NSIS；Linux deb / rpm / appimage；不得加入 MSI | `tauri.conf.json` |

**依赖准入（硬规则）**

1. 严禁私自引入未批准的运行时库、原生库、二进制 sidecar、外部服务或遥测 SDK。
2. 新增或升级依赖必须同时满足：所有者批准、`02` 记录 ADR、许可证兼容并更新 `THIRD_PARTY_NOTICES.md`、公开仓 CI 通过、说明体积/内存/冷启动影响。
3. 前端依赖必须进 `package-lock.json`；Rust 依赖必须进 `Cargo.lock`。禁止 git 依赖、本地路径依赖，或未同步 lockfile 的升级。
4. 禁止为“方便”引入第二套状态管理、第二套 UI 库或第二套数据库访问层；HTTP 客户端只允许现有 `reqwest` / `ureq` 的分工，新增第三套必须单独批准。
5. 禁止 Python/Node sidecar、8500 端口常驻进程、原生 PDF 库（PDFium 等）、文档内嵌脚本执行。

---

## 3. 架构与目录契约

```text
src/
  components/        可复用展示组件；ui/ 为 shadcn 基类，不承载业务状态
  features/          按能力域组织（reader/import/online/pdf/update/...）
  pages/             路由页面
  lib/               纯工具、IPC 封装、跨域基础设施
  i18n/messages/     六语字典（zh-CN / zh-TW / en / es / ja / ko）
  types/             跨模块共享类型
src-tauri/src/       Rust 能力域；lib.rs 统一注册命令；db.rs 为唯一连接入口
docs/                公开架构说明与第三方许可
.agent_relay/        接力控制面，只存状态与决策，不承载业务实现
```

- **分层方向**：`pages` → `features` → `components/lib/types`；跨 feature 复用必须先下沉，禁止直接穿透其它 feature 的内部文件。
- **Rust 边界**：命令在 `lib.rs` 注册；新增/修改命令必须同步公开架构说明与前端类型。
- **前端到后端**：桌面模式统一经 `src/lib/tauri.ts` 的冻结 invoke 契约调用，禁止散落拼接命令名；错误必须保留稳定错误码。Web 演示入口不得获得本地能力。
- **后端到前端**：事件只用于必要通知；不得用事件实现静默后台刷新或强制模式切换。
- **数据库**：所有生产连接必须经 `db::open` / `db::configure`，禁止直接 `Connection::open`。
- **路径锚点**：数据/缓存必须来自 `app.path().app_data_dir()` / `app_cache_dir()`；测试隔离变量只用于隔离环境。
- **网络与凭据**：在线抓取、Cookie 边界、请求头绑定、SSRF 校验只在 Rust 侧完成；前端不得持久化会话凭据，在线请求头不得进入前端日志或遥测。

---

## 4. 代码风格与命名

- TypeScript：函数组件 + hooks；避免 class 组件；禁止无理由 `any`；共享类型放 `src/types/`；路径别名使用 `@/*`。
- Rust：`cargo fmt` 必须通过；生产路径避免 `unwrap` / `expect` 造成 panic；错误用 `thiserror` 表达并保留稳定码。
- 命名：组件 `PascalCase`；hooks `useXxx`；函数/变量 `camelCase`；Rust 标识符 `snake_case`；错误码 `kebab-case`；CSS token `--sh-*`；i18n key 按功能域分组。
- 文案：组件、Toast、错误提示、设置项一律走 `t()`；六个语言块必须同时新增；后端错误必须经 `localizeBackendError`。
- 日志：路径、漫画名、URL、Cookie、Token、请求头值在展示/导出/落盘前必须脱敏；禁止记录完整签名 URL query。
- 注释：只解释“为什么”和约束，不复述代码；禁止在注释与文档中使用第三方设计模板名称作为风格代号。

---

## 5. 性能、体积与内存红线

- WebView2 单纹理高度上限按 16384px 估算；单页渲染输出上限 `MAX_SAFE_TEXTURE_H = 8192`。
- 条漫切片：单片源高度上限 `MAX_SLICE_H = 4096`；前端可见切片 `WEBTOON_TILE_H = 2048`；必须“先切后缩”，禁止同时持有原图、缩放图、切片三份大缓冲。
- PDF：画布单边 ≤4096px、面积 ≤16Mpx；最多同时持有 4 份文档；关闭阅读器必须取消在途渲染并终止 worker。
- 缓存：`render_cache/` 与 `online_cache/` 共用 `diskCacheBudgetMb`（500MB–10GB，默认 2048MB），LRU 淘汰；写失败必须进入 `cache_health`。
- 前端：禁止新增未评估的重型依赖；新增依赖必须报告 gzip 体积与冷启动影响；派生状态优先 memo，不得以“先渲染再修”掩盖布局抖动。
- 启动：React 挂载前必须执行 `sanitizeStorage`；数据库 `init_schema` 后必须 `PRAGMA quick_check`；启动路径不得阻塞在网络请求上。

---

## 6. 安全、隐私与数据不变量

- **用户主权**：禁止未经确认的静默重启、强制阅读模式切换、后台刷新、自动模式切换、遥测上传、自动重建主窗口。
- **会话凭据**：`session_online_headers` 只驻留内存，绝不写 SQLite、绝不写日志；全局 `settings.online_headers` 可持久化，但同样禁止进入日志、诊断导出与错误文案。
- **Cookie 边界**：不自动抓取、不持久化第三方 Cookie；辅助浏览器窗不读 Cookie；主窗口不注入脚本。
- **SSRF**：在线 URL 与每一跳重定向必须拒绝本机/私网/link-local/云元数据地址；域名必须解析后校验；回环只允许 debug/隔离测试显式放行，release 不得放行。
- **日志脱敏**：`diagnostics.rs` / `security.rs` 是脱敏权威；日志禁止出现 Cookie、Token、请求头值、完整签名 URL query。
- **路径身份**：本地书 id = `sha256(首次入库 path)`；导入/重定位先查 `find_book_id_by_path`；Windows 归一分隔符与大小写，Unix 不把反斜杠当分隔符。
- **自然序**：文件名/目录用 `natural_cmp_path`，卷/话标题用 `natural_cmp`；禁止退回普通字典序。
- **SQLite**：WAL、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`；schema 单向递增；退出前 `wal_checkpoint(TRUNCATE)`。
- **进度原子性**：`set_progress` 的 `books` 更新与 `reading_log` 累加同一事务；`reading_log.book_id` 为可空外键 + `ON DELETE CASCADE`；唯一性由 `(date, COALESCE(book_id,''))` 表达式索引保证。
- **备份/删除**：`.mrbackup` 只含白名单数据；恢复前校验完整性；删除源文件只允许压缩包或宽目录下的实际书目录，系统/用户关键目录与应用数据目录一律拒绝。
- **窗口与权限**：`main` / `recovery` / `browser` 三窗必须在 `capabilities/default.json` 覆盖；禁止全量 `fs:*`、`shell:*`、`process:*`；CSP 不得为 null/空，生产 CSP 不得加入通配符、外部 origin、`blob:` 或 `wasm-unsafe-eval`。
- **内嵌浏览器**：只允许 http/https，禁止跳回 `tauri.localhost` 与开发态 `localhost:1420`。

---

## 7. UI 与国际化不变量

- 视觉体系：晴空蓝胶囊新粗野主义（Ice-blue Capsule Neo-Brutalism）。代码/文档只描述可度量规则，不写第三方模板名称。
- 胶囊层必须 `rounded-full`：导航轨、顶栏控件、状态胶囊、命令中心、读者 HUD、Badge、Tab 触发器、胶囊输入框。
- 卡片/面板统一 `rounded-2xl`；`src/components/ui/` 基类保留自身 radius，只有 `pill` 变体是胶囊。
- 主题 token 以 `--sh-*` 唯一权威；历史兼容别名仅维护，新代码不得新增依赖；禁止恢复已删除的旧全局样式类名。
- 双主题（Light/Dark）与跟随系统必须同时成立；主表面用硬偏移阴影，浮层可用普通阴影。
- 六语必须齐全（zh-CN、zh-TW、en、es、ja、ko）；胶囊容器必须有 `whitespace-nowrap` 或弹性宽度保护。
- 真实路由只有 `/`、`/reader/:id`、`/browser`、`/settings`；`/library` 仅兼容重定向；两套路由表都必须有 `*` → `/` 兜底。

---

## 8. 发布与更新红线

- 产品发布只通过维护者完整工程环境的 candidate → Draft → 人工审批 → publish；公开仓不包含发布工作流，禁止推送 `v*` Tag 触发发布。
- 更新通道事实源唯一：`tauri.conf.json` 的 `plugins.updater`；设置页与安全自检必须读同一份配置。
- `productName`（MangaReader）、`identifier`（com.local.manga-reader）、主程序名是升级身份锚点，禁止漂移。
- 禁止直接内存覆写正在运行的二进制；补丁/全量包必须先落系统临时目录或专属 staging，完成 SHA-256 + minisign 校验后由标准安装器事务替换。
- Release Notes 必须英文完整版在前、简体中文完整版在后；结构模板见 `.github/RELEASE_NOTES_TEMPLATE.md`；公开说明禁止写入 QA 计数、CI run id、PR/Issue 编号、commit/SHA 清单、CSP 细节、审批记录。
- L3（可见 GUI/桌面/系统级）操作必须事先获得所有者单独授权，并记录进程/端口、清理结果与证据状态。

---

## 9. Agent 行为准则

1. **原子任务闭环**：每完成一个可验证的原子步骤，立即更新 `01_STATE.md`，并在对应 Issue 分支上提交；禁止积攒大爆炸提交。
2. **设计变更前置**：任何架构、契约、依赖、发布流程变更，先在 `02_DECISIONS_AND_PITFALLS.md` 追加 ADR，再改代码。
3. **单写者**：同一文件同一时间只有一个写者；子代理按文件所有权切分，主代理负责集成与验收。
4. **状态真实**：未运行的检查不得记为 PASS；使用 VERIFIED / SIMULATED / INFERRED / UNKNOWN / BLOCKED 标注证据。
5. **最小侵入**：L0 只读分析；L1 后台 CLI；L2 隔离数据/端口/profile；L3 可见 GUI/桌面/系统级必须单独授权。不得抢焦点、改分辨率、模拟桌面输入或终止无关进程。
6. **禁止清场式 Git**：禁止 `git stash`、`git checkout --`、强制推送、删除他人分支来清理工作区；冲突必须显式记录。
7. **禁止编辑生成物**：`dist/`、`target/`、缓存目录不得提交；公开仓不包含内部生成状态文件，不得引用或手工创建。
8. **提交格式**：Subject 遵循 Conventional Commits 中文说明；正文追加 `[RELAY] <模块>: <动作> | NEXT: <下一步>`，便于 `git log --grep` 还原接力链。
9. **交接纪律**：`01_STATE.md` 控制在 100 行以内，只保留当前有效断点；历史与失败路径只进 `02`，不得把过期噪音留在热状态。
10. **完成定义（DoD）**：代码 + 测试 + 文档 +（涉及 UI 时）六语 + `npm run check` / `npm run test:rust` / `npm run build` 相关验证 + 状态更新 + 分支内提交；缺一项不得宣称完成。

---

## 10. 权威指针（仅公开仓可见文件）

| 内容 | 位置 |
|---|---|
| 产品说明与构建入口 | `README.md` / `README.en.md` |
| 公开架构概览 | `docs/ARCHITECTURE.md` |
| PR 与 Release Notes 模板 | `.github/PULL_REQUEST_TEMPLATE.md` / `.github/RELEASE_NOTES_TEMPLATE.md` |
| 许可证与第三方声明 | `LICENSE` / `NOTICE.md` / `THIRD_PARTY_NOTICES.md` |
| 版本与脚本 | `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` |
| IPC 契约 / 主题 token / 六语字典 | `src/lib/tauri.ts` / `src/index.css` / `src/i18n/messages/` |
| 实时断点 | `.agent_relay/01_STATE.md` |
| 决策与错题本 | `.agent_relay/02_DECISIONS_AND_PITFALLS.md` |
| 接力操作手册 | `.agent_relay/03_HANDOVER_SOP.md` |
| 冷启动唤醒词 | `.agent_relay/04_WAKEUP.md` |
