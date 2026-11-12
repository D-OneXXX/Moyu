import { currentLocale, translate, type MessageKey } from "@/i18n";
import { hasStableCode } from "./stableCodes";

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 后端错误文案内嵌的稳定错误码（括号形式，如 `（archive-encrypted）`）。
 * 非 中文界面按码映射六语文案，不再回落到泛化提示；与 update.rs 的
 * `linux-manual-install` 先例同一套路。新增码时同步补 common.ts 六语键。
 */
const STABLE_ERROR_CODES: ReadonlyArray<{ code: string; key: string }> = [
  { code: "feature-disabled", key: "error.featureDisabled" },
  { code: "cache-clear-failed", key: "error.cacheClearFailed" },
  { code: "safe-mode-unavailable", key: "error.safeModeUnavailable" },
  { code: "blocking-task-failed", key: "error.blockingTaskFailed" },
  { code: "archive-disguised-rar", key: "error.archiveDisguisedRar" },
  { code: "archive-disguised-7z", key: "error.archiveDisguised7z" },
  { code: "archive-not-zip", key: "error.archiveNotZip" },
  { code: "archive-encrypted", key: "error.archiveEncrypted" },
  { code: "db-open-failed", key: "dbRecovery.openFailed" },
  { code: "db-schema-failed", key: "dbRecovery.schemaFailed" },
  { code: "db-quick-check-failed", key: "dbRecovery.quickCheckFailed" },
  { code: "db-settings-load-failed", key: "dbRecovery.settingsLoadFailed" },
  {
    code: "db-settings-normalize-failed",
    key: "dbRecovery.settingsNormalizeFailed",
  },
  { code: "db-already-healthy", key: "dbRecovery.unknown" },
  { code: "linux-manual-install", key: "updates.linux.manualBlocked" },
  { code: "backup-file-missing", key: "error.backupFileMissing" },
  { code: "backup-invalid-format", key: "error.backupInvalidFormat" },
  { code: "backup-unsupported-schema", key: "error.backupUnsupportedSchema" },
  { code: "backup-integrity-failed", key: "error.backupIntegrity" },
  { code: "backup-too-large", key: "error.backupTooLarge" },
  { code: "backup-restore-failed", key: "error.backupRestoreFailed" },
  { code: "backup-requires-confirmation", key: "error.backupRequiresConfirmation" },
  { code: "online-url-invalid", key: "error.onlineUrlInvalid" },
  { code: "online-blocked-address", key: "error.onlineBlockedAddress" },
  { code: "online-too-many-pages", key: "error.onlineTooManyPages" },
  { code: "online-fetch-failed", key: "error.onlineFetchFailed" },
  { code: "online-html-no-content", key: "error.onlineHtmlNoContent" },
  { code: "opds-disabled", key: "error.opdsDisabled" },
  { code: "opds-not-configured", key: "error.opdsNotConfigured" },
  { code: "opds-url-invalid", key: "error.opdsUrlInvalid" },
  { code: "opds-credentials-invalid", key: "error.opdsCredentialsInvalid" },
  { code: "opds-auth-failed", key: "error.opdsAuthFailed" },
  { code: "opds-not-found", key: "error.opdsNotFound" },
  { code: "opds-fetch-failed", key: "error.opdsFetchFailed" },
  { code: "opds-invalid-feed", key: "error.opdsInvalidFeed" },
  { code: "opds-cross-origin", key: "error.opdsCrossOrigin" },
  { code: "opds-unsupported-format", key: "error.opdsUnsupportedFormat" },
  { code: "opds-resource-too-large", key: "error.opdsTooLarge" },
  { code: "opds-cbr-failed", key: "error.opdsCbrFailed" },
  { code: "opds-cbr-encrypted", key: "error.opdsCbrEncrypted" },
  { code: "opds-cbr-multivolume", key: "error.opdsCbrMultivolume" },
  { code: "opds-io-failed", key: "error.opdsIoFailed" },
  { code: "update-unsupported-format", key: "error.updateUnsupportedFormat" },
  { code: "update-disk-space-low", key: "updates.disk.full" },
  // 官方更新代理命令（check_native_update / install_native_update）。
  { code: "update-check-failed", key: "updates.native.errorCheck" },
  { code: "update-install-failed", key: "updates.native.errorInstall" },
  { code: "update-version-changed", key: "updates.native.versionChanged" },
  { code: "not-a-sha", key: "error.updateUnsupportedFormat" },
  { code: "not-decoded-by-import", key: "error.updateUnsupportedFormat" },
  { code: "non-utf8-path", key: "error.nonUtf8Path" },
  // 文件打开 / 导入 / 删除的稳定码：桌面端只需给出可操作提示。
  { code: "import-failed", key: "error.backendGeneric" },
  { code: "open-with-pending", key: "error.backendGeneric" },
  { code: "sensitive-delete-target", key: "error.backendGeneric" },
  { code: "online-page-count-drop", key: "error.onlinePageCountDrop" },
  {
    code: "telegram-document-login-required",
    key: "error.telegramDocumentLoginRequired",
  },
  { code: "telegram-search-invalid", key: "error.telegramSearchInvalid" },
  { code: "pdf-not-valid", key: "error.pdfNotValid" },
  { code: "pdf-not-found", key: "error.pdfNotFound" },
  { code: "pdf-source-not-allowed", key: "error.pdfSourceNotAllowed" },
  { code: "pdf-not-pdf", key: "error.pdfSourceNotAllowed" },
  { code: "pdf-source-not-local", key: "error.pdfSourceNotAllowed" },
  { code: "pdf-render-unsupported", key: "error.pdfRenderUnsupported" },
  { code: "pdf-encrypted", key: "error.pdfEncrypted" },
  { code: "pdf-too-large", key: "error.pdfTooLarge" },
  { code: "pdf-source-unsupported", key: "error.pdfSourceUnsupported" },
  { code: "source-unsupported", key: "error.sourceUnsupported" },
  { code: "source-page-too-large", key: "error.sourcePageTooLarge" },
  { code: "online-metadata-write", key: "error.onlineMetadataWrite" },
  { code: "webtoon-too-large", key: "error.webtoonTooLarge" },
  { code: "pdf-cover-missing", key: "error.pdfCoverMissing" },
  { code: "pdf-page-count-invalid", key: "error.pdfPageCountInvalid" },
  { code: "pdf-cover-invalid", key: "error.pdfCoverInvalid" },
  { code: "pdf-cover-too-large", key: "error.pdfCoverTooLarge" },
  { code: "pdf-cover-dimensions", key: "error.pdfCoverDimensions" },
  { code: "ca-not-initialized", key: "error.caNotInitialized" },
  { code: "ca-state-corrupt", key: "error.caStateCorrupt" },
  { code: "ca-expired", key: "error.caExpired" },
  { code: "ca-key-mismatch", key: "error.caKeyMismatch" },
  { code: "ca-fingerprint-mismatch", key: "error.caFingerprintMismatch" },
  { code: "ca-cert-parse", key: "error.caCertParse" },
  // CA helper 的细分失败码：桌面端不区分内部阶段，统一落到可操作的 CA 文案。
  { code: "ca-chain-verification", key: "error.caCertParse" },
  { code: "ca-invalid-leaf-ip", key: "error.caCertParse" },
  { code: "ca-invalid-leaf-name", key: "error.caCertParse" },
  { code: "ca-crypto", key: "error.caIo" },
  { code: "ca-data-dir-unavailable", key: "error.caIo" },
  { code: "ca-generation-not-active", key: "error.caStateCorrupt" },
  { code: "ca-root-relative", key: "error.caStateCorrupt" },
  { code: "wrong-fingerprint", key: "error.caFingerprintMismatch" },
  { code: "ca-partial-initialization", key: "error.caPartialInitialization" },
  { code: "ca-acl-verification", key: "error.caAclVerification" },
  { code: "ca-acl", key: "error.caAclVerification" },
  { code: "ca-io", key: "error.caIo" },
  { code: "ca-insufficient-validity", key: "error.caInsufficientValidity" },
  { code: "ca-export-path", key: "error.caExportPath" },
  { code: "ca-distribution-running", key: "error.caDistributionRunning" },
  { code: "ca-distribution-no-lan", key: "error.caDistributionNoLan" },
  { code: "ca-distribution-invalid-ip", key: "error.caDistributionInvalidIp" },
  { code: "ca-distribution-io", key: "error.caDistributionIo" },
  { code: "web-access-already-enabled", key: "error.webAccessAlreadyEnabled" },
  { code: "web-access-not-enabled", key: "error.webAccessNotEnabled" },
  { code: "web-access-invalid-state", key: "error.webAccessInvalidState" },
  { code: "web-access-safe-mode", key: "settings.webAccess.safeModeBlocked" },
  { code: "web-access-invalid-ip", key: "error.webAccessInvalidIp" },
  { code: "web-access-no-lan-address", key: "error.webAccessNoLan" },
  { code: "web-access-too-many-lan-addresses", key: "error.webAccessTooManyLan" },
  { code: "web-access-invalid-san", key: "error.webAccessInvalidSan" },
  { code: "web-access-invalid-bind", key: "error.webAccessInvalidBind" },
  { code: "web-access-tls-config", key: "error.webAccessTlsConfig" },
  { code: "web-access-io", key: "error.webAccessIo" },
  { code: "web-access-server-join", key: "error.webAccessServerJoin" },
  {
    code: "web-access-certificate-expired",
    key: "error.webAccessCertificateExpired",
  },
  {
    code: "web-access-root-change-pending",
    key: "error.webAccessRootChangePending",
  },
  {
    code: "web-access-root-change-mismatch",
    key: "error.webAccessRootChangeMismatch",
  },
  {
    code: "web-access-rollback-unavailable",
    key: "error.webAccessRollbackUnavailable",
  },
  {
    code: "web-access-device-not-found",
    key: "error.webAccessDeviceNotFound",
  },
  { code: "pairing-not-found", key: "error.webAccessPairingNotFound" },
  { code: "pairing-claimed", key: "error.webAccessPairingClaimed" },
  { code: "pairing-consumed", key: "error.webAccessPairingConsumed" },
  { code: "pairing-expired", key: "error.webAccessPairingExpired" },
  { code: "pairing-denied", key: "error.webAccessPairingDenied" },
  { code: "pairing-cancelled", key: "error.webAccessPairingCancelled" },
  { code: "device-limit", key: "error.webAccessDeviceLimit" },
  { code: "pairing-rate-limited", key: "error.webAccessRateLimited" },
  { code: "invalid-parameter", key: "error.webAccessInvalidParameter" },
  // Web Access HTTP 面可能经由事件回传到桌面 toast；未知细节统一安全兜底。
  { code: "body-too-large", key: "error.webAccessInvalidParameter" },
  { code: "page-out-of-range", key: "error.webAccessInvalidParameter" },
  { code: "busy", key: "error.backendGeneric" },
  { code: "unauthorized", key: "error.webAccessNotEnabled" },
  { code: "internal-error", key: "error.backendGeneric" },
  { code: "render-timeout", key: "error.backendGeneric" },
  { code: "book-not-found", key: "error.backendGeneric" },
  { code: "progress-conflict", key: "error.backendGeneric" },
  { code: "session-expired", key: "error.backendGeneric" },
  { code: "source-missing", key: "error.backendGeneric" },
  { code: "thumbnail-missing", key: "error.backendGeneric" },
  { code: "invalid-page-limit", key: "error.pageInvalidLimit" },
  { code: "invalid-page-query", key: "error.pageInvalidQuery" },
  { code: "invalid-page-cursor", key: "error.pageInvalidCursor" },
  // 皮肤素材导入（Rust 侧校验图片头与尺寸）。
  { code: "skin-read-failed", key: "settings.skin.errorRead" },
  { code: "skin-empty", key: "settings.skin.errorRead" },
  { code: "skin-too-large", key: "settings.skin.errorSize" },
  { code: "skin-unsupported-format", key: "settings.skin.errorFormat" },
  { code: "skin-dimension-too-large", key: "settings.skin.errorDimension" },
];

/**
 * 按稳定码直接取本地化文案。
 *
 * 用于「前端自己归类出来的错误」（例如 pdf.js 异常 → `pdf-encrypted`）：
 * 没有后端文案可解析，只有码，因此不能走 `localizeBackendError`。
 * 未知码一律落到泛化文案，绝不显示原始异常。
 */
export function localizeStableErrorCode(code: string): string {
  const entry = STABLE_ERROR_CODES.find((item) => item.code === code);
  return entry
    ? translate(entry.key as MessageKey)
    : translate("error.backendGeneric");
}

/**
 * Backend commands still return human-readable Chinese strings. Chinese UI
 * keeps the exact detail; other locales show a localized generic message plus
 * an HTTP status when one is available, never raw Chinese mixed into the UI.
 * Errors carrying a stable code (see STABLE_ERROR_CODES) are localized by the
 * code table instead of the generic fallback.
 */
export function localizeBackendError(
  input: unknown,
  locale = currentLocale(),
): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return translate("error.backendGeneric");
  // Simplified Chinese backend strings can be shown verbatim; zh-TW must use
  // the Traditional code table instead of inheriting Simplified text.
  if (locale === "zh-CN" || locale.startsWith("zh-Hans")) return raw;
  for (const entry of STABLE_ERROR_CODES) {
    if (hasStableCode(raw, entry.code)) return translate(entry.key as MessageKey);
  }
  if (!CJK.test(raw)) return raw;
  const http = raw.match(/HTTP\s*(\d{3})/i)?.[1];
  return http
    ? `${translate("error.backendGeneric")} (HTTP ${http})`
    : translate("error.backendGeneric");
}
