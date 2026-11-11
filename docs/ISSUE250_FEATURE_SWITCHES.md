# Issue #250 · 大功能总开关与后端功能门卫

> 状态：设计确认（2026-11-08）。分支 `feat/250-feature-switches`。
> 关联：[Issue #250](https://github.com/D-OneXXX/Moyu/issues/250)
> 基线：`main` = `ff42dd6`。
> 本文是实施规格；实现计划见本轮 SDD scratch，不随产品文档提交。

## 1. 目标

让每个**可选大功能**都有独立、持久化、可即时生效的总开关；关闭时同时做到：

1. 前端入口隐藏或禁用；
2. 后端对应 IPC 命令拒绝执行，返回稳定码 `feature-disabled`；
3. 涉及监听/窗口/交接的功能在关闭时执行清理；
4. 刷新、重启、恢复备份后状态可预测。

书库、阅读器、设置三块核心能力不可关闭；安全模式、恢复窗、数据库修复优先级高于任何功能开关。

## 2. 已确认决策

1. **条漫默认开**：旧 `experimentalWebtoon` 字段从未真正接线；若直接按旧默认值
   `false` 生效，会让现有用户失去条漫。新总开关默认 `true`，保持当前实际体验。
2. **应用更新旁路已关闭**：官方 Updater 插件仍注册，但 WebView 不再持有
   `updater:default`。检查/安装只能经 `check_native_update` / `install_native_update`
   代理命令，二者先过 `FeatureId::Updates` 门卫；关闭时返回 `feature-disabled`，
   控制台直连 `plugin:updater|*` 也会被 ACL 拒绝。
3. **备份/诊断的恢复路径常开**：备份开关只关闭手动导出/导入；`get_db_health`、
   `recover_database_from_backup`、启动恢复门始终可用。诊断开关只关闭
   `diagnostics_export`；panic 记录、breadcrumb 与错误边界本地诊断保留。

## 3. 功能清单与默认值

| id | 中文名 | 默认 | 关闭后的主行为 |
|---|---|---:|---|
| `webtoon` | 条漫模式 | 开 | 阅读器不再提供条漫；按书条漫偏好回退；`get_webtoon_*` 拒绝 |
| `online` | 在线直读 | 关（保持现状） | 在线入口/导入/交接隐藏；在线命令拒绝；停止 handoff 并清理辅助会话 |
| `browser` | 内置浏览器 | 开 | 顶栏入口隐藏，`/browser` 重定向；`browser_*` 拒绝；已开窗关闭 |
| `pdf` | PDF 阅读 | 开 | 已有 PDF 书仍显示；打开显示关闭态；PDF 字节/封面写入命令拒绝 |
| `opds` | OPDS 远程书库 | 开 | 书库按钮与设置面板隐藏；`opds_*` 拒绝；配置保留 |
| `webAccess` | 局域网访问 | 开 | 面板隐藏；监听停止、配对取消、CA 分发停止；控制面命令拒绝（stop/status 除外） |
| `updates` | 应用更新 | 开 | 更新卡隐藏；`check_native_update` / `install_native_update` 返回 `feature-disabled`；WebView 无 updater 插件权限 |
| `backup` | 备份与恢复 | 开 | 手动导出/导入隐藏并拒绝；健康检查与启动恢复常开 |
| `diagnostics` | 诊断与问题反馈 | 开 | 支持面板隐藏并拒绝 `diagnostics_export`；崩溃诊断与 breadcrumb 常开 |

默认值选择原则：**不改变现有可用功能**。除在线直读外，全部默认开；在线直读保持实验性默认关。

## 4. 数据模型与持久化

### 4.1 Rust

新增 `src-tauri/src/features.rs`：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureId {
    Webtoon,
    Online,
    Browser,
    Pdf,
    Opds,
    WebAccess,
    Updates,
    Backup,
    Diagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FeatureFlags {
    pub webtoon: bool,
    pub online: bool,
    pub browser: bool,
    pub pdf: bool,
    pub opds: bool,
    pub web_access: bool,
    pub updates: bool,
    pub backup: bool,
    pub diagnostics: bool,
}
```

- `FeatureFlags::default()`：`webtoon=true`、`online=false`、其余 `true`。
- `FeatureId::ALL`、`FeatureId::key()`、`FeatureId::label_zh()`、
  `FeatureId::get(&FeatureFlags)`、`FeatureId::set(&mut FeatureFlags, bool)` 作为唯一映射。
- `Settings` 增加 `#[serde(default)] pub features: FeatureFlags`，删除
  `experimental_webtoon` / `experimental_online` 两个字段；`Settings::default()` 同步。

### 4.2 SQLite 键

| 功能 | 新键 | 兼容读取 |
|---|---|---|
| webtoon | `feature_webtoon` | 不读旧值（旧值不可信）；缺省为 `true` |
| online | `feature_online` | 缺省时回退 `experimental_online` |
| 其余 | `feature_browser`、`feature_pdf`、`feature_opds`、`feature_web_access`、`feature_updates`、`feature_backup`、`feature_diagnostics` | 缺省为 `true` |

- `hydrate_settings` 按上表读取；布尔只认 `"true"` / `"1"`。
- `settings_persist_pairs` 写入全部 9 个 `feature_*` 键；为升级/降级兼容，
  同时写 `experimental_webtoon` / `experimental_online` 的旧键（仅这两项）。
- 不需要 `PRAGMA user_version` 迁移；`settings` 是键值表。
- 备份白名单只增加 `feature_webtoon`（阅读偏好）；其余 8 项属于本机能力/安全姿态，
  不随 `.mrbackup` 迁移。恢复后保留本机值，避免备份重新打开已关闭的网络能力。

### 4.3 保存规则

- 新增命令 `set_feature_enabled(feature: FeatureId, enabled: bool) -> Settings`：
  - 只写该功能对应的键，不读写其他设置；
  - 关闭 `online`：停止 handoff、清空辅助会话、失效源句柄；
  - 关闭 `browser`：关闭标签为 `browser` 的窗口（不存在则忽略）；
  - 关闭 `webAccess`：`WebAccessRuntime::stop(StopReason::Stopped)` 后
    `CaDistributionRuntime::stop()`；
  - 返回更新后的完整 `Settings`，前端据此刷新镜像。
- `set_settings` 保留“整对象保存”语义，但**忽略传入的 `features`**，始终使用内存中的
  当前 `FeatureFlags`；功能开关只能经 `set_feature_enabled` 修改，避免旧表单覆盖。
- 前端切换开关即时保存，不依赖页面底部的“保存设置”。

## 5. 后端门卫

### 5.1 统一门卫

```rust
pub(crate) fn ensure_feature(state: &AppState, feature: FeatureId) -> Result<(), String> {
    if feature.get(&state.settings.lock().features) {
        Ok(())
    } else {
        Err(format!("{}已在设置中关闭（feature-disabled）", feature.label_zh()))
    }
}
```

- 新增稳定码 `feature-disabled`；六语字典新增 `error.featureDisabled`；
  `src/features/errors/localize.ts` 的 `STABLE_ERROR_CODES` 同步。
- 安全模式检查（`ensure_online_allowed`）保留在门卫之前或之后均可，但不得被功能开关绕过。

### 5.2 命令映射

| 功能 | 需要门卫的命令 |
|---|---|
| webtoon | `get_webtoon_layout`、`get_webtoon_tile` |
| online | 现有 `experimental_online` 检查点全部替换为 `ensure_feature(Online)`：`resolve_online_url`、`import_resolved_pages`、`resolve_online_batch`、`test_online_connection`、Telegram/filter/session 相关命令、`start_browser_handoff` 等 |
| browser | `open_browser_window`、`navigate_browser`、`list_browser_downloads`、`import_browser_download` |
| pdf | `get_pdf_chunk`、`put_pdf_thumbnail`；`get_thumbnail` 的 PDF 封面读取允许 |
| opds | `opds_get_config`、`opds_set_config`、`opds_test_connection`、`opds_browse`、`opds_cover`、`opds_download_entry` |
| webAccess | `web_access_start`、配对创建/批准/拒绝/取消、设备撤销、CA 分发 start/export；**`web_access_stop`、status/refresh 保持可用** |
| updates | `check_native_update` / `install_native_update` 在接触 updater 之前调用 `FeatureId::Updates` 门卫；`capabilities/updater.json` 权限为空，页面无法直连插件 |
| backup | `export_backup`、`import_backup`；`get_db_health`、`recover_database_from_backup`、`open_data_dir` 常开 |
| diagnostics | `diagnostics_export`；`diagnostics_collect`、`diagnostics_record_*`、panic hook 常开 |

- 返回 `BackendError` 的命令把字符串转为对应错误类型。
- 门卫必须在 `spawn_blocking`/await 之前执行，避免关闭后仍启动新任务。
- 已开始的长任务不强制取消；关闭只阻止新调用，文档标注。

### 5.3 新增命令

- `set_feature_enabled`：见 4.3。
- `assert_feature_enabled(feature: FeatureId) -> Result<(), String>`：只读门卫，
  供更新前端在调用官方插件前使用。
- 两命令在 `lib.rs` 注册，并写入 `docs/TECHNICAL.md` 命令契约。

## 6. 前端

### 6.1 注册表

新增 `src/features/features.ts`：

```ts
export type FeatureId =
  | "webtoon" | "online" | "browser" | "pdf" | "opds"
  | "webAccess" | "updates" | "backup" | "diagnostics";

export interface FeatureDefinition {
  id: FeatureId;
  settingKey: keyof Settings["features"];
  mirrorKey: string;          // mr-feature-*
  defaultEnabled: boolean;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [ ... ];
```

- 提供 `isFeatureEnabled(id)`、`useFeatureEnabled(id)`、`useFeatureFlags()`。
- `isFeatureEnabled` 读 `localStorage` 镜像；镜像缺失时回退注册表默认值
  （webtoon 开、online 关、其余开）。online/webtoon 兼容读取旧 `mr-exp-*`。
- 订阅现有 `mr-settings-changed` 事件；`setFeatureEnabled` 成功后更新镜像并广播。

### 6.2 设置镜像

- `src/lib/tauri.ts`：
  - `Settings` 类型改为 `features: { ... }`，删除 `experimentalWebtoon/Online`；
  - `applySettingsMirror` 写 9 个 `mr-feature-*`，并继续写 `mr-exp-wt` / `mr-exp-online`；
  - 新增 `api.setFeatureEnabled(feature, enabled)`；
  - `isWebtoonEnabled` / `isOnlineEnabled` 保留为薄包装，内部走注册表。
- `src/lib/storageSanitizer.ts`：登记 9 个 `mr-feature-*`（`flagRule`），保留旧键。
- 所有入口只读注册表，不再各自硬编码开关名。

### 6.3 设置页

- 设置页仍是 5 个 tab；在「常规与外观」顶部新增「功能开关」`SettingsSection`。
- 9 行 `SettingRow` + `Switch`，文案、默认值、字段全部由注册表驱动。
- 切换流程：禁用当前行 → `api.setFeatureEnabled` → 用返回的 `Settings` 更新表单/镜像 →
  toast `settings.toast.featureOn/Off`；失败回滚并 `localizeBackendError`。
- 移除在线源卡片里的“启用在线直读”开关，避免双主开关；该位置显示由功能开关控制的
  状态说明。OPDS 的“启用远程书库”和局域网“启动/停止”保留为二级控制。
- 依赖功能的面板按开关隐藏：
  - `OpdsPanel`（网络与在线源）
  - `WebAccessPanel`（隐私与安全）
  - `UpdatesPanel`、`SupportPanel`（关于与维护）
  - `DataBackupPanel`（存储与数据）
- 中央「功能开关」卡片始终可见，作为唯一重新开启入口。

### 6.4 入口

- `TopBar`：`browser` 关闭时隐藏“浏览器”导航项。
- `AppShell`：`/browser` 在关闭时 `<Navigate to="/" replace />`。
- `Library`：
  - `opds` 关闭时隐藏 OPDS 按钮/对话框入口；
  - `pdf` 关闭时“添加文件”对话框不再提供 `pdf` 扩展名；已有 PDF 书仍显示。
- `Reader`：
  - `webtoon` 关闭时 `webtoonAllowed=false`，模式循环、建议条、快捷键全部排除条漫；
    已存 `webtoon` 偏好回退到单页（若 `prefs.mode` 也是 webtoon 则用 `single`）。
  - PDF 书 + `pdf` 关闭：渲染“功能已关闭”面板（标题、说明、前往设置按钮），
    PDF 初始化 effect 直接跳过，不请求字节。
- 关闭 `browser` 时，若浏览器窗已打开，由后端 `set_feature_enabled` 关闭；前端同时刷新导航。

### 6.5 文案

- 新增 20 个左右六语键：`settings.features.*`（标题、说明、9×title/description）。
- 新增 `feature.disabled.title`、`feature.disabled.description`（含 `{feature}`）、
  `feature.disabled.openSettings`，用于 PDF 关闭态和后续通用关闭态。
- 新增 `error.featureDisabled`。
- 删除已无引用的 `settings.experimental.*` 和在线源内联启用键（若确认无其他引用）。

## 7. 安全与优先级

1. 安全模式仍优先：即使功能开关为开，网络能力在安全模式下照常禁用。
2. 恢复窗、数据库自检、`recover_database_from_backup` 不受 `backup` 开关影响。
3. `diagnostics_export` 关闭不影响崩溃记录、breadcrumb、错误边界本地诊断。
4. 关闭 `webAccess` 必须停止监听并清理会话；仅隐藏 UI 不算完成。
5. 关闭 `online` 必须停止 handoff 并清空辅助会话注册表；仅拒绝新命令不算完成。
6. 功能开关状态不写入日志详情；breadcrumb 只记录“settingsChange”。
7. 新开关不随备份迁移（`feature_webtoon` 除外），避免备份改写本机安全姿态。

## 8. 测试与验收

### 8.1 Rust

- `FeatureFlags::default` 与 `FeatureId::ALL` 映射。
- `hydrate_settings`：新键、缺省、online 旧键回退、webtoon 忽略旧值。
- `settings_persist_pairs` 覆盖全部 9 个键。
- `ensure_feature` 对开启/关闭返回正确结果与 `feature-disabled` 文案。
- `set_feature` 纯函数（便于无 Tauri State 测试）更新单个标志。
- 现有 backup 测试保持通过（旧键仍持久化）。

### 8.2 前端 / 静态

- `npx tsc --noEmit`。
- `npm run build`。
- `node tests/qa/run-qa.mjs --suite=static`：i18n parity、storage whitelist、
  post-i18n hardcode 全绿。
- 新增 `tests/features.test.mjs`：
  - 注册表 id 唯一、Rust `FeatureId` 一一对应；
  - 每个 `mirrorKey` 在 `KNOWN_STORAGE_KEYS`；
  - 每个 title/description key 在 `settings.ts` 六语块各出现一次；
  - 默认值与规格表一致。
- 纳入 `test:governance` 命令列表。

### 8.3 门禁

- `cargo test --lib`（串行，单独窗口）。
- `cargo check --all-targets`。
- `npx tsc --noEmit`、`npm run build`。
- `static` QA、`test:governance`、`test:version`、`format:check`。
- L3 `architecture` / `visual` 套件需用户单独授权；本轮不执行，报告中标 UNKNOWN。

### 8.4 人工/后续

- 关闭每项后刷新验证入口仍隐藏；重新开启后恢复。
- 局域网关闭后监听端口释放（需 L3 或既有运行时测试）。
- 更新插件例外写入文档并在验收中标注。

## 9. 文档

- `docs/TECHNICAL.md`：
  - Settings 字段与 9 个 `feature_*` 键；
  - `set_feature_enabled` / `assert_feature_enabled` 命令契约；
  - 门卫表与三个例外（更新插件、恢复路径、诊断崩溃路径）；
  - 备份不迁移策略。
- `docs/TESTING.md`：`test:features`、static/governance 覆盖、L3 待授权项。
- `AGENTS.md`：新增「功能总开关不变量」小节（可选但本规格建议固化）：
  - 可选大功能必须有独立总开关；
  - 关闭 = 入口 + 后端双层；
  - 核心与恢复路径不可关闭；
  - 清单/默认值以 `features.ts` + `features.rs` 为准。
- 不修改 `docs/superpowers/` 下的既有 scratch。

## 10. 不在范围

- 不把书库、阅读器、设置改为可关闭。
- 不新增第 6 个设置 tab。
- 不改在线直读默认值（保持关）。
- 不改官方 Updater 通道或发布流程。
- 不做 L3 可见 GUI 自动化、不移动真实光标/抢焦点。
- 不引入新依赖。

## 11. 验收清单

- [ ] 9 项功能均有持久化总开关，默认值与第 3 节一致
- [ ] 关闭后入口消失/禁用，刷新与重启保持
- [ ] 相关后端命令返回 `feature-disabled`（已知例外除外）
- [ ] 关闭 online/webAccess/browser 执行对应清理
- [ ] 核心与恢复路径不受开关影响
- [ ] 六语、localize、storage whitelist 同步
- [ ] Rust/前端/静态/治理门禁通过
- [ ] TECHNICAL/TESTING/AGENTS 更新
- [ ] L3 未执行项在证据中标记 UNKNOWN/BLOCKED
