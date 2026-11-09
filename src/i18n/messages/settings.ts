/**
 * Settings page and settings section strings.
 * Owned by the settings conversion. All six objects must stay in sync.
 */
const zhCN = {
  "settings.features.title": "功能开关",
  "settings.features.description":
    "每项功能可独立开启或关闭；关闭后入口隐藏，后端调用会被拒绝。更改立即生效。",
  "settings.features.browser.description":
    "用于站点验证与下载导入的辅助浏览器。关闭后顶栏入口隐藏。",
  "settings.features.pdf.title": "PDF 阅读",
  "settings.features.pdf.description":
    "本地 PDF 的读取与渲染。关闭后已有 PDF 仍保留，打开时会提示功能已关闭。",
  "settings.page.eyebrow": "偏好设置",
  "settings.page.description": "外观、在线源、阅读统计与缓存都在这台设备上管理。",
  "settings.page.localFirst": "本地优先",
  "settings.page.loading": "正在加载设置",

  "settings.tabs.label": "设置分区",
  "settings.tabs.general": "常规与外观",
  "settings.tabs.online": "在线源",
  "settings.tabs.reading": "统计",
  "settings.tabs.cache": "缓存",
  "settings.tabs.network": "网络与在线源",
  "settings.tabs.storage": "存储与数据",
  "settings.tabs.privacy": "隐私与安全",
  "settings.tabs.about": "关于与维护",

  "settings.shortcuts.title": "全局快捷键",
  "settings.shortcuts.description":
    "输入框聚焦或输入法组合中（isComposing / keyCode 229）时，除 Ctrl/Cmd+W 外，全局快捷键一律不触发。",
  "settings.shortcuts.note":
    "需要使用快捷键时请先离开输入框；Ctrl/Cmd+W（关闭窗口）是唯一例外。",
  "settings.shortcuts.command": "Ctrl/Cmd+K 打开命令中心",

  "settings.language.title": "界面语言",
  "settings.language.description":
    "选择界面语言；切换会立即生效并保存在本机，无需保存设置。",
  "settings.language.label": "显示语言",

  "settings.theme.title": "外观主题",
  "settings.tray.title": "窗口与托盘",
  "settings.tray.description":
    "局域网阅读运行时可关闭主窗口到系统托盘，后台继续提供阅读服务。",
  "settings.tray.closeToTray": "关闭主窗口时最小化到托盘",
  "settings.tray.closeToTrayHint":
    "开启后，点击关闭（×）只隐藏窗口；从托盘菜单可彻底退出。",
  "settings.theme.description":
    "选择界面配色；切换会立即生效，并同步到本地偏好与数据库。",
  "settings.theme.groupLabel": "主题模式",
  "settings.theme.systemHint": "随系统深浅色切换",
  "settings.theme.lightHint": "冰蓝画布",
  "settings.theme.darkHint": "深夜座舱",
  "settings.theme.systemNote":
    "「跟随系统」会随操作系统的深浅色自动切换。",


  "settings.experimental.webtoonTitle": "条漫模式",
  "settings.experimental.webtoonDescription":
    "韩漫长条纵向连续滚动，在单页 / 双页之外提供第三版式。",

  "settings.toast.featureOn": "{feature}已开启",
  "settings.toast.featureOff": "{feature}已关闭",

  "settings.library.title": "书库目录",
  "settings.library.description":
    "指定漫画所在目录；扫描会把新书加入本机书库。",
  "settings.library.dirLabel": "扫描目录",
  "settings.library.dirPlaceholder": "D:\\Manga 或 /path/to/manga",
  "settings.library.pick": "选择",
  "settings.library.pickTitle": "选择漫画目录",
  "settings.library.clearDir": "清空目录",
  "settings.library.scanning": "扫描中…",
  "settings.library.scanNow": "立即扫描",
  "settings.library.scanHint":
    "扫描使用上方目录，无需先保存；结果会以提示显示。",

  "settings.about.title": "关于",
  "settings.about.description": "Moyu 是一款免费的桌面漫画阅读与书库管理软件。",
  "settings.about.version": "版本",
  "settings.about.commit": "构建提交",
  "settings.about.storage": "设置存储",
  "settings.about.storageValue": "本机 SQLite",
  "settings.about.dataFlow": "数据去向",
  "settings.about.dataFlowValue": "不离开设备",
  "settings.about.note":
    "设置与阅读记录保存在本机；扫描、在线请求与阅读都不会上传个人数据。",

  "settings.online.urlTitle": "在线 URL 直读",
  "settings.online.urlDescription":
    "支持 JSON 清单与单页 HTML 图集；关闭时书库与浏览器会提示先开启。",
  "settings.online.enableTitle": "启用在线源",
  "settings.online.enableDescription":
    "允许从在线清单 / 图集导入并阅读，导入的章节会进入本机书库。",
  "settings.online.enableNote":
    "切换会立即持久化；下方网络参数需点击底部「保存设置」后生效。",
  "settings.online.networkTitle": "网络与请求",
  "settings.online.networkDescription":
    "代理、并发与请求头会随在线请求发送；请只填写你信任的源或网关。",
  "settings.online.proxyLabel": "代理地址",
  "settings.online.proxyPlaceholder":
    "留空直连，或 http://127.0.0.1:7890",
  "settings.online.detectProxy": "系统代理",
  "settings.online.detectProxyTitle":
    "读取 Windows 系统代理并填入代理地址，不会自动保存",
  "settings.online.detecting": "检测中…",
  "settings.online.proxyHint": "支持 http / https / socks5；留空为直连。",
  "settings.online.concurrencyLabel": "页面并发",
  "settings.online.concurrencyPlaceholder": "选择并发数",
  "settings.online.concurrencyItem": "{count} 并发",
  "settings.online.concurrencyHint":
    "1–8；并发越高越快，也更容易被源限流。",
  "settings.online.headersLabel": "自定义请求头",
  "settings.online.sessionActive": "会话凭据生效中",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} 或 session=...; token=...',
  "settings.online.headersHint":
    "请求头以明文保存在本机设置中，并会随请求发送到你配置的源或网关。",
  "settings.online.storageMode": "存储模式",
  "settings.online.storageModeDescription":
    "会话模式不写入数据库，退出应用即清除。",
  "settings.online.storageModeGroup": "请求头存储模式",
  "settings.online.memoryOnly": "仅驻留内存",
  "settings.online.persistLocal": "持久化到本地库",
  "settings.online.sessionPresent": "当前有请求头保存在进程内存中。",
  "settings.online.sessionAbsent": "当前没有会话请求头。",
  "settings.online.clearSession": "清空内存凭据",
  "settings.online.storageModeNote":
    "会话请求头只驻留内存，且只对首次请求的站点生效；切换站点后需重新填写。",
  "settings.online.testTitle": "连通性测试",
  "settings.online.testDescription":
    "解析目标清单或图集，只做探测，不写入书库。",
  "settings.online.testUrlAria": "在线清单或图集测试 URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "测试中…",
  "settings.online.testConnection": "测试连接",
  "settings.online.reachable": "可连接",
  "settings.online.testSummary": "{title} · {pages} 页 · {ms} ms",
  "settings.online.testHint":
    "测试使用已保存的代理与请求头；修改后请先保存设置。",

  "settings.stats.loadError": "阅读统计加载失败：{detail}",
  "settings.stats.loading": "正在汇总本机阅读记录…",
  "settings.stats.totalBooks": "总藏书",
  "settings.stats.reading": "在读",
  "settings.stats.todayPages": "今日阅读",
  "settings.stats.last7Pages": "近 7 天",
  "settings.stats.unitBooks": "本",
  "settings.stats.note":
    "只统计本机阅读记录中实际翻过的页面；未打开的书与未记录进度不计入。",
  "settings.stats.title": "书库与阅读统计",
  "settings.stats.description":
    "本机阅读记录总览；书库目录与扫描也统一收在这里。",

  "settings.cache.budgetTitle": "内存缓存预算",
  "settings.cache.budgetDescription":
    "内存预算越高，翻页越顺滑，但进程内存占用也越高。",
  "settings.cache.budgetLabel": "内存缓存预算",
  "settings.cache.budgetAria": "内存缓存预算（MB）",
  "settings.cache.budgetHint": "保存后立即套用到页面与缩略图的内存缓存。",
  "settings.cache.diskTitle": "磁盘缓存",
  "settings.cache.diskDescription":
    "渲染结果与在线原图共用同一份磁盘缓存，超出上限时会自动清理较旧的文件。",
  "settings.cache.diskLabel": "磁盘缓存上限",
  "settings.cache.diskAria": "磁盘缓存上限（MB）",
  "settings.cache.diskHint":
    "保存后立即套用；降低上限后，超出部分会在后续访问时清理。",
  "settings.cache.diskUsage": "磁盘占用",
  "settings.cache.diskRender": "渲染缓存",
  "settings.cache.diskOnline": "在线原图",
  "settings.cache.diskEmpty": "暂无磁盘缓存统计。",
  "settings.cache.memoryTitle": "内存使用",
  "settings.cache.memoryDescription": "本次运行的内存与缓存快照。",
  "settings.cache.budgetUsage": "内存预算使用",
  "settings.cache.process": "进程占用",
  "settings.cache.imageCache": "图片缓存",
  "settings.cache.cachedPages": "缓存页面",
  "settings.cache.cachedThumbs": "封面缩略图",
  "settings.cache.webtoonCache": "条漫缓存",
  "settings.cache.limit": "内存上限",
  "settings.cache.empty": "暂无内存统计。",
  "settings.cache.pagesValue": "{count} 页",
  "settings.cache.thumbsValue": "{count} 张",
  "settings.cache.webtoonValue": "{size} · {count} 片",
  "settings.cache.maintenanceTitle": "缓存维护",
  "settings.cache.maintenanceDescription":
    "清理后按需重建，不影响书库与阅读进度。",
  "settings.cache.clearThumbs": "清除封面缓存",
  "settings.cache.clearing": "清除中…",
  "settings.cache.clearPages": "清空页面缓存",
  "settings.cache.purging": "清理中…",
  "settings.cache.clearHint":
    "封面缓存清空后，重新进入书库会自动生成。",
  "settings.cache.clearTemp": "一键清空临时缓存",
  "settings.cache.clearingTemp": "正在清空…",
  "settings.cache.clearTempHint":
    "清除内存页缓存、渲染成品与在线原图；封面会按需重建，书库和阅读进度不受影响。",
  "settings.cache.manageTitle": "缓存管理与 LRU 配额",
  "settings.cache.manageDescription":
    "渲染缓存与在线图片缓存共用同一份 LRU 软上限（500 MB – 10 GB）；一键清空临时缓存。",
  "settings.online.proxyMode.system": "跟随系统代理",
  "settings.online.proxyMode.manual": "手动代理",
  "settings.online.proxyMode.direct": "直连",
  "settings.online.browserHint":
    "解析漫画网址或 Telegram 频道请前往「浏览器」页，在顶部唯一的地址栏输入即可。",

  "settings.status.loading": "正在加载设置…",
  "settings.status.loadFailed": "设置未加载",
  "settings.status.saving": "正在保存设置…",
  "settings.status.dirty": "有未保存的更改",
  "settings.status.saved": "所有更改已保存",
  "settings.status.saveHint": "保存后写入本机设置",
  "settings.saveButton": "保存设置",

  "settings.errors.loadSettings": "读取设置失败",
  "settings.errors.loadStats": "统计读取失败",
  "settings.errors.connectTest": "连接测试失败",
  "settings.errors.loadSettingsDetail": "设置加载失败：{detail}",

  "settings.toast.scanDone": "扫描完成，书库共 {count} 本",
  "settings.toast.scanErrors": "有 {count} 个条目无法读取，已跳过",
  "settings.toast.proxyFilled": "已填入系统代理并保存",
  "settings.toast.proxyNotFound": "未检测到开启的系统代理",
  "settings.toast.sessionCleared": "已清空内存凭据",
  "settings.toast.urlRequired": "请填写清单或图集 URL",
  "settings.toast.noReadablePages": "清单没有可读页面",
  "settings.toast.thumbsCleared":
    "已清除 {count} 个封面缓存，重新进入书库将自动重建",
  "settings.toast.pagesCleared": "页面缓存已清空",
  "settings.toast.tempCleared": "已清空临时缓存，释放 {size}",
  "settings.toast.saved": "设置已保存",

  "settings.backup.title": "本地备份与恢复",
  "settings.backup.description":
    "把书库索引、阅读进度与偏好打包成单个备份文件；恢复前请先导出当前数据。",
  "settings.backup.export": "导出本地备份 (.mrbackup / .zip)",
  "settings.backup.exporting": "正在导出…",
  "settings.backup.restore": "从备份恢复",
  "settings.backup.restoring": "正在恢复…",
  "settings.backup.saveTitle": "选择备份保存位置",
  "settings.backup.pickTitle": "选择备份文件",
  "settings.backup.filterName": "Moyu 备份",
  "settings.backup.note":
    "备份包含书库索引、阅读进度、阅读统计、主题/语言/阅读器偏好与自学习过滤规则；不包含图片缓存、会话请求头、Cookie、过滤事件与内部版本标记。恢复会覆盖当前书库与阅读进度，建议先导出当前数据。",
  "settings.backup.confirmTitle": "从备份恢复？",
  "settings.backup.confirmMessage":
    "这会覆盖当前书库、阅读进度与偏好设置，且无法撤销。备份文件：{file}",
  "settings.backup.confirmRestore": "从备份恢复",
  "settings.backup.exported": "已导出备份：{books} 本 · {size}",
  "settings.backup.restored": "已从备份恢复：{books} 本 · {days} 天阅读记录",
  "settings.backup.applied": "已应用备份中的主题、语言与阅读器偏好",
  "settings.backup.error": "备份操作失败，请重试",
  "settings.about.buildOrigin": "构建来源",
  "settings.about.buildOriginLabel": "构建来源指纹（Build Origin）",
  "settings.about.buildOriginOfficial": "Official Release",
  "settings.about.buildOriginCommunity": "Community Modified Build (Non-Commercial)",
  "settings.about.nonCommercial": "非商业授权 (Non-Commercial Only)",
  "settings.backup.skippedTitle": "以下本地书未恢复",
  "settings.backup.skippedHint":
    "源路径不存在、不是可读漫画，或命中系统/用户敏感目录。记录未写入书库，磁盘内容未被删除。",
  "settings.backup.skippedReasonMissing": "路径不存在或不可用",
  "settings.backup.skippedReasonNotBook": "不是可读的漫画目录/压缩包",
  "settings.backup.skippedReasonUnsafe": "命中系统或用户敏感目录",
  "settings.backup.skippedCount": "有 {count} 本本地书未恢复",
  "settings.backup.skipWarningTitle": "恢复会移除部分进度",
  "settings.backup.skipWarningMessage":
    "备份中有 {count} 本本地书当前无法访问（外置盘或网络位置未挂载）。继续恢复会删除它们在当前书库中的阅读进度与历史。恢复前会自动保存当前书库的快照。",
  "settings.backup.forwardSchema": "备份来自更高版本（{version}）：已按兼容模式恢复核心书库与进度，高版本新增配置项被忽略",
  "settings.ca.title": "根 CA 与设备信任",
  "settings.ca.description":
    "初始化、导出根证书，并在短时内通过明文 HTTP 分发给手机安装；用于让设备信任本机的 HTTPS 服务。",
  "settings.ca.badgeNotInitialized": "CA 未初始化",
  "settings.ca.badgeInitialized": "CA 已初始化",
  "settings.ca.notInitialized":
    "本地 CA 尚未初始化。初始化会创建新的根证书；请只在你控制的设备上安装，并妥善备份 CA。",
  "settings.ca.initialize": "初始化本地 CA",
  "settings.ca.initializeConfirmTitle": "初始化本地根 CA？",
  "settings.ca.initializeConfirmMessage":
    "这会创建新的本地根 CA。丢失 CA 后，所有已安装设备都需要重新安装信任证书；初始化过程不会上传任何数据。",
  "settings.ca.initialized": "本地 CA 已初始化并通过私钥 ACL 校验。",
  "settings.ca.fingerprint": "根证书 SHA-256 指纹",
  "settings.ca.fingerprintHint":
    "在手机上安装证书前，核对完整 SHA-256 指纹：共 64 个十六进制字符，忽略冒号与大小写。",
  "settings.ca.verifyOnPhone":
    "重要：手机安装页可能显示 SHA-1 或 SHA-256；必须切到 SHA-256 并与上方逐段核对。不一致就不要安装。",
  "settings.ca.copyFingerprint": "复制指纹",
  "settings.ca.copied": "已复制",
  "settings.ca.copyFailed": "复制失败，请手动选择文本复制。",
  "settings.ca.expires": "根证书到期：{date}（剩余 {days} 天）",
  "settings.ca.rotationWarning":
    "根证书将在 {days} 天后进入轮换窗口；轮换后需要向所有设备重新分发并安装。",
  "settings.ca.intermediateFingerprint": "中间 CA 指纹（诊断）",
  "settings.ca.export": "导出根证书",
  "settings.ca.exportTitle": "保存根证书",
  "settings.ca.exported": "根证书已导出；安装前请核对指纹。",
  "settings.ca.exportFailed": "导出根证书失败，请重试。",
  "settings.ca.loadError": "无法加载 CA 状态：{detail}",
  "settings.ca.distribution.title": "短时分发服务",
  "settings.ca.distribution.description":
    "显式启动后，仅提供根证书下载；服务使用明文 HTTP（手机在信任 CA 前无法验证 HTTPS），120 秒后自动关闭。",
  "settings.ca.distribution.address": "分发地址",
  "settings.ca.distribution.start": "启动分发",
  "settings.ca.distribution.stop": "停止分发",
  "settings.ca.distribution.running": "运行中",
  "settings.ca.distribution.stopped": "已停止",
  "settings.ca.distribution.url": "下载地址",
  "settings.ca.distribution.expiresIn": "剩余 {seconds} 秒",
  "settings.ca.distribution.expired": "分发服务已到期并自动关闭。",
  "settings.ca.distribution.securityNote":
    "只分发公开根证书；请只在可信局域网内使用。分发地址是明文 HTTP，不要向不可信网络暴露。",
  "settings.ca.distribution.noAddress":
    "未找到可用的私有局域网 IPv4 地址，无法启动分发。",
  "settings.ca.privateKeyNote":
    "CA 私钥只保存在本机 CA 目录中；HTTP 分发任务没有读取私钥的能力。",

  "settings.webAccess.unknownDevice": "未知设备",
  "settings.webAccess.networkHint":
    "如果 Windows 防火墙阻止连接，请允许本程序在专用网络入站。仅 HTTPS 模式需要设备信任本地证书。",
  "settings.webAccess.title": "局域网阅读",
  "settings.webAccess.description":
    "手机扫码或输入网址，在电脑上批准后即可阅读。服务默认关闭。",
  "settings.webAccess.statusTitle": "服务状态",
  "settings.webAccess.refresh": "刷新状态",
  "settings.webAccess.loadError": "无法加载 Web Access 状态：{detail}",
  "settings.webAccess.phase.disabled": "已关闭",
  "settings.webAccess.phase.starting": "正在启动",
  "settings.webAccess.phase.enabled": "运行中",
  "settings.webAccess.phase.stopping": "正在停止",
  "settings.webAccess.phase.error": "错误",
  "settings.webAccess.caRequired":
    "HTTPS 模式需要先在「根 CA 与设备信任」中初始化本地 CA。",
  "settings.webAccess.safeModeBlocked":
    "安全模式处于启用状态。Web Access 已被停止，退出安全模式前无法重新启动。",
  "settings.webAccess.address": "监听地址",
  "settings.webAccess.noAddress": "未找到可用的私有局域网 IPv4 地址",
  "settings.webAccess.bindAddress": "绑定地址",
  "settings.webAccess.port": "实际端口",
  "settings.webAccess.deviceCount": "已配对设备：{count}",
  "settings.webAccess.pendingCount": "待批准请求：{count}",
  "settings.webAccess.notRunning": "服务未运行；启动后可生成配对二维码。",
  "settings.webAccess.start": "启动服务",
  "settings.webAccess.httpWarning": "局域网 HTTP 不加密；同一网络中的设备可能读取或篡改内容和会话。请仅在可信网络使用。",
  "settings.webAccess.startSecure": "高级：使用 HTTPS",
  "settings.webAccess.plainPairHint": "手机扫码或输入网址后，在此批准设备。无需安装证书。",
  "settings.webAccess.starting": "正在启动",
  "settings.webAccess.stop": "停止服务",
  "settings.webAccess.stopping": "正在停止",
  "settings.webAccess.stopConfirmTitle": "停止 Web Access？",
  "settings.webAccess.stopConfirmMessage":
    "停止会立即断开所有已配对设备、取消当前配对窗口，并关闭监听端口。需要时可以从本面板重新启动。",
  "settings.webAccess.stopReasonTitle": "停止原因",
  "settings.webAccess.stopReason.stopped": "用户手动停止",
  "settings.webAccess.stopReason.safeMode": "进入安全模式后停止",
  "settings.webAccess.stopReason.recovery": "崩溃恢复时停止",
  "settings.webAccess.stopReason.exit": "应用退出时停止",
  "settings.webAccess.lastError": "最近错误：{detail}",
  "settings.webAccess.rootFingerprint": "根证书 SHA-256 指纹",
  "settings.webAccess.leafFingerprint": "叶证书 SHA-256 指纹",
  "settings.webAccess.leafExpires": "叶证书到期：{date}",
  "settings.webAccess.copyFingerprint": "复制指纹",
  "settings.webAccess.pairingTitle": "设备配对",
  "settings.webAccess.pairingDescription":
    "点击开始后会生成一个 120 秒有效的配对窗口；手机扫描二维码或打开链接后，需要在本面板逐条确认。",
  "settings.webAccess.pairingStart": "开始配对",
  "settings.webAccess.pairingCancel": "取消配对",
  "settings.webAccess.pairingCountdown": "剩余 {seconds} 秒",
  "settings.webAccess.pairingExpired": "配对窗口已过期，请重新开始配对。",
  "settings.webAccess.qrAlt": "Web Access 配对二维码",
  "settings.webAccess.qrHint":
    "二维码只包含本次配对链接；请用手机相机扫描，不要截图分享。",
  "settings.webAccess.copyUrl": "复制链接",
  "settings.webAccess.copied": "已复制",
  "settings.webAccess.copyFailed": "复制失败，请手动选择文本复制。",
  "settings.webAccess.claimsTitle": "待批准请求",
  "settings.webAccess.claimsEmpty": "当前没有待批准的配对请求。",
  "settings.webAccess.claimCount": "待批准 {count} 条",
  "settings.webAccess.unverifiedDevice": "名称未经核实",
  "settings.webAccess.sourceIp": "来源 IP（服务端观测）",
  "settings.webAccess.receivedAt": "收到时间：{time}",
  "settings.webAccess.claimExpiresIn": "请求剩余 {seconds} 秒",
  "settings.webAccess.claimExpired": "请求已过期",
  "settings.webAccess.cancelRequest": "取消请求",
  "settings.webAccess.approve": "批准",
  "settings.webAccess.deny": "拒绝",
  "settings.webAccess.approveConfirmTitle": "批准这台设备？",
  "settings.webAccess.approveConfirmMessage":
    "即将授权「{name}」连接本机，并可浏览和读取这台桌面设备上的整个书库与阅读进度。设备名由手机自行上报，无法证明对方身份；只有你本人发起了这次配对时才应批准。",
  "settings.webAccess.approvePlainHttpWarning":
    "当前使用未加密的 HTTP；同一局域网内的设备都可连接服务。请只在可信网络中批准你信任的设备。",
  "settings.webAccess.cancelStart": "取消启动",
  "settings.webAccess.cancelingStart": "正在取消…",
  "settings.webAccess.devicesTitle": "已配对设备",
  "settings.webAccess.devicesEmpty": "还没有已配对设备。设备完成配对批准并打开阅读页后会自动出现在这里。",
  "settings.webAccess.deviceIp": "局域网地址：{ip}",
  "settings.webAccess.deviceLastActive": "最近活跃：{date}",
  "settings.webAccess.devicesMemoryNote":
    "会话只保存在内存中：停止局域网服务或退出程序后，所有设备会自动断开并清空。",
  "settings.webAccess.deviceIssued": "签发：{date}",
  "settings.webAccess.deviceExpires": "到期：{date}",
  "settings.webAccess.revoke": "撤销",
  "settings.webAccess.revokeConfirmTitle": "撤销这台设备？",
  "settings.webAccess.revokeConfirmMessage":
    "撤销「{name}」会立即断开它的访问，之后必须重新完成配对。",
  "settings.webAccess.securityNote":
    "设备名由手机自行上报，可能被修改；本项目没有 SAS 或密码学绑定，桌面端的人工批准是唯一授权。请不要因为设备出现在列表里就认为它已通过验证。",

  "settings.autoSaved": "已自动保存",
  "settings.autoSaving": "正在保存…",
  "settings.autoSaveFailed": "保存失败",
  "settings.filter.blockedShort": "已拦截 {count} 项",
} as const;

type SettingsMessages = { [K in keyof typeof zhCN]: string };

const zhTW: SettingsMessages = {
  "settings.features.title": "功能開關",
  "settings.features.description":
    "每項功能可獨立開啟或關閉；關閉後入口隱藏，後端呼叫會被拒絕。變更立即生效。",
  "settings.features.browser.description":
    "用於站點驗證與下載匯入的輔助瀏覽器。關閉後頂欄入口隱藏。",
  "settings.features.pdf.title": "PDF 閱讀",
  "settings.features.pdf.description":
    "本機 PDF 的讀取與渲染。關閉後既有 PDF 仍保留，開啟時會提示功能已關閉。",
  "settings.page.eyebrow": "偏好設定",
  "settings.page.description":
    "外觀、線上來源、閱讀統計與快取都在這台裝置上管理。",
  "settings.page.localFirst": "本機優先",
  "settings.page.loading": "正在載入設定",

  "settings.tabs.label": "設定分區",
  "settings.tabs.general": "一般與外觀",
  "settings.tabs.online": "線上來源",
  "settings.tabs.reading": "統計",
  "settings.tabs.cache": "快取",
  "settings.tabs.network": "網路與線上來源",
  "settings.tabs.storage": "儲存與資料",
  "settings.tabs.privacy": "隱私與安全",
  "settings.tabs.about": "關於與維護",

  "settings.shortcuts.title": "全域快速鍵",
  "settings.shortcuts.description":
    "輸入框聚焦或輸入法組字中（isComposing / keyCode 229）時，除 Ctrl/Cmd+W 外，全域快速鍵一律不觸發。",
  "settings.shortcuts.note":
    "需要使用快速鍵時請先離開輸入框；Ctrl/Cmd+W（關閉視窗）是唯一例外。",
  "settings.shortcuts.command": "Ctrl/Cmd+K 開啟命令中心",

  "settings.language.title": "介面語言",
  "settings.language.description":
    "選擇介面語言；切換會立即生效並儲存在本機，無需儲存設定。",
  "settings.language.label": "顯示語言",

  "settings.theme.title": "外觀主題",
  "settings.tray.title": "視窗與系統匣",
  "settings.tray.description":
    "區域網路閱讀執行時可將主視窗關閉至系統匣，背景繼續提供閱讀服務。",
  "settings.tray.closeToTray": "關閉主視窗時最小化到系統匣",
  "settings.tray.closeToTrayHint":
    "開啟後，點擊關閉（×）只會隱藏視窗；可從系統匣選單徹底結束。",
  "settings.theme.description":
    "選擇介面配色；切換會立即生效，並同步到本機偏好與資料庫。",
  "settings.theme.groupLabel": "主題模式",
  "settings.theme.systemHint": "跟隨系統深淺色切換",
  "settings.theme.lightHint": "冰藍畫布",
  "settings.theme.darkHint": "深夜座艙",
  "settings.theme.systemNote":
    "「跟隨系統」會隨作業系統的深淺色自動切換。",


  "settings.experimental.webtoonTitle": "條漫模式",
  "settings.experimental.webtoonDescription":
    "韓漫長條縱向連續捲動，在單頁 / 雙頁之外提供第三種版面。",

  "settings.toast.featureOn": "{feature}已開啟",
  "settings.toast.featureOff": "{feature}已關閉",

  "settings.library.title": "書庫目錄",
  "settings.library.description":
    "指定漫畫所在目錄；掃描會把新書加入本機書庫。",
  "settings.library.dirLabel": "掃描目錄",
  "settings.library.dirPlaceholder": "D:\\Manga 或 /path/to/manga",
  "settings.library.pick": "選擇",
  "settings.library.pickTitle": "選擇漫畫目錄",
  "settings.library.clearDir": "清空目錄",
  "settings.library.scanning": "掃描中…",
  "settings.library.scanNow": "立即掃描",
  "settings.library.scanHint":
    "掃描使用上方目錄，無需先儲存；結果會以提示顯示。",

  "settings.about.title": "關於",
  "settings.about.description":
    "Moyu 是一款免費的桌面漫畫閱讀與書庫管理軟體。",
  "settings.about.version": "版本",
  "settings.about.commit": "建置提交",
  "settings.about.storage": "設定儲存",
  "settings.about.storageValue": "本機 SQLite",
  "settings.about.dataFlow": "資料去向",
  "settings.about.dataFlowValue": "不離開裝置",
  "settings.about.note":
    "設定與閱讀記錄保存在本機；掃描、線上請求與閱讀都不會上傳個人資料。",

  "settings.online.urlTitle": "線上 URL 直讀",
  "settings.online.urlDescription":
    "支援 JSON 清單與單頁 HTML 圖集；關閉時書庫與瀏覽器會提示先開啟。",
  "settings.online.enableTitle": "啟用線上來源",
  "settings.online.enableDescription":
    "允許從線上清單 / 圖集匯入並閱讀，匯入的章節會進入本機書庫。",
  "settings.online.enableNote":
    "切換會立即保存；下方網路參數需點擊底部「儲存設定」後生效。",
  "settings.online.networkTitle": "網路與請求",
  "settings.online.networkDescription":
    "代理、並行與請求標頭會隨線上請求傳送；請只填寫你信任的來源或閘道。",
  "settings.online.proxyLabel": "代理位址",
  "settings.online.proxyPlaceholder":
    "留空直連，或 http://127.0.0.1:7890",
  "settings.online.detectProxy": "系統代理",
  "settings.online.detectProxyTitle":
    "讀取 Windows 系統代理並填入代理位址，不會自動儲存",
  "settings.online.detecting": "偵測中…",
  "settings.online.proxyHint": "支援 http / https / socks5；留空為直連。",
  "settings.online.concurrencyLabel": "頁面並行",
  "settings.online.concurrencyPlaceholder": "選擇並行數",
  "settings.online.concurrencyItem": "{count} 並行",
  "settings.online.concurrencyHint":
    "1–8；並行越高越快，也更容易被來源限流。",
  "settings.online.headersLabel": "自訂請求標頭",
  "settings.online.sessionActive": "工作階段憑證生效中",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} 或 session=...; token=...',
  "settings.online.headersHint":
    "請求標頭以明文保存在本機設定中，並會隨請求傳送到你設定的來源或閘道。",
  "settings.online.storageMode": "儲存模式",
  "settings.online.storageModeDescription":
    "工作階段模式不寫入資料庫，結束應用程式即清除。",
  "settings.online.storageModeGroup": "請求標頭儲存模式",
  "settings.online.memoryOnly": "僅駐留記憶體",
  "settings.online.persistLocal": "持久化到本機資料庫",
  "settings.online.sessionPresent":
    "目前有請求標頭保存在處理程序記憶體中。",
  "settings.online.sessionAbsent": "目前沒有工作階段請求標頭。",
  "settings.online.clearSession": "清空記憶體憑證",
  "settings.online.storageModeNote":
    "工作階段請求標頭僅駐留記憶體，且只對首次請求的站點生效；切換站點後需重新填寫。",
  "settings.online.testTitle": "連線測試",
  "settings.online.testDescription":
    "解析目標清單或圖集，只做探測，不寫入書庫。",
  "settings.online.testUrlAria": "線上清單或圖集測試 URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "測試中…",
  "settings.online.testConnection": "測試連線",
  "settings.online.reachable": "可連線",
  "settings.online.testSummary": "{title} · {pages} 頁 · {ms} ms",
  "settings.online.testHint":
    "測試使用已儲存的代理與請求標頭；修改後請先儲存設定。",

  "settings.stats.loadError": "閱讀統計載入失敗：{detail}",
  "settings.stats.loading": "正在彙整本機閱讀記錄…",
  "settings.stats.totalBooks": "總藏書",
  "settings.stats.reading": "在讀",
  "settings.stats.todayPages": "今日閱讀",
  "settings.stats.last7Pages": "近 7 天",
  "settings.stats.unitBooks": "本",
  "settings.stats.note":
    "只統計本機閱讀記錄中實際翻過的頁面；未開啟的書與未記錄進度不計入。",
  "settings.stats.title": "書庫與閱讀統計",
  "settings.stats.description":
    "本機閱讀記錄總覽；書庫目錄與掃描也統一收在這裡。",

  "settings.cache.budgetTitle": "記憶體快取預算",
  "settings.cache.budgetDescription":
    "記憶體預算越高，翻頁越順暢，但處理程序記憶體占用也越高。",
  "settings.cache.budgetLabel": "記憶體快取預算",
  "settings.cache.budgetAria": "記憶體快取預算（MB）",
  "settings.cache.budgetHint": "儲存後立即套用到頁面與縮圖的記憶體快取。",
  "settings.cache.diskTitle": "磁碟快取",
  "settings.cache.diskDescription":
    "渲染結果與線上原圖共用同一份磁碟快取，超過上限時會自動清理較舊的檔案。",
  "settings.cache.diskLabel": "磁碟快取上限",
  "settings.cache.diskAria": "磁碟快取上限（MB）",
  "settings.cache.diskHint":
    "儲存後立即套用；調低上限後，超出部分會在後續存取時清理。",
  "settings.cache.diskUsage": "磁碟占用",
  "settings.cache.diskRender": "渲染快取",
  "settings.cache.diskOnline": "線上原圖",
  "settings.cache.diskEmpty": "暫無磁碟快取統計。",
  "settings.cache.memoryTitle": "記憶體使用",
  "settings.cache.memoryDescription": "本次執行的記憶體與快取快照。",
  "settings.cache.budgetUsage": "記憶體預算使用",
  "settings.cache.process": "處理程序占用",
  "settings.cache.imageCache": "圖片快取",
  "settings.cache.cachedPages": "快取頁面",
  "settings.cache.cachedThumbs": "封面縮圖",
  "settings.cache.webtoonCache": "條漫快取",
  "settings.cache.limit": "記憶體上限",
  "settings.cache.empty": "暫無記憶體統計。",
  "settings.cache.pagesValue": "{count} 頁",
  "settings.cache.thumbsValue": "{count} 張",
  "settings.cache.webtoonValue": "{size} · {count} 片",
  "settings.cache.maintenanceTitle": "快取維護",
  "settings.cache.maintenanceDescription":
    "清理後按需重建，不影響書庫與閱讀進度。",
  "settings.cache.clearThumbs": "清除封面快取",
  "settings.cache.clearing": "清除中…",
  "settings.cache.clearPages": "清空頁面快取",
  "settings.cache.purging": "清理中…",
  "settings.cache.clearHint":
    "封面快取清空後，重新進入書庫會自動產生。",
  "settings.cache.clearTemp": "一鍵清空臨時快取",
  "settings.cache.clearingTemp": "正在清空…",
  "settings.cache.clearTempHint":
    "清除記憶體頁面快取、渲染成品與線上原圖；封面會按需重建，書庫與閱讀進度不受影響。",
  "settings.cache.manageTitle": "快取管理與 LRU 配額",
  "settings.cache.manageDescription":
    "渲染快取與線上圖片快取共用同一份 LRU 軟上限（500 MB – 10 GB）；一鍵清空臨時快取。",
  "settings.online.proxyMode.system": "跟隨系統代理",
  "settings.online.proxyMode.manual": "手動代理",
  "settings.online.proxyMode.direct": "直連",
  "settings.online.browserHint":
    "解析漫畫網址或 Telegram 頻道請前往「瀏覽器」頁，在頂部唯一的網址列輸入即可。",

  "settings.status.loading": "正在載入設定…",
  "settings.status.loadFailed": "設定未載入",
  "settings.status.saving": "正在儲存設定…",
  "settings.status.dirty": "有未儲存的變更",
  "settings.status.saved": "所有變更已儲存",
  "settings.status.saveHint": "儲存後寫入本機設定",
  "settings.saveButton": "儲存設定",

  "settings.errors.loadSettings": "讀取設定失敗",
  "settings.errors.loadStats": "統計讀取失敗",
  "settings.errors.connectTest": "連線測試失敗",
  "settings.errors.loadSettingsDetail": "設定載入失敗：{detail}",

  "settings.toast.scanDone": "掃描完成，書庫共 {count} 本",
  "settings.toast.scanErrors": "有 {count} 個項目無法讀取，已跳過",
  "settings.toast.proxyFilled": "已填入系統代理並儲存",
  "settings.toast.proxyNotFound": "未偵測到開啟的系統代理",
  "settings.toast.sessionCleared": "已清空記憶體憑證",
  "settings.toast.urlRequired": "請填寫清單或圖集 URL",
  "settings.toast.noReadablePages": "清單沒有可讀頁面",
  "settings.toast.thumbsCleared":
    "已清除 {count} 個封面快取，重新進入書庫將自動重建",
  "settings.toast.pagesCleared": "頁面快取已清空",
  "settings.toast.tempCleared": "已清空臨時快取，釋放 {size}",
  "settings.toast.saved": "設定已儲存",

  "settings.backup.title": "本機備份與還原",
  "settings.backup.description":
    "將書庫索引、閱讀進度與偏好打包成單一備份檔；還原前請先匯出目前資料。",
  "settings.backup.export": "匯出本機備份 (.mrbackup / .zip)",
  "settings.backup.exporting": "正在匯出…",
  "settings.backup.restore": "從備份還原",
  "settings.backup.restoring": "正在還原…",
  "settings.backup.saveTitle": "選擇備份儲存位置",
  "settings.backup.pickTitle": "選擇備份檔案",
  "settings.backup.filterName": "Moyu 備份",
  "settings.backup.note":
    "備份包含書庫索引、閱讀進度、閱讀統計、主題/語言/閱讀器偏好與自學過濾規則；不包含圖片快取、工作階段請求標頭、Cookie、過濾事件與內部版本標記。還原會覆蓋目前的書庫與閱讀進度，建議先匯出目前資料。",
  "settings.backup.confirmTitle": "要從備份還原嗎？",
  "settings.backup.confirmMessage":
    "這會覆蓋目前的書庫、閱讀進度與偏好設定，且無法復原。備份檔案：{file}",
  "settings.backup.confirmRestore": "從備份還原",
  "settings.backup.exported": "已匯出備份：{books} 本 · {size}",
  "settings.backup.restored": "已從備份還原：{books} 本 · {days} 天閱讀記錄",
  "settings.backup.applied": "已套用備份中的主題、語言與閱讀器偏好",
  "settings.backup.error": "備份操作失敗，請再試一次",
  "settings.about.buildOrigin": "構建來源",
  "settings.about.buildOriginLabel": "構建來源指紋（Build Origin）",
  "settings.about.buildOriginOfficial": "Official Release",
  "settings.about.buildOriginCommunity": "Community Modified Build (Non-Commercial)",
  "settings.about.nonCommercial": "非商業授權 (Non-Commercial Only)",
  "settings.backup.skippedTitle": "以下本機書籍未還原",
  "settings.backup.skippedHint":
    "來源路徑不存在、不是可讀漫畫，或命中系統/使用者敏感目錄。紀錄未寫入書庫，磁碟內容未被刪除。",
  "settings.backup.skippedReasonMissing": "路徑不存在或無法使用",
  "settings.backup.skippedReasonNotBook": "不是可讀的漫畫資料夾/壓縮檔",
  "settings.backup.skippedReasonUnsafe": "命中系統或使用者敏感目錄",
  "settings.backup.skippedCount": "有 {count} 本本機書籍未還原",
  "settings.backup.skipWarningTitle": "還原會移除部分進度",
  "settings.backup.skipWarningMessage":
    "備份中有 {count} 本本機書籍目前無法存取（外接磁碟或網路位置未掛載）。繼續還原會刪除它們在目前書庫中的閱讀進度與歷史。還原前會自動儲存目前書庫的快照。",
  "settings.backup.forwardSchema": "備份來自更高版本（{version}）：已按相容模式還原核心書庫與進度，高版本新增設定項已忽略",
  "settings.ca.title": "根 CA 與裝置信任",
  "settings.ca.description":
    "初始化、匯出根憑證，並在短時間內透過明文 HTTP 分發給手機安裝；用於讓裝置信任本機的 HTTPS 服務。",
  "settings.ca.badgeNotInitialized": "CA 未初始化",
  "settings.ca.badgeInitialized": "CA 已初始化",
  "settings.ca.notInitialized":
    "本機 CA 尚未初始化。初始化會建立新的根憑證；請只在您控制的裝置上安裝，並妥善備份 CA。",
  "settings.ca.initialize": "初始化本機 CA",
  "settings.ca.initializeConfirmTitle": "初始化本機根 CA？",
  "settings.ca.initializeConfirmMessage":
    "這會建立新的本機根 CA。遺失 CA 後，所有已安裝裝置都需要重新安裝信任憑證；初始化不會上傳任何資料。",
  "settings.ca.initialized": "本機 CA 已初始化並通過私鑰 ACL 檢查。",
  "settings.ca.fingerprint": "根憑證 SHA-256 指紋",
  "settings.ca.fingerprintHint":
    "在手機安裝憑證前，核對完整 SHA-256 指紋：共 64 個十六進位字元，忽略冒號與大小寫。",
  "settings.ca.verifyOnPhone":
    "重要：手機安裝頁可能顯示 SHA-1 或 SHA-256；必須切到 SHA-256 並與上方逐段核對。不一致就不要安裝。",
  "settings.ca.copyFingerprint": "複製指紋",
  "settings.ca.copied": "已複製",
  "settings.ca.copyFailed": "複製失敗，請手動選取文字複製。",
  "settings.ca.expires": "根憑證到期：{date}（剩餘 {days} 天）",
  "settings.ca.rotationWarning":
    "根憑證將在 {days} 天後進入輪換窗口；輪換後需要向所有裝置重新分發並安裝。",
  "settings.ca.intermediateFingerprint": "中間 CA 指紋（診斷）",
  "settings.ca.export": "匯出根憑證",
  "settings.ca.exportTitle": "儲存根憑證",
  "settings.ca.exported": "根憑證已匯出；安裝前請核對指紋。",
  "settings.ca.exportFailed": "匯出根憑證失敗，請重試。",
  "settings.ca.loadError": "無法載入 CA 狀態：{detail}",
  "settings.ca.distribution.title": "短時分發服務",
  "settings.ca.distribution.description":
    "明確啟動後，僅提供根憑證下載；服務使用明文 HTTP（手機在信任 CA 前無法驗證 HTTPS），120 秒後自動關閉。",
  "settings.ca.distribution.address": "分發位址",
  "settings.ca.distribution.start": "啟動分發",
  "settings.ca.distribution.stop": "停止分發",
  "settings.ca.distribution.running": "執行中",
  "settings.ca.distribution.stopped": "已停止",
  "settings.ca.distribution.url": "下載位址",
  "settings.ca.distribution.expiresIn": "剩餘 {seconds} 秒",
  "settings.ca.distribution.expired": "分發服務已到期並自動關閉。",
  "settings.ca.distribution.securityNote":
    "只分發公開根憑證；請只在可信區域網路內使用。分發位址是明文 HTTP，不要向不可信網路暴露。",
  "settings.ca.distribution.noAddress":
    "找不到可用的私有區域網路 IPv4 位址，無法啟動分發。",
  "settings.ca.privateKeyNote":
    "CA 私鑰只保存在本機 CA 目錄中；HTTP 分發工作沒有讀取私鑰的能力。",

  "settings.webAccess.unknownDevice": "未知裝置",
  "settings.webAccess.networkHint":
    "若 Windows 防火牆阻止連線，請允許本程式在私人網路的傳入連線。只有 HTTPS 模式需要裝置信任本機憑證。",
  "settings.webAccess.title": "區域網路閱讀",
  "settings.webAccess.description":
    "手機掃碼或輸入網址，在電腦上核准後即可閱讀。服務預設關閉。",
  "settings.webAccess.statusTitle": "服務狀態",
  "settings.webAccess.refresh": "重新整理狀態",
  "settings.webAccess.loadError": "無法載入 Web Access 狀態：{detail}",
  "settings.webAccess.phase.disabled": "已關閉",
  "settings.webAccess.phase.starting": "正在啟動",
  "settings.webAccess.phase.enabled": "執行中",
  "settings.webAccess.phase.stopping": "正在停止",
  "settings.webAccess.phase.error": "錯誤",
  "settings.webAccess.caRequired":
    "HTTPS 模式需要先在「根 CA 與裝置信任」中初始化本機 CA。",
  "settings.webAccess.safeModeBlocked":
    "安全模式已啟用。Web Access 已停止，結束安全模式前無法重新啟動。",
  "settings.webAccess.address": "監聽位址",
  "settings.webAccess.noAddress": "找不到可用的私有區域網路 IPv4 位址",
  "settings.webAccess.bindAddress": "綁定位址",
  "settings.webAccess.port": "實際連接埠",
  "settings.webAccess.deviceCount": "已配對裝置：{count}",
  "settings.webAccess.pendingCount": "待批准請求：{count}",
  "settings.webAccess.notRunning": "服務未執行；啟動後可產生配對 QR Code。",
  "settings.webAccess.start": "啟動服務",
  "settings.webAccess.httpWarning": "區域網路 HTTP 未加密；同一網路的裝置可能讀取或竄改內容與工作階段。請僅在可信網路使用。",
  "settings.webAccess.startSecure": "進階：使用 HTTPS",
  "settings.webAccess.plainPairHint": "手機掃碼或輸入網址後，在此核准裝置。無需安裝憑證。",
  "settings.webAccess.starting": "正在啟動",
  "settings.webAccess.stop": "停止服務",
  "settings.webAccess.stopping": "正在停止",
  "settings.webAccess.stopConfirmTitle": "停止 Web Access？",
  "settings.webAccess.stopConfirmMessage":
    "停止會立即中斷所有已配對裝置、取消目前的配對視窗，並關閉監聽連接埠。需要時可以從本面板重新啟動。",
  "settings.webAccess.stopReasonTitle": "停止原因",
  "settings.webAccess.stopReason.stopped": "使用者手動停止",
  "settings.webAccess.stopReason.safeMode": "進入安全模式後停止",
  "settings.webAccess.stopReason.recovery": "當機復原時停止",
  "settings.webAccess.stopReason.exit": "應用程式結束時停止",
  "settings.webAccess.lastError": "最近錯誤：{detail}",
  "settings.webAccess.rootFingerprint": "根憑證 SHA-256 指紋",
  "settings.webAccess.leafFingerprint": "葉憑證 SHA-256 指紋",
  "settings.webAccess.leafExpires": "葉憑證到期：{date}",
  "settings.webAccess.copyFingerprint": "複製指紋",
  "settings.webAccess.pairingTitle": "裝置配對",
  "settings.webAccess.pairingDescription":
    "按下開始後會產生一個 120 秒有效的配對視窗；手機掃描 QR Code 或開啟連結後，需要在本面板逐筆確認。",
  "settings.webAccess.pairingStart": "開始配對",
  "settings.webAccess.pairingCancel": "取消配對",
  "settings.webAccess.pairingCountdown": "剩餘 {seconds} 秒",
  "settings.webAccess.pairingExpired": "配對視窗已過期，請重新開始配對。",
  "settings.webAccess.qrAlt": "Web Access 配對 QR Code",
  "settings.webAccess.qrHint":
    "QR Code 只包含本次配對連結；請用手機相機掃描，不要截圖分享。",
  "settings.webAccess.copyUrl": "複製連結",
  "settings.webAccess.copied": "已複製",
  "settings.webAccess.copyFailed": "複製失敗，請手動選取文字複製。",
  "settings.webAccess.claimsTitle": "待批准請求",
  "settings.webAccess.claimsEmpty": "目前沒有待批准的配對請求。",
  "settings.webAccess.claimCount": "待批准 {count} 筆",
  "settings.webAccess.unverifiedDevice": "名稱未經核實",
  "settings.webAccess.sourceIp": "來源 IP（伺服器端觀測）",
  "settings.webAccess.receivedAt": "收到時間：{time}",
  "settings.webAccess.claimExpiresIn": "請求剩餘 {seconds} 秒",
  "settings.webAccess.claimExpired": "請求已過期",
  "settings.webAccess.cancelRequest": "取消請求",
  "settings.webAccess.approve": "批准",
  "settings.webAccess.deny": "拒絕",
  "settings.webAccess.approveConfirmTitle": "批准這台裝置？",
  "settings.webAccess.approveConfirmMessage":
    "即將授權「{name}」連線到本機，並可瀏覽和讀取這台桌面裝置上的整個書庫與閱讀進度。裝置名稱由手機自行回報，無法證明對方身分；只有你本人發起這次配對時才應批准。",
  "settings.webAccess.approvePlainHttpWarning":
    "目前使用未加密的 HTTP；同一區域網路內的裝置都可連線至服務。請只在可信任的網路中批准你信任的裝置。",
  "settings.webAccess.cancelStart": "取消啟動",
  "settings.webAccess.cancelingStart": "正在取消…",
  "settings.webAccess.devicesTitle": "已配對裝置",
  "settings.webAccess.devicesEmpty": "還沒有已配對裝置。裝置完成配對批准並開啟閱讀頁後會自動出現在這裡。",
  "settings.webAccess.deviceIp": "區域網路位址：{ip}",
  "settings.webAccess.deviceLastActive": "最近活躍：{date}",
  "settings.webAccess.devicesMemoryNote":
    "工作階段只保存在記憶體中：停止區域網路服務或結束程式後，所有裝置會自動斷開並清空。",
  "settings.webAccess.deviceIssued": "簽發：{date}",
  "settings.webAccess.deviceExpires": "到期：{date}",
  "settings.webAccess.revoke": "撤銷",
  "settings.webAccess.revokeConfirmTitle": "撤銷這台裝置？",
  "settings.webAccess.revokeConfirmMessage":
    "撤銷「{name}」會立即中斷它的存取，之後必須重新完成配對。",
  "settings.webAccess.securityNote":
    "裝置名稱由手機自行回報，可能被修改；本專案沒有 SAS 或密碼學綁定，桌面端的人工批准是唯一授權。請不要因為裝置出現在清單裡就認為它已通過驗證。",

  "settings.autoSaved": "已自動儲存",
  "settings.autoSaving": "正在儲存…",
  "settings.autoSaveFailed": "儲存失敗",
  "settings.filter.blockedShort": "已攔截 {count} 項",
};

const en: SettingsMessages = {
  "settings.features.title": "Feature switches",
  "settings.features.description":
    "Enable or disable each feature independently. Turning one off hides its entry points and blocks backend calls. Changes apply immediately.",
  "settings.features.browser.description":
    "Auxiliary browser for site verification and download import. Turning it off hides the top-bar entry.",
  "settings.features.pdf.title": "PDF reading",
  "settings.features.pdf.description":
    "Local PDF reading and rendering. Existing PDFs remain in the library, but opening one shows a disabled notice.",
  "settings.page.eyebrow": "Preferences",
  "settings.page.description":
    "Appearance, online sources, reading stats and cache are managed on this device.",
  "settings.page.localFirst": "Local first",
  "settings.page.loading": "Loading settings",

  "settings.tabs.label": "Settings sections",
  "settings.tabs.general": "General & appearance",
  "settings.tabs.online": "Online",
  "settings.tabs.reading": "Stats",
  "settings.tabs.cache": "Cache",
  "settings.tabs.network": "Network & sources",
  "settings.tabs.storage": "Storage & data",
  "settings.tabs.privacy": "Privacy & security",
  "settings.tabs.about": "About & maintenance",

  "settings.shortcuts.title": "Global shortcuts",
  "settings.shortcuts.description":
    "While an input is focused or an IME is composing (isComposing / keyCode 229), no global shortcut fires except Ctrl/Cmd+W.",
  "settings.shortcuts.note":
    "Move focus out of the input first; Ctrl/Cmd+W (close window) is the only exception.",
  "settings.shortcuts.command": "Ctrl/Cmd+K opens the command center",

  "settings.language.title": "Interface language",
  "settings.language.description":
    "Choose the interface language. Changes apply instantly and are saved on this device; no save is needed.",
  "settings.language.label": "Display language",

  "settings.theme.title": "Appearance",
  "settings.tray.title": "Window & tray",
  "settings.tray.description":
    "While LAN reading is running, closing the main window can keep it in the system tray and keep serving pages in the background.",
  "settings.tray.closeToTray": "Minimize to tray when closing the main window",
  "settings.tray.closeToTrayHint":
    "When enabled, the close (×) button only hides the window; quit from the tray menu to exit completely.",
  "settings.theme.description":
    "Choose the interface palette. Changes apply instantly and sync to local preferences and the database.",
  "settings.theme.groupLabel": "Theme mode",
  "settings.theme.systemHint": "Follows system light/dark",
  "settings.theme.lightHint": "Ice-blue canvas",
  "settings.theme.darkHint": "Midnight cockpit",
  "settings.theme.systemNote":
    "“System” follows your operating system's light and dark appearance automatically.",


  "settings.experimental.webtoonTitle": "Webtoon mode",
  "settings.experimental.webtoonDescription":
    "Continuous vertical scrolling for long-strip comics, a third layout beyond single and double page.",

  "settings.toast.featureOn": "{feature} enabled",
  "settings.toast.featureOff": "{feature} disabled",

  "settings.library.title": "Library folder",
  "settings.library.description":
    "Choose the folder containing your manga; scanning adds new books to this device's library.",
  "settings.library.dirLabel": "Scan folder",
  "settings.library.dirPlaceholder": "D:\\Manga or /path/to/manga",
  "settings.library.pick": "Browse",
  "settings.library.pickTitle": "Choose manga folder",
  "settings.library.clearDir": "Clear folder",
  "settings.library.scanning": "Scanning…",
  "settings.library.scanNow": "Scan now",
  "settings.library.scanHint":
    "Scanning uses the folder above; no save needed. Results appear as a notification.",

  "settings.about.title": "About",
  "settings.about.description":
    "Moyu is a free desktop application for manga reading and library management.",
  "settings.about.version": "Version",
  "settings.about.commit": "Build commit",
  "settings.about.storage": "Settings storage",
  "settings.about.storageValue": "Local SQLite",
  "settings.about.dataFlow": "Data stays",
  "settings.about.dataFlowValue": "On this device",
  "settings.about.note":
    "Settings and reading history stay on this device. Scanning, online requests and reading never upload personal data.",

  "settings.online.urlTitle": "Online URL reading",
  "settings.online.urlDescription":
    "Supports JSON manifests and single-page HTML galleries. When off, the library and browser prompt you to enable it.",
  "settings.online.enableTitle": "Enable online sources",
  "settings.online.enableDescription":
    "Import and read from online manifests or galleries; imported chapters are added to this device's library.",
  "settings.online.enableNote":
    "Toggling persists immediately; network options below take effect after you click “Save settings”.",
  "settings.online.networkTitle": "Network & requests",
  "settings.online.networkDescription":
    "Proxy, concurrency and headers are sent with online requests. Only configure sources or gateways you trust.",
  "settings.online.proxyLabel": "Proxy address",
  "settings.online.proxyPlaceholder":
    "Leave empty for direct, or http://127.0.0.1:7890",
  "settings.online.detectProxy": "System proxy",
  "settings.online.detectProxyTitle":
    "Read the Windows system proxy into the proxy field; it is not saved automatically",
  "settings.online.detecting": "Detecting…",
  "settings.online.proxyHint":
    "Supports http / https / socks5; leave empty for a direct connection.",
  "settings.online.concurrencyLabel": "Page concurrency",
  "settings.online.concurrencyPlaceholder": "Select concurrency",
  "settings.online.concurrencyItem": "{count} concurrent",
  "settings.online.concurrencyHint":
    "1–8; higher concurrency is faster but more likely to be rate-limited by the source.",
  "settings.online.headersLabel": "Custom headers",
  "settings.online.sessionActive": "Session credentials active",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} or session=...; token=...',
  "settings.online.headersHint":
    "Headers are stored in plain text in local settings and sent with requests to the source or gateway you configure.",
  "settings.online.storageMode": "Storage mode",
  "settings.online.storageModeDescription":
    "Session mode is not written to the database and is cleared when the app exits.",
  "settings.online.storageModeGroup": "Header storage mode",
  "settings.online.memoryOnly": "Memory only",
  "settings.online.persistLocal": "Persist locally",
  "settings.online.sessionPresent":
    "Headers are currently stored in process memory.",
  "settings.online.sessionAbsent": "No session headers right now.",
  "settings.online.clearSession": "Clear memory credentials",
  "settings.online.storageModeNote":
    "Session headers stay in memory only and apply only to the first site you use them with. Re-enter them after switching sites.",
  "settings.online.testTitle": "Connectivity test",
  "settings.online.testDescription":
    "Parses the target manifest or gallery as a probe only; nothing is written to the library.",
  "settings.online.testUrlAria": "Online manifest or gallery test URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "Testing…",
  "settings.online.testConnection": "Test connection",
  "settings.online.reachable": "Reachable",
  "settings.online.testSummary": "{title} · {pages} pages · {ms} ms",
  "settings.online.testHint":
    "The test uses saved proxy and headers; save your changes first.",

  "settings.stats.loadError": "Failed to load reading stats: {detail}",
  "settings.stats.loading": "Summarizing local reading history…",
  "settings.stats.totalBooks": "Total books",
  "settings.stats.reading": "Reading",
  "settings.stats.todayPages": "Pages today",
  "settings.stats.last7Pages": "Last 7 days",
  "settings.stats.unitBooks": "books",
  "settings.stats.note":
    "Only pages actually turned in local reading history are counted; unopened books and unrecorded progress are excluded.",
  "settings.stats.title": "Library & reading stats",
  "settings.stats.description":
    "Overview of local reading history; the library folder and scan live here too.",

  "settings.cache.budgetTitle": "Memory cache budget",
  "settings.cache.budgetDescription":
    "A higher memory budget makes page turns smoother but increases process memory use.",
  "settings.cache.budgetLabel": "Memory cache budget",
  "settings.cache.budgetAria": "Memory cache budget (MB)",
  "settings.cache.budgetHint":
    "Applied to the in-memory page and thumbnail caches immediately after saving.",
  "settings.cache.diskTitle": "Disk cache",
  "settings.cache.diskDescription":
    "Rendered pages and online originals share one disk cache; older files are evicted automatically when the limit is exceeded.",
  "settings.cache.diskLabel": "Disk cache limit",
  "settings.cache.diskAria": "Disk cache limit (MB)",
  "settings.cache.diskHint":
    "Applied immediately after saving; lowering the limit cleans up excess files on later access.",
  "settings.cache.diskUsage": "Disk usage",
  "settings.cache.diskRender": "Render cache",
  "settings.cache.diskOnline": "Online originals",
  "settings.cache.diskEmpty": "No disk cache stats yet.",
  "settings.cache.memoryTitle": "Memory usage",
  "settings.cache.memoryDescription": "Memory and cache snapshot for this run.",
  "settings.cache.budgetUsage": "Memory budget usage",
  "settings.cache.process": "Process",
  "settings.cache.imageCache": "Image cache",
  "settings.cache.cachedPages": "Cached pages",
  "settings.cache.cachedThumbs": "Cover thumbnails",
  "settings.cache.webtoonCache": "Webtoon cache",
  "settings.cache.limit": "Memory limit",
  "settings.cache.empty": "No memory stats yet.",
  "settings.cache.pagesValue": "{count} pages",
  "settings.cache.thumbsValue": "{count} thumbs",
  "settings.cache.webtoonValue": "{size} · {count} tiles",
  "settings.cache.maintenanceTitle": "Cache maintenance",
  "settings.cache.maintenanceDescription":
    "Cleared items rebuild on demand without affecting the library or reading progress.",
  "settings.cache.clearThumbs": "Clear cover cache",
  "settings.cache.clearing": "Clearing…",
  "settings.cache.clearPages": "Clear page cache",
  "settings.cache.purging": "Purging…",
  "settings.cache.clearHint":
    "Cover thumbnails regenerate automatically the next time you open the library.",
  "settings.cache.clearTemp": "Clear temporary cache",
  "settings.cache.clearingTemp": "Clearing…",
  "settings.cache.clearTempHint":
    "Clears in-memory pages, rendered files and online originals; covers rebuild as needed, while the library and reading progress are unaffected.",
  "settings.cache.manageTitle": "Cache & LRU quota",
  "settings.cache.manageDescription":
    "Render and online image caches share one soft LRU limit (500 MB – 10 GB); one click clears temporary caches.",
  "settings.online.proxyMode.system": "Follow system proxy",
  "settings.online.proxyMode.manual": "Manual proxy",
  "settings.online.proxyMode.direct": "Direct",
  "settings.online.browserHint":
    "To resolve a manga URL or a Telegram channel, open the Browser page and type it into the single address bar at the top.",

  "settings.status.loading": "Loading settings…",
  "settings.status.loadFailed": "Settings not loaded",
  "settings.status.saving": "Saving settings…",
  "settings.status.dirty": "Unsaved changes",
  "settings.status.saved": "All changes saved",
  "settings.status.saveHint": "Saved to this device's settings",
  "settings.saveButton": "Save settings",

  "settings.errors.loadSettings": "Failed to read settings",
  "settings.errors.loadStats": "Failed to read stats",
  "settings.errors.connectTest": "Connection test failed",
  "settings.errors.loadSettingsDetail": "Failed to load settings: {detail}",

  "settings.toast.scanDone": "Scan complete. {count} books in the library.",
  "settings.toast.scanErrors": "{count} entries could not be read and were skipped",
  "settings.toast.proxyFilled": "System proxy detected and saved",
  "settings.toast.proxyNotFound": "No enabled system proxy detected",
  "settings.toast.sessionCleared": "Memory credentials cleared",
  "settings.toast.urlRequired": "Enter a manifest or gallery URL",
  "settings.toast.noReadablePages": "The manifest has no readable pages",
  "settings.toast.thumbsCleared":
    "Cleared {count} cover thumbnails; they will rebuild when you reopen the library",
  "settings.toast.pagesCleared": "Page cache cleared",
  "settings.toast.tempCleared": "Temporary cache cleared, {size} freed",
  "settings.toast.saved": "Settings saved",

  "settings.backup.title": "Local backup & restore",
  "settings.backup.description":
    "Pack the library index, reading progress and preferences into one backup file; export current data before restoring.",
  "settings.backup.export": "Export local backup (.mrbackup / .zip)",
  "settings.backup.exporting": "Exporting…",
  "settings.backup.restore": "Restore from backup",
  "settings.backup.restoring": "Restoring…",
  "settings.backup.saveTitle": "Choose where to save the backup",
  "settings.backup.pickTitle": "Choose a backup file",
  "settings.backup.filterName": "Moyu backup",
  "settings.backup.note":
    "The backup contains the library index, reading progress, reading stats, theme/language/reader preferences and self-learned filter rules. It does not include image caches, session request headers, cookies, filter events or internal version markers. Restoring overwrites the current library and reading progress, so export first.",
  "settings.backup.confirmTitle": "Restore from this backup?",
  "settings.backup.confirmMessage":
    "This overwrites the current library, reading progress and preferences and cannot be undone. Backup file: {file}",
  "settings.backup.confirmRestore": "Restore backup",
  "settings.backup.exported": "Backup exported: {books} books · {size}",
  "settings.backup.restored":
    "Backup restored: {books} books · {days} reading days",
  "settings.backup.applied":
    "Theme, language and reader preferences from the backup were applied",
  "settings.backup.error": "Backup operation failed. Please try again.",
  "settings.about.buildOrigin": "Build origin",
  "settings.about.buildOriginLabel": "Build origin fingerprint",
  "settings.about.buildOriginOfficial": "Official Release",
  "settings.about.buildOriginCommunity": "Community Modified Build (Non-Commercial)",
  "settings.about.nonCommercial": "Non-Commercial Only",
  "settings.backup.skippedTitle": "Some local books were not restored",
  "settings.backup.skippedHint":
    "The source path is missing, not a readable manga, or points at a sensitive system/user folder. Nothing was added to the library and nothing on disk was deleted.",
  "settings.backup.skippedReasonMissing": "Path missing or unavailable",
  "settings.backup.skippedReasonNotBook":
    "Not a readable manga folder/archive",
  "settings.backup.skippedReasonUnsafe":
    "Points at a sensitive system/user folder",
  "settings.backup.skippedCount": "{count} local books were not restored",
  "settings.backup.skipWarningTitle": "Restore removes some progress",
  "settings.backup.skipWarningMessage":
    "{count} local books in this backup cannot be reached right now (an external drive or network location is not mounted). Continuing deletes their reading progress and history from the current library. A snapshot of the current library is saved first.",
  "settings.backup.forwardSchema": "Backup was exported by a newer version ({version}). Core library and progress were restored in compatibility mode; settings added in newer versions were ignored.",
  "settings.ca.title": "Root CA and device trust",
  "settings.ca.description":
    "Initialize and export the root CA, then distribute it briefly over plain HTTP so a phone can install it and trust this device's HTTPS service.",
  "settings.ca.badgeNotInitialized": "CA not initialized",
  "settings.ca.badgeInitialized": "CA initialized",
  "settings.ca.notInitialized":
    "The local CA is not initialized. Initialization creates a new root certificate; install it only on devices you control and back up the CA.",
  "settings.ca.initialize": "Initialize local CA",
  "settings.ca.initializeConfirmTitle": "Initialize the local root CA?",
  "settings.ca.initializeConfirmMessage":
    "This creates a new local root CA. If the CA is lost, every installed device must install the trust certificate again. Nothing is uploaded.",
  "settings.ca.initialized": "Local CA initialized and private-key ACL verified.",
  "settings.ca.fingerprint": "Root certificate SHA-256 fingerprint",
  "settings.ca.fingerprintHint":
    "Before installing on the phone, compare the full SHA-256 fingerprint: 64 hexadecimal characters, ignoring colons and letter case.",
  "settings.ca.verifyOnPhone":
    "Important: the phone may show SHA-1 or SHA-256. Switch to SHA-256 and compare every group with the value above. Do not install if they differ.",
  "settings.ca.copyFingerprint": "Copy fingerprint",
  "settings.ca.copied": "Copied",
  "settings.ca.copyFailed": "Copy failed; select the text and copy it manually.",
  "settings.ca.expires": "Root expires: {date} ({days} days remaining)",
  "settings.ca.rotationWarning":
    "The root CA enters its rotation window in {days} days. After rotation, redistribute and reinstall it on every device.",
  "settings.ca.intermediateFingerprint": "Intermediate CA fingerprint (diagnostic)",
  "settings.ca.export": "Export root certificate",
  "settings.ca.exportTitle": "Save root certificate",
  "settings.ca.exported": "Root certificate exported; verify the fingerprint before installing.",
  "settings.ca.exportFailed": "Failed to export the root certificate. Try again.",
  "settings.ca.loadError": "Could not load CA status: {detail}",
  "settings.ca.distribution.title": "Short-lived distribution",
  "settings.ca.distribution.description":
    "After an explicit start, only the root certificate is offered. The service uses plain HTTP (a phone cannot verify HTTPS before trusting the CA) and closes automatically after 120 seconds.",
  "settings.ca.distribution.address": "Distribution address",
  "settings.ca.distribution.start": "Start distribution",
  "settings.ca.distribution.stop": "Stop distribution",
  "settings.ca.distribution.running": "Running",
  "settings.ca.distribution.stopped": "Stopped",
  "settings.ca.distribution.url": "Download URL",
  "settings.ca.distribution.expiresIn": "{seconds} seconds remaining",
  "settings.ca.distribution.expired": "The distribution service expired and closed automatically.",
  "settings.ca.distribution.securityNote":
    "Only the public root certificate is served. Use it only on a trusted LAN; the URL is plain HTTP, so do not expose it to untrusted networks.",
  "settings.ca.distribution.noAddress":
    "No private LAN IPv4 address is available, so distribution cannot start.",
  "settings.ca.privateKeyNote":
    "The CA private key stays in the local CA directory; the HTTP distribution task cannot read it.",

  "settings.webAccess.unknownDevice": "Unknown device",
  "settings.webAccess.networkHint":
    "If Windows Firewall blocks the connection, allow this app inbound on private networks. Only HTTPS mode requires the device to trust the local certificate.",
  "settings.webAccess.title": "Local network reading",
  "settings.webAccess.description":
    "Scan the code or enter the address and approve the device on your computer. The service is off by default.",
  "settings.webAccess.statusTitle": "Service status",
  "settings.webAccess.refresh": "Refresh status",
  "settings.webAccess.loadError": "Could not load Web Access status: {detail}",
  "settings.webAccess.phase.disabled": "Disabled",
  "settings.webAccess.phase.starting": "Starting",
  "settings.webAccess.phase.enabled": "Enabled",
  "settings.webAccess.phase.stopping": "Stopping",
  "settings.webAccess.phase.error": "Error",
  "settings.webAccess.caRequired":
    "HTTPS mode requires the local CA to be initialized in “Root CA and device trust” first.",
  "settings.webAccess.safeModeBlocked":
    "Safe mode is active. Web Access has been stopped and cannot be started until you leave safe mode.",
  "settings.webAccess.address": "Listen address",
  "settings.webAccess.noAddress":
    "No private LAN IPv4 address is available",
  "settings.webAccess.bindAddress": "Bound address",
  "settings.webAccess.port": "Actual port",
  "settings.webAccess.deviceCount": "Paired devices: {count}",
  "settings.webAccess.pendingCount": "Pending requests: {count}",
  "settings.webAccess.notRunning":
    "The service is not running. Start it to generate a pairing QR code.",
  "settings.webAccess.start": "Start service",
  "settings.webAccess.httpWarning": "Local HTTP is unencrypted. Devices on the network may read or alter content and sessions. Use only on a trusted network.",
  "settings.webAccess.startSecure": "Advanced: use HTTPS",
  "settings.webAccess.plainPairHint": "Scan the code or enter the address, then approve the device here. No certificate is needed.",
  "settings.webAccess.starting": "Starting",
  "settings.webAccess.stop": "Stop service",
  "settings.webAccess.stopping": "Stopping",
  "settings.webAccess.stopConfirmTitle": "Stop Web Access?",
  "settings.webAccess.stopConfirmMessage":
    "Stopping disconnects every paired device, cancels the current pairing window, and closes the listening port. You can start it again from this panel.",
  "settings.webAccess.stopReasonTitle": "Stop reason",
  "settings.webAccess.stopReason.stopped": "Stopped manually by the user",
  "settings.webAccess.stopReason.safeMode":
    "Stopped after entering safe mode",
  "settings.webAccess.stopReason.recovery":
    "Stopped during crash recovery",
  "settings.webAccess.stopReason.exit": "Stopped because the app is exiting",
  "settings.webAccess.lastError": "Last error: {detail}",
  "settings.webAccess.rootFingerprint":
    "Root certificate SHA-256 fingerprint",
  "settings.webAccess.leafFingerprint":
    "Leaf certificate SHA-256 fingerprint",
  "settings.webAccess.leafExpires": "Leaf certificate expires: {date}",
  "settings.webAccess.copyFingerprint": "Copy fingerprint",
  "settings.webAccess.pairingTitle": "Device pairing",
  "settings.webAccess.pairingDescription":
    "Starting creates a pairing window that is valid for 120 seconds. After the phone scans the QR code or opens the link, confirm each request in this panel.",
  "settings.webAccess.pairingStart": "Start pairing",
  "settings.webAccess.pairingCancel": "Cancel pairing",
  "settings.webAccess.pairingCountdown": "{seconds}s left",
  "settings.webAccess.pairingExpired":
    "The pairing window has expired. Start pairing again.",
  "settings.webAccess.qrAlt": "Web Access pairing QR code",
  "settings.webAccess.qrHint":
    "The QR code contains only this pairing link. Scan it with the phone camera and do not share screenshots.",
  "settings.webAccess.copyUrl": "Copy link",
  "settings.webAccess.copied": "Copied",
  "settings.webAccess.copyFailed":
    "Could not copy. Select the text and copy it manually.",
  "settings.webAccess.claimsTitle": "Pending requests",
  "settings.webAccess.claimsEmpty": "There are no pending pairing requests.",
  "settings.webAccess.claimCount": "{count} pending",
  "settings.webAccess.unverifiedDevice": "Unverified name",
  "settings.webAccess.sourceIp": "Source IP (server-observed)",
  "settings.webAccess.receivedAt": "Received: {time}",
  "settings.webAccess.claimExpiresIn": "Request expires in {seconds}s",
  "settings.webAccess.claimExpired": "Request expired",
  "settings.webAccess.cancelRequest": "Cancel request",
  "settings.webAccess.approve": "Approve",
  "settings.webAccess.deny": "Deny",
  "settings.webAccess.approveConfirmTitle": "Approve this device?",
  "settings.webAccess.approveConfirmMessage":
    "You are about to authorize “{name}” to connect to this desktop and browse or read its entire library and reading progress. The device name is self-reported by the phone and does not prove its identity; approve only if you started this pairing.",
  "settings.webAccess.approvePlainHttpWarning":
    "Plain HTTP is unencrypted and the service is reachable by devices on this local network. Continue only on a network you trust and for a device you trust.",
  "settings.webAccess.cancelStart": "Cancel start",
  "settings.webAccess.cancelingStart": "Canceling…",
  "settings.webAccess.devicesTitle": "Paired devices",
  "settings.webAccess.devicesEmpty":
    "No devices are paired yet. A device appears here right after its pairing is approved and it opens the reader.",
  "settings.webAccess.deviceIp": "LAN address: {ip}",
  "settings.webAccess.deviceLastActive": "Last active: {date}",
  "settings.webAccess.devicesMemoryNote":
    "Sessions live in memory only: stopping the LAN service or quitting the app disconnects and clears every device.",
  "settings.webAccess.deviceIssued": "Issued: {date}",
  "settings.webAccess.deviceExpires": "Expires: {date}",
  "settings.webAccess.revoke": "Revoke",
  "settings.webAccess.revokeConfirmTitle": "Revoke this device?",
  "settings.webAccess.revokeConfirmMessage":
    "Revoking “{name}” disconnects it immediately; it must pair again to reconnect.",
  "settings.webAccess.securityNote":
    "Device names are self-reported by the phone and can change. This project has no SAS or cryptographic binding; manual approval on this desktop is the only authorization. Do not treat a device as verified just because it appears in this list.",

  "settings.autoSaved": "Auto-saved",
  "settings.autoSaving": "Saving…",
  "settings.autoSaveFailed": "Save failed",
  "settings.filter.blockedShort": "{count} blocked",
};

const es: SettingsMessages = {
  "settings.features.title": "Interruptores de funciones",
  "settings.features.description":
    "Activa o desactiva cada función de forma independiente. Al desactivarla se ocultan sus entradas y se bloquean las llamadas al backend. Los cambios se aplican al instante.",
  "settings.features.browser.description":
    "Navegador auxiliar para verificación de sitios e importación de descargas. Al desactivarlo se oculta la entrada de la barra superior.",
  "settings.features.pdf.title": "Lectura de PDF",
  "settings.features.pdf.description":
    "Lectura y renderizado de PDF locales. Los PDF existentes permanecen en la biblioteca, pero al abrirlos se muestra un aviso de función desactivada.",
  "settings.page.eyebrow": "Preferencias",
  "settings.page.description":
    "La apariencia, las fuentes en línea, las estadísticas y la caché se gestionan en este dispositivo.",
  "settings.page.localFirst": "Prioridad local",
  "settings.page.loading": "Cargando ajustes",

  "settings.tabs.label": "Secciones de ajustes",
  "settings.tabs.general": "General y apariencia",
  "settings.tabs.online": "En línea",
  "settings.tabs.reading": "Datos",
  "settings.tabs.cache": "Caché",
  "settings.tabs.network": "Red y fuentes",
  "settings.tabs.storage": "Almacenamiento y datos",
  "settings.tabs.privacy": "Privacidad y seguridad",
  "settings.tabs.about": "Acerca de y mantenimiento",

  "settings.shortcuts.title": "Atajos globales",
  "settings.shortcuts.description":
    "Con un campo enfocado o el IME en composición (isComposing / keyCode 229), ningún atajo global se activa salvo Ctrl/Cmd+W.",
  "settings.shortcuts.note":
    "Quita el foco del campo primero; Ctrl/Cmd+W (cerrar ventana) es la única excepción.",
  "settings.shortcuts.command": "Ctrl/Cmd+K abre el centro de comandos",

  "settings.language.title": "Idioma de la interfaz",
  "settings.language.description":
    "Elige el idioma de la interfaz. El cambio se aplica al instante y se guarda en este dispositivo; no hace falta guardar.",
  "settings.language.label": "Idioma mostrado",

  "settings.theme.title": "Apariencia",
  "settings.tray.title": "Ventana y bandeja",
  "settings.tray.description":
    "Con la lectura LAN en marcha, cerrar la ventana principal puede mantenerla en la bandeja del sistema y seguir sirviendo páginas en segundo plano.",
  "settings.tray.closeToTray":
    "Minimizar a la bandeja al cerrar la ventana principal",
  "settings.tray.closeToTrayHint":
    "Si se activa, el botón cerrar (×) solo oculta la ventana; sal del menú de la bandeja para terminar del todo.",
  "settings.theme.description":
    "Elige la paleta de la interfaz. El cambio se aplica al instante y se sincroniza con las preferencias locales y la base de datos.",
  "settings.theme.groupLabel": "Modo de tema",
  "settings.theme.systemHint": "Sigue el claro/oscuro del sistema",
  "settings.theme.lightHint": "Lienzo azul hielo",
  "settings.theme.darkHint": "Cabina nocturna",
  "settings.theme.systemNote":
    "«Sistema» sigue automáticamente el modo claro u oscuro del sistema operativo.",


  "settings.experimental.webtoonTitle": "Modo webtoon",
  "settings.experimental.webtoonDescription":
    "Desplazamiento vertical continuo para cómics de tira larga, un tercer diseño además de página única y doble.",

  "settings.toast.featureOn": "Se activó «{feature}»",
  "settings.toast.featureOff": "Se desactivó «{feature}»",

  "settings.library.title": "Carpeta de la biblioteca",
  "settings.library.description":
    "Indica la carpeta donde están tus cómics; el escaneo añade libros nuevos a la biblioteca de este dispositivo.",
  "settings.library.dirLabel": "Carpeta de escaneo",
  "settings.library.dirPlaceholder": "D:\\Manga o /path/to/manga",
  "settings.library.pick": "Elegir",
  "settings.library.pickTitle": "Elegir carpeta de cómics",
  "settings.library.clearDir": "Vaciar carpeta",
  "settings.library.scanning": "Escaneando…",
  "settings.library.scanNow": "Escanear ahora",
  "settings.library.scanHint":
    "El escaneo usa la carpeta de arriba; no hace falta guardar. El resultado aparece como aviso.",

  "settings.about.title": "Acerca de",
  "settings.about.description":
    "Moyu es una aplicación de escritorio gratuita para leer manga y gestionar tu biblioteca.",
  "settings.about.version": "Versión",
  "settings.about.commit": "Commit de compilación",
  "settings.about.storage": "Almacenamiento",
  "settings.about.storageValue": "SQLite local",
  "settings.about.dataFlow": "Ubicación de datos",
  "settings.about.dataFlowValue": "En este dispositivo",
  "settings.about.note":
    "Los ajustes y el historial de lectura permanecen en este dispositivo. El escaneo, las solicitudes en línea y la lectura nunca suben datos personales.",

  "settings.online.urlTitle": "Lectura por URL en línea",
  "settings.online.urlDescription":
    "Admite manifiestos JSON y galerías HTML de una página. Si está desactivado, la biblioteca y el navegador te piden activarlo.",
  "settings.online.enableTitle": "Activar fuentes en línea",
  "settings.online.enableDescription":
    "Permite importar y leer desde manifiestos o galerías en línea; los capítulos importados se añaden a la biblioteca local.",
  "settings.online.enableNote":
    "El interruptor se guarda al instante; los parámetros de red de abajo se aplican tras pulsar «Guardar ajustes».",
  "settings.online.networkTitle": "Red y solicitudes",
  "settings.online.networkDescription":
    "El proxy, la concurrencia y las cabeceras se envían con las solicitudes en línea. Configura solo fuentes o pasarelas de confianza.",
  "settings.online.proxyLabel": "Dirección del proxy",
  "settings.online.proxyPlaceholder":
    "Vacío para conexión directa, o http://127.0.0.1:7890",
  "settings.online.detectProxy": "Proxy del sistema",
  "settings.online.detectProxyTitle":
    "Lee el proxy del sistema de Windows y lo rellena; no se guarda automáticamente",
  "settings.online.detecting": "Detectando…",
  "settings.online.proxyHint":
    "Compatible con http / https / socks5; vacío para conexión directa.",
  "settings.online.concurrencyLabel": "Concurrencia de páginas",
  "settings.online.concurrencyPlaceholder": "Elegir concurrencia",
  "settings.online.concurrencyItem": "{count} en paralelo",
  "settings.online.concurrencyHint":
    "1–8; más concurrencia es más rápido, pero la fuente puede limitarte.",
  "settings.online.headersLabel": "Cabeceras personalizadas",
  "settings.online.sessionActive": "Credenciales de sesión activas",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} o session=...; token=...',
  "settings.online.headersHint":
    "Las cabeceras se guardan en texto plano en los ajustes locales y se envían con las solicitudes a la fuente o pasarela configurada.",
  "settings.online.storageMode": "Modo de almacenamiento",
  "settings.online.storageModeDescription":
    "El modo de sesión no se escribe en la base de datos y se borra al salir de la aplicación.",
  "settings.online.storageModeGroup": "Modo de almacenamiento de cabeceras",
  "settings.online.memoryOnly": "Solo en memoria",
  "settings.online.persistLocal": "Guardar en local",
  "settings.online.sessionPresent":
    "Ahora mismo hay cabeceras en la memoria del proceso.",
  "settings.online.sessionAbsent": "No hay cabeceras de sesión.",
  "settings.online.clearSession": "Borrar credenciales en memoria",
  "settings.online.storageModeNote":
    "Las cabeceras de sesión solo permanecen en memoria y se aplican únicamente al primer sitio con el que se usan. Vuelve a introducirlas al cambiar de sitio.",
  "settings.online.testTitle": "Prueba de conectividad",
  "settings.online.testDescription":
    "Analiza el manifiesto o la galería solo como prueba; no escribe en la biblioteca.",
  "settings.online.testUrlAria":
    "URL de prueba de manifiesto o galería en línea",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "Probando…",
  "settings.online.testConnection": "Probar conexión",
  "settings.online.reachable": "Accesible",
  "settings.online.testSummary": "{title} · {pages} páginas · {ms} ms",
  "settings.online.testHint":
    "La prueba usa el proxy y las cabeceras guardados; guarda los cambios primero.",

  "settings.stats.loadError": "Error al cargar estadísticas: {detail}",
  "settings.stats.loading": "Resumiendo el historial de lectura local…",
  "settings.stats.totalBooks": "Libros totales",
  "settings.stats.reading": "En lectura",
  "settings.stats.todayPages": "Páginas hoy",
  "settings.stats.last7Pages": "Últimos 7 días",
  "settings.stats.unitBooks": "libros",
  "settings.stats.note":
    "Solo se cuentan las páginas realmente pasadas en el historial local; los libros sin abrir y el progreso no registrado no cuentan.",
  "settings.stats.title": "Biblioteca y estadísticas",
  "settings.stats.description":
    "Resumen del historial de lectura local; la carpeta y el escaneo de la biblioteca también viven aquí.",

  "settings.cache.budgetTitle": "Presupuesto de caché en memoria",
  "settings.cache.budgetDescription":
    "Un presupuesto de memoria mayor hace más fluido el cambio de página, pero usa más memoria del proceso.",
  "settings.cache.budgetLabel": "Presupuesto de caché en memoria",
  "settings.cache.budgetAria": "Presupuesto de caché en memoria (MB)",
  "settings.cache.budgetHint":
    "Se aplica a la caché de páginas y miniaturas en memoria al guardar.",
  "settings.cache.diskTitle": "Caché en disco",
  "settings.cache.diskDescription":
    "Las páginas renderizadas y los originales en línea comparten una caché en disco; los archivos antiguos se eliminan al superar el límite.",
  "settings.cache.diskLabel": "Límite de caché en disco",
  "settings.cache.diskAria": "Límite de caché en disco (MB)",
  "settings.cache.diskHint":
    "Se aplica al guardar; al bajar el límite, el exceso se limpia en accesos posteriores.",
  "settings.cache.diskUsage": "Uso en disco",
  "settings.cache.diskRender": "Caché de renderizado",
  "settings.cache.diskOnline": "Originales en línea",
  "settings.cache.diskEmpty": "Aún no hay estadísticas de caché en disco.",
  "settings.cache.memoryTitle": "Uso de memoria",
  "settings.cache.memoryDescription":
    "Instantánea de memoria y caché de esta ejecución.",
  "settings.cache.budgetUsage": "Uso del presupuesto de memoria",
  "settings.cache.process": "Proceso",
  "settings.cache.imageCache": "Caché de imágenes",
  "settings.cache.cachedPages": "Páginas en caché",
  "settings.cache.cachedThumbs": "Miniaturas de portada",
  "settings.cache.webtoonCache": "Caché de webtoon",
  "settings.cache.limit": "Límite de memoria",
  "settings.cache.empty": "Aún no hay estadísticas de memoria.",
  "settings.cache.pagesValue": "{count} páginas",
  "settings.cache.thumbsValue": "{count} miniaturas",
  "settings.cache.webtoonValue": "{size} · {count} fragmentos",
  "settings.cache.maintenanceTitle": "Mantenimiento de caché",
  "settings.cache.maintenanceDescription":
    "Lo borrado se reconstruye cuando hace falta, sin afectar a la biblioteca ni al progreso.",
  "settings.cache.clearThumbs": "Borrar caché de portadas",
  "settings.cache.clearing": "Borrando…",
  "settings.cache.clearPages": "Vaciar caché de páginas",
  "settings.cache.purging": "Limpiando…",
  "settings.cache.clearHint":
    "Las miniaturas de portada se regeneran al volver a abrir la biblioteca.",
  "settings.cache.clearTemp": "Vaciar caché temporal",
  "settings.cache.clearingTemp": "Vaciando…",
  "settings.cache.clearTempHint":
    "Borra las páginas en memoria, los archivos renderizados y los originales en línea; las portadas se reconstruyen cuando haga falta y la biblioteca y el progreso no se ven afectados.",
  "settings.cache.manageTitle": "Caché y cuota LRU",
  "settings.cache.manageDescription":
    "La caché de renderizado y las imágenes en línea comparten un límite LRU blando (500 MB – 10 GB); un clic borra la caché temporal.",
  "settings.online.proxyMode.system": "Proxy del sistema",
  "settings.online.proxyMode.manual": "Proxy manual",
  "settings.online.proxyMode.direct": "Directo",
  "settings.online.browserHint":
    "Para resolver una URL de manga o un canal de Telegram, abre la página del navegador y escríbela en la única barra de direcciones.",

  "settings.status.loading": "Cargando ajustes…",
  "settings.status.loadFailed": "Ajustes no cargados",
  "settings.status.saving": "Guardando ajustes…",
  "settings.status.dirty": "Cambios sin guardar",
  "settings.status.saved": "Todos los cambios guardados",
  "settings.status.saveHint": "Se guarda en los ajustes de este dispositivo",
  "settings.saveButton": "Guardar ajustes",

  "settings.errors.loadSettings": "Error al leer los ajustes",
  "settings.errors.loadStats": "Error al leer las estadísticas",
  "settings.errors.connectTest": "Error en la prueba de conexión",
  "settings.errors.loadSettingsDetail": "Error al cargar los ajustes: {detail}",

  "settings.toast.scanDone":
    "Escaneo completado. {count} libros en la biblioteca.",
  "settings.toast.scanErrors":
    "No se pudieron leer {count} entradas; se omitieron",
  "settings.toast.proxyFilled":
    "Proxy del sistema detectado y guardado",
  "settings.toast.proxyNotFound":
    "No se detectó ningún proxy del sistema activado",
  "settings.toast.sessionCleared": "Credenciales en memoria borradas",
  "settings.toast.urlRequired": "Introduce una URL de manifiesto o galería",
  "settings.toast.noReadablePages":
    "El manifiesto no tiene páginas legibles",
  "settings.toast.thumbsCleared":
    "Se borraron {count} miniaturas; se reconstruirán al reabrir la biblioteca",
  "settings.toast.pagesCleared": "Caché de páginas vaciada",
  "settings.toast.tempCleared":
    "Caché temporal vaciada; se liberaron {size}",
  "settings.toast.saved": "Ajustes guardados",

  "settings.backup.title": "Copia local y restauración",
  "settings.backup.description":
    "Empaqueta el índice de la biblioteca, el progreso de lectura y las preferencias en un solo archivo; exporta los datos actuales antes de restaurar.",
  "settings.backup.export": "Exportar copia local (.mrbackup / .zip)",
  "settings.backup.exporting": "Exportando…",
  "settings.backup.restore": "Restaurar desde copia",
  "settings.backup.restoring": "Restaurando…",
  "settings.backup.saveTitle": "Elegir dónde guardar la copia",
  "settings.backup.pickTitle": "Elegir un archivo de copia",
  "settings.backup.filterName": "Copia de Moyu",
  "settings.backup.note":
    "La copia incluye el índice de la biblioteca, el progreso y las estadísticas de lectura, las preferencias de tema/idioma/lector y las reglas de filtrado aprendidas. No incluye cachés de imágenes, cabeceras de sesión, cookies, eventos de filtrado ni marcas internas de versión. Restaurar sobrescribe la biblioteca y el progreso actuales, así que exporta primero.",
  "settings.backup.confirmTitle": "¿Restaurar desde esta copia?",
  "settings.backup.confirmMessage":
    "Esto sobrescribe la biblioteca, el progreso de lectura y las preferencias actuales, y no se puede deshacer. Archivo: {file}",
  "settings.backup.confirmRestore": "Restaurar copia",
  "settings.backup.exported": "Copia exportada: {books} libros · {size}",
  "settings.backup.restored":
    "Copia restaurada: {books} libros · {days} días de lectura",
  "settings.backup.applied":
    "Se aplicaron el tema, el idioma y las preferencias de lectura de la copia",
  "settings.backup.error":
    "La operación de copia falló. Inténtalo de nuevo.",
  "settings.about.buildOrigin": "Origen de compilación",
  "settings.about.buildOriginLabel": "Huella de origen de compilación",
  "settings.about.buildOriginOfficial": "Official Release",
  "settings.about.buildOriginCommunity": "Community Modified Build (Non-Commercial)",
  "settings.about.nonCommercial": "Solo no comercial (Non-Commercial Only)",
  "settings.backup.skippedTitle": "Algunos libros locales no se restauraron",
  "settings.backup.skippedHint":
    "La ruta de origen no existe, no es un manga legible o apunta a una carpeta sensible del sistema/usuario. No se añadió nada a la biblioteca ni se borró nada del disco.",
  "settings.backup.skippedReasonMissing": "Ruta inexistente o no disponible",
  "settings.backup.skippedReasonNotBook":
    "No es una carpeta/archivo de manga legible",
  "settings.backup.skippedReasonUnsafe":
    "Apunta a una carpeta sensible del sistema/usuario",
  "settings.backup.skippedCount":
    "No se restauraron {count} libros locales",
  "settings.backup.skipWarningTitle": "La restauración elimina parte del progreso",
  "settings.backup.skipWarningMessage":
    "{count} libros locales de esta copia no están accesibles ahora mismo (una unidad externa o una ubicación de red no está montada). Si continúas, se borrarán su progreso e historial de lectura de la biblioteca actual. Antes se guarda una instantánea de la biblioteca actual.",
  "settings.backup.forwardSchema": "La copia procede de una versión más reciente ({version}). La biblioteca y el progreso esenciales se restauraron en modo de compatibilidad; se ignoraron las opciones añadidas en versiones más recientes.",
  "settings.ca.title": "CA raíz y confianza del dispositivo",
  "settings.ca.description":
    "Inicializa y exporta la CA raíz y distribúyela brevemente por HTTP sin cifrar para que el teléfono la instale y confíe en el servicio HTTPS de este equipo.",
  "settings.ca.badgeNotInitialized": "CA no inicializada",
  "settings.ca.badgeInitialized": "CA inicializada",
  "settings.ca.notInitialized":
    "La CA local no está inicializada. La inicialización crea un certificado raíz nuevo; instálalo solo en dispositivos que controles y haz una copia de seguridad.",
  "settings.ca.initialize": "Inicializar CA local",
  "settings.ca.initializeConfirmTitle": "¿Inicializar la CA raíz local?",
  "settings.ca.initializeConfirmMessage":
    "Esto crea una CA raíz local nueva. Si se pierde, todos los dispositivos instalados deberán instalar de nuevo el certificado de confianza. No se sube nada.",
  "settings.ca.initialized": "CA local inicializada y ACL de la clave privada verificada.",
  "settings.ca.fingerprint": "Huella SHA-256 del certificado raíz",
  "settings.ca.fingerprintHint":
    "Antes de instalar en el teléfono, compara la huella SHA-256 completa: 64 caracteres hexadecimales, ignorando dos puntos y mayúsculas.",
  "settings.ca.verifyOnPhone":
    "Importante: el teléfono puede mostrar SHA-1 o SHA-256. Cambia a SHA-256 y compara cada grupo con el valor superior. No instales si no coinciden.",
  "settings.ca.copyFingerprint": "Copiar huella",
  "settings.ca.copied": "Copiado",
  "settings.ca.copyFailed": "No se pudo copiar; selecciona el texto y cópialo manualmente.",
  "settings.ca.expires": "La raíz caduca: {date} ({days} días restantes)",
  "settings.ca.rotationWarning":
    "La CA raíz entra en su ventana de rotación en {days} días. Tras la rotación, redistribúyela y reinstálala en todos los dispositivos.",
  "settings.ca.intermediateFingerprint": "Huella de la CA intermedia (diagnóstico)",
  "settings.ca.export": "Exportar certificado raíz",
  "settings.ca.exportTitle": "Guardar certificado raíz",
  "settings.ca.exported": "Certificado raíz exportado; verifica la huella antes de instalarlo.",
  "settings.ca.exportFailed": "No se pudo exportar el certificado raíz. Inténtalo de nuevo.",
  "settings.ca.loadError": "No se pudo cargar el estado de la CA: {detail}",
  "settings.ca.distribution.title": "Distribución temporal",
  "settings.ca.distribution.description":
    "Tras un inicio explícito, solo se ofrece el certificado raíz. El servicio usa HTTP sin cifrar (el teléfono no puede verificar HTTPS antes de confiar en la CA) y se cierra automáticamente a los 120 segundos.",
  "settings.ca.distribution.address": "Dirección de distribución",
  "settings.ca.distribution.start": "Iniciar distribución",
  "settings.ca.distribution.stop": "Detener distribución",
  "settings.ca.distribution.running": "En ejecución",
  "settings.ca.distribution.stopped": "Detenido",
  "settings.ca.distribution.url": "URL de descarga",
  "settings.ca.distribution.expiresIn": "Quedan {seconds} segundos",
  "settings.ca.distribution.expired": "El servicio de distribución caducó y se cerró automáticamente.",
  "settings.ca.distribution.securityNote":
    "Solo se sirve el certificado raíz público. Úsalo solo en una LAN de confianza; la URL es HTTP sin cifrar, así que no la expongas a redes no confiables.",
  "settings.ca.distribution.noAddress":
    "No hay ninguna dirección IPv4 privada de LAN disponible; no se puede iniciar la distribución.",
  "settings.ca.privateKeyNote":
    "La clave privada de la CA permanece en el directorio local de la CA; la tarea HTTP no puede leerla.",

  "settings.webAccess.unknownDevice": "Dispositivo desconocido",
  "settings.webAccess.networkHint":
    "Si el Firewall de Windows bloquea la conexión, permite el acceso entrante de esta aplicación en redes privadas. Solo HTTPS requiere confiar en el certificado local.",
  "settings.webAccess.title": "Lectura en red local",
  "settings.webAccess.description":
    "Escanea el código o introduce la dirección y aprueba el dispositivo en el ordenador. El servicio está desactivado por defecto.",
  "settings.webAccess.statusTitle": "Estado del servicio",
  "settings.webAccess.refresh": "Actualizar estado",
  "settings.webAccess.loadError":
    "No se pudo cargar el estado de Web Access: {detail}",
  "settings.webAccess.phase.disabled": "Desactivado",
  "settings.webAccess.phase.starting": "Iniciando",
  "settings.webAccess.phase.enabled": "Activo",
  "settings.webAccess.phase.stopping": "Deteniendo",
  "settings.webAccess.phase.error": "Error",
  "settings.webAccess.caRequired":
    "El modo HTTPS requiere inicializar primero la CA local en «CA raíz y confianza del dispositivo».",
  "settings.webAccess.safeModeBlocked":
    "El modo seguro está activo. Web Access se ha detenido y no se puede iniciar hasta que salgas del modo seguro.",
  "settings.webAccess.address": "Dirección de escucha",
  "settings.webAccess.noAddress":
    "No hay ninguna dirección IPv4 privada de red local disponible",
  "settings.webAccess.bindAddress": "Dirección vinculada",
  "settings.webAccess.port": "Puerto real",
  "settings.webAccess.deviceCount": "Dispositivos vinculados: {count}",
  "settings.webAccess.pendingCount": "Solicitudes pendientes: {count}",
  "settings.webAccess.notRunning":
    "El servicio no está activo; inícialo para generar el código QR de vinculación.",
  "settings.webAccess.start": "Iniciar servicio",
  "settings.webAccess.httpWarning": "HTTP local no está cifrado. Otros dispositivos de la red pueden leer o modificar el contenido y la sesión. Úsalo solo en redes de confianza.",
  "settings.webAccess.startSecure": "Avanzado: usar HTTPS",
  "settings.webAccess.plainPairHint": "Escanea el código o introduce la dirección y aprueba el dispositivo aquí. No se necesita certificado.",
  "settings.webAccess.starting": "Iniciando",
  "settings.webAccess.stop": "Detener servicio",
  "settings.webAccess.stopping": "Deteniendo",
  "settings.webAccess.stopConfirmTitle": "¿Detener Web Access?",
  "settings.webAccess.stopConfirmMessage":
    "Al detener se desconectan todos los dispositivos vinculados, se cancela la ventana de vinculación actual y se cierra el puerto. Puedes volver a iniciarlo desde este panel.",
  "settings.webAccess.stopReasonTitle": "Motivo de la detención",
  "settings.webAccess.stopReason.stopped":
    "Detenido manualmente por el usuario",
  "settings.webAccess.stopReason.safeMode":
    "Detenido al entrar en modo seguro",
  "settings.webAccess.stopReason.recovery":
    "Detenido durante la recuperación",
  "settings.webAccess.stopReason.exit":
    "Detenido al salir de la aplicación",
  "settings.webAccess.lastError": "Último error: {detail}",
  "settings.webAccess.rootFingerprint": "Huella SHA-256 de la CA raíz",
  "settings.webAccess.leafFingerprint":
    "Huella SHA-256 del certificado hoja",
  "settings.webAccess.leafExpires": "El certificado hoja caduca: {date}",
  "settings.webAccess.copyFingerprint": "Copiar huella",
  "settings.webAccess.pairingTitle": "Vinculación de dispositivos",
  "settings.webAccess.pairingDescription":
    "Al empezar se crea una ventana de vinculación de 120 segundos; después de escanear el código QR o abrir el enlace, confirma cada solicitud en este panel.",
  "settings.webAccess.pairingStart": "Iniciar vinculación",
  "settings.webAccess.pairingCancel": "Cancelar vinculación",
  "settings.webAccess.pairingCountdown": "Quedan {seconds} s",
  "settings.webAccess.pairingExpired":
    "La ventana de vinculación ha caducado. Iníciala de nuevo.",
  "settings.webAccess.qrAlt": "Código QR de vinculación de Web Access",
  "settings.webAccess.qrHint":
    "El código QR solo contiene el enlace de esta vinculación; escanéalo con la cámara del teléfono y no compartas capturas.",
  "settings.webAccess.copyUrl": "Copiar enlace",
  "settings.webAccess.copied": "Copiado",
  "settings.webAccess.copyFailed":
    "No se pudo copiar. Selecciona el texto y cópialo manualmente.",
  "settings.webAccess.claimsTitle": "Solicitudes pendientes",
  "settings.webAccess.claimsEmpty":
    "No hay solicitudes de vinculación pendientes.",
  "settings.webAccess.claimCount": "{count} pendientes",
  "settings.webAccess.unverifiedDevice": "Nombre sin verificar",
  "settings.webAccess.sourceIp":
    "IP de origen (observada por el servidor)",
  "settings.webAccess.receivedAt": "Recibida: {time}",
  "settings.webAccess.claimExpiresIn": "La solicitud caduca en {seconds} s",
  "settings.webAccess.claimExpired": "Solicitud caducada",
  "settings.webAccess.cancelRequest": "Cancelar solicitud",
  "settings.webAccess.approve": "Aprobar",
  "settings.webAccess.deny": "Rechazar",
  "settings.webAccess.approveConfirmTitle": "¿Aprobar este dispositivo?",
  "settings.webAccess.approveConfirmMessage":
    "Vas a autorizar que «{name}» se conecte a este equipo y pueda explorar o leer toda su biblioteca y el progreso de lectura. El nombre lo declara el propio teléfono y no demuestra su identidad; aprueba solo si tú iniciaste esta vinculación.",
  "settings.webAccess.approvePlainHttpWarning":
    "HTTP sin cifrar permite que los dispositivos de esta red local lleguen al servicio. Continúa solo en una red de confianza y para un dispositivo en el que confíes.",
  "settings.webAccess.cancelStart": "Cancelar inicio",
  "settings.webAccess.cancelingStart": "Cancelando…",
  "settings.webAccess.devicesTitle": "Dispositivos vinculados",
  "settings.webAccess.devicesEmpty":
    "Todavía no hay dispositivos vinculados. Un dispositivo aparece aquí en cuanto se aprueba su vinculación y abre el lector.",
  "settings.webAccess.deviceIp": "Dirección LAN: {ip}",
  "settings.webAccess.deviceLastActive": "Última actividad: {date}",
  "settings.webAccess.devicesMemoryNote":
    "Las sesiones solo viven en memoria: al detener el servicio LAN o salir de la aplicación, todos los dispositivos se desconectan y se borran.",
  "settings.webAccess.deviceIssued": "Emitido: {date}",
  "settings.webAccess.deviceExpires": "Caduca: {date}",
  "settings.webAccess.revoke": "Revocar",
  "settings.webAccess.revokeConfirmTitle": "¿Revocar este dispositivo?",
  "settings.webAccess.revokeConfirmMessage":
    "Al revocar «{name}» se corta su acceso de inmediato y tendrá que vincularse de nuevo.",
  "settings.webAccess.securityNote":
    "El nombre del dispositivo lo declara el teléfono y puede cambiarse; este proyecto no tiene SAS ni vínculo criptográfico, y la aprobación manual en el escritorio es la única autorización. No consideres un dispositivo verificado solo porque aparezca en la lista.",

  "settings.autoSaved": "Guardado automáticamente",
  "settings.autoSaving": "Guardando…",
  "settings.autoSaveFailed": "Error al guardar",
  "settings.filter.blockedShort": "{count} bloqueados",
};

const ja: SettingsMessages = {
  "settings.features.title": "機能スイッチ",
  "settings.features.description":
    "各機能を個別にオン・オフできます。オフにすると入口が非表示になり、バックエンド呼び出しは拒否されます。変更は即時反映されます。",
  "settings.features.browser.description":
    "サイト検証とダウンロード取り込み用の補助ブラウザー。オフにすると上部バーの入口が非表示になります。",
  "settings.features.pdf.title": "PDF 閲覧",
  "settings.features.pdf.description":
    "ローカル PDF の読み取りと描画。オフにしても既存の PDF は残りますが、開くと機能が無効である旨が表示されます。",
  "settings.page.eyebrow": "環境設定",
  "settings.page.description":
    "外観、オンラインソース、読書統計、キャッシュはこのデバイスで管理されます。",
  "settings.page.localFirst": "ローカル優先",
  "settings.page.loading": "設定を読み込み中",

  "settings.tabs.label": "設定セクション",
  "settings.tabs.general": "一般と外観",
  "settings.tabs.online": "オンライン",
  "settings.tabs.reading": "統計",
  "settings.tabs.cache": "キャッシュ",
  "settings.tabs.network": "ネットワークとソース",
  "settings.tabs.storage": "ストレージとデータ",
  "settings.tabs.privacy": "プライバシーとセキュリティ",
  "settings.tabs.about": "情報とメンテナンス",

  "settings.shortcuts.title": "グローバルショートカット",
  "settings.shortcuts.description":
    "入力欄にフォーカスがある、または IME 変換中（isComposing / keyCode 229）は、Ctrl/Cmd+W 以外のグローバルショートカットは動作しません。",
  "settings.shortcuts.note":
    "ショートカットを使う前にフォーカスを外してください。Ctrl/Cmd+W（ウィンドウを閉じる）だけが例外です。",
  "settings.shortcuts.command": "Ctrl/Cmd+K でコマンドセンターを開く",

  "settings.language.title": "表示言語",
  "settings.language.description":
    "UI の言語を選択します。切り替えはすぐに反映され、このデバイスに保存されるため、保存操作は不要です。",
  "settings.language.label": "表示言語",

  "settings.theme.title": "外観テーマ",
  "settings.tray.title": "ウィンドウとトレイ",
  "settings.tray.description":
    "LAN リーディングの実行中は、メインウィンドウを閉じてもシステムトレイに残してバックグラウンドで配信を続けられます。",
  "settings.tray.closeToTray": "メインウィンドウを閉じるときにトレイへ最小化",
  "settings.tray.closeToTrayHint":
    "有効にすると、閉じる（×）はウィンドウを隠すだけになります。完全に終了するにはトレイメニューから終了してください。",
  "settings.theme.description":
    "配色を選択します。切り替えはすぐに反映され、ローカル設定とデータベースに同期されます。",
  "settings.theme.groupLabel": "テーマモード",
  "settings.theme.systemHint": "システムの明暗に追従",
  "settings.theme.lightHint": "アイスブルーのキャンバス",
  "settings.theme.darkHint": "深夜のコックピット",
  "settings.theme.systemNote":
    "「システム」は OS のライト / ダークに合わせて自動で切り替わります。",


  "settings.experimental.webtoonTitle": "Webtoon モード",
  "settings.experimental.webtoonDescription":
    "縦長作品を途切れず縦スクロール。単ページ / 見開きに続く第 3 のレイアウトです。",

  "settings.toast.featureOn": "{feature}をオンにしました",
  "settings.toast.featureOff": "{feature}をオフにしました",

  "settings.library.title": "ライブラリフォルダー",
  "settings.library.description":
    "漫画のあるフォルダーを指定します。スキャンで新しい本をこのデバイスのライブラリに追加します。",
  "settings.library.dirLabel": "スキャンフォルダー",
  "settings.library.dirPlaceholder": "D:\\Manga または /path/to/manga",
  "settings.library.pick": "選択",
  "settings.library.pickTitle": "漫画フォルダーを選択",
  "settings.library.clearDir": "フォルダーをクリア",
  "settings.library.scanning": "スキャン中…",
  "settings.library.scanNow": "今すぐスキャン",
  "settings.library.scanHint":
    "上のフォルダーを使ってスキャンします。保存は不要で、結果は通知で表示されます。",

  "settings.about.title": "このアプリについて",
  "settings.about.description":
    "Moyu は、漫画の閲覧と書庫管理のための無料デスクトップアプリです。",
  "settings.about.version": "バージョン",
  "settings.about.commit": "ビルドコミット",
  "settings.about.storage": "設定の保存先",
  "settings.about.storageValue": "ローカル SQLite",
  "settings.about.dataFlow": "データの行き先",
  "settings.about.dataFlowValue": "デバイス内のみ",
  "settings.about.note":
    "設定と読書履歴はこのデバイスに保存されます。スキャン、オンラインリクエスト、閲覧で個人データをアップロードすることはありません。",

  "settings.online.urlTitle": "オンライン URL 直読み",
  "settings.online.urlDescription":
    "JSON マニフェストと単ページ HTML ギャラリーに対応。オフの場合、ライブラリとブラウザーで有効化を促します。",
  "settings.online.enableTitle": "オンラインソースを有効化",
  "settings.online.enableDescription":
    "オンラインのマニフェスト / ギャラリーからインポートして閲覧できます。取り込んだ話はローカルライブラリに追加されます。",
  "settings.online.enableNote":
    "切り替えはすぐに保存されます。下のネットワーク設定は下部の「設定を保存」で反映されます。",
  "settings.online.networkTitle": "ネットワークとリクエスト",
  "settings.online.networkDescription":
    "プロキシ、並列数、ヘッダーはオンラインリクエストとともに送信されます。信頼できるソースかゲートウェイのみ設定してください。",
  "settings.online.proxyLabel": "プロキシアドレス",
  "settings.online.proxyPlaceholder":
    "空欄で直接接続、または http://127.0.0.1:7890",
  "settings.online.detectProxy": "システムプロキシ",
  "settings.online.detectProxyTitle":
    "Windows のシステムプロキシを読み取って入力します。自動保存はされません",
  "settings.online.detecting": "検出中…",
  "settings.online.proxyHint":
    "http / https / socks5 に対応。空欄は直接接続です。",
  "settings.online.concurrencyLabel": "ページ並列数",
  "settings.online.concurrencyPlaceholder": "並列数を選択",
  "settings.online.concurrencyItem": "{count} 並列",
  "settings.online.concurrencyHint":
    "1–8。高いほど速くなりますが、ソース側の制限を受けやすくなります。",
  "settings.online.headersLabel": "カスタムヘッダー",
  "settings.online.sessionActive": "セッション認証情報が有効",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} または session=...; token=...',
  "settings.online.headersHint":
    "ヘッダーはローカル設定に平文で保存され、設定したソースやゲートウェイへのリクエストに付与されます。",
  "settings.online.storageMode": "保存モード",
  "settings.online.storageModeDescription":
    "セッションモードはデータベースに書き込まれず、アプリ終了時に消去されます。",
  "settings.online.storageModeGroup": "ヘッダーの保存モード",
  "settings.online.memoryOnly": "メモリのみ",
  "settings.online.persistLocal": "ローカルに保存",
  "settings.online.sessionPresent":
    "現在、ヘッダーはプロセスメモリに保存されています。",
  "settings.online.sessionAbsent": "現在セッションヘッダーはありません。",
  "settings.online.clearSession": "メモリ上の認証情報を消去",
  "settings.online.storageModeNote":
    "セッションヘッダーはメモリのみに保持され、最初に使用したサイトにのみ適用されます。サイトを切り替えたら再入力してください。",
  "settings.online.testTitle": "接続テスト",
  "settings.online.testDescription":
    "対象のマニフェストやギャラリーを解析するだけで、ライブラリには書き込みません。",
  "settings.online.testUrlAria":
    "オンラインマニフェストまたはギャラリーのテスト URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "テスト中…",
  "settings.online.testConnection": "接続をテスト",
  "settings.online.reachable": "接続可能",
  "settings.online.testSummary": "{title} · {pages} ページ · {ms} ms",
  "settings.online.testHint":
    "テストは保存済みのプロキシとヘッダーを使用します。変更後は先に保存してください。",

  "settings.stats.loadError": "読書統計の読み込みに失敗しました：{detail}",
  "settings.stats.loading": "ローカルの読書履歴を集計中…",
  "settings.stats.totalBooks": "総蔵書",
  "settings.stats.reading": "読書中",
  "settings.stats.todayPages": "今日のページ",
  "settings.stats.last7Pages": "過去 7 日間",
  "settings.stats.unitBooks": "冊",
  "settings.stats.note":
    "ローカルの読書履歴で実際にめくったページのみを集計します。未開封の本や記録されていない進捗は含みません。",
  "settings.stats.title": "ライブラリと読書統計",
  "settings.stats.description":
    "端末内の読書記録の概要。ライブラリーフォルダーとスキャンもここに統合されています。",

  "settings.cache.budgetTitle": "メモリキャッシュ予算",
  "settings.cache.budgetDescription":
    "メモリ予算を増やすとページめくりが滑らかになりますが、プロセスのメモリ使用量も増えます。",
  "settings.cache.budgetLabel": "メモリキャッシュ予算",
  "settings.cache.budgetAria": "メモリキャッシュ予算（MB）",
  "settings.cache.budgetHint":
    "保存後、ページとサムネイルのメモリキャッシュにすぐ適用されます。",
  "settings.cache.diskTitle": "ディスクキャッシュ",
  "settings.cache.diskDescription":
    "レンダリング画像とオンライン原画は同じディスクキャッシュを共有し、上限を超えると古いファイルから自動削除されます。",
  "settings.cache.diskLabel": "ディスクキャッシュ上限",
  "settings.cache.diskAria": "ディスクキャッシュ上限（MB）",
  "settings.cache.diskHint":
    "保存後すぐに適用されます。上限を下げた場合、超過分は以降のアクセス時に整理されます。",
  "settings.cache.diskUsage": "ディスク使用量",
  "settings.cache.diskRender": "レンダリングキャッシュ",
  "settings.cache.diskOnline": "オンライン原画",
  "settings.cache.diskEmpty": "ディスクキャッシュの統計はまだありません。",
  "settings.cache.memoryTitle": "メモリ使用量",
  "settings.cache.memoryDescription":
    "今回の実行のメモリとキャッシュのスナップショット。",
  "settings.cache.budgetUsage": "メモリ予算の使用率",
  "settings.cache.process": "プロセス",
  "settings.cache.imageCache": "画像キャッシュ",
  "settings.cache.cachedPages": "キャッシュ済みページ",
  "settings.cache.cachedThumbs": "表紙サムネイル",
  "settings.cache.webtoonCache": "Webtoon キャッシュ",
  "settings.cache.limit": "メモリ上限",
  "settings.cache.empty": "メモリ統計はまだありません。",
  "settings.cache.pagesValue": "{count} ページ",
  "settings.cache.thumbsValue": "{count} 枚",
  "settings.cache.webtoonValue": "{size} · {count} タイル",
  "settings.cache.maintenanceTitle": "キャッシュの保守",
  "settings.cache.maintenanceDescription":
    "消去後は必要に応じて再構築され、ライブラリや読書進捗には影響しません。",
  "settings.cache.clearThumbs": "表紙キャッシュを消去",
  "settings.cache.clearing": "消去中…",
  "settings.cache.clearPages": "ページキャッシュを空にする",
  "settings.cache.purging": "クリーンアップ中…",
  "settings.cache.clearHint":
    "表紙キャッシュは、次にライブラリを開いたときに自動で再生成されます。",
  "settings.cache.clearTemp": "一時キャッシュを一括削除",
  "settings.cache.clearingTemp": "削除中…",
  "settings.cache.clearTempHint":
    "メモリ上のページ、レンダリング済みファイル、オンライン原画を削除します。表紙は必要に応じて再生成され、ライブラリと読書進捗には影響しません。",
  "settings.cache.manageTitle": "キャッシュと LRU 上限",
  "settings.cache.manageDescription":
    "レンダーキャッシュとオンライン画像キャッシュは同じ LRU 上限（500 MB ～ 10 GB）を共有。ワンクリックで一時キャッシュを削除できます。",
  "settings.online.proxyMode.system": "システムプロキシに従う",
  "settings.online.proxyMode.manual": "手動プロキシ",
  "settings.online.proxyMode.direct": "直接接続",
  "settings.online.browserHint":
    "漫画 URL や Telegram チャンネルの解析は「ブラウザー」ページ上部の唯一のアドレスバーから行ってください。",

  "settings.status.loading": "設定を読み込み中…",
  "settings.status.loadFailed": "設定が未読み込み",
  "settings.status.saving": "設定を保存中…",
  "settings.status.dirty": "未保存の変更があります",
  "settings.status.saved": "すべての変更を保存済み",
  "settings.status.saveHint": "保存するとこのデバイスの設定に書き込まれます",
  "settings.saveButton": "設定を保存",

  "settings.errors.loadSettings": "設定の読み取りに失敗しました",
  "settings.errors.loadStats": "統計の読み取りに失敗しました",
  "settings.errors.connectTest": "接続テストに失敗しました",
  "settings.errors.loadSettingsDetail":
    "設定の読み込みに失敗しました：{detail}",

  "settings.toast.scanDone":
    "スキャン完了。ライブラリに {count} 冊あります。",
  "settings.toast.scanErrors":
    "{count} 件を読み込めずスキップしました",
  "settings.toast.proxyFilled":
    "システムプロキシを検出して保存しました",
  "settings.toast.proxyNotFound": "有効なシステムプロキシが見つかりません",
  "settings.toast.sessionCleared": "メモリ上の認証情報を消去しました",
  "settings.toast.urlRequired":
    "マニフェストまたはギャラリーの URL を入力してください",
  "settings.toast.noReadablePages":
    "マニフェストに読めるページがありません",
  "settings.toast.thumbsCleared":
    "{count} 件の表紙キャッシュを消去しました。ライブラリを開き直すと再生成されます",
  "settings.toast.pagesCleared": "ページキャッシュを空にしました",
  "settings.toast.tempCleared":
    "一時キャッシュを削除し、{size} を解放しました",
  "settings.toast.saved": "設定を保存しました",

  "settings.backup.title": "ローカルバックアップと復元",
  "settings.backup.description":
    "書庫インデックス、読書進捗、設定を 1 つのバックアップファイルにまとめます。復元の前に現在のデータをエクスポートしてください。",
  "settings.backup.export": "ローカルバックアップを書き出す (.mrbackup / .zip)",
  "settings.backup.exporting": "書き出し中…",
  "settings.backup.restore": "バックアップから復元",
  "settings.backup.restoring": "復元中…",
  "settings.backup.saveTitle": "バックアップの保存先を選択",
  "settings.backup.pickTitle": "バックアップファイルを選択",
  "settings.backup.filterName": "Moyu バックアップ",
  "settings.backup.note":
    "バックアップには書庫インデックス、読書進捗、読書統計、テーマ/言語/リーダー設定、自動学習したフィルタールールが含まれます。画像キャッシュ、セッションのリクエストヘッダー、Cookie、フィルターイベント、内部バージョン印は含まれません。復元すると現在の書庫と読書進捗が上書きされるため、先に書き出すことをおすすめします。",
  "settings.backup.confirmTitle": "このバックアップから復元しますか？",
  "settings.backup.confirmMessage":
    "現在の書庫、読書進捗、設定が上書きされ、元に戻せません。バックアップファイル: {file}",
  "settings.backup.confirmRestore": "バックアップから復元",
  "settings.backup.exported": "バックアップを書き出しました: {books} 冊 · {size}",
  "settings.backup.restored":
    "バックアップから復元しました: {books} 冊 · {days} 日分の読書記録",
  "settings.backup.applied":
    "バックアップのテーマ、言語、リーダー設定を適用しました",
  "settings.backup.error":
    "バックアップ操作に失敗しました。もう一度お試しください。",
  "settings.about.buildOrigin": "ビルド由来",
  "settings.about.buildOriginLabel": "ビルド由来フィンガープリント",
  "settings.about.buildOriginOfficial": "Official Release",
  "settings.about.buildOriginCommunity": "Community Modified Build (Non-Commercial)",
  "settings.about.nonCommercial": "非商用ライセンス (Non-Commercial Only)",
  "settings.backup.skippedTitle": "一部のローカル書籍を復元できませんでした",
  "settings.backup.skippedHint":
    "元のパスが存在しない、読める漫画ではない、またはシステム/ユーザーの重要なフォルダーを指しています。書庫には追加せず、ディスク上の内容も削除していません。",
  "settings.backup.skippedReasonMissing": "パスが存在しないか使用できません",
  "settings.backup.skippedReasonNotBook":
    "読み取り可能な漫画フォルダー/アーカイブではありません",
  "settings.backup.skippedReasonUnsafe":
    "システム/ユーザーの重要なフォルダーを指しています",
  "settings.backup.skippedCount":
    "{count} 冊のローカル書籍を復元できませんでした",
  "settings.backup.skipWarningTitle": "復元すると一部の進捗が失われます",
  "settings.backup.skipWarningMessage":
    "このバックアップには現在アクセスできないローカル書籍が {count} 冊あります（外付けドライブやネットワークの場所が未接続）。続行すると、現在のライブラリからこれらの読書進捗と履歴が削除されます。復元前に現在のライブラリのスナップショットを保存します。",
  "settings.backup.forwardSchema": "新しいバージョン（{version}）で書き出されたバックアップです。互換モードで中核のライブラリと進捗を復元し、新バージョンで追加された設定は無視しました。",
  "settings.ca.title": "ルート CA とデバイス信頼",
  "settings.ca.description":
    "ルート CA を初期化・エクスポートし、短時間だけ平文 HTTP で配布して、スマートフォンが本機の HTTPS サービスを信頼できるようにします。",
  "settings.ca.badgeNotInitialized": "CA 未初期化",
  "settings.ca.badgeInitialized": "CA 初期化済み",
  "settings.ca.notInitialized":
    "ローカル CA は未初期化です。初期化すると新しいルート証明書が作成されます。管理下の端末にのみインストールし、CA をバックアップしてください。",
  "settings.ca.initialize": "ローカル CA を初期化",
  "settings.ca.initializeConfirmTitle": "ローカルルート CA を初期化しますか？",
  "settings.ca.initializeConfirmMessage":
    "新しいローカルルート CA を作成します。CA を失うと、インストール済みの全端末で信頼証明書の再インストールが必要です。データはアップロードされません。",
  "settings.ca.initialized": "ローカル CA を初期化し、秘密鍵 ACL を検証しました。",
  "settings.ca.fingerprint": "ルート証明書の SHA-256 フィンガープリント",
  "settings.ca.fingerprintHint":
    "スマートフォンへのインストール前に、SHA-256 フィンガープリント全体を照合してください。16 進数 64 文字で、コロンと大文字小文字は無視します。",
  "settings.ca.verifyOnPhone":
    "重要: スマートフォン側は SHA-1 を表示する場合があります。SHA-256 表示に切り替え、上の値と全グループを照合してください。一致しない場合はインストールしないでください。",
  "settings.ca.copyFingerprint": "フィンガープリントをコピー",
  "settings.ca.copied": "コピーしました",
  "settings.ca.copyFailed": "コピーできませんでした。テキストを選択して手動でコピーしてください。",
  "settings.ca.expires": "ルートの有効期限: {date}（残り {days} 日）",
  "settings.ca.rotationWarning":
    "ルート CA は {days} 日後にローテーション期間に入ります。ローテーション後は全端末へ再配布・再インストールが必要です。",
  "settings.ca.intermediateFingerprint": "中間 CA フィンガープリント（診断用）",
  "settings.ca.export": "ルート証明書をエクスポート",
  "settings.ca.exportTitle": "ルート証明書を保存",
  "settings.ca.exported": "ルート証明書をエクスポートしました。インストール前にフィンガープリントを確認してください。",
  "settings.ca.exportFailed": "ルート証明書のエクスポートに失敗しました。再試行してください。",
  "settings.ca.loadError": "CA 状態を読み込めませんでした: {detail}",
  "settings.ca.distribution.title": "短時間配布サービス",
  "settings.ca.distribution.description":
    "明示的に開始した場合のみ、ルート証明書だけを配布します。スマートフォンは CA を信頼する前に HTTPS を検証できないため平文 HTTP を使用し、120 秒後に自動停止します。",
  "settings.ca.distribution.address": "配布アドレス",
  "settings.ca.distribution.start": "配布を開始",
  "settings.ca.distribution.stop": "配布を停止",
  "settings.ca.distribution.running": "実行中",
  "settings.ca.distribution.stopped": "停止済み",
  "settings.ca.distribution.url": "ダウンロード URL",
  "settings.ca.distribution.expiresIn": "残り {seconds} 秒",
  "settings.ca.distribution.expired": "配布サービスは期限切れとなり、自動的に停止しました。",
  "settings.ca.distribution.securityNote":
    "公開ルート証明書のみを配布します。信頼できる LAN でのみ使用してください。URL は平文 HTTP のため、信頼できないネットワークに公開しないでください。",
  "settings.ca.distribution.noAddress":
    "利用可能なプライベート LAN IPv4 アドレスがないため、配布を開始できません。",
  "settings.ca.privateKeyNote":
    "CA 秘密鍵はローカル CA ディレクトリにのみ保存され、HTTP 配布タスクは読み取れません。",

  "settings.webAccess.unknownDevice": "不明なデバイス",
  "settings.webAccess.networkHint":
    "Windows ファイアウォールが接続を遮断する場合は、プライベートネットワークでこのアプリの受信を許可してください。ローカル証明書の信頼設定が必要なのは HTTPS モードだけです。",
  "settings.webAccess.title": "ローカルネットワーク閲覧",
  "settings.webAccess.description":
    "コードを読み取るかアドレスを入力し、パソコンで端末を承認すると閲覧できます。サービスは既定でオフです。",
  "settings.webAccess.statusTitle": "サービスの状態",
  "settings.webAccess.refresh": "状態を更新",
  "settings.webAccess.loadError":
    "Web Access の状態を読み込めませんでした：{detail}",
  "settings.webAccess.phase.disabled": "無効",
  "settings.webAccess.phase.starting": "起動中",
  "settings.webAccess.phase.enabled": "稼働中",
  "settings.webAccess.phase.stopping": "停止中",
  "settings.webAccess.phase.error": "エラー",
  "settings.webAccess.caRequired":
    "HTTPS モードでは、先に「ルート CA と端末の信頼」でローカル CA を初期化してください。",
  "settings.webAccess.safeModeBlocked":
    "セーフモードが有効です。Web Access は停止されており、セーフモードを終了するまで再起動できません。",
  "settings.webAccess.address": "待ち受けアドレス",
  "settings.webAccess.noAddress":
    "利用可能なプライベート LAN IPv4 アドレスが見つかりません",
  "settings.webAccess.bindAddress": "バインドアドレス",
  "settings.webAccess.port": "実際のポート",
  "settings.webAccess.deviceCount": "ペアリング済み端末：{count}",
  "settings.webAccess.pendingCount": "承認待ちの要求：{count}",
  "settings.webAccess.notRunning":
    "サービスは停止しています。起動するとペアリング用 QR コードを生成できます。",
  "settings.webAccess.start": "サービスを起動",
  "settings.webAccess.httpWarning": "ローカル HTTP は暗号化されません。同じネットワークの機器が内容やセッションを読み取り、改ざんする可能性があります。信頼できるネットワークでのみ使用してください。",
  "settings.webAccess.startSecure": "詳細：HTTPS を使用",
  "settings.webAccess.plainPairHint": "コードを読み取るかアドレスを入力し、ここで端末を承認します。証明書は不要です。",
  "settings.webAccess.starting": "起動中",
  "settings.webAccess.stop": "サービスを停止",
  "settings.webAccess.stopping": "停止中",
  "settings.webAccess.stopConfirmTitle": "Web Access を停止しますか？",
  "settings.webAccess.stopConfirmMessage":
    "停止すると、ペアリング済みの端末はすべて切断され、現在のペアリングウィンドウは取り消され、待ち受けポートが閉じます。必要ならこのパネルから再起動できます。",
  "settings.webAccess.stopReasonTitle": "停止理由",
  "settings.webAccess.stopReason.stopped": "ユーザーによる手動停止",
  "settings.webAccess.stopReason.safeMode":
    "セーフモード移行のため停止",
  "settings.webAccess.stopReason.recovery": "クラッシュ復旧のため停止",
  "settings.webAccess.stopReason.exit": "アプリ終了のため停止",
  "settings.webAccess.lastError": "直近のエラー：{detail}",
  "settings.webAccess.rootFingerprint":
    "ルート CA の SHA-256 フィンガープリント",
  "settings.webAccess.leafFingerprint":
    "リーフ証明書の SHA-256 フィンガープリント",
  "settings.webAccess.leafExpires": "リーフ証明書の有効期限：{date}",
  "settings.webAccess.copyFingerprint": "フィンガープリントをコピー",
  "settings.webAccess.pairingTitle": "端末のペアリング",
  "settings.webAccess.pairingDescription":
    "開始すると 120 秒間有効なペアリングウィンドウが作成されます。スマートフォンで QR コードを読み取るかリンクを開いた後、このパネルで 1 件ずつ確認してください。",
  "settings.webAccess.pairingStart": "ペアリングを開始",
  "settings.webAccess.pairingCancel": "ペアリングを中止",
  "settings.webAccess.pairingCountdown": "残り {seconds} 秒",
  "settings.webAccess.pairingExpired":
    "ペアリングウィンドウの有効期限が切れました。もう一度開始してください。",
  "settings.webAccess.qrAlt": "Web Access のペアリング QR コード",
  "settings.webAccess.qrHint":
    "QR コードにはこのペアリングのリンクだけが含まれます。スマートフォンのカメラで読み取り、スクリーンショットを共有しないでください。",
  "settings.webAccess.copyUrl": "リンクをコピー",
  "settings.webAccess.copied": "コピーしました",
  "settings.webAccess.copyFailed":
    "コピーできませんでした。テキストを選択して手動でコピーしてください。",
  "settings.webAccess.claimsTitle": "承認待ちの要求",
  "settings.webAccess.claimsEmpty":
    "承認待ちのペアリング要求はありません。",
  "settings.webAccess.claimCount": "承認待ち {count} 件",
  "settings.webAccess.unverifiedDevice": "未確認の名前",
  "settings.webAccess.sourceIp": "送信元 IP（サーバー側の観測値）",
  "settings.webAccess.receivedAt": "受信日時：{time}",
  "settings.webAccess.claimExpiresIn": "要求の有効期限：残り {seconds} 秒",
  "settings.webAccess.claimExpired": "要求の有効期限が切れました",
  "settings.webAccess.cancelRequest": "要求を取り消す",
  "settings.webAccess.approve": "承認",
  "settings.webAccess.deny": "拒否",
  "settings.webAccess.approveConfirmTitle": "この端末を承認しますか？",
  "settings.webAccess.approveConfirmMessage":
    "「{name}」にこの PC への接続を許可すると、このデスクトップのライブラリ全体と読書の進行状況を閲覧・読み取りできるようになります。端末名はスマートフォンの自己申告であり、本人性の証明にはなりません。自分でこのペアリングを開始した場合にのみ承認してください。",
  "settings.webAccess.approvePlainHttpWarning":
    "平文の HTTP を使用中です。同じローカルネットワーク上の端末からサービスに接続できます。信頼できるネットワークと端末の場合にのみ続行してください。",
  "settings.webAccess.cancelStart": "起動を中止",
  "settings.webAccess.cancelingStart": "中止しています…",
  "settings.webAccess.devicesTitle": "ペアリング済み端末",
  "settings.webAccess.devicesEmpty":
    "ペアリング済みの端末はまだありません。ペアリング承認後にリーダーを開くと、ここに表示されます。",
  "settings.webAccess.deviceIp": "LAN アドレス：{ip}",
  "settings.webAccess.deviceLastActive": "最終アクティブ：{date}",
  "settings.webAccess.devicesMemoryNote":
    "セッションはメモリ内だけに保持されます。LAN サービスを停止するかアプリを終了すると、すべての端末が切断され消去されます。",
  "settings.webAccess.deviceIssued": "発行：{date}",
  "settings.webAccess.deviceExpires": "有効期限：{date}",
  "settings.webAccess.revoke": "取り消す",
  "settings.webAccess.revokeConfirmTitle": "この端末を取り消しますか？",
  "settings.webAccess.revokeConfirmMessage":
    "「{name}」を取り消すと、ただちにアクセスが切断され、再度ペアリングが必要になります。",
  "settings.webAccess.securityNote":
    "端末名はスマートフォンの自己申告であり、変更される可能性があります。本プロジェクトには SAS や暗号学的な紐付けはなく、デスクトップ側での手動承認だけが認可です。一覧に表示されているだけで検証済みとみなさないでください。",

  "settings.autoSaved": "自動保存しました",
  "settings.autoSaving": "保存中…",
  "settings.autoSaveFailed": "保存に失敗",
  "settings.filter.blockedShort": "{count} 件をブロック",
};

const ko: SettingsMessages = {
  "settings.features.title": "기능 스위치",
  "settings.features.description":
    "각 기능을 독립적으로 켜고 끌 수 있습니다. 끄면 진입점이 숨겨지고 백엔드 호출이 거부됩니다. 변경 사항은 즉시 적용됩니다.",
  "settings.features.browser.description":
    "사이트 확인과 다운로드 가져오기에 쓰는 보조 브라우저입니다. 끄면 상단 표시줄의 진입점이 숨겨집니다.",
  "settings.features.pdf.title": "PDF 읽기",
  "settings.features.pdf.description":
    "로컬 PDF 읽기와 렌더링. 끄더라도 기존 PDF는 서재에 남지만 열면 기능이 꺼져 있다는 안내가 표시됩니다.",
  "settings.page.eyebrow": "환경설정",
  "settings.page.description":
    "외형, 온라인 소스, 읽기 통계와 캐시를 이 기기에서 관리합니다.",
  "settings.page.localFirst": "로컬 우선",
  "settings.page.loading": "설정 불러오는 중",

  "settings.tabs.label": "설정 섹션",
  "settings.tabs.general": "일반 및 모양",
  "settings.tabs.online": "온라인",
  "settings.tabs.reading": "통계",
  "settings.tabs.cache": "캐시",
  "settings.tabs.network": "네트워크 및 소스",
  "settings.tabs.storage": "저장공간 및 데이터",
  "settings.tabs.privacy": "개인정보 및 보안",
  "settings.tabs.about": "정보 및 유지보수",

  "settings.shortcuts.title": "전역 단축키",
  "settings.shortcuts.description":
    "입력란에 포커스가 있거나 입력기 조합 중(isComposing / keyCode 229)이면 Ctrl/Cmd+W를 제외한 전역 단축키가 동작하지 않습니다.",
  "settings.shortcuts.note":
    "단축키를 쓰려면 먼저 입력란 밖으로 포커스를 옮기세요. Ctrl/Cmd+W(창 닫기)만 예외입니다.",
  "settings.shortcuts.command": "Ctrl/Cmd+K로 명령 센터 열기",

  "settings.language.title": "인터페이스 언어",
  "settings.language.description":
    "인터페이스 언어를 선택합니다. 변경 사항은 즉시 적용되고 이 기기에 저장되므로 따로 저장할 필요가 없습니다.",
  "settings.language.label": "표시 언어",

  "settings.theme.title": "외형 테마",
  "settings.tray.title": "창 및 트레이",
  "settings.tray.description":
    "LAN 읽기가 실행 중일 때 기본 창을 닫아도 시스템 트레이에 남아 백그라운드에서 계속 제공할 수 있습니다.",
  "settings.tray.closeToTray": "기본 창을 닫을 때 트레이로 최소화",
  "settings.tray.closeToTrayHint":
    "활성화하면 닫기(×)는 창을 숨기기만 합니다. 완전히 종료하려면 트레이 메뉴에서 종료하세요.",
  "settings.theme.description":
    "인터페이스 색상을 선택합니다. 변경은 즉시 적용되며 로컬 환경설정과 데이터베이스에 동기화됩니다.",
  "settings.theme.groupLabel": "테마 모드",
  "settings.theme.systemHint": "시스템 밝기 모드 따름",
  "settings.theme.lightHint": "아이스 블루 캔버스",
  "settings.theme.darkHint": "한밤의 콕핏",
  "settings.theme.systemNote":
    "「시스템」은 운영체제의 라이트/다크 모드를 자동으로 따릅니다.",


  "settings.experimental.webtoonTitle": "웹툰 모드",
  "settings.experimental.webtoonDescription":
    "세로로 긴 작품을 끊김 없이 스크롤하는, 단일/양면 페이지에 이은 세 번째 레이아웃입니다.",

  "settings.toast.featureOn": "{feature} 켜짐",
  "settings.toast.featureOff": "{feature} 꺼짐",

  "settings.library.title": "서재 폴더",
  "settings.library.description":
    "만화가 있는 폴더를 지정합니다. 스캔하면 새 책이 이 기기의 서재에 추가됩니다.",
  "settings.library.dirLabel": "스캔 폴더",
  "settings.library.dirPlaceholder": "D:\\Manga 또는 /path/to/manga",
  "settings.library.pick": "선택",
  "settings.library.pickTitle": "만화 폴더 선택",
  "settings.library.clearDir": "폴더 지우기",
  "settings.library.scanning": "스캔 중…",
  "settings.library.scanNow": "지금 스캔",
  "settings.library.scanHint":
    "위 폴더로 스캔하며 저장할 필요가 없습니다. 결과는 알림으로 표시됩니다.",

  "settings.about.title": "정보",
  "settings.about.description":
    "Moyu는 만화 읽기와 라이브러리 관리를 위한 무료 데스크톱 애플리케이션입니다.",
  "settings.about.version": "버전",
  "settings.about.commit": "빌드 커밋",
  "settings.about.storage": "설정 저장 위치",
  "settings.about.storageValue": "로컬 SQLite",
  "settings.about.dataFlow": "데이터 위치",
  "settings.about.dataFlowValue": "기기를 벗어나지 않음",
  "settings.about.note":
    "설정과 읽기 기록은 이 기기에 저장됩니다. 스캔, 온라인 요청, 읽기 과정에서 개인 데이터를 업로드하지 않습니다.",

  "settings.online.urlTitle": "온라인 URL 바로 읽기",
  "settings.online.urlDescription":
    "JSON 매니페스트와 단일 페이지 HTML 갤러리를 지원합니다. 꺼져 있으면 서재와 브라우저에서 먼저 켜라는 안내가 표시됩니다.",
  "settings.online.enableTitle": "온라인 소스 사용",
  "settings.online.enableDescription":
    "온라인 매니페스트/갤러리에서 가져와 읽을 수 있으며, 가져온 화는 로컬 서재에 추가됩니다.",
  "settings.online.enableNote":
    "스위치는 즉시 저장됩니다. 아래 네트워크 설정은 하단의 「설정 저장」을 눌러야 적용됩니다.",
  "settings.online.networkTitle": "네트워크 및 요청",
  "settings.online.networkDescription":
    "프록시, 동시 연결 수, 헤더가 온라인 요청에 함께 전송됩니다. 신뢰할 수 있는 소스나 게이트웨이만 입력하세요.",
  "settings.online.proxyLabel": "프록시 주소",
  "settings.online.proxyPlaceholder":
    "비워 두면 직접 연결, 또는 http://127.0.0.1:7890",
  "settings.online.detectProxy": "시스템 프록시",
  "settings.online.detectProxyTitle":
    "Windows 시스템 프록시를 읽어 프록시 주소에 채웁니다. 자동으로 저장되지는 않습니다",
  "settings.online.detecting": "감지 중…",
  "settings.online.proxyHint":
    "http / https / socks5를 지원하며, 비워 두면 직접 연결합니다.",
  "settings.online.concurrencyLabel": "페이지 동시 연결",
  "settings.online.concurrencyPlaceholder": "동시 연결 수 선택",
  "settings.online.concurrencyItem": "{count}개 동시",
  "settings.online.concurrencyHint":
    "1–8. 높을수록 빠르지만 소스에서 속도 제한을 받기 쉽습니다.",
  "settings.online.headersLabel": "사용자 지정 헤더",
  "settings.online.sessionActive": "세션 자격 증명 사용 중",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} 또는 session=...; token=...',
  "settings.online.headersHint":
    "헤더는 로컬 설정에 평문으로 저장되며 설정한 소스나 게이트웨이로 보내는 요청에 포함됩니다.",
  "settings.online.storageMode": "저장 모드",
  "settings.online.storageModeDescription":
    "세션 모드는 데이터베이스에 기록되지 않으며 앱을 종료하면 지워집니다.",
  "settings.online.storageModeGroup": "헤더 저장 모드",
  "settings.online.memoryOnly": "메모리에만 보관",
  "settings.online.persistLocal": "로컬에 저장",
  "settings.online.sessionPresent":
    "현재 헤더가 프로세스 메모리에 저장되어 있습니다.",
  "settings.online.sessionAbsent": "현재 세션 헤더가 없습니다.",
  "settings.online.clearSession": "메모리 자격 증명 지우기",
  "settings.online.storageModeNote":
    "세션 헤더는 메모리에만 보관되며 처음 사용한 사이트에만 적용됩니다. 사이트를 바꾸면 다시 입력하세요.",
  "settings.online.testTitle": "연결 테스트",
  "settings.online.testDescription":
    "대상 매니페스트나 갤러리를 분석만 하며 서재에 기록하지 않습니다.",
  "settings.online.testUrlAria":
    "온라인 매니페스트 또는 갤러리 테스트 URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "테스트 중…",
  "settings.online.testConnection": "연결 테스트",
  "settings.online.reachable": "연결 가능",
  "settings.online.testSummary": "{title} · {pages}페이지 · {ms} ms",
  "settings.online.testHint":
    "테스트에는 저장된 프록시와 헤더가 사용됩니다. 변경 후 먼저 저장하세요.",

  "settings.stats.loadError": "읽기 통계를 불러오지 못했습니다: {detail}",
  "settings.stats.loading": "로컬 읽기 기록을 집계하는 중…",
  "settings.stats.totalBooks": "총 장서",
  "settings.stats.reading": "읽는 중",
  "settings.stats.todayPages": "오늘 읽은 페이지",
  "settings.stats.last7Pages": "최근 7일",
  "settings.stats.unitBooks": "권",
  "settings.stats.note":
    "로컬 읽기 기록에서 실제로 넘긴 페이지만 집계합니다. 열지 않은 책과 기록되지 않은 진행률은 제외됩니다.",
  "settings.stats.title": "서재와 읽기 통계",
  "settings.stats.description":
    "로컬 읽기 기록 요약. 서재 폴더와 스캔도 여기에 함께 있습니다.",

  "settings.cache.budgetTitle": "메모리 캐시 예산",
  "settings.cache.budgetDescription":
    "메모리 예산이 높을수록 페이지 넘김이 부드러워지지만 프로세스 메모리 사용량도 늘어납니다.",
  "settings.cache.budgetLabel": "메모리 캐시 예산",
  "settings.cache.budgetAria": "메모리 캐시 예산(MB)",
  "settings.cache.budgetHint":
    "저장하면 페이지와 썸네일 메모리 캐시에 즉시 적용됩니다.",
  "settings.cache.diskTitle": "디스크 캐시",
  "settings.cache.diskDescription":
    "렌더링 이미지와 온라인 원본이 하나의 디스크 캐시를 공유하며, 한도를 넘으면 오래된 파일부터 자동으로 정리됩니다.",
  "settings.cache.diskLabel": "디스크 캐시 상한",
  "settings.cache.diskAria": "디스크 캐시 상한(MB)",
  "settings.cache.diskHint":
    "저장 후 즉시 적용됩니다. 상한을 낮추면 초과분은 이후 접근 시 정리됩니다.",
  "settings.cache.diskUsage": "디스크 사용량",
  "settings.cache.diskRender": "렌더링 캐시",
  "settings.cache.diskOnline": "온라인 원본",
  "settings.cache.diskEmpty": "아직 디스크 캐시 통계가 없습니다.",
  "settings.cache.memoryTitle": "메모리 사용량",
  "settings.cache.memoryDescription": "이번 실행의 메모리와 캐시 스냅숏입니다.",
  "settings.cache.budgetUsage": "메모리 예산 사용률",
  "settings.cache.process": "프로세스",
  "settings.cache.imageCache": "이미지 캐시",
  "settings.cache.cachedPages": "캐시된 페이지",
  "settings.cache.cachedThumbs": "표지 썸네일",
  "settings.cache.webtoonCache": "웹툰 캐시",
  "settings.cache.limit": "메모리 상한",
  "settings.cache.empty": "아직 메모리 통계가 없습니다.",
  "settings.cache.pagesValue": "{count}페이지",
  "settings.cache.thumbsValue": "{count}개",
  "settings.cache.webtoonValue": "{size} · {count} 타일",
  "settings.cache.maintenanceTitle": "캐시 관리",
  "settings.cache.maintenanceDescription":
    "삭제한 항목은 필요할 때 다시 생성되며 서재와 읽기 진행률에는 영향을 주지 않습니다.",
  "settings.cache.clearThumbs": "표지 캐시 지우기",
  "settings.cache.clearing": "지우는 중…",
  "settings.cache.clearPages": "페이지 캐시 비우기",
  "settings.cache.purging": "정리 중…",
  "settings.cache.clearHint":
    "표지 캐시는 서재에 다시 들어가면 자동으로 생성됩니다.",
  "settings.cache.clearTemp": "임시 캐시 한 번에 지우기",
  "settings.cache.clearingTemp": "지우는 중…",
  "settings.cache.clearTempHint":
    "메모리 페이지, 렌더링된 파일, 온라인 원본을 지웁니다. 표지는 필요할 때 다시 생성되며 서재와 읽기 진행률에는 영향을 주지 않습니다.",
  "settings.cache.manageTitle": "캐시 및 LRU 할당량",
  "settings.cache.manageDescription":
    "렌더 캐시와 온라인 이미지 캐시는 하나의 LRU 상한(500 MB – 10 GB)을 공유합니다. 원클릭으로 임시 캐시를 비웁니다.",
  "settings.online.proxyMode.system": "시스템 프록시 따르기",
  "settings.online.proxyMode.manual": "수동 프록시",
  "settings.online.proxyMode.direct": "직접 연결",
  "settings.online.browserHint":
    "만화 URL이나 Telegram 채널은 '브라우저' 페이지 상단의 유일한 주소창에서 입력하세요.",

  "settings.status.loading": "설정 불러오는 중…",
  "settings.status.loadFailed": "설정이 로드되지 않음",
  "settings.status.saving": "설정 저장 중…",
  "settings.status.dirty": "저장하지 않은 변경 사항 있음",
  "settings.status.saved": "모든 변경 사항 저장됨",
  "settings.status.saveHint": "저장하면 이 기기의 설정에 기록됩니다",
  "settings.saveButton": "설정 저장",

  "settings.errors.loadSettings": "설정을 읽지 못했습니다",
  "settings.errors.loadStats": "통계를 읽지 못했습니다",
  "settings.errors.connectTest": "연결 테스트 실패",
  "settings.errors.loadSettingsDetail":
    "설정을 불러오지 못했습니다: {detail}",

  "settings.toast.scanDone": "스캔 완료. 서재에 {count}권이 있습니다.",
  "settings.toast.scanErrors": "항목 {count}개를 읽지 못해 건너뛰었습니다",
  "settings.toast.proxyFilled":
    "시스템 프록시를 감지하여 저장했습니다",
  "settings.toast.proxyNotFound": "활성화된 시스템 프록시를 찾지 못했습니다",
  "settings.toast.sessionCleared": "메모리 자격 증명을 지웠습니다",
  "settings.toast.urlRequired": "매니페스트 또는 갤러리 URL을 입력하세요",
  "settings.toast.noReadablePages":
    "매니페스트에 읽을 수 있는 페이지가 없습니다",
  "settings.toast.thumbsCleared":
    "표지 캐시 {count}개를 지웠습니다. 서재에 다시 들어가면 자동으로 생성됩니다",
  "settings.toast.pagesCleared": "페이지 캐시를 비웠습니다",
  "settings.toast.tempCleared":
    "임시 캐시를 지우고 {size}를 확보했습니다",
  "settings.toast.saved": "설정이 저장되었습니다",

  "settings.backup.title": "로컬 백업 및 복원",
  "settings.backup.description":
    "서재 인덱스, 읽기 진행률, 환경설정을 하나의 백업 파일로 묶습니다. 복원 전에 현재 데이터를 내보내세요.",
  "settings.backup.export": "로컬 백업 내보내기 (.mrbackup / .zip)",
  "settings.backup.exporting": "내보내는 중…",
  "settings.backup.restore": "백업에서 복원",
  "settings.backup.restoring": "복원하는 중…",
  "settings.backup.saveTitle": "백업 저장 위치 선택",
  "settings.backup.pickTitle": "백업 파일 선택",
  "settings.backup.filterName": "Moyu 백업",
  "settings.backup.note":
    "백업에는 서재 인덱스, 읽기 진행률, 읽기 통계, 테마/언어/리더 환경설정, 자체 학습 필터 규칙이 포함됩니다. 이미지 캐시, 세션 요청 헤더, 쿠키, 필터 이벤트, 내부 버전 표시는 포함되지 않습니다. 복원하면 현재 서재와 읽기 진행률을 덮어쓰므로 먼저 내보내는 것이 좋습니다.",
  "settings.backup.confirmTitle": "이 백업에서 복원할까요?",
  "settings.backup.confirmMessage":
    "현재 서재, 읽기 진행률, 환경설정을 덮어쓰며 되돌릴 수 없습니다. 백업 파일: {file}",
  "settings.backup.confirmRestore": "백업에서 복원",
  "settings.backup.exported": "백업을 내보냈습니다: {books}권 · {size}",
  "settings.backup.restored":
    "백업에서 복원했습니다: {books}권 · {days}일 읽기 기록",
  "settings.backup.applied":
    "백업의 테마, 언어, 리더 환경설정을 적용했습니다",
  "settings.backup.error": "백업 작업에 실패했습니다. 다시 시도하세요.",
  "settings.about.buildOrigin": "빌드 출처",
  "settings.about.buildOriginLabel": "빌드 출처 지문",
  "settings.about.buildOriginOfficial": "Official Release",
  "settings.about.buildOriginCommunity": "Community Modified Build (Non-Commercial)",
  "settings.about.nonCommercial": "비상업 라이선스 (Non-Commercial Only)",
  "settings.backup.skippedTitle": "일부 로컬 책을 복원하지 못했습니다",
  "settings.backup.skippedHint":
    "원본 경로가 없거나 읽을 수 있는 만화가 아니거나 시스템/사용자 중요 폴더를 가리킵니다. 라이브러리에 추가하지 않았고 디스크 내용도 삭제하지 않았습니다.",
  "settings.backup.skippedReasonMissing": "경로가 없거나 사용할 수 없음",
  "settings.backup.skippedReasonNotBook":
    "읽을 수 있는 만화 폴더/압축 파일이 아님",
  "settings.backup.skippedReasonUnsafe":
    "시스템/사용자 중요 폴더를 가리킴",
  "settings.backup.skippedCount":
    "로컬 책 {count}권을 복원하지 못했습니다",
  "settings.backup.skipWarningTitle": "복원하면 일부 진행률이 사라집니다",
  "settings.backup.skipWarningMessage":
    "이 백업의 로컬 책 {count}권에 지금 접근할 수 없습니다(외장 드라이브나 네트워크 위치가 연결되지 않음). 계속하면 현재 라이브러리에서 해당 책의 읽기 진행률과 기록이 삭제됩니다. 복원 전에 현재 라이브러리의 스냅샷을 저장합니다.",
  "settings.backup.forwardSchema": "더 최신 버전({version})에서 내보낸 백업입니다. 호환 모드로 핵심 라이브러리와 진행 상황을 복원했으며, 최신 버전에서 추가된 설정은 무시했습니다.",
  "settings.ca.title": "루트 CA 및 기기 신뢰",
  "settings.ca.description":
    "루트 CA를 초기화·내보내고 짧은 시간 동안 평문 HTTP로 배포하여 휴대폰이 이 기기의 HTTPS 서비스를 신뢰하도록 합니다.",
  "settings.ca.badgeNotInitialized": "CA 미초기화",
  "settings.ca.badgeInitialized": "CA 초기화됨",
  "settings.ca.notInitialized":
    "로컬 CA가 초기화되지 않았습니다. 초기화하면 새 루트 인증서가 생성됩니다. 관리하는 기기에만 설치하고 CA를 백업하세요.",
  "settings.ca.initialize": "로컬 CA 초기화",
  "settings.ca.initializeConfirmTitle": "로컬 루트 CA를 초기화할까요?",
  "settings.ca.initializeConfirmMessage":
    "새 로컬 루트 CA를 만듭니다. CA를 잃으면 설치된 모든 기기에서 신뢰 인증서를 다시 설치해야 합니다. 어떤 데이터도 업로드되지 않습니다.",
  "settings.ca.initialized": "로컬 CA를 초기화하고 개인 키 ACL을 검증했습니다.",
  "settings.ca.fingerprint": "루트 인증서 SHA-256 지문",
  "settings.ca.fingerprintHint":
    "휴대폰에 설치하기 전에 전체 SHA-256 지문을 확인하세요. 16진수 64자이며 콜론과 대소문자는 무시합니다.",
  "settings.ca.verifyOnPhone":
    "중요: 휴대폰 설치 화면에 SHA-1이 표시될 수 있습니다. SHA-256으로 전환한 뒤 위 값과 모든 그룹을 비교하세요. 다르면 설치하지 마세요.",
  "settings.ca.copyFingerprint": "지문 복사",
  "settings.ca.copied": "복사됨",
  "settings.ca.copyFailed": "복사하지 못했습니다. 텍스트를 선택해 직접 복사하세요.",
  "settings.ca.expires": "루트 만료: {date} ({days}일 남음)",
  "settings.ca.rotationWarning":
    "루트 CA가 {days}일 후 교체 기간에 들어갑니다. 교체 후 모든 기기에 다시 배포하고 설치해야 합니다.",
  "settings.ca.intermediateFingerprint": "중간 CA 지문(진단용)",
  "settings.ca.export": "루트 인증서 내보내기",
  "settings.ca.exportTitle": "루트 인증서 저장",
  "settings.ca.exported": "루트 인증서를 내보냈습니다. 설치 전에 지문을 확인하세요.",
  "settings.ca.exportFailed": "루트 인증서를 내보내지 못했습니다. 다시 시도하세요.",
  "settings.ca.loadError": "CA 상태를 불러오지 못했습니다: {detail}",
  "settings.ca.distribution.title": "단기 배포 서비스",
  "settings.ca.distribution.description":
    "명시적으로 시작한 경우에만 루트 인증서를 제공합니다. 휴대폰은 CA를 신뢰하기 전에 HTTPS를 검증할 수 없으므로 평문 HTTP를 사용하며 120초 후 자동으로 종료됩니다.",
  "settings.ca.distribution.address": "배포 주소",
  "settings.ca.distribution.start": "배포 시작",
  "settings.ca.distribution.stop": "배포 중지",
  "settings.ca.distribution.running": "실행 중",
  "settings.ca.distribution.stopped": "중지됨",
  "settings.ca.distribution.url": "다운로드 URL",
  "settings.ca.distribution.expiresIn": "{seconds}초 남음",
  "settings.ca.distribution.expired": "배포 서비스가 만료되어 자동으로 종료되었습니다.",
  "settings.ca.distribution.securityNote":
    "공개 루트 인증서만 제공합니다. 신뢰할 수 있는 LAN에서만 사용하세요. URL은 평문 HTTP이므로 신뢰할 수 없는 네트워크에 노출하지 마세요.",
  "settings.ca.distribution.noAddress":
    "사용 가능한 사설 LAN IPv4 주소가 없어 배포를 시작할 수 없습니다.",
  "settings.ca.privateKeyNote":
    "CA 개인 키는 로컬 CA 디렉터리에만 있으며 HTTP 배포 작업은 이를 읽을 수 없습니다.",

  "settings.webAccess.unknownDevice": "알 수 없는 기기",
  "settings.webAccess.networkHint":
    "Windows 방화벽이 연결을 차단하면 개인 네트워크에서 이 앱의 인바운드를 허용하세요. 로컬 인증서 신뢰는 HTTPS 모드에서만 필요합니다.",
  "settings.webAccess.title": "로컬 네트워크 읽기",
  "settings.webAccess.description":
    "코드를 스캔하거나 주소를 입력하고 컴퓨터에서 기기를 승인하면 읽을 수 있습니다. 서비스는 기본적으로 꺼져 있습니다.",
  "settings.webAccess.statusTitle": "서비스 상태",
  "settings.webAccess.refresh": "상태 새로 고침",
  "settings.webAccess.loadError":
    "Web Access 상태를 불러오지 못했습니다: {detail}",
  "settings.webAccess.phase.disabled": "꺼짐",
  "settings.webAccess.phase.starting": "시작 중",
  "settings.webAccess.phase.enabled": "실행 중",
  "settings.webAccess.phase.stopping": "중지 중",
  "settings.webAccess.phase.error": "오류",
  "settings.webAccess.caRequired":
    "HTTPS 모드에서는 먼저 ‘루트 CA 및 기기 신뢰’에서 로컬 CA를 초기화해야 합니다.",
  "settings.webAccess.safeModeBlocked":
    "안전 모드가 활성화되어 있습니다. Web Access가 중지되었으며 안전 모드를 종료할 때까지 다시 시작할 수 없습니다.",
  "settings.webAccess.address": "수신 주소",
  "settings.webAccess.noAddress":
    "사용 가능한 사설 LAN IPv4 주소를 찾지 못했습니다",
  "settings.webAccess.bindAddress": "바인드 주소",
  "settings.webAccess.port": "실제 포트",
  "settings.webAccess.deviceCount": "페어링된 기기: {count}",
  "settings.webAccess.pendingCount": "승인 대기 요청: {count}",
  "settings.webAccess.notRunning":
    "서비스가 실행 중이 아닙니다. 시작하면 페어링 QR 코드를 만들 수 있습니다.",
  "settings.webAccess.start": "서비스 시작",
  "settings.webAccess.httpWarning": "로컬 HTTP는 암호화되지 않습니다. 같은 네트워크의 기기가 콘텐츠와 세션을 읽거나 변경할 수 있습니다. 신뢰할 수 있는 네트워크에서만 사용하세요.",
  "settings.webAccess.startSecure": "고급: HTTPS 사용",
  "settings.webAccess.plainPairHint": "코드를 스캔하거나 주소를 입력한 뒤 여기서 기기를 승인하세요. 인증서는 필요하지 않습니다.",
  "settings.webAccess.starting": "시작 중",
  "settings.webAccess.stop": "서비스 중지",
  "settings.webAccess.stopping": "중지 중",
  "settings.webAccess.stopConfirmTitle": "Web Access를 중지할까요?",
  "settings.webAccess.stopConfirmMessage":
    "중지하면 페어링된 모든 기기의 연결이 끊기고 현재 페어링 창이 취소되며 수신 포트가 닫힙니다. 필요하면 이 패널에서 다시 시작할 수 있습니다.",
  "settings.webAccess.stopReasonTitle": "중지 사유",
  "settings.webAccess.stopReason.stopped": "사용자가 직접 중지",
  "settings.webAccess.stopReason.safeMode": "안전 모드 진입으로 중지",
  "settings.webAccess.stopReason.recovery": "충돌 복구로 중지",
  "settings.webAccess.stopReason.exit": "앱 종료로 중지",
  "settings.webAccess.lastError": "최근 오류: {detail}",
  "settings.webAccess.rootFingerprint": "루트 CA SHA-256 지문",
  "settings.webAccess.leafFingerprint": "리프 인증서 SHA-256 지문",
  "settings.webAccess.leafExpires": "리프 인증서 만료: {date}",
  "settings.webAccess.copyFingerprint": "지문 복사",
  "settings.webAccess.pairingTitle": "기기 페어링",
  "settings.webAccess.pairingDescription":
    "시작하면 120초 동안 유효한 페어링 창이 만들어집니다. 휴대폰으로 QR 코드를 스캔하거나 링크를 연 뒤 이 패널에서 요청을 하나씩 확인하세요.",
  "settings.webAccess.pairingStart": "페어링 시작",
  "settings.webAccess.pairingCancel": "페어링 취소",
  "settings.webAccess.pairingCountdown": "{seconds}초 남음",
  "settings.webAccess.pairingExpired":
    "페어링 창이 만료되었습니다. 다시 시작하세요.",
  "settings.webAccess.qrAlt": "Web Access 페어링 QR 코드",
  "settings.webAccess.qrHint":
    "QR 코드에는 이번 페어링 링크만 들어 있습니다. 휴대폰 카메라로 스캔하고 스크린샷을 공유하지 마세요.",
  "settings.webAccess.copyUrl": "링크 복사",
  "settings.webAccess.copied": "복사됨",
  "settings.webAccess.copyFailed":
    "복사하지 못했습니다. 텍스트를 선택해 직접 복사하세요.",
  "settings.webAccess.claimsTitle": "승인 대기 요청",
  "settings.webAccess.claimsEmpty":
    "승인 대기 중인 페어링 요청이 없습니다.",
  "settings.webAccess.claimCount": "{count}건 대기",
  "settings.webAccess.unverifiedDevice": "확인되지 않은 이름",
  "settings.webAccess.sourceIp": "출발지 IP(서버 관측값)",
  "settings.webAccess.receivedAt": "수신 시각: {time}",
  "settings.webAccess.claimExpiresIn": "요청 만료까지 {seconds}초",
  "settings.webAccess.claimExpired": "요청이 만료됨",
  "settings.webAccess.cancelRequest": "요청 취소",
  "settings.webAccess.approve": "승인",
  "settings.webAccess.deny": "거부",
  "settings.webAccess.approveConfirmTitle": "이 기기를 승인할까요?",
  "settings.webAccess.approveConfirmMessage":
    "'{name}' 기기가 이 PC에 연결하면 이 데스크톱의 전체 서재와 읽기 진행 상황을 둘러보고 읽을 수 있습니다. 기기 이름은 휴대폰이 스스로 신고한 값이라 신원을 증명하지 않습니다. 직접 이 페어링을 시작한 경우에만 승인하세요.",
  "settings.webAccess.approvePlainHttpWarning":
    "암호화되지 않은 HTTP를 사용 중이며 같은 로컬 네트워크의 기기에서 서비스에 연결할 수 있습니다. 신뢰하는 네트워크와 기기에서만 계속하세요.",
  "settings.webAccess.cancelStart": "시작 취소",
  "settings.webAccess.cancelingStart": "취소 중…",
  "settings.webAccess.devicesTitle": "페어링된 기기",
  "settings.webAccess.devicesEmpty":
    "아직 페어링된 기기가 없습니다. 페어링 승인 후 리더를 열면 여기에 표시됩니다.",
  "settings.webAccess.deviceIp": "LAN 주소: {ip}",
  "settings.webAccess.deviceLastActive": "최근 활동: {date}",
  "settings.webAccess.devicesMemoryNote":
    "세션은 메모리에만 보관됩니다. LAN 서비스를 중지하거나 앱을 종료하면 모든 기기가 연결 해제되고 지워집니다.",
  "settings.webAccess.deviceIssued": "발급: {date}",
  "settings.webAccess.deviceExpires": "만료: {date}",
  "settings.webAccess.revoke": "취소",
  "settings.webAccess.revokeConfirmTitle": "이 기기를 취소할까요?",
  "settings.webAccess.revokeConfirmMessage":
    "'{name}' 기기를 취소하면 즉시 연결이 끊기고 다시 페어링해야 합니다.",
  "settings.webAccess.securityNote":
    "기기 이름은 휴대폰이 스스로 신고한 값이라 바뀔 수 있습니다. 이 프로젝트에는 SAS나 암호학적 바인딩이 없으며 데스크톱에서의 수동 승인만이 유일한 인가입니다. 목록에 보인다는 이유만으로 검증된 기기로 간주하지 마세요.",

  "settings.autoSaved": "자동 저장됨",
  "settings.autoSaving": "저장 중…",
  "settings.autoSaveFailed": "저장 실패",
  "settings.filter.blockedShort": "{count}개 차단됨",
};

export const settingsMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
