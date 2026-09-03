import { spawn } from "node:child_process";
import { BUN_CRASH_MARKER, createBunCrashLatch } from "./bun-start-supervisor.mjs";

export { BUN_CRASH_MARKER };

/** How long one launch attempt is observed for early death before it is left unobserved. */
export const TRAY_HOST_LAUNCH_OBSERVE_MS = 2_500;
/** A panic-qualified tray-host launch gets one, and only one, retry. */
export const TRAY_HOST_RETRY_LIMIT = 1;

function isAbnormalExit(code, signal) {
  return signal !== null || (code !== null && code !== 0);
}

/**
 * Launch the detached tray-host Bun child with runBunWithCrashRetry semantics.
 *
 * The tray host is long-lived (it stays alive for the whole tray session), so
 * unlike the npm launcher this supervisor never awaits the child. It observes
 * only the launch window: a child that dies inside the window is classified
 * against Bun's exact crash marker and earns at most one panic-qualified
 * retry, and every abnormal early exit is reported through `onEvidence`.
 * A healthy or still-running child resolves as soon as `heartbeatFresh`
 * turns true, otherwise when the window elapses, leaving the caller's own
 * heartbeat wait in charge of the overall verdict.
 *
 * The detached child keeps its stderr pipe unreferenced so the pipe can never
 * hold the parent's event loop open after a detached launch.
 *
 * Every dependency is injectable for focused tests; defaults are Node-safe
 * because this module is imported by the TypeScript tray controller.
 */
export function launchTrayHostWithCrashRetry(options = {}) {
  const {
    command,
    args,
    env,
    spawnImpl = spawn,
    heartbeatFresh = () => false,
    observeWindowMs = TRAY_HOST_LAUNCH_OBSERVE_MS,
    pollIntervalMs = 100,
    sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
    maxRetries = TRAY_HOST_RETRY_LIMIT,
    onAttempt,
    onEvidence,
    nowImpl = () => Date.now(),
  } = options;
  const retries = Math.max(0, Math.min(TRAY_HOST_RETRY_LIMIT, Number(maxRetries) || 0));

  return new Promise(resolve => {
    let finished = false;
    let attempts = 0;
    let lastOutcome = null;

    const finish = result => {
      if (finished) return;
      finished = true;
      resolve({ ...result, attempts });
    };

    const recordEvidence = evidence => {
      try {
        onEvidence?.({
          timestampMs: nowImpl(),
          panic: false,
          exitCode: null,
          signal: null,
          ...evidence,
        });
      } catch { /* diagnostics must not change launch semantics */ }
    };

    const launch = () => {
      if (finished) return;
      attempts += 1;
      const attempt = attempts;
      let spawnError = null;
      let exitInfo = null;
      onAttempt?.({ attempt });
      const latch = createBunCrashLatch();

      let child = null;
      try {
        child = spawnImpl(command, args, {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          env,
        });
      } catch (error) {
        recordEvidence({ attempt, error: error instanceof Error ? error.message : String(error), exitCode: null });
        finish({ outcome: "exited", error, panic: false, exitCode: null, signal: null, stderrTail: "" });
        return;
      }
      // Detached lifecycle: neither the child nor its stderr pipe may keep the
      // launching process alive after this call returns.
      child.unref?.();
      try { child.stderr?.unref?.(); } catch { /* stream doubles without unref are fine */ }

      if (child.stderr && typeof child.stderr.on === "function") {
        child.stderr.on("data", chunk => latch.append(chunk));
      }

      child.once("error", error => {
        // Node emits `close` after `error`; retaining that ordering lets the
        // close handler report actual fields while forbidding any retry.
        spawnError = error;
      });
      child.once("close", (code, signal) => {
        if (!spawnError && !exitInfo) exitInfo = { code, signal };
      });
      // A small test double may only implement `exit`; real Node children emit
      // close after their piped stderr drains.
      child.once("exit", (code, signal) => {
        if (typeof child?.stderr?.on !== "function" && !exitInfo) exitInfo = { code, signal };
      });

      const observe = async () => {
        try {
          const deadline = nowImpl() + observeWindowMs;
          while (!finished) {
            if (exitInfo || spawnError) break;
            if (heartbeatFresh()) {
              finish({ outcome: "healthy", panic: false, exitCode: null, signal: null, stderrTail: latch.toString() });
              return;
            }
            if (nowImpl() >= deadline) {
              finish({ outcome: "running", panic: false, exitCode: null, signal: null, stderrTail: latch.toString() });
              return;
            }
            await sleepImpl(pollIntervalMs);
          }
          if (finished) return;

          const code = exitInfo ? exitInfo.code : null;
          const signal = exitInfo ? exitInfo.signal : null;
          const abnormal = spawnError === null && isAbnormalExit(code, signal);
          const panic = Boolean(abnormal && latch.matched);
          lastOutcome = {
            outcome: "exited",
            panic,
            exitCode: code ?? null,
            signal: signal ?? null,
            stderrTail: latch.toString(),
          };
          if (spawnError) lastOutcome.error = spawnError;
          // Only abnormal launch-window deaths are evidence; a clean early
          // exit (for example the tray singleton refusing a duplicate) is a
          // normal outcome the caller already understands.
          if (abnormal || spawnError) {
            recordEvidence({
              attempt,
              panic,
              exitCode: code ?? null,
              signal: signal ?? null,
              ...(spawnError ? { error: spawnError.message } : {}),
            });
          }
          if (panic && attempt <= retries) {
            emitRetryDiagnostic();
            launch();
            return;
          }
          finish(lastOutcome);
        } catch (error) {
          // Observation must never reject or hang the launcher.
          recordEvidence({ attempt, panic: false, exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) });
          finish({ outcome: "exited", panic: false, exitCode: null, signal: null, stderrTail: "" });
        }
      };
      void observe();
    };

    const emitRetryDiagnostic = () => {
      try { process.stderr.write("opencodex: tray host crashed during launch; retrying once.\n"); } catch { /* best-effort */ }
    };

    launch();
  });
}
