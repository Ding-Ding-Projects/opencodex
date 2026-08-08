import { isIP } from "node:net";

import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import { configuredAdminToken } from "../lib/admin-secrets";
import {
  ALL_INTERFACES,
  describeHost,
  hasDataPlaneCredential,
  lanAddresses,
  mintDataPlaneKey,
  type HostStatus,
} from "../lib/host-control";
import {
  DEBUG_SANDBOX_ENV,
  debugSandboxEnabled,
  setSandboxExposedPreview,
} from "../lib/debug-sandbox";
import { isLoopbackHostname } from "../server/auth-cors";
import { findLiveProxy } from "../server/proxy-liveness";
import { printSubcommandUsage } from "./help";

export { describeHost, hasDataPlaneCredential, lanAddresses } from "../lib/host-control";

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function validateHostArgs(args: string[]): string | null {
  if ((args[0] === "status" || args[0] === "disable") && args.slice(1).some(arg => arg !== "--json")) {
    return `${args[0]} accepts only --json`;
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hostname") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return "--hostname requires a bind address";
      index += 1;
      continue;
    }
    if (arg === "--new-key") {
      if (args[index + 1] && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    if (arg === "--yes" || arg === "--json") continue;
    if (arg.startsWith("--")) {
      return `${arg} is not supported; credentials, including the ADMIN token, must never be passed in argv`;
    }
    return `unexpected argument at position ${index + 1}`;
  }
  return null;
}

function validBindHostname(value: string): boolean {
  if (!value || value !== value.trim() || /[\s\\/?#@]/.test(value)) return false;
  const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (isIP(unwrapped) !== 0) return true;
  if (/^\d+(?:\.\d+){3}$/.test(value) || value.length > 253) return false;
  return value.split(".").every(label =>
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function validKeyName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value) && !/^ocx_/i.test(value);
}

function printStatus(status: HostStatus, json: boolean): void {
  const managementCredentialConfigured = configuredAdminToken() !== null;
  if (json) {
    console.log(JSON.stringify({ ...status, managementCredentialConfigured }, null, 2));
    return;
  }
  console.log(`Bind address : ${status.hostname}:${status.port}`);
  console.log(`Reachable    : ${status.exposed ? "other devices on this network" : "this machine only (loopback)"}`);
  console.log(`Data plane  : ${status.credentialConfigured ? "credential configured" : "NONE — an exposed bind will refuse to start"}`);
  console.log(`Dashboard   : ${managementCredentialConfigured ? "ADMIN credential configured" : "ADMIN credential is created when the proxy starts"}`);
  if (status.urls.length > 0) {
    console.log("\nOpen from another trusted device:");
    for (const url of status.urls) console.log(`  ${url}`);
    console.log("\nThe remote dashboard prompts for this proxy's ADMIN token. Direct HTTP is unencrypted; prefer an SSH tunnel outside a trusted LAN.");
  } else {
    console.log(status.credentialConfigured
      ? "\nEnable trusted-LAN access:  ocx host enable --yes"
      : "\nEnable trusted-LAN access:  ocx host enable --new-key --yes");
  }
}

export async function handleHostCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printSubcommandUsage("host");
    return 0;
  }

  const action = args[0];
  const json = args.includes("--json");
  const argError = validateHostArgs(args);
  if (argError) {
    console.error(`ocx host: ${argError}. Try 'ocx host --help'.`);
    return 2;
  }
  const config = loadConfig();
  if (action === "status") {
    const live = await findLiveProxy();
    // A configured port is only a preference for automatic starts. When it was
    // busy, advertise the identity-verified listener a remote device can reach.
    printStatus(describeHost(config, live ? {
      port: live.port,
      ...(live.hostname ? { hostname: live.hostname } : {}),
    } : undefined), json);
    return 0;
  }
  if (action === "disable") {
    if (debugSandboxEnabled()) setSandboxExposedPreview(null);
    else {
      config.hostname = "127.0.0.1";
      saveConfigPreservingClaudeCode(config);
    }
    if (json) console.log(JSON.stringify({ ...describeHost(config), restartRequired: !debugSandboxEnabled() }, null, 2));
    else console.log(debugSandboxEnabled()
      ? `${DEBUG_SANDBOX_ENV} is set; the preview is loopback-only and no config was written.`
      : "Bound to 127.0.0.1 — reachable from this machine only. Restart the proxy to apply.");
    return 0;
  }
  if (action !== "enable") {
    console.error(`ocx host: unknown command "${action}". Try 'ocx host --help'.`);
    return 2;
  }

  const hostname = flagValue(args, "--hostname") ?? "0.0.0.0";
  if (!validBindHostname(hostname)) {
    console.error("ocx host: --hostname must be an IPv4 address, IPv6 address, or DNS hostname without a scheme, path, credentials, or port.");
    return 2;
  }
  if (isLoopbackHostname(hostname)) {
    console.error(`ocx host: "${hostname}" is loopback-only. Use 'ocx host disable' to turn network access off.`);
    return 2;
  }
  if (!args.includes("--yes")) {
    const targets = ALL_INTERFACES.has(hostname) ? lanAddresses() : [hostname];
    console.error(
      `ocx host: this makes the proxy reachable at ${hostname}:${config.port}`
      + `${targets.length ? ` (${targets.join(", ")})` : ""}.\n`
      + "The remote dashboard still requires that proxy's ADMIN token; never pass it in argv.\n"
      + "Only use direct HTTP on a trusted LAN. Re-run with --yes to confirm.",
    );
    return 2;
  }

  const wantsKey = args.includes("--new-key");
  if (wantsKey && debugSandboxEnabled()) {
    console.error(`${DEBUG_SANDBOX_ENV} is set, so no data-plane key or config will be created.`);
    return 2;
  }
  let minted: string | null = null;
  let mintedName: string | null = null;
  if (wantsKey) {
    const index = args.indexOf("--new-key");
    const candidate = args[index + 1];
    mintedName = candidate && !candidate.startsWith("--") ? candidate : "network";
    if (!validKeyName(mintedName)) {
      console.error("ocx host: --new-key accepts only a short label (letters, digits, '.', '_' or '-'), never a credential value.");
      return 2;
    }
    minted = mintDataPlaneKey(config, mintedName);
  }
  if (!hasDataPlaneCredential(config) && !debugSandboxEnabled()) {
    console.error("ocx host: an exposed bind requires a data-plane credential. Use --new-key or create an access key first.");
    return 2;
  }

  if (debugSandboxEnabled()) setSandboxExposedPreview(hostname);
  else {
    config.hostname = hostname;
    saveConfigPreservingClaudeCode(config);
  }
  if (json) {
    console.log(JSON.stringify({ ...describeHost(config), generatedKey: minted, generatedKeyName: mintedName, restartRequired: true }, null, 2));
    return 0;
  }
  if (minted && mintedName) console.log(`Created data-plane key ${JSON.stringify(mintedName)} (shown once): ${minted}\n`);
  printStatus(describeHost(config), false);
  console.log(debugSandboxEnabled()
    ? `\n${DEBUG_SANDBOX_ENV} is set; this is display-only and no config was written.`
    : "\nRestart the proxy to apply:  ocx restart");
  return 0;
}
