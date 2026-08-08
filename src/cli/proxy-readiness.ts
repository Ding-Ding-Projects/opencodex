import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";

export interface ProxyReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Continuous identity-health window required before startup is reported. */
  stabilityMs?: number;
  /** Direct launches know their child PID and must not adopt a racing proxy. */
  expectedPid?: number;
  findLive?: () => Promise<LiveProxy | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Keep the stability check short relative to the overall deadline, while giving
 * longer-lived service-manager starts more time to expose an immediate crash loop.
 */
export function defaultProxyReadinessStabilityMs(timeoutMs: number, intervalMs: number): number {
  return Math.min(1_500, Math.max(intervalMs, Math.trunc(timeoutMs / 20)));
}

function sameProxyIdentity(left: LiveProxy, right: LiveProxy): boolean {
  return left.pid === right.pid
    && left.port === right.port
    && (left.hostname ?? "") === (right.hostname ?? "");
}

/** Wait for stable identity-verified health, optionally requiring one exact child PID. */
export async function waitForProxyIdentity(
  options: ProxyReadinessOptions = {},
): Promise<LiveProxy | null> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 8_000);
  const intervalMs = Math.max(1, options.intervalMs ?? 150);
  const stabilityMs = Math.max(
    0,
    options.stabilityMs ?? defaultProxyReadinessStabilityMs(timeoutMs, intervalMs),
  );
  const findLive = options.findLive ?? findLiveProxy;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let candidate: LiveProxy | null = null;
  let stableSince = 0;

  while (now() < deadline) {
    const live = await findLive();
    const sampledAt = now();
    if (sampledAt >= deadline) return null;
    if (live && (options.expectedPid === undefined || live.pid === options.expectedPid)) {
      if (!candidate || !sameProxyIdentity(candidate, live)) {
        candidate = live;
        stableSince = sampledAt;
      } else if (sampledAt - stableSince >= stabilityMs) {
        return live;
      }
      if (stabilityMs === 0) return live;
    } else {
      candidate = null;
      stableSince = 0;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    await sleep(Math.min(intervalMs, remaining));
  }
  return null;
}
