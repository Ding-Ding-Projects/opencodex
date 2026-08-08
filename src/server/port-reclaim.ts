/**
 * Reclaim a listen port after stop/update so restart can stay on the configured
 * port instead of hopping to an ephemeral one (Windows CLOSE_WAIT / leftover ocx).
 *
 * This helper never terminates a process. PID allowlists cannot authenticate a
 * process instance after PID reuse, so the stop/update owner must finish any
 * termination before calling this wait-and-dead-row-cleanup boundary.
 */
import { execFileSync } from "node:child_process";
import { isProcessAlive } from "../lib/process-control";
import { isPortAvailable, type WaitForPortOptions } from "./ports";
import { dropWindowsTcpRowsForLocalPort } from "./windows-tcp-drop";

export type ListenPidScan =
  | { ok: true; pids: number[] }
  | { ok: false; error?: string };

export type ReclaimListenPortOptions = WaitForPortOptions & {
  /**
   * @deprecated Retained for source compatibility and ignored. Reclaim never
   * terminates a live owner; the caller must stop its own process first.
   */
  killOcxHolders?: boolean;
  /**
   * @deprecated Retained for source compatibility and ignored. A PID is not a
   * stable process-instance identity across a reuse boundary.
   */
  onlyKillPids?: number[];
  /**
   * On Windows, force-delete IPv4 TCP rows for this local port via SetTcpEntry.
   * Default true on win32. Never kills foreign processes, never runs while a
   * live foreign / protected ocx listener owns the port, and never runs when
   * the listener scan failed.
   */
  dropTcpRows?: boolean;
  /** How often to scan for listen PIDs / attempt TCB drop (ms). Default 500. */
  scanIntervalMs?: number;
  listListenPidsFn?: (port: number) => ListenPidScan | number[];
  isAliveFn?: (pid: number) => boolean;
  /** @deprecated Test seam retained for compatibility; never called. */
  verifyOcxFn?: (pid: number) => number | null;
  /** @deprecated Test seam retained for compatibility; never called. */
  killFn?: (pid: number) => void;
  dropTcpFn?: (
    port: number,
    expectedDeadOwnerPids: readonly number[],
    isAliveFn: (pid: number) => boolean,
  ) => number | { dropped: number; skippedIpv6: number };
  isAvailableFn?: (port: number, hostname?: string) => Promise<boolean>;
  sleepMs?: (ms: number) => Promise<void>;
};

/**
 * Parse `netstat -ano` (Windows) / `netstat -anlp` listen lines for a port.
 * Exported for unit tests.
 */
export function parseListenPidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  const portSuffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^TCP\b/i.test(line) && !/^tcp\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    // Prefer the first address token that ends with :port (local), not a later foreign one.
    const localIdx = parts.findIndex(part => part.endsWith(portSuffix) || part.endsWith(`]:${port}`));
    if (localIdx < 0) continue;
    const foreign = parts[localIdx + 1] ?? "";
    // Locale-safe listen detection: English LISTEN*, or unbound foreign wildcard
    // (German ABHÖREN still shows 0.0.0.0:0 / *:*).
    const listenWord = /\bLISTEN/i.test(line);
    const wildcardForeign = /^(0\.0\.0\.0|::|\*|\[::\]):0$/.test(foreign) || foreign === "*:*";
    if (!listenWord && !wildcardForeign) continue;
    const last = parts[parts.length - 1] ?? "";
    const winPid = /^\d+$/.test(last) ? Number(last) : NaN;
    const unixPid = /^(\d+)(?:\/\S*)?$/.exec(last);
    const pid = Number.isSafeInteger(winPid) && winPid > 0
      ? winPid
      : unixPid
        ? Number(unixPid[1])
        : NaN;
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function normalizeListenPidScan(result: ListenPidScan | number[]): ListenPidScan {
  if (Array.isArray(result)) return { ok: true, pids: result };
  return result;
}

/** Prefer English netstat states; fall back to the UI-locale table. */
function readWindowsNetstatAno(): string {
  const netstat = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\netstat.exe`;
  const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  try {
    // chcp 437 forces English LISTENING/ESTABLISHED labels on localized Windows.
    return execFileSync(cmd, ["/d", "/c", `chcp 437>nul & "${netstat}" -ano -p tcp`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return execFileSync(netstat, ["-ano", "-p", "tcp"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    });
  }
}

/**
 * Scan for PIDs currently LISTENing on `port`.
 * Distinguishes probe failure (`ok: false`) from a successful empty result.
 */
export function scanListenPids(port: number): ListenPidScan {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: "invalid port" };
  }
  try {
    if (process.platform === "win32") {
      return { ok: true, pids: parseListenPidsFromNetstat(readWindowsNetstatAno(), port) };
    }
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return {
        ok: true,
        pids: output
          .split(/\r?\n/)
          .map(line => Number(line.trim()))
          .filter(pid => Number.isSafeInteger(pid) && pid > 0),
      };
    } catch (lsofErr) {
      try {
        const output = execFileSync("netstat", ["-anlp"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        });
        return { ok: true, pids: parseListenPidsFromNetstat(output, Math.trunc(port)) };
      } catch (netstatErr) {
        return {
          ok: false,
          error: `lsof/netstat unavailable: ${String(lsofErr)} / ${String(netstatErr)}`,
        };
      }
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Best-effort PIDs currently LISTENing on `port`. Empty on probe failure. */
export function listListenPids(port: number): number[] {
  const scan = scanListenPids(port);
  return scan.ok ? scan.pids : [];
}

/**
 * Wait until `port` can bind.
 * Never kills a process. Never drops TCP rows while any live listener owns the
 * port, or when the listener scan failed. This remains safe across PID reuse:
 * a live owner is protected regardless of its executable or command line.
 */
export async function reclaimListenPort(
  port: number,
  hostname = "127.0.0.1",
  opts: ReclaimListenPortOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 100;
  const scanIntervalMs = opts.scanIntervalMs ?? 500;
  const dropTcpRows = opts.dropTcpRows ?? process.platform === "win32";
  const listFn = opts.listListenPidsFn ?? scanListenPids;
  const isAliveFn = opts.isAliveFn ?? isProcessAlive;
  const dropTcpFn = opts.dropTcpFn ?? dropWindowsTcpRowsForLocalPort;
  const isAvailableFn = opts.isAvailableFn ?? isPortAvailable;
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const deadline = Date.now() + timeoutMs;
  let lastScan = 0;
  for (;;) {
    if (await isAvailableFn(port, hostname)) return true;
    if (Date.now() >= deadline) return false;

    if (Date.now() - lastScan >= scanIntervalMs) {
      lastScan = Date.now();

      const scan = normalizeListenPidScan(listFn(port));
      if (!scan.ok) {
        // Failed probe ≠ empty listeners: do not kill and do not reset TCP rows.
        await sleep(intervalMs);
        continue;
      }

      let liveOwner = false;
      const deadOwnerPids = new Set<number>();

      for (const pid of scan.pids) {
        if (pid === process.pid) {
          liveOwner = true;
          continue;
        }
        if (!isAliveFn(pid)) {
          // Windows may retain a dead PID on a ghost LISTEN/CLOSE_WAIT row.
          deadOwnerPids.add(pid);
          continue;
        }
        // A numeric allowlist cannot distinguish this instance from a newly
        // reused PID (including a newly started ocx twin). Protect every live
        // owner and leave termination to the caller that owns a real handle.
        liveOwner = true;
      }

      if (liveOwner) {
        // Any live owner keeps the port protected. Never SetTcpEntry-reset its
        // sockets, even when its PID resembles a process the caller once owned.
        await sleep(intervalMs);
        continue;
      }

      // After hard-kill, browsers often keep ESTABLISHED/CLOSE_WAIT to the dead listener.
      // Reset those IPv4 TCBs (and ghost LISTEN rows) so the configured port can bind again —
      // without killing the browser process. Only safe when no live foreign/protected listener remains.
      if (dropTcpRows) {
        try {
          // The dropper takes its own fresh all-state netstat snapshot. This
          // also reaches CLOSE_WAIT/ESTABLISHED-only ghosts after their LISTEN
          // row disappears. Every fresh owner must still be parseable and dead;
          // a new live listener makes the entire reset fail closed.
          dropTcpFn(port, [...deadOwnerPids], isAliveFn);
        } catch {
          /* access denied / unsupported — keep waiting */
        }
      }
    }

    await sleep(intervalMs);
  }
}
