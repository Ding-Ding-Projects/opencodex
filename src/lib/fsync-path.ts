import { closeSync, fsyncSync, lstatSync, openSync } from "node:fs";

function quotePowerShell(value: string): string { return value.replaceAll("'", "''"); }

/** Flush a file or directory and fail closed when durability cannot be proven. */
export function fsyncPath(path: string): void {
  if (process.platform !== "win32") {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return;
  }

  const isDirectory = lstatSync(path).isDirectory();
  const flags = isDirectory ? 0x02000000 : 0;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OcxFlush { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool FlushFileBuffers(IntPtr handle); [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle); }'",
    `$h=[OcxFlush]::CreateFile('${quotePowerShell(path)}',0x40000000,7,[IntPtr]::Zero,3,${flags},[IntPtr]::Zero)`,
    "if($h -eq [IntPtr](-1)){ exit [Runtime.InteropServices.Marshal]::GetLastWin32Error() }",
    "try { if(-not [OcxFlush]::FlushFileBuffers($h)){ exit [Runtime.InteropServices.Marshal]::GetLastWin32Error() } } finally { [OcxFlush]::CloseHandle($h) | Out-Null }",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  if (!result.success) throw new Error(`durability flush failed (${isDirectory ? "directory" : "file"}, ${result.exitCode ?? "unknown"})`);
}
