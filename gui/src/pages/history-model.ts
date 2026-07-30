/**
 * The two histories, merged.
 *
 * OpenCodex records changes in two completely separate places and, until now, the
 * Version history screen only showed one of them:
 *
 *  1. `shell/revisions.ts` — client-side revisions written by the dashboard as the
 *     user edits providers, accounts, keys, combos and settings. They can carry a
 *     `before` payload, which is the thing a restore writes back.
 *  2. `GET /api/host/history` — the server-side local git history of the config
 *     directory, one commit per account add/remove. Restoring one goes through
 *     `POST /api/host/restore`, which drains in-flight requests, commits the
 *     current state first and restarts the proxy.
 *
 * They answer different questions ("what did I change here?" versus "what does the
 * machine think happened?") and a user chasing a mistake has to read both. This
 * module is the pure half of putting them on one timeline: no React, no copy, so
 * the merge/filter contract can be tested without a DOM.
 */

import type { Revision, RevisionScope } from "../shell/revisions";

/** One snapshot from the local account-change history, as GET /api/host/history reports it. */
export interface StateHistoryEntry {
  hash: string;
  short: string;
  subject: string;
  at: string;
}

/** Which of the two logs an entry came from. Never inferred — always carried. */
export type HistoryOrigin = "local" | "server";

export interface TimelineEntry {
  /** Unique across both origins, so React keys cannot collide between logs. */
  key: string;
  origin: HistoryOrigin;
  /** Epoch ms. Server entries carry an ISO string; it is parsed once, here. */
  at: number;
  /** Primary line: a revision's label, or a commit subject. */
  title: string;
  /** Secondary line: a revision's summary, or the empty string for a snapshot. */
  summary: string;
  /** Mono reference: a revision id, or the short commit hash. */
  ref: string;
  /** Server snapshots are whole-config commits, so they belong to no single scope. */
  scope: RevisionScope | null;
  restored: boolean;
  revision: Revision | null;
  snapshot: StateHistoryEntry | null;
}

/**
 * Server timestamps arrive as strings from git. An unparseable one becomes 0
 * rather than NaN so the entry sorts to the bottom instead of poisoning the sort
 * comparator and scrambling the whole timeline.
 */
function epochOf(at: string): number {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
}

export function localEntry(revision: Revision): TimelineEntry {
  return {
    key: "local:" + revision.id,
    origin: "local",
    at: revision.at,
    title: revision.label,
    summary: revision.summary,
    ref: revision.id,
    scope: revision.scope,
    restored: revision.restored === true,
    revision,
    snapshot: null,
  };
}

export function serverEntry(snapshot: StateHistoryEntry): TimelineEntry {
  return {
    key: "server:" + snapshot.hash,
    origin: "server",
    at: epochOf(snapshot.at),
    title: snapshot.subject,
    summary: "",
    ref: snapshot.short,
    scope: null,
    restored: false,
    revision: null,
    snapshot,
  };
}

/**
 * Newest first across both logs. `snapshots` is deliberately nullable: `null`
 * means the server read failed and is NOT the same as an empty history — the
 * caller renders an error beside the timeline rather than letting a dead proxy
 * look like a machine that has never changed.
 */
export function buildTimeline(
  revisions: readonly Revision[],
  snapshots: readonly StateHistoryEntry[] | null | undefined,
): TimelineEntry[] {
  const merged = revisions.map(localEntry).concat((snapshots ?? []).map(serverEntry));
  return merged.sort((a, b) => b.at - a.at);
}

/** Mirrors the regex builder: a pasted novel can never become a backtracking payload. */
export const PATTERN_CAP = 400;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day. `2026-02-31` parses but is not a date. */
export function isValidIsoDate(value: string): boolean {
  const parts = ISO_DATE.exec(value);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * Day bounds are computed in the viewer's own timezone, because the row beside
 * the filter shows `toLocaleString()`. A UTC bound would drop entries the user
 * can plainly see are inside the range they typed.
 */
function dayBound(value: string, end: boolean): number | null {
  if (!isValidIsoDate(value)) return null;
  const parts = ISO_DATE.exec(value)!;
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (end) date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function dayStart(value: string): number | null { return dayBound(value, false); }
export function dayEnd(value: string): number | null { return dayBound(value, true); }

/** Local-timezone `YYYY-MM-DD`, for the date-range presets. */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export interface TimelineFilter {
  scope: RevisionScope | "all";
  /** Both origins are shown by default; unticking both is an honest empty result. */
  origins: readonly HistoryOrigin[];
  from: string;
  to: string;
  query: string;
  useRegex: boolean;
}

export interface TimelineResult {
  rows: TimelineEntry[];
  /** Set only when regex mode is on and the pattern does not compile. */
  patternError: string | null;
}

/**
 * An invalid pattern matches nothing and says so, rather than silently falling
 * back to plain text and showing rows the user did not ask for. An invalid *date*
 * is simply not applied — the typed text stays in the field and the screen keeps
 * working, which is the behaviour the changelog filter already established.
 */
export function filterTimeline(entries: readonly TimelineEntry[], filter: TimelineFilter): TimelineResult {
  const { scope, origins, from, to, query, useRegex } = filter;

  let matcher: (text: string) => boolean;
  const trimmed = query.trim();
  if (!trimmed) {
    matcher = () => true;
  } else if (useRegex) {
    try {
      const re = new RegExp(trimmed.slice(0, PATTERN_CAP), "i");
      matcher = text => re.test(text);
    } catch (e) {
      return { rows: [], patternError: e instanceof Error ? e.message : String(e) };
    }
  } else {
    const needle = trimmed.toLowerCase();
    matcher = text => text.toLowerCase().includes(needle);
  }

  const lo = dayStart(from);
  const hi = dayEnd(to);

  const rows = entries.filter(entry => {
    if (!origins.includes(entry.origin)) return false;
    // A whole-config snapshot has no scope, so narrowing to one scope excludes it
    // rather than pretending the commit was about providers.
    if (scope !== "all" && entry.scope !== scope) return false;
    if (lo !== null && entry.at < lo) return false;
    if (hi !== null && entry.at > hi) return false;
    return matcher(entry.title + " " + entry.summary + " " + entry.ref);
  });

  return { rows, patternError: null };
}

export interface PayloadRow {
  path: string;
  value: string;
}

const MAX_PAYLOAD_ROWS = 400;
const MAX_PAYLOAD_DEPTH = 6;

function walk(value: unknown, path: string, out: PayloadRow[], depth: number): void {
  if (out.length >= MAX_PAYLOAD_ROWS) return;
  if (value !== null && typeof value === "object" && depth < MAX_PAYLOAD_DEPTH) {
    const pairs: [string, unknown][] = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>);
    if (pairs.length === 0) {
      out.push({ path, value: Array.isArray(value) ? "[]" : "{}" });
      return;
    }
    for (const [k, v] of pairs) walk(v, path ? path + "." + k : k, out, depth + 1);
    return;
  }
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  out.push({ path, value: rendered ?? String(value) });
}

/**
 * A captured `before` is JSON far more often than not, and dumping it as one
 * unwrapped blob is the reason the old pane was unreadable. Flattened to
 * `path → value` rows it reads like a settings list, which is what it is.
 *
 * Returns `null` when the payload is not a JSON object or array — a bare string
 * or a non-JSON snapshot has no structure to show and the caller falls back to
 * preformatted text rather than inventing one.
 */
export function flattenPayload(raw: string): PayloadRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const out: PayloadRow[] = [];
  walk(parsed, "", out, 0);
  return out.length ? out : null;
}
