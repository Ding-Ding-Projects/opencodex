/**
 * Runs a PDF operation inside a bounded worker thread.
 *
 * `worker_threads` is the isolation this app already has (see
 * `src/storage/policy-job.ts`): a separate V8 heap and event loop in the same
 * process, not a separate OS process. That is the honest scope of "equivalent
 * sandbox" here — it bounds memory (`resourceLimits`), wall-clock time (a
 * timeout that terminates the worker) and lets a run be cancelled, but it does
 * not give the operation a different filesystem or network namespace the way
 * an OS-level sandbox would. The operations run inside it make no filesystem
 * or network calls of their own (see `operations.ts`'s header), which is what
 * keeps "no ambient network" true in practice rather than only in principle;
 * a stronger process-level sandbox is recorded as a known gap in the feature
 * inventory rather than implied by this comment.
 */
import { Worker } from "node:worker_threads";
import {
  WORKER_MAX_OLD_GENERATION_MB,
  WORKER_MAX_YOUNG_GENERATION_MB,
  WORKER_STACK_SIZE_MB,
  WORKER_TIMEOUT_MS,
} from "./bounds";
import type { PdfOperationRequest, PdfOperationResult } from "./types";

export interface RunOptions {
  timeoutMs?: number;
  /** Aborting this cancels the in-flight worker run. */
  signal?: AbortSignal;
}

/**
 * Run one operation in a fresh, bounded worker and resolve with its result.
 *
 * A fresh worker per call, not a pool: PDF operations are not hot-path
 * traffic, and a fresh worker means a leaked buffer from one run can never
 * accumulate into the next one's memory ceiling.
 */
export function runPdfOperationSandboxed(
  request: PdfOperationRequest,
  options: RunOptions = {},
): Promise<PdfOperationResult> {
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
  return new Promise<PdfOperationResult>((resolve) => {
    const requestId = crypto.randomUUID();
    let settled = false;

    const worker = new Worker(new URL("./worker.ts", import.meta.url).href, {
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GENERATION_MB,
        stackSizeMb: WORKER_STACK_SIZE_MB,
      },
    });

    const timer = setTimeout(() => {
      finish(() => resolve({ ok: false, error: `the operation exceeded its ${timeoutMs} ms time budget and was cancelled` }));
    }, timeoutMs);

    const onAbort = () => {
      finish(() => resolve({ ok: false, error: "the operation was cancelled" }));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try { void worker.terminate(); } catch { /* already gone */ }
      fn();
    }

    worker.on("message", (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;
      if (msg.requestId !== requestId) return;
      if (msg.type === "done") {
        finish(() => resolve(msg.result as PdfOperationResult));
      } else if (msg.type === "error") {
        const message = typeof msg.message === "string" ? msg.message : "the worker failed";
        finish(() => resolve({ ok: false, error: message }));
      }
    });

    worker.on("error", (err: Error) => {
      finish(() => resolve({ ok: false, error: err.message || "the worker crashed" }));
    });

    worker.on("exit", (code: number) => {
      if (code !== 0) finish(() => resolve({ ok: false, error: `the worker exited unexpectedly (code ${code})` }));
    });

    worker.postMessage({ type: "run", requestId, request });
  });
}
