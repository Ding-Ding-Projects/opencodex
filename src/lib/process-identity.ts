import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

/**
 * Stable-enough identity for one OS process lifetime. A PID is deliberately
 * not sufficient: operating systems reuse it after a process exits.
 */
export interface ProcessIdentity {
  pid: number;
  /** Windows CreationDate or Linux /proc starttime (opaque, equality-only). */
  startIdentity: string;
  /** Executable path when the platform exposes it. */
  executablePath?: string;
  /** Command line when the platform exposes it. */
  commandLine?: string;
}

/** The only identity fields safe to persist in a journal or update record. */
export interface PersistedProcessIdentity {
  pid: number;
  startIdentity: string;
  executablePath?: string;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function normalizeExecutablePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readWindowsProcessIdentity(pid: number): ProcessIdentity | null {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const wmic = `${systemRoot}\\System32\\wbem\\WMIC.exe`;
  try {
    const output = execFileSync(wmic, [
      "process", "where", `ProcessId=${pid}`,
      "get", "CreationDate,ExecutablePath,CommandLine", "/VALUE",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    });
    const fields = new Map<string, string>();
    for (const line of output.replace(/\r/g, "").split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    const startIdentity = fields.get("CreationDate");
    if (startIdentity) {
      return {
        pid,
        startIdentity,
        executablePath: normalizeExecutablePath(fields.get("ExecutablePath")),
        commandLine: fields.get("CommandLine") || undefined,
      };
    }
  } catch {
    // Newer Windows images may not include WMIC. Use the built-in CIM cmdlet.
  }

  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; `
        + "if ($null -ne $p) { $p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress }",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    }).trim();
    if (!output) return null;
    const value = JSON.parse(output) as {
      ProcessId?: number;
      CreationDate?: string;
      ExecutablePath?: string;
      CommandLine?: string;
    };
    if (value.ProcessId !== pid || !value.CreationDate) return null;
    return {
      pid,
      startIdentity: value.CreationDate,
      executablePath: normalizeExecutablePath(value.ExecutablePath),
      commandLine: value.CommandLine?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function readProcIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    // Fields after comm start at state (field 3); starttime is field 22.
    const startIdentity = fields[19];
    if (!startIdentity) return null;
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    let executablePath: string | undefined;
    try { executablePath = normalizeExecutablePath(readlinkSync(`/proc/${pid}/exe`)); } catch { /* optional */ }
    return { pid, startIdentity, executablePath, commandLine: commandLine || undefined };
  } catch {
    return null;
  }
}

/** Read one process identity without treating a missing/denied read as proof of ownership. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!validPid(pid)) return null;
  // The current process can provide its own start identity without spawning a
  // Windows management child. This keeps synchronous journal writes off the
  // server's event loop; external PIDs still use the OS process table below.
  if (pid === process.pid) {
    const startedAt = Date.now() - Math.round(process.uptime() * 1000);
    return {
      pid,
      startIdentity: String(startedAt),
      executablePath: normalizeExecutablePath(process.execPath),
      commandLine: [process.execPath, ...process.argv].join(" "),
    };
  }
  return process.platform === "win32" ? readWindowsProcessIdentity(pid) : readProcIdentity(pid);
}

function normalizedCommandLine(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\\/g, "/");
}

/**
 * The proxy-specific reader used by stop paths. Generic process termination may
 * use readProcessIdentity, but stopping a proxy must also prove the executable
 * command is an OpenCodex start process.
 */
export function readProxyProcessIdentity(pid: number): ProcessIdentity | null {
  const identity = readProcessIdentity(pid);
  if (!identity) return null;
  const commandLine = normalizedCommandLine(identity.commandLine);
  const entrypoint = commandLine.includes("src/cli.ts")
    || commandLine.includes("src/cli/index.ts")
    || commandLine.includes("@bitkyc08/opencodex")
    || /(?:^|[\s/"'])(?:ocx|opencodex)(?:\.cmd)?(?:$|[\s"'])/.test(commandLine);
  const isStart = /(?:^|[\s"'])start(?:$|[\s"'])/.test(commandLine);
  return entrypoint && isStart ? identity : null;
}

/** Compare identities from two observations; PID alone never passes. */
export function sameProcessIdentity(expected: ProcessIdentity, actual: ProcessIdentity | null): boolean {
  if (!actual || expected.pid !== actual.pid || canonicalStartIdentity(expected.startIdentity) !== canonicalStartIdentity(actual.startIdentity)) return false;
  if (expected.executablePath !== undefined || actual.executablePath !== undefined) {
    if (!expected.executablePath || !actual.executablePath || expected.executablePath !== actual.executablePath) return false;
  }
  return true;
}

export function toPersistedProcessIdentity(identity: ProcessIdentity): PersistedProcessIdentity {
  return {
    pid: identity.pid,
    startIdentity: identity.startIdentity,
    ...(identity.executablePath ? { executablePath: identity.executablePath } : {}),
  };
}

function canonicalStartIdentity(value: string): string {
  const trimmed = value.trim();
  // PowerShell CIM serializes DateTime as /Date(epoch-ms)/.
  const jsonDate = /^\/Date\((\d+)\)\/$/.exec(trimmed);
  if (jsonDate) return jsonDate[1];
  // The current-process fast path stores epoch milliseconds directly.
  if (/^\d{12,}$/.test(trimmed)) return trimmed;
  // WMIC's DMTF timestamp: YYYYMMDDHHMMSS.mmmmmm(+|-)UUU.
  const dmtf = /^(\d{14})\.(\d{6})([+-])(\d{3})$/.exec(trimmed);
  if (dmtf) {
    const digits = dmtf[1];
    const utc = Date.UTC(
      Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6, 8)),
      Number(digits.slice(8, 10)), Number(digits.slice(10, 12)), Number(digits.slice(12, 14)),
    );
    const offsetMinutes = Number(dmtf[4]) * (dmtf[3] === "+" ? 1 : -1);
    return String(utc - offsetMinutes * 60_000 + Math.trunc(Number(`0.${dmtf[2]}`) * 1000));
  }
  return trimmed;
}

/** Validate a persisted identity before using it as an ownership claim. */
export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProcessIdentity>;
  return validPid(candidate.pid ?? 0)
    && typeof candidate.startIdentity === "string"
    && candidate.startIdentity.length > 0
    && candidate.startIdentity.length <= 128
    && (candidate.executablePath === undefined || (typeof candidate.executablePath === "string" && candidate.executablePath.length <= 4096))
    && (candidate.commandLine === undefined || (typeof candidate.commandLine === "string" && candidate.commandLine.length <= 16_384));
}

export function isPersistedProcessIdentity(value: unknown): value is PersistedProcessIdentity {
  return isProcessIdentity(value) && (value as ProcessIdentity).commandLine === undefined;
}
