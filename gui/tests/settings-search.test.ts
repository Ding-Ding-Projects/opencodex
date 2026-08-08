/**
 * The shared settings search, at the level where the matching actually happens.
 *
 * These guard the defects that made twenty-two hand-wired search bars worth
 * replacing with one component:
 *
 *  - a search that only looked at labels, so a setting was unfindable by the
 *    value it was currently set to;
 *  - a match on another tab reported as "no such setting", which is how a user
 *    concludes a feature does not exist while looking at the screen that has it;
 *  - regex silently on, so a plain-text query with a `.` in it matched rows the
 *    user never asked for;
 *  - an invalid pattern throwing, or worse, quietly falling back to plain text so
 *    the error line and the visible rows disagreed;
 *  - and the `g` flag, which makes `RegExp.test` stateful and drops every other
 *    matching setting depending only on what order they happen to be listed in.
 */

import { expect, test } from "bun:test";
import { PATTERN_CAP, SAMPLE_CAP } from "../src/regex/engine";
import { optionText, runSettingsSearch, settingsMatcher } from "../src/shell/settings-search";
import type { SettingsOption } from "../src/shell/settings-search";

const OPTIONS: SettingsOption[] = [
  { id: "theme", label: "Theme", desc: "Light, dark or follow the system", value: "Dark" },
  { id: "density", label: "Density", desc: "How tightly rows are packed", value: "3" },
  { id: "cleanup", label: "Automatic cleanup", desc: "Delete archived files", value: "Weekly" },
  { id: "narrator", label: "Narrator", desc: "Spoken narration", value: "Off" },
];

const run = (query: string, useRegex = false, extra: Partial<Parameters<typeof runSettingsSearch>[0]> = {}) =>
  runSettingsSearch({ options: OPTIONS, query, useRegex, ...extra });

const ids = (result: { visible: SettingsOption[] }) => result.visible.map(option => option.id);

/* ------------------------------------------------- the surface filters its own -- */

test("an untouched field hides nothing", () => {
  const result = run("");
  expect(result.active).toBe(false);
  expect(ids(result)).toEqual(["theme", "density", "cleanup", "narrator"]);
  expect(result.matches("theme")).toBe(true);
});

test("a query narrows the surface to the options it matched", () => {
  const result = run("density");
  expect(ids(result)).toEqual(["density"]);
  expect(result.hits).toBe(1);
  expect(result.total).toBe(4);
  expect(result.matches("theme")).toBe(false);
});

// The defect: a search over labels alone. A user who remembers setting cleanup to
// "weekly" but not what the control was called finds nothing and concludes the
// setting is gone.
test("a setting is findable by its current value, not only by its name", () => {
  expect(ids(run("weekly"))).toEqual(["cleanup"]);
  expect(ids(run("dark"))).toEqual(["theme"]);
});

test("a setting is findable by its description", () => {
  expect(ids(run("archived files"))).toEqual(["cleanup"]);
});

// Option labels inside a select are what a user remembers seeing, and they are
// not the control's own name.
test("a setting is findable by the choices its control offers", () => {
  const withKeywords: SettingsOption[] = [
    { id: "schedule", label: "Cleanup schedule", value: "Manual", keywords: "At startup Daily Weekly Manual" },
  ];
  const result = runSettingsSearch({ options: withKeywords, query: "daily", useRegex: false });
  expect(ids(result)).toEqual(["schedule"]);
});

test("matching ignores case in plain-text mode", () => {
  expect(ids(run("DENSITY"))).toEqual(["density"]);
});

/* --------------------------------------------- a match elsewhere is reported -- */

// The whole point of the cross-tab note: hiding an off-tab hit is indistinguishable
// from the setting not existing.
test("a match on another tab of this surface is counted and its tab named", () => {
  const tabbed: SettingsOption[] = [
    { id: "port", label: "Port", tab: "Connection" },
    { id: "data-key", label: "Data-plane key", tab: "Security" },
  ];
  const result = runSettingsSearch({ options: tabbed, activeTab: "Connection", query: "data-plane", useRegex: false });

  expect(result.hits).toBe(0);
  expect(result.otherTabHits).toBe(1);
  expect(result.otherTabs).toEqual(["Security"]);
  // It matched — it is simply not on screen. A surface that asked `matches` would
  // otherwise be told the setting failed the query.
  expect(result.matches("data-key")).toBe(true);
});

test("an option with no tab is visible whatever tab is showing", () => {
  const mixed: SettingsOption[] = [
    { id: "global", label: "Language mode" },
    { id: "scoped", label: "Language mode override", tab: "Advanced" },
  ];
  const result = runSettingsSearch({ options: mixed, activeTab: "Basics", query: "language", useRegex: false });
  expect(ids(result)).toEqual(["global"]);
  expect(result.otherTabs).toEqual(["Advanced"]);
});

test("a hit on another surface is reported separately from one on another tab", () => {
  const result = run("narration", false, {
    elsewhere: [{ label: "Spoken narration voice", tab: "Language & voice" }],
  });
  expect(result.elsewhereHits).toBe(1);
  expect(result.elsewhereTabs).toEqual(["Language & voice"]);
});

// An untouched field has not matched anything, here or anywhere else, so claiming
// neighbours before a single character is typed is noise.
test("no cross-surface hits are claimed while the field is empty", () => {
  const result = run("", false, { elsewhere: [{ label: "Anything", tab: "Somewhere" }] });
  expect(result.elsewhereHits).toBe(0);
});

// The same rule for the off-tab note, and it was got wrong first time round: an
// empty query matches every option, so a tabbed surface announced "3 match(es) on
// another tab" from the moment it loaded — a result for a search nobody had run.
test("no off-tab hits are claimed while the field is empty", () => {
  const tabbed: SettingsOption[] = [
    { id: "here", label: "Alpha", tab: "One" },
    { id: "there", label: "Beta", tab: "Two" },
  ];
  const result = runSettingsSearch({ options: tabbed, activeTab: "One", query: "", useRegex: false });
  expect(result.otherTabHits).toBe(0);
  expect(result.otherTabs).toEqual([]);
  // The visible tab still shows everything it owns — the fix must not hide rows.
  expect(result.visible.map(option => option.id)).toEqual(["here"]);
});

// Whitespace is not a query. Trimming to nothing has to behave exactly like empty,
// or a stray space in the field revives the same phantom claim.
test("a whitespace-only query claims nothing either", () => {
  const tabbed: SettingsOption[] = [
    { id: "here", label: "Alpha", tab: "One" },
    { id: "there", label: "Beta", tab: "Two" },
  ];
  const result = runSettingsSearch({ options: tabbed, activeTab: "One", query: "   ", useRegex: false });
  expect(result.active).toBe(false);
  expect(result.otherTabHits).toBe(0);
});

/* --------------------------------------------------- plain text is the default -- */

// `.` is a literal until the user opts in. Regex-by-default would have "3.5" match
// "395" and the user would never know why.
test("regex metacharacters are literal until regex mode is switched on", () => {
  const dotted: SettingsOption[] = [
    { id: "exact", label: "Model gpt-3.5" },
    { id: "wrong", label: "Model gpt-395" },
  ];
  expect(runSettingsSearch({ options: dotted, query: "gpt-3.5", useRegex: false }).visible.map(o => o.id))
    .toEqual(["exact"]);
  expect(runSettingsSearch({ options: dotted, query: "gpt-3.5", useRegex: true }).visible.map(o => o.id))
    .toEqual(["exact", "wrong"]);
});

test("regex mode matches by pattern", () => {
  expect(ids(run("dark|spoken", true))).toEqual(["theme", "narrator"]);
});

// Worth pinning: a pattern is run over one joined string per option — label,
// description, value and keywords together — so `^` anchors to the start of the
// label and `$` to the end of the value, not to the end of the label. Someone
// writing `^Theme$` and getting nothing is not looking at a bug.
test("a pattern is matched against the option's whole searchable text", () => {
  expect(ids(run("^Theme\\b", true))).toEqual(["theme"]);
  expect(ids(run("^Theme$", true))).toEqual([]);
});

/* ------------------------------------------------- invalid patterns are reported -- */

test("an invalid pattern reports the engine's own words instead of throwing", () => {
  const result = run("model(", true);
  expect(result.error).toBeTruthy();
  expect(typeof result.error).toBe("string");
});

// Falling back to plain text on a bad pattern would leave the error line saying
// one thing and the visible rows showing another.
test("an invalid pattern matches nothing rather than falling back to plain text", () => {
  const result = run("Theme(", true);
  expect(result.hits).toBe(0);
  expect(result.matches("theme")).toBe(false);
});

test("a valid pattern reports no error", () => {
  expect(run("theme", true).error).toBeNull();
});

/* -------------------------------------------------------------- flag handling -- */

// The defect this prevents: `g` and `y` carry `lastIndex` between calls, so testing
// one regex across a list returns true, false, true, false. Half the matching
// settings vanish, and which half depends only on their order.
test("a g-flagged pattern still matches every option, not every other one", () => {
  const many: SettingsOption[] = ["a", "b", "c", "d"].map(id => ({ id, label: `Setting ${id}` }));
  const result = runSettingsSearch({ options: many, query: "Setting", useRegex: true, flags: "gi" });
  expect(result.visible.map(o => o.id)).toEqual(["a", "b", "c", "d"]);
});

test("a sticky pattern is likewise not order-dependent", () => {
  const many: SettingsOption[] = ["a", "b", "c"].map(id => ({ id, label: `Setting ${id}` }));
  const result = runSettingsSearch({ options: many, query: "Setting", useRegex: true, flags: "y" });
  expect(result.visible.map(o => o.id)).toEqual(["a", "b", "c"]);
});

test("flags the user chose are honoured in regex mode", () => {
  const cased: SettingsOption[] = [{ id: "upper", label: "THEME" }];
  // Without `i` the lower-case query must miss; with it, it must hit.
  expect(runSettingsSearch({ options: cased, query: "theme", useRegex: true, flags: "" }).hits).toBe(0);
  expect(runSettingsSearch({ options: cased, query: "theme", useRegex: true, flags: "i" }).hits).toBe(1);
});

// Plain text is a substring search over visible labels; punishing someone for
// typing "weekly" instead of "Weekly" would be a worse search, not a stricter one.
test("plain text stays case-insensitive whatever the flags say", () => {
  expect(runSettingsSearch({ options: OPTIONS, query: "WEEKLY", useRegex: false, flags: "" }).hits).toBe(1);
});

/* -------------------------------------------------------------------- bounds -- */

test("an over-long pattern is capped rather than compiled whole", () => {
  // `a{1}` repeated past the cap: if the cap were not applied the trailing brace
  // would still parse, so the assertion is on the cap being reached at all.
  const long = "a".repeat(PATTERN_CAP + 50);
  const matcher = settingsMatcher(long, true);
  expect(matcher.error).toBeNull();
  expect(matcher.test("a".repeat(PATTERN_CAP))).toBe(true);
});

test("the builder sample is bounded so a large surface cannot paste a novel into the panel", () => {
  const huge: SettingsOption[] = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i),
    label: `Setting number ${i}`,
    desc: "x".repeat(40),
  }));
  const result = runSettingsSearch({ options: huge, query: "", useRegex: false });
  expect(result.sample.length).toBeLessThanOrEqual(SAMPLE_CAP);
});

// The sample exists so a half-written pattern can be tried against the real
// corpus; seeding it with only the rows that pattern already matched would hide
// exactly the rows the user is still trying to reach.
test("the sample is the whole surface, not the rows the current query survived", () => {
  const result = run("density");
  expect(result.sample).toContain("Narrator");
  expect(result.sample).toContain("Automatic cleanup");
});

test("optionText joins every searchable field and skips the absent ones", () => {
  expect(optionText({ id: "a", label: "Label", value: "Value" })).toBe("Label Value");
  expect(optionText({ id: "b", label: "Only" })).toBe("Only");
});
