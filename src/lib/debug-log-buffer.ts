/**
 * Ring buffer of debug log lines for `ocx debug logs` / GUI tailing, mirrored to
 * `logs/opencodex.log` so the same lines survive the process that wrote them.
 *
 * The ring answers "what just happened" quickly; the file answers "what happened
 * before this crash" at all. Both hold the same text, so a line read in Notepad
 * and the same line read in the Debug tab can never disagree.
 */

import { appendAppLogLine, readAppLogTail } from "./app-log-file";

export interface DebugLogEntry {
  /** Monotonic cursor for pagination; survives same-millisecond bursts. */
  seq: number;
  at: number;
  line: string;
}

const MAX_LINES = 2_000;
const buffer: DebugLogEntry[] = [];
const listeners = new Set<(entry: DebugLogEntry) => void>();
let nextSeq = 1;
/** True once hydrateDebugLogFromDisk has run in this process. */
let hydratedFromDisk = false;

export function appendDebugLogLine(line: string): void {
  const entry: DebugLogEntry = { seq: nextSeq++, at: Date.now(), line };
  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  // Best-effort and self-swallowing; see app-log-file.ts. Deliberately before the
  // listeners, so a listener that throws cannot cost the line its durable copy.
  appendAppLogLine(line);
  for (const listener of listeners) {
    try { listener(entry); } catch { /* listeners must not break logging */ }
  }
}

/**
 * Seed the ring from the on-disk log so the Debug tab is not blank after a
 * restart, exactly as `hydrateRequestLogsFromDisk` does for `/api/logs`.
 *
 * Idempotent per process, and a no-op once the ring holds live entries — lines
 * produced by THIS run must never be pushed below replayed history.
 */
export function hydrateDebugLogFromDisk(
  reader: () => { at: number; line: string }[] = () => readAppLogTail(MAX_LINES),
): number {
  if (hydratedFromDisk || buffer.length > 0) {
    hydratedFromDisk = true;
    return 0;
  }
  hydratedFromDisk = true;
  try {
    const replayed = reader();
    for (const entry of replayed.slice(-MAX_LINES)) {
      buffer.push({ seq: nextSeq++, at: entry.at, line: entry.line });
    }
    return Math.min(replayed.length, MAX_LINES);
  } catch {
    return 0;
  }
}

export function getDebugLogEntries(options?: { after?: number; limit?: number }): DebugLogEntry[] {
  const after = options?.after ?? 0;
  const limit = options?.limit ?? 500;
  const filtered = after > 0 ? buffer.filter(entry => entry.seq > after) : buffer;
  if (filtered.length <= limit) return filtered;
  return filtered.slice(-limit);
}

export function subscribeDebugLogEntries(listener: (entry: DebugLogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Drop the replayed/live lines after the on-disk log has been cleared.
 *
 * `seq` deliberately keeps counting rather than restarting at 1: a dashboard
 * polling `?after=<seq>` would otherwise be handed lines it has already shown,
 * as if the clear had never happened.
 */
export function clearDebugLogBuffer(): void {
  buffer.length = 0;
  // A later restore has to be able to replay the file it puts back.
  hydratedFromDisk = false;
}

/** Test isolation. */
export function resetDebugLogBufferForTests(): void {
  buffer.length = 0;
  listeners.clear();
  nextSeq = 1;
  hydratedFromDisk = false;
}
