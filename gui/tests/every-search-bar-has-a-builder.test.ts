/**
 * Every search bar reaches the regex builder from an affordance beside it.
 *
 * This is the test the codebase did not have, and its absence is the whole
 * reason this work existed. Twenty-two search bars were wired to the builder by
 * hand, one at a time, and a parity audit later found three that had been missed
 * — not because anyone decided those three did not need it, but because nothing
 * checked. A twenty-third search bar added next month has the same odds.
 *
 * So this walks the source and counts, per file, how many search fields it
 * renders against how many builders it renders. A file that grows a search bar
 * without a builder fails here, at the point the omission is cheap to fix,
 * rather than in an audit six months later.
 *
 * The counting is deliberately crude — a placeholder bound to a key whose name
 * says "search" or "filter" — because a clever heuristic that misses a case is
 * worse than a blunt one that occasionally needs an exception written down. The
 * exceptions are written down, with reasons, below.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Fields that are not text searches, and must NOT be given a builder.
 *
 * A builder here would be a lie: it would let a user compose a pattern that the
 * filter then cannot honour, and finding nothing forever is a worse failure than
 * having no builder at all.
 */
const NOT_A_TEXT_SEARCH: Record<string, string> = {
  // The conversation filter is an exact-match identity lookup, not a search: the
  // stored ids are SHA-256 prefixes, and the field matches by string equality
  // against the id or against the hash of what was typed (see
  // src/log-conversation-id.ts). A regular expression cannot be hashed, so a
  // pattern could only ever be compared verbatim against a hex digest.
  "logs.filter.conversation.placeholder": "exact-match hash lookup, not a text search",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Placeholder keys whose name says the field is a search or a filter. */
function searchFieldKeys(source: string): string[] {
  return [...source.matchAll(/placeholder=\{t\("([^"]+)"/g)]
    .map(match => match[1]!)
    .filter(key => /search|filter/i.test(key));
}

function builderCount(source: string): number {
  // `SearchField` is the wrapper that already contains a `RegexBuilderButton`,
  // so either one satisfies the rule.
  return (source.match(/<RegexBuilderButton/g) ?? []).length
    + (source.match(/<SearchField/g) ?? []).length;
}

test("no search bar is rendered without a regex builder beside it", () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    // The builder's own module renders the control it defines; counting it as a
    // call site would make the rule circular.
    if (file.endsWith(`shell${sep}RegexBuilderButton.tsx`)) continue;

    const source = readFileSync(file, "utf8");
    const keys = searchFieldKeys(source);
    const searchable = keys.filter(key => !(key in NOT_A_TEXT_SEARCH));
    if (searchable.length === 0) continue;

    const builders = builderCount(source);
    if (builders < searchable.length) {
      offenders.push(
        `${relative(SRC, file)}: ${searchable.length} search field(s) [${searchable.join(", ")}] `
        + `but ${builders} builder(s)`,
      );
    }
  }

  expect(offenders).toEqual([]);
});

// The exceptions are load-bearing, so they have to stay honest: an entry naming a
// key that no longer exists is a stale excuse that would silently cover a real
// search bar added under the same key later.
test("every documented non-search exception still names a field that exists", () => {
  const everyKey = new Set(
    walk(SRC).flatMap(file => searchFieldKeys(readFileSync(file, "utf8"))),
  );
  for (const key of Object.keys(NOT_A_TEXT_SEARCH)) {
    expect(everyKey.has(key)).toBe(true);
  }
});

/**
 * The settings surfaces that must carry a search bar at all.
 *
 * Separate from the count above, which only says "if you have a search bar, give
 * it a builder". This says "you must have one" — the rule that four-plus
 * settings surfaces were silently failing, because a screen with no search bar
 * at all trips no per-field check anywhere.
 */
const SETTINGS_SURFACES = [
  "pages/Settings.tsx",
  "pages/Appearance.tsx",
  "pages/LanguageVoice.tsx",
  "pages/Storage.tsx",
  "pages/Network.tsx",
  "pages/Startup.tsx",
  "pages/Mobile.tsx",
  "shell/TabAppearanceEditor.tsx",
];

test("every settings surface renders a search bar", () => {
  const missing: string[] = [];
  for (const rel of SETTINGS_SURFACES) {
    const source = readFileSync(join(SRC, ...rel.split("/")), "utf8");
    // Either the shared row, or a hand-rolled one that predates it. The point is
    // that the surface is searchable at all, not which component does it.
    const searchable = source.includes("<SettingsSearchRow")
      || source.includes("SettingsSearchRow")
      || searchFieldKeys(source).length > 0;
    if (!searchable) missing.push(rel);
  }
  expect(missing).toEqual([]);
});
