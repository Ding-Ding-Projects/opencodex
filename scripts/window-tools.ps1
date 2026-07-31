<#
.SYNOPSIS
  Find, size and photograph a real Win32 window. Used by `capture-shots.ts`.

.DESCRIPTION
  The screenshots in `assets/shots/` are captured from the actual desktop window
  rather than through the DevTools screenshot API, and these three verbs are what
  that costs.

  Why not CDP: `Page.captureScreenshot` renders the *web contents*. For a
  frameless Electron window that is very nearly the whole app, and therefore very
  nearly right, which is the most dangerous kind of wrong. It cannot show that
  the app owns a real top-level window at the size the README claims, it is
  identical whether the window is 1440x900 or 300x200, and it would look exactly
  the same if the desktop shell had failed to open a window at all.

  Three things here are load-bearing and none of them is obvious:

  - **PW_RENDERFULLCONTENT (0x2).** Without it a GPU-composited Chromium window
    paints a perfectly-sized, perfectly-black rectangle. The call succeeds, a
    plausible PNG is written, and it contains nothing.

  - **DPI awareness, set before touching any window.** A DPI-unaware process is
    handed virtualised 96-DPI coordinates, so on a 150% display it measures a
    1440x900 client area, captures 1440x900, and silently loses the other 55% of
    the pixels. Nothing errors; the shots are just soft.

  - **Window handles are desktop-scoped.** A process on the interactive desktop
    cannot see a window on an off-screen one, so this only works when it runs on
    the same desktop as the app. That is why the harness spawns Electron as its
    own child instead of attaching to a window someone else launched.

  Keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI, so one
  stray em dash in a comment becomes a parser error reported against an unrelated
  line twenty lines further down.

.PARAMETER Action
  find    - locate the app window owned by -OwnerPid.  Prints "OK <hwnd> <w> <h>".
  fit     - resize -Hwnd until its CLIENT area is exactly -Width x -Height.
  capture - PrintWindow -Hwnd into the PNG at -Out.

.EXAMPLE
  window-tools.ps1 -Action find -OwnerPid 1234
  window-tools.ps1 -Action fit -Hwnd 65552 -Width 2880 -Height 1800
  window-tools.ps1 -Action capture -Hwnd 65552 -Out shots/dashboard.png
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('find', 'fit', 'capture')][string]$Action,
  [long]$Hwnd = 0,
  [int]$OwnerPid = 0,
  [int]$Width = 0,
  [int]$Height = 0,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class OcxWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
  // SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
  public const uint MoveFlags = 0x0002 | 0x0004 | 0x0010;

  // Electron's real top-level window. Chrome_WidgetWin_0 is used for the many
  // zero-sized helper windows in the same process, so the class alone is not
  // enough of a filter.
  public const string AppClass = "Chrome_WidgetWin_1";

  public static List<IntPtr> ForProcess(uint wanted) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != wanted) return true;
      StringBuilder cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() != AppClass) return true;
      RECT r;
      if (!GetClientRect(h, out r)) return true;
      if (r.Right - r.Left < 200 || r.Bottom - r.Top < 200) return true;
      found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

try {
  if (-not [OcxWin]::SetProcessDpiAwarenessContext([OcxWin]::PerMonitorV2)) { [void][OcxWin]::SetProcessDPIAware() }
} catch {
  try { [void][OcxWin]::SetProcessDPIAware() } catch { }
}

function Get-Client([IntPtr]$h) {
  $r = New-Object OcxWin+RECT
  [void][OcxWin]::GetClientRect($h, [ref]$r)
  # Return a typed pair; PowerShell unrolls bare arrays in ways that turn an
  # int into an Object[] two lines later.
  return New-Object psobject -Property @{ W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top) }
}

if ($Action -eq 'find') {
  if ($OwnerPid -le 0) { throw "find needs -OwnerPid" }

  # Electron opens the window well after the process exists, and the desktop
  # shell waits on its proxy answering /healthz first, so this can legitimately
  # take a while on a cold start.
  for ($i = 0; $i -lt 120; $i++) {
    $windows = [OcxWin]::ForProcess([uint32]$OwnerPid)
    if ($windows.Count -ge 1) {
      $h = $windows[0]
      $c = Get-Client $h
      Write-Output ("OK {0} {1} {2}" -f [long]$h, $c.W, $c.H)
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }
  throw "no $([OcxWin]::AppClass) window for pid $OwnerPid after 60s"
}

$h = [IntPtr]::new($Hwnd)
if (-not [OcxWin]::IsWindow($h)) {
  throw "hwnd $Hwnd is not a live window on this desktop (handles are desktop-scoped)"
}

if ($Action -eq 'fit') {
  if ($Width -le 0 -or $Height -le 0) { throw "fit needs -Width and -Height" }

  $outer = New-Object OcxWin+RECT
  [void][OcxWin]::GetWindowRect($h, [ref]$outer)
  $outerW = $outer.Right - $outer.Left
  $outerH = $outer.Bottom - $outer.Top

  # Asking for a size does not get you one: a frameless Chromium window carries
  # an invisible resize border whose thickness depends on DPI and Windows
  # version, and Chromium clamps a launch size to the display. So set, measure
  # what actually resulted, correct by the difference, repeat. Two passes in
  # practice; the rest cover a window still animating open.
  #
  # Windows is happy to make a window larger than the screen, which is what lets
  # a 1280x800 off-screen desktop host a 2880x1800 capture surface.
  $c = Get-Client $h
  for ($i = 0; $i -lt 8; $i++) {
    $c = Get-Client $h
    $dw = $Width - $c.W
    $dh = $Height - $c.H
    if ($dw -eq 0 -and $dh -eq 0) {
      Write-Output ("OK {0} {1}" -f $c.W, $c.H)
      exit 0
    }
    $outerW += $dw
    $outerH += $dh
    [void][OcxWin]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $outerW, $outerH, [OcxWin]::MoveFlags)
    Start-Sleep -Milliseconds 220
  }
  throw "could not fit hwnd $Hwnd to ${Width}x${Height}; client settled at $($c.W)x$($c.H)"
}

# ------------------------------------------------------------------- capture
if ([string]::IsNullOrWhiteSpace($Out)) { throw "capture needs -Out" }

Add-Type -AssemblyName System.Drawing

$c = Get-Client $h
if ($c.W -le 0 -or $c.H -le 0) { throw "hwnd $Hwnd has a $($c.W)x$($c.H) client area" }

$bmp = New-Object System.Drawing.Bitmap($c.W, $c.H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
try {
  # PW_CLIENTONLY (1) | PW_RENDERFULLCONTENT (2)
  $ok = [OcxWin]::PrintWindow($h, $hdc, 3)
} finally {
  $gfx.ReleaseHdc($hdc)
}
$gfx.Dispose()
if (-not $ok) { $bmp.Dispose(); throw "PrintWindow returned false for hwnd $Hwnd" }

# A black frame is what a failed GPU read-back looks like, and it is
# indistinguishable from a real capture by file size alone. Sample a coarse grid
# and refuse to write one. This is a smoke test for "did the compositor hand us
# pixels", not an image diff.
$distinct = New-Object 'System.Collections.Generic.HashSet[int]'
$stepX = [Math]::Max(1, [int]($c.W / 40))
$stepY = [Math]::Max(1, [int]($c.H / 40))
for ($x = 0; $x -lt $c.W; $x += $stepX) {
  for ($y = 0; $y -lt $c.H; $y += $stepY) {
    [void]$distinct.Add($bmp.GetPixel($x, $y).ToArgb())
  }
}
if ($distinct.Count -lt 8) {
  $bmp.Dispose()
  throw "capture of hwnd $Hwnd sampled only $($distinct.Count) distinct colours, so the window painted blank (no PW_RENDERFULLCONTENT, or the GPU process is not compositing)"
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output ("OK {0} {1}" -f $c.W, $c.H)
