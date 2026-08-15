/**
 * The batch-pull queue's processing engine: bounded concurrency, durable
 * per-item state, byte-accurate progress where the runtime reports it,
 * cancel, retry, and a restart-safe resume.
 *
 * ## The one rule everything else here serves
 *
 * A failed item never turns the batch green, and a failed or cancelled pull
 * never deletes an already-installed model. This module never imports
 * `deleteOllamaModel` — there is no code path here that can remove anything
 * from this machine. A failed re-pull of an already-installed tag leaves
 * that tag exactly as it was: Ollama's own pull only replaces a model's
 * manifest after every layer verifies successfully, so an interrupted or
 * failed `/api/pull` leaves the previously-working installation untouched on
 * the daemon's side, and this module adds no destructive step of its own on
 * top of that.
 *
 * ## Concurrency and claiming
 *
 * `worker()` claims the next `queued` item and immediately marks it
 * `pulling` before its first `await` — Bun/Node only switches between
 * concurrent async functions at an `await`, so two workers can never claim
 * the same item.
 *
 * ## Resume
 *
 * `ensureResumed()` runs at most once per process lifetime (tests reset it
 * via `resetPullQueueEngineForTests`). It reconciles every non-terminal item
 * against the runtime's *current* `/api/tags` — never against what the queue
 * file remembered — because a "pulling" item from a previous process life is
 * not actually being pulled by anything any more. If the tag is now
 * installed, the item is marked `pulled` (it finished; the process just
 * never got to record it); otherwise it is requeued with its progress
 * cleared, since a partial byte count cannot be trusted across a restart.
 */

import { fetchOllamaTags } from "./client";
import { pullOllamaModel, type OllamaPullFailure } from "./pull-client";
import {
  flushQueueState,
  getQueueState,
  resetPullQueueStoreForTests,
  updateAndFlushQueueState,
  updateQueueStateInMemory,
} from "./pull-queue-store";
import { summarizePullQueue, type PullQueueItem, type PullQueueState, type PullQueueSummary } from "./pull-queue-types";

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 5;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_BATCH_TAGS = 25;

let concurrencyLimit = DEFAULT_CONCURRENCY;
let resumed = false;
let pumpPromise: Promise<void> | null = null;
const abortControllers = new Map<string, AbortController>();

type PullExecutor = typeof pullOllamaModel;
let pullExecutor: PullExecutor = pullOllamaModel;

/** Test seam: replace the network call the engine makes per item. Pass null to restore the real streaming client. */
export function setPullExecutorForTests(executor: PullExecutor | null): void {
  pullExecutor = executor ?? pullOllamaModel;
}

/** Test seam: replace the `/api/tags` reconciliation call `ensureResumed`/`startBatchPull` make. Pass null to restore the real client. */
type TagsFetcher = typeof fetchOllamaTags;
let tagsFetcher: TagsFetcher = fetchOllamaTags;
export function setPullQueueTagsFetcherForTests(fetcher: TagsFetcher | null): void {
  tagsFetcher = fetcher ?? fetchOllamaTags;
}

/** Test-only: resets every module-level runtime flag (never the persisted file) so a test can simulate a fresh process picking the queue back up. */
export function resetPullQueueEngineForTests(): void {
  concurrencyLimit = DEFAULT_CONCURRENCY;
  resumed = false;
  pumpPromise = null;
  abortControllers.clear();
  pullExecutor = pullOllamaModel;
  tagsFetcher = fetchOllamaTags;
  resetPullQueueStoreForTests();
}

function describePullFailure(failure: OllamaPullFailure): string {
  switch (failure.kind) {
    case "refused": return "the runtime refused the connection";
    case "timeout": return "the pull timed out";
    case "aborted": return "cancelled";
    case "network": return failure.error;
    case "http": return `the runtime answered with HTTP ${failure.status}`;
    case "reported-error": return failure.error;
    case "stream-error": return failure.error;
    default: return "the pull failed";
  }
}

function clampConcurrency(value: number): number {
  const floored = Math.floor(value);
  if (!Number.isFinite(floored)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, floored));
}

/* --------------------------------------------------------------- resume */

/**
 * Reconciles the persisted queue against the runtime's real current state
 * and, once, kicks background processing of anything still `queued`. Safe to
 * call from every route (it is idempotent after the first real run) — see
 * the module header for exactly what it does and why.
 */
export async function ensureResumed(baseUrl: string): Promise<PullQueueState> {
  if (resumed) return getQueueState();
  resumed = true;

  const state = getQueueState();
  const hasNonTerminal = state.items.some(i => i.status === "queued" || i.status === "pulling");
  if (!hasNonTerminal) return state;

  const tagsResult = await tagsFetcher(baseUrl);
  const installed = tagsResult.ok ? new Set(tagsResult.data.map(t => t.name)) : null;

  for (const item of state.items) {
    if (item.status !== "queued" && item.status !== "pulling") continue;
    if (installed?.has(item.tag)) {
      item.status = "pulled";
      item.finishedAt = Date.now();
      item.error = null;
      item.lastStatusMessage = "found already installed on resume";
      if (item.totalBytes > 0) item.receivedBytes = item.totalBytes;
      continue;
    }
    // Nothing is actually downloading this any more, whatever it says — requeue with progress cleared.
    item.status = "queued";
    item.startedAt = null;
    item.receivedBytes = 0;
    item.totalBytes = 0;
    item.totalKnown = false;
    item.lastStatusMessage = installed
      ? "resumed after restart"
      : "resumed after restart; the runtime's current state could not be verified";
  }
  flushQueueState();

  if (state.items.some(i => i.status === "queued")) void processQueue(baseUrl);
  return state;
}

/* ------------------------------------------------------------- claiming */

function claimNextQueued(): PullQueueItem | null {
  const state = getQueueState();
  const next = state.items.find(i => i.status === "queued");
  if (!next) return null;
  next.status = "pulling";
  next.startedAt = Date.now();
  next.lastStatusMessage = "starting…";
  flushQueueState();
  return next;
}

const PROGRESS_FLUSH_MIN_INTERVAL_MS = 750;
const PROGRESS_FLUSH_MIN_BYTES = 8 * 1024 * 1024;

async function runClaimedItem(baseUrl: string, itemId: string, tag: string): Promise<void> {
  const controller = new AbortController();
  abortControllers.set(itemId, controller);

  const digestTotals = new Map<string, { total: number; completed: number }>();
  let lastFlushAt = Date.now();
  let bytesSinceFlush = 0;
  let lastStatus: string | null = null;

  const outcome = await pullExecutor(baseUrl, tag, {
    signal: controller.signal,
    onLine: line => {
      if (line.digest) {
        const prior = digestTotals.get(line.digest) ?? { total: 0, completed: 0 };
        digestTotals.set(line.digest, {
          total: line.total ?? prior.total,
          completed: line.completed ?? prior.completed,
        });
      }
      let totalBytes = 0;
      let receivedBytes = 0;
      for (const d of digestTotals.values()) { totalBytes += d.total; receivedBytes += d.completed; }

      updateQueueStateInMemory(state => {
        const item = state.items.find(i => i.id === itemId);
        if (!item) return;
        bytesSinceFlush += Math.max(0, receivedBytes - item.receivedBytes);
        item.receivedBytes = receivedBytes;
        item.totalBytes = totalBytes;
        item.totalKnown = totalBytes > 0;
        if (line.status) item.lastStatusMessage = line.status;
      });

      const now = Date.now();
      const statusChanged = line.status !== lastStatus;
      lastStatus = line.status;
      if (statusChanged || bytesSinceFlush >= PROGRESS_FLUSH_MIN_BYTES || now - lastFlushAt >= PROGRESS_FLUSH_MIN_INTERVAL_MS) {
        flushQueueState();
        lastFlushAt = now;
        bytesSinceFlush = 0;
      }
    },
  });

  abortControllers.delete(itemId);

  updateAndFlushQueueState(state => {
    const item = state.items.find(i => i.id === itemId);
    if (!item || item.status !== "pulling") return; // never clobber a status something else already resolved
    if (outcome.ok) {
      item.status = "pulled";
      item.error = null;
      item.lastStatusMessage = "success";
      item.totalKnown = true;
      if (item.totalBytes > 0) item.receivedBytes = item.totalBytes;
    } else if (outcome.failure.kind === "aborted") {
      item.status = "cancelled";
      item.error = "cancelled";
    } else {
      item.status = "failed";
      item.error = describePullFailure(outcome.failure);
    }
    item.finishedAt = Date.now();
  });
}

async function worker(baseUrl: string): Promise<void> {
  for (;;) {
    const claimed = claimNextQueued();
    if (!claimed) return;
    await runClaimedItem(baseUrl, claimed.id, claimed.tag);
  }
}

/**
 * Runs every currently-`queued` item to a terminal state using
 * `concurrencyLimit` workers, looping until the queue is drained (including
 * items added by a concurrent `startBatchPull`/`retryItem` call while this
 * was already running). Concurrent callers share one in-flight run — this
 * both prevents double-processing and gives tests a promise to await for a
 * deterministic "the batch is done" point.
 */
export function processQueue(baseUrl: string): Promise<void> {
  if (pumpPromise) return pumpPromise;
  if (!getQueueState().items.some(i => i.status === "queued")) return Promise.resolve();
  pumpPromise = (async () => {
    try {
      for (;;) {
        const n = clampConcurrency(concurrencyLimit);
        await Promise.all(Array.from({ length: n }, () => worker(baseUrl)));
        if (!getQueueState().items.some(i => i.status === "queued")) break;
      }
    } finally {
      pumpPromise = null;
    }
  })();
  return pumpPromise;
}

/* --------------------------------------------------------------- start */

export interface StartBatchPullOptions {
  concurrency?: number;
  /** Re-pull a tag even when it is already installed, instead of marking it `skipped`. */
  force?: boolean;
}

export type StartBatchPullResult =
  | { ok: true; state: PullQueueState }
  | { ok: false; error: string };

export async function startBatchPull(baseUrl: string, tags: string[], opts: StartBatchPullOptions = {}): Promise<StartBatchPullResult> {
  const cleaned = Array.from(new Set(tags.map(t => t.trim()).filter(t => t.length > 0)));
  if (cleaned.length === 0) return { ok: false, error: "at least one tag is required" };
  if (cleaned.length > MAX_BATCH_TAGS) return { ok: false, error: `a batch may include at most ${MAX_BATCH_TAGS} tags at once` };
  if (cleaned.some(t => t.length > 200)) return { ok: false, error: "a tag name is unreasonably long" };

  await ensureResumed(baseUrl);

  if (opts.concurrency !== undefined) concurrencyLimit = clampConcurrency(opts.concurrency);

  const tagsResult = await tagsFetcher(baseUrl);
  const installed = tagsResult.ok ? new Set(tagsResult.data.map(t => t.name)) : null;

  const state = getQueueState();
  const now = Date.now();
  for (const tag of cleaned) {
    const alreadyActive = state.items.some(i => i.tag === tag && (i.status === "queued" || i.status === "pulling"));
    if (alreadyActive) continue;
    const alreadyInstalled = installed?.has(tag) === true;
    const skip = alreadyInstalled && !opts.force;
    const item: PullQueueItem = {
      id: crypto.randomUUID(),
      tag,
      status: skip ? "skipped" : "queued",
      requestedAt: now,
      startedAt: null,
      finishedAt: skip ? now : null,
      receivedBytes: 0,
      totalBytes: 0,
      totalKnown: false,
      lastStatusMessage: skip ? "already installed; skipped" : null,
      estimatedSizeBytes: null,
      error: null,
    };
    state.items.push(item);
  }
  flushQueueState();

  void processQueue(baseUrl);
  return { ok: true, state: getQueueState() };
}

/* -------------------------------------------------------- cancel/retry */

export type QueueMutationResult =
  | { ok: true; state: PullQueueState }
  | { ok: false; error: string };

/** Cancels one item: a `queued` item is cancelled immediately; a `pulling` item's connection is closed and the worker records the cancellation once the abort actually unwinds — see `pull-client.ts`. */
export function cancelItem(id: string): QueueMutationResult {
  const state = getQueueState();
  const item = state.items.find(i => i.id === id);
  if (!item) return { ok: false, error: "no such queue item" };
  if (item.status === "queued") {
    item.status = "cancelled";
    item.finishedAt = Date.now();
    item.error = "cancelled before it started";
    flushQueueState();
    return { ok: true, state };
  }
  if (item.status === "pulling") {
    abortControllers.get(id)?.abort();
    return { ok: true, state }; // status transition happens in runClaimedItem once the abort is observed
  }
  return { ok: true, state }; // already terminal — nothing to do
}

/** Cancels every non-terminal item in the batch. */
export function cancelAllPending(): PullQueueSummary {
  const state = getQueueState();
  for (const item of state.items) {
    if (item.status === "queued") {
      item.status = "cancelled";
      item.finishedAt = Date.now();
      item.error = "cancelled before it started";
    } else if (item.status === "pulling") {
      abortControllers.get(item.id)?.abort();
    }
  }
  flushQueueState();
  return summarizePullQueue(getQueueState().items);
}

/** Resets a `failed` or `cancelled` item back to `queued`, clearing its progress and error, and kicks processing. */
export function retryItem(baseUrl: string, id: string): QueueMutationResult {
  const state = getQueueState();
  const item = state.items.find(i => i.id === id);
  if (!item) return { ok: false, error: "no such queue item" };
  if (item.status !== "failed" && item.status !== "cancelled") {
    return { ok: false, error: "only a failed or cancelled item can be retried" };
  }
  item.status = "queued";
  item.startedAt = null;
  item.finishedAt = null;
  item.receivedBytes = 0;
  item.totalBytes = 0;
  item.totalKnown = false;
  item.lastStatusMessage = "retrying";
  item.error = null;
  flushQueueState();
  void processQueue(baseUrl);
  return { ok: true, state };
}

/** Removes every item already in a terminal state (`pulled`/`skipped`/`cancelled`/`failed`), leaving `queued`/`pulling` items untouched. Pure housekeeping — never touches anything installed. */
export function clearFinishedItems(): PullQueueSummary {
  const state = getQueueState();
  state.items = state.items.filter(i => i.status === "queued" || i.status === "pulling");
  flushQueueState();
  return summarizePullQueue(state.items);
}

/* ---------------------------------------------------------------- read */

export function getQueueSnapshot(): { state: PullQueueState; summary: PullQueueSummary } {
  const state = getQueueState();
  return { state, summary: summarizePullQueue(state.items) };
}

export function getConcurrencyLimit(): number {
  return concurrencyLimit;
}
