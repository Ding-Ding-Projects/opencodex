import { closeSync, fsyncSync, lstatSync, openSync } from "node:fs";

function quotePowerShell(value: string): string { return value.replaceAll("'", "''"); }

/**
 * Retry a filesystem operation a bounded number of times when it fails with a transient
 * EPERM, EACCES, or EBUSY: the codes Windows hands back when antivirus, an indexer, or
 * another concurrent writer is still holding a handle on a file or directory that was just
 * created or renamed. Every other error, including a persistent EPERM/EACCES/EBUSY that
 * outlasts every attempt, is rethrown exactly as the caller would see it on a bare call.
 * This never swallows a real failure, and the decision is made from the error code alone,
 * never from `process.platform`, so the same guard applies wherever it is genuinely needed.
 */
export function retryTransientFsError<T>(run: () => T, attempts = 3): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= attempts - 1) throw error;
      Bun.sleepSync(25 * (attempt + 1));
    }
  }
}

function fsyncHandle(path: string, mode: "r" | "r+"): void {
  const fd = openSync(path, mode);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Flush a file or directory and fail closed when durability cannot be proven.
 *
 * A Windows-only quirk used to send *every* call here (files included) through a
 * spawned powershell.exe: `FlushFileBuffers` (what `fsyncSync` calls into on Windows)
 * requires a handle opened with write access. Opening the path read-only (`"r"`) fails
 * on every single call with exactly `EPERM: operation not permitted, fsync`, reproduced
 * directly on this host. `"r+"` opens for read+write without truncating or creating, so
 * a file's own bytes are never touched, only its OS buffers are flushed; POSIX fsync
 * accepts `"r+"` identically to `"r"`, so this one mode covers a *file* on every platform
 * natively, no spawn required.
 *
 * A *directory* is a genuine per-OS split that a file is not: POSIX generally refuses to
 * open a directory for write access at all, while Windows refuses to fsync a directory
 * handle that was opened *without* write access (same EPERM, also reproduced directly on
 * this host, both modes below). The two modes are tried in turn, and the result decides
 * which one this real host needs. This deliberately never consults `process.platform`,
 * which test code legitimately overrides independently of the real OS (see the
 * Auto-connect Darwin / non-Darwin tests in tests/claude-management-api.test.ts, which
 * fake `process.platform` for the very code path this function is on: `saveConfig` during
 * `startServer`). Trusting `process.platform` here previously meant a faked platform
 * silently picked the wrong handle mode on a real Windows machine and threw the same
 * EPERM from a different call site. Only if *neither* native mode works does this fall
 * through to the raw Win32 `CreateFile`/`FlushFileBuffers` call: unconditionally correct
 * but the slowest path, and what this always was, just no longer the first thing tried.
 *
 * Routing every file flush through a synchronous, blocking child-process spawn, as this
 * used to on every atomic write, was not just slower than the native call: it is expensive
 * enough on its own to make writes queue up and race elsewhere under load (measured turning
 * unrelated saveConfig-adjacent tests from milliseconds into multi-second timeouts).
 */
export function fsyncPath(path: string): void {
  const isDirectory = lstatSync(path).isDirectory();

  if (!isDirectory) {
    // A transient EPERM/EACCES/EBUSY here (antivirus or an indexer still holding the
    // handle for a moment) is retried; anything else still fails closed immediately.
    retryTransientFsError(() => fsyncHandle(path, "r+"));
    return;
  }

  try {
    // The POSIX shape, tried first because it is what already worked here. A single bare
    // attempt: on the host where this is instead the Windows quirk, it fails the same way
    // every time, so retrying it would only spend a bounded retry's backoff for nothing.
    fsyncHandle(path, "r");
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
  }
  try {
    // The Windows shape. A transient failure here is retried like any other write path.
    retryTransientFsError(() => fsyncHandle(path, "r+"));
    return;
  } catch {
    // Neither native mode worked on this host: fall through to the raw Win32 call, the
    // original and still-correct last resort for a genuinely unusual environment.
  }

  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OcxFlush { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool FlushFileBuffers(IntPtr handle); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle); }'",
    `$h=[OcxFlush]::CreateFile('${quotePowerShell(path)}',0x40000000,7,[IntPtr]::Zero,3,0x02000000,[IntPtr]::Zero)`,
    "if($h -eq [IntPtr](-1)){ exit [Runtime.InteropServices.Marshal]::GetLastWin32Error() }",
    "try { if(-not [OcxFlush]::FlushFileBuffers($h)){ exit [Runtime.InteropServices.Marshal]::GetLastWin32Error() } } finally { [OcxFlush]::CloseHandle($h) | Out-Null }",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  if (!result.success) throw new Error(`durability flush failed (directory, ${result.exitCode ?? "unknown"})`);
}
