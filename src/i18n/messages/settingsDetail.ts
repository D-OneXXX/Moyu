/**
 * Settings progressive-disclosure strings (Task 2/8) and the skin/mascot slot
 * strings (Task 7). Kept in one module so the six dictionaries stay in sync.
 */
const zhCN = {

  "settings.skin.title": "界面皮肤与画框主题",
  "settings.skin.description":
    "整片窗口是一张主题画布，书库与设置是内嵌视窗；只做画框换肤，没有任何漂浮挂件。",
  "settings.skin.open": "界面皮肤与画框主题",
  "settings.skin.openHint": "画框展厅 / 本地皮肤包",
  "settings.skin.active": "使用中",
  "settings.skin.apply": "应用",
  "settings.skin.builtin": "内置",
  "settings.skin.installed": "本地",
  "settings.skin.colorLight": "亮色",
  "settings.skin.colorDark": "暗色",
  "settings.skin.colorBoth": "亮暗通用",
  "settings.skin.importPack": "导入 .moyuskin 皮肤包",
  "settings.skin.createCustom": "快速自制背景/画框皮肤",
  "settings.skin.installedCount": "{count} 套本地皮肤",
  "settings.skin.export": "导出",
  "settings.skin.delete": "删除",
  "settings.skin.deleteTitle": "删除本地皮肤",
  "settings.skin.deleteBody":
    "将删除「{name}」及其本地图片资源；若正在使用会自动回到极简默认。",
  "settings.skin.deleteDone": "已删除本地皮肤",
  "settings.skin.exportDone": "皮肤包已导出",
  "settings.skin.importDone": "皮肤包已导入并应用",
  "settings.skin.importHint":
    "皮肤包只包含清单与 PNG / JPEG / WebP 图片，不会上传到任何服务器。",
  "settings.skin.importSessionOnly":
    "皮肤包图片只保存在本机应用数据目录。",
  "settings.skin.customName": "自制皮肤",
  "settings.skin.builderTitle": "快速自制画框皮肤",
  "settings.skin.builderHint":
    "选一张整页背景图（可选一张透明 PNG 画框），拖动滑杆实时预览。",
  "settings.skin.nameLabel": "皮肤名称",
  "settings.skin.namePlaceholder": "例如：我的夏日画框",
  "settings.skin.backdropLabel": "整页背景",
  "settings.skin.backdropHint":
    "PNG / JPEG / WebP，单张 ≤ 4 MiB、≤ 4096px。",
  "settings.skin.frameLabel": "视窗外框（可选）",
  "settings.skin.frameHint": "带透明区域的 PNG，会铺在外围画框上。",
  "settings.skin.frameNone": "未选择画框",
  "settings.skin.insetLabel": "视窗内缩",
  "settings.skin.opacityLabel": "面板通透度",
  "settings.skin.numericValue": "{value}{unit}",
  "settings.skin.previewLabel": "实时预览",
  "settings.skin.createAction": "生成并应用皮肤",
  "settings.skin.creating": "正在生成…",
  "settings.skin.createDone": "自制皮肤已创建并应用",
  "settings.skin.defaultName": "极简（默认）",
  "settings.skin.defaultDescription": "0px 边距，全屏铺满，零额外开销。",
  "settings.skin.inkName": "纸墨画廊",
  "settings.skin.inkDescription":
    "宣纸质感底纹与内缩画框，留白安静，适合长时间阅读。",
  "settings.skin.midnightName": "午夜霓虹",
  "settings.skin.midnightDescription":
    "深邃星云网格画布与发光微边框，磨砂视窗更沉浸。",
  "settings.skin.pastelName": "柔光物语",
  "settings.skin.pastelDescription":
    "低饱和治愈渐变与大圆角视窗，方便替换成自己的插画背景。",
  "settings.skin.errorFormat": "不支持的图片格式（仅 PNG / JPEG / WebP）",
  "settings.skin.errorSize": "图片超过 4 MiB 上限",
  "settings.skin.errorDimension": "图片尺寸超过 4096px 上限",
  "settings.skin.errorRead": "无法读取该图片",
  "settings.skin.errorPack": "皮肤包无效或包含不支持的资源",
  "settings.skin.errorPackSize": "皮肤包超过 16 MiB / 16 个条目上限",
  "settings.skin.errorExists": "同 id 的皮肤已安装",
  "settings.skin.errorWrite": "皮肤写入或删除失败",
  "settings.skin.errorName": "皮肤名称无效",
  "settings.skin.errorRange": "内缩边距或通透度超出允许范围",
  "settings.skin.errorFrame": "画框贴图必须是透明 PNG",

  "settings.shortcuts.enabled": "全局快捷键已启用",
  "settings.shortcuts.disabled": "全局快捷键已关闭",
  "settings.shortcuts.count": "{count} 组映射",
  "settings.shortcuts.open": "查看/配置快捷键列表",
  "settings.shortcuts.openHint": "输入态与输入法组合中自动豁免",
  "settings.shortcuts.reset": "恢复默认",
  "settings.shortcuts.resetDone": "快捷键已恢复默认",
  "settings.shortcuts.sheetDescription":
    "键位在输入框聚焦或输入法组合中一律不触发（Ctrl/Cmd+W 除外）。",
  "settings.shortcuts.toggle": "启用全局快捷键",
  "settings.shortcuts.toggleHint": "关闭后主界面与阅读器不再响应任何全局键位。",

  "settings.filter.engineTitle": "在线提纯引擎",
  "settings.filter.engineDescription":
    "按站点档案与规则拦截广告、导航与占位图。",
  "settings.filter.engineSwitch": "提纯引擎",
  "settings.filter.engineSwitchHint": "关闭后在线页面按原始 HTML 渲染。",
  "settings.filter.open": "过滤规则与站点档案",
  "settings.filter.openHint": "{rules} 条规则 · {profiles} 个站点档案",

  "settings.cache.budgetBadge": "预算 {size} MB",
  "settings.cache.detailOpen": "配额与缓存明细",
  "settings.cache.detailOpenHint": "调整上限 / 查看渲染与在线缓存",

  "settings.webAccess.pairedDevices": "{count} 台已配对",
  "settings.webAccess.accessUrlLabel": "访问地址",
  "settings.webAccess.quickHint":
    "同一局域网内的设备可扫码或输入地址访问书库。",
  "settings.webAccess.quickToggle": "局域网访问",
  "settings.webAccess.quickToggleHint":
    "开启后在当前网络内提供书库浏览与阅读。",
  "settings.webAccess.openAdvanced": "高级配置（CA / 配对设备）",
  "settings.webAccess.openAdvancedHint":
    "证书轮换、指纹核对、OPDS 凭据与设备管理",

  "privacy.detail.open": "查看完整安全自检明细 & 导出诊断包",
  "privacy.detail.openHint": "{pass} 项通过 · {warn} 项提醒",
  "privacy.detail.reportTitle": "安全自检报告",
  "privacy.detail.exportTitle": "诊断包导出",
};

const zhTW = {

  "settings.skin.title": "介面皮膚與畫框主題",
  "settings.skin.description":
    "整片視窗是一張主題畫布，書庫與設定是內嵌視窗；只做畫框換膚，沒有任何漂浮掛件。",
  "settings.skin.open": "介面皮膚與畫框主題",
  "settings.skin.openHint": "畫框展廳 / 本機皮膚包",
  "settings.skin.active": "使用中",
  "settings.skin.apply": "套用",
  "settings.skin.builtin": "內建",
  "settings.skin.installed": "本機",
  "settings.skin.colorLight": "亮色",
  "settings.skin.colorDark": "暗色",
  "settings.skin.colorBoth": "亮暗通用",
  "settings.skin.importPack": "匯入 .moyuskin 皮膚包",
  "settings.skin.createCustom": "快速自製背景/畫框皮膚",
  "settings.skin.installedCount": "{count} 套本機皮膚",
  "settings.skin.export": "匯出",
  "settings.skin.delete": "刪除",
  "settings.skin.deleteTitle": "刪除本機皮膚",
  "settings.skin.deleteBody":
    "將刪除「{name}」及其本機圖片資源；若正在使用會自動回到極簡預設。",
  "settings.skin.deleteDone": "已刪除本機皮膚",
  "settings.skin.exportDone": "皮膚包已匯出",
  "settings.skin.importDone": "皮膚包已匯入並套用",
  "settings.skin.importHint":
    "皮膚包只包含清單與 PNG / JPEG / WebP 圖片，不會上傳到任何伺服器。",
  "settings.skin.importSessionOnly":
    "皮膚包圖片只保存在本機應用程式資料目錄。",
  "settings.skin.customName": "自製皮膚",
  "settings.skin.builderTitle": "快速自製畫框皮膚",
  "settings.skin.builderHint":
    "選一張整頁背景圖（可選一張透明 PNG 畫框），拖動滑桿即時預覽。",
  "settings.skin.nameLabel": "皮膚名稱",
  "settings.skin.namePlaceholder": "例如：我的夏日畫框",
  "settings.skin.backdropLabel": "整頁背景",
  "settings.skin.backdropHint":
    "PNG / JPEG / WebP，單張 ≤ 4 MiB、≤ 4096px。",
  "settings.skin.frameLabel": "視窗外框（可選）",
  "settings.skin.frameHint": "帶透明區域的 PNG，會鋪在外圍畫框上。",
  "settings.skin.frameNone": "未選擇畫框",
  "settings.skin.insetLabel": "視窗內縮",
  "settings.skin.opacityLabel": "面板通透度",
  "settings.skin.numericValue": "{value}{unit}",
  "settings.skin.previewLabel": "即時預覽",
  "settings.skin.createAction": "產生並套用皮膚",
  "settings.skin.creating": "正在產生…",
  "settings.skin.createDone": "自製皮膚已建立並套用",
  "settings.skin.defaultName": "極簡（預設）",
  "settings.skin.defaultDescription": "0px 邊距，全螢幕鋪滿，零額外開銷。",
  "settings.skin.inkName": "紙墨畫廊",
  "settings.skin.inkDescription":
    "宣紙質感底紋與內縮畫框，留白安靜，適合長時間閱讀。",
  "settings.skin.midnightName": "午夜霓虹",
  "settings.skin.midnightDescription":
    "深邃星雲網格畫布與發光微邊框，磨砂視窗更沉浸。",
  "settings.skin.pastelName": "柔光物語",
  "settings.skin.pastelDescription":
    "低飽和療癒漸層與大圓角視窗，方便替換成自己的插畫背景。",
  "settings.skin.errorFormat": "不支援的圖片格式（僅 PNG / JPEG / WebP）",
  "settings.skin.errorSize": "圖片超過 4 MiB 上限",
  "settings.skin.errorDimension": "圖片尺寸超過 4096px 上限",
  "settings.skin.errorRead": "無法讀取該圖片",
  "settings.skin.errorPack": "皮膚包無效或包含不支援的資源",
  "settings.skin.errorPackSize": "皮膚包超過 16 MiB / 16 個項目上限",
  "settings.skin.errorExists": "相同 id 的皮膚已安裝",
  "settings.skin.errorWrite": "皮膚寫入或刪除失敗",
  "settings.skin.errorName": "皮膚名稱無效",
  "settings.skin.errorRange": "內縮邊距或通透度超出允許範圍",
  "settings.skin.errorFrame": "畫框貼圖必須是透明 PNG",

  "settings.shortcuts.enabled": "全域快捷鍵已啟用",
  "settings.shortcuts.disabled": "全域快捷鍵已關閉",
  "settings.shortcuts.count": "{count} 組對應",
  "settings.shortcuts.open": "檢視/設定快捷鍵清單",
  "settings.shortcuts.openHint": "輸入狀態與輸入法組字時自動豁免",
  "settings.shortcuts.reset": "恢復預設",
  "settings.shortcuts.resetDone": "快捷鍵已恢復預設",
  "settings.shortcuts.sheetDescription":
    "鍵位在輸入框聚焦或輸入法組字中一律不觸發（Ctrl/Cmd+W 除外）。",
  "settings.shortcuts.toggle": "啟用全域快捷鍵",
  "settings.shortcuts.toggleHint": "關閉後主介面與閱讀器不再回應任何全域鍵位。",

  "settings.filter.engineTitle": "線上提純引擎",
  "settings.filter.engineDescription":
    "依站點檔案與規則攔截廣告、導覽與佔位圖。",
  "settings.filter.engineSwitch": "提純引擎",
  "settings.filter.engineSwitchHint": "關閉後線上頁面依原始 HTML 呈現。",
  "settings.filter.open": "過濾規則與站點檔案",
  "settings.filter.openHint": "{rules} 條規則 · {profiles} 個站點檔案",

  "settings.cache.budgetBadge": "額度 {size} MB",
  "settings.cache.detailOpen": "配額與快取明細",
  "settings.cache.detailOpenHint": "調整上限 / 檢視算圖與線上快取",

  "settings.webAccess.pairedDevices": "{count} 台已配對",
  "settings.webAccess.accessUrlLabel": "存取位址",
  "settings.webAccess.quickHint":
    "同一區域網路內的裝置可掃碼或輸入位址存取書庫。",
  "settings.webAccess.quickToggle": "區域網路存取",
  "settings.webAccess.quickToggleHint":
    "開啟後在目前網路內提供書庫瀏覽與閱讀。",
  "settings.webAccess.openAdvanced": "進階設定（CA / 配對裝置）",
  "settings.webAccess.openAdvancedHint":
    "憑證輪替、指紋核對、OPDS 憑證與裝置管理",

  "privacy.detail.open": "檢視完整安全自檢明細 & 匯出診斷包",
  "privacy.detail.openHint": "{pass} 項通過 · {warn} 項提醒",
  "privacy.detail.reportTitle": "安全自檢報告",
  "privacy.detail.exportTitle": "診斷包匯出",
};

const en = {

  "settings.skin.title": "Interface skins and frames",
  "settings.skin.description":
    "The whole window is one themed canvas, with the library and settings inside an inset viewport. Framed reskins only — no floating mascots.",
  "settings.skin.open": "Interface skins and frames",
  "settings.skin.openHint": "Frame gallery / local skin packs",
  "settings.skin.active": "In use",
  "settings.skin.apply": "Apply",
  "settings.skin.builtin": "Built-in",
  "settings.skin.installed": "Local",
  "settings.skin.colorLight": "Light",
  "settings.skin.colorDark": "Dark",
  "settings.skin.colorBoth": "Light + dark",
  "settings.skin.importPack": "Import .moyuskin pack",
  "settings.skin.createCustom": "Create a background/frame skin",
  "settings.skin.installedCount": "{count} local skins",
  "settings.skin.export": "Export",
  "settings.skin.delete": "Delete",
  "settings.skin.deleteTitle": "Delete local skin",
  "settings.skin.deleteBody":
    "This removes “{name}” and its local images. If it is in use, the minimal default is restored.",
  "settings.skin.deleteDone": "Local skin deleted",
  "settings.skin.exportDone": "Skin pack exported",
  "settings.skin.importDone": "Skin pack imported and applied",
  "settings.skin.importHint":
    "A pack only contains a manifest and PNG / JPEG / WebP images. Nothing is uploaded.",
  "settings.skin.importSessionOnly":
    "Skin images are stored only in the local app data directory.",
  "settings.skin.customName": "Custom skin",
  "settings.skin.builderTitle": "Create a framed skin",
  "settings.skin.builderHint":
    "Pick a full-page background (and an optional transparent PNG frame), then drag the sliders for a live preview.",
  "settings.skin.nameLabel": "Skin name",
  "settings.skin.namePlaceholder": "e.g. My summer frame",
  "settings.skin.backdropLabel": "Full-page background",
  "settings.skin.backdropHint":
    "PNG / JPEG / WebP, up to 4 MiB and 4096px.",
  "settings.skin.frameLabel": "Outer frame (optional)",
  "settings.skin.frameHint":
    "A PNG with transparent areas, painted around the viewport.",
  "settings.skin.frameNone": "No frame selected",
  "settings.skin.insetLabel": "Viewport inset",
  "settings.skin.opacityLabel": "Panel opacity",
  "settings.skin.numericValue": "{value}{unit}",
  "settings.skin.previewLabel": "Live preview",
  "settings.skin.createAction": "Create and apply",
  "settings.skin.creating": "Creating…",
  "settings.skin.createDone": "Custom skin created and applied",
  "settings.skin.defaultName": "Minimal (default)",
  "settings.skin.defaultDescription": "0px inset, fullscreen, no extra cost.",
  "settings.skin.inkName": "Ink Gallery",
  "settings.skin.inkDescription":
    "Paper grain, an inset frame, and calm negative space for long reading sessions.",
  "settings.skin.midnightName": "Midnight Neon",
  "settings.skin.midnightDescription":
    "A deep nebula grid canvas with a glowing hairline frame and frosted viewport.",
  "settings.skin.pastelName": "Pastel Canvas",
  "settings.skin.pastelDescription":
    "Low-saturation gradients and large rounded corners, ready for your own illustration.",
  "settings.skin.errorFormat":
    "Unsupported image format (PNG / JPEG / WebP only)",
  "settings.skin.errorSize": "Image exceeds the 4 MiB limit",
  "settings.skin.errorDimension": "Image exceeds the 4096px limit",
  "settings.skin.errorRead": "This image could not be read",
  "settings.skin.errorPack":
    "The skin pack is invalid or contains unsupported resources",
  "settings.skin.errorPackSize":
    "The skin pack exceeds 16 MiB or 16 entries",
  "settings.skin.errorExists": "A skin with that id is already installed",
  "settings.skin.errorWrite": "The skin could not be written or deleted",
  "settings.skin.errorName": "Invalid skin name",
  "settings.skin.errorRange": "Inset or opacity is outside the allowed range",
  "settings.skin.errorFrame": "The frame artwork must be a transparent PNG",

  "settings.shortcuts.enabled": "Global shortcuts on",
  "settings.shortcuts.disabled": "Global shortcuts off",
  "settings.shortcuts.count": "{count} mappings",
  "settings.shortcuts.open": "View / configure shortcut list",
  "settings.shortcuts.openHint": "Skipped while typing or composing IME text",
  "settings.shortcuts.reset": "Restore defaults",
  "settings.shortcuts.resetDone": "Shortcuts restored to defaults",
  "settings.shortcuts.sheetDescription":
    "Keys never fire while an input is focused or an IME composition is active (Ctrl/Cmd+W is the only exception).",
  "settings.shortcuts.toggle": "Enable global shortcuts",
  "settings.shortcuts.toggleHint":
    "When off, neither the shell nor the reader reacts to global keys.",

  "settings.filter.engineTitle": "Online purification engine",
  "settings.filter.engineDescription":
    "Blocks ads, navigation chrome and placeholder images using site profiles and rules.",
  "settings.filter.engineSwitch": "Purification engine",
  "settings.filter.engineSwitchHint":
    "When off, online pages render from raw HTML.",
  "settings.filter.open": "Filter rules & site profiles",
  "settings.filter.openHint": "{rules} rules · {profiles} site profiles",

  "settings.cache.budgetBadge": "Budget {size} MB",
  "settings.cache.detailOpen": "Quota & cache details",
  "settings.cache.detailOpenHint":
    "Adjust the limit / inspect render and online caches",

  "settings.webAccess.pairedDevices": "{count} paired",
  "settings.webAccess.accessUrlLabel": "Access URL",
  "settings.webAccess.quickHint":
    "Devices on the same LAN can scan the code or open the URL to browse this library.",
  "settings.webAccess.quickToggle": "LAN access",
  "settings.webAccess.quickToggleHint":
    "Serves this library to the current network while on.",
  "settings.webAccess.openAdvanced": "Advanced (CA / paired devices)",
  "settings.webAccess.openAdvancedHint":
    "Certificate rotation, fingerprint checks, OPDS credentials and devices",

  "privacy.detail.open": "View the full security report & export diagnostics",
  "privacy.detail.openHint": "{pass} passed · {warn} warnings",
  "privacy.detail.reportTitle": "Security self-check report",
  "privacy.detail.exportTitle": "Diagnostics export",
};

const es = {

  "settings.skin.title": "Pieles y marcos de interfaz",
  "settings.skin.description":
    "Toda la ventana es un lienzo temático y la biblioteca y los ajustes viven en una vista interior. Solo cambia el marco: sin mascotas flotantes.",
  "settings.skin.open": "Pieles y marcos de interfaz",
  "settings.skin.openHint": "Galería de marcos / paquetes locales",
  "settings.skin.active": "En uso",
  "settings.skin.apply": "Aplicar",
  "settings.skin.builtin": "Integrada",
  "settings.skin.installed": "Local",
  "settings.skin.colorLight": "Clara",
  "settings.skin.colorDark": "Oscura",
  "settings.skin.colorBoth": "Clara y oscura",
  "settings.skin.importPack": "Importar paquete .moyuskin",
  "settings.skin.createCustom": "Crear piel de fondo/marco",
  "settings.skin.installedCount": "{count} pieles locales",
  "settings.skin.export": "Exportar",
  "settings.skin.delete": "Eliminar",
  "settings.skin.deleteTitle": "Eliminar piel local",
  "settings.skin.deleteBody":
    "Se eliminará «{name}» y sus imágenes locales. Si está en uso, se volverá al modo mínimo.",
  "settings.skin.deleteDone": "Piel local eliminada",
  "settings.skin.exportDone": "Paquete de piel exportado",
  "settings.skin.importDone": "Paquete importado y aplicado",
  "settings.skin.importHint":
    "El paquete solo contiene un manifiesto e imágenes PNG / JPEG / WebP. Nunca se sube nada.",
  "settings.skin.importSessionOnly":
    "Las imágenes se guardan solo en la carpeta de datos local de la app.",
  "settings.skin.customName": "Piel propia",
  "settings.skin.builderTitle": "Crear una piel de marco",
  "settings.skin.builderHint":
    "Elige un fondo de página completa (y un PNG transparente opcional) y ajusta las barras para previsualizar.",
  "settings.skin.nameLabel": "Nombre de la piel",
  "settings.skin.namePlaceholder": "p. ej. Mi marco de verano",
  "settings.skin.backdropLabel": "Fondo de página completa",
  "settings.skin.backdropHint":
    "PNG / JPEG / WebP, hasta 4 MiB y 4096 px.",
  "settings.skin.frameLabel": "Marco exterior (opcional)",
  "settings.skin.frameHint":
    "Un PNG con zonas transparentes; se coloca alrededor de la vista.",
  "settings.skin.frameNone": "Sin marco",
  "settings.skin.insetLabel": "Margen de la vista",
  "settings.skin.opacityLabel": "Opacidad del panel",
  "settings.skin.numericValue": "{value}{unit}",
  "settings.skin.previewLabel": "Vista previa",
  "settings.skin.createAction": "Crear y aplicar",
  "settings.skin.creating": "Creando…",
  "settings.skin.createDone": "Piel creada y aplicada",
  "settings.skin.defaultName": "Mínimo (predeterminado)",
  "settings.skin.defaultDescription":
    "0 px de margen, pantalla completa, sin coste extra.",
  "settings.skin.inkName": "Galería de tinta",
  "settings.skin.inkDescription":
    "Textura de papel, marco interior y mucho aire para leer sin fatiga.",
  "settings.skin.midnightName": "Neón de medianoche",
  "settings.skin.midnightDescription":
    "Lienzo de nebulosa con rejilla, borde luminoso y vista de cristal esmerilado.",
  "settings.skin.pastelName": "Luz pastel",
  "settings.skin.pastelDescription":
    "Degradados suaves y esquinas muy redondeadas, listos para tu propia ilustración.",
  "settings.skin.errorFormat":
    "Formato no compatible (solo PNG / JPEG / WebP)",
  "settings.skin.errorSize": "La imagen supera el límite de 4 MiB",
  "settings.skin.errorDimension": "La imagen supera el límite de 4096 px",
  "settings.skin.errorRead": "No se pudo leer esta imagen",
  "settings.skin.errorPack":
    "El paquete no es válido o contiene recursos no compatibles",
  "settings.skin.errorPackSize":
    "El paquete supera 16 MiB o 16 entradas",
  "settings.skin.errorExists": "Ya hay una piel instalada con ese id",
  "settings.skin.errorWrite": "No se pudo escribir o eliminar la piel",
  "settings.skin.errorName": "Nombre de piel no válido",
  "settings.skin.errorRange":
    "El margen o la opacidad están fuera del rango permitido",
  "settings.skin.errorFrame": "El marco debe ser un PNG transparente",

  "settings.shortcuts.enabled": "Atajos globales activados",
  "settings.shortcuts.disabled": "Atajos globales desactivados",
  "settings.shortcuts.count": "{count} combinaciones",
  "settings.shortcuts.open": "Ver / configurar la lista de atajos",
  "settings.shortcuts.openHint": "Se omiten al escribir o componer con IME",
  "settings.shortcuts.reset": "Restaurar valores",
  "settings.shortcuts.resetDone": "Atajos restaurados",
  "settings.shortcuts.sheetDescription":
    "Las teclas no se activan con un campo enfocado ni durante la composición de un IME (Ctrl/Cmd+W es la única excepción).",
  "settings.shortcuts.toggle": "Activar atajos globales",
  "settings.shortcuts.toggleHint":
    "Al desactivarlos, ni la interfaz ni el lector responden a teclas globales.",

  "settings.filter.engineTitle": "Motor de purificación en línea",
  "settings.filter.engineDescription":
    "Bloquea anuncios, navegación y marcadores de posición con perfiles y reglas por sitio.",
  "settings.filter.engineSwitch": "Motor de purificación",
  "settings.filter.engineSwitchHint":
    "Al desactivarlo, las páginas se muestran con el HTML original.",
  "settings.filter.open": "Reglas de filtrado y perfiles de sitio",
  "settings.filter.openHint": "{rules} reglas · {profiles} perfiles de sitio",

  "settings.cache.budgetBadge": "Límite {size} MB",
  "settings.cache.detailOpen": "Cuota y detalles de caché",
  "settings.cache.detailOpenHint":
    "Ajustar el límite / ver caché de renderizado y en línea",

  "settings.webAccess.pairedDevices": "{count} vinculados",
  "settings.webAccess.accessUrlLabel": "URL de acceso",
  "settings.webAccess.quickHint":
    "Los dispositivos de la misma LAN pueden escanear el código o abrir la URL para explorar la biblioteca.",
  "settings.webAccess.quickToggle": "Acceso por LAN",
  "settings.webAccess.quickToggleHint":
    "Mientras está activo, sirve la biblioteca a la red actual.",
  "settings.webAccess.openAdvanced": "Avanzado (CA / dispositivos)",
  "settings.webAccess.openAdvancedHint":
    "Rotación de certificados, huellas, credenciales OPDS y dispositivos",

  "privacy.detail.open":
    "Ver el informe de seguridad completo y exportar diagnósticos",
  "privacy.detail.openHint": "{pass} correctos · {warn} avisos",
  "privacy.detail.reportTitle": "Informe de autocomprobación",
  "privacy.detail.exportTitle": "Exportar diagnóstico",
};

const ja = {

  "settings.skin.title": "インターフェーススキンと額装テーマ",
  "settings.skin.description":
    "ウィンドウ全体がテーマキャンバスで、書庫と設定は内側のビューポートに収まります。額装の着せ替えのみで、浮遊マスコットはありません。",
  "settings.skin.open": "インターフェーススキンと額装テーマ",
  "settings.skin.openHint": "額装ギャラリー / ローカルパック",
  "settings.skin.active": "使用中",
  "settings.skin.apply": "適用",
  "settings.skin.builtin": "内蔵",
  "settings.skin.installed": "ローカル",
  "settings.skin.colorLight": "ライト",
  "settings.skin.colorDark": "ダーク",
  "settings.skin.colorBoth": "ライト・ダーク共通",
  "settings.skin.importPack": ".moyuskin パックを読み込む",
  "settings.skin.createCustom": "背景・額装スキンを自作",
  "settings.skin.installedCount": "ローカルスキン {count} 件",
  "settings.skin.export": "書き出す",
  "settings.skin.delete": "削除",
  "settings.skin.deleteTitle": "ローカルスキンを削除",
  "settings.skin.deleteBody":
    "「{name}」とローカル画像を削除します。使用中の場合は最小表示に戻ります。",
  "settings.skin.deleteDone": "ローカルスキンを削除しました",
  "settings.skin.exportDone": "スキンパックを書き出しました",
  "settings.skin.importDone": "スキンパックを読み込んで適用しました",
  "settings.skin.importHint":
    "パックにはマニフェストと PNG / JPEG / WebP 画像のみが含まれ、サーバーへ送信されません。",
  "settings.skin.importSessionOnly":
    "画像はアプリのローカルデータフォルダーにのみ保存されます。",
  "settings.skin.customName": "自作スキン",
  "settings.skin.builderTitle": "額装スキンを自作",
  "settings.skin.builderHint":
    "全ページ背景（任意で透過 PNG の額装）を選び、スライダーでリアルタイムに確認できます。",
  "settings.skin.nameLabel": "スキン名",
  "settings.skin.namePlaceholder": "例：夏の額装",
  "settings.skin.backdropLabel": "全ページ背景",
  "settings.skin.backdropHint":
    "PNG / JPEG / WebP、4 MiB・4096px 以下。",
  "settings.skin.frameLabel": "外側の額装（任意）",
  "settings.skin.frameHint":
    "透過部分のある PNG。ビューポートの外側に敷きます。",
  "settings.skin.frameNone": "額装なし",
  "settings.skin.insetLabel": "ビューポートの余白",
  "settings.skin.opacityLabel": "パネルの透過度",
  "settings.skin.numericValue": "{value}{unit}",
  "settings.skin.previewLabel": "リアルタイムプレビュー",
  "settings.skin.createAction": "作成して適用",
  "settings.skin.creating": "作成中…",
  "settings.skin.createDone": "自作スキンを作成して適用しました",
  "settings.skin.defaultName": "ミニマル（既定）",
  "settings.skin.defaultDescription": "余白 0px、全画面、追加コストなし。",
  "settings.skin.inkName": "紙墨ギャラリー",
  "settings.skin.inkDescription":
    "和紙のような質感と内側の額装。静かな余白で長時間の読書に向きます。",
  "settings.skin.midnightName": "ミッドナイトネオン",
  "settings.skin.midnightDescription":
    "深い星雲とグリッドのキャンバス、発光する細枠とすりガラスのビューポート。",
  "settings.skin.pastelName": "パステルストーリー",
  "settings.skin.pastelDescription":
    "低彩度のやさしいグラデーションと大きな角丸。自作イラストにも置き換えやすい構成です。",
  "settings.skin.errorFormat":
    "未対応の画像形式です（PNG / JPEG / WebP のみ）",
  "settings.skin.errorSize": "画像が 4 MiB の上限を超えています",
  "settings.skin.errorDimension": "画像が 4096px の上限を超えています",
  "settings.skin.errorRead": "この画像を読み込めませんでした",
  "settings.skin.errorPack":
    "スキンパックが無効、または未対応のリソースを含みます",
  "settings.skin.errorPackSize":
    "パックが 16 MiB / 16 エントリの上限を超えています",
  "settings.skin.errorExists": "同じ id のスキンが既にインストールされています",
  "settings.skin.errorWrite": "スキンの書き込みまたは削除に失敗しました",
  "settings.skin.errorName": "スキン名が無効です",
  "settings.skin.errorRange": "余白または透過度が許容範囲外です",
  "settings.skin.errorFrame": "額装画像は透過 PNG である必要があります",

  "settings.shortcuts.enabled": "グローバルショートカット有効",
  "settings.shortcuts.disabled": "グローバルショートカット無効",
  "settings.shortcuts.count": "{count} 組の割り当て",
  "settings.shortcuts.open": "ショートカット一覧を表示/設定",
  "settings.shortcuts.openHint": "入力中と IME 変換中は自動的に無効",
  "settings.shortcuts.reset": "既定に戻す",
  "settings.shortcuts.resetDone": "ショートカットを既定に戻しました",
  "settings.shortcuts.sheetDescription":
    "入力欄にフォーカスがある間や IME 変換中はキーを処理しません（Ctrl/Cmd+W のみ例外）。",
  "settings.shortcuts.toggle": "グローバルショートカットを有効化",
  "settings.shortcuts.toggleHint":
    "オフにするとシェルもリーダーもグローバルキーに反応しません。",

  "settings.filter.engineTitle": "オンライン浄化エンジン",
  "settings.filter.engineDescription":
    "サイトプロファイルとルールで広告・ナビゲーション・プレースホルダー画像を遮断します。",
  "settings.filter.engineSwitch": "浄化エンジン",
  "settings.filter.engineSwitchHint":
    "オフにするとオンラインページは元の HTML で描画されます。",
  "settings.filter.open": "フィルタールールとサイトプロファイル",
  "settings.filter.openHint": "ルール {rules} 件 · サイト {profiles} 件",

  "settings.cache.budgetBadge": "上限 {size} MB",
  "settings.cache.detailOpen": "割当とキャッシュの詳細",
  "settings.cache.detailOpenHint": "上限の調整 / 描画・オンラインキャッシュの確認",

  "settings.webAccess.pairedDevices": "{count} 台ペアリング済み",
  "settings.webAccess.accessUrlLabel": "アクセス URL",
  "settings.webAccess.quickHint":
    "同じ LAN の端末から QR コードまたは URL で書庫を開けます。",
  "settings.webAccess.quickToggle": "LAN アクセス",
  "settings.webAccess.quickToggleHint":
    "オンの間、現在のネットワークに書庫を公開します。",
  "settings.webAccess.openAdvanced": "詳細設定（CA / ペアリング端末）",
  "settings.webAccess.openAdvancedHint":
    "証明書の更新、指紋確認、OPDS 認証情報、端末管理",

  "privacy.detail.open": "セキュリティ診断の全詳細と診断パッケージを書き出す",
  "privacy.detail.openHint": "{pass} 件合格 · {warn} 件注意",
  "privacy.detail.reportTitle": "セキュリティ自己診断レポート",
  "privacy.detail.exportTitle": "診断パッケージの書き出し",
};

const ko = {

  "settings.skin.title": "인터페이스 스킨 및 액자 테마",
  "settings.skin.description":
    "창 전체가 테마 캔버스이고 서재와 설정은 안쪽 뷰포트에 들어갑니다. 액자 스킨만 바꾸며 떠다니는 마스코트는 없습니다.",
  "settings.skin.open": "인터페이스 스킨 및 액자 테마",
  "settings.skin.openHint": "액자 갤러리 / 로컬 스킨 팩",
  "settings.skin.active": "사용 중",
  "settings.skin.apply": "적용",
  "settings.skin.builtin": "기본 제공",
  "settings.skin.installed": "로컬",
  "settings.skin.colorLight": "라이트",
  "settings.skin.colorDark": "다크",
  "settings.skin.colorBoth": "라이트·다크 공용",
  "settings.skin.importPack": ".moyuskin 스킨 팩 가져오기",
  "settings.skin.createCustom": "배경/액자 스킨 직접 만들기",
  "settings.skin.installedCount": "로컬 스킨 {count}개",
  "settings.skin.export": "내보내기",
  "settings.skin.delete": "삭제",
  "settings.skin.deleteTitle": "로컬 스킨 삭제",
  "settings.skin.deleteBody":
    "「{name}」과 로컬 이미지를 삭제합니다. 사용 중이면 미니멀 기본으로 돌아갑니다.",
  "settings.skin.deleteDone": "로컬 스킨을 삭제했습니다",
  "settings.skin.exportDone": "스킨 팩을 내보냈습니다",
  "settings.skin.importDone": "스킨 팩을 가져와 적용했습니다",
  "settings.skin.importHint":
    "스킨 팩에는 매니페스트와 PNG / JPEG / WebP 이미지만 들어 있으며 서버로 전송되지 않습니다.",
  "settings.skin.importSessionOnly":
    "이미지는 앱의 로컬 데이터 폴더에만 저장됩니다.",
  "settings.skin.customName": "사용자 스킨",
  "settings.skin.builderTitle": "액자 스킨 직접 만들기",
  "settings.skin.builderHint":
    "전체 배경(선택: 투명 PNG 액자)을 고르고 슬라이더로 실시간 확인하세요.",
  "settings.skin.nameLabel": "스킨 이름",
  "settings.skin.namePlaceholder": "예: 나의 여름 액자",
  "settings.skin.backdropLabel": "전체 배경",
  "settings.skin.backdropHint":
    "PNG / JPEG / WebP, 4 MiB·4096px 이하.",
  "settings.skin.frameLabel": "바깥 액자(선택)",
  "settings.skin.frameHint":
    "투명 영역이 있는 PNG. 뷰포트 바깥에 깔립니다.",
  "settings.skin.frameNone": "액자 없음",
  "settings.skin.insetLabel": "뷰포트 여백",
  "settings.skin.opacityLabel": "패널 투명도",
  "settings.skin.numericValue": "{value}{unit}",
  "settings.skin.previewLabel": "실시간 미리보기",
  "settings.skin.createAction": "만들고 적용",
  "settings.skin.creating": "만드는 중…",
  "settings.skin.createDone": "사용자 스킨을 만들고 적용했습니다",
  "settings.skin.defaultName": "미니멀(기본)",
  "settings.skin.defaultDescription": "여백 0px, 전체 화면, 추가 비용 없음.",
  "settings.skin.inkName": "종이와 먹 갤러리",
  "settings.skin.inkDescription":
    "한지 질감과 안쪽 액자, 여백이 넉넉해 오래 읽기 좋습니다.",
  "settings.skin.midnightName": "미드나이트 네온",
  "settings.skin.midnightDescription":
    "깊은 성운과 그리드 캔버스, 빛나는 얇은 테두리와 반투명 유리 뷰포트.",
  "settings.skin.pastelName": "파스텔 스토리",
  "settings.skin.pastelDescription":
    "저채도 부드러운 그라데이션과 큰 둥근 모서리. 자신의 일러스트로 바꾸기 좋은 구성입니다.",
  "settings.skin.errorFormat":
    "지원하지 않는 이미지 형식입니다(PNG / JPEG / WebP 전용)",
  "settings.skin.errorSize": "이미지가 4 MiB 한도를 초과했습니다",
  "settings.skin.errorDimension": "이미지가 4096px 한도를 초과했습니다",
  "settings.skin.errorRead": "이미지를 읽을 수 없습니다",
  "settings.skin.errorPack":
    "스킨 팩이 유효하지 않거나 지원하지 않는 리소스가 있습니다",
  "settings.skin.errorPackSize":
    "스킨 팩이 16 MiB / 16개 항목 한도를 초과했습니다",
  "settings.skin.errorExists": "같은 id의 스킨이 이미 설치되어 있습니다",
  "settings.skin.errorWrite": "스킨 쓰기 또는 삭제에 실패했습니다",
  "settings.skin.errorName": "스킨 이름이 올바르지 않습니다",
  "settings.skin.errorRange": "여백 또는 투명도가 허용 범위를 벗어났습니다",
  "settings.skin.errorFrame": "액자 이미지는 투명 PNG여야 합니다",

  "settings.shortcuts.enabled": "전역 단축키 사용 중",
  "settings.shortcuts.disabled": "전역 단축키 꺼짐",
  "settings.shortcuts.count": "{count}개 매핑",
  "settings.shortcuts.open": "단축키 목록 보기/설정",
  "settings.shortcuts.openHint": "입력 중과 IME 조합 중에는 자동 제외",
  "settings.shortcuts.reset": "기본값 복원",
  "settings.shortcuts.resetDone": "단축키를 기본값으로 복원했습니다",
  "settings.shortcuts.sheetDescription":
    "입력창에 포커스가 있거나 IME 조합 중에는 키가 동작하지 않습니다(Ctrl/Cmd+W 만 예외).",
  "settings.shortcuts.toggle": "전역 단축키 사용",
  "settings.shortcuts.toggleHint":
    "끄면 셸과 리더 모두 전역 키에 반응하지 않습니다.",

  "settings.filter.engineTitle": "온라인 정제 엔진",
  "settings.filter.engineDescription":
    "사이트 프로필과 규칙으로 광고, 내비게이션, 자리표시자 이미지를 차단합니다.",
  "settings.filter.engineSwitch": "정제 엔진",
  "settings.filter.engineSwitchHint":
    "끄면 온라인 페이지를 원본 HTML 로 렌더링합니다.",
  "settings.filter.open": "필터 규칙과 사이트 프로필",
  "settings.filter.openHint": "규칙 {rules}개 · 사이트 {profiles}개",

  "settings.cache.budgetBadge": "예산 {size} MB",
  "settings.cache.detailOpen": "할당량과 캐시 세부정보",
  "settings.cache.detailOpenHint":
    "상한 조정 / 렌더·온라인 캐시 확인",

  "settings.webAccess.pairedDevices": "{count}대 연결됨",
  "settings.webAccess.accessUrlLabel": "접속 주소",
  "settings.webAccess.quickHint":
    "같은 LAN 의 기기에서 QR 코드나 주소로 서재를 열 수 있습니다.",
  "settings.webAccess.quickToggle": "LAN 접속",
  "settings.webAccess.quickToggleHint":
    "켜면 현재 네트워크에 서재를 제공합니다.",
  "settings.webAccess.openAdvanced": "고급 설정(CA / 연결 기기)",
  "settings.webAccess.openAdvancedHint":
    "인증서 교체, 지문 확인, OPDS 자격 증명, 기기 관리",

  "privacy.detail.open": "보안 자가진단 전체 보기 및 진단 패키지 내보내기",
  "privacy.detail.openHint": "{pass}개 통과 · {warn}개 주의",
  "privacy.detail.reportTitle": "보안 자가진단 보고서",
  "privacy.detail.exportTitle": "진단 패키지 내보내기",
};

export const settingsDetailMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
