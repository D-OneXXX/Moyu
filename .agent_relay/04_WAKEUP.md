# 04 · 冷启动唤醒词（COPY-PASTE · 公开源码快照版）

> 用途：把下面整段粘贴给任何零对话历史、准备接手 Moyu 公开源码快照的新 Agent。
> 极简唤醒词：**读取 `.agent_relay` 并接管当前断点；先对齐状态，再改代码。**
> 本文件只负责启动指令；当前进度、分支、Issue 与验证结果一律以 `01_STATE.md` 为准。

```text
【Moyu 中途接手 · 冷启动唤醒 · 公开源码快照】
读取 .agent_relay 并接管当前断点；先对齐状态，再改代码。

你现在接手 Moyu 公开源码快照（仓库：D-OneXXX/Moyu，origin/main）的中途开发任务。
你没有上一轮对话历史。禁止凭记忆猜测，禁止跳过交接文件直接开工，禁止重复已完成的工作。
公开仓不包含 AGENTS.md、内部 QA 套件、发布工作流与内部工程脚本；不要引用或寻找这些缺失文件。

一、只读加载（按顺序）
1. .agent_relay/00_CHARTER.md
2. .agent_relay/01_STATE.md
3. .agent_relay/03_HANDOVER_SOP.md
4. .agent_relay/02_DECISIONS_AND_PITFALLS.md 中与当前任务相关的 ADR / Pitfall / Contract
5. README.md / README.en.md
6. docs/ARCHITECTURE.md
按需查阅相关源码、.github/PULL_REQUEST_TEMPLATE.md、THIRD_PARTY_NOTICES.md。

二、环境自检（L1，不改业务代码）
pwd
git remote -v
git status --short
git worktree list
git log -5 --format='%h %s'
npm ci
npm run check
npm run test:rust

构建与格式检查按改动裁剪：npm run build / npm run format:check。
公开仓没有内部 QA 套件；完整 QA 在维护者的完整工程环境执行。
未运行的检查写 UNKNOWN，禁止写 PASS。
L3（可见 GUI/桌面/系统级）未获单独授权，不得执行。

三、状态对齐
- 若 01_STATE.md 与仓库实际状态不一致：先修正 01，再汇报，不要直接开工。
- 若 01 为 GREEN：确认断点可执行后，继续 Next Immediate Action。
- 若 01 为 RED：只允许收敛到 GREEN，不得开新功能。
- 若 01 为 BLOCKED：先处理阻塞或明确告知，不得自行绕过。
- 工作区中非本轮改动不得清理、覆盖或提交。

四、执行纪律
- 同一文件同一时间只有一个写者；不抢写他人文件。
- 禁止 git stash、git checkout --、git reset --hard、强制推送、删除他人分支。
- 每完成一个原子任务：先覆盖更新 01_STATE.md，再在对应 Issue 分支提交。
- 禁止直接提交 main；没有 Issue/分支归属时，停下来问，不得擅自提交。
- 提交格式：
  feat(scope): 中文动作
  - 3–6 条中文要点
  [RELAY] <模块>: <动作> | NEXT: <下一步>
- 设计/契约/依赖/发布流程变更：先在 02 追加 ADR，再改代码。
- 不引入未批准依赖；不改 00_CHARTER；不推送 v* Tag；不跳过签名与必需检查。
- 不在公开仓文档中引用 AGENTS.md、内部 QA 套件、发布工作流或生成状态文件。
- 证据必须标注 VERIFIED / SIMULATED / INFERRED / UNKNOWN / BLOCKED。

五、现在只输出以下确认，不要先改代码
[RELAY ACK]
仓库 / 分支 / HEAD：
状态：GREEN / RED / BLOCKED
最后完成：
当前断点（文件/函数）：
Next Immediate Action：
阻塞项：
本轮验证：
与 01_STATE 不一致之处：

Ack 后，如果 Next Immediate Action 明确、无阻塞、不涉及 L3，可直接执行；否则先问。
不要重新规划整个项目，不要扩大范围。
```

## 维护规则

- 本文件只放可复用的启动指令，不写当前 HEAD、Issue 号、进度等易漂移信息；这些只放 `01_STATE.md`。
- 读取顺序、自检命令或执行纪律变化时，先更新 `03_HANDOVER_SOP.md`，再同步本文件。
- 本文件与 `00_CHARTER.md` / `03_HANDOVER_SOP.md` 冲突时，以后者为准。
