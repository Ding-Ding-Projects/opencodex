/**
 * The Version history timeline compiles the flags the user actually chose.
 *
 * `filterTimeline` was the last shared matcher still building
 * `new RegExp(trimmed, "i")` with its flags pinned, which made the chips in the
 * builder anchored beside that field decorative from the timeline's point of
 * view: they changed the preview inside the popover and then changed nothing
 * about which revisions the screen listed, so a pattern deliberately composed as
 * case-sensitive arrived case-insensitive.
 *
 * The `g` case is the one worth watching fail. Every preset the builder ships
 * sets it, so it arrives here legitimately, and a `g` regex reused down a list
 * carries `lastIndex` between calls — the filter then returns every other
 * matching revision, in an order decided by how the two logs happened to
 * interleave. That is a search which answers differently for the same pattern
 * over the same data, which is worse than one that finds nothing.
 *
 * The rest of these are the behaviours the flags were threaded through *without*
 * disturbing: the trim, the empty query, the 400-character cap, plain text
 * staying case-insensitive, and an unusable pattern matching nothing and saying
 * so rather than degrading to a substring search.
 */

import { expect, test } from "bun:test";
import { PATTERN_CAP, buildTimeline, filterTimeline, type TimelineFilter } from "../src/pages/history-model";
import { DEFAULT_SEARCH_FLAGS } from "../src/shell/settings-search";
import type { Revision } from "../src/shell/revisions";

const BOTH = ["local", "server"] as const;

function filter(over: Partial<TimelineFilter> = {}): TimelineFilter {
  return { scope: "all", origins: BOTH, from: "", to: "", query: "", useRegex: false, ...over };
}

/** Four revisions a minute apart, so the merge order is fixed and readable. */
const ROWS = buildTimeline(
  ([
    { id: "r4", scope: "settings", label: "Row four", summary: "", at: 4_000 },
    { id: "r3", scope: "settings", label: "Row three", summary: "", at: 3_000 },
    { id: "r2", scope: "settings", label: "Row two", summary: "", at: 2_000 },
    { id: "r1", scope: "settings", label: "row one", summary: "", at: 1_000 },
  ] as Revision[]),
  [],
);

const refs = (over: Partial<TimelineFilter>) => filterTimeline(ROWS, filter(over)).rows.map(row => row.ref);

test("a pattern composed as case-sensitive stays case-sensitive", () => {
  // Under the pinned `"i"` both of these returned all four rows, which is the
  // reported defect in one assertion.
  expect(refs({ query: "Row", useRegex: true, flags: "" })).toEqual(["r4", "r3", "r2"]);
  expect(refs({ query: "Row", useRegex: true, flags: "i" })).toEqual(["r4", "r3", "r2", "r1"]);
});

test("an absent flags field still means the case-insensitive `i` it used to hard-code", () => {
  // The field is optional precisely so every caller written before the builder
  // handed flags back keeps the behaviour it already had.
  expect(DEFAULT_SEARCH_FLAGS).toBe("i");
  expect(refs({ query: "Row", useRegex: true })).toEqual(["r4", "r3", "r2", "r1"]);
});

test("a `g` flag does not make the timeline drop every other revision", () => {
  // `lastIndex` survives between calls, so an unstripped `g` keeps r4, skips r3,
  // keeps r2, skips r1 — a result that depends only on the order the rows were
  // tested in.
  expect(refs({ query: "row", useRegex: true, flags: "gi" })).toEqual(["r4", "r3", "r2", "r1"]);
});

test("`y` is dropped for the same reason as `g`", () => {
  expect(refs({ query: "row", useRegex: true, flags: "yi" })).toEqual(["r4", "r3", "r2", "r1"]);
});

test("plain text stays case-insensitive whatever the flags say", () => {
  // The flags describe the regex the builder composes, so they take effect only
  // in the mode that compiles one.
  expect(refs({ query: "Row", flags: "" })).toEqual(["r4", "r3", "r2", "r1"]);
  expect(refs({ query: "  ROW  ", flags: "" })).toEqual(["r4", "r3", "r2", "r1"]);
});

test("carrying flags disturbs neither the trim nor the empty query", () => {
  expect(refs({ query: "  Row three  ", useRegex: true, flags: "i" })).toEqual(["r3"]);
  // An untouched field hides nothing, in either mode and under any flags.
  expect(refs({ query: "", useRegex: true, flags: "" })).toHaveLength(4);
  expect(refs({ query: "   ", useRegex: true, flags: "" })).toHaveLength(4);
});

test("an unusable pattern still matches nothing and reports itself", () => {
  const result = filterTimeline(ROWS, filter({ query: "(unclosed", useRegex: true, flags: "" }));
  expect(result.rows).toHaveLength(0);
  expect(result.patternError).toBeTruthy();
});

test("the 400-character cap still applies before the flags reach the compiler", () => {
  // 400 dots then an unclosed group: uncapped, the group would reach the compiler
  // and this would report an error instead of matching everything.
  const result = filterTimeline(ROWS, filter({ query: ".".repeat(PATTERN_CAP) + "(", useRegex: true, flags: "im" }));
  expect(result.patternError).toBeNull();
});
