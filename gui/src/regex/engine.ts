/**
 * Regex evaluation, shared by the builder page and the anchored builder popover.
 *
 * Engine: the **ECMAScript `RegExp`** built into whatever browser is running
 * this, evaluated locally. Nothing here reads or writes the network, and no
 * caller is given a hook to — a pattern the user is still typing is exactly the
 * kind of thing that must never leave the machine.
 *
 * This module exists because the builder now has two surfaces. A popover that
 * re-derived matches and capture indices for itself would be a second engine,
 * and two engines drift: the page would say a named group is `$3` while the
 * popover said `$1`, and only one of them could be right. So the evaluation, the
 * caps, the flag list and the guided palette all live here once, and both
 * surfaces render the same answers.
 *
 * What it deliberately does NOT do: any rendering, any i18n lookup, and any
 * clamping the caller did not ask for. It returns `TKey`s for the palette and
 * the flags so the caller can translate them, but it never touches React, and
 * `evaluate` never silently truncates its inputs — a caller that wants the caps
 * applied to what the user typed calls `capPattern` / `capSample` on the way in,
 * which is the only place the truncation is visible to the user.
 */

import type { TKey } from "../i18n/shared";

/**
 * Safety caps. A pattern is bounded so a pathological one cannot be built at
 * all; the sample is bounded so an accidental paste of a whole log file does not
 * become a quadratic scan; matches are bounded so a `\b`-style pattern on a long
 * sample cannot produce a list longer than the page can lay out.
 */
export const PATTERN_CAP = 400;
export const SAMPLE_CAP = 20_000;
export const MATCH_CAP = 200;

/** Shown when a group participated in no capture, and for a zero-width match. */
export const EMPTY_MARK = "∅";

/**
 * Shown in the capture-groups panel for a declared group that no match in the
 * sample ever filled. Deliberately *not* `EMPTY_MARK`: the two mean different
 * things — `∅` beside a match says that group did not participate in *that*
 * match, while `—` says nothing in the whole sample reached the group at all.
 */
export const NO_VALUE_MARK = "—";

export const FLAGS: { flag: string; tkey: TKey }[] = [
  { flag: "g", tkey: "regex.flagG" },
  { flag: "i", tkey: "regex.flagI" },
  { flag: "m", tkey: "regex.flagM" },
  { flag: "s", tkey: "regex.flagS" },
  { flag: "u", tkey: "regex.flagU" },
  { flag: "y", tkey: "regex.flagY" },
];

/**
 * Guided palette: insert a construct rather than remembering its syntax.
 *
 * Grouped exactly the way the prototype groups them — literals → character
 * classes → anchors → groups → alternation → quantifiers — so each section
 * carries its own heading and its own `role="group"` label.
 *
 * Every insert is a *complete* construct: `(?<name>)` and not `(?<name>…)`,
 * because the ellipsis is a literal character and silently broke the pattern
 * the moment it was inserted.
 */
export const TOKEN_GROUPS: { tkey: TKey; items: { insert: string; tkey: TKey }[] }[] = [
  {
    tkey: "regex.groupLiterals",
    items: [
      { insert: "abc", tkey: "regex.tokLiteral" },
      { insert: "\\.", tkey: "regex.tokEscapedDot" },
      { insert: "\\\\", tkey: "regex.tokBackslash" },
    ],
  },
  {
    tkey: "regex.groupClasses",
    items: [
      { insert: "\\d", tkey: "regex.tokDigit" },
      { insert: "\\w", tkey: "regex.tokWord" },
      { insert: "\\s", tkey: "regex.tokSpace" },
      // `.` is not in the prototype's class list, but it is the construct users
      // reach for beside `\d`/`\w`, and it already has its own description key.
      { insert: ".", tkey: "regex.tokAny" },
      { insert: "[a-z]", tkey: "regex.tokClass" },
      { insert: "[^/]", tkey: "regex.tokNegated" },
      { insert: "\\p{Script=Han}", tkey: "regex.tokUnicodeScript" },
    ],
  },
  {
    tkey: "regex.groupAnchors",
    items: [
      { insert: "^", tkey: "regex.tokStart" },
      { insert: "$", tkey: "regex.tokEnd" },
      { insert: "\\b", tkey: "regex.tokBoundary" },
    ],
  },
  {
    tkey: "regex.groupGroups",
    items: [
      { insert: "()", tkey: "regex.tokCapture" },
      { insert: "(?<name>)", tkey: "regex.tokNamed" },
      { insert: "(?:)", tkey: "regex.tokGroup" },
      { insert: "(?=)", tkey: "regex.tokLookahead" },
    ],
  },
  {
    tkey: "regex.groupAlternation",
    items: [{ insert: "|", tkey: "regex.tokAlt" }],
  },
  {
    tkey: "regex.groupQuantifiers",
    items: [
      { insert: "*", tkey: "regex.tokStar" },
      { insert: "+", tkey: "regex.tokPlus" },
      { insert: "?", tkey: "regex.tokOpt" },
      { insert: "{1,3}", tkey: "regex.tokRange" },
      { insert: "+?", tkey: "regex.tokLazy" },
    ],
  },
];

export interface MatchRow {
  index: number;
  text: string;
  /** Positional captures, `undefined` where the group did not participate. */
  positional: (string | undefined)[];
  groups: Record<string, string | undefined>;
}

export interface Evaluation {
  rows: MatchRow[];
  error: string | null;
  truncated: boolean;
}

/** A declared named group, the index the engine assigns it, and its first value. */
export interface CaptureGroup {
  index: number;
  name: string;
  value: string | undefined;
}

/** The caps applied at the point the user types, where the count beside the field can say so. */
export const capPattern = (text: string): string => text.slice(0, PATTERN_CAP);
export const capSample = (text: string): string => text.slice(0, SAMPLE_CAP);

export function evaluate(pattern: string, flags: string, sample: string): Evaluation {
  if (!pattern) return { rows: [], error: null, truncated: false };
  let re: RegExp;
  try {
    // `g` is forced so the scan below can walk every match; the user's own `g` is harmless.
    re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e), truncated: false };
  }

  const rows: MatchRow[] = [];
  let truncated = false;
  let guard = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sample)) !== null) {
    rows.push({
      index: match.index,
      text: match[0],
      positional: match.slice(1),
      groups: { ...(match.groups ?? {}) } as Record<string, string | undefined>,
    });
    // Zero-width match: advance manually or exec() never moves and this loops forever.
    if (match[0] === "") re.lastIndex += 1;
    if (rows.length >= MATCH_CAP) { truncated = true; break; }
    if (++guard > SAMPLE_CAP) { truncated = true; break; }
  }
  return { rows, error: null, truncated };
}

/**
 * Named capture groups in pattern order, each with the positional number the
 * engine actually assigns it.
 *
 * Counting matters: a named group that follows two unnamed ones is `$3`, not
 * `$1`, so this has to walk the pattern rather than number the names it finds.
 * Escapes and character classes are skipped — `\(` and `[(]` open no group — and
 * every `(?…` form except `(?<name>` is non-capturing, including the `(?<=` /
 * `(?<!` lookbehinds that otherwise read as a named group.
 */
export function namedGroups(pattern: string): { index: number; name: string }[] {
  const found: { index: number; name: string }[] = [];
  let captures = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { i += 1; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch !== "(") continue;
    const rest = pattern.slice(i + 1);
    const named = /^\?<(?![=!])([A-Za-z_$][\w$]*)>/.exec(rest);
    if (named) { found.push({ index: ++captures, name: named[1] }); continue; }
    if (rest.startsWith("?")) continue;
    captures += 1;
  }
  return found;
}

/**
 * The capture-groups panel's rows.
 *
 * Read off the pattern, not off the matches: a group that captured nothing is
 * still a group the user declared, and the panel has to say so. An invalid
 * pattern yields nothing at all, because the error line is already saying the
 * only useful thing about it.
 */
export function describeGroups(pattern: string, result: Evaluation): CaptureGroup[] {
  if (result.error) return [];
  return namedGroups(pattern).map(g => ({
    ...g,
    value: result.rows.find(row => row.groups[g.name] != null)?.groups[g.name],
  }));
}

/** Positional index → declared name, so a match row can label `$3` as `tail`. */
export function groupNameMap(groups: CaptureGroup[]): Map<number, string> {
  return new Map(groups.map(g => [g.index, g.name] as const));
}

/**
 * `$1=… name=…` beside a match, so captures are readable without a second table.
 *
 * One entry per positional capture and no more: a named group *is* a positional
 * one, so listing the named map as well printed `$1=9fa2c1  id=9fa2c1` — the same
 * capture twice. Named slots are labelled by their name, unnamed ones by `$n`.
 */
export function groupsLabel(row: MatchRow, names: Map<number, string>): string {
  return row.positional
    .map((value, i) => `${names.get(i + 1) ?? `$${i + 1}`}=${value ?? EMPTY_MARK}`)
    .join("  ");
}
