## 关联 Issue

<!-- 必须写 Closes #<issue>，合并后自动关闭对应 Issue；Dependabot / Renovate 等自动化 PR 免填。 -->
<!-- 纯跟踪型 PR（不关闭 Issue）可写 Refs #<issue>，并说明为何不关闭。 -->

Closes #

## 变更范围

<!-- 只写本 Issue 范围内的改动；相邻但本次不处理的问题请明确标为「不包含」。 -->

## 验证

<!-- 执行级别按 AGENTS.md §1.5；L2 · QA gate 会按改动路径自动选套件，此处只做人工核对。 -->
<!-- 常用命令：npm run test:governance / npm run version:check / npm run test:version / npx tsc --noEmit / npm run build / cargo test --lib / node tests/qa/run-qa.mjs -->

执行级别：

- [ ] L0 离线分析（只读代码/文档、静态推理）
- [ ] L1 后台执行（单测、`tsc`、构建、静态 QA、治理脚本）
- [ ] L2 隔离执行（临时库/目录、独立端口与 profile，已登记并清理）
- [ ] L3 交互/宿主级执行（已获用户单独授权，并记录证据与清理）

证据状态（每条结论都要标注；未执行的测试不得记为 PASS）：

- [ ] VERIFIED（真实执行并查看结果）
- [ ] SIMULATED（仅模拟/桩）
- [ ] INFERRED（由代码或日志推断）
- [ ] UNKNOWN（未覆盖）
- [ ] BLOCKED（被环境阻塞，写明原因）

```text
实际执行的命令与结果、创建/占用的进程与端口、延期或阻塞的检查。
```

## 数据与隐私

- [ ] 不涉及书库、阅读进度、SQLite、备份、缓存或文件删除
- [ ] 不新增未脱敏的路径、书名、Cookie、Token、请求头或完整 URL 日志
- [ ] 不改变 `session_online_headers` 仅驻留内存的约束

## 发布影响

- [ ] 不需要版本 bump
- [ ] 需要版本 bump，已用 `npm run version:sync -- X.Y.Z` 同步
- [ ] 影响 Updater / 签名 / 安装器 / 公开更新通道（需单独发布审批）
- [ ] 涉及公开发布时，Release Notes 已按 `.github/RELEASE_NOTES_TEMPLATE.md` 写成双语

## 风险与回滚

<!-- 最坏情况、触发条件、如何停止或回滚、是否需要用户数据保护措施。 -->

## 提交前自检

- [ ] PR 只包含关联 Issue 的范围，未混入无关改动
- [ ] 未删除测试、未降低断言、未静默跳过失败检查
- [ ] 涉及 UI 时六语字典、双主题与相关 QA 已同步
- [ ] 涉及后端命令/数据结构时 `lib.rs` 与内部命令契约文档已同步
- [ ] 未推送 `v*` 发布标签（正式发布只走 candidate → Draft → 人工审批 → publish）
