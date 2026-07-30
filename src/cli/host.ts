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
  verifyAdminTokenAgainstProxy,
  type AdminTokenVerification,
  type HostStatus,
} from "../lib/host-control";
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
      "\nThe dashboard and /api/* ask for the ADMIN token (not the data-plane key):\n"
      + "  ocx host token\n"
      + "It is held in browser memory only, so each device (and each reload) asks\n"
      + "again. That is deliberate: a browser reached over the network is never\n"
      + "handed a session automatically. The data-plane key from --new-key is what\n"
      + "API clients (Codex, Claude Code) send with their model requests.",
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
  /** Injectable so the stale-token path is testable without a live proxy. */
  verifyAdminToken?: (token: string) => Promise<AdminTokenVerification>;
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
    // The management (/api/*, dashboard) credential — distinct from the data-plane
    // key on purpose: the server refuses a credential that plays both roles.
    const envToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
    const { loadAdminTokenFromFile, adminApiTokenFilePath } = await import("../lib/admin-secrets");
    const token = envToken || loadAdminTokenFromFile();
    if (!token) {
      console.error(
        "ocx host: no admin token exists yet — it is created the first time the proxy starts.\n"
        + `  Expected at: ${adminApiTokenFilePath()}`,
      );
      return 1;
    }
    // Where this token came from is NOT where the running proxy got its own.
    // A proxy started as a service, in a container, or from another shell with
    // OPENCODEX_ADMIN_AUTH_TOKEN set enforces a secret this process cannot read,
    // while the on-disk file it never consulted still parses fine — so printing
    // the file token alone would hand the user a credential the dashboard
    // rejects, with nothing on screen to explain why. Ask the live proxy.
    const verify = io.verifyAdminToken ?? verifyAdminTokenAgainstProxy;
    const verification = await verify(token);

    if (json) {
      console.log(JSON.stringify({
        adminToken: token,
        source: envToken ? "environment" : "file",
        // null, not false: "the proxy said no" and "nothing answered" are
        // different facts and a script must be able to tell them apart.
        verified: verification.state === "unverified" ? null : verification.state === "accepted",
        verification: verification.state,
        verificationDetail: verification.state === "unverified" ? verification.reason : verification.endpoint,
      }, null, 2));
      return 0;
    }

    console.error("⚠️  This token grants full management access to the proxy. Treat it like a password.");
    if (verification.state === "rejected") {
      console.error(
        `⚠️  The RUNNING proxy at ${verification.endpoint} REJECTED this token — it will not work.\n`
        + `  This token came from ${envToken ? "OPENCODEX_ADMIN_AUTH_TOKEN in this shell" : adminApiTokenFilePath()},\n`
        + "  but the proxy was started with a different OPENCODEX_ADMIN_AUTH_TOKEN (a service,\n"
        + "  a container, or another shell). Read the token from that environment, or restart\n"
        + "  the proxy without OPENCODEX_ADMIN_AUTH_TOKEN so it uses the file above.",
      );
    } else if (verification.state === "unverified") {
      console.error(`ℹ️  Not verified against a running proxy (${verification.reason}) — if one is started elsewhere with its own OPENCODEX_ADMIN_AUTH_TOKEN, this token will not work there.`);
    }
    // The bare token still goes to stdout in every case: scripts capture it,
    // and a warning on stderr is the honest way to flag a token that may not fit.
    console.log(token);
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
