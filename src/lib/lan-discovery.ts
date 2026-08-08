/**
 * Finding an opencodex proxy already running on this network.
 *
 * The onboarding wizard offers to connect to an existing install rather than
 * make the user type an IP they would have to go and look up. There is no mDNS
 * here: adding a multicast responder means shipping a service advertisement
 * that runs whether or not anyone wants it, and the thing being looked for is a
 * single well-known port answering a health check. A bounded sweep of the local
 * /24 answers the same question without advertising anything.
 *
 * ## What this deliberately does not do
 *
 * - **It is never automatic.** The sweep runs only when a user asks for it. A
 *   background subnet scan is indistinguishable from the thing security tools
 *   are built to catch, and an app that quietly probes 254 hosts on a corporate
 *   network has earned the alert it triggers.
 * - **It probes one port and one path.** `GET /healthz` on the configured proxy
 *   port. No port range, no service fingerprinting, nothing that would make
 *   this useful for mapping a network someone else owns.
 * - **It only sweeps subnets this machine is already on.** The candidate list
 *   comes from the host's own IPv4 interfaces, so an arbitrary CIDR cannot be
 *   handed in from a request.
 * - **It is bounded.** A short per-host timeout, a hard concurrency cap, and a
 *   whole-sweep deadline, so a slow network cannot hold the event loop or the
 *   request open indefinitely.
 */

import { networkInterfaces } from "node:os";

/** Per-host connect timeout. A proxy on the LAN answers in single-digit ms. */
const PROBE_TIMEOUT_MS = 400;
/** Concurrent probes. High enough to sweep a /24 quickly, low enough to be polite. */
const CONCURRENCY = 32;
/** Hard ceiling for the whole sweep, whatever the network is doing. */
const SWEEP_DEADLINE_MS = 6000;

export interface DiscoveredProxy {
  /** `http://host:port` — what a client would point at. */
  url: string;
  host: string;
  port: number;
  /** Reported by /healthz when it answers with one. */
  version?: string;
  /** True when this is the machine running the sweep. */
  self: boolean;
}

/** The /24 networks this host sits on, as `a.b.c` prefixes. */
export function localSubnets(): { prefix: string; own: string }[] {
  const nets: { prefix: string; own: string }[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      // Only a /24 or narrower is swept. A /16 is 65k hosts — that is not a
      // discovery sweep, it is a port scan, and it would never finish inside
      // the deadline anyway.
      if (entry.netmask !== "255.255.255.0") continue;
      const prefix = entry.address.split(".").slice(0, 3).join(".");
      if (!nets.some(n => n.prefix === prefix)) nets.push({ prefix, own: entry.address });
    }
  }
  return nets;
}

interface ProbeDeps {
  /** Injected in tests; defaults to a real fetch with a timeout. */
  probe?: (url: string, signal: AbortSignal) => Promise<Response>;
  now?: () => number;
}

async function probeHost(
  host: string,
  port: number,
  own: Set<string>,
  deps: ProbeDeps,
): Promise<DiscoveredProxy | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const url = `http://${host}:${port}`;
  try {
    const doProbe = deps.probe ?? ((u, signal) => fetch(`${u}/healthz`, { signal }));
    const res = await doProbe(url, controller.signal);
    if (!res.ok) return null;
    // A 200 from any old service is not a match — the body has to look like
    // ours, or every web server on the subnet reports as an opencodex proxy.
    const body = await res.json().catch(() => null) as { status?: unknown; version?: unknown } | null;
    if (!body || typeof body.status !== "string") return null;
    return {
      url,
      host,
      port,
      version: typeof body.version === "string" ? body.version : undefined,
      self: own.has(host),
    };
  } catch {
    // Unreachable, refused, timed out, or not JSON. All the same answer: no.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sweep the local /24s for a proxy answering on `port`.
 *
 * Returns what answered, self included and flagged — the wizard shows "this
 * machine" differently from a peer, and hiding it would make the local install
 * look undiscoverable.
 */
export async function discoverProxies(port: number, deps: ProbeDeps = {}): Promise<DiscoveredProxy[]> {
  const now = deps.now ?? Date.now;
  const subnets = localSubnets();
  if (subnets.length === 0) return [];

  const own = new Set(subnets.map(s => s.own));
  const targets: string[] = [];
  for (const { prefix } of subnets) {
    // .0 is the network address and .255 the broadcast; neither is a host.
    for (let i = 1; i <= 254; i++) targets.push(`${prefix}.${i}`);
  }

  const deadline = now() + SWEEP_DEADLINE_MS;
  const found: DiscoveredProxy[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length && now() < deadline) {
      const host = targets[cursor++];
      const hit = await probeHost(host, port, own, deps);
      if (hit) found.push(hit);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  // Self first, then by address, so the list is stable between sweeps.
  return found.sort((a, b) => (Number(b.self) - Number(a.self)) || a.host.localeCompare(b.host));
}
