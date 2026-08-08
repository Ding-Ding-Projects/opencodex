/**
 * The settings that live on some other tab.
 *
 * Every settings surface carries a search bar, and the rule that goes with it is
 * that a match sitting on a different tab has to be said out loud — otherwise
 * the user types a setting's name, sees nothing, and concludes the app does not
 * have it.
 *
 * The mechanism for saying so was already built. What was wrong is that each
 * screen kept *its own* list of what lives elsewhere: `Settings` knew about five
 * entries, `Appearance` knew about three, the combo workspace had a third list.
 * So the same query reported different neighbours depending on which search bar
 * you typed it into, and every new setting had to be remembered in three places
 * or it silently became unfindable from the other two.
 *
 * One list, imported by all of them. A screen filters out its own rows rather
 * than curating what it knows about, so registering a setting here makes it
 * findable from every search bar at once.
 *
 * The design prototype reports fourteen entries across five tabs. This is the
 * subset whose keys genuinely exist in the dictionaries today — deliberately not
 * padded to reach that count, because a row pointing at a key that resolves to
 * nothing is worse than a shorter list: it sends the user to a tab to look for
 * something that is not there.
 */

import type { TKey } from "../i18n/shared";

export interface ElsewhereSetting {
  /** Label key, used both for display and as the text the matcher runs over. */
  tkey: TKey;
  /** Optional description, matched as well so a search can find it by meaning. */
  descKey?: TKey;
  /** Nav key of the tab it lives on — shown so the user knows where to go. */
  tabKey: TKey;
}

export const SETTINGS_ELSEWHERE: ReadonlyArray<ElsewhereSetting> = [
  { tkey: "accountPool.strategy", descKey: "accountPool.strategyDesc", tabKey: "nav.codexAuth" },
  { tkey: "models.contextCapLabel", tabKey: "nav.models" },
  { tkey: "models.v2ThreadsLabel", tabKey: "nav.models" },
  { tkey: "grok.title", descKey: "grok.subtitle", tabKey: "nav.grok" },
  { tkey: "api.title", tabKey: "nav.api" },
  { tkey: "lang.mode", tabKey: "nav.language" },
  { tkey: "lang.funnyEn", tabKey: "nav.language" },
  { tkey: "lang.funnyYue", tabKey: "nav.language" },
];

/**
 * The entries a given screen should offer, i.e. everything not on that screen.
 *
 * Passing the screen's own nav key rather than hand-curating a list is what
 * stops the three lists drifting apart again: a screen states where it *is*, and
 * the registry works out what counts as elsewhere.
 */
export function elsewhereFor(ownTabKey: TKey): ElsewhereSetting[] {
  return SETTINGS_ELSEWHERE.filter(entry => entry.tabKey !== ownTabKey);
}
