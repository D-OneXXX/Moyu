; MangaReader 安装器系统准入：Windows 10 (NT 10.0, Build 10240) 及以上。
;
; 与 src-tauri/src/platform.rs 的 `enforce_windows_baseline` 保持一致：
; 安装器先拦一层，避免用户在 Win7 / Win8 / Win8.1 上装完才发现无法启动。
; Tauri 会在生成的 installer.nsi 中通过 NSIS_HOOK_PREINSTALL 注入本宏。
;
; 说明：`${AtLeastWin10}` 覆盖 NT 10.0 全部版本（Win10 RTM 即 Build 10240，
; Win11 报 10.0.2xxxx）；低于它的系统（6.1 / 6.2 / 6.3）一律拒绝安装。

!include "WinVer.nsh"

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "MangaReader requires Windows 10 (NT 10.0, Build 10240) or later.$\r$\n$\r$\nMangaReader 需要 Windows 10（Build 10240）或更高版本，安装已中止。"
    Quit
  ${EndIf}
!macroend
