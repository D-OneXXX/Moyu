/**
 * Developer feature-gate panel and recoverable disabled-module prompt strings.
 * All six dictionaries must stay in sync.
 */
const zhCN = {
  "developer.title": "开发者功能总控",
  "developer.description":
    "集中管理 9 项内置功能模块门卫。这里是开发者入口，不是日常开关；关闭会立即停止关联子系统，对应业务区域会变成可恢复的占位条。",
  "developer.open": "打开功能开关矩阵",
  "developer.openHint": "9 项模块门卫 · 内置开发者入口",
  "developer.badge": "开发者",
  "developer.warning":
    "这些开关面向模块开发者与故障排查。关闭后后端命令返回 feature-disabled；前端不会卸载业务入口，而是显示「当前已停用」并提供一键启用。",
  "developer.gateOn": "后端门卫：放行",
  "developer.gateOff": "后端门卫：拒绝",
  "developer.subsystem": "关联子系统：{subsystem}",
  "developer.summary": "已启用 {count}/9",
  "developer.reset": "恢复默认模块配置",
  "developer.resetting": "正在恢复默认…",
  "developer.resetConfirmTitle": "恢复默认模块配置？",
  "developer.resetConfirmMessage":
    "将写入 9 项模块门卫的默认值：9 项全部默认开启。已关闭的关联子系统不会自动重启，需要用户再次手动开启服务。",
  "developer.resetDone": "已恢复默认模块配置",
  "developer.resetPartial": "部分模块恢复失败：{detail}",
  "developer.safeMode":
    "安全模式保护中：退出安全模式前不能修改模块门卫。",
  "developer.toggleHint": "切换立即写入 SQLite，并刷新全局设置上下文。",
  "developer.subsystem.webtoon": "条漫版式与巨图切片布局",
  "developer.subsystem.online": "在线 URL 解析、Telegram 直读与辅助交接",
  "developer.subsystem.browser": "内嵌浏览器窗口与下载导入",
  "developer.subsystem.pdf": "PDF.js 本地渲染与字节区间通道",
  "developer.subsystem.opds": "OPDS 目录、封面、测试连接与附件导入",
  "developer.subsystem.webAccess": "局域网监听、配对、设备会话与 CA 分发",
  "developer.subsystem.updates": "官方更新检查、下载与安装门卫",
  "developer.subsystem.backup": "本地备份导出与恢复",
  "developer.subsystem.diagnostics": "诊断包预览、复制与导出",

  "featureGate.disabledBar": "{feature} 当前已在开发者功能开关中停用",
  "featureGate.enable": "一键启用",
  "featureGate.enabling": "正在启用…",
  "featureGate.enabledToast": "已启用 {feature}",
  "featureGate.safeMode": "安全模式保护中：{feature} 已被后端暂停。",
  "featureGate.openDeveloper": "打开开发者功能总控",
  "featureGate.pageTitle": "此功能已在开发者入口停用",
  "featureGate.pageBody":
    "关闭状态不会删除任何本地数据。你可以在这里立即重新启用，或前往设置 → 关于与维护的开发者功能总控集中管理 9 项模块门卫。",
};

const zhTW = {
  "developer.title": "開發者功能總控",
  "developer.description":
    "集中管理 9 項內建功能模組閘門。這裡是開發者入口，不是日常開關；關閉會立即停止關聯子系統，對應業務區域會變成可恢復的佔位條。",
  "developer.open": "開啟功能開關矩陣",
  "developer.openHint": "9 項模組閘門 · 內建開發者入口",
  "developer.badge": "開發者",
  "developer.warning":
    "這些開關面向模組開發者與故障排查。關閉後後端命令回傳 feature-disabled；前端不會卸載業務入口，而是顯示「目前已停用」並提供一鍵啟用。",
  "developer.gateOn": "後端閘門：放行",
  "developer.gateOff": "後端閘門：拒絕",
  "developer.subsystem": "關聯子系統：{subsystem}",
  "developer.summary": "已啟用 {count}/9",
  "developer.reset": "恢復預設模組設定",
  "developer.resetting": "正在恢復預設…",
  "developer.resetConfirmTitle": "恢復預設模組設定？",
  "developer.resetConfirmMessage":
    "將寫入 9 項模組閘門的預設值：9 項全部預設開啟。已關閉的關聯子系統不會自動重啟，需要使用者再次手動開啟服務。",
  "developer.resetDone": "已恢復預設模組設定",
  "developer.resetPartial": "部分模組恢復失敗：{detail}",
  "developer.safeMode":
    "安全模式保護中：退出安全模式前不能修改模組閘門。",
  "developer.toggleHint": "切換立即寫入 SQLite，並重新整理全域設定上下文。",
  "developer.subsystem.webtoon": "條漫版式與巨圖切片佈局",
  "developer.subsystem.online": "線上 URL 解析、Telegram 直讀與輔助交接",
  "developer.subsystem.browser": "內嵌瀏覽器視窗與下載匯入",
  "developer.subsystem.pdf": "PDF.js 本機渲染與位元組區間通道",
  "developer.subsystem.opds": "OPDS 目錄、封面、測試連線與附件匯入",
  "developer.subsystem.webAccess": "區域網路監聽、配對、裝置工作階段與 CA 分發",
  "developer.subsystem.updates": "官方更新檢查、下載與安裝閘門",
  "developer.subsystem.backup": "本機備份匯出與還原",
  "developer.subsystem.diagnostics": "診斷包預覽、複製與匯出",

  "featureGate.disabledBar": "{feature} 目前已在開發者功能開關中停用",
  "featureGate.enable": "一鍵啟用",
  "featureGate.enabling": "正在啟用…",
  "featureGate.enabledToast": "已啟用 {feature}",
  "featureGate.safeMode": "安全模式保護中：{feature} 已被後端暫停。",
  "featureGate.openDeveloper": "開啟開發者功能總控",
  "featureGate.pageTitle": "此功能已在開發者入口停用",
  "featureGate.pageBody":
    "關閉狀態不會刪除任何本機資料。你可以在這裡立即重新啟用，或前往設定 → 關於與維護的開發者功能總控集中管理 9 項模組閘門。",
};

const en = {
  "developer.title": "Developer feature gates",
  "developer.description":
    "Central control for the nine built-in module gates. This is a developer entry, not a daily switch; disabling one stops its subsystem immediately and turns the matching surface into a recoverable placeholder.",
  "developer.open": "Open the feature-gate matrix",
  "developer.openHint": "9 module gates · built-in developer entry",
  "developer.badge": "Developer",
  "developer.warning":
    "These gates are for module developers and troubleshooting. When disabled, backend commands return feature-disabled; the UI does not unmount the entry, it shows a recoverable notice with a one-click enable.",
  "developer.gateOn": "Backend gate: allowed",
  "developer.gateOff": "Backend gate: denied",
  "developer.subsystem": "Linked subsystem: {subsystem}",
  "developer.summary": "{count}/9 enabled",
  "developer.reset": "Restore default module gates",
  "developer.resetting": "Restoring defaults…",
  "developer.resetConfirmTitle": "Restore default module gates?",
  "developer.resetConfirmMessage":
    "Writes the default values for all nine gates: all nine are on by default. Stopped subsystems do not restart automatically; the user must start the service again.",
  "developer.resetDone": "Default module gates restored",
  "developer.resetPartial": "Some modules failed to restore: {detail}",
  "developer.safeMode":
    "Safe mode is active: module gates cannot be changed until you leave safe mode.",
  "developer.toggleHint":
    "Changes persist to SQLite immediately and refresh the global settings context.",
  "developer.subsystem.webtoon": "Webtoon layout and large-image tiling",
  "developer.subsystem.online": "Online URL resolution, Telegram reading and handoff",
  "developer.subsystem.browser": "Embedded browser window and download import",
  "developer.subsystem.pdf": "PDF.js local rendering and byte-range channel",
  "developer.subsystem.opds": "OPDS feeds, covers, connection test and archive import",
  "developer.subsystem.webAccess": "LAN listener, pairing, device sessions and CA distribution",
  "developer.subsystem.updates": "Official update check, download and install gate",
  "developer.subsystem.backup": "Local backup export and restore",
  "developer.subsystem.diagnostics": "Diagnostic bundle preview, copy and export",

  "featureGate.disabledBar": "{feature} is disabled in the developer feature gates",
  "featureGate.enable": "Enable now",
  "featureGate.enabling": "Enabling…",
  "featureGate.enabledToast": "{feature} enabled",
  "featureGate.safeMode": "Safe mode is active: {feature} is paused by the backend.",
  "featureGate.openDeveloper": "Open developer feature gates",
  "featureGate.pageTitle": "This feature is disabled in the developer entry",
  "featureGate.pageBody":
    "Disabling it does not delete local data. You can re-enable it here, or manage all nine module gates in Settings → About & maintenance → Developer feature gates.",
};

const es = {
  "developer.title": "Controles de funciones para desarrolladores",
  "developer.description":
    "Control central de los nueve módulos internos. Es una entrada para desarrolladores, no un interruptor diario; al desactivar uno, su subsistema se detiene de inmediato y la superficie correspondiente pasa a un aviso recuperable.",
  "developer.open": "Abrir la matriz de controles",
  "developer.openHint": "9 controles de módulo · entrada integrada para desarrolladores",
  "developer.badge": "Desarrollador",
  "developer.warning":
    "Estos controles son para desarrollo y diagnóstico. Al desactivarlos, los comandos del backend devuelven feature-disabled; la interfaz no desmonta la entrada, muestra un aviso recuperable con activación en un clic.",
  "developer.gateOn": "Control del backend: permitido",
  "developer.gateOff": "Control del backend: denegado",
  "developer.subsystem": "Subsistema vinculado: {subsystem}",
  "developer.summary": "{count}/9 activados",
  "developer.reset": "Restaurar controles predeterminados",
  "developer.resetting": "Restaurando valores predeterminados…",
  "developer.resetConfirmTitle": "¿Restaurar los controles predeterminados?",
  "developer.resetConfirmMessage":
    "Escribe los valores predeterminados de los nueve controles: los nueve quedan activados. Los subsistemas detenidos no se reinician solos; el usuario debe volver a iniciar el servicio.",
  "developer.resetDone": "Controles predeterminados restaurados",
  "developer.resetPartial": "Algunos módulos no se restauraron: {detail}",
  "developer.safeMode":
    "Modo seguro activo: no se pueden cambiar los controles hasta salir del modo seguro.",
  "developer.toggleHint":
    "Los cambios se guardan en SQLite al instante y actualizan el contexto global de ajustes.",
  "developer.subsystem.webtoon": "Diseño webtoon y división de imágenes enormes",
  "developer.subsystem.online": "Resolución de URL, lectura de Telegram y traspaso",
  "developer.subsystem.browser": "Ventana de navegador integrada e importación de descargas",
  "developer.subsystem.pdf": "Renderizado local con PDF.js y canal por rangos de bytes",
  "developer.subsystem.opds": "Catálogos OPDS, portadas, prueba de conexión e importación",
  "developer.subsystem.webAccess": "Escucha LAN, emparejamiento, sesiones y distribución de CA",
  "developer.subsystem.updates": "Control de comprobación, descarga e instalación de actualizaciones",
  "developer.subsystem.backup": "Exportación y restauración de copias locales",
  "developer.subsystem.diagnostics": "Vista previa, copia y exportación de diagnósticos",

  "featureGate.disabledBar": "{feature} está desactivado en los controles para desarrolladores",
  "featureGate.enable": "Activar ahora",
  "featureGate.enabling": "Activando…",
  "featureGate.enabledToast": "{feature} activado",
  "featureGate.safeMode": "Modo seguro activo: el backend ha pausado {feature}.",
  "featureGate.openDeveloper": "Abrir controles para desarrolladores",
  "featureGate.pageTitle": "Esta función está desactivada en la entrada para desarrolladores",
  "featureGate.pageBody":
    "Desactivarla no borra datos locales. Puedes volver a activarla aquí o gestionar los nueve controles en Ajustes → Acerca de y mantenimiento → Controles de funciones para desarrolladores.",
};

const ja = {
  "developer.title": "開発者向け機能ゲート",
  "developer.description":
    "9 つの組み込みモジュールゲートを一括管理します。これは開発者向け入口であり日常スイッチではありません。無効にすると関連サブシステムが即座に停止し、該当画面は復元可能な案内に変わります。",
  "developer.open": "機能ゲート一覧を開く",
  "developer.openHint": "9 つのモジュールゲート · 組み込み開発者入口",
  "developer.badge": "開発者",
  "developer.warning":
    "これらのスイッチはモジュール開発と障害調査用です。無効にするとバックエンド命令は feature-disabled を返し、画面は入口を削除せず「現在無効」とワンクリック有効化を表示します。",
  "developer.gateOn": "バックエンドゲート：許可",
  "developer.gateOff": "バックエンドゲート：拒否",
  "developer.subsystem": "関連サブシステム：{subsystem}",
  "developer.summary": "{count}/9 有効",
  "developer.reset": "既定のモジュール設定に戻す",
  "developer.resetting": "既定値に戻しています…",
  "developer.resetConfirmTitle": "既定のモジュール設定に戻しますか？",
  "developer.resetConfirmMessage":
    "9 つのゲートに既定値を書き込みます。オンライン直読みは既定で無効、残り 8 項目は有効です。停止済みのサブシステムは自動再起動せず、ユーザーが再度サービスを開始する必要があります。",
  "developer.resetDone": "既定のモジュール設定に戻しました",
  "developer.resetPartial": "一部のモジュールを復元できませんでした：{detail}",
  "developer.safeMode":
    "セーフモード保護中：セーフモードを終了するまでモジュールゲートは変更できません。",
  "developer.toggleHint":
    "変更は即座に SQLite へ保存され、グローバル設定コンテキストを更新します。",
  "developer.subsystem.webtoon": "Webtoon レイアウトと巨大画像の分割",
  "developer.subsystem.online": "オンライン URL 解決、Telegram 直読み、引き継ぎ",
  "developer.subsystem.browser": "内蔵ブラウザーウィンドウとダウンロード取り込み",
  "developer.subsystem.pdf": "PDF.js によるローカル描画とバイト範囲チャネル",
  "developer.subsystem.opds": "OPDS フィード、表紙、接続テスト、添付取り込み",
  "developer.subsystem.webAccess": "LAN 待受、ペアリング、端末セッション、CA 配布",
  "developer.subsystem.updates": "公式アップデートの確認・ダウンロード・インストールゲート",
  "developer.subsystem.backup": "ローカルバックアップの書き出しと復元",
  "developer.subsystem.diagnostics": "診断バンドルのプレビュー、コピー、書き出し",

  "featureGate.disabledBar": "{feature} は開発者向け機能ゲートで無効になっています",
  "featureGate.enable": "今すぐ有効化",
  "featureGate.enabling": "有効化中…",
  "featureGate.enabledToast": "{feature} を有効化しました",
  "featureGate.safeMode": "セーフモード保護中：{feature} はバックエンドで停止されています。",
  "featureGate.openDeveloper": "開発者向け機能ゲートを開く",
  "featureGate.pageTitle": "この機能は開発者入口で無効になっています",
  "featureGate.pageBody":
    "無効にしてもローカルデータは削除されません。ここで再度有効化するか、設定 → このアプリについて → 開発者向け機能ゲートで 9 項目を一括管理できます。",
};

const ko = {
  "developer.title": "개발자 기능 게이트",
  "developer.description":
    "내장 모듈 9개의 게이트를 한곳에서 관리합니다. 일상 스위치가 아니라 개발자용 진입점이며, 비활성화하면 관련 하위 시스템이 즉시 중지되고 해당 화면은 복구 가능한 안내로 바뀝니다.",
  "developer.open": "기능 게이트 매트릭스 열기",
  "developer.openHint": "모듈 게이트 9개 · 내장 개발자 진입점",
  "developer.badge": "개발자",
  "developer.warning":
    "이 스위치는 모듈 개발과 문제 진단용입니다. 끄면 백엔드 명령이 feature-disabled를 반환하며, 화면은 진입점을 제거하지 않고 '현재 비활성' 안내와 한 번에 켜기를 표시합니다.",
  "developer.gateOn": "백엔드 게이트: 허용",
  "developer.gateOff": "백엔드 게이트: 거부",
  "developer.subsystem": "연결된 하위 시스템: {subsystem}",
  "developer.summary": "{count}/9 사용 중",
  "developer.reset": "기본 모듈 설정 복원",
  "developer.resetting": "기본값 복원 중…",
  "developer.resetConfirmTitle": "기본 모듈 설정을 복원할까요?",
  "developer.resetConfirmMessage":
    "게이트 9개의 기본값을 기록합니다. 9개 모두 기본적으로 켜져 있습니다. 중지된 하위 시스템은 자동으로 다시 시작되지 않으며 사용자가 서비스를 다시 시작해야 합니다.",
  "developer.resetDone": "기본 모듈 설정을 복원했습니다",
  "developer.resetPartial": "일부 모듈을 복원하지 못했습니다: {detail}",
  "developer.safeMode":
    "안전 모드 보호 중: 안전 모드를 종료하기 전에는 모듈 게이트를 변경할 수 없습니다.",
  "developer.toggleHint":
    "변경은 즉시 SQLite에 저장되고 전역 설정 컨텍스트를 갱신합니다.",
  "developer.subsystem.webtoon": "웹툰 레이아웃과 대형 이미지 분할",
  "developer.subsystem.online": "온라인 URL 해석, Telegram 직접 읽기 및 핸드오프",
  "developer.subsystem.browser": "내장 브라우저 창과 다운로드 가져오기",
  "developer.subsystem.pdf": "PDF.js 로컬 렌더링과 바이트 범위 채널",
  "developer.subsystem.opds": "OPDS 피드, 표지, 연결 테스트 및 첨부 가져오기",
  "developer.subsystem.webAccess": "LAN 수신, 페어링, 기기 세션 및 CA 배포",
  "developer.subsystem.updates": "공식 업데이트 확인, 다운로드 및 설치 게이트",
  "developer.subsystem.backup": "로컬 백업 내보내기와 복원",
  "developer.subsystem.diagnostics": "진단 번들 미리보기, 복사 및 내보내기",

  "featureGate.disabledBar": "{feature} 기능이 개발자 기능 게이트에서 비활성화되어 있습니다",
  "featureGate.enable": "지금 켜기",
  "featureGate.enabling": "켜는 중…",
  "featureGate.enabledToast": "{feature}을(를) 켰습니다",
  "featureGate.safeMode": "안전 모드 보호 중: 백엔드에서 {feature}을(를) 일시 중지했습니다.",
  "featureGate.openDeveloper": "개발자 기능 게이트 열기",
  "featureGate.pageTitle": "이 기능은 개발자 진입점에서 비활성화되어 있습니다",
  "featureGate.pageBody":
    "비활성화해도 로컬 데이터는 삭제되지 않습니다. 여기에서 다시 켜거나 설정 → 정보 및 유지보수의 개발자 기능 게이트에서 9개 모듈을 관리할 수 있습니다.",
};

export const featureGateMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
