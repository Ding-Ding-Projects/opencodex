/**
 * `ocx codex [codex args...]` — launch Codex through the local proxy.
 *
 * Codex normally needs no launch-time environment shim because `ocx start`
 * writes its provider configuration. This command still earns its keep as the
 * plug-and-play path promised by the README: it starts the proxy when needed,
 * refreshes that configuration against the live port, resolves the real Codex
 * runtime, and forwards every remaining argument with inherited stdio.
 */
import { spawn } from "node:child_process";
import { codexExecInvocation } from "../codex/exec-invocation";
import { resolveAndPersistCodexRuntime } from "../codex/runtime";
import { syncModelsToCodex } from "../codex/sync";
import { findLiveProxy } from "../server/proxy-liveness";

export interface CodexCliDeps {
  findLiveProxy?: typeof findLiveProxy;
  syncModelsToCodex?: typeof syncModelsToCodex;
  resolveRuntime?: typeof resolveAndPersistCodexRuntime;
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  startupTimeoutMs?: number;
  execPath?: string;
  cliPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const CODEX_INSTALL_HINT = "❌ Codex CLI not found. Install Codex, then run `ocx doctor` to select its runtime.";
const PROXY_START_TIMEOUT_MS = 35_000;

export function codexNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? CODEX_INSTALL_HINT : null;
}

/** Start the proxy on the configured port when no healthy owned instance exists. */
export async function ensureProxyForCodex(deps: CodexCliDeps = {}): Promise<number | null> {
  const findLive = deps.findLiveProxy ?? findLiveProxy;
  const live = await findLive();
  if (live) return live.port;

  const spawnFn = deps.spawn ?? spawn;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnFn(
      deps.execPath ?? process.execPath,
      // Use the normal soft-start path: it prefers config.port but can hop to a
      // free port instead of spending 30 seconds pinned behind a foreign listener.
      [deps.cliPath ?? process.argv[1]!, "start"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...(deps.env ?? process.env), OCX_SERVICE: "1" },
      },
    );
  } catch {
    return null;
  }

  let startupFailed = false;
  child.once("error", () => { startupFailed = true; });
  child.once("exit", () => { startupFailed = true; });
  child.unref();

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.startupTimeoutMs ?? PROXY_START_TIMEOUT_MS);
  while (now() < deadline) {
    const started = await findLive();
    if (started) {
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      return started.port;
    }
    if (startupFailed) return null;
    await sleep(Math.min(250, Math.max(0, deadline - now())));
  }

  // One final probe closes the boundary race. If startup still has not won,
  // terminate the child we own so it cannot appear after we reported failure.
  const started = await findLive();
  if (started) {
    child.removeAllListeners("error");
    child.removeAllListeners("exit");
    return started.port;
  }
  if (!startupFailed) {
    try { child.kill(); } catch { /* best effort; the child is detached and unref'd */ }
  }
  return null;
}

export async function cmdCodex(args: string[], deps: CodexCliDeps = {}): Promise<number> {
  const port = await ensureProxyForCodex(deps);
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }

  try {
    const synced = await (deps.syncModelsToCodex ?? syncModelsToCodex)(port);
    if (!synced.ok) {
      console.error("❌ Codex configuration could not be pointed at the running proxy.");
      return 1;
    }
  } catch (error) {
    console.error(`❌ Codex configuration sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const platform = deps.platform ?? process.platform;
  const runtime = (deps.resolveRuntime ?? resolveAndPersistCodexRuntime)({
    env: deps.env ?? process.env,
    platform,
    discoverAlternatives: false,
  }).runtime;
  const invocation = codexExecInvocation(runtime.command, args, platform);
  const spawnFn = deps.spawn ?? spawn;

  return await new Promise<number>(resolve => {
    const child = spawnFn(invocation.file, invocation.args, {
      stdio: "inherit",
      env: deps.env ?? process.env,
      ...invocation.options,
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") console.error(CODEX_INSTALL_HINT);
      else console.error(`❌ Failed to launch Codex: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = codexNotFoundHint(code, signal, platform);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}
