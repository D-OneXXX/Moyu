/**
 * Settings progressive-disclosure strings (Task 2/8) and the skin/mascot slot
 * strings (Task 7). Kept in one module so the six dictionaries stay in sync.
 */
const zhCN = {
  "settings.brandIcon.open": "更换品牌图标",
  "settings.brandIcon.openHint": "内置图标 / 自定义上传",

  "settings.skin.title": "界面风格与角色挂件",
  "settings.skin.description":
    "一套 CSS 变量即可切换整体骨骼质感；装饰层永不拦截点击与滚动。",
  "settings.skin.decorationCount": "{count} 个挂件",
  "settings.skin.open": "选择界面风格",
  "settings.skin.openHint": "挂件在阅读路由自动卸载",
  "settings.skin.active": "使用中",
  "settings.skin.apply": "应用",
  "settings.skin.import": "导入本地立绘",
  "settings.skin.importHint":
    "经后端校验图片头与尺寸后转为 data: URL，全程不联网。",
  "settings.skin.importDone": "已应用本地立绘",
  "settings.skin.customName": "自定义素材",
  "settings.skin.defaultName": "极简（默认）",
  "settings.skin.defaultDescription": "零装饰、零额外开销。",
  "settings.skin.companionName": "墨鱼陪伴",
  "settings.skin.companionDescription": "右下角看板角色 + 顶栏趴趴挂件。",
  "settings.skin.errorFormat": "不支持的图片格式（仅 PNG / JPEG / WebP / GIF）",
  "settings.skin.errorSize": "图片超过 8 MB 上限",
  "settings.skin.errorDimension": "图片尺寸超过 4096px 上限",
  "settings.skin.errorRead": "无法读取该图片",

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
  "settings.webAccess.openAdvanced": "高级配置（CA / OPDS / 配对设备）",
  "settings.webAccess.openAdvancedHint":
    "证书轮换、指纹核对、OPDS 凭据与设备管理",

  "privacy.detail.open": "查看完整安全自检明细 & 导出诊断包",
  "privacy.detail.openHint": "{pass} 项通过 · {warn} 项提醒",
  "privacy.detail.reportTitle": "安全自检报告",
  "privacy.detail.exportTitle": "诊断包导出",
};

const zhTW = {
  "settings.brandIcon.open": "更換品牌圖示",
  "settings.brandIcon.openHint": "內建圖示 / 自訂上傳",

  "settings.skin.title": "介面風格與角色掛件",
  "settings.skin.description":
    "一組 CSS 變數即可切換整體骨架質感；裝飾層永不攔截點擊與捲動。",
  "settings.skin.decorationCount": "{count} 個掛件",
  "settings.skin.open": "選擇介面風格",
  "settings.skin.openHint": "掛件在閱讀路由自動卸載",
  "settings.skin.active": "使用中",
  "settings.skin.apply": "套用",
  "settings.skin.import": "匯入本機立繪",
  "settings.skin.importHint":
    "經後端校驗圖片標頭與尺寸後轉為 data: URL，全程不連網。",
  "settings.skin.importDone": "已套用本機立繪",
  "settings.skin.customName": "自訂素材",
  "settings.skin.defaultName": "極簡（預設）",
  "settings.skin.defaultDescription": "零裝飾、零額外開銷。",
  "settings.skin.companionName": "墨魚陪伴",
  "settings.skin.companionDescription": "右下角看板角色 + 頂欄趴趴掛件。",
  "settings.skin.errorFormat": "不支援的圖片格式（僅 PNG / JPEG / WebP / GIF）",
  "settings.skin.errorSize": "圖片超過 8 MB 上限",
  "settings.skin.errorDimension": "圖片尺寸超過 4096px 上限",
  "settings.skin.errorRead": "無法讀取該圖片",

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
  "settings.webAccess.openAdvanced": "進階設定（CA / OPDS / 配對裝置）",
  "settings.webAccess.openAdvancedHint":
    "憑證輪替、指紋核對、OPDS 憑證與裝置管理",

  "privacy.detail.open": "檢視完整安全自檢明細 & 匯出診斷包",
  "privacy.detail.openHint": "{pass} 項通過 · {warn} 項提醒",
  "privacy.detail.reportTitle": "安全自檢報告",
  "privacy.detail.exportTitle": "診斷包匯出",
};

const en = {
  "settings.brandIcon.open": "Change brand icon",
  "settings.brandIcon.openHint": "Built-in presets or your own upload",

  "settings.skin.title": "Appearance & companion",
  "settings.skin.description":
    "One set of CSS variables reshapes the whole UI; the decoration layer never blocks clicks or scrolling.",
  "settings.skin.decorationCount": "{count} decorations",
  "settings.skin.open": "Choose a look",
  "settings.skin.openHint": "Decorations unmount on the reader route",
  "settings.skin.active": "In use",
  "settings.skin.apply": "Apply",
  "settings.skin.import": "Import artwork",
  "settings.skin.importHint":
    "Validated by the backend (header + dimensions), then loaded as a data: URL. No network.",
  "settings.skin.importDone": "Artwork applied",
  "settings.skin.customName": "Custom artwork",
  "settings.skin.defaultName": "Minimal (default)",
  "settings.skin.defaultDescription": "No decorations, no extra cost.",
  "settings.skin.companionName": "Ink companion",
  "settings.skin.companionDescription":
    "A corner companion plus a perch mascot above the top bar.",
  "settings.skin.errorFormat":
    "Unsupported image format (PNG / JPEG / WebP / GIF only)",
  "settings.skin.errorSize": "Image exceeds the 8 MB limit",
  "settings.skin.errorDimension": "Image exceeds the 4096px limit",
  "settings.skin.errorRead": "This image could not be read",

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
  "settings.webAccess.openAdvanced": "Advanced (CA / OPDS / paired devices)",
  "settings.webAccess.openAdvancedHint":
    "Certificate rotation, fingerprint checks, OPDS credentials and devices",

  "privacy.detail.open": "View the full security report & export diagnostics",
  "privacy.detail.openHint": "{pass} passed · {warn} warnings",
  "privacy.detail.reportTitle": "Security self-check report",
  "privacy.detail.exportTitle": "Diagnostics export",
};

const es = {
  "settings.brandIcon.open": "Cambiar el icono de marca",
  "settings.brandIcon.openHint": "Iconos integrados o tu propia imagen",

  "settings.skin.title": "Aspecto y compañero",
  "settings.skin.description":
    "Un juego de variables CSS redefine toda la interfaz; la capa decorativa nunca bloquea clics ni desplazamiento.",
  "settings.skin.decorationCount": "{count} decoraciones",
  "settings.skin.open": "Elegir un aspecto",
  "settings.skin.openHint": "Las decoraciones se desmontan en el lector",
  "settings.skin.active": "En uso",
  "settings.skin.apply": "Aplicar",
  "settings.skin.import": "Importar ilustración",
  "settings.skin.importHint":
    "El backend valida la cabecera y las dimensiones y la convierte en data: URL. Sin red.",
  "settings.skin.importDone": "Ilustración aplicada",
  "settings.skin.customName": "Material propio",
  "settings.skin.defaultName": "Mínimo (predeterminado)",
  "settings.skin.defaultDescription": "Sin decoraciones ni coste extra.",
  "settings.skin.companionName": "Compañero tinta",
  "settings.skin.companionDescription":
    "Personaje en la esquina y mascota sobre la barra superior.",
  "settings.skin.errorFormat":
    "Formato no compatible (solo PNG / JPEG / WebP / GIF)",
  "settings.skin.errorSize": "La imagen supera el límite de 8 MB",
  "settings.skin.errorDimension": "La imagen supera el límite de 4096 px",
  "settings.skin.errorRead": "No se pudo leer esta imagen",

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
  "settings.webAccess.openAdvanced": "Avanzado (CA / OPDS / dispositivos)",
  "settings.webAccess.openAdvancedHint":
    "Rotación de certificados, huellas, credenciales OPDS y dispositivos",

  "privacy.detail.open":
    "Ver el informe de seguridad completo y exportar diagnósticos",
  "privacy.detail.openHint": "{pass} correctos · {warn} avisos",
  "privacy.detail.reportTitle": "Informe de autocomprobación",
  "privacy.detail.exportTitle": "Exportar diagnóstico",
};

const ja = {
  "settings.brandIcon.open": "ブランドアイコンを変更",
  "settings.brandIcon.openHint": "内蔵アイコン / 独自アップロード",

  "settings.skin.title": "外観スタイルと相棒キャラ",
  "settings.skin.description":
    "CSS 変数ひと組で UI 全体の質感を切り替えます。装飾レイヤーはクリックもスクロールも妨げません。",
  "settings.skin.decorationCount": "装飾 {count} 個",
  "settings.skin.open": "外観スタイルを選ぶ",
  "settings.skin.openHint": "リーダー画面では装飾を自動的に解除",
  "settings.skin.active": "使用中",
  "settings.skin.apply": "適用",
  "settings.skin.import": "立ち絵を読み込む",
  "settings.skin.importHint":
    "バックエンドが画像ヘッダーと寸法を検証し data: URL に変換します。通信は行いません。",
  "settings.skin.importDone": "立ち絵を適用しました",
  "settings.skin.customName": "カスタム素材",
  "settings.skin.defaultName": "ミニマル（既定）",
  "settings.skin.defaultDescription": "装飾なし、追加コストなし。",
  "settings.skin.companionName": "イカの相棒",
  "settings.skin.companionDescription":
    "右下の相棒キャラとトップバー上のちょこんと乗るマスコット。",
  "settings.skin.errorFormat":
    "未対応の画像形式です（PNG / JPEG / WebP / GIF のみ）",
  "settings.skin.errorSize": "画像が 8 MB の上限を超えています",
  "settings.skin.errorDimension": "画像が 4096px の上限を超えています",
  "settings.skin.errorRead": "この画像を読み込めませんでした",

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
  "settings.webAccess.openAdvanced": "詳細設定（CA / OPDS / ペアリング端末）",
  "settings.webAccess.openAdvancedHint":
    "証明書の更新、指紋確認、OPDS 認証情報、端末管理",

  "privacy.detail.open": "セキュリティ診断の全詳細と診断パッケージを書き出す",
  "privacy.detail.openHint": "{pass} 件合格 · {warn} 件注意",
  "privacy.detail.reportTitle": "セキュリティ自己診断レポート",
  "privacy.detail.exportTitle": "診断パッケージの書き出し",
};

const ko = {
  "settings.brandIcon.open": "브랜드 아이콘 변경",
  "settings.brandIcon.openHint": "내장 아이콘 / 직접 업로드",

  "settings.skin.title": "화면 스타일과 캐릭터 장식",
  "settings.skin.description":
    "CSS 변수 한 세트로 전체 질감을 바꿉니다. 장식 레이어는 클릭과 스크롤을 절대 가로막지 않습니다.",
  "settings.skin.decorationCount": "장식 {count}개",
  "settings.skin.open": "화면 스타일 선택",
  "settings.skin.openHint": "리더 화면에서는 장식이 자동으로 해제됩니다",
  "settings.skin.active": "사용 중",
  "settings.skin.apply": "적용",
  "settings.skin.import": "로컬 일러스트 가져오기",
  "settings.skin.importHint":
    "백엔드가 이미지 헤더와 크기를 검증한 뒤 data: URL 로 변환합니다. 네트워크를 쓰지 않습니다.",
  "settings.skin.importDone": "일러스트를 적용했습니다",
  "settings.skin.customName": "사용자 소재",
  "settings.skin.defaultName": "미니멀(기본)",
  "settings.skin.defaultDescription": "장식 없음, 추가 비용 없음.",
  "settings.skin.companionName": "오징어 컴패니언",
  "settings.skin.companionDescription":
    "오른쪽 아래 캐릭터와 상단 바 위에 엎드린 마스코트.",
  "settings.skin.errorFormat":
    "지원하지 않는 이미지 형식입니다(PNG / JPEG / WebP / GIF 전용)",
  "settings.skin.errorSize": "이미지가 8 MB 한도를 초과했습니다",
  "settings.skin.errorDimension": "이미지가 4096px 한도를 초과했습니다",
  "settings.skin.errorRead": "이미지를 읽을 수 없습니다",

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
  "settings.webAccess.openAdvanced": "고급 설정(CA / OPDS / 연결 기기)",
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
