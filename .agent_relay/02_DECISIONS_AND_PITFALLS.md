# 02 · 决策日志与错题本（APPEND-ONLY · 公开源码快照版）

> 状态：只追加，不删除、不改写历史结论。
> 适用范围：`D-OneXXX/Moyu` 公开源码快照（`origin/main`）。
> 条目 ID 只增不复用；被推翻的决策标记 `SUPERSEDED` 并指向新 ADR；失败路径保留，供继任者避坑。
> 公开仓不包含 `AGENTS.md`、内部 QA 套件、发布工作流与内部工程脚本；本文件不得依赖这些缺失文件。
>
> **记录时机**：架构/契约/依赖/发布流程变更前；确认一条死胡同时；跨模块接口或核心字段变更时；交接前。
>
> **条目模板**
>
> ```markdown
> ## ADR-XXX · 标题
> - 日期：YYYY-MM-DD
> - 状态：ACCEPTED / SUPERSEDED
> - 背景：
> - 决策：
> - 放弃方案：
> - 后果/约束：
> ```

---

## A. 核心设计决策（ADR）

### ADR-001 · 本地优先、零遥测、零静默副作用
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：阅读器处理用户本地书库、阅读进度与在线站点凭据，隐私风险高。
- 决策：书库/进度/统计/设置默认只存本机；上传、遥测、后台刷新、模式切换必须由用户显式触发。
- 放弃方案：云端同步、匿名统计、后台自动更新内容、看门狗自动重建主窗。
- 后果：任何“智能恢复/自动优化”都必须降级为独立窗口或用户确认。

### ADR-002 · Tauri 命令边界 + Rust 核心
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：需要同时保证 WebView 安全边界与本地能力。
- 决策：桌面模式前端只经 `src/lib/tauri.ts` 的冻结契约调用 Rust 命令；命令在 `lib.rs` 注册；数据库、文件、网络、凭据逻辑留在 Rust。Web 演示入口不得获得本地能力。
- 放弃方案：前端直接持有文件系统/网络/数据库能力；Node sidecar；本地 HTTP 服务。
- 后果：新增命令必须同步注册、公开架构说明与前端类型，不允许“前端临时拼接命令”。

### ADR-003 · SQLite 单一入口、WAL 与原子进度
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：高速滚动进度与规则落盘会并发写库。
- 决策：所有生产连接经 `db::open` / `db::configure`，开启 WAL、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`；`set_progress` 与 `reading_log` 同事务；退出前 `wal_checkpoint(TRUNCATE)`。
- 放弃方案：各处 `Connection::open`；`DELETE` 日志模式；进度与统计分事务写。
- 后果：绕过入口视为缺陷；schema 变更必须单向递增并更新公开架构说明。

### ADR-004 · 会话请求头只驻留内存
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：在线源需要用户自备请求头，但凭据泄露风险最高。
- 决策：`session_online_headers` 只驻留内存，绝不写 SQLite、日志、诊断导出或错误文案；全局 `settings.online_headers` 可持久化，但同样禁止出现在日志与导出中。
- 放弃方案：把会话头写入设置表；把请求头打进错误上下文；跨 origin 复用。
- 后果：任何与内存驻留冲突的需求以本条为准；请求头严格按 origin 绑定。

### ADR-005 · PDF 本地 PDF.js，禁止原生依赖
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：PDF 是独立书源格式，WebView2 与原生 PDF 库都会引入额外攻击面。
- 决策：后端只提供受控字节区间 `get_pdf_chunk`（单次 ≤4 MiB、文件 ≤512 MiB）；前端用 `pdfjs-dist` 本机渲染；不引入 PDFium/Rust PDF 解析库；不传 `wasmUrl` / `iccUrl`；不执行内嵌脚本；加密 PDF 按 `pdf-encrypted` 提示。
- 放弃方案：PDF 进 ZIP/图片取页管线；PDFium；quickjs-eval 沙箱；跨源 CMap。
- 后果：CSP 只允许 `font-src 'self' data:` 与同源 `connect-src 'self'`；资源受 4096px / 16Mpx / 4 文档限制。

### ADR-006 · 路径身份与自然序
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：书库会经历导入、移动、重定位，路径与排序必须稳定。
- 决策：本地书 id = `sha256(首次入库 path)`；导入/重定位先 `find_book_id_by_path`；Windows 归一分隔符/大小写，Unix 不把反斜杠当分隔符；文件名用 `natural_cmp_path`，卷/话标题用 `natural_cmp`。
- 放弃方案：用自增 id 作身份；重定位时新建记录；普通字典序。
- 后果：移动文件不得删除记录或重置 `current_page` / `scroll_pct` / 阅读统计。

### ADR-007 · 发布只走 Draft + 人工审批
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：Tag 直发与自动发布绕过了签名、QA 与人工审批。
- 决策：产品发布只通过维护者完整工程环境的 candidate → Draft → 人工审批 → publish；公开仓不包含发布工作流；禁止推送 `v*` Tag 触发发布；Release Notes 英文完整版在前、简体中文完整版在后。
- 放弃方案：Tag 直发；在公开说明里写 QA 计数/CI run id/PR 编号/commit 清单；发布后改写说明。
- 后果：每次发布需所有者单独授权；公开仓只保留产品级发布约束与模板。

### ADR-008 · 无 Sidecar、无本地常驻服务
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：外部 Python/Node 进程会增加安装、杀软与端口风险。
- 决策：应用启动不得拉起 Python、8500 端口进程或任何未批准 sidecar。
- 放弃方案：本地 OCR/翻译服务；浏览器自动化服务；外部下载器。
- 后果：所有能力要么在前端，要么在 Rust 进程内完成。

### ADR-009 · 接力控制面：摘要索引 + 热状态 + 追加日志 + SOP
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：多 Agent 零历史接力容易重复踩坑、风格漂移或制造第二份事实源。
- 决策：`00_CHARTER.md` 固化公开仓可见的稳定约束；`01_STATE.md` 是可覆盖的热状态（≤100 行）；`02_DECISIONS_AND_PITFALLS.md` 只追加；`03_HANDOVER_SOP.md` 定义接手与更新流程；`04_WAKEUP.md` 提供冷启动指令。
- 放弃方案：复制完整开发仓的内部文档到公开仓；把历史决策塞进 `01`；引用公开仓不存在的文件。
- 后果：提交格式采用“Conventional 主题 + `[RELAY]` 正文”，保留接力链检索。

### ADR-010 · L0–L3 非侵入式执行
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：桌面环境下的自动化可能抢占焦点、改变显示配置或影响无关应用。
- 决策：L0 只读分析；L1 后台 CLI；L2 隔离数据/端口/profile；L3 可见 GUI/桌面/系统级必须单独授权并记录清理与证据。
- 放弃方案：默认直接操作桌面；用无头结果冒充真实 GUI 覆盖；未授权模拟键鼠。
- 后果：报告必须写明执行级别、已执行/延期/阻塞、进程与端口、清理结果。

### ADR-011 · UI token 与圆角层级
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：历史样式文件曾造成 token 漂移与直角后台风格回潮。
- 决策：`--sh-*` 为唯一权威；胶囊层 `rounded-full`，卡片/面板 `rounded-2xl`，`ui/` 基类保留自身 radius；禁止恢复已删除的旧全局样式类名；新代码不新增历史兼容别名依赖。
- 放弃方案：全站强制胶囊；把基类改成胶囊；引入第三方设计模板名称作为风格代号。
- 后果：UI 改动必须同时检查双主题、六语与本地验证。

### ADR-012 · 四路由与启动清洗
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：历史路由与脏 localStorage 会造成白屏或残留 URL。
- 决策：真实路由只有 `/`、`/reader/:id`、`/browser`、`/settings`；`/library` 兼容重定向；两套路由表都有 `*` → `/`；React 挂载前执行 `sanitizeStorage`。
- 放弃方案：保留废弃工作台路由；启动时不校验枚举/JSON；用白屏兜底。
- 后果：新增路由必须同时更新两套路由表与本地验证。

### ADR-013 · 更新通道单一事实源
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：设置页、安全自检与更新器曾可能读取不同配置，导致假告警。
- 决策：端点与公钥只存在于 `tauri.conf.json` 的 `plugins.updater`；设置页徽章与 `security_audit` 都经 `NativeUpdaterConfig::from_tauri_config` 读取同一份配置。
- 放弃方案：改读已下线的旧补丁通道；用编译期单点判定代替配置。
- 后果：旧自定义更新 IPC 不得重新暴露，除非重新完成公钥注入、清单统一与前端接线。

### ADR-014 · SSRF 与回环策略
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：在线直读会接受用户 URL，可能被用于访问内网或云元数据。
- 决策：在线 URL 与每一跳重定向拒绝 127/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7、fe80::/10；域名 DNS 解析后校验；回环只允许 debug/隔离测试显式放行，release 不得放行。
- 放弃方案：只校验首跳；只做字符串前缀判断；release 放行回环。
- 后果：校验失败必须返回稳定错误码，不得静默降级为裸请求。

### ADR-015 · 备份白名单与删除锚定
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：备份/恢复与删除源文件都可能造成不可逆数据损失。
- 决策：`.mrbackup` 只含净化后的 SQLite 快照与白名单前端偏好，不含图片缓存、`online_headers`、`online_proxy`、`experimental_online`、Cookie、`online_filter_events`；恢复前校验完整性；删除源文件只允许压缩包或宽目录下的实际书目录。
- 放弃方案：整目录打包；备份凭据；按备份中的任意路径删除。
- 后果：失败不得改活库；系统/用户关键目录与应用数据目录一律拒绝删除。

### ADR-016 · 多 Agent 文件所有权
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：并行 Agent 写同一文件会互相覆盖。
- 决策：按文件所有权切分；同一文件同一时间只有一个写者；主代理负责集成与验收；子代理只改授权文件。
- 放弃方案：多个 Agent 同时重构同一模块；用 `git stash` 互相让路。
- 后果：冲突必须显式记录；不得用清场式 Git 操作解决。

### ADR-017 · 公开仓快照与完整开发仓分离
- 日期：2026-11-07
- 状态：ACCEPTED
- 背景：`origin/main` 是重建的公开源码快照，只包含核心产品源码与构建配置；完整 QA、发布与内部工程脚本不随公开仓提供。
- 决策：公开仓的 `.agent_relay` 只引用公开仓可见文件；内部 `AGENTS.md`、QA 套件、发布工作流与生成状态文件不得作为公开仓文档的依赖；不得把完整历史或内部工程文件推到公开仓。
- 放弃方案：把完整开发仓文档原样提交到公开快照；向公开仓推送完整历史基线；引用公开仓不存在的文件。
- 后果：公开仓 PR 必须自洽；完整工程治理仍在维护者的完整开发仓执行。

---

## B. 死胡同与避坑指南（Graveyard / Pitfalls）

> 以下路径已被证实会导致安全、数据或治理问题。**严禁再次尝试**，除非所有者明确批准并新增 ADR。

| ID | 严禁再次尝试 | 会导致的问题 |
|---|---|---|
| P-001 | 直接内存覆写正在运行的二进制 | 杀软误报、文件损坏、更新失败 |
| P-002 | 未注入公钥就重新暴露旧自定义更新 IPC | 远程包落地与供应链风险 |
| P-003 | 推送 `v*` Tag 触发发布 | 绕过 Draft、签名、QA 与人工审批 |
| P-004 | 全量 `fs:*` / `shell:*` / `process:*` 权限或通配 CSP | 能力墙失效、CSP 形同虚设 |
| P-005 | 看门狗自动重建主窗口 | 违反用户主权、打断阅读 |
| P-006 | 全局快捷键不隔离 IME/输入态 | 输入中文时误触发翻页/切模式 |
| P-007 | PDF 进 ZIP/图片取页管线；PDFium；quickjs；`wasmUrl` | 取页契约破坏、脚本执行与 wasm 攻击面 |
| P-008 | 主窗口注入脚本；读取或持久化第三方 Cookie | 合规与凭据泄露 |
| P-009 | `session_online_headers` 落 SQLite 或写日志 | 最高级别隐私违约 |
| P-010 | 绕过 `db::open` 直接 `Connection::open` | 锁库、WAL 失效、数据损坏 |
| P-011 | 文件名/目录用普通字典序 | `1 / 10 / 2` 排序错乱 |
| P-012 | 文件移动时删记录或重置进度 | 阅读统计与断点丢失 |
| P-013 | 启动 Python/8500 sidecar | 安装复杂度、端口冲突、杀软误报 |
| P-014 | `git stash` / `git checkout --` / 强制推送清场 | 丢失他人或自己的未提交工作 |
| P-015 | 积攒多个功能后大爆炸提交 | 无法定位回归、接力断点失真 |
| P-016 | 生产 CSP 放 `unsafe-eval`、外部 origin、`blob:`、通配符 | 违背 PDF/CSP 安全约束 |
| P-017 | 内嵌浏览器跳回 `tauri.localhost` / 开发态 localhost | 远程页获得本地 Origin 能力 |
| P-018 | 路径、漫画名、URL 原样写日志/导出 | 隐私泄露 |
| P-019 | `reading_log` 用 `(date, book_id)` 主键或非空 `book_id` | 迁移前旧史无法承载、唯一性冲突 |
| P-020 | 信任 `location.origin === "null"` 的交接 | 非法 origin 登记与凭据错配 |
| P-021 | 按备份中的任意路径删除源文件 | 误删用户数据 |
| P-022 | 加入 MSI；修改 `productName` / `identifier` / 主程序名 | 升级身份漂移、卸载/关联失效 |
| P-023 | 用未执行测试或未脱敏数字冒充证据 | 假 PASS、门禁失真 |
| P-024 | `--no-verify`、跳过签名或跳过必需检查 | 绕过治理与安全门禁 |
| P-025 | 在 `main` 上直接提交或推送 | 违反 Issue/分支/Worktree 纪律 |
| P-026 | 恢复直角后台风格或旧全局样式类名 | 视觉契约回退 |
| P-027 | 组件/Toast/错误里硬编码中英文；后端中文错误直出 | 六语漂移、本地化契约破坏 |
| P-028 | 自动抓取、后台批量爬虫、验证码破解 | 合规与封禁风险 |
| P-029 | 在公开仓文档中引用 `AGENTS.md`、内部 QA 套件或发布工作流 | 公开快照文件缺失，文档自洽性破坏 |
| P-030 | 把完整历史或内部工程文件推到公开仓 | 暴露内部治理、破坏公开快照边界 |
| P-031 | 在 `storageSanitizer` 的 `KEY_RULES` 里没登记的 localStorage 键 | 启动即被当未知键删除，用户选择「保存了但重启就没」；皮肤偏好曾长期命中此坑 |
| P-032 | 直接改写 EXE 的 PE 资源来换图标 | 破坏 Minisign 签名与官方 Updater，升级链断裂 |

---

## C. 跨模块契约（Contracts）

### C-01 · 本地书身份与路径
- id：`sha256(首次入库 path)`。
- 入库/重定位先 `find_book_id_by_path`；Windows 归一 `/`→`\`、尾分隔符与大小写；Unix 不把反斜杠当分隔符。
- 排序：文件名/目录 `natural_cmp_path`；卷/话标题 `natural_cmp`。

### C-02 · 阅读进度
- `books.current_page` / `books.scroll_pct` 与 `reading_log` 累加必须同一事务。
- `reading_log.book_id` 为可空外键，`REFERENCES books(id) ON DELETE CASCADE`。
- 唯一性：`(date, COALESCE(book_id,''))` 表达式索引。
- 重定位在事务内 `PRAGMA defer_foreign_keys=ON` 后再改 `books.id`。

### C-03 · 设置与凭据
- 持久化偏好：`settings.online_headers`、`online_proxy`、`experimental_online`、`diskCacheBudgetMb` 等。
- 仅内存：`session_online_headers`。
- 禁止进入备份：`online_headers`、`online_proxy`、`experimental_online`、Cookie、`online_filter_events`、内部版本标记。
- 禁止进入日志/诊断/错误文案：任何请求头值、Cookie、Token、完整签名 URL query。

### C-04 · 错误码
- 稳定码使用 `kebab-case`，附在用户文案尾部，如 `（pdf-encrypted）`。
- 后端错误在非中文界面必须经 `localizeBackendError`。
- 新增错误码必须同步 `src/features/errors/localize.ts` 与六语字典；未知中文错误落泛化本地化文案。

### C-05 · 路由
- 真实路由：`/`、`/reader/:id`、`/browser`、`/settings`。
- `/library` 仅兼容重定向到 `/`。
- 两套路由表都必须有 `<Route path="*" element={<Navigate to="/" replace />} />`。

### C-06 · 主题与视觉
- token：`src/index.css` 的 `--sh-*` 唯一权威；历史兼容别名仅维护。
- 胶囊层 `rounded-full`；卡片/面板 `rounded-2xl`；`ui/` 基类保留自身 radius。
- 主表面硬偏移阴影；浮层可用普通阴影。

### C-07 · 国际化
- 六语：`zh-CN`、`zh-TW`、`en`、`es`、`ja`、`ko`。
- 新增 key 必须同时写入六套字典；类型由其它语言块约束。
- 胶囊容器必须有 `whitespace-nowrap` 或弹性宽度保护。

### C-08 · 窗口、权限与 CSP
- 窗口标签：`main`、`recovery`、`browser`。
- `capabilities/default.json` 必须覆盖三个真实窗口；只声明真实调用的能力。
- 生产 CSP 禁止 null/空、通配符、外部 origin、`blob:`、`wasm-unsafe-eval`。
- 内嵌浏览器只允许 http/https，禁止跳回本地源。

### C-09 · 接力状态
- `01_STATE.md` ≤100 行；状态只能是 `GREEN` / `RED` / `BLOCKED`（可附证据说明）。
- 必填：当前修改文件与函数/组件、最后完成动作、Next Immediate Action、FIXME/TODO 位置。
- 每次原子任务后覆盖更新；交接前必须刷新。

### C-10 · 提交与接力链
- Subject：Conventional Commits 中文说明，如 `feat(parser): 完成 AST 节点定义`。
- 正文：3–6 条中文要点，末尾追加 `[RELAY] <模块>: <动作> | NEXT: <下一步>`。
- 只在对应 Issue 分支提交；`main` 不直接提交；不积攒大爆炸提交。

### C-11 · 缓存
- `render_cache/` 与 `online_cache/` 共用 `diskCacheBudgetMb`（500MB–10GB，默认 2048MB）。
- 读取刷新 mtime，LRU 淘汰；只清理派生目录，不碰 `library.db` 与阅读进度。
- 写失败进入 `cache_health`（首次 toast + 诊断可见），不得永久静默。

### C-12 · 版本与发布
- 版本事实源：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`；公开仓 `npm run build` 内置一致性检查。
- 产品发布只通过维护者完整工程环境的 candidate → Draft → 人工审批 → publish。
- Release Notes 结构模板：`.github/RELEASE_NOTES_TEMPLATE.md`。

### C-13 · 证据口径
- `VERIFIED`：本轮实际执行并有输出/回执。
- `SIMULATED`：用模拟环境/假数据验证，需标明。
- `INFERRED`：由代码/配置推断，未执行。
- `UNKNOWN`：当前环境无法验证。
- `BLOCKED`：外部条件阻塞，需写明阻塞项与下一步。

---

## D. 追加记录

### 2026-11-07 · 公开仓兼容版接力控制面
- 以 `origin/main`（`ad78bbc` 公开源码快照）为基线，建立 `.agent_relay/` 五文件。
- 移除对 `AGENTS.md`、内部 QA 套件、发布工作流与生成状态文件的依赖；公开仓文档只引用公开仓可见文件。
- GitHub Issue：#225；分支：`chore/225-relay-public`。
- PR #231：首轮必需检查全部通过（Analyze / CodeQL / PR governance / build + rust check）；mergeStateStatus CLEAN；本次 01 更新后重跑。
- 提交格式采用“Conventional 主题 + `[RELAY]` 正文”。
- 本轮仅新增控制面文档，不改业务代码。

### 2026-11-08 · Task 3 / Task 7（品牌冻结 + 系统级图标 + 画框包裹式换肤）

#### ADR-033 · 系统级图标走 Shell Link，绝不改写 EXE 资源
- 日期：2026-11-08
- 状态：**SUPERSEDED（被 ADR-035 取代，代码未合入）**
- 背景：当时用户要换的是桌面快捷方式、任务栏与托盘的系统级图标。最直觉的做法是改写 EXE 的 PE 图标资源，但发布产物带 Minisign 签名，官方 Updater 会校验它——改资源等于让升级链断掉。
- 当时的决策：新增 `src-tauri/src/desktop_icon.rs`，后端校验图片魔数与 2 MiB 上限，用 `image` 的 ICO 编码器生成多尺寸 `active.ico`，再用 Windows Shell Link COM（`IShellLinkW` + `IPersistFile`）改写 `.lnk` 图标位置。
- 后续修订：用户进一步明确「桌面/任务栏/托盘图标 100% 维持随包构建资源，且**不要开发任何图标自定义/切换功能**」。因此本 ADR 的实现整体撤回：Shell Link 后端、`.ico` 编码、图标偏好链路与设置页入口全部删除，`windows` 的 COM/Shell feature 与 `image` 的 `ico` feature 一并回退。**保留本 ADR 的核心结论**：任何情况下都不改写 EXE 资源。
- 保留价值：它记录了「为什么不能动 EXE 图标资源」这条硬约束，以及 Shell Link 方案在需要时如何重建。

#### ADR-034 · 画框包裹式换肤：整窗画布 + 内嵌视窗，禁用漂浮挂件
- 日期：2026-11-08
- 状态：ACCEPTED
- 背景：旧的「角色挂件」装饰层把美术摆在内容之上，天然存在遮挡列表与文字的风险；用户要求改成「整片窗口是一张主题画布，功能区是内嵌视窗」。
- 决策：删除 `ThemeDecorationLayer` 与全部 `mr-decoration-*` 槽位，改为 `SkinCanvasFrame`（100vw × 100vh 画布：背景层 + 外框层，均 `pointer-events: none`）与 `ContentViewport`（`--mr-skin-viewport-inset` 控制内缩、圆角、毛玻璃叠加层与画框投影）两层骨架。美术只画在画布上，视窗压在其上，因此角色与插画只能出现在视窗外围，永远压不到内容。沉浸式阅读路由不挂载视窗，天然全屏无边距。
- 放弃方案：继续用绝对定位挂件槽位；用 `clip-path` / `mask` 在视窗上方开洞（合成层差异大，且失败时可能盖住内容）；把背景图直接铺在内容容器上（失去画框层次）。
- 后果：皮肤 token 统一收敛到 `--mr-skin-*`；素材只有两条合法通道（`public/skins/` 随包静态文件、后端校验后的 `data:` URL），生产 CSP `img-src 'self' data:` 不变；`Skin Viewport Guard` 用无头 Chrome 断言顶栏、搜索框、书库卡片在非零内缩下仍完全可见可点击，且阅读路由恢复全屏。

#### ADR-035 · 左上角品牌标识冻结在 0.19.1 原版；系统图标恒为随包构建资源（不提供任何图标自定义）
- 日期：2026-11-08
- 状态：ACCEPTED
- 背景：品牌图标偏好原先同时驱动左上角 UI 标识与托盘。用户明确要求左上角保持 0.19.1 发布版的原版图形（纯内联 SVG、固定配色、不可替换），可替换能力只留给系统级图标。
- 决策：`AppBrandIcon` 改为纯展示组件（不再读取偏好上下文），`BrandLogo` 固定渲染 `moyu` 预设——即 v0.19.1 的原始路径与配色逐字照搬。**图标偏好链路整体删除**：`features/brand/{brandIcon,BrandIconProvider,appIcon,trayIcon}`、`tray_set_icon` 命令、设置页的图标卡片与 `settings.desktopIcon.*` 六语词条全部移除；桌面快捷方式、任务栏与托盘恒用 `src-tauri/icons/` 的随包构建资源（托盘固定 `default_window_icon`）。品牌展示名收敛为单一常量 `BRAND_DISPLAY_NAME`，新增 `static:release-surface` 守卫（`scripts/release-surface.mjs`，Vite 配置加载时也执行一次）同时守住升级身份锚点与六语品牌名。
- 放弃方案：保留左上角的动态替换；保留任何一级的图标自定义入口；只靠文案约定而不做守卫；把守卫只放在 CI 而不放在构建入口。
- 后果：图标定制能力整体不存在，两端图标各自独立、互不同步；`Cargo.toml` 的 `windows` feature 集合与 `image` feature 集合回到基线状态，Cargo.lock 无新增第三方包。

### ADR-036 · 在线直读开关回到卡片上；地址选择改为「筛出可用地址」
- 日期：2026-11-09
- 状态：ACCEPTED
- 背景：用户报告 v0.18.0 可用、v0.19.x 不可用的「在线 URL 直读」回归。排查结论有三条：
  (1) 开关不是被「配额去重」藏起来的，而是「重建公开源码快照」那次提交**主动**把
  「在线 URL 直读」卡片上的 Switch 拿掉，只留一句「由『功能开关』统一控制」的死提示，
  而功能开关面板在**常规**分区——用户去网络页找不到入口；
  (2) Rust 侧的门控没有 stale 问题：`set_feature_enabled` 在同一次写入里同步了
  内存快照，`resolve_online_url` 读的就是这份快照；
  (3) 真正的「打不开」在网络层：Issue #179 的地址校验采用「任一解析地址被拦就整体
  拒绝」，域名同时给出公网 IPv4 与 ULA/link-local IPv6 时整站不可达。
- 决策：
  - 设置页「网络与在线源 → 在线 URL 直读」卡片右上角**恢复可直接点击的 Switch**，
    走与功能开关面板完全相同的 `set_feature_enabled` 持久化路径；删掉死提示文案；
  - 关闭态在 `/browser` 顶部地址栏提交时，提示条与 toast 都给「立即开启」按钮，
    点击即开启功能并立刻放行重试；后端错误统一识别 `feature-disabled`；
  - 地址校验改为**筛出可直连地址**：保留通过白名单的地址、公网 IPv4 优先，
    一个可用地址都没有才 fail-closed；连接仍只发生在这些已校验地址上，
    私网地址永远不会被连到（SSRF 防护不变）。TLS server name 仍是原域名，
    证书校验不受钉 IP 影响；
  - 安全模式阻断补稳定码 `safe-mode-blocked`，并补「文件缺失/未激活必须放行」的
    Rust 单测，锁死误判。
- 放弃方案：把功能开关面板搬进网络分区（与常规分区重复）；放宽 SSRF 白名单；
  为 SOCKS 目标改用 IPv6 表达式（适配器不支持，仍只支持 IPv4）。
- 后果：`experimental_online` 的写入必须走 `set_feature_enabled`——`set_settings`
  刻意不写功能键（防止表单未保存的改动被一起写库），这一点被写进 ADR 供后来者参照。

#### 附带修复
- 本分支开始时 `storageSanitizer` 尚未登记 `mr-skin`，皮肤偏好每次启动都被当未知键删除（命中 P-031）。上游 **#291（`fix(preferences)`）已独立修复**该问题并登记 `mr-skin` 规则；rebase 后本 PR 只保留「用户导入的整页背景」`mr-skin-custom` 一条新规则，重复规则已删除。
- 皮肤默认状态改为**预留态（dormant）**：内置 `framed` 皮肤不会被持久化偏好自动启用，当前版本恒为极简外观；设置页不再暴露未完成的皮肤切换 UI，Schema 与 Hook 保留在代码层。
- `src-tauri/src/skin.rs` 未改动；自定义整页背景仍走「后端校验 → data: URL」通道。
