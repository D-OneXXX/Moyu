import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * WebView2 ignores CDP viewport emulation. Resize the real native window on
 * Windows so 900px minimum-width layout checks exercise the actual shell.
 *
 * A maximized window ignores SetWindowPos size changes, and `MainWindowHandle`
 * can point at a hidden helper window. Restore the largest visible window owned
 * by the app process, resize it, then read back its client rect so callers can
 * assert the requested width actually took effect.
 */
export function resizeNativeWindow(pid, physicalWidth, physicalHeight) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "native window resize is Windows-only in this QA harness" };
  }
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class QaWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static IntPtr FindLargestVisibleWindow(int pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner != (uint)pid || !IsWindowVisible(hWnd)) return true;
      RECT rect;
      if (!GetClientRect(hWnd, out rect)) return true;
      long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
      if (area > bestArea) { bestArea = area; best = hWnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
[QaWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$handle = [QaWindow]::FindLargestVisibleWindow(${Number(pid)})
if ($handle -eq [IntPtr]::Zero) { throw "main window handle unavailable" }
if ([QaWindow]::IsZoomed($handle)) {
  [QaWindow]::ShowWindow($handle, 9) | Out-Null
}
[QaWindow]::SetWindowPos($handle, [IntPtr]::Zero, 80, 70, ${Math.round(physicalWidth)}, ${Math.round(physicalHeight)}, 0x0014) | Out-Null
Start-Sleep -Milliseconds 250
$rect = New-Object QaWindow+RECT
[QaWindow]::GetClientRect($handle, [ref]$rect) | Out-Null
"$($rect.Right) $($rect.Bottom)"
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: String(result.stderr || result.stdout || "powershell resize failed").trim(),
    };
  }
  const [width, height] = String(result.stdout || "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const actual = Number.isFinite(width) && Number.isFinite(height)
    ? { width, height }
    : {};
  return { ok: true, reason: "", ...actual };
}
