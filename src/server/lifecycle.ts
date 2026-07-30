import { flushResponseState } from "../responses/state";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import {
  abortStorageCleanupPolicyJob,
  setStorageCleanupPolicyJobLiveApply,
} from "../storage/policy-job";
import { stopStorageCleanupScheduler } from "../storage/policy-scheduler";

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

const activeTurns = new Set<AbortController>();
let draining = false;
let recyclingForExit = false;
let _serverRef: ReturnType<typeof Bun.serve> | undefined;

export function setServerRef(server: ReturnType<typeof Bun.serve> | undefined): void { _serverRef = server; }
export function setDraining(value: boolean): void { draining = value; }
export function registerTurn(ac: AbortController): void { activeTurns.add(ac); }
export function unregisterTurn(ac: AbortController): void { activeTurns.delete(ac); }
export function isDraining(): boolean { return draining; }
export function getActiveTurnCount(): number { return activeTurns.size; }
/** Live listen port of the Bun server, when started. */
export function getServerListenPort(): number | undefined {
  const port = _serverRef?.port;
  return typeof port === "number" && port > 0 ? port : undefined;
}
/**
 * Mark this process as a recycle (dashboard drain-and-restart). Exit cleanup
 * must keep Codex/Grok/system-env injection so the replacement process inherits
 * a working fence — unlike an intentional `ocx stop` teardown.
 */
export function markRecyclingForExit(): void { recyclingForExit = true; }
export function isRecyclingForExit(): boolean { return recyclingForExit; }

/**
 * "Finish and hand off": stop admitting new turns, then wait for the in-flight
 * ones to end on their own — without stopping the server.
 *
 * {@link drainAndShutdown} does the same wait but tears the listener down with
 * it, which is wrong for an operation that has to keep serving afterwards (a
 * restore rewrites the state files, then hands the restart over to
 * system-restart). Splitting the wait out means a restore never rewrites
 * `auth.json` underneath a request that is still using the credential in it.
 *
 * Unlike the shutdown drain, in-flight turns are never aborted: a caller that
 * runs out of patience is told what is still running and decides for itself.
 * The caller owns `draining` from here on — clear it if the operation is
 * abandoned, or leave it set if a shutdown follows.
 */
export async function quiesceActiveTurns(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
  draining = true;
  const deadline = Date.now() + timeoutMs;
  while (activeTurns.size > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  return { drained: activeTurns.size === 0, remaining: activeTurns.size };
}

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  ac: AbortController,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  registerTurn(ac);
  const reader = body.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    unregisterTurn(ac);
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        finish();
        try { controller.error(err); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      finish();
      ac.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export async function drainAndShutdown(
  server: ReturnType<typeof Bun.serve> | undefined,
  timeoutMs: number,
): Promise<void> {
  const s = server ?? _serverRef;
  draining = true;

  // Embedded terminal children are not turns and will not drain — a shell sits
  // there forever waiting for input. Kill them first so shutdown does not leave
  // orphaned processes holding the user's home directory open.
  try {
    const { killAllSessions } = await import("../lib/terminal-session");
    killAllSessions();
  } catch { /* module never loaded: no sessions to kill */ }

  const deadline = Date.now() + timeoutMs;
  while (activeTurns.size > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (activeTurns.size > 0) {
    console.warn(`⚠️  Aborting ${activeTurns.size} in-flight turn(s) after ${timeoutMs}ms deadline`);
    for (const ac of activeTurns) {
      ac.abort(new Error("server shutdown"));
    }
    activeTurns.clear();
  }
  // Debounced replay-state snapshot may still be pending; flush so the last completed turn's
  // previous_response_id chain survives the restart this shutdown is usually part of.
  await flushResponseState();
  // Tear down opt-in storage policy timers / worker / live-config sink so they cannot fire after stop.
  stopStorageCleanupScheduler();
  abortStorageCleanupPolicyJob();
  setStorageCleanupPolicyLiveSink(null);
  setStorageCleanupPolicyJobLiveApply(null);
  s?.stop(true);
  draining = false;
}
