/**
 * `ocx host` — expose the proxy and its dashboard to other devices on the network.
 *
 * The server already supports this: binding to a non-loopback hostname flips
 * `isApiAuthRequired()`, which forces data-plane requests to carry a credential,
 * and `assertServerAuthConfig()` refuses to start without
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
 * - **Management is open by design.** `/api/*` no longer has an admin-token gate;
 *   use an external authenticated boundary before exposing a non-loopback proxy.
 * - **Plaintext once.** A generated key is printed exactly once, like
 *   `ocx access key create`.
 *
 * This binds to the local network. It does not open a firewall port, forward
 * anything, or expose the proxy to the internet, and it should not be pointed at
 * an untrusted network — anyone who reaches the port and holds the key can drive
 * the proxy and every provider account behind it.
 */

import { loadConfig, saveConfig } from "../config";
import { printSubcommandUsage } from "./help";
import { isLoopbackHostname } from "../server/auth-cors";
import {
  ALL_INTERFACES,
  addCustomDataPlaneKey,
  describeHost,
  hasDataPlaneCredential,
  lanAddresses,
  mintDataPlaneKey,
  type HostStatus,
} from "../lib/host-control";
import { DEBUG_SANDBOX_ENV, debugSandboxEnabled } from "../lib/debug-sandbox";
import type { OcxConfig } from "../types";

// Re-exported so existing importers (tests/cli-host.test.ts) keep their path.
export { describeHost, hasDataPlaneCredential, lanAddresses } from "../lib/host-control";

/**
 * Short form for the unknown-subcommand error only. The FULL help lives in
 * `helpEntries.host` (src/cli/help.ts) and nowhere else: cli/index.ts
 * short-circuits any argv carrying a help flag straight into
 * `printSubcommandUsage(command)`, so a second help text maintained here could
 * never be reached by `ocx host --help` and would silently rot. `ocx host` with
 * no arguments therefore delegates to the same entry rather than duplicating it.
 */
const USAGE = "Usage: ocx host <status|enable|disable|token> [--hostname <addr>] [--new-key [name]] [--key <value>] [--yes] [--json]";

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
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
      "\nThe dashboard and /api/* no longer require an ADMIN token.\n"
      + "The data-plane key from --new-key is still required by model API clients\n"
      + "when this proxy is reachable from other devices. Put remote management\n"
      + "behind an external authenticated boundary.",
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

export interface HostCommandIo {
  /** Kept for compatibility with callers of the former token command. */
  verifyAdminToken?: (token: string) => Promise<unknown>;
}

export async function handleHostCommand(args: string[], io: HostCommandIo = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printSubcommandUsage("host");
    return 0;
  }

  const action = args[0];
  const json = args.includes("--json");
  const config = loadConfig();

  if (action === "status") {
    if (args.slice(1).some(arg => arg.startsWith("--") && arg !== "--json")) {
      console.error("ocx host: status accepts only --json.");
      return 2;
    }
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

  if (action === "token") {
    if (json) {
      console.log(JSON.stringify({ adminTokenGate: false, managementApi: "open" }, null, 2));
    } else {
      console.log("The admin-token gate is disabled permanently; /api/* needs no ADMIN token.");
    }
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
  const customValue = flagValue(args, "--key");
  let minted: string | null = null;
  if (customValue !== undefined) {
    const result = addCustomDataPlaneKey(config, "custom", customValue ?? "");
    if ("error" in result) {
      console.error(`ocx host: ${result.error}
  Custom keys are stored in plaintext in config.json — never reuse a real password.`);
      return 2;
    }
    minted = result.key;
  } else if (wantsKey) {
    // The debug sandbox issues no credentials, so say so and stop rather than
    // letting `mintDataPlaneKey` throw its backstop as an unhandled crash. There
    // is nothing useful this could do instead: a key it minted would not be
    // written, so the very next command would not see it.
    if (debugSandboxEnabled()) {
      console.error(
        `ocx host: ${DEBUG_SANDBOX_ENV} is set, so no data-plane key will be minted and no\n`
        + "  config will be written. Unset it and run this again to make a real change.",
      );
      return 2;
    }
    const nameIndex = args.indexOf("--new-key") + 1;
    const candidate = args[nameIndex];
    minted = mintDataPlaneKey(config, candidate && !candidate.startsWith("--") ? candidate : "network");
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
