/**
 * Durable, atomic, on-disk persistence for the converter's batch queue.
 *
 * State lives at `<codexHome>/converter/convert-queue.json` — its own file,
 * outside `config.toml`/`config.json` and outside the model-runtime pull
 * queue's own file, so a queue with many in-flight items being written on
 * every status transition never contends with, or risks corrupting,
 * unrelated state. Every write is temp-file-then-rename, the same shape
 * `src/lib/model-runtime/pull-queue-store.ts` already uses for the same
 * reason: this file carries no secrets, so it needs none of `renameAtomicFile`
 * in `src/config.ts`'s Windows ACL hardening, just the plain atomicity.
 *
 * Two read paths, same discipline as the pull queue's store:
 * - `getQueueState()` — the in-memory cache, always current.
 * - `flushQueueState()` — writes the current cache to disk.
 *
 * "Durable per-item state that survives a restart" means the cache is
 * rebuilt from this file, not from memory, whenever a fresh process (or a
 * test simulating one via `resetConvertQueueStoreForTests`) first asks for
 * it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCodexHomeDir } from "../../codex/home";
import type { ConvertJobKind, ConvertQueueItem, ConvertQueueItemStatus, ConvertQueueState } from "./queue-types";
import type { StructuredFormat } from "./structured-service";

let storePathOverride: string | null = null;

function defaultStorePath(): string {
  return join(resolveCodexHomeDir(), "converter", "convert-queue.json");
}

function storePath(): string {
  return storePathOverride ?? defaultStorePath();
}

/** Test seam: redirect the persisted file to an isolated path (e.g. a temp dir). Pass null to restore the real default. */
export function setConvertQueueStorePathForTests(path: string | null): void {
  storePathOverride = path;
}

const VALID_STATUSES: ConvertQueueItemStatus[] = ["queued", "converting", "converted", "skipped", "cancelled", "failed"];
const VALID_KINDS: ConvertJobKind[] = ["structured"];
const VALID_FORMATS: StructuredFormat[] = ["json", "csv", "tsv", "xml"];

function emptyState(): ConvertQueueState {
  return { version: 1, paused: false, items: [] };
}

function isStructuredFormat(value: unknown): value is StructuredFormat {
  return typeof value === "string" && (VALID_FORMATS as readonly string[]).includes(value);
}

/** Defensive re-validation of every field — a hand-edited or truncated file degrades to "drop the bad item", never a thrown exception. */
function sanitizeItem(raw: unknown): ConvertQueueItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.kind !== "string" || !VALID_KINDS.includes(r.kind as ConvertJobKind)) return null;
  if (typeof r.sourcePath !== "string" || !r.sourcePath) return null;
  if (!isStructuredFormat(r.sourceFormat)) return null;
  if (typeof r.destPath !== "string" || !r.destPath) return null;
  if (!isStructuredFormat(r.destFormat)) return null;
  if (typeof r.status !== "string" || !VALID_STATUSES.includes(r.status as ConvertQueueItemStatus)) return null;
  return {
    id: r.id,
    kind: r.kind as ConvertJobKind,
    sourcePath: r.sourcePath,
    sourceFormat: r.sourceFormat,
    destPath: r.destPath,
    destFormat: r.destFormat,
    acknowledgeLossy: r.acknowledgeLossy === true,
    status: r.status as ConvertQueueItemStatus,
    requestedAt: typeof r.requestedAt === "number" && Number.isFinite(r.requestedAt) ? r.requestedAt : Date.now(),
    startedAt: typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? r.startedAt : null,
    finishedAt: typeof r.finishedAt === "number" && Number.isFinite(r.finishedAt) ? r.finishedAt : null,
    sourceBytes: typeof r.sourceBytes === "number" && Number.isFinite(r.sourceBytes) && r.sourceBytes >= 0 ? r.sourceBytes : null,
    bytesWritten: typeof r.bytesWritten === "number" && Number.isFinite(r.bytesWritten) && r.bytesWritten >= 0 ? r.bytesWritten : null,
    lossy: typeof r.lossy === "boolean" ? r.lossy : null,
    notes: Array.isArray(r.notes) && r.notes.every(n => typeof n === "string") ? r.notes as string[] : null,
    boundary: typeof r.boundary === "string" ? r.boundary : null,
    error: typeof r.error === "string" ? r.error : null,
  };
}

function readFromDisk(): ConvertQueueState {
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
  const items = Array.isArray(rawItems) ? rawItems.map(sanitizeItem).filter((i): i is ConvertQueueItem => i !== null) : [];
  const paused = (parsed as { paused?: unknown }).paused === true;
  return { version: 1, paused, items };
}

let cache: ConvertQueueState | null = null;

/** Always current — hydrates from disk once, then reflects every subsequent in-memory mutation immediately. */
export function getQueueState(): ConvertQueueState {
  if (cache === null) cache = readFromDisk();
  return cache;
}

/** Replaces the in-memory cache. Does not touch disk — call `flushQueueState()` to persist. */
export function setQueueState(next: ConvertQueueState): ConvertQueueState {
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
  const tmp = `${path}.ocx-convert-queue.${process.pid}.${++atomicSeq}.tmp`;
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
export function updateAndFlushQueueState(mutator: (state: ConvertQueueState) => void): ConvertQueueState {
  const state = getQueueState();
  mutator(state);
  flushQueueState();
  return state;
}

/**
 * Test-only: drops the in-memory cache so the next `getQueueState()` call
 * re-reads the file from disk, exactly as a fresh process would. This is how
 * "resume after restart" is exercised without spawning a real second process.
 */
export function resetConvertQueueStoreForTests(): void {
  cache = null;
}
