<#
.SYNOPSIS
  List every top-level Chrome_WidgetWin_1 window owned by a process, with its
  title, so a caller can pick the one it wants by name.

.DESCRIPTION
  `window-tools.ps1 -Action find` (used by `scripts/capture-shots.ts`) returns
  only the FIRST size-filtered window for a pid, which is fine when the app
  ever has exactly one top-level window open. The download popups break that
  assumption on purpose: `electron/main.mjs`'s `openDownloadPopup` opens a
  SECOND `BrowserWindow` in the same process, alongside the main dashboard
  window, each with its own distinct title ("opencodex - Start download" /
  "opencodex - Download"). This script exists only to disambiguate between
  them by title; the actual PrintWindow capture still goes through
  `window-tools.ps1 -Action capture -Hwnd <hwnd>` once the right hwnd is
  known, unchanged.

  No minimum-size filter here, unlike `window-tools.ps1`'s `find` - the
  popups are real UI, not a zero-sized helper window, but there is no reason
  to bake in a size assumption a one-off recapture script does not need.

.PARAMETER OwnerPid
  The Electron process id to enumerate windows for.

.EXAMPLE
  popup-window-find.ps1 -OwnerPid 1234
  # OK 65552  opencodex v2.7.42
  # OK 131080 opencodex - Start download
#>
param(
  [Parameter(Mandatory = $true)][int]$OwnerPid
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class OcxPopupWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public const string AppClass = "Chrome_WidgetWin_1";

  public class Found { public IntPtr H; public string Title; public int W; public int Hgt; }

  public static List<Found> ForProcess(uint wanted) {
    List<Found> found = new List<Found>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != wanted) return true;
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() != AppClass) return true;
      RECT r;
      if (!GetClientRect(h, out r)) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowTextW(h, title, title.Capacity);
      Found f = new Found();
      f.H = h; f.Title = title.ToString(); f.W = r.Right - r.Left; f.Hgt = r.Bottom - r.Top;
      found.Add(f);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

for ($i = 0; $i -lt 60; $i++) {
  $windows = [OcxPopupWin]::ForProcess([uint32]$OwnerPid)
  if ($windows.Count -ge 1) {
    foreach ($w in $windows) {
      Write-Output ("OK {0}`t{1}`t{2}`t{3}" -f [long]$w.H, $w.Title, $w.W, $w.Hgt)
    }
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
throw "no Chrome_WidgetWin_1 window for pid $OwnerPid after 30s"
