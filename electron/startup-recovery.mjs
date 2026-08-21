/**
 * Testable policy and process boundary for the desktop shell's startup recovery.
 *
 * The Electron entrypoint must not guess from one configured port, kill a listener
 * it cannot prove it owns, or ask the renderer to provide a command. This module
 * keeps those decisions pure where possible and keeps the one native restore
 * operation bounded and fixed.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { planProxyAdoption } from "./proxy-adoption.mjs";

export const DEFAULT_DESKTOP_PORT = 10100;
export const NATIVE_RESTORE_TIMEOUT_MS = 20_000;

/**
 * The desktop shell is a local client. Bind-any values are probed through
 * loopback; configured LAN/public hostnames are not fetched by startup.
 */
export function normalizeDesktopProbeHostname(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw || raw === "localhost" || raw === "127.0.0.1" || raw === "[::1]" || raw === "::1"
    || raw === "0.0.0.0" || raw === "::" || raw === "[::]") return "127.0.0.1";
  return undefined;
}

/** Return a TCP port only when the input is an integer in 1..65535. */
export function parseDesktopPort(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function configDirFor(env, home) {
  const raw = typeof env.OPENCODEX_HOME === "string" ? env.OPENCODEX_HOME.trim() : "";
  if (!raw) return join(home, ".opencodex");
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(raw);
}

function readJson(readFile, path) {
  try {
    return JSON.parse(readFile(path));
  } catch {
    return null;
  }
}

function validRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pid = value.pid;
  const port = parseDesktopPort(value.port);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !port) return null;
  if (value.hostname !== undefined && typeof value.hostname !== "string") return null;
  if (value.supervised !== undefined && typeof value.supervised !== "boolean") return null;
  return {
    pid,
    port,
    ...(value.hostname === undefined ? {} : { hostname: value.hostname }),
    ...(value.supervised === undefined ? {} : { supervised: value.supervised }),
  };
}

/**
 * Read every persisted desktop endpoint candidate. Invalid state is ignored,
 * never repaired or overwritten by the shell.
 */
export function readDesktopPortState({
  env = process.env,
  home = homedir(),
  readFile = path => readFileSync(path, "utf8"),
  defaultPort = DEFAULT_DESKTOP_PORT,
} = {}) {
  const dir = configDirFor(env, home);
  const runtime = validRuntime(readJson(readFile, join(dir, "runtime-port.json")));
  const config = readJson(readFile, join(dir, "config.json"));
  const configuredPort = parseDesktopPort(config?.port);
  const configuredHostname = normalizeDesktopProbeHostname(config?.hostname);
  const fallback = parseDesktopPort(defaultPort) ?? DEFAULT_DESKTOP_PORT;
  const hardPin = parseDesktopPort(env.OPENCODEX_PORT);
  const candidates = [];
  for (const port of [hardPin, runtime?.port, configuredPort, fallback]) {
    if (port !== undefined && !candidates.includes(port)) candidates.push(port);
  }
  return {
    configDir: dir,
    runtime,
    configuredPort,
    configuredHostname,
    hardPin,
    candidates,
  };
}

/** Classify one health response without treating a foreign service as ours. */
export function classifyDesktopHealth(health, stamp) {
  if (!health || typeof health !== "object") return { action: "spawn" };
  if (health.service === "opencodex") return planProxyAdoption(health, stamp);
  // A legacy health body that looks like an OpenCodex response but has no build
  // stamp is an ownership question, not permission to replace a listener.
  if (health.service === undefined && health.status === "ok"
    && typeof health.version === "string" && typeof health.uptime === "number") {
    return { action: "uncertain", pid: typeof health.pid === "number" ? health.pid : null };
  }
  return { action: "foreign" };
}

/**
 * Decide the next startup step. No result contains a stop/kill action: a healthy
 * listener not proven to be this build remains untouched.
 */
export function planDesktopStartup({ candidates, hardPin, healthByPort, stamp }) {
  let occupiedPort;
  for (const port of candidates) {
    const health = healthByPort instanceof Map ? healthByPort.get(port) : healthByPort?.[port];
    const plan = classifyDesktopHealth(health ?? null, stamp);
    if (plan.action === "adopt") {
      return { action: "adopt", port, pid: plan.pid ?? null, needsRestore: false };
    }
    if (health) occupiedPort ??= port;
    if (hardPin === port && (plan.action === "conflict" || plan.action === "uncertain" || plan.action === "foreign")) {
      return {
        action: "blocked",
        reason: `Port ${port} is occupied by a listener whose ownership cannot be verified; it was left untouched.`,
      };
    }
  }
  return { action: "restore-and-spawn", pinnedPort: hardPin, occupiedPort, needsRestore: true };
}

/**
 * Invoke exactly `ocx restore` through the packaged launcher. The caller supplies
 * only executable and launcher paths; no renderer value becomes argv, cwd, or env.
 */
export function runFixedNativeRestore({
  execPath,
  launcherPath,
  cwd,
  env = process.env,
  spawnFn = nodeSpawn,
  timeoutMs = NATIVE_RESTORE_TIMEOUT_MS,
} = {}) {
  return new Promise(resolveResult => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    if (typeof execPath !== "string" || !execPath || typeof launcherPath !== "string" || !launcherPath) {
      finish({ ok: false, error: "Native Codex restore is unavailable: the fixed launcher is missing." });
      return;
    }
    let child;
    try {
      child = spawnFn(execPath, [launcherPath, "restore"], {
        cwd: typeof cwd === "string" && cwd ? cwd : undefined,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish({ ok: false, error: "Native Codex restore could not start." });
      return;
    }
    child.once("error", () => finish({ ok: false, error: "Native Codex restore could not start." }));
    child.once("close", code => {
      if (code === 0) {
        finish({ ok: true, message: "Native Codex routing restored." });
      } else {
        finish({ ok: false, error: code === null
          ? "Native Codex restore stopped before completing."
          : `Native Codex restore failed with exit code ${code}.` });
      }
    });
    timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* only our restore child is terminated */ }
      finish({ ok: false, error: `Native Codex restore exceeded the ${timeoutMs}ms safety bound.` });
    }, timeoutMs);
    timer.unref?.();
  });
}

export function desktopLauncherPath(root) {
  return join(root, "bin", "ocx.mjs");
}

export function desktopRootFromElectronDir(electronDir) {
  return join(electronDir, "..");
}

export function launcherExists(path) {
  return existsSync(path);
}
