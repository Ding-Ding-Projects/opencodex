/**
 * Searching a settings surface: its option names, their descriptions, and their
 * *current values*.
 *
 * The rule is specific about the third one, and it is the one a settings search
 * usually gets wrong. A reader who remembers they set the accent to something
 * green types "green", not "accent colour" — and a search that only indexed
 * labels would tell them no such setting exists while it sits two rows down. So
 * the value a control is showing right now is part of what is searched, which
 * means the option table has to be read at query time rather than declared once
 * at build time.
 *
 * Hence the DOM as the source of truth. `readOptionsFromDom` reads what the
 * panel is actually rendering: the label the reader can see, in the language the
 * panel is rendering it in, with the value the control currently holds. A TypeScript
 * table would have to be kept in step with the markup by hand, would go stale the
 * first time a row was renamed, and would be in one language.
 *
 * Cross-surface reporting is built in from the start even though this site has
 * one settings surface today. "Say plainly when a match sits on a different tab"
 * is not a feature that can be retrofitted into a search that only ever looked at
 * the rows in front of it — the data model has to carry the tab, so it does, and
 * the settings page that is coming inherits a search that already handles it.
 *
 * What this module deliberately does NOT do: hide rows, own a query, or decide
 * what a tab is called. It answers "which options match, and which of those are
 * somewhere else"; the component acts on the answer.
 */

import { tabMatcher, type TabMatcher } from "../../../shared/m3/tabs";

export interface SettingOption {
  /** Stable id, used to find the row again to show or hide it. */
  id: string;
  label: string;
  description: string;
  /** What the control is showing right now, as text. */
  value: string;
  /** The surface or tab this option lives on, for the cross-tab message. */
  tab: string;
}

export interface SettingsSearchResult {
  /** Matching options on the current tab, in document order. */
  matches: SettingOption[];
  /** Matching options that live somewhere else. */
  elsewhere: SettingOption[];
  /** The distinct tab names in `elsewhere`, ready to name in a sentence. */
  otherTabs: string[];
  /** Options considered on the current tab, matched or not. */
  total: number;
}

/**
 * Everything one option contributes to a match, as one string.
 *
 * Joined with newlines rather than spaces so an anchored pattern (`^Theme$`) can
 * still match a whole field under the `m` flag instead of being defeated by the
 * concatenation. The order is label, description, value — which is also the
 * order a reader would guess at.
 */
export function haystackOf(option: SettingOption): string {
  return `${option.label}\n${option.description}\n${option.value}`;
}

/**
 * Split matching options into "here" and "elsewhere".
 *
 * An unrunnable query (empty, or a pattern that will not compile) matches
 * everything rather than nothing: a settings panel that empties itself the
 * moment the field is focused, or while a pattern is half-typed, is a panel the
 * reader has to fight. The invalid-pattern message is shown beside the field by
 * the search bar itself, so nothing is hidden by this being permissive.
 */
export function searchSettings(
  options: SettingOption[],
  matcher: TabMatcher,
  currentTab: string,
): SettingsSearchResult {
  const here = options.filter(option => option.tab === currentTab);
  if (!matcher.ok) {
    return { matches: here, elsewhere: [], otherTabs: [], total: here.length };
  }
  const test = matcher.test;
  const matched = options.filter(option => test(haystackOf(option)));
  const elsewhere = matched.filter(option => option.tab !== currentTab);
  return {
    matches: matched.filter(option => option.tab === currentTab),
    elsewhere,
    otherTabs: [...new Set(elsewhere.map(option => option.tab))],
    total: here.length,
  };
}

/** Convenience for callers holding a raw query rather than a compiled matcher. */
export function searchSettingsQuery(
  options: SettingOption[],
  query: string,
  regex: boolean,
  flags: string,
  currentTab: string,
): SettingsSearchResult {
  return searchSettings(options, tabMatcher(query, regex, flags), currentTab);
}

/* ------------------------------------------------------------------- DOM -- */

/** Minimal shape of what this reads, so the scraper can be exercised without a browser. */
export interface OptionElement {
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => { textContent: string | null } | null;
  textContent: string | null;
}

/**
 * Read the options a settings surface is rendering.
 *
 * The contract is four attributes on the markup, and every one of them is
 * optional in a way that degrades to something true rather than to nothing:
 *
 *  - `data-setting-id`  — marks the row. Required; a row without it is not a row.
 *  - `data-setting-label` — the visible name. Falls back to the row's own text,
 *    which is verbose but never wrong.
 *  - `data-setting-desc` — the explanation, when the row has one.
 *  - `data-setting-value` — the live value. Falls back to empty, because a wrong
 *    guess at a value is worse than admitting there is none to search.
 *  - `data-setting-tab` — which surface it belongs to, for the cross-tab message.
 */
export function readOptionsFrom(elements: OptionElement[], defaultTab: string): SettingOption[] {
  const options: SettingOption[] = [];
  for (const element of elements) {
    const id = element.getAttribute("data-setting-id");
    if (!id) continue;
    const text = (selector: string) => element.querySelector(selector)?.textContent?.trim() ?? "";
    options.push({
      id,
      label: element.getAttribute("data-setting-label")
        || text("[data-setting-label]")
        || (element.textContent ?? "").trim().slice(0, 120),
      description: element.getAttribute("data-setting-desc") || text("[data-setting-desc]"),
      value: element.getAttribute("data-setting-value") || text("[data-setting-value]"),
      tab: element.getAttribute("data-setting-tab") || defaultTab,
    });
  }
  return options;
}
