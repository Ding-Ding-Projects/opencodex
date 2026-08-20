/**
 * `ocx codex [codex args...]` — start/adopt the proxy and launch Codex through it.
 *
 * This command is deliberately a transparent launcher.  The proxy lifecycle and
 * Codex configuration are prepared before the native process is created, and the
 * tail argv is passed to the selected, probed Codex runtime byte-for-byte.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { loadConfig } from "../config";
import { codexExecInvocation, isSpawnableCodexCandidate } from "../codex/exec-invocation";
import { resolveAndPersistCodexRuntime, type ResolveCodexRuntimeResult } from "../codex/runtime";
import { syncModelsToCodex, type CodexSyncResult } from "../codex/sync";
import { directProxyEnv, proxyStartArgv } from "../lib/proxy-launch";
import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";
import { waitForProxyIdentity } from "./proxy-readiness";

const CODEX_INSTALL_HINT = "❌ `codex` CLI not found. Install it first: npm install -g @openai/codex";

/** Injectable seams keep the launch ordering and failure gates unit-testable. */
export interface CodexLaunchDeps {
  loadConfig?: typeof loadConfig;
  findLiveProxy?: typeof findLiveProxy;
  waitForProxyIdentity?: typeof waitForProxyIdentity;
  spawn?: typeof spawn;
  syncModelsToCodex?: typeof syncModelsToCodex;
  resolveCodexRuntime?: () => ResolveCodexRuntimeResult;
  codexExecInvocation?: typeof codexExecInvocation;
  isSpawnableCodexCandidate?: typeof isSpawnableCodexCandidate;
  platform?: NodeJS.Platform;
  /** The process object is injectable only for signal/exit tests. */
  process?: Pick<NodeJS.Process, "on" | "removeListener" | "kill" | "exitCode">;
}

type ForwardableSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

const SIGNAL_EXIT_CODES: Record<ForwardableSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

function signalList(platform: NodeJS.Platform): ForwardableSignal[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * cmd.exe reports command-not-found as exit 9009 for a `.cmd` shim.  A signal
 * exit is intentionally not described as an installation failure.
 */
export function codexNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? CODEX_INSTALL_HINT : null;
}

async function ensureProxyForCodex(
  deps: Required<Pick<CodexLaunchDeps, "findLiveProxy" | "waitForProxyIdentity" | "spawn">>,
): Promise<LiveProxy | null> {
  const live = await deps.findLiveProxy();
  if (live) return live;

  const child = deps.spawn(process.execPath, proxyStartArgv(process.argv[1]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: directProxyEnv(),
  });
  // Readiness is the authoritative failure path.  A spawn error must not become
  // an uncaught process exception before that bounded probe reports failure.
  child.on("error", () => { /* reported by the readiness probe */ });
  child.unref();

  const started = await deps.waitForProxyIdentity({ expectedPid: child.pid, intervalMs: 250 });
  // Another caller may have won the startup race.  Adopt only after the exact
  // child probe expires and through the same identity-checked liveness helper.
  return started ?? await deps.waitForProxyIdentity({ intervalMs: 250 });
}

function runtimeFailure(runtime: ResolveCodexRuntimeResult, platform: NodeJS.Platform, spawnable: typeof isSpawnableCodexCandidate): string | null {
  if (runtime.runtime.source === "fallback") {
    return "❌ No trusted Codex runtime was found. Install the Codex CLI and retry.";
  }
  if (!runtime.runtime.command || !spawnable(runtime.runtime.command, platform)) {
    return "❌ The selected Codex runtime is not a spawnable launcher on this platform.";
  }
  return null;
}

function launchCodex(
  runtime: ResolveCodexRuntimeResult,
  args: string[],
  deps: Required<Pick<CodexLaunchDeps, "spawn" | "codexExecInvocation" | "isSpawnableCodexCandidate">> & {
    platform: NodeJS.Platform;
    process: Pick<NodeJS.Process, "on" | "removeListener" | "kill" | "exitCode">;
  },
): Promise<number> {
  const failure = runtimeFailure(runtime, deps.platform, deps.isSpawnableCodexCandidate);
  if (failure) {
    console.error(failure);
    return Promise.resolve(1);
  }

  let invocation: ReturnType<typeof codexExecInvocation>;
  try {
    invocation = deps.codexExecInvocation(runtime.runtime.command, args, deps.platform);
  } catch (error) {
    console.error(`❌ Could not prepare the Codex launcher: ${error instanceof Error ? error.message : String(error)}`);
    return Promise.resolve(1);
  }
  let child: ChildProcess;
  try {
    child = deps.spawn(invocation.file, invocation.args, {
      stdio: "inherit",
      ...invocation.options,
    });
  } catch (error) {
    console.error(`❌ Failed to launch codex: ${error instanceof Error ? error.message : String(error)}`);
    return Promise.resolve(1);
  }

  return new Promise<number>(resolve => {
    const forwarded = signalList(deps.platform);
    const handlers = forwarded.map(signal => {
      const handler = () => {
        try {
          child.kill(signal);
        } catch {
          /* The child may have exited between the signal and kill calls. */
        }
      };
      deps.process.on(signal, handler);
      return [signal, handler] as const;
    });
    const clearHandlers = () => {
      for (const [signal, handler] of handlers) deps.process.removeListener(signal, handler);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearHandlers();
      if (error.code === "ENOENT") console.error(CODEX_INSTALL_HINT);
      else console.error(`❌ Failed to launch codex: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      clearHandlers();
      const hint = codexNotFoundHint(code, signal, deps.platform);
      if (hint) console.error(hint);
      if (signal && signal in SIGNAL_EXIT_CODES) {
        // Match the bin launcher contract: terminate this wrapper with the same
        // signal.  The numeric fallback keeps direct unit calls deterministic
        // when a test process intentionally stubs `kill`.
        try { deps.process.kill(process.pid, signal); } catch { /* best-effort */ }
        resolve(SIGNAL_EXIT_CODES[signal as ForwardableSignal]);
        return;
      }
      resolve(signal ? 1 : code ?? 0);
    });
  });
}

/** Start/adopt the proxy, sync its live port, then transparently launch Codex. */
export async function cmdCodex(args: string[], overrides: CodexLaunchDeps = {}): Promise<number> {
  const deps = {
    loadConfig: overrides.loadConfig ?? loadConfig,
    findLiveProxy: overrides.findLiveProxy ?? findLiveProxy,
    waitForProxyIdentity: overrides.waitForProxyIdentity ?? waitForProxyIdentity,
    spawn: overrides.spawn ?? spawn,
    syncModelsToCodex: overrides.syncModelsToCodex ?? syncModelsToCodex,
    resolveCodexRuntime: overrides.resolveCodexRuntime ?? resolveAndPersistCodexRuntime,
    codexExecInvocation: overrides.codexExecInvocation ?? codexExecInvocation,
    isSpawnableCodexCandidate: overrides.isSpawnableCodexCandidate ?? isSpawnableCodexCandidate,
    platform: overrides.platform ?? process.platform,
    process: overrides.process ?? process,
  };

  // Loading config here keeps the proxy starter's environment aligned with the
  // same OpenCodex profile that the sync operation resolves below.
  deps.loadConfig();
  let live: LiveProxy | null;
  try {
    live = await ensureProxyForCodex(deps);
  } catch (error) {
    console.error(`❌ Could not ensure a healthy proxy: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!live) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }

  let synced: CodexSyncResult;
  try {
    synced = await deps.syncModelsToCodex(live.port);
  } catch (error) {
    console.error(`❌ Codex provider sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!synced.ok) {
    console.error(`❌ Codex provider sync failed: ${synced.message}`);
    return 1;
  }

  let runtime: ResolveCodexRuntimeResult;
  try {
    runtime = deps.resolveCodexRuntime();
  } catch (error) {
    console.error(`❌ Could not resolve a trusted Codex runtime: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (runtime.persistError) {
    console.error(`⚠️  Codex runtime selection could not be persisted: ${runtime.persistError}`);
  }
  return launchCodex(runtime, args, deps);
}
