/**
 * The changelog: parsing it, filtering it, and writing the filtered view back
 * out as Markdown.
 *
 * The source is the repository's own `CHANGELOG.md`, imported as raw text by the
 * viewer and parsed here. Deliberately not a generated JSON file checked into
 * `src/data/`: a generated file is a second copy that goes stale the moment
 * somebody tags a release without re-running the generator, and "the changelog
 * is missing the last three versions" is invisible to a build. Parsing the real
 * file at build time means the site cannot disagree with the repository.
 *
 * ## Everything is pure and text-in / text-out
 *
 * No React, no DOM, no clock. `filterReleases` takes the range and the predicate
 * it is given, and `toMarkdown` takes the rows it is given. That is what makes
 * the export provably honour the filter: the export renders **the same rows the
 * screen rendered**, not a second query built from the same inputs, so the two
 * cannot drift into disagreeing about what was on screen.
 *
 * ## The undated case, which is a real one
 *
 * A release whose heading carries no date is kept when no date bound is set and
 * dropped as soon as one is. Dropping it is the honest answer — the filter
 * cannot prove it is inside a range it has no date for — and the viewer says so
 * rather than letting a version silently vanish.
 */

/** Conventional-commit types, folded into the categories a reader cares about. */
export type ChangeKind =
  | "feat"
  | "fix"
  | "perf"
  | "docs"
  | "test"
  | "refactor"
  | "ci"
  | "chore"
  | "other";

export interface ChangeEntry {
  /** The line as written, minus the leading bullet. */
  text: string;
  kind: ChangeKind;
  /** The `(scope)` of a conventional commit, when there is one. */
  scope: string | null;
}

export interface Release {
  version: string;
  /** `YYYY-MM-DD`, or null when the heading carried no date. */
  date: string | null;
  entries: ChangeEntry[];
}

/**
 * `## 2.7.42 — 2026-07-28`, with the em dash the generator writes.
 *
 * A plain hyphen and an en dash are accepted too. The generator uses an em dash
 * today; a heading hand-edited with `-` is still a release, and refusing to parse
 * it would silently drop a version from a viewer whose entire promise is "every
 * released version".
 */
const HEADING = /^##\s+([^\s—–-]\S*)\s*(?:[—–-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
/** `type(scope): subject` — the scope and the colon are both optional. */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?!?:\s/;

const KIND_OF: Record<string, ChangeKind> = {
  feat: "feat",
  fix: "fix",
  perf: "perf",
  docs: "docs",
  test: "test",
  tests: "test",
  refactor: "refactor",
  ci: "ci",
  build: "ci",
  chore: "chore",
  style: "chore",
};

/** Category order on screen and in an export: what shipped, then what was fixed. */
export const KIND_ORDER: readonly ChangeKind[] = [
  "feat", "fix", "perf", "refactor", "docs", "test", "ci", "chore", "other",
];

export function classify(text: string): { kind: ChangeKind; scope: string | null } {
  const match = CONVENTIONAL.exec(text);
  if (!match) return { kind: "other", scope: null };
  return { kind: KIND_OF[match[1]] ?? "other", scope: match[2] || null };
}

/**
 * Parse the file into releases, newest first — which is the order the file is
 * already in, so this preserves it rather than sorting. Sorting by version would
 * need a semver comparator and would reorder the one case the file gets right by
 * construction: two releases tagged on the same day.
 */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { version: heading[1], date: heading[2] ?? null, entries: [] };
      releases.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = BULLET.exec(line);
    if (!bullet) continue;
    const text = bullet[1].trim();
    if (!text) continue;
    current.entries.push({ text, ...classify(text) });
  }

  return releases;
}

/* ---------------------------------------------------------------- filters -- */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real calendar date in `YYYY-MM-DD`.
 *
 * The round trip through `Date` is what rejects `2026-02-31`: the shape test
 * alone accepts it, and `Date` silently rolls it forward to 2 March, so a filter
 * built on the shape test would quietly use a bound the reader never typed.
 */
export function isIsoDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface DateRange {
  /** `YYYY-MM-DD`, or "" for an open start. */
  from: string;
  /** `YYYY-MM-DD`, or "" for an open end. */
  to: string;
}

export const OPEN_RANGE: DateRange = { from: "", to: "" };

/**
 * Whether a release's date sits inside the range.
 *
 * String comparison rather than `Date` arithmetic: `YYYY-MM-DD` sorts
 * lexicographically exactly as it sorts chronologically, and going through
 * `Date` would drag the reader's timezone into a comparison between two dates
 * that have none — which is how a release tagged on the 1st disappears from a
 * range starting on the 1st for anyone west of UTC.
 */
export function inRange(date: string | null, range: DateRange): boolean {
  if (date === null) return !range.from && !range.to;
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

export interface FilteredRelease {
  release: Release;
  /** The entries that matched. All of them when the version itself matched. */
  entries: ChangeEntry[];
  /** How many entries were dropped by the search, so the viewer can say so. */
  hidden: number;
  /** True when the release survived because its version number matched. */
  byVersion: boolean;
}

/**
 * Apply the date range and the text predicate together.
 *
 * The two compose rather than override: a release must be inside the range AND
 * have something that matches. `test` is null when there is nothing runnable —
 * an empty query, or one whose pattern will not compile — and a null predicate
 * means "no text filter", never "match nothing". An invalid pattern emptying the
 * list would look exactly like a genuine no-match, and the reader would go
 * looking for a release that is right there.
 */
export function filterReleases(
  releases: readonly Release[],
  range: DateRange,
  test: ((value: string) => boolean) | null,
): FilteredRelease[] {
  const out: FilteredRelease[] = [];
  for (const release of releases) {
    if (!inRange(release.date, range)) continue;
    if (!test) {
      out.push({ release, entries: release.entries, hidden: 0, byVersion: false });
      continue;
    }
    if (test(release.version)) {
      out.push({ release, entries: release.entries, hidden: 0, byVersion: true });
      continue;
    }
    const entries = release.entries.filter(entry => test(entry.text));
    if (entries.length) {
      out.push({ release, entries, hidden: release.entries.length - entries.length, byVersion: false });
    }
  }
  return out;
}

/** Total entries across a filtered view, for the honest count line. */
export function countEntries(rows: readonly FilteredRelease[]): number {
  return rows.reduce((total, row) => total + row.entries.length, 0);
}

/** Group one release's entries by category, in `KIND_ORDER`, skipping empties. */
export function groupByKind(entries: readonly ChangeEntry[]): { kind: ChangeKind; entries: ChangeEntry[] }[] {
  const buckets = new Map<ChangeKind, ChangeEntry[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.kind);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.kind, [entry]);
  }
  return KIND_ORDER.filter(kind => buckets.has(kind)).map(kind => ({ kind, entries: buckets.get(kind)! }));
}

/* ----------------------------------------------------------------- export -- */

export interface ExportMeta {
  title: string;
  /** A human sentence naming the date range, already translated. */
  range: string;
  /** The search text, or the translated word for "none". */
  search: string;
  /** Already-translated "Range: {range}. Search: {search}." */
  note: string;
  undated: string;
}

/**
 * Render the filtered view as Markdown.
 *
 * Takes the rows the screen is showing rather than re-running the filter, so the
 * export cannot disagree with what the reader was looking at. The range and the
 * search are written into the file itself: a changelog extract with no statement
 * of what was excluded is a document that will later be read as complete.
 *
 * Entries keep their original bullet order inside a release rather than being
 * regrouped by category. The screen groups them because a reader is scanning;
 * a file is usually diffed or pasted, and reordering lines that came from a
 * generated file is how an export stops matching its source.
 */
export function toMarkdown(rows: readonly FilteredRelease[], meta: ExportMeta): string {
  const lines: string[] = [`# ${meta.title}`, "", meta.note, ""];
  for (const { release, entries } of rows) {
    lines.push(`## ${release.version} — ${release.date ?? meta.undated}`, "");
    for (const entry of entries) lines.push(`- ${entry.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------- presets -- */

/** A range ending today and starting `days` ago. */
export function lastDays(days: number, today = new Date()): DateRange {
  const start = new Date(today.getTime());
  start.setUTCDate(start.getUTCDate() - days);
  return { from: iso(start), to: iso(today) };
}

/** 1 January of the current year through today. */
export function thisYear(today = new Date()): DateRange {
  return { from: `${today.getUTCFullYear()}-01-01`, to: iso(today) };
}

export function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------- calendar -- */

/**
 * The days of one month as a 6x7 grid, Monday first, padded with the
 * neighbouring months' days so every row is full.
 *
 * A fixed six rows rather than five-or-six: a grid that changes height as the
 * reader pages through months makes the buttons below it jump, and on a phone
 * that means the "Today" button moves out from under a thumb already on its way
 * down. Padding days are marked so they can be rendered dimmed and still be
 * selectable — clicking 1 March in February's trailing row is unambiguous.
 */
export interface CalendarDay {
  iso: string;
  day: number;
  outside: boolean;
}

export function monthGrid(year: number, month: number): CalendarDay[] {
  const first = new Date(Date.UTC(year, month, 1));
  // `getUTCDay` is 0 for Sunday; shift so Monday is column 0.
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime());
  start.setUTCDate(start.getUTCDate() - lead);

  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(start.getTime());
    day.setUTCDate(day.getUTCDate() + i);
    days.push({ iso: iso(day), day: day.getUTCDate(), outside: day.getUTCMonth() !== month });
  }
  return days;
}
