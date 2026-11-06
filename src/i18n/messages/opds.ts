/**
 * OPDS 1.2 remote-library settings, browser and error strings.
 * All six objects must stay in sync (the zh-CN shape defines MessageKey).
 */
const zhCN = {
  "opds.settings.title": "远程书库（OPDS）",
  "opds.settings.description":
    "连接你自建的 Komga、Kavita 或其他 OPDS 1.2 服务；只读目录与你自己的漫画文件。",
  "opds.settings.enableTitle": "启用远程书库",
  "opds.settings.enableDescription":
    "开启后，书库页会显示「远程书库」入口。",
  "opds.settings.urlLabel": "目录地址",
  "opds.settings.urlPlaceholder":
    "http://192.168.1.10:25600/opds/v1.2/catalog",
  "opds.settings.urlHint":
    "填写 OPDS 1.2 目录地址。Komga 通常是 /opds/v1.2/catalog；Kavita 使用带 API key 的 /api/opds/.../catalog。地址和凭据只保存在本机。",
  "opds.settings.usernameLabel": "用户名（可选）",
  "opds.settings.usernamePlaceholder": "Basic 认证用户名",
  "opds.settings.usernameSaved": "已保存账号",
  "opds.settings.usernameNone": "未保存账号",
  "opds.settings.clearUsername": "清除账号",
  "opds.settings.passwordLabel": "密码（可选）",
  "opds.settings.passwordPlaceholder": "留空保持不变",
  "opds.settings.passwordSaved": "已保存密码",
  "opds.settings.passwordNone": "未保存密码",
  "opds.settings.passwordOriginNote":
    "更换服务器地址（协议/主机/端口）后，原账号和密码会被清除，需要重新输入。",
  "opds.settings.clearPassword": "清除密码",
  "opds.settings.save": "保存",
  "opds.settings.saving": "保存中…",
  "opds.settings.saved": "远程书库配置已保存",
  "opds.settings.test": "测试连接",
  "opds.settings.testing": "测试中…",
  "opds.settings.testOk": "连接成功：{title}（{count} 个条目）",
  "opds.settings.testFailed": "连接失败：{error}",
  "opds.settings.saveFirst": "请先保存配置再测试连接。",
  "opds.settings.localOnly":
    "仅访问你填写的服务器；不使用系统代理，也不会把凭据发给其他网站。",
  "opds.settings.backupNote": "密码不写入备份、不进入诊断日志。",
  "opds.settings.safeMode": "安全模式下远程书库已暂停。",

  "opds.libraryButton": "远程书库",
  "opds.libraryButtonTitle": "浏览你自建的 OPDS 书库",
  "opds.dialog.title": "远程书库",
  "opds.dialog.description":
    "只读浏览你配置的 OPDS 1.2 服务；选择章节后下载到本机再阅读。",
  "opds.dialog.disabledTitle": "远程书库未启用",
  "opds.dialog.disabledBody":
    "请先在设置 → 网络与在线源中填写目录地址、凭据并启用。",
  "opds.dialog.goSettings": "前往设置",
  "opds.dialog.loading": "正在读取目录…",
  "opds.dialog.loadFailed": "目录读取失败：{error}",
  "opds.dialog.empty": "这个目录没有条目。",
  "opds.dialog.back": "返回上一级",
  "opds.dialog.refresh": "刷新",
  "opds.dialog.next": "下一页",
  "opds.dialog.prev": "上一页",
  "opds.dialog.root": "目录",
  "opds.dialog.untitled": "未命名条目",
  "opds.dialog.coverAlt": "{title} 封面",
  "opds.dialog.footer":
    "下载的章节会作为本地书加入书库；远端文件不会被修改。",
  "opds.entry.navigation": "进入",
  "opds.entry.download": "下载并阅读",
  "opds.entry.downloading": "下载中…",
  "opds.entry.unsupported": "格式不支持",
  "opds.entry.archiveZip": "CBZ",
  "opds.entry.archiveRar": "CBR",
  "opds.entry.archiveAuto": "压缩包",
  "opds.download.done": "已下载并打开「{title}」",
  "opds.download.failed": "下载失败：{error}",
  "opds.download.noSelection": "该条目没有可下载的 CBZ/CBR。",

  "error.opdsDisabled": "远程书库未启用，请先在设置中开启",
  "error.opdsNotConfigured": "远程书库地址未配置",
  "error.opdsUrlInvalid":
    "OPDS 地址无效：仅支持不含账号密码的 http/https 地址",
  "error.opdsCredentialsInvalid": "OPDS 账号或密码含非法字符",
  "error.opdsAuthFailed": "OPDS 认证失败，请检查用户名和密码",
  "error.opdsNotFound": "OPDS 目录或附件不存在",
  "error.opdsFetchFailed": "OPDS 请求失败，请检查网络或服务器地址",
  "error.opdsInvalidFeed": "这不是有效的 OPDS 1.2 Atom 目录",
  "error.opdsCrossOrigin": "OPDS 链接指向了已配置服务器之外，已拒绝",
  "error.opdsUnsupportedFormat": "该 OPDS 附件不是可读的 CBZ/CBR",
  "error.opdsTooLarge": "OPDS 资源超过大小上限",
  "error.opdsCbrFailed": "CBR 读取或转换失败",
  "error.opdsCbrEncrypted": "该 CBR 已加密，当前版本不支持",
  "error.opdsCbrMultivolume":
    "该 CBR 是分卷压缩包，请先在服务器端合并",
  "error.opdsIoFailed": "OPDS 本地文件读写失败",
} as const;

const zhTW = {
  "opds.settings.title": "遠端書庫（OPDS）",
  "opds.settings.description":
    "連接你自建的 Komga、Kavita 或其他 OPDS 1.2 服務；只讀目錄與你自己的漫畫檔案。",
  "opds.settings.enableTitle": "啟用遠端書庫",
  "opds.settings.enableDescription":
    "開啟後，書庫頁會顯示「遠端書庫」入口。",
  "opds.settings.urlLabel": "目錄位址",
  "opds.settings.urlPlaceholder":
    "http://192.168.1.10:25600/opds/v1.2/catalog",
  "opds.settings.urlHint":
    "填寫 OPDS 1.2 目錄位址。Komga 通常是 /opds/v1.2/catalog；Kavita 使用帶 API key 的 /api/opds/.../catalog。位址與憑據只保存在本機。",
  "opds.settings.usernameLabel": "使用者名稱（選填）",
  "opds.settings.usernamePlaceholder": "Basic 認證使用者名稱",
  "opds.settings.usernameSaved": "已儲存帳號",
  "opds.settings.usernameNone": "未儲存帳號",
  "opds.settings.clearUsername": "清除帳號",
  "opds.settings.passwordLabel": "密碼（選填）",
  "opds.settings.passwordPlaceholder": "留空保持不變",
  "opds.settings.passwordSaved": "已儲存密碼",
  "opds.settings.passwordNone": "未儲存密碼",
  "opds.settings.passwordOriginNote":
    "更換伺服器位址（協定/主機/連接埠）後，原帳號與密碼會被清除，需要重新輸入。",
  "opds.settings.clearPassword": "清除密碼",
  "opds.settings.save": "儲存",
  "opds.settings.saving": "儲存中…",
  "opds.settings.saved": "遠端書庫設定已儲存",
  "opds.settings.test": "測試連線",
  "opds.settings.testing": "測試中…",
  "opds.settings.testOk": "連線成功：{title}（{count} 個項目）",
  "opds.settings.testFailed": "連線失敗：{error}",
  "opds.settings.saveFirst": "請先儲存設定再測試連線。",
  "opds.settings.localOnly":
    "僅存取你填寫的伺服器；不使用系統代理，也不會把憑據傳給其他網站。",
  "opds.settings.backupNote": "密碼不寫入備份、不進入診斷日誌。",
  "opds.settings.safeMode": "安全模式下遠端書庫已暫停。",

  "opds.libraryButton": "遠端書庫",
  "opds.libraryButtonTitle": "瀏覽你自建的 OPDS 書庫",
  "opds.dialog.title": "遠端書庫",
  "opds.dialog.description":
    "只讀瀏覽你設定的 OPDS 1.2 服務；選擇章節後下載到本機再閱讀。",
  "opds.dialog.disabledTitle": "遠端書庫未啟用",
  "opds.dialog.disabledBody":
    "請先在設定 → 網路與線上來源中填寫目錄位址、憑據並啟用。",
  "opds.dialog.goSettings": "前往設定",
  "opds.dialog.loading": "正在讀取目錄…",
  "opds.dialog.loadFailed": "目錄讀取失敗：{error}",
  "opds.dialog.empty": "這個目錄沒有項目。",
  "opds.dialog.back": "返回上一層",
  "opds.dialog.refresh": "重新整理",
  "opds.dialog.next": "下一頁",
  "opds.dialog.prev": "上一頁",
  "opds.dialog.root": "目錄",
  "opds.dialog.untitled": "未命名項目",
  "opds.dialog.coverAlt": "{title} 封面",
  "opds.dialog.footer":
    "下載的章節會作為本機書加入書庫；遠端檔案不會被修改。",
  "opds.entry.navigation": "進入",
  "opds.entry.download": "下載並閱讀",
  "opds.entry.downloading": "下載中…",
  "opds.entry.unsupported": "格式不支援",
  "opds.entry.archiveZip": "CBZ",
  "opds.entry.archiveRar": "CBR",
  "opds.entry.archiveAuto": "壓縮檔",
  "opds.download.done": "已下載並開啟「{title}」",
  "opds.download.failed": "下載失敗：{error}",
  "opds.download.noSelection": "該項目沒有可下載的 CBZ/CBR。",

  "error.opdsDisabled": "遠端書庫未啟用，請先在設定中開啟",
  "error.opdsNotConfigured": "遠端書庫位址未設定",
  "error.opdsUrlInvalid":
    "OPDS 位址無效：僅支援不含帳號密碼的 http/https 位址",
  "error.opdsCredentialsInvalid": "OPDS 帳號或密碼含非法字元",
  "error.opdsAuthFailed": "OPDS 認證失敗，請檢查使用者名稱與密碼",
  "error.opdsNotFound": "OPDS 目錄或附件不存在",
  "error.opdsFetchFailed": "OPDS 請求失敗，請檢查網路或伺服器位址",
  "error.opdsInvalidFeed": "這不是有效的 OPDS 1.2 Atom 目錄",
  "error.opdsCrossOrigin": "OPDS 連結指向已設定伺服器之外，已拒絕",
  "error.opdsUnsupportedFormat": "該 OPDS 附件不是可讀的 CBZ/CBR",
  "error.opdsTooLarge": "OPDS 資源超過大小上限",
  "error.opdsCbrFailed": "CBR 讀取或轉換失敗",
  "error.opdsCbrEncrypted": "該 CBR 已加密，目前版本不支援",
  "error.opdsCbrMultivolume":
    "該 CBR 是分卷壓縮檔，請先在伺服器端合併",
  "error.opdsIoFailed": "OPDS 本機檔案讀寫失敗",
};

const en = {
  "opds.settings.title": "Remote library (OPDS)",
  "opds.settings.description":
    "Connect to your own Komga, Kavita, or another OPDS 1.2 service. Only catalogs and your own comic files are read.",
  "opds.settings.enableTitle": "Enable remote library",
  "opds.settings.enableDescription":
    "Shows a Remote library entry on the library page.",
  "opds.settings.urlLabel": "Catalog URL",
  "opds.settings.urlPlaceholder":
    "http://192.168.1.10:25600/opds/v1.2/catalog",
  "opds.settings.urlHint":
    "Enter the OPDS 1.2 catalog URL. Komga usually serves /opds/v1.2/catalog; Kavita uses /api/opds/.../catalog with an API key. The URL and credentials stay on this device.",
  "opds.settings.usernameLabel": "Username (optional)",
  "opds.settings.usernamePlaceholder": "Basic auth username",
  "opds.settings.usernameSaved": "Username saved",
  "opds.settings.usernameNone": "No username saved",
  "opds.settings.clearUsername": "Clear username",
  "opds.settings.passwordLabel": "Password (optional)",
  "opds.settings.passwordPlaceholder": "Leave blank to keep",
  "opds.settings.passwordSaved": "Password saved",
  "opds.settings.passwordNone": "No password saved",
  "opds.settings.passwordOriginNote":
    "Changing the server origin (scheme/host/port) clears the saved username and password; re-enter them if needed.",
  "opds.settings.clearPassword": "Clear password",
  "opds.settings.save": "Save",
  "opds.settings.saving": "Saving…",
  "opds.settings.saved": "Remote library settings saved",
  "opds.settings.test": "Test connection",
  "opds.settings.testing": "Testing…",
  "opds.settings.testOk": "Connected: {title} ({count} entries)",
  "opds.settings.testFailed": "Connection failed: {error}",
  "opds.settings.saveFirst": "Save the configuration before testing.",
  "opds.settings.localOnly":
    "Only the server you entered is contacted. No system proxy is used and credentials are never sent to another site.",
  "opds.settings.backupNote":
    "The password is excluded from backups and diagnostic logs.",
  "opds.settings.safeMode":
    "Remote library is paused while safe mode is active.",

  "opds.libraryButton": "Remote library",
  "opds.libraryButtonTitle": "Browse your self-hosted OPDS library",
  "opds.dialog.title": "Remote library",
  "opds.dialog.description":
    "Read-only browsing of your OPDS 1.2 service. Selected chapters are downloaded locally before reading.",
  "opds.dialog.disabledTitle": "Remote library is disabled",
  "opds.dialog.disabledBody":
    "Open Settings → Network & online sources to enter the catalog URL and credentials, then enable it.",
  "opds.dialog.goSettings": "Open settings",
  "opds.dialog.loading": "Reading catalog…",
  "opds.dialog.loadFailed": "Could not read catalog: {error}",
  "opds.dialog.empty": "This catalog has no entries.",
  "opds.dialog.back": "Back",
  "opds.dialog.refresh": "Refresh",
  "opds.dialog.next": "Next page",
  "opds.dialog.prev": "Previous page",
  "opds.dialog.root": "Catalog",
  "opds.dialog.untitled": "Untitled entry",
  "opds.dialog.coverAlt": "Cover of {title}",
  "opds.dialog.footer":
    "Downloaded chapters are added to the local library as local books. Remote files are never modified.",
  "opds.entry.navigation": "Open",
  "opds.entry.download": "Download & read",
  "opds.entry.downloading": "Downloading…",
  "opds.entry.unsupported": "Unsupported format",
  "opds.entry.archiveZip": "CBZ",
  "opds.entry.archiveRar": "CBR",
  "opds.entry.archiveAuto": "Archive",
  "opds.download.done": "Downloaded and opened “{title}”",
  "opds.download.failed": "Download failed: {error}",
  "opds.download.noSelection": "This entry has no downloadable CBZ/CBR.",

  "error.opdsDisabled": "Remote library is disabled; enable it in settings",
  "error.opdsNotConfigured": "Remote library URL is not configured",
  "error.opdsUrlInvalid":
    "Invalid OPDS URL: only http/https without embedded credentials is supported",
  "error.opdsCredentialsInvalid":
    "OPDS username or password contains invalid characters",
  "error.opdsAuthFailed":
    "OPDS authentication failed; check the username and password",
  "error.opdsNotFound": "OPDS catalog or attachment was not found",
  "error.opdsFetchFailed":
    "OPDS request failed; check the network or server address",
  "error.opdsInvalidFeed": "This is not a valid OPDS 1.2 Atom catalog",
  "error.opdsCrossOrigin":
    "The OPDS link points outside the configured server and was rejected",
  "error.opdsUnsupportedFormat":
    "This OPDS attachment is not a readable CBZ/CBR",
  "error.opdsTooLarge": "The OPDS resource exceeds the size limit",
  "error.opdsCbrFailed": "Could not read or convert the CBR archive",
  "error.opdsCbrEncrypted":
    "This CBR is encrypted and is not supported yet",
  "error.opdsCbrMultivolume":
    "This CBR is a multi-volume archive; merge it on the server first",
  "error.opdsIoFailed": "Local OPDS file operation failed",
};

const es = {
  "opds.settings.title": "Biblioteca remota (OPDS)",
  "opds.settings.description":
    "Conecta tu propio Komga, Kavita u otro servicio OPDS 1.2. Solo se leen catálogos y tus propios cómics.",
  "opds.settings.enableTitle": "Activar biblioteca remota",
  "opds.settings.enableDescription":
    "Muestra una entrada de Biblioteca remota en la página de la biblioteca.",
  "opds.settings.urlLabel": "URL del catálogo",
  "opds.settings.urlPlaceholder":
    "http://192.168.1.10:25600/opds/v1.2/catalog",
  "opds.settings.urlHint":
    "Introduce la URL del catálogo OPDS 1.2. Komga suele usar /opds/v1.2/catalog; Kavita usa /api/opds/.../catalog con una clave API. La URL y las credenciales se guardan solo en este dispositivo.",
  "opds.settings.usernameLabel": "Usuario (opcional)",
  "opds.settings.usernamePlaceholder": "Usuario de autenticación básica",
  "opds.settings.usernameSaved": "Usuario guardado",
  "opds.settings.usernameNone": "Sin usuario guardado",
  "opds.settings.clearUsername": "Borrar usuario",
  "opds.settings.passwordLabel": "Contraseña (opcional)",
  "opds.settings.passwordPlaceholder": "Déjalo vacío para mantenerla",
  "opds.settings.passwordSaved": "Contraseña guardada",
  "opds.settings.passwordNone": "Sin contraseña guardada",
  "opds.settings.passwordOriginNote":
    "Cambiar el origen del servidor (esquema/host/puerto) borra el usuario y la contraseña guardados; vuelve a introducirlos si es necesario.",
  "opds.settings.clearPassword": "Borrar contraseña",
  "opds.settings.save": "Guardar",
  "opds.settings.saving": "Guardando…",
  "opds.settings.saved": "Configuración de biblioteca remota guardada",
  "opds.settings.test": "Probar conexión",
  "opds.settings.testing": "Probando…",
  "opds.settings.testOk": "Conectado: {title} ({count} entradas)",
  "opds.settings.testFailed": "Error de conexión: {error}",
  "opds.settings.saveFirst": "Guarda la configuración antes de probar.",
  "opds.settings.localOnly":
    "Solo se contacta el servidor indicado. No se usa el proxy del sistema y las credenciales nunca se envían a otro sitio.",
  "opds.settings.backupNote":
    "La contraseña queda excluida de las copias de seguridad y de los registros de diagnóstico.",
  "opds.settings.safeMode":
    "La biblioteca remota está en pausa mientras el modo seguro está activo.",

  "opds.libraryButton": "Biblioteca remota",
  "opds.libraryButtonTitle": "Explora tu biblioteca OPDS autoalojada",
  "opds.dialog.title": "Biblioteca remota",
  "opds.dialog.description":
    "Exploración de solo lectura de tu servicio OPDS 1.2. Los capítulos elegidos se descargan localmente antes de leer.",
  "opds.dialog.disabledTitle": "La biblioteca remota está desactivada",
  "opds.dialog.disabledBody":
    "Abre Ajustes → Red y fuentes en línea para introducir la URL y las credenciales, y actívala.",
  "opds.dialog.goSettings": "Abrir ajustes",
  "opds.dialog.loading": "Leyendo catálogo…",
  "opds.dialog.loadFailed": "No se pudo leer el catálogo: {error}",
  "opds.dialog.empty": "Este catálogo no tiene entradas.",
  "opds.dialog.back": "Atrás",
  "opds.dialog.refresh": "Actualizar",
  "opds.dialog.next": "Página siguiente",
  "opds.dialog.prev": "Página anterior",
  "opds.dialog.root": "Catálogo",
  "opds.dialog.untitled": "Entrada sin título",
  "opds.dialog.coverAlt": "Portada de {title}",
  "opds.dialog.footer":
    "Los capítulos descargados se añaden a la biblioteca local como libros locales. Los archivos remotos nunca se modifican.",
  "opds.entry.navigation": "Abrir",
  "opds.entry.download": "Descargar y leer",
  "opds.entry.downloading": "Descargando…",
  "opds.entry.unsupported": "Formato no compatible",
  "opds.entry.archiveZip": "CBZ",
  "opds.entry.archiveRar": "CBR",
  "opds.entry.archiveAuto": "Archivo",
  "opds.download.done": "Descargado y abierto «{title}»",
  "opds.download.failed": "Error de descarga: {error}",
  "opds.download.noSelection": "Esta entrada no tiene CBZ/CBR descargable.",

  "error.opdsDisabled":
    "La biblioteca remota está desactivada; actívala en ajustes",
  "error.opdsNotConfigured": "La URL de la biblioteca remota no está configurada",
  "error.opdsUrlInvalid":
    "URL OPDS no válida: solo se admite http/https sin credenciales incrustadas",
  "error.opdsCredentialsInvalid":
    "El usuario o la contraseña de OPDS contiene caracteres no válidos",
  "error.opdsAuthFailed":
    "Falló la autenticación OPDS; revisa el usuario y la contraseña",
  "error.opdsNotFound": "No se encontró el catálogo o el adjunto OPDS",
  "error.opdsFetchFailed":
    "Falló la solicitud OPDS; revisa la red o la dirección del servidor",
  "error.opdsInvalidFeed": "No es un catálogo Atom OPDS 1.2 válido",
  "error.opdsCrossOrigin":
    "El enlace OPDS apunta fuera del servidor configurado y se rechazó",
  "error.opdsUnsupportedFormat":
    "Este adjunto OPDS no es un CBZ/CBR legible",
  "error.opdsTooLarge": "El recurso OPDS supera el límite de tamaño",
  "error.opdsCbrFailed": "No se pudo leer o convertir el archivo CBR",
  "error.opdsCbrEncrypted":
    "Este CBR está cifrado y aún no es compatible",
  "error.opdsCbrMultivolume":
    "Este CBR es un archivo multivolumen; únelo primero en el servidor",
  "error.opdsIoFailed": "Falló la operación de archivo local de OPDS",
};

const ja = {
  "opds.settings.title": "リモート書庫（OPDS）",
  "opds.settings.description":
    "自前の Komga、Kavita、その他の OPDS 1.2 サービスに接続します。閲覧するのは目録と自分の漫画ファイルだけです。",
  "opds.settings.enableTitle": "リモート書庫を有効にする",
  "opds.settings.enableDescription":
    "書庫ページに「リモート書庫」の入口を表示します。",
  "opds.settings.urlLabel": "目録 URL",
  "opds.settings.urlPlaceholder":
    "http://192.168.1.10:25600/opds/v1.2/catalog",
  "opds.settings.urlHint":
    "OPDS 1.2 の目録 URL を入力します。Komga は通常 /opds/v1.2/catalog、Kavita は API キー付きの /api/opds/.../catalog です。URL と認証情報はこの端末にのみ保存されます。",
  "opds.settings.usernameLabel": "ユーザー名（任意）",
  "opds.settings.usernamePlaceholder": "Basic 認証のユーザー名",
  "opds.settings.usernameSaved": "ユーザー名を保存済み",
  "opds.settings.usernameNone": "ユーザー名未保存",
  "opds.settings.clearUsername": "ユーザー名を消去",
  "opds.settings.passwordLabel": "パスワード（任意）",
  "opds.settings.passwordPlaceholder": "空欄なら変更しません",
  "opds.settings.passwordSaved": "パスワード保存済み",
  "opds.settings.passwordNone": "パスワード未保存",
  "opds.settings.passwordOriginNote":
    "サーバーの origin（スキーム/ホスト/ポート）を変更すると保存済みのユーザー名とパスワードは消去されます。必要なら再入力してください。",
  "opds.settings.clearPassword": "パスワードを消去",
  "opds.settings.save": "保存",
  "opds.settings.saving": "保存中…",
  "opds.settings.saved": "リモート書庫の設定を保存しました",
  "opds.settings.test": "接続テスト",
  "opds.settings.testing": "テスト中…",
  "opds.settings.testOk": "接続成功：{title}（{count} 項目）",
  "opds.settings.testFailed": "接続失敗：{error}",
  "opds.settings.saveFirst": "接続テストの前に設定を保存してください。",
  "opds.settings.localOnly":
    "入力したサーバーにのみ接続します。システムプロキシは使わず、認証情報を他のサイトへ送りません。",
  "opds.settings.backupNote":
    "パスワードはバックアップと診断ログに含まれません。",
  "opds.settings.safeMode":
    "セーフモード中はリモート書庫を停止しています。",

  "opds.libraryButton": "リモート書庫",
  "opds.libraryButtonTitle": "自前の OPDS 書庫を閲覧",
  "opds.dialog.title": "リモート書庫",
  "opds.dialog.description":
    "設定した OPDS 1.2 サービスを読み取り専用で閲覧します。選んだ章は端末にダウンロードしてから読みます。",
  "opds.dialog.disabledTitle": "リモート書庫は無効です",
  "opds.dialog.disabledBody":
    "設定 → ネットワークとオンラインソースで目録 URL と認証情報を入力し、有効にしてください。",
  "opds.dialog.goSettings": "設定を開く",
  "opds.dialog.loading": "目録を読み込み中…",
  "opds.dialog.loadFailed": "目録を読み込めません：{error}",
  "opds.dialog.empty": "この目録には項目がありません。",
  "opds.dialog.back": "戻る",
  "opds.dialog.refresh": "更新",
  "opds.dialog.next": "次のページ",
  "opds.dialog.prev": "前のページ",
  "opds.dialog.root": "目録",
  "opds.dialog.untitled": "無題の項目",
  "opds.dialog.coverAlt": "{title} の表紙",
  "opds.dialog.footer":
    "ダウンロードした章はローカル書庫にローカル本として追加されます。リモートのファイルは変更しません。",
  "opds.entry.navigation": "開く",
  "opds.entry.download": "ダウンロードして読む",
  "opds.entry.downloading": "ダウンロード中…",
  "opds.entry.unsupported": "未対応の形式",
  "opds.entry.archiveZip": "CBZ",
  "opds.entry.archiveRar": "CBR",
  "opds.entry.archiveAuto": "アーカイブ",
  "opds.download.done": "「{title}」をダウンロードして開きました",
  "opds.download.failed": "ダウンロード失敗：{error}",
  "opds.download.noSelection":
    "この項目にはダウンロード可能な CBZ/CBR がありません。",

  "error.opdsDisabled":
    "リモート書庫が無効です。設定で有効にしてください",
  "error.opdsNotConfigured": "リモート書庫の URL が設定されていません",
  "error.opdsUrlInvalid":
    "OPDS URL が無効です。認証情報を含まない http/https のみ対応します",
  "error.opdsCredentialsInvalid":
    "OPDS のユーザー名またはパスワードに不正な文字があります",
  "error.opdsAuthFailed":
    "OPDS 認証に失敗しました。ユーザー名とパスワードを確認してください",
  "error.opdsNotFound": "OPDS の目録または添付が見つかりません",
  "error.opdsFetchFailed":
    "OPDS リクエストに失敗しました。ネットワークまたはサーバー URL を確認してください",
  "error.opdsInvalidFeed": "有効な OPDS 1.2 Atom 目録ではありません",
  "error.opdsCrossOrigin":
    "OPDS リンクが設定したサーバー外を指しているため拒否しました",
  "error.opdsUnsupportedFormat":
    "この OPDS 添付は読み取り可能な CBZ/CBR ではありません",
  "error.opdsTooLarge": "OPDS リソースがサイズ上限を超えています",
  "error.opdsCbrFailed": "CBR の読み取りまたは変換に失敗しました",
  "error.opdsCbrEncrypted":
    "この CBR は暗号化されており、現在は未対応です",
  "error.opdsCbrMultivolume":
    "この CBR は分割アーカイブです。サーバー側で結合してください",
  "error.opdsIoFailed": "OPDS のローカルファイル操作に失敗しました",
};

const ko = {
  "opds.settings.title": "원격 서재(OPDS)",
  "opds.settings.description":
    "직접 운영하는 Komga, Kavita 또는 다른 OPDS 1.2 서비스에 연결합니다. 카탈로그와 본인의 만화 파일만 읽습니다.",
  "opds.settings.enableTitle": "원격 서재 사용",
  "opds.settings.enableDescription":
    "서재 페이지에 '원격 서재' 진입점을 표시합니다.",
  "opds.settings.urlLabel": "카탈로그 URL",
  "opds.settings.urlPlaceholder":
    "http://192.168.1.10:25600/opds/v1.2/catalog",
  "opds.settings.urlHint":
    "OPDS 1.2 카탈로그 URL을 입력하세요. Komga는 보통 /opds/v1.2/catalog, Kavita는 API 키가 포함된 /api/opds/.../catalog를 사용합니다. URL과 자격 증명은 이 기기에만 저장됩니다.",
  "opds.settings.usernameLabel": "사용자 이름(선택)",
  "opds.settings.usernamePlaceholder": "Basic 인증 사용자 이름",
  "opds.settings.usernameSaved": "사용자 이름 저장됨",
  "opds.settings.usernameNone": "저장된 사용자 이름 없음",
  "opds.settings.clearUsername": "사용자 이름 지우기",
  "opds.settings.passwordLabel": "비밀번호(선택)",
  "opds.settings.passwordPlaceholder": "비워 두면 유지",
  "opds.settings.passwordSaved": "비밀번호 저장됨",
  "opds.settings.passwordNone": "저장된 비밀번호 없음",
  "opds.settings.passwordOriginNote":
    "서버 origin(스킴/호스트/포트)을 변경하면 저장된 사용자 이름과 비밀번호가 지워지므로 필요하면 다시 입력하세요.",
  "opds.settings.clearPassword": "비밀번호 지우기",
  "opds.settings.save": "저장",
  "opds.settings.saving": "저장 중…",
  "opds.settings.saved": "원격 서재 설정을 저장했습니다",
  "opds.settings.test": "연결 테스트",
  "opds.settings.testing": "테스트 중…",
  "opds.settings.testOk": "연결됨: {title} ({count}개 항목)",
  "opds.settings.testFailed": "연결 실패: {error}",
  "opds.settings.saveFirst": "연결 테스트 전에 설정을 저장하세요.",
  "opds.settings.localOnly":
    "입력한 서버에만 접속합니다. 시스템 프록시를 사용하지 않으며 자격 증명을 다른 사이트로 보내지 않습니다.",
  "opds.settings.backupNote":
    "비밀번호는 백업과 진단 로그에 포함되지 않습니다.",
  "opds.settings.safeMode":
    "안전 모드에서는 원격 서재가 일시 중지됩니다.",

  "opds.libraryButton": "원격 서재",
  "opds.libraryButtonTitle": "직접 운영하는 OPDS 서재 둘러보기",
  "opds.dialog.title": "원격 서재",
  "opds.dialog.description":
    "설정한 OPDS 1.2 서비스를 읽기 전용으로 둘러봅니다. 선택한 장은 먼저 기기에 다운로드한 뒤 읽습니다.",
  "opds.dialog.disabledTitle": "원격 서재가 비활성화되어 있습니다",
  "opds.dialog.disabledBody":
    "설정 → 네트워크 및 온라인 소스에서 카탈로그 URL과 자격 증명을 입력한 뒤 활성화하세요.",
  "opds.dialog.goSettings": "설정 열기",
  "opds.dialog.loading": "카탈로그 읽는 중…",
  "opds.dialog.loadFailed": "카탈로그를 읽지 못했습니다: {error}",
  "opds.dialog.empty": "이 카탈로그에는 항목이 없습니다.",
  "opds.dialog.back": "뒤로",
  "opds.dialog.refresh": "새로 고침",
  "opds.dialog.next": "다음 페이지",
  "opds.dialog.prev": "이전 페이지",
  "opds.dialog.root": "카탈로그",
  "opds.dialog.untitled": "제목 없는 항목",
  "opds.dialog.coverAlt": "{title} 표지",
  "opds.dialog.footer":
    "다운로드한 장은 로컬 서재에 로컬 책으로 추가됩니다. 원격 파일은 수정하지 않습니다.",
  "opds.entry.navigation": "열기",
  "opds.entry.download": "다운로드 후 읽기",
  "opds.entry.downloading": "다운로드 중…",
  "opds.entry.unsupported": "지원하지 않는 형식",
  "opds.entry.archiveZip": "CBZ",
  "opds.entry.archiveRar": "CBR",
  "opds.entry.archiveAuto": "압축 파일",
  "opds.download.done": "「{title}」을(를) 다운로드해 열었습니다",
  "opds.download.failed": "다운로드 실패: {error}",
  "opds.download.noSelection":
    "이 항목에는 다운로드 가능한 CBZ/CBR이 없습니다.",

  "error.opdsDisabled":
    "원격 서재가 비활성화되어 있습니다. 설정에서 활성화하세요",
  "error.opdsNotConfigured": "원격 서재 URL이 설정되지 않았습니다",
  "error.opdsUrlInvalid":
    "OPDS URL이 잘못되었습니다. 자격 증명이 없는 http/https만 지원합니다",
  "error.opdsCredentialsInvalid":
    "OPDS 사용자 이름 또는 비밀번호에 잘못된 문자가 있습니다",
  "error.opdsAuthFailed":
    "OPDS 인증에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요",
  "error.opdsNotFound": "OPDS 카탈로그 또는 첨부 파일을 찾을 수 없습니다",
  "error.opdsFetchFailed":
    "OPDS 요청에 실패했습니다. 네트워크 또는 서버 주소를 확인하세요",
  "error.opdsInvalidFeed": "유효한 OPDS 1.2 Atom 카탈로그가 아닙니다",
  "error.opdsCrossOrigin":
    "OPDS 링크가 설정된 서버 밖을 가리켜 거부했습니다",
  "error.opdsUnsupportedFormat":
    "이 OPDS 첨부 파일은 읽을 수 있는 CBZ/CBR이 아닙니다",
  "error.opdsTooLarge": "OPDS 리소스가 크기 한도를 초과했습니다",
  "error.opdsCbrFailed": "CBR을 읽거나 변환하지 못했습니다",
  "error.opdsCbrEncrypted":
    "이 CBR은 암호화되어 있어 현재 지원하지 않습니다",
  "error.opdsCbrMultivolume":
    "이 CBR은 분할 압축 파일입니다. 서버에서 먼저 병합하세요",
  "error.opdsIoFailed": "OPDS 로컬 파일 작업에 실패했습니다",
};

export const opdsMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
