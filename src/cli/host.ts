/**
 * `ocx host` — expose the proxy and its dashboard to other devices on the network.
 *
 * The server already supports this: binding to a non-loopback hostname flips
 * `isApiAuthRequired()`, which forces every `/api/*` and data-plane request to
 * carry a credential, and `assertServerAuthConfig()` refuses to start without
 * one. What was missing was a safe, discoverable way to turn it on — previously
 * you hand-edited `config.hostname` and hoped you had a key.
 *
 * The security posture this command preserves, deliberately:
 *
 * - **Off by default, and never enabled implicitly.** `enable` is the only path,
 *   it requires `--yes`, and it names what becomes reachable.
 * - **No credential, no exposure.** `enable` refuses unless a data-plane
 *   credential already exists or `--new-key` mints one. That mirrors the
 *   server-side assertion rather than duplicating a weaker version of it.
 * - **No session bootstrap over the network.** `issueGuiSession()` refuses any
 *   non-loopback Host, so a remote browser cannot be silently trusted — it gets
 *   a 401 and must paste the key, which the dashboard holds in memory only.
 *   That is intended, and `status` says so rather than treating it as a defect.
 * - **Plaintext once.** A generated key is printed exactly once, like
 *   `ocx access key create`.
 *
 * This binds to the local network. It does not open a firewall port, forward
 * anything, or expose the proxy to the internet, and it should not be pointed at
 * an untrusted network — anyone who reaches the port and holds the key can drive
 * the proxy and every provider account behind it.
 */

import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { loadConfig, saveConfig } from "../config";
import { isLoopbackHostname } from "../server/auth-cors";
import type { OcxConfig } from "../types";

const USAGE = "Usage: ocx host <status|enable|disable> [--hostname <addr>] [--new-key [name]] [--yes] [--json]";

/** Bind addresses that accept connections from other devices. */
const ALL_INTERFACES = new Set(["0.0.0.0", "::", "[::]"]);

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

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
}

export function describeHost(config: OcxConfig): HostStatus {
  const hostname = config.hostname ?? "127.0.0.1";
  const port = config.port;
  const exposed = !isLoopbackHostname(hostname);
  const hosts = ALL_INTERFACES.has(hostname) ? lanAddresses() : exposed ? [hostname] : [];
  return {
    hostname,
    port,
    exposed,
    credentialConfigured: hasDataPlaneCredential(config),
    urls: hosts.map(h => `http://${h}:${port}/`),
  };
}

function printStatus(status: HostStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`Bind address : ${status.hostname}:${status.port}`);
  console.log(`Reachable    : ${status.exposed ? "other devices on this network" : "this machine only (loopback)"}`);
  console.log(`Credential   : ${status.credentialConfigured ? "configured" : "NONE — an exposed bind will refuse to start"}`);
  if (status.urls.length) {
    console.log("\nOpen from another device:");
    for (const url of status.urls) console.log(`  ${url}`);
    console.log(
      "\nThe dashboard will ask for an API key on first load and keeps it in memory\n"
      + "only, so each device (and each reload) asks again. That is deliberate: a\n"
      + "browser reached over the network is never handed a session automatically.",
    );
  } else if (!status.exposed) {
    // Name the flag that will actually succeed: without a credential the plain
    // form refuses, and pointing at it would just produce a second error.
    console.log(
      status.credentialConfigured
        ? "\nEnable network access:  ocx host enable --yes"
        : "\nEnable network access:  ocx host enable --new-key --yes",
    );
  }
}

function mintKey(config: OcxConfig, name: string): string {
  const key = `ocx_${randomBytes(32).toString("base64url")}`;
  config.apiKeys = [
    ...(config.apiKeys ?? []),
    { id: randomBytes(8).toString("hex"), name, key, createdAt: new Date().toISOString() },
  ];
  return key;
}

export async function handleHostCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(
      `${USAGE}\n\n`
      + "Expose the proxy and dashboard to other devices on your network.\n\n"
      + "  status    Show the current bind address and the URLs other devices use.\n"
      + "  enable    Bind to the network. Requires --yes and a data-plane credential.\n"
      + "  disable   Return to loopback (this machine only).\n\n"
      + "  --hostname  Bind address for enable (default: 0.0.0.0, all interfaces).\n"
      + "  --new-key   Generate an API key and print it once.\n"
      + "  --yes       Confirm that the proxy becomes reachable by other devices.\n\n"
      + "Only use this on a network you trust. Anyone who can reach the port and\n"
      + "holds the key can drive the proxy and every provider account behind it.",
    );
    return 0;
  }

  const action = args[0];
  const json = args.includes("--json");
  const config = loadConfig();

  if (action === "status") {
    printStatus(describeHost(config), json);
    return 0;
  }

  if (action === "disable") {
    config.hostname = "127.0.0.1";
    saveConfig(config);
    if (json) console.log(JSON.stringify(describeHost(config), null, 2));
    else console.log("Bound to 127.0.0.1 — reachable from this machine only.\nRestart the proxy to apply:  ocx stop && ocx start");
    return 0;
  }

  if (action !== "enable") {
    console.error(`ocx host: unknown command "${action}".\n${USAGE}`);
    return 2;
  }

  const hostname = flagValue(args, "--hostname") ?? "0.0.0.0";
  if (isLoopbackHostname(hostname)) {
    console.error(`ocx host: "${hostname}" is a loopback address, which is not reachable by other devices.\n  To turn network access off instead:  ocx host disable`);
    return 2;
  }

  const wantsKey = args.includes("--new-key");
  let minted: string | null = null;
  if (wantsKey) {
    const nameIndex = args.indexOf("--new-key") + 1;
    const candidate = args[nameIndex];
    minted = mintKey(config, candidate && !candidate.startsWith("--") ? candidate : "network");
  }

  // Mirror assertServerAuthConfig: refuse here with an actionable message rather
  // than writing a config that makes the next `ocx start` throw.
  if (!hasDataPlaneCredential(config)) {
    console.error(
      "ocx host: an exposed bind requires a data-plane credential, and none is configured.\n"
      + "  Generate one now:   ocx host enable --new-key --yes\n"
      + "  Or set one:         OPENCODEX_API_AUTH_TOKEN, or ocx access key create",
    );
    return 2;
  }

  if (!args.includes("--yes")) {
    const targets = ALL_INTERFACES.has(hostname) ? lanAddresses() : [hostname];
    console.error(
      `ocx host: this makes the proxy reachable at ${hostname}:${config.port}`
      + `${targets.length ? ` (${targets.join(", ")})` : ""}.\n`
      + "  Anyone on this network who has the API key can drive the proxy and every\n"
      + "  provider account behind it. Only do this on a network you trust.\n"
      + "  Re-run with --yes to confirm.",
    );
    return 2;
  }

  config.hostname = hostname;
  saveConfig(config);

  const status = describeHost(config);
  if (json) {
    console.log(JSON.stringify({ ...status, generatedKey: minted }, null, 2));
    return 0;
  }
  if (minted) console.log(`Created API key "network" (shown once): ${minted}\n`);
  printStatus(status, false);
  console.log("\nRestart the proxy to apply:  ocx stop && ocx start");
  return 0;
}
