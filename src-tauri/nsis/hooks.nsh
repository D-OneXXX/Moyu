; MangaReader 安装器系统准入：Windows 10 (NT 10.0, Build 10240) 及以上。
;
; 与 src-tauri/src/platform.rs 的 `enforce_windows_baseline` 保持一致：
; 安装器先拦一层，避免用户在 Win7 / Win8 / Win8.1 上装完才发现无法启动。
; Tauri 会在生成的 installer.nsi 中通过 NSIS_HOOK_PREINSTALL 注入本宏。
;
; 说明：`${AtLeastWin10}` 覆盖 NT 10.0 全部版本（Win10 RTM 即 Build 10240，
; Win11 报 10.0.2xxxx）；低于它的系统（6.1 / 6.2 / 6.3）一律拒绝安装。
;
; 文件关联修复（#318）：
; Tauri 的 APP_ASSOCIATE 在每次覆盖安装时都会把“当前默认值”写入
; `<ProgID>_backup`。升级时当前默认值已经是本应用，备份因此被污染成自身；
; 卸载时 APP_UNASSOCIATE 又把它恢复回来，留下指向已删除 ProgID 的悬空关联。
; 这里在安装前保存真正的原始备份、安装后恢复它，并在卸载后清掉任何仍指向
; 本应用的默认值，避免重复升级/卸载留下死关联。
;
; `MR_ASSOC_ROOT` 仅供测试注入；生产安装器始终使用 `Software\Classes`。

!include "WinVer.nsh"

!ifndef MR_ASSOC_ROOT
  !define MR_ASSOC_ROOT "Software\Classes"
!endif

!define MR_ASSOC_CBZ_CLASS "MangaReader Comic Archive"
!define MR_ASSOC_ZIP_CLASS "MangaReader ZIP Archive"
!define MR_ASSOC_PRESERVED "MangaReader_preserved_backup"

; 安装前：如果现有 `_backup` 是用户原始关联，先暂存；如果它已经指向本应用，
; 说明来自旧版覆盖安装的污染，删除暂存值，让安装后的恢复回落到空关联。
!macro MR_PRESERVE_ASSOC_BACKUP EXT FILECLASS
  ReadRegStr $R0 SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${FILECLASS}_backup"
  StrCmp $R0 "${FILECLASS}" mr_preserve_${EXT}_clear
  StrCmp $R0 "" mr_preserve_${EXT}_clear
  WriteRegStr SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${MR_ASSOC_PRESERVED}" "$R0"
  Goto mr_preserve_${EXT}_done
  mr_preserve_${EXT}_clear:
    DeleteRegValue SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${MR_ASSOC_PRESERVED}"
  mr_preserve_${EXT}_done:
!macroend

; 安装后：Tauri 已把当前默认值写入 `_backup`；若它是本应用，恢复安装前
; 暂存的原始值（没有原始值时写空），避免卸载时恢复出一个悬空 ProgID。
!macro MR_RESTORE_ASSOC_BACKUP EXT FILECLASS
  ReadRegStr $R0 SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${FILECLASS}_backup"
  StrCmp $R0 "${FILECLASS}" 0 mr_restore_${EXT}_done
  ReadRegStr $R1 SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${MR_ASSOC_PRESERVED}"
  WriteRegStr SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${FILECLASS}_backup" "$R1"
  mr_restore_${EXT}_done:
    DeleteRegValue SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${MR_ASSOC_PRESERVED}"
!macroend

; 卸载后：Tauri 已把 `_backup` 恢复到扩展名默认值并删除 ProgID。
; 若默认值仍然是本应用（旧版污染或异常路径），清空它并移除备份/暂存值。
!macro MR_CLEAR_DEAD_ASSOC EXT FILECLASS
  ReadRegStr $R0 SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" ""
  StrCmp $R0 "${FILECLASS}" 0 mr_clear_${EXT}_done
  WriteRegStr SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "" ""
  mr_clear_${EXT}_done:
    DeleteRegValue SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${FILECLASS}_backup"
    DeleteRegValue SHELL_CONTEXT "${MR_ASSOC_ROOT}\.${EXT}" "${MR_ASSOC_PRESERVED}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "MangaReader requires Windows 10 (NT 10.0, Build 10240) or later.$\r$\n$\r$\nMangaReader 需要 Windows 10（Build 10240）或更高版本，安装已中止。"
    Quit
  ${EndIf}
  !insertmacro MR_PRESERVE_ASSOC_BACKUP "cbz" "${MR_ASSOC_CBZ_CLASS}"
  !insertmacro MR_PRESERVE_ASSOC_BACKUP "zip" "${MR_ASSOC_ZIP_CLASS}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MR_RESTORE_ASSOC_BACKUP "cbz" "${MR_ASSOC_CBZ_CLASS}"
  !insertmacro MR_RESTORE_ASSOC_BACKUP "zip" "${MR_ASSOC_ZIP_CLASS}"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MR_CLEAR_DEAD_ASSOC "cbz" "${MR_ASSOC_CBZ_CLASS}"
  !insertmacro MR_CLEAR_DEAD_ASSOC "zip" "${MR_ASSOC_ZIP_CLASS}"
!macroend
