/**
 * Clearing the logs, and putting them back.
 *
 * Two files hold everything the dashboard's Logs screen shows:
 *
 *  - `usage.jsonl` — one JSON row per request, what `/api/logs` and the Usage
 *    screen are both built from, and
 *  - `logs/opencodex.log` (plus its rotated generations) — the app's own diagnostic
 *    lines, what the Debug tab tails.
 *
 * Both are deleted together, because deleting only one produces a state nobody
 * asked for: clear the rows and the diagnostics still name them, or clear the
 * diagnostics and the rows come back on the next restart via hydration. "Clear
 * logs" has to mean the logs.
 *
 * **The snapshot happens first.** `recordLogSnapshotBeforeDelete` commits the
 * bytes into the local git history and is awaited, so by the time anything is
 * unlinked the content is already recoverable. A post-hoc commit could not do
 * this — it would record the absence, and recovery would depend on some earlier
 * commit happening to contain the rows, which is not true for the first clear a
 * machine ever performs.
 *
 * **A failed snapshot does not fail the clear.** If git is missing, the index is
 * locked, or the commit times out, the deletion still runs and the caller is told
 * `snapshot: false`. A user who pressed "clear logs" gets their logs cleared;
 * refusing on the grounds that the bookkeeping repo was busy would be a worse
 * outcome than an honestly-reported gap in the history.
 *
 * **Restoring appends.** It commits the current logs first, writes the chosen
 * revision over them, and commits that too — so the undo is itself undoable, and
 * a user can go back and forth between two states without ever losing one.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { getConfigDir } from "../config";
import { usageLogPath } from "../usage/log";
import { clearAppLogFiles, measureAppLogFiles, type AppLogFootprint } from "./app-log-file";
import { recordLogSnapshotBeforeDelete, restoreLogsFromHistory, type StateRestoreResult } from "./state-history";

/** What is on disk right now, so a confirmation can name it before destroying it. */
export interface LogFootprint {
  /** Rows in usage.jsonl — the request log the Logs screen lists. */
  requestRows: number;
  /** Lines across every generation of the app log. */
  appLines: number;
  bytes: number;
}

function countUsageRows(path: string): { rows: number; bytes: number } {
  if (!existsSync(path)) return { rows: 0, bytes: 0 };
  try {
    const text = readFileSync(path, "utf-8");
    return {
      rows: text.split(/\r?\n/).filter(line => line.trim()).length,
      bytes: Buffer.byteLength(text, "utf-8"),
    };
  } catch {
    // Unreadable is not empty. Reporting 0 would let the dialog promise a
    // no-op delete for a file that is about to be removed regardless.
    return { rows: 0, bytes: 0 };
  }
}

export function measurePersistedLogs(configDir: string = getConfigDir()): LogFootprint {
  const usage = countUsageRows(usageLogPath(configDir));
  const app: AppLogFootprint = measureAppLogFiles(configDir);
  return { requestRows: usage.rows, appLines: app.lines, bytes: usage.bytes + app.bytes };
}

/**
 * The revision label.
 *
 * Names WHAT changed, with the counts, rather than that something did. A history
 * panel whose every row says "Updated" is a list nobody can navigate, and the
 * counts are the only thing that lets a user tell one clear from another when
 * they are looking for the one that took the rows they want back.
 */
export function describeLogClear(footprint: LogFootprint): string {
  const parts: string[] = [];
  if (footprint.requestRows > 0) {
    parts.push(`${footprint.requestRows.toLocaleString("en-US")} request log row${footprint.requestRows === 1 ? "" : "s"}`);
  }
  if (footprint.appLines > 0) {
    parts.push(`${footprint.appLines.toLocaleString("en-US")} app log line${footprint.appLines === 1 ? "" : "s"}`);
  }
  return parts.length ? `cleared ${parts.join(" and ")}` : "cleared the logs (already empty)";
}

export interface ClearLogsResult {
  ok: true;
  /** Whether the pre-delete commit actually landed. False is reported, never hidden. */
  snapshot: boolean;
  /** The commit now holding the deleted logs, when one was made. */
  commit: string | null;
  /** The subject that commit carries, which is also the history row's label. */
  label: string;
  removed: LogFootprint;
}

/**
 * Snapshot, then delete. In that order, and the order is the entire point.
 *
 * `reload` re-seeds the in-memory rings from what is now on disk. It is injected
 * so this module stays free of the server's process state and the tests can
 * observe the sequencing directly.
 */
export async function clearPersistedLogs(options?: {
  configDir?: string;
  reload?: () => void;
  /** Injected in tests to prove a failing history write does not fail the delete. */
  snapshot?: (reason: string, configDir: string) => Promise<string | null>;
}): Promise<ClearLogsResult> {
  const configDir = options?.configDir ?? getConfigDir();
  const removed = measurePersistedLogs(configDir);
  const label = describeLogClear(removed);

  let commit: string | null = null;
  try {
    const take = options?.snapshot ?? ((reason, dir) => recordLogSnapshotBeforeDelete(reason, dir));
    commit = await take(label, configDir);
  } catch {
    // Deliberately swallowed. The user asked for their logs to be cleared, not
    // for a report on the health of the history repository; they get `snapshot:
    // false` and the clear they asked for.
    commit = null;
  }

  try { rmSync(usageLogPath(configDir), { force: true }); } catch { /* a locked file survives; the rest still go */ }
  clearAppLogFiles(configDir);
  options?.reload?.();

  return { ok: true, snapshot: commit !== null, commit, label, removed };
}

export interface RestoreLogsResult extends StateRestoreResult {
  /** What is on disk after the restore, so the caller can report a real number. */
  footprint: LogFootprint;
}

/** Put a log revision back, appending two commits so the undo stays undoable. */
export async function restorePersistedLogs(
  commit: string,
  options?: { configDir?: string; reload?: () => void },
): Promise<RestoreLogsResult> {
  const configDir = options?.configDir ?? getConfigDir();
  const result = await restoreLogsFromHistory(commit, configDir);
  // Re-seed even on failure: a failed checkout may still have written some of
  // the paths, and rings that disagree with disk are worse than either state.
  options?.reload?.();
  return { ...result, footprint: measurePersistedLogs(configDir) };
}
