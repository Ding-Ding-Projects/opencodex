/**
 * One settings search, shared by every surface that carries settings.
 *
 * The rule is that every settings, preferences, properties or adjustment surface
 * carries its own search bar wired to the full regex builder. The app satisfied
 * that rule twenty-two times by hand, and hand-wiring is exactly why three
 * surfaces were missed and five more never got a search bar at all: each screen
 * re-derived its own matcher, its own `.*` chip, its own status line and its own
 * idea of what "a match on another tab" means. Six near-identical copies of the
 * same row had already accumulated (Storage's `SettingsSearchRow`, Claude Code's
 * `ClaudeSettingsSearchRow`, and inline rows on Settings, Appearance, Language
 * and Notifications), and they had already drifted: some reported cross-tab hits,
 * some did not; some searched values, most searched only labels.
 *
 * So the behaviour lives here once and the surfaces declare their options. A new
 * settings screen adds an option list, not a search implementation.
 *
 * What this module deliberately does NOT do: render anything, look up any
 * translation, or hold React state. It takes already-translated strings and
 * returns a plain result, so the whole contract is testable without a DOM and a
 * surface can compute the same answer in a test that it shows to a user.
 *
 * Nothing here transmits or persists a pattern. Evaluation is local, through the
 * caps in `../regex/engine` — the same bounds the builder itself enforces.
 */

import { PATTERN_CAP, SAMPLE_CAP } from "../regex/engine";

/**
 * One adjustable thing on a surface, as the search sees it.
 *
 * `label`, `desc` and `value` are already translated: this module never calls
 * `t`, because a surface that renders "Enabled" must be findable by typing
 * "Enabled" in whatever language it is actually showing.
 */
export interface SettingsOption {
  /** Stable within its surface. The host filters its rows by this. */
  id: string;
  /** The visible label, translated. */
  label: string;
  /** The visible description or hint, translated. */
  desc?: string;
  /**
   * What the control currently reads, in the same words the control shows.
   * Searched as well as the label: a user who remembers they set something to
   * "weekly" but not what the setting was called still has to be able to find it.
   */
  value?: string;
  /**
   * Extra words that should match but are not rendered as the label — option
   * names inside a select, the chips of a segmented control. Typing a remembered
   * choice has to find the control that produces it.
   */
  keywords?: string;
  /**
   * The tab or section of *this* surface the option sits on. Left undefined on a
   * flat surface. A match here while a different tab is showing is reported
   * rather than silently filtered away.
   */
  tab?: string;
}

/** A setting that lives on a different surface entirely, for the cross-surface note. */
export interface ElsewhereOption {
  label: string;
  desc?: string;
  /** The tab/screen name to send the user to, translated. */
  tab: string;
}

export interface SettingsMatcher {
  test: (text: string) => boolean;
  /** Compile failure verbatim from the engine; `null` while the pattern is usable. */
  error: string | null;
}

/** The flags a search bar compiles unless its host asks for others. */
export const DEFAULT_SEARCH_FLAGS = "i";

/**
 * Flags that make `RegExp.prototype.test` stateful.
 *
 * `g` and `y` carry `lastIndex` between calls, so testing the same regex against
 * a list of options returns true, false, true, false — half the matching settings
 * vanish, and which half depends on their order. The builder offers both flags
 * because they are meaningful when *scanning* a sample, so they arrive here
 * legitimately and are dropped rather than refused: the user's pattern still
 * works, it just stops being order-dependent.
 */
const STATEFUL_FLAGS = /[gy]/g;

/** Every word a search runs over for one option, in one string. */
export function optionText(option: SettingsOption): string {
  return [option.label, option.desc, option.value, option.keywords]
    .filter(Boolean)
    .join(" ");
}

/**
 * Plain text by default; regex only when the caller opted in.
 *
 * Plain text stays case-insensitive whatever the flags say — it is a substring
 * search over visible labels, and a user typing "weekly" to find "Weekly" is not
 * making a mistake the search should punish them for. The flags describe the
 * regex the builder is composing, so they only take effect in regex mode.
 *
 * An invalid pattern matches nothing rather than falling back to plain text, so
 * the error the surface reports and the rows it shows can never disagree.
 */
export function settingsMatcher(query: string, useRegex: boolean, flags = DEFAULT_SEARCH_FLAGS): SettingsMatcher {
  const trimmed = query.trim();
  if (!trimmed) return { test: () => true, error: null };
  if (!useRegex) {
    const needle = trimmed.toLowerCase();
    return { test: text => text.toLowerCase().includes(needle), error: null };
  }
  try {
    const safe = flags.replace(STATEFUL_FLAGS, "");
    const re = new RegExp(trimmed.slice(0, PATTERN_CAP), safe);
    return { test: text => re.test(text), error: null };
  } catch (e) {
    return { test: () => false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface SettingsSearchInput {
  options: readonly SettingsOption[];
  /** Settings on other surfaces, so a miss here can still point somewhere. */
  elsewhere?: readonly ElsewhereOption[];
  /** The tab currently showing, when the surface has tabs. */
  activeTab?: string;
  query: string;
  useRegex: boolean;
  flags?: string;
}

export interface SettingsSearchResult {
  /** True once something was typed. An untouched field hides nothing. */
  active: boolean;
  /** Did this option match? Always true while the field is untouched. */
  matches: (id: string) => boolean;
  /** Matching options on the tab that is showing (all of them on a flat surface). */
  visible: SettingsOption[];
  /** How many matched here, on the visible tab. */
  hits: number;
  /**
   * How many options this tab has in total, matching or not. The status line
   * reads "3 of 12", and a count without its denominator says nothing about
   * whether the search narrowed anything.
   */
  total: number;
  /** Regex compile failure verbatim; `null` while the pattern is usable. */
  error: string | null;
  /** Tabs of *this* surface carrying a hit that is not currently visible. */
  otherTabs: string[];
  otherTabHits: number;
  /** Other surfaces carrying a hit, by tab name. */
  elsewhereTabs: string[];
  elsewhereHits: number;
  /**
   * The corpus the search actually runs over, for the builder to test a pattern
   * against. Capped, because it is fed straight into a `<textarea>` and a surface
   * with a thousand options would otherwise paste a novel into the panel.
   */
  sample: string;
}

/**
 * Run one surface's settings search.
 *
 * The cross-tab reporting is the part worth reading twice. A match that is not
 * on the visible tab is *not* dropped — it is counted and its tab named, because
 * the alternative is that a user types a setting's name, sees an empty list, and
 * concludes the app does not have it. Two kinds are reported separately since
 * they need different actions: a hit on another tab of this surface is one click
 * away, while a hit on another screen means navigating somewhere else.
 */
export function runSettingsSearch({
  options, elsewhere = [], activeTab, query, useRegex, flags,
}: SettingsSearchInput): SettingsSearchResult {
  const active = query.trim().length > 0;
  const matcher = settingsMatcher(query, useRegex, flags);

  const matched = options.filter(option => matcher.test(optionText(option)));
  const matchedIds = new Set(matched.map(option => option.id));

  // With no active tab the surface is flat and everything it owns is on screen,
  // so nothing can be "on another tab" and the whole match set is visible.
  const onThisTab = (option: SettingsOption) =>
    activeTab === undefined || option.tab === undefined || option.tab === activeTab;

  const visible = matched.filter(onThisTab);
  // Only once something was typed. An empty query "matches" every option, so
  // without this an untouched field on a tabbed surface permanently announced
  // "3 match(es) on another tab" — a claim about a search nobody had run yet,
  // sitting on screen from the moment the page loaded.
  const offTab = active ? matched.filter(option => !onThisTab(option)) : [];

  const elsewhereHitRows = active
    ? elsewhere.filter(row => matcher.test([row.label, row.desc].filter(Boolean).join(" ")))
    : [];

  return {
    active,
    matches: (id: string) => !active || matchedIds.has(id),
    visible,
    hits: visible.length,
    total: options.filter(onThisTab).length,
    error: matcher.error,
    otherTabs: [...new Set(offTab.map(option => option.tab as string))],
    otherTabHits: offTab.length,
    elsewhereTabs: [...new Set(elsewhereHitRows.map(row => row.tab))],
    elsewhereHits: elsewhereHitRows.length,
    // Every option, not just the matching ones: the sample exists so a pattern
    // being written can be tried against the real corpus, and seeding it with the
    // rows the half-typed pattern already matched would hide the rest.
    sample: options.map(optionText).join("\n").slice(0, SAMPLE_CAP),
  };
}
