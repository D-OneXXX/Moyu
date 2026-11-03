# W7-D2 整改登记（Task 4 P2 承接）

> 本文件登记 W7-D2 独立审查遗留的两项 P2，明确责任、完成阶段与验收证据。
> 提交、合并、发布与 G3 状态仍按 `docs/ENGINEERING_WORKFLOW.md` 与
> `AGENTS.md` 执行；本文件不代表任何生产启用或发布批准。

- 分支：`feat/w7-d2-read-only-data`
- 基线：D1b `2382f23`
- 登记日期：2026-11-03
- 当前阶段：Task 6（条件请求扩展与传输治理）

## 整改项

| ID | 问题 | 级别 | 责任 | 完成阶段 | 状态 |
|---|---|---|---|---|---|
| D2-R1 | 条件 GET 先调用 provider/渲染，再计算 ETag 判定 304 | P2 | Backend（D2 控制器） | Task 6 | **已关闭** |
| D2-R2 | `source-unsupported` 尚未进入冻结错误码表与六语映射 | P2 | Controller（契约/文档）+ Frontend（六语） | Task 8（契约/静态守卫）+ D4（Web UI 本地化） | **未关闭** |

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

**当前事实**

- `data.rs` 对 `DataError::SourceUnsupported` 输出 HTTP `415` 与稳定码
  `source-unsupported`。
- 该码**不在** `WEB_ACCESS_API.md` §6.2 冻结词表中，也尚未进入
  `src/features/errors/localize.ts` 与六语字典。
- 该码只在 Web 数据面出现；D2 尚未交付 Web Reader UI，因此不是当前桌面 UI 的
  可见回归，但属于必须在公开 Web V1 前关闭的契约债。

**责任与完成阶段**

- Controller：Task 8 更新 `docs/dev/WEB_ACCESS_API.md` §6.2 与
  `tests/qa/suites/static.mjs` 的码表/静态守卫，把 `source-unsupported`
  明确登记为 415 稳定码；如产品决定不新增码，则在 Task 8 改为复用既有码并
  同步修改 `data.rs` 与测试。
- Frontend：D4 Web Reader 本地化阶段，在 `localize.ts` 与
  `zh-CN/zh-TW/en/es/ja/ko` 六语字典中补齐该码的文案。
- 在以上两项完成前，D2-R2 保持**未关闭**；不得因 Task 4/Task 6 已提交而视为关闭。

**验收口径**

- Task 8：冻结文档与静态守卫能检索到 `source-unsupported`，且与实现一致。
- D4：非中文界面不直出中文；该码有六语文案；未知码仍落到泛化本地化文案。

## 残余边界（不阻塞 Task 6）

- hyper 的 `max_buf_size(16 KiB)` 先于应用层 8 KiB 守卫：8–16 KiB 头块由应用层
  返回带 `X-Request-Id` 的 `431 header-too-large`；超过 16 KiB 的极端头块可能由
  hyper 直接拒绝且不带应用请求 ID。该边界属传输层既有上限，若需统一到 8 KiB
  必须同时调整 hyper 缓冲策略，留待 Task 8/9 评估。
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
- 整改项状态：**D2-R1 保持已关闭**；**D2-R2 保持未关闭**，责任（Controller Task 8 +
  Frontend D4）与完成阶段**不变**；`source-unsupported` 仍不在 `WEB_ACCESS_API.md` §6.2
  冻结码表与六语映射中。
- 安全分级：P0/P1 均无；P2 仅 D2-R2 与 G3 BLOCKED；P3 为已知传输/证据边界。
  本轮无需生产修复，无被跳过的失败测试。
- 完整证据（真实测试名、命令计数、A–F 矩阵、分级）：`docs/dev/W7_D2_TASK7_SECURITY_VERIFICATION.md`
  （该文件位于 gitignored 的 `docs/dev/`，仅本地留存，不入库）。
- G3 仍为 **BLOCKED**；未合并、未推送、未创建 Tag/Release、未启用生产监听。
