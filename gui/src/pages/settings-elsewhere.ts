/**
 * A compatibility shim over the shared settings registry.
 *
 * This file used to *be* the cross-surface index: eight hand-written rows, one
 * list, imported by `Settings` and `Appearance` so those two screens at least
 * agreed with each other about what lived elsewhere. That fixed the drift
 * between three private lists, and it left the real problem untouched — the list
 * was curated by hand, so it covered eight settings out of roughly eighty, and
 * every setting added after it was written silently became unfindable from every
 * search bar except the one on its own screen.
 *
 * The index now lives in `shell/settings-registry.ts`, contributed per page by
 * `shell/settings-registry-entries.ts` and read by `useSettingsSearch`. This
 * module survives only so the two screens that consume the older
 * `{ tkey, descKey, tabKey }` shape keep working while they still build their
 * searches by hand; it holds no rows of its own, and a new setting is registered
 * in the entries file rather than added here.
 *
 * New code should not import this. Pass `scope` to `useSettingsSearch` instead,
 * which resolves the same index and matches keywords as well as labels.
 */

import type { TKey } from "../i18n/shared";
import { settingsRegistryPages } from "../shell/settings-registry";
// Side-effect import, and load-bearing: `Settings.tsx` calls `elsewhereFor` at
// module scope, so the registry has to be populated by the time this module's
// exports are first evaluated rather than at first render.
import "../shell/settings-registry-entries";

export interface ElsewhereSetting {
  /** Label key, used both for display and as the text the matcher runs over. */
  tkey: TKey;
  /** Optional description, matched as well so a search can find it by meaning. */
  descKey?: TKey;
  /**
   * Option names and chip labels the row should also match by. Carried through
   * from the registry; the two legacy consumers do not read it yet, which is one
   * of the reasons to move them onto `useSettingsSearch`.
   */
  keywordKeys?: readonly TKey[];
  /** Nav key of the tab it lives on — shown so the user knows where to go. */
  tabKey: TKey;
}

/**
 * Every registered setting, flattened into the older row shape.
 *
 * Derived rather than declared: there is one index now, and a second copy of it
 * here would be the exact drift this file's own history is a record of.
 */
export const SETTINGS_ELSEWHERE: ReadonlyArray<ElsewhereSetting> = settingsRegistryPages().flatMap(
  entry => entry.rows.map((row): ElsewhereSetting => ({
    tkey: row.tkey,
    descKey: row.descKey,
    keywordKeys: row.keywordKeys,
    tabKey: entry.navKey,
  })),
);

/**
 * The entries a given screen should offer, i.e. everything not on that screen.
 *
 * Passing the screen's own nav key rather than hand-curating a list is what
 * stops the lists drifting apart again: a screen states where it *is*, and the
 * registry works out what counts as elsewhere.
 */
export function elsewhereFor(ownTabKey: TKey): ElsewhereSetting[] {
  return SETTINGS_ELSEWHERE.filter(entry => entry.tabKey !== ownTabKey);
}
