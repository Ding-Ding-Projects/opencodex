/**
 * One index of every setting the app has, so a search bar can answer for the
 * whole app rather than for the screen it happens to be sitting on.
 *
 * `settings-search.ts` already unified *how* a settings search matches. What it
 * could not unify is *what* each search can see: every surface built its own
 * local option list, so `settings.otherTab` could only ever name another card on
 * the same screen. Type "seed colour" into the search on Storage and the honest
 * answer was "no match" — the setting exists, it is one click away, and the
 * screen you were on had no way to know that. The stopgap was
 * `pages/settings-elsewhere.ts`: eight hand-written rows, curated by whoever
 * last noticed the gap, which is a list that goes stale the first time somebody
 * adds a setting without remembering it exists.
 *
 * So the surfaces contribute instead of being curated. A screen declares the
 * settings it owns once, under its own page id, and every other search bar in
 * the app can then report them by page name. Adding a setting to a screen makes
 * it findable from all of them or from none of them — never from some.
 *
 * ## Why the rows are i18n keys and not strings
 *
 * The whole point is to describe settings on screens that are **not mounted**.
 * A row cannot therefore be built from a live control's rendered label, and it
 * cannot be registered from a component effect either: a mount-time registry
 * only knows about the page you are already looking at, which is exactly the
 * blindness being fixed. Rows are declared statically as `TKey`s and resolved
 * through `t` at query time, which has three useful consequences:
 *
 * - `TKey` is a union of the real dictionary keys, so a row pointing at a key
 *   that does not exist is a compile error rather than a search result that
 *   sends the user to a tab to look for nothing.
 * - The same row renders in whatever language the reader has selected, because
 *   it is translated at the moment it is searched, not at the moment it is
 *   declared.
 * - Nothing here imports a page component, so the registry costs no bundle
 *   weight beyond the strings and cannot introduce an import cycle.
 *
 * ## What this module deliberately does NOT do
 *
 * Render, call `t`, or hold React state — the same boundary `settings-search.ts`
 * keeps. It takes a `TFn` from a caller that has one and returns plain data.
 */

import type { Page } from "../app-routing";
import type { TFn, TKey } from "../i18n/shared";
import type { ElsewhereOption } from "./settings-search";
import { isSchoolModeActive } from "../school-mode/client";

/**
 * A screen's identity, borrowed from the router rather than invented here.
 *
 * A second parallel set of page names is a second thing to keep in step, and the
 * one that drifts is always the one nobody navigates by. Reusing `Page` means a
 * registry entry for a screen that does not exist does not compile.
 */
export type SettingsPageId = Page;

/**
 * One setting, as the cross-page index knows it.
 *
 * Deliberately thinner than `SettingsOption`: no live `value`, because a value
 * belongs to a mounted control and this index describes screens that are not
 * open. A cross-page hit answers "that setting is on Appearance", which is what
 * the user needs in order to go and look; claiming to know what it is currently
 * set to, from a screen that has not read it, would be a guess.
 */
export interface SettingsRegistryRow {
  /** Stable within its page. Not globally unique, and never needs to be. */
  id: string;
  /** The setting's visible label. */
  tkey: TKey;
  /** Its explanation, matched too, so a search for what a setting *does* finds it. */
  descKey?: TKey;
  /**
   * Extra words that should match but are not the label — the option names
   * inside a select, the chips of a segmented control. A user who remembers
   * setting something to "round-robin" but not what the control was called still
   * has to be able to find it.
   */
  keywordKeys?: readonly TKey[];
  /**
   * True when this row must behave as "not installed" while School Mode is
   * forcing English presentation — Cantonese, bilingual, funny-level,
   * personal-vocabulary and dim-sum rows. Declared right beside the row it
   * describes (in `settings-registry-entries.ts`) rather than in a separate
   * keyed list elsewhere, so a reader can see the suppression the moment they
   * see the row itself. `visibleSettingsRows()` below is the one place this
   * flag is ever consulted — every reader of the registry (cross-page search,
   * the command palette) goes through it rather than `entry.rows` directly.
   */
  schoolModeSuppressed?: boolean;
}

/** Every setting one screen owns, under the name the navigation gives that screen. */
export interface SettingsPageEntry {
  page: SettingsPageId;
  /** The nav label, so a cross-page hit names somewhere the user can actually go. */
  navKey: TKey;
  rows: readonly SettingsRegistryRow[];
}

/**
 * Registration order does not matter and re-registration replaces rather than
 * appends, so a module evaluated twice under hot reload leaves one copy of each
 * page instead of two copies of every row.
 */
const PAGES = new Map<SettingsPageId, SettingsPageEntry>();

/**
 * Contribute one screen's settings to the shared index.
 *
 * Returns the entry it was given so a surface can `export const ROWS =
 * registerSettingsPage({...})` and then render or test against the same list it
 * registered — one declaration, not a declaration plus a copy that can disagree
 * with it.
 */
export function registerSettingsPage(entry: SettingsPageEntry): SettingsPageEntry {
  PAGES.set(entry.page, entry);
  return entry;
}

/** Every registered page, for a caller that wants to inspect the whole index. */
export function settingsRegistryPages(): SettingsPageEntry[] {
  return [...PAGES.values()];
}

/**
 * One page's rows with anything School Mode must currently hide removed.
 *
 * The single choke point every reader of the registry goes through — cross-
 * page search below, and the command palette's `paletteSettings()` — so a
 * suppressed row can never leak through one enumeration while correctly
 * hidden from another.
 */
export function visibleSettingsRows(entry: SettingsPageEntry): SettingsRegistryRow[] {
  if (!isSchoolModeActive()) return [...entry.rows];
  return entry.rows.filter(row => !row.schoolModeSuppressed);
}

/** One page's contributed rows, or an empty list if it has contributed none. */
export function settingsRegistryRows(page: SettingsPageId): readonly SettingsRegistryRow[] {
  const entry = PAGES.get(page);
  return entry ? visibleSettingsRows(entry) : [];
}

/** How many settings the whole index holds. Used by docs and by callers reporting coverage. */
export function settingsRegistrySize(): number {
  return settingsRegistryPages().reduce((sum, entry) => sum + entry.rows.length, 0);
}

/**
 * Every setting that is *not* on the given page, translated and tagged with the
 * page it lives on.
 *
 * `ownPage` is stated rather than curated: a screen says where it is, and the
 * registry works out what counts as elsewhere. That is what stops the three
 * hand-written lists this replaced from drifting apart again — a screen can no
 * longer be wrong about its neighbours, only about itself.
 *
 * Passing `undefined` returns the entire index, which is what a surface that is
 * not a page wants (a popover, a dialog): nothing it can show is "here", so
 * everything is somewhere else.
 */
export function settingsElsewhere(ownPage: SettingsPageId | undefined, t: TFn): ElsewhereOption[] {
  const out: ElsewhereOption[] = [];
  for (const entry of PAGES.values()) {
    if (entry.page === ownPage) continue;
    const tab = t(entry.navKey);
    for (const row of visibleSettingsRows(entry)) {
      out.push({
        label: t(row.tkey),
        desc: row.descKey ? t(row.descKey) : undefined,
        keywords: row.keywordKeys?.map(key => t(key)).join(" "),
        tab,
      });
    }
  }
  return out;
}
