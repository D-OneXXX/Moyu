# W7-D2 整改登记（Task 4 P2 承接）

> 本文件登记 W7-D2 独立审查遗留的两项 P2，明确责任、完成阶段与验收证据。
> 提交、合并、发布与 G3 状态仍按 `docs/ENGINEERING_WORKFLOW.md` 与
> `AGENTS.md` 执行；本文件不代表任何生产启用或发布批准。

- 分支：`feat/w7-d2-read-only-data`
- 基线：D1b `2382f23`
- 登记日期：2026-11-03
- 当前阶段：Task 8（契约冻结、静态登记与文档回写）

## 整改项

| ID | 问题 | 级别 | 责任 | 完成阶段 | 状态 |
|---|---|---|---|---|---|
| D2-R1 | 条件 GET 先调用 provider/渲染，再计算 ETag 判定 304 | P2 | Backend（D2 控制器） | Task 6 | **已关闭** |
| D2-R2 | `source-unsupported` 尚未进入冻结错误码表与六语映射 | P2 | Controller（契约/静态）+ Frontend（六语） | Task 8 契约/静态登记 + D4 六语 | **部分关闭**：契约/静态登记已关闭；六语仍待 D4 |

## D2-R1：条件 GET 预渲染探测

**处理方式**

- 仅当请求携带 `If-None-Match` 时，在 `spawn_blocking` 内先调用只读 L2 探测：
  - `read_service::cached_page_asset`
  - `read_service::cached_tile_asset`
- 探测函数复用 `page_asset`/`tile_asset` 的 active/PDF/source/range 守卫，
  但只读 `RenderCache` 的 L2 成品字节，不渲染、不写 DB、不写 L1、不预取、
  不获取 tile 物化锁。探测可能删除无法解析的坏 L2 条目（缓存自愈），
  但不会写入新的缓存字节。
- 命中时直接用缓存字节构造原有 `Payload`，由既有 `Payload::into_response`
  计算内容哈希 ETag：匹配返回 `304`，不匹配返回 `200`（仍不渲染）。
- 未命中时回落到原有 `run`，因为 ETag 是成品字节的内容哈希；没有缓存字节
  就无法诚实地判定 304。
- 认证先于探测；撤销会话、移除书籍、PDF、越界页/瓦片都在探测阶段返回原有
  错误，不会借缓存绕过 401/404/415/416。
- 会话/渲染许可在探测与可能的后备渲染期间保持持有，超时不释放仍在工作的许可。

**验收证据**

- `read_service`：`cached_page_asset_returns_none_until_rendered_then_hits_l2`、
  `cached_tile_asset_returns_none_until_rendered_then_hits_l2`、
  `cached_probes_keep_typed_errors`、
  `cached_probes_do_not_mutate_progress_or_reading_log`。
- `web_access::test_http`：条件 304 后 provider `page`/`tile` 调用计数不增加；
  冷缓存条件请求仍回落到渲染；撤销后条件请求返回 401 且不调用 provider。
- 真实 TLS：撤销会话后携带 `If-None-Match` 仍返回 `401`，不返回 `304`。
- `cargo test --lib` 与 `cargo clippy --all-targets -- -D warnings` 全绿
  （具体计数见 Task 6 交付报告）。

## D2-R2：`source-unsupported` 稳定码登记

**当前事实（Task 8 后）**

- `data.rs` 对 `DataError::SourceUnsupported` 输出 HTTP **415** 与稳定码
  `source-unsupported`；`DataError::PdfUnsupported` 输出另一稳定码
  `pdf-source-unsupported`，两者不得混用。
- 触发条件：`read_service::ensure_source_allowed` 只接受
  `source_type = "local"` / `"generic_manga"`；其它值（如 `anime`）→ 415。
  作用范围为 thumb / pages / page / layout / tile 及条件 GET 的 L2 探测；
  **不作用**于 detail / progress（在线书仍可读元数据与进度）。
- 语义：**永久失败**，无 `Retry-After` / `retryAfterMs`，客户端不得自动重试；
  PDF 是“格式不支持”（封面 thumb 例外），`source-unsupported` 是“源类型不在
  数据面支持列表”；无 per-book ACL。
- 契约已写入 `docs/dev/WEB_ACCESS_API.md` §6.1 / §6.2 / §6.3，并与实现一致。
- **六语本地化仍未完成**：`src/features/errors/localize.ts` 目前只有
  `pdf-source-unsupported` 映射，`zh-CN/zh-TW/en/es/ja/ko` 均无该码文案。

**关闭拆分**

| 责任 | 阶段 | 状态 |
|---|---|---|
| 契约冻结（§6.1/§6.2/§6.3） | Task 8 | **已关闭** |
| 静态登记 `static:d2-data-routes`（Agent B 同批加入） | Task 8 | **已关闭**（守卫校验 `source-unsupported` 在 `data.rs` 唯一映射；415 语义与码表在契约文档） |
| `localize.ts` + 六语字典 | D4 | **未关闭** |

- Task 8 **只**关闭“契约/静态登记”责任；D2-R2 整体仍为**部分关闭**，
  不得写成完全关闭，也不得声称六语已就绪。
- `static:d2-data-routes` 由 Agent B 在同一 Task 8 批次写入
  `tests/qa/suites/static.mjs`；本文件的文档改动不替代该守卫，也不重复实现。
- D4 验收口径不变：非中文界面不直出中文；该码有六语文案；未知码仍落到泛化
  本地化文案。六语完成前，Web Reader 不得把该码直接展示给非中文用户。

## 残余边界（不阻塞 D2 本地交付）

- hyper 的 `max_buf_size(16 KiB)` 先于应用层 8 KiB 守卫：8–16 KiB 头块由应用层
  返回带 `X-Request-Id` 的 `431 header-too-large`；超过 16 KiB 的极端头块可能由
  hyper 直接拒绝且不带应用请求 ID。该边界属传输层既有上限，Task 8 确认保留为
  残余边界；若需统一到 8 KiB 必须同时调整 hyper 缓冲策略，留待 Task 9/后续评估。
- 连接总预算 65 秒，头读取 10 秒、数据 handler 60 秒；慢头 + 满额渲染的极端组合
  会由连接预算先截断，无法保证 504 已写出。该组合只影响异常客户端，且阻塞任务
  仍持有许可，不会绕过渲染门。
- 条件瓦片探测命中 L2 后仍需读取布局；冷布局会扫描页头（在线书可能读网），
  但不执行图像渲染。该成本受会话/渲染门与超时约束。

## 范围声明

- 本登记不改变 G3 的 **BLOCKED** 状态。
- 未合并 `main`、未推送、未创建 Tag/Release、未启用生产监听。
- 真实手机/LAN/信任库仍属于 G3/D5，未在本阶段验证。

## Task 7 验证记录（2026-11-03）

- 基线：分支 `feat/w7-d2-read-only-data`，HEAD `15dec5c5`；Task 7 只新增测试与文档，
  **零生产代码改动**，无新依赖/迁移/路由/写路径。
- 执行级别：L0/L1 + loopback L2 TLS；无 GUI、无生产监听、无 CA 初始化、无配对窗口、
  无防火墙/信任库变更；仅使用临时目录、内存库与临时端口，结束后无遗留进程/端口。
- 全量回归：`cargo test --lib` **735 passed / 0 failed**；`cargo fmt --check`、
  `cargo clippy --all-targets -- -D warnings` 均 PASS。
- 新增证据（测试）：`web_access::test_http` 8 项凭据/路径/条件请求/Range/431 用例；
  `web_access::tests::real_tls_data_routes_reject_traversal_and_unknown_methods`（真实 TLS）；
  新增 `web_access::data_tests` 4 项只读快照用例（8 条 GET 路由前后 `books` 进度列与
  `reading_log` 计数不变、条件 304 零写入、移除/PDF/缺源零写入、在线 layout 不改
  `meta_json`）；`read_service::tests` 4 项（移除书、anime、缺源、不安全路径）。
- 只读完整性：8 条 GET 路由与条件 304 的数据库快照完全一致，无 `Access-Control-Allow-Origin`；
  会话活动刷新仅驻留内存。
- 未取得有效证据（**不计 PASS**）：宿主拒绝创建符号链接，`folder_source_skips_symlinked_images`
  输出 `BLOCKED` 并记 **BLOCKED**；目录联接点未构造，记 **BLOCKED/UNKNOWN**；
  503/504 仅映射契约 VERIFIED，真实 gate 超时路径未强制触发（**UNKNOWN**）。
- 整改项状态：**D2-R1 保持已关闭**；**D2-R2 在 Task 7 时保持未关闭**，责任
  （Controller Task 8 + Frontend D4）与完成阶段**不变**；`source-unsupported` 当时
  不在 §6.2 冻结码表与六语映射中。Task 8 已补齐 §6.1/§6.2/§6.3 契约与静态登记，
  六语仍待 D4（见下方 Task 8 记录）。
- 安全分级：P0/P1 均无；P2 仅 D2-R2 与 G3 BLOCKED；P3 为已知传输/证据边界。
  本轮无需生产修复，无被跳过的失败测试。
- 完整证据（真实测试名、命令计数、A–F 矩阵、分级）：`docs/dev/W7_D2_TASK7_SECURITY_VERIFICATION.md`
  （该文件位于 gitignored 的 `docs/dev/`，仅本地留存，不入库）。
- G3 仍为 **BLOCKED**；未合并、未推送、未创建 Tag/Release、未启用生产监听。

## Task 8 记录（2026-11-03，文档与契约冻结）

- 范围：**文档 + 静态守卫**；零生产 Rust/路由/依赖/迁移改动，未改任何 Rust 测试；
  仅运行 L1 静态 QA，不运行全量 QA/GUI。
  回写文件：`docs/dev/WEB_ACCESS_API.md`、`docs/TECHNICAL.md`、`docs/TESTING.md`、
  `docs/dev/W7_PRODUCTION_GATES.md`、本文件。Task 7 报告
  `docs/dev/W7_D2_TASK7_SECURITY_VERIFICATION.md` 保持原样。
- 本地文档为 gitignored 副本，从 D1b 工作区同步后在 D2 worktree 本地更新；
  不 force-add、不入库。
- **D2-R1：保持已关闭**（Task 6 的条件探测实现与证据未变）。
- **D2-R2：部分关闭**。Task 8 关闭**契约/静态登记责任**：
  - `WEB_ACCESS_API.md` §6.1/§6.2 登记 415 `source-unsupported`，§6.3 说明触发条件
    （`source_type` 非 `local`/`generic_manga`）、作用范围（thumb/pages/page/layout/tile
    与 L2 探测，不含 detail/progress）、永久失败与客户端不得自动重试；
  - 与 `pdf-source-unsupported` 明确并列、不混用；
  - `static:d2-data-routes` 由 **Agent B 在同一 Task 8 批次**加入
    `tests/qa/suites/static.mjs`，校验八条 GET 白名单、无写路由、`source-unsupported`
    在 `data.rs` 唯一映射、无 CORS/Range、`keep_alive(false)` 与连接上限 32/8
    的 TCP 断开路径；415 语义与码表登记在本契约文档中，本文件的文档改动不替代该守卫。
- **仍开放**：`src/features/errors/localize.ts` 与 `zh-CN/zh-TW/en/es/ja/ko` 六语字典
  尚无 `source-unsupported` 文案；该责任归 **D4 Web Reader 本地化**。因此 D2-R2
  **不得**标记为完全关闭，Task 8 也不声称六语已完成。
- 事实基线未变：735/735 Rust 测试；G3 BLOCKED；无真机/LAN/信任库证据；
  未合并、未推送、未创建 Tag/Release、未启用生产监听。

## Task 9 记录（2026-11-03，最终验收与独立审查）

- 基线：`feat/w7-d2-read-only-data`，Task 9 起始 HEAD `31fb01b`；Task 9 代码/测试/静态守卫提交 `30876e0`。
- 独立审查：3 个只读审查代理（安全/认证、只读/数据完整性、文档/静态/仓库卫生）；**无 P0/P1**。
- P2 修复：
  - `read_service` 测试改用每线程临时渲染根，避免向用户真实 `render_cache` 写测试书；已清理本轮前遗留的 `a…/b…/d…` 测试目录（派生缓存，删除后可按需重建）。
  - `data_tests` 快照补齐 `page_count`、`scroll_pct` 与 `reading_log SUM(pages)`。
  - `cached_tile` 文档更正：只读 L2 图片字节，但仍会读取布局元数据（可能扫描页头/在线尺寸），不渲染图片。
  - 静态守卫拒绝 `method.as_str()/to_string()` 字符串方法比较，保留显式 `Method::GET` 门。
  - **勘误**：Task 7 报告中“桌面无行为变更”的表述已被更精确的结论取代。`src-tauri/src/source.rs` 自 D2 起跳过目录源中的符号链接子图片；这是有意的 fail-closed 加固，桌面目录书中使用符号链接页的用户会看到这些页被排除。详情见 `docs/TECHNICAL.md` §16.1；Task 7 报告保留为历史证据，不覆盖。
- 门禁证据（L0/L1，未运行 L3 GUI/全量 QA）：
  - `cargo fmt --all -- --check` PASS；
  - `cargo clippy --all-targets -- -D warnings` PASS；
  - `cargo test --lib` **735 passed / 0 failed**；
  - `node tests/qa/run-qa.mjs --suite=static` **28/28 PASS**；
  - `npx tsc --noEmit` PASS（先执行 `npm ci`，仅安装锁定依赖）；
  - `npm run build` PASS（Vite production build）；
  - `npm run test:version` 6/6 PASS；`npm run test:governance` 39/39 PASS。
- 未执行/不计 PASS：`--suite=architecture` 与全量 QA 属 L3（启动可见应用/窗口），本轮未获单独授权，标 **BLOCKED**；真实手机/LAN/信任库/G3 仍 **BLOCKED**；符号链接/junction 仍 BLOCKED/UNKNOWN；503/504 真实 gate 超时路径仅映射契约 VERIFIED，实际强制触发 UNKNOWN。
- D2-R2：契约/静态登记仍关闭；六语本地化仍归 D4，整体保持**部分关闭**。
- G3：**BLOCKED**。
- 范围：未合并 `main`、未推送、未创建 Tag/Release、未启用生产监听；Task 9 无生产运行时语义变更。
