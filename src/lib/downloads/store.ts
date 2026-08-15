/**
 * Persistence for the download-capture history.
 *
 * Kept deliberately simple next to `authenticator-store.ts`: there are no
 * secrets here (a URL and a filename are not credentials), so there is no ACL
 * hardening to do — only the same atomic temp+rename write every other config
 * file in this codebase uses, so a crash mid-write can never leave `downloads.json`
 * half-written.
 *
 * Progress ticks (`bytesReceived` climbing during an active transfer) are NOT
 * persisted on every chunk — that would turn a fast local download into a
 * disk-write storm. The manager persists on state transitions only
 * (queued→downloading, →paused, →completed, →error, →canceled); progress
 * between those points lives in memory and is rebuilt from `GET
 * /api/downloads/:id` polling, not from the file on disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import { MAX_DOWNLOAD_RECORDS, PRUNE_TO_RECORDS } from "./bounds";
import { TERMINAL_STATES, type DownloadRecord } from "./types";

function storePath(): string {
  return join(getConfigDir(), "downloads.json");
}

interface StoreShape {
  version: 1;
  records: DownloadRecord[];
}

function isDownloadRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.url === "string" && typeof r.state === "string";
}

/**
 * Load the persisted history, reconciling any record a previous process left
 * mid-flight.
 *
 * A record that was `downloading` or `paused` when the process last stopped
 * has no `AbortController` any more — the transfer genuinely stopped, whether
 * the app crashed or was just closed — so it is reported honestly as `error`
 * rather than silently resumed as though nothing happened or left forever
 * claiming to be "downloading" while nothing moves.
 */
export function loadDownloadStore(): DownloadRecord[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  const raw = parsed && typeof parsed === "object" && Array.isArray((parsed as StoreShape).records)
    ? (parsed as StoreShape).records
    : [];
  const now = Date.now();
  return raw.filter(isDownloadRecord).map(record => {
    if (record.state === "downloading" || record.state === "paused") {
      return {
        ...record,
        state: "error" as const,
        error: "Interrupted: opencodex was not running to finish this transfer.",
        updatedAt: now,
      };
    }
    return record;
  });
}

/** Oldest-first among the terminal (finished) records — the ones safe to drop when the history is over its cap. */
function pruneToCap(records: DownloadRecord[]): DownloadRecord[] {
  if (records.length <= MAX_DOWNLOAD_RECORDS) return records;
  const active = records.filter(r => !TERMINAL_STATES.includes(r.state));
  const terminal = records
    .filter(r => TERMINAL_STATES.includes(r.state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const keepTerminal = terminal.slice(0, Math.max(0, PRUNE_TO_RECORDS - active.length));
  const kept = new Set([...active, ...keepTerminal].map(r => r.id));
  return records.filter(r => kept.has(r.id));
}

/**
 * Async signature kept for call-site symmetry with the rest of the manager
 * (`await persist()` reads the same either way), but the write itself is the
 * plain SYNCHRONOUS `atomicWriteFile` — the one `authenticator-store.ts` and
 * every other non-secret config-dir file in this codebase uses. `downloads.json`
 * carries no secret to protect with Windows ACL hardening, and the async
 * variant's hardening step is the one documented as flaky under contention
 * (`windows-secret-acl.ts`); there is no reason to inherit that risk for a
 * file that was never a secret in the first place.
 */
export async function saveDownloadStore(records: DownloadRecord[]): Promise<void> {
  const bounded = pruneToCap(records);
  const body: StoreShape = { version: 1, records: bounded };
  atomicWriteFile(storePath(), JSON.stringify(body, null, 2));
}
