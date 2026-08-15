/**
 * Durable, atomic, on-disk persistence for the batch-pull queue.
 *
 * State lives at `<codexHome>/model-runtime/pull-queue.json` — outside the
 * main `config.toml`/`config.json` this app already owns, so a queue with a
 * dozen in-flight items being written on every progress line never contends
 * with, or risks corrupting, unrelated configuration. Every write is
 * temp-file-then-rename, the same shape `renameAtomicFile` in `src/config.ts`
 * uses, kept self-contained here because this file carries no secrets and so
 * needs none of that helper's Windows ACL hardening.
 *
 * Two read paths are exposed on purpose:
 * - `getQueueState()` — the in-memory cache, always current. The engine
 *   calls this before every mutation and the GET route calls it to serve
 *   live progress, so a caller never has to wait for a throttled disk flush
 *   to see the latest byte counts.
 * - `flushQueueState()` — writes the current cache to disk. The engine calls
 *   this on every status transition (queued→pulling→terminal) and on a
 *   bounded cadence of progress lines, never on every single byte-progress
 *   callback — see `pull-queue-engine.ts` for the throttle.
 *
 * "Durable per-item state that survives a restart" means the cache is
 * rebuilt from this file, not from memory, whenever a fresh process (or a
 * test simulating one via `resetPullQueueStoreForTests`) first asks for it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCodexHomeDir } from "../../codex/home";
import type { PullItemStatus, PullQueueItem, PullQueueState } from "./pull-queue-types";

let storePathOverride: string | null = null;

function defaultStorePath(): string {
  return join(resolveCodexHomeDir(), "model-runtime", "pull-queue.json");
}

function storePath(): string {
  return storePathOverride ?? defaultStorePath();
}

/** Test seam: redirect the persisted file to an isolated path (e.g. a temp dir). Pass null to restore the real default. */
export function setPullQueueStorePathForTests(path: string | null): void {
  storePathOverride = path;
}

const VALID_STATUSES: PullItemStatus[] = ["queued", "pulling", "pulled", "skipped", "cancelled", "failed"];

function emptyState(): PullQueueState {
  return { version: 1, items: [] };
}

/** Defensive re-validation of every field — a hand-edited or truncated file degrades to "drop the bad item", never a thrown exception. */
function sanitizeItem(raw: unknown): PullQueueItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.tag !== "string" || !r.tag) return null;
  if (typeof r.status !== "string" || !VALID_STATUSES.includes(r.status as PullItemStatus)) return null;
  return {
    id: r.id,
    tag: r.tag,
    status: r.status as PullItemStatus,
    requestedAt: typeof r.requestedAt === "number" && Number.isFinite(r.requestedAt) ? r.requestedAt : Date.now(),
    startedAt: typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? r.startedAt : null,
    finishedAt: typeof r.finishedAt === "number" && Number.isFinite(r.finishedAt) ? r.finishedAt : null,
    receivedBytes: typeof r.receivedBytes === "number" && Number.isFinite(r.receivedBytes) && r.receivedBytes >= 0 ? r.receivedBytes : 0,
    totalBytes: typeof r.totalBytes === "number" && Number.isFinite(r.totalBytes) && r.totalBytes >= 0 ? r.totalBytes : 0,
    totalKnown: r.totalKnown === true,
    lastStatusMessage: typeof r.lastStatusMessage === "string" ? r.lastStatusMessage : null,
    estimatedSizeBytes: typeof r.estimatedSizeBytes === "number" && Number.isFinite(r.estimatedSizeBytes) ? r.estimatedSizeBytes : null,
    error: typeof r.error === "string" ? r.error : null,
  };
}

function readFromDisk(): PullQueueState {
  const path = storePath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyState(); // no file yet — a fresh install/first use, not an error
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState(); // corrupt file fails closed to "no queue", never throws
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return emptyState();
  const rawItems = (parsed as { items?: unknown }).items;
  const items = Array.isArray(rawItems) ? rawItems.map(sanitizeItem).filter((i): i is PullQueueItem => i !== null) : [];
  return { version: 1, items };
}

let cache: PullQueueState | null = null;

/** Always current — hydrates from disk once, then reflects every subsequent in-memory mutation immediately. */
export function getQueueState(): PullQueueState {
  if (cache === null) cache = readFromDisk();
  return cache;
}

/** Replaces the in-memory cache. Does not touch disk — call `flushQueueState()` to persist. */
export function setQueueState(next: PullQueueState): PullQueueState {
  cache = next;
  return cache;
}

let atomicSeq = 0;

/** Writes the current in-memory cache to disk, atomically (temp file + rename). */
export function flushQueueState(): void {
  const state = getQueueState();
  const path = storePath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // If the directory genuinely cannot be created, the write below will
    // fail too and surface the same way — no need to duplicate the handling.
  }
  const tmp = `${path}.ocx-pull-queue.${process.pid}.${++atomicSeq}.tmp`;
  const content = JSON.stringify(state, null, 2);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup; the real error below is what matters */ }
    throw error;
  }
}

/** Convenience: mutate the cache in place, then immediately persist it. Used at every status transition. */
export function updateAndFlushQueueState(mutator: (state: PullQueueState) => void): PullQueueState {
  const state = getQueueState();
  mutator(state);
  flushQueueState();
  return state;
}

/** Convenience: mutate the cache in place without touching disk — for high-frequency progress updates the engine throttles separately. */
export function updateQueueStateInMemory(mutator: (state: PullQueueState) => void): PullQueueState {
  const state = getQueueState();
  mutator(state);
  return state;
}

/**
 * Test-only: drops the in-memory cache so the next `getQueueState()` call
 * re-reads the file from disk, exactly as a fresh process would. This is how
 * "resume after restart" is exercised without spawning a real second process.
 */
export function resetPullQueueStoreForTests(): void {
  cache = null;
}
