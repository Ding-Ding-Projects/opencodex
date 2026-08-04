/**
 * Shared logic behind `ocx host` (CLI) and `/api/host` (dashboard): one
 * implementation of the bind/credential rules so the two surfaces cannot
 * disagree about what "exposed" means or when enabling is allowed.
 *
 * The rules themselves live in the server (`assertServerAuthConfig` refuses a
 * non-loopback bind without a data-plane credential); everything here mirrors
 * them for *pre-flight* honesty — refusing early with an actionable message
 * instead of writing a config that kills the next start.
 */

import { randomBytes } from "node:crypto";

import { debugSandboxEnabled, sandboxExposedPreview } from "./debug-sandbox";
import { networkInterfaces } from "node:os";
import { isLoopbackHostname } from "../server/auth-cors";
import type { OcxConfig } from "../types";

/** Bind addresses that accept connections from other devices. */
export const ALL_INTERFACES = new Set(["0.0.0.0", "::", "[::]"]);

/** Non-internal IPv4 addresses this machine answers on. */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found.sort();
}

export function hasDataPlaneCredential(config: OcxConfig): boolean {
  if (process.env.OPENCODEX_API_AUTH_TOKEN?.trim()) return true;
  return (config.apiKeys ?? []).some(entry => !!entry.key.trim());
}

export interface HostStatus {
  hostname: string;
  port: number;
  /** True when the bind address accepts connections from other devices. */
  exposed: boolean;
  /** True when a data-plane credential exists — required for any exposed bind. */
  credentialConfigured: boolean;
  /** URLs another device should use. Empty when bound to loopback. */
  urls: string[];
  /**
   * True when this process runs with `OPENCODEX_DEBUG_SANDBOX` set.
   *
   * Reported so the dashboard can say so. Without it the sandbox is invisible
   * from the UI and simply looks broken: every toggle springs back on reload and
   * pairing refuses a code that is plainly on screen, which reads as data loss
   * rather than as the mode the user asked for.
   */
  debugSandbox: boolean;
}

export function describeHost(config: OcxConfig): HostStatus {
  // In the sandbox the "enabled" state is a display fiction: the config was never
  // changed, so the auth posture and the socket are both untouched, and only this
  // read pretends otherwise. See `exposedPreview` in `debug-sandbox.ts` for why
  // the obvious alternative — mutating `config.hostname` — made the running
  // process reject every credential it had.
  const preview = debugSandboxEnabled() ? sandboxExposedPreview() : null;
  const hostname = preview ?? config.hostname ?? "127.0.0.1";
  const port = config.port;
  const exposed = !isLoopbackHostname(hostname);
  const hosts = ALL_INTERFACES.has(hostname) ? lanAddresses() : exposed ? [hostname] : [];
  return {
    hostname,
    port,
    exposed,
    credentialConfigured: hasDataPlaneCredential(config),
    urls: hosts.map(h => `http://${h}:${port}/`),
    debugSandbox: debugSandboxEnabled(),
  };
}

/**
 * Mint a data-plane API key onto the config (caller persists). The plaintext
 * is returned exactly once and must never be logged or echoed by later reads.
 */
/**
 * Thrown when something tries to mint a credential inside the debug sandbox.
 *
 * A backstop, not the mechanism: every caller below is expected to check
 * `debugSandboxEnabled()` and do something sensible instead. This exists so that
 * a caller added later cannot quietly reintroduce credential minting into a mode
 * whose whole promise is that it issues none — the failure is loud rather than a
 * live key nobody expected.
 */
export class DebugSandboxMintError extends Error {
  constructor() {
    super("refusing to mint a data-plane key: OPENCODEX_DEBUG_SANDBOX is set");
    this.name = "DebugSandboxMintError";
  }
}

export function mintDataPlaneKey(config: OcxConfig, name: string): string {
  if (debugSandboxEnabled()) throw new DebugSandboxMintError();
  const key = `ocx_${randomBytes(32).toString("base64url")}`;
  config.apiKeys = [
    ...(config.apiKeys ?? []),
    { id: randomBytes(8).toString("hex"), name, key, createdAt: new Date().toISOString() },
  ];
  return key;
}

/** Floor for user-chosen keys. Deliberately above "favourite word" territory. */
export const CUSTOM_KEY_MIN_LENGTH = 12;

/**
 * Store a USER-CHOSEN key value. Returns an error string instead of storing
 * when the value is unusable.
 *
 * Custom keys exist because typing a memorable token on a phone beats
 * transcribing 43 characters of base64 — but they are stored in PLAINTEXT in
 * config.json and ride along in `ocx export`, so every surface that offers
 * this must say: never reuse a password from anywhere else. Enforced here:
 * a length floor and no whitespace. Strength beyond that is the user's call,
 * made after an explicit warning.
 */
export function addCustomDataPlaneKey(config: OcxConfig, name: string, value: string): { key: string } | { error: string } {
  const key = value.trim();
  if (key.length < CUSTOM_KEY_MIN_LENGTH) {
    return { error: `custom key must be at least ${CUSTOM_KEY_MIN_LENGTH} characters` };
  }
  if (/\s/.test(key)) {
    return { error: "custom key must not contain whitespace" };
  }
  if ((config.apiKeys ?? []).some(entry => entry.key === key)) {
    return { error: "a key with this exact value already exists" };
  }
  config.apiKeys = [
    ...(config.apiKeys ?? []),
    { id: randomBytes(8).toString("hex"), name, key, createdAt: new Date().toISOString() },
  ];
  return { key };
}
