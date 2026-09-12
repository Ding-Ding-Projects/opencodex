import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptSystemRestart, setSystemRestartIoForTests } from "../src/server/management/system-restart";

/**
 * L2-02 — `POST /api/stop` (src/server/management-api.ts), `POST /api/host/exit`
 * (src/server/management/host-routes.ts), and the dashboard's drain-and-restart
 * (`acceptSystemRestart` in src/server/management/system-restart.ts) all used to schedule
 * their real shutdown as a bare fire-and-forget timer:
 *
 *   setTimeout(async () => {
 *     await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
 *     process.exit(0);
 *   }, 200);
 *
 * with no try/catch/finally at all — unlike the CLI's own signal-driven shutdown in
 * src/cli/index.ts (handleStart's `shutdown()`), which wraps the identical call in
 * `try { await drainAndShutdown(...) } finally { ...; process.exit(...) }` specifically so
 * `process.exit` always runs.
 *
 * If `drainAndShutdown` ever throws (it has no internal top-level try/catch either — see
 * src/server/lifecycle.ts: runShutdownTasks(), flushResponseState(), the storage-cleanup
 * calls, and s?.stop(true) are all called unguarded), the async setTimeout callback's
 * returned promise rejects with nothing attached to it (setTimeout discards a callback's
 * return value), so `process.exit(0)` is skipped and the rejection becomes a genuine
 * Node/Bun `unhandledRejection`. src/lib/crash-guard.ts's `installCrashGuards()` registers
 * the ONLY process-wide `unhandledRejection` handler and, for anything outside its narrow
 * benign-abort allowlist, deliberately logs "(proxy stayed up; logged to crash.log)" and
 * returns — by design, it never exits. Net effect: the client already received an HTTP 200
 * promising "Proxy stopping..." / `{ exiting: true }`, but the daemon silently keeps running
 * forever — or, for the restart route, stays permanently in `draining` with no exit and no
 * replacement on the way.
 *
 * The fix moved `/api/stop` and `/api/host/exit` onto one shared helper,
 * `scheduleDrainAndExit` (src/server/lifecycle.ts), which wraps the identical
 * `drainAndShutdown` call in `try { ... } finally { process.exit(0); }` — mirroring the CLI's
 * proven pattern exactly. `acceptSystemRestart` cannot use that same helper unconditionally
 * (its post-drain logic decides whether to respawn or hand off to a supervisor), so it wraps
 * its own `await drain(...)` in try/catch instead, resetting `restartAccepted` and `draining`
 * back to their pre-accept state on failure rather than exiting into a possibly half-torn-down
 * state.
 *
 * This file extracts the REAL, currently-published `setTimeout(async () => { ... }, 200)`
 * callback body verbatim from `scheduleDrainAndExit` and fires it exactly the way the real
 * code does — uncaught, unawaited — to prove that a throwing `drainAndShutdown` still yields
 * exactly one `process.exit(0)` call and zero unhandled rejections. It also proves both
 * `/api/stop` and `/api/host/exit` are actually wired through that shared helper (rather than
 * a reintroduced bare timer), and exercises the real `acceptSystemRestart` export directly
 * (it already has a dependency-injection seam for exactly this) to prove the same absence of
 * an unhandled rejection, plus the restart-specific "resume service, don't wedge" behavior.
 */

/**
 * `searchFrom` skips past this file's own doc comment above, which quotes the real
 * `setTimeout(async () => {` line verbatim as prose — without it, `source.indexOf(marker)`
 * would match that quotation instead of the real code and extract non-executable comment
 * text. Callers anchor the search past a marker unique to the real declaration (e.g. the
 * exported function's name) so only the genuine occurrence is ever extracted.
 */
function extractTimerCallbackBody(source: string, label: string, searchFrom = 0): string {
  const marker = "setTimeout(async () => {";
  const idx = source.indexOf(marker, searchFrom);
  if (idx === -1) throw new Error(`could not find "${marker}" in ${label} at or after offset ${searchFrom}`);
  let depth = 1;
  let i = idx + marker.length;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting the setTimeout callback in ${label}`);
  return source.slice(idx + marker.length, i - 1);
}

/**
 * The real `process.exit` never returns — it terminates the process on the spot, so control
 * never comes back to whatever called it, and the async function that called it never gets a
 * chance to settle its promise at all (there is nothing left running to settle it). A spy that
 * just records the call and returns normally does NOT reproduce that: per ordinary
 * `try/finally` semantics, a `finally` block that completes normally does not swallow the
 * `try` block's exception, so with a plain returning spy the original `drainAndShutdown`
 * rejection would keep propagating out of `finally { process.exit(0); }` regardless of
 * whether the fix is present, making passing and failing code indistinguishable. Throwing
 * this sentinel from the spy instead reproduces the one behavior that matters here — nothing
 * queued after the call ever runs — because a `finally` block that itself throws DOES replace
 * whatever completion the `try` block was already carrying, exactly like a real process exit
 * supersedes an in-flight rejection nobody will ever observe.
 */
class ProcessExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${String(code)}) sentinel`);
  }
}

async function observeShutdownTimerBody(
  filePath: string,
  label: string,
  anchor: string,
): Promise<{ exitCalls: unknown[]; settledWith: unknown; drainCalls: number }> {
  const source = readFileSync(filePath, "utf8");
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) throw new Error(`could not find anchor ${JSON.stringify(anchor)} in ${label}`);
  const body = extractTimerCallbackBody(source, label, anchorIdx);

  const exitCalls: unknown[] = [];
  let drainCalls = 0;
  const drainAndShutdown = async () => {
    drainCalls += 1;
    throw new Error(`simulated ${label} drainAndShutdown failure`);
  };
  const spyProcess = {
    exit: (code?: number) => {
      exitCalls.push(code);
      throw new ProcessExitCalled(code);
    },
  };

  // eslint-disable-next-line no-new-func
  const callback = new Function(
    "drainAndShutdown", "timeoutMs", "process",
    `return (async () => { ${body} })();`,
  ) as (
    drain: typeof drainAndShutdown,
    timeoutMs: number,
    proc: { exit(code?: number): void },
  ) => Promise<void>;

  // Directly awaited and caught in the same expression — unlike the real fire-and-forget
  // `setTimeout(async () => {...}, delayMs)`, this attaches a rejection handler in the same
  // microtask the promise is created in, so nothing here can ever register as a process-level
  // unhandled rejection regardless of what the extracted body does; the outcome is read from
  // `settledWith` instead (undefined if the callback resolved, or whatever it rejected with).
  let settledWith: unknown;
  try {
    await callback(drainAndShutdown, 5000, spyProcess);
  } catch (err) {
    settledWith = err;
  }

  return { exitCalls, settledWith, drainCalls };
}

describe("shutdown-timer unhandled-rejection contract (L2-02)", () => {
  test("scheduleDrainAndExit still calls process.exit(0) when drainAndShutdown throws", async () => {
    const path = join(import.meta.dir, "..", "src", "server", "lifecycle.ts");
    const result = await observeShutdownTimerBody(path, "lifecycle.ts scheduleDrainAndExit", "export function scheduleDrainAndExit");

    expect(result.drainCalls).toBe(1);
    // process.exit(0) still runs even though drainAndShutdown rejected.
    expect(result.exitCalls).toEqual([0]);
    // Nothing past the exit call is independently observable — in particular, the original
    // "simulated ... failure" error from drainAndShutdown never surfaces on its own. That is
    // exactly the property that matters in production: a real process.exit(0) would already
    // have ended the process before any such rejection could ever be reported as unhandled.
    expect(result.settledWith).toBeInstanceOf(ProcessExitCalled);
  });

  test("POST /api/stop schedules its shutdown through the shared scheduleDrainAndExit helper", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "server", "management-api.ts"), "utf8");
    expect(source).toContain("scheduleDrainAndExit(config.shutdownTimeoutMs ?? 5000)");
    // No reintroduced bare fire-and-forget timer alongside the helper call.
    expect(source).not.toContain("setTimeout(async");
  });

  test("POST /api/host/exit schedules its shutdown through the shared scheduleDrainAndExit helper", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "server", "management", "host-routes.ts"), "utf8");
    expect(source).toContain("scheduleDrainAndExit(config.shutdownTimeoutMs ?? 5000)");
    expect(source).not.toContain("setTimeout(async");
  });

  describe("acceptSystemRestart (system-restart.ts)", () => {
    afterEach(() => {
      setSystemRestartIoForTests();
    });

    test("a throwing drain resumes service instead of exiting or wedging the daemon", async () => {
      const calls: string[] = [];
      let scheduled: (() => void | Promise<void>) | null = null;
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        const first = acceptSystemRestart({
          isDraining: () => false,
          getActiveTurnCount: () => 0,
          schedule: (fn) => { scheduled = fn; },
          setDraining: (value) => { calls.push(`draining:${value}`); },
          drainAndShutdown: async () => {
            calls.push("drain");
            throw new Error("simulated acceptSystemRestart drainAndShutdown failure");
          },
          exitProcess: (code) => { calls.push(`exit:${code}`); },
        });
        expect(first.alreadyDraining).toBe(false);
        expect(scheduled).not.toBeNull();

        await scheduled!();
        // Same real event-loop grace window as the other two routes above, so any rejection
        // that slipped past the try/catch would have surfaced as unhandled by now.
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(calls).toEqual(["draining:true", "drain", "draining:false"]);
        // Nothing past the failed drain ran: no exit, no respawn, no markRecycling.
        expect(calls.some(c => c.startsWith("exit:"))).toBe(false);
        expect(unhandled).toEqual([]);
        expect(warnings.some(w => w.includes("resuming service"))).toBe(true);

        // The accept latch must not still read "already draining" after the failure: a fresh
        // accept must be treated as a brand-new request, not a no-op against a stale
        // `restartAccepted` — otherwise the daemon would refuse every future restart/stop
        // attempt made through this route forever.
        const second = acceptSystemRestart({
          isDraining: () => false,
          getActiveTurnCount: () => 0,
          schedule: () => {},
        });
        expect(second.alreadyDraining).toBe(false);
      } finally {
        process.removeListener("unhandledRejection", onUnhandledRejection);
        console.warn = originalWarn;
      }
    });
  });
});
