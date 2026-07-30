/**
 * The merge/filter contract behind Version history.
 *
 * These are the invariants that decide whether the screen tells the truth: the
 * two logs interleave strictly by time, a whole-config git snapshot is not
 * pretended to belong to one scope, an unparseable server timestamp must not
 * scramble the sort, an invalid pattern matches nothing rather than silently
 * degrading to plain text, and the pattern is capped before it is compiled.
 */

import { expect, test } from "bun:test";
import {
  PATTERN_CAP, buildTimeline, filterTimeline, flattenPayload, isValidIsoDate, isoDay,
  type StateHistoryEntry, type TimelineFilter,
} from "../src/pages/history-model";
import type { Revision } from "../src/shell/revisions";

const BOTH = ["local", "server"] as const;

const REVISIONS: Revision[] = [
  { id: "r2", scope: "settings", label: "Appearance", summary: "Seed colour changed", at: 3_000 },
  { id: "r1", scope: "provider", label: "groq", summary: "Provider added", at: 1_000, before: "{\"base\":\"https://api.groq.com\"}" },
];

const SNAPSHOTS: StateHistoryEntry[] = [
  { hash: "aaaaaaaaaaaa", short: "aaaaaaa", subject: "Add Codex account", at: new Date(2_000).toISOString() },
  { hash: "bbbbbbbbbbbb", short: "bbbbbbb", subject: "Remove API key", at: new Date(4_000).toISOString() },
];

function filter(over: Partial<TimelineFilter> = {}): TimelineFilter {
  return { scope: "all", origins: BOTH, from: "", to: "", query: "", useRegex: false, ...over };
}

test("both logs interleave by time, newest first, each keeping its origin", () => {
  const rows = buildTimeline(REVISIONS, SNAPSHOTS);
  expect(rows.map(r => r.key)).toEqual([
    "server:bbbbbbbbbbbb", "local:r2", "server:aaaaaaaaaaaa", "local:r1",
  ]);
  expect(rows.map(r => r.origin)).toEqual(["server", "local", "server", "local"]);
  // The refs a user reads are the revision id and the short hash, never the internal key.
  expect(rows.map(r => r.ref)).toEqual(["bbbbbbb", "r2", "aaaaaaa", "r1"]);
});

test("a failed server read is an absent list, not an empty one — the client log still renders", () => {
  expect(buildTimeline(REVISIONS, null).map(r => r.key)).toEqual(["local:r2", "local:r1"]);
  expect(buildTimeline(REVISIONS, undefined)).toHaveLength(2);
});

test("an unparseable server timestamp sinks to the bottom instead of scrambling the sort", () => {
  const broken: StateHistoryEntry = { hash: "cccccccccccc", short: "ccccccc", subject: "Broken date", at: "not a date" };
  const rows = buildTimeline(REVISIONS, [broken, ...SNAPSHOTS]);
  expect(rows.map(r => r.ref)).toEqual(["bbbbbbb", "r2", "aaaaaaa", "r1", "ccccccc"]);
});

test("narrowing to a scope drops git snapshots, which belong to no single scope", () => {
  const rows = buildTimeline(REVISIONS, SNAPSHOTS);
  expect(filterTimeline(rows, filter({ scope: "provider" })).rows.map(r => r.ref)).toEqual(["r1"]);
  // Both snapshots and both revisions survive when no scope is chosen.
  expect(filterTimeline(rows, filter()).rows).toHaveLength(4);
});

test("origin toggles hide a whole log, and unticking both is an honest empty result", () => {
  const rows = buildTimeline(REVISIONS, SNAPSHOTS);
  expect(filterTimeline(rows, filter({ origins: ["local"] })).rows.map(r => r.ref)).toEqual(["r2", "r1"]);
  expect(filterTimeline(rows, filter({ origins: ["server"] })).rows.map(r => r.ref)).toEqual(["bbbbbbb", "aaaaaaa"]);
  expect(filterTimeline(rows, filter({ origins: [] })).rows).toHaveLength(0);
});

test("the date range is inclusive of both whole days, in the viewer's own timezone", () => {
  const day = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).getTime();
  const rows = buildTimeline(
    [
      { id: "early", scope: "key", label: "Early", summary: "", at: day(2026, 7, 1, 0) },
      { id: "mid", scope: "key", label: "Mid", summary: "", at: day(2026, 7, 2, 13) },
      { id: "late", scope: "key", label: "Late", summary: "", at: day(2026, 7, 3, 23) },
    ],
    [],
  );
  expect(filterTimeline(rows, filter({ from: "2026-07-02" })).rows.map(r => r.ref)).toEqual(["late", "mid"]);
  expect(filterTimeline(rows, filter({ to: "2026-07-02" })).rows.map(r => r.ref)).toEqual(["mid", "early"]);
  expect(filterTimeline(rows, filter({ from: "2026-07-02", to: "2026-07-02" })).rows.map(r => r.ref)).toEqual(["mid"]);
  // An invalid date is not applied, so the screen keeps working while it is typed.
  expect(filterTimeline(rows, filter({ from: "2026-02-31" })).rows).toHaveLength(3);
});

test("2026-02-31 parses as a Date but is not a day", () => {
  expect(isValidIsoDate("2026-07-02")).toBe(true);
  expect(isValidIsoDate("2026-02-31")).toBe(false);
  expect(isValidIsoDate("2026-7-2")).toBe(false);
  expect(isValidIsoDate("")).toBe(false);
  expect(isoDay(new Date(2026, 0, 5))).toBe("2026-01-05");
});

test("search covers the label, the summary and the commit subject", () => {
  const rows = buildTimeline(REVISIONS, SNAPSHOTS);
  expect(filterTimeline(rows, filter({ query: "codex" })).rows.map(r => r.ref)).toEqual(["aaaaaaa"]);
  expect(filterTimeline(rows, filter({ query: "provider added" })).rows.map(r => r.ref)).toEqual(["r1"]);
});

test("an invalid pattern matches nothing and reports itself rather than degrading to plain text", () => {
  const rows = buildTimeline(REVISIONS, SNAPSHOTS);
  const result = filterTimeline(rows, filter({ query: "(unclosed", useRegex: true }));
  expect(result.rows).toHaveLength(0);
  expect(result.patternError).toBeTruthy();
  // Plain text is still the default: the same string finds nothing but does not error.
  expect(filterTimeline(rows, filter({ query: "(unclosed" })).patternError).toBeNull();
});

test("the pattern is capped at 400 characters before it is compiled", () => {
  const rows = buildTimeline(REVISIONS, []);
  // 400 dots then an unclosed group: if the cap were not applied the group would
  // reach the compiler and this would be an error instead of a match.
  const pattern = ".".repeat(PATTERN_CAP) + "(";
  const result = filterTimeline(rows, filter({ query: pattern, useRegex: true }));
  expect(result.patternError).toBeNull();
});

test("a JSON payload flattens to dotted paths; anything else keeps its raw text", () => {
  expect(flattenPayload("{\"a\":{\"b\":1},\"c\":[\"x\"],\"d\":{}}")).toEqual([
    { path: "a.b", value: "1" },
    { path: "c.0", value: "x" },
    { path: "d", value: "{}" },
  ]);
  expect(flattenPayload("Seed colour changed")).toBeNull();
  expect(flattenPayload("42")).toBeNull();
  expect(flattenPayload("not json {")).toBeNull();
});
