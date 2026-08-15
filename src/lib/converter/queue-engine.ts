/**
 * The converter batch queue's processing engine: paged enqueue, bounded
 * concurrency, durable per-item state, pause/resume/cancel, retry, and a
 * restart-safe resume.
 *
 * Same overall shape as `src/lib/model-runtime/pull-queue-engine.ts`, adapted
 * for a job that is synchronous and bounded rather than a long streamed
 * download:
 *
 * ## Only the structured-data family is wired in today
 *
 * A `ConvertQueueItem` drives `convertStructuredDataAtPath` — JSON/CSV/TSV/XML
 * only. ZIP extraction and the PDF family are real, working, tested adapters
 * elsewhere in this module (`archive-service.ts`, `../pdf-tools/service.ts`)
 * but are not yet queued jobs here; see `docs/FEATURE-INVENTORY.md`'s
 * converter row for that gap rather than assuming this queue covers every
 * adapter the catalogue lists.
 *
 * ## Why "cancel" cannot interrupt a `converting` item
 *
 * A structured-data conversion is one bounded, synchronous call: read a file
 * up to `MAX_STRUCTURED_INPUT_BYTES`, parse it, serialize it, write it
 * atomically. There is no `await` inside that call for a cancellation signal
 * to land on, and — unlike a multi-gigabyte streamed model pull — there is
 * nothing expensive to save by aborting mid-write. So cancelling a `queued`
 * item is immediate; cancelling a `converting` item is a no-op that lets it
 * reach its own natural terminal state, and `pauseQueue()` works the same
 * way: it stops new items from being *claimed*, but never interrupts one
 * already running.
 *
 * ## The one rule everything else here serves
 *
 * A failed item never turns the batch green, and a failed item never deletes
 * or truncates an existing destination file — `structured-service.ts`'s own
 * atomic-write-then-reopen discipline already guarantees that; this module
 * adds no destructive step of its own on top of it.
 *
 * ## Resume
 *
 * `ensureQueueResumed()` runs at most once per process lifetime (tests reset
 * it via `resetConvertQueueEngineForTests`). Unlike the model-pull queue,
 * which must reconcile against the runtime's real current state because a
 * partial download cannot simply be replayed, a structured conversion is a
 * pure, idempotent function of its source file: requeuing a `converting` item
 * found at startup (nothing was still running it — the previous process life
 * is gone) either reproduces the exact same output or performs the first real
 * attempt, and either is safe because every write is atomic and reread from
 * disk before being trusted.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { buildConvertQueuePreflight, type ConvertQueuePreflight, type DiskFreeProbe } from "./queue-preflight";
import {
  flushQueueState,
  getQueueState,
  resetConvertQueueStoreForTests,
  updateAndFlushQueueState,
} from "./queue-store";
import { summarizeConvertQueue, type ConvertQueueItem, type ConvertQueueState, type ConvertQueueSummary } from "./queue-types";
import { convertStructuredDataAtPath, type StructuredConversionOutcome, type StructuredFormat } from "./structured-service";

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 3;

/**
 * Bound on one `enqueueConvertJobs` call — the "paged discovery" half of the
 * contract: a caller walking an arbitrarily large source (a directory tree,
 * a saved file list) pages jobs in through repeated calls rather than
 * resolving and holding the whole thing in memory before the first byte is
 * queued. Nothing bounds how many *total* items the durable queue can hold
 * across many such calls — see the module contract this file implements.
 */
export const MAX_ENQUEUE_PAGE = 500;

let concurrencyLimit = DEFAULT_CONCURRENCY;
let resumed = false;
let pumpPromise: Promise<void> | null = null;

type ConvertExecutor = (
  sourcePath: string,
  sourceFormat: StructuredFormat,
  destPath: string,
  destFormat: StructuredFormat,
  acknowledgeLossy?: boolean,
) => StructuredConversionOutcome | Promise<StructuredConversionOutcome>;
let convertExecutor: ConvertExecutor = convertStructuredDataAtPath;

/** Test seam: replace the actual conversion call the engine makes per item (e.g. to control timing and prove bounded concurrency). Pass null to restore the real synchronous converter. */
export function setConvertExecutorForTests(executor: ConvertExecutor | null): void {
  convertExecutor = executor ?? convertStructuredDataAtPath;
}

let diskProbeOverride: DiskFreeProbe | null = null;

/** Test seam: replace the free-disk-space probe the storage preflight makes. Pass null to restore the real platform probe. */
export function setConvertQueueDiskProbeForTests(probe: DiskFreeProbe | null): void {
  diskProbeOverride = probe;
}

/** Test-only: resets every module-level runtime flag (never the persisted file) so a test can simulate a fresh process picking the queue back up. */
export function resetConvertQueueEngineForTests(): void {
  concurrencyLimit = DEFAULT_CONCURRENCY;
  resumed = false;
  pumpPromise = null;
  convertExecutor = convertStructuredDataAtPath;
  diskProbeOverride = null;
  resetConvertQueueStoreForTests();
}

function clampConcurrency(value: number): number {
  const floored = Math.floor(value);
  if (!Number.isFinite(floored)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, floored));
}

export function getConcurrencyLimit(): number {
  return concurrencyLimit;
}

export function setConcurrencyLimit(value: number): number {
  concurrencyLimit = clampConcurrency(value);
  return concurrencyLimit;
}

/* ------------------------------------------------------------- claiming */

function claimNextQueued(): ConvertQueueItem | null {
  const state = getQueueState();
  if (state.paused) return null;
  const next = state.items.find(i => i.status === "queued");
  if (!next) return null;
  next.status = "converting";
  next.startedAt = Date.now();
  flushQueueState();
  return next;
}

async function runClaimedItem(itemId: string, job: Pick<ConvertQueueItem, "sourcePath" | "sourceFormat" | "destPath" | "destFormat" | "acknowledgeLossy">): Promise<void> {
  let outcome: StructuredConversionOutcome;
  try {
    outcome = await convertExecutor(job.sourcePath, job.sourceFormat, job.destPath, job.destFormat, job.acknowledgeLossy);
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : "the conversion crashed unexpectedly" };
  }

  updateAndFlushQueueState(state => {
    const item = state.items.find(i => i.id === itemId);
    if (!item || item.status !== "converting") return; // never clobber a status something else already resolved
    if (outcome.ok) {
      item.status = "converted";
      item.bytesWritten = outcome.bytesWritten ?? null;
      item.lossy = outcome.lossy ?? false;
      item.notes = outcome.notes ?? null;
      item.error = null;
      item.boundary = null;
    } else {
      item.status = "failed";
      item.error = outcome.error ?? "the conversion failed";
      item.boundary = outcome.boundary ?? null;
    }
    item.finishedAt = Date.now();
  });
}

async function worker(): Promise<void> {
  for (;;) {
    const claimed = claimNextQueued();
    if (!claimed) return;
    await runClaimedItem(claimed.id, claimed);
  }
}

/**
 * Runs every currently-`queued` item to a terminal state using
 * `concurrencyLimit` workers, looping until the queue is drained or paused
 * (including items added by a concurrent `enqueueConvertJobs`/`retryItem`
 * call while this was already running). Concurrent callers share one
 * in-flight run — this both prevents double-processing and gives tests a
 * promise to await for a deterministic "this pass is done" point.
 */
export function processQueue(): Promise<void> {
  if (pumpPromise) return pumpPromise;
  const initial = getQueueState();
  if (initial.paused || !initial.items.some(i => i.status === "queued")) return Promise.resolve();
  pumpPromise = (async () => {
    try {
      for (;;) {
        const n = clampConcurrency(concurrencyLimit);
        await Promise.all(Array.from({ length: n }, () => worker()));
        const state = getQueueState();
        if (state.paused || !state.items.some(i => i.status === "queued")) break;
      }
    } finally {
      pumpPromise = null;
    }
  })();
  return pumpPromise;
}

/* --------------------------------------------------------------- start */

export interface ConvertJobInput {
  sourcePath: string;
  sourceFormat: StructuredFormat;
  destPath: string;
  destFormat: StructuredFormat;
  acknowledgeLossy?: boolean;
  /** Overwrite an existing destination instead of skipping it. Defaults to `false` — the queue's own admission policy, applied before any bytes are touched (`structured-service.ts` itself has no "does this already exist" opinion). */
  overwrite?: boolean;
}

export type EnqueueConvertJobsResult =
  | { ok: true; state: ConvertQueueState; added: number; preflight: ConvertQueuePreflight }
  | { ok: false; error: string; preflight?: ConvertQueuePreflight };

/**
 * Admits one page of jobs into the durable queue and kicks background
 * processing. Refuses the whole page — adding nothing — when either the page
 * size is invalid or the storage preflight finds a *definite* shortfall; an
 * indeterminate disk reading never blocks admission, matching
 * `queue-preflight.ts`'s own rule.
 */
export async function enqueueConvertJobs(jobs: ConvertJobInput[]): Promise<EnqueueConvertJobsResult> {
  if (jobs.length === 0) return { ok: false, error: "at least one job is required" };
  if (jobs.length > MAX_ENQUEUE_PAGE) {
    return { ok: false, error: `a single enqueue call may include at most ${MAX_ENQUEUE_PAGE} jobs — page a larger batch across repeated calls` };
  }
  for (const job of jobs) {
    if (!isAbsolute(job.sourcePath)) return { ok: false, error: "every job's sourcePath must be an absolute path" };
    if (!isAbsolute(job.destPath)) return { ok: false, error: "every job's destPath must be an absolute path" };
  }

  // Stat every source up front — bounded by the page size above, so this
  // never becomes an unbounded directory walk; the caller has already
  // resolved concrete file paths before calling this.
  const sourceBytesByJob = jobs.map(job => {
    try {
      const stat = statSync(job.sourcePath);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  });

  const preflight = await buildConvertQueuePreflight(
    jobs.map((job, i) => ({ destPath: job.destPath, sourceBytes: sourceBytesByJob[i] })),
    diskProbeOverride ?? undefined,
  );
  if (preflight.insufficientDiskSpace) {
    return {
      ok: false,
      error: "the destination does not have enough free space for this batch, by the conservative estimate below",
      preflight,
    };
  }

  const state = getQueueState();
  const now = Date.now();
  let added = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const alreadyExists = existsSync(job.destPath);
    const skip = alreadyExists && job.overwrite !== true;
    const item: ConvertQueueItem = {
      id: crypto.randomUUID(),
      kind: "structured",
      sourcePath: job.sourcePath,
      sourceFormat: job.sourceFormat,
      destPath: job.destPath,
      destFormat: job.destFormat,
      acknowledgeLossy: job.acknowledgeLossy === true,
      status: skip ? "skipped" : "queued",
      requestedAt: now,
      startedAt: null,
      finishedAt: skip ? now : null,
      sourceBytes: sourceBytesByJob[i],
      bytesWritten: null,
      lossy: null,
      notes: skip ? ["the destination already existed and overwrite was not requested; skipped rather than overwritten"] : null,
      boundary: null,
      error: null,
    };
    state.items.push(item);
    added += 1;
  }
  flushQueueState();

  void processQueue();
  return { ok: true, state: getQueueState(), added, preflight };
}

/* --------------------------------------------------------- pause/resume */

export function pauseQueue(): ConvertQueueSummary {
  const state = updateAndFlushQueueState(s => { s.paused = true; });
  return summarizeConvertQueue(state.items, state.paused);
}

export function resumeQueue(): ConvertQueueSummary {
  const state = updateAndFlushQueueState(s => { s.paused = false; });
  void processQueue();
  return summarizeConvertQueue(state.items, state.paused);
}

/* -------------------------------------------------------- cancel/retry */

export type QueueMutationResult =
  | { ok: true; state: ConvertQueueState }
  | { ok: false; error: string };

/**
 * Cancels one item. A `queued` item is cancelled immediately. A `converting`
 * item cannot be interrupted (see the module header) so this is a no-op for
 * it — it will reach `converted` or `failed` on its own, at which point
 * `retryItem`/`clearFinishedItems` apply normally. Anything already terminal
 * is left untouched.
 */
export function cancelItem(id: string): QueueMutationResult {
  const state = getQueueState();
  const item = state.items.find(i => i.id === id);
  if (!item) return { ok: false, error: "no such queue item" };
  if (item.status === "queued") {
    item.status = "cancelled";
    item.finishedAt = Date.now();
    item.error = "cancelled before it started";
    flushQueueState();
  }
  return { ok: true, state };
}

/** Cancels every `queued` item in the batch. Items already `converting` finish naturally — see the module header. */
export function cancelAllPending(): ConvertQueueSummary {
  const state = getQueueState();
  for (const item of state.items) {
    if (item.status === "queued") {
      item.status = "cancelled";
      item.finishedAt = Date.now();
      item.error = "cancelled before it started";
    }
  }
  flushQueueState();
  return summarizeConvertQueue(state.items, state.paused);
}

/** Resets a `failed` or `cancelled` item back to `queued`, clearing its prior outcome, and kicks processing. */
export function retryItem(id: string): QueueMutationResult {
  const state = getQueueState();
  const item = state.items.find(i => i.id === id);
  if (!item) return { ok: false, error: "no such queue item" };
  if (item.status !== "failed" && item.status !== "cancelled") {
    return { ok: false, error: "only a failed or cancelled item can be retried" };
  }
  item.status = "queued";
  item.startedAt = null;
  item.finishedAt = null;
  item.bytesWritten = null;
  item.lossy = null;
  item.notes = null;
  item.boundary = null;
  item.error = null;
  flushQueueState();
  void processQueue();
  return { ok: true, state };
}

/** Removes every item already in a terminal state (`converted`/`skipped`/`cancelled`/`failed`), leaving `queued`/`converting` items untouched. Pure housekeeping — never touches a written file. */
export function clearFinishedItems(): ConvertQueueSummary {
  const state = getQueueState();
  state.items = state.items.filter(i => i.status === "queued" || i.status === "converting");
  flushQueueState();
  return summarizeConvertQueue(state.items, state.paused);
}

/* --------------------------------------------------------------- resume */

/**
 * Reconciles the persisted queue after a restart and, once, kicks background
 * processing of anything still `queued`. Safe to call from every route (it
 * is idempotent after the first real run) — see the module header for
 * exactly what it does and why re-running a `converting` item is safe.
 */
export function ensureQueueResumed(): ConvertQueueState {
  if (resumed) return getQueueState();
  resumed = true;

  const state = getQueueState();
  let changed = false;
  for (const item of state.items) {
    if (item.status !== "converting") continue;
    item.status = "queued";
    item.startedAt = null;
    changed = true;
  }
  if (changed) flushQueueState();

  if (!state.paused && state.items.some(i => i.status === "queued")) void processQueue();
  return state;
}

/* ---------------------------------------------------------------- read */

export function getQueueSnapshot(): { state: ConvertQueueState; summary: ConvertQueueSummary } {
  const state = getQueueState();
  return { state, summary: summarizeConvertQueue(state.items, state.paused) };
}
