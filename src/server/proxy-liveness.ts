/**
 * Runtime-state-first proxy liveness with identity checking.
 *
 * Historically `ensure`/`start` probed only `config.port` and accepted ANY 2xx /healthz:
 * a proxy that started on a fallback port was invisible (duplicate starts, Codex synced
 * back to a dead port), and a foreign app answering 200 on the configured port counted
 * as "our proxy". Liveness now (1) prefers the pid + runtime-port record and (2) requires
 * the /healthz body to identify as opencodex.
 *
 * Lives outside cli.ts (which dispatches argv at module top level) so tests can import it.
 */
import { loadConfig, readAlivePid, readRuntimePort, verifyPidIdentityFresh } from "../config";
import { scanListenPids, type ListenPidScan } from "./port-reclaim";

export interface HealthzIdentity {
  service?: unknown;
  status?: unknown;
  version?: unknown;
  uptime?: unknown;
  pid?: unknown;
}

export interface LivenessIo {
  fetchFn?: typeof fetch;
  readPidFn?: () => number | null;
  /**
   * Fresh full identity check of the passed candidate pid; must return the SAME pid or null.
   * Destructive callers only ever receive pids that passed this gate.
   */
  verifyPidFn?: (candidatePid: number) => number | null;
  /** Fail-closed lookup of the PIDs currently listening on a candidate port. */
  scanListenPidsFn?: (port: number) => ListenPidScan | number[];
  readRuntimeFn?: (pid?: number) => { pid?: number; port: number; hostname?: string; supervised?: boolean } | null;
  configFn?: () => { port?: number; hostname?: string };
  timeoutMs?: number;
}

export interface LiveProxy {
  pid: number | null;
  port: number;
  /** Raw bind hostname the probe succeeded against; compose URLs via `probeHostname`. */
  hostname?: string;
  /** Whether the successful probe used runtime-port metadata or the configured listen port. */
  source: "runtime" | "config";
  /** Correlated from the PID-matched runtime record, never inferred from installation. */
  supervised?: boolean;
}

/**
 * Host to probe for a given bind hostname: wildcards answer on IPv4 loopback, and raw
 * IPv6 addresses must be bracketed or the composed URL is invalid.
 */
export function probeHostname(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * True when a /healthz body identifies an opencodex proxy. Accepts the explicit
 * `service: "opencodex"` marker, plus the legacy `{status, version, uptime}` trio so a
 * still-running pre-identity proxy (e.g. right after `ocx update`) is not mistaken for a
 * foreign server and shadow-started over.
 */
export function isOpencodexHealthz(body: HealthzIdentity | null): boolean {
  if (!body) return false;
  if (body.service === "opencodex") return true;
  if (body.service !== undefined) return false;
  return body.status === "ok" && typeof body.version === "string" && typeof body.uptime === "number";
}

/** Identity-checked /healthz probe; null when unreachable, non-OK, or not our proxy. */
export async function proxyIdentityAt(
  port: number,
  opts: { hostname?: string; expectedPid?: number } = {},
  io: LivenessIo = {},
): Promise<{ pid: number | null } | null> {
  const fetchFn = io.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`http://${probeHostname(opts.hostname)}:${port}/healthz`, {
      signal: AbortSignal.timeout(io.timeoutMs ?? 750),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as HealthzIdentity | null;
    if (!isOpencodexHealthz(body)) return null;
    const pid = typeof body?.pid === "number" ? body.pid : null;
    if (opts.expectedPid !== undefined && pid !== null && pid !== opts.expectedPid) return null;
    return { pid };
  } catch {
    return null;
  }
}

/**
 * Locate the live proxy: pid file → runtime-port record → identity probe. Falls back to
 * the configured port ONLY when no runtime record answers, so a fallback-port proxy is
 * found and a foreign listener on the configured port is rejected.
 */
export async function findLiveProxy(io: LivenessIo = {}): Promise<LiveProxy | null> {
  // Prefer the cheap alive-pid check: the Windows cmdline probe (WMIC/PowerShell) is too
  // expensive for waitForProxy's 150ms poll loop. Run it only after /healthz answers,
  // immediately before the candidate can become a destructive stop/kill target.
  const readPidFn = io.readPidFn ?? readAlivePid;
  const verifyPidFn = io.verifyPidFn ?? verifyPidIdentityFresh;
  const scanListenPidsFn = io.scanListenPidsFn ?? scanListenPids;
  const readRuntimeFn = io.readRuntimeFn ?? readRuntimePort;
  const configFn = io.configFn ?? loadConfig;

  // The cheap pid is discovery-only. Before it can appear in a returned (killable) result,
  // it must be the sole listener on the probed port and pass a fresh full identity check
  // whose verifier echoes the exact candidate. A health endpoint cannot authorize another
  // process merely by copying its PID.
  const killablePid = (candidate: number | null, port: number): number | null => {
    if (candidate === null || !Number.isSafeInteger(candidate) || candidate <= 0) return null;
    try {
      const rawScan = scanListenPidsFn(port);
      const scan: ListenPidScan = Array.isArray(rawScan) ? { ok: true, pids: rawScan } : rawScan;
      if (!scan.ok) return null;
      const owners = new Set(scan.pids);
      if (owners.size !== 1 || !owners.has(candidate)) return null;
      const verified = verifyPidFn(candidate);
      return verified === candidate ? verified : null;
    } catch {
      return null;
    }
  };

  const pid = readPidFn();
  let probedPort: number | null = null;
  if (pid) {
    const runtime = readRuntimeFn(pid);
    if (runtime?.port) {
      probedPort = runtime.port;
      const identity = await proxyIdentityAt(runtime.port, { hostname: runtime.hostname, expectedPid: pid }, io);
      if (identity) {
        // Even when healthz echoes the pid-file value, the endpoint is unauthenticated
        // and the PID may have been reused. A full process-identity check is required
        // before a destructive caller receives the runtime PID.
        const trusted = killablePid(pid, runtime.port);
        return {
          pid: trusted,
          port: runtime.port,
          hostname: runtime.hostname,
          source: "runtime",
          // Service ownership is meaningful only when this exact runtime PID was
          // verified by healthz or the process-identity fallback. A stale marker
          // beside a PID-less legacy response must remain ordinary liveness only.
          ...(runtime.supervised === true && trusted !== null ? { supervised: true as const } : {}),
        };
      }
    }
  }

  // Orphan recovery: the pid file can be lost/corrupt while the proxy is alive (crash of a
  // sibling command, manual deletion). The runtime record still says where it listens —
  // identity-probe it so ensure/update/stop see the live proxy instead of shadowing it.
  const record = readRuntimeFn();
  if (record?.port && record.port !== probedPort) {
    const expectedPid = typeof record.pid === "number" ? record.pid : undefined;
    const identity = await proxyIdentityAt(record.port, { hostname: record.hostname, expectedPid }, io);
    // Only a freshly process-verified healthz pid is authoritative here. Both the
    // record and the unauthenticated endpoint can echo a stale/reused pid, so neither
    // may hand destructive callers (stopProxy → kill fallback) a candidate directly.
    if (identity) {
      const trusted = killablePid(identity.pid, record.port);
      return {
        pid: trusted,
        port: record.port,
        hostname: record.hostname,
        source: "runtime",
        ...(record.supervised === true && trusted !== null ? { supervised: true as const } : {}),
      };
    }
  }

  const config = configFn();
  const port = config.port ?? 10100;
  const identity = await proxyIdentityAt(port, { hostname: config.hostname }, io);
  if (identity) {
    // /healthz is a liveness signal, not process authorization. Keep legacy
    // PID-less responses usable, but expose a kill target only after a fresh
    // command-line identity check of the exact candidate.
    const trusted = killablePid(identity.pid ?? pid, port);
    return {
      pid: trusted,
      port,
      hostname: config.hostname,
      source: "config",
    };
  }
  return null;
}
