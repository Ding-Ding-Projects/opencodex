/**
 * The changelog: parsing the real file, filtering it, and exporting what was
 * filtered.
 *
 * Two kinds of assertion, and both are needed.
 *
 * The fixtures pin the rules — a heading without a date, an entry that is not a
 * conventional commit, a date bound that excludes an undated release — because
 * those are the cases the real file happens not to contain today and would
 * therefore never be exercised.
 *
 * The real `CHANGELOG.md` is parsed too, because a viewer whose promise is
 * "every released version" fails in exactly one way that a fixture cannot catch:
 * the generator changes its heading format, the parser silently matches fewer
 * headings, and the page renders a shorter list with no error anywhere. So the
 * count is checked against the file's own `## ` lines rather than a number
 * written here, which stays true as releases are added.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  OPEN_RANGE,
  classify,
  countEntries,
  filterReleases,
  groupByKind,
  inRange,
  isIsoDate,
  monthGrid,
  parseChangelog,
  toMarkdown,
  type Release,
} from "../src/lib/changelog";

const FIXTURE = `# Changelog

Some preamble that is not a release.

## 2.0.0 — 2026-03-04

- feat(gui): add the thing
- fix(cli): stop the other thing
- a line with no conventional prefix

## 1.9.9

- chore: undated release, on purpose

## 1.0.0 — 2025-01-31

- docs(readme): write it down
`;

const releases = parseChangelog(FIXTURE);

describe("parsing", () => {
  test("finds every release, newest first, preamble excluded", () => {
    expect(releases.map(r => r.version)).toEqual(["2.0.0", "1.9.9", "1.0.0"]);
  });

  test("keeps a release whose heading carries no date", () => {
    // Dropping it would silently remove a version from a viewer whose entire
    // promise is "every released version".
    expect(releases[1]).toMatchObject({ version: "1.9.9", date: null });
    expect(releases[1].entries).toHaveLength(1);
  });

  test("classifies conventional commits and does not invent a type for the rest", () => {
    expect(classify("feat(gui): x")).toEqual({ kind: "feat", scope: "gui" });
    expect(classify("fix: x")).toEqual({ kind: "fix", scope: null });
    expect(classify("build(ci): x")).toEqual({ kind: "ci", scope: "ci" });
    expect(classify("feat(gui)!: breaking")).toEqual({ kind: "feat", scope: "gui" });
    expect(classify("just a sentence")).toEqual({ kind: "other", scope: null });
  });

  test("groups by category in a fixed order, skipping empty ones", () => {
    const grouped = groupByKind(releases[0].entries);
    expect(grouped.map(g => g.kind)).toEqual(["feat", "fix", "other"]);
  });
});

describe("the real CHANGELOG.md", () => {
  const raw = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const real = parseChangelog(raw);

  test("every `## ` heading in the file becomes a release", () => {
    const headings = raw.split(/\r?\n/).filter(line => line.startsWith("## ")).length;
    expect(real.length).toBe(headings);
    expect(real.length).toBeGreaterThan(50);
  });

  test("every release has a version and at least one entry", () => {
    for (const release of real) {
      expect(`${release.version}:${release.entries.length > 0}`).toBe(`${release.version}:true`);
    }
  });

  test("every date the file records is a real calendar date", () => {
    for (const release of real) {
      if (release.date === null) continue;
      expect(`${release.version}:${isIsoDate(release.date)}`).toBe(`${release.version}:true`);
    }
  });
});

describe("date validation", () => {
  test("accepts a real date and rejects a plausible one that is not", () => {
    expect(isIsoDate("2026-07-31")).toBe(true);
    // The shape test alone accepts this; `Date` rolls it forward to 2 March, so
    // a filter built on the shape would use a bound nobody typed.
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-7-1")).toBe(false);
    expect(isIsoDate("yesterday")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  test("range comparison is inclusive at both ends", () => {
    expect(inRange("2026-03-04", { from: "2026-03-04", to: "2026-03-04" })).toBe(true);
    expect(inRange("2026-03-03", { from: "2026-03-04", to: "" })).toBe(false);
    expect(inRange("2026-03-05", { from: "", to: "2026-03-04" })).toBe(false);
  });

  test("an undated release survives an open range and no other", () => {
    expect(inRange(null, OPEN_RANGE)).toBe(true);
    expect(inRange(null, { from: "2020-01-01", to: "" })).toBe(false);
  });
});

describe("the two filters compose", () => {
  const has = (needle: string) => (value: string) => value.toLowerCase().includes(needle);

  test("no filters shows everything", () => {
    const rows = filterReleases(releases, OPEN_RANGE, null);
    expect(rows).toHaveLength(3);
    expect(countEntries(rows)).toBe(5);
  });

  test("text alone narrows to matching entries and reports what it hid", () => {
    const rows = filterReleases(releases, OPEN_RANGE, has("thing"));
    expect(rows).toHaveLength(1);
    expect(rows[0].entries).toHaveLength(2);
    expect(rows[0].hidden).toBe(1);
  });

  test("a version match keeps the whole release", () => {
    const rows = filterReleases(releases, OPEN_RANGE, has("1.0.0"));
    expect(rows).toHaveLength(1);
    expect(rows[0].byVersion).toBe(true);
    expect(rows[0].entries).toHaveLength(1);
  });

  test("date and text are ANDed, not ORed", () => {
    const rows = filterReleases(releases, { from: "2026-01-01", to: "" }, has("write it down"));
    // The entry matches, but its release is from 2025 — so nothing survives.
    expect(rows).toHaveLength(0);
  });

  test("an unrunnable pattern means no text filter, never a match-nothing", () => {
    // The viewer passes `null` when the query is empty or will not compile. An
    // empty list there would look exactly like a genuine no-match, and the
    // reader would go hunting for a release that is right in front of them.
    expect(filterReleases(releases, OPEN_RANGE, null)).toHaveLength(3);
  });
});

describe("the export is the screen", () => {
  const meta = {
    title: "Changelog",
    range: "from 2026-01-01",
    search: "thing",
    note: "Range: from 2026-01-01. Search: thing.",
    undated: "no date recorded",
  };

  test("only the filtered rows and only the matching entries are written", () => {
    const rows = filterReleases(releases, OPEN_RANGE, (value: string) => value.includes("thing"));
    const out = toMarkdown(rows, meta);
    expect(out).toContain("## 2.0.0 — 2026-03-04");
    expect(out).toContain("- feat(gui): add the thing");
    expect(out).not.toContain("1.0.0");
    // The entry the search hid must not reappear in the file.
    expect(out).not.toContain("no conventional prefix");
  });

  test("the file states what was excluded", () => {
    // An extract with no statement of its filter will later be read as complete.
    expect(toMarkdown([], meta)).toContain(meta.note);
  });

  test("an undated release exports with the translated placeholder", () => {
    const rows = filterReleases([releases[1]] as Release[], OPEN_RANGE, null);
    expect(toMarkdown(rows, meta)).toContain("## 1.9.9 — no date recorded");
  });
});

describe("calendar grid", () => {
  test("is always six full weeks, so the controls under it never move", () => {
    for (const [year, month] of [[2026, 0], [2026, 1], [2024, 1], [2026, 7]] as const) {
      expect(monthGrid(year, month)).toHaveLength(42);
    }
  });

  test("starts on the Monday on or before the first of the month", () => {
    // 1 February 2026 is a Sunday, so the grid opens on 26 January.
    expect(monthGrid(2026, 1)[0].iso).toBe("2026-01-26");
    expect(monthGrid(2026, 1)[0].outside).toBe(true);
  });

  test("marks the month's own days as inside", () => {
    const grid = monthGrid(2026, 1);
    const first = grid.find(day => day.iso === "2026-02-01");
    expect(first?.outside).toBe(false);
  });

  test("a leap day is present and dated correctly", () => {
    expect(monthGrid(2024, 1).some(day => day.iso === "2024-02-29")).toBe(true);
  });
});

/**
 * The changelog exports in every coding format, not only Markdown.
 *
 * `Changelog.tsx` is `client:only`, so it never appears in the built HTML and a
 * dist grep proves nothing about it either way. What is checkable — and what
 * actually matters — is that it reaches for the shared serialisers rather than
 * growing its own, and that the format list it offers is the same one the app
 * and the CLI offer.
 */
describe("changelog export formats", () => {
  const source = readFileSync(new URL("../src/components/Changelog.tsx", import.meta.url), "utf-8");

  test("uses the shared serialisers rather than a second implementation", () => {
    expect(source).toContain('from "../../../src/lib/export-formats"');
    expect(source).toContain("serialize(");
    expect(source).toContain("filenameFor(");
  });

  test("offers every format the rest of the product does", () => {
    // Not a hardcoded list in the component: it maps EXPORT_FORMATS, so a format
    // added centrally appears here without anyone remembering to come back.
    expect(source).toContain("EXPORT_FORMATS.map(");
  });

  test("keeps Markdown on its own path, deliberately", () => {
    // `toMarkdown` writes a document that states the active range and search —
    // what someone exporting a changelog to *read* wants. The generic writers
    // produce a table of the same rows, for someone exporting it to *process*.
    expect(source).toContain('format === "markdown"');
    expect(source).toContain("buildExport()");
  });

  test("names the file after the format it actually wrote", () => {
    expect(source).toContain('filenameFor("opencodex-changelog", format)');
    // The old hardcoded `.md` would have put a CSV in a file called .md, which
    // the OS then opens with the wrong application.
    expect(source).not.toContain('link.download = "opencodex-changelog.md"');
  });
});
