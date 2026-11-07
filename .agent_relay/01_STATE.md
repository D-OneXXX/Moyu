# 01 · 实时热状态（公开源码快照版）

> 最后更新：2026-11-07T10:27:16+08:00
> 分支 / 基线 HEAD：`chore/225-relay-public` / `ad78bbc`（`origin/main` 公开源码快照；PR #231）
> 状态：**GREEN**
> 证据：隔离 worktree `issue-225-relay-public` 中 `npm ci`、`npm run check`、`npm run test:rust`、`npm run build`、`npm run format:check` 全部通过。本轮仅新增 `.agent_relay/` 文档，未改业务代码。
> 边界：完整 QA 与 L3 不在公开仓执行（UNKNOWN/未授权）；不得据此宣称发布就绪。

## 1. 里程碑（模块级）

- [x] 公开仓接力控制面：`00` / `01` / `02` / `03` / `04` 已初始化
- [x] 公开仓基线验证：check / test:rust / build / format:check 通过
- [x] Issue #225 关联（OPEN / status:in-progress / area:docs；PR 使用 `Refs`，不自动关闭）
- [x] PR #231 已创建；首轮必需检查全部通过（mergeStateStatus CLEAN）
- [/] 等待所有者审阅/合并 PR #231 并指定首个业务任务

## 2. 当前精确断点（Active Breakpoint）

- 当前文件：`.agent_relay/`（公开仓兼容版控制面文档，无业务代码修改）
- 最后完成：写入 `00`–`04`；完成公开仓基线验证；创建 PR #231（首轮门禁全部通过）
- **Next Immediate Action**：等待所有者审阅/合并 PR #231；合并后由所有者指定首个业务 Issue
- 阻塞项：无

## 3. FIXME / TODO（代码桩与未完结标记）

- 无代码桩：本轮未改业务代码。
- 既有构建提示：`npm run build` 有 chunk >500 kB 警告（非本轮引入，不阻塞）。
- 公开仓边界：不得引用 `AGENTS.md`、内部 QA 套件、发布工作流或生成状态文件；完整工程治理在维护者完整开发仓执行。

## 4. 工作区快照（接手者必看）

- 本轮新增：`.agent_relay/`（位于隔离 worktree `issue-225-relay-public`）
- 当前工作区：干净；`chore/225-relay-public` 跟踪 `origin/chore/225-relay-public`
- 禁止用 `git stash` / `git checkout --` / 强制推送清理工作区。

## 5. 本轮验证（L1，隔离 worktree）

- VERIFIED：`npm ci` → 294 packages / 14s
- VERIFIED：`npm run check` → tsc + cargo check 通过
- VERIFIED：`npm run test:rust` → 856 passed / 0 failed / 2 ignored / 86.97s
- VERIFIED：`npm run build` → vite 6.4.5 / 2636 modules / built in 7.12s（chunk 警告非阻塞）
- VERIFIED：`npm run format:check` → 通过
- VERIFIED：PR #231 首轮检查 → Analyze (actions) / Analyze (javascript-typescript) / CodeQL / PR governance / build + rust check 全部 pass；mergeStateStatus CLEAN（本次 01 更新会触发重跑）
- UNKNOWN：完整 QA、真实 GUI / L3（公开仓不含内部 QA；未授权）
- 未创建常驻进程/端口；未进行桌面交互。

## 6. 当前目标与范围

- 本轮目标：在公开源码快照建立自洽的接力控制面与冷启动唤醒词，不改变产品行为。
- 范围：不引入依赖、不改业务代码、不提交无关文件、不推送 `v*` Tag。
- 当前交付：PR #231 等待所有者审阅/合并；下一业务候选由所有者在公开仓 Issue 中指定。
