/** In-memory debug ring mirrored to the bounded app log on disk. */

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
let hydratedFromDisk = false;

export function appendDebugLogLine(line: string): void {
  const entry: DebugLogEntry = { seq: nextSeq++, at: Date.now(), line };
  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  appendAppLogLine(line);
  for (const listener of listeners) {
    try { listener(entry); } catch { /* listeners must not break logging */ }
  }
}

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

export function clearDebugLogBuffer(): void {
  buffer.length = 0;
  hydratedFromDisk = false;
}

/** Test isolation. */
export function resetDebugLogBufferForTests(): void {
  buffer.length = 0;
  listeners.clear();
  nextSeq = 1;
  hydratedFromDisk = false;
}
