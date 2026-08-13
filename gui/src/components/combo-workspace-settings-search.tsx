import type { TFn } from "../i18n/shared";
import { makeMatcher } from "../pages/models-shared";
import { DEFAULT_SEARCH_FLAGS } from "../shell/settings-search";

/**
 * The settings the combo detail's Config tab owns, in render order. The
 * settings-search row above the cards filters against these ids, so a user who
 * remembers a control's name can type it instead of scanning three cards.
 */
export const COMBO_SETTING_IDS = [
  "identity",
  "strategy",
  "targets",
] as const;

export type ComboSettingId = (typeof COMBO_SETTING_IDS)[number];

/**
 * What each card is searchable by: every label and hint it renders, so typing a
 * remembered phrase ("sticky", "weight", "public model name") finds the card that
 * carries the control rather than nothing at all.
 */
function comboSettingsIndex(t: TFn): Record<ComboSettingId, string> {
  return {
    identity: [
      t("cws.tab.config"),
      t("cws.field.id"),
      t("cws.field.idInternalHint"),
      t("cws.field.alias"),
      t("cws.field.aliasHint"),
    ].join(" "),
    strategy: [
      t("cws.strategy"),
      t("cws.strategy.failover"),
      t("cws.strategy.failoverHint"),
      t("cws.strategy.roundRobin"),
      t("cws.strategy.roundRobinHint"),
      t("cws.field.defaultEffort"),
      t("cws.field.defaultEffortHint"),
      t("cws.field.stickyLimit"),
      t("cws.field.stickyLimitHint"),
    ].join(" "),
    targets: [
      t("cws.targets"),
      t("cws.targets.failoverHint"),
      t("cws.targets.roundRobinHint"),
      t("cws.target.provider"),
      t("cws.target.model"),
      t("cws.target.weight"),
      t("cws.target.add"),
    ].join(" "),
  };
}

/**
 * Settings that live on the sibling About tab. A miss on Config can still point
 * somewhere, which is why the shared row reports cross-tab hits by name instead of
 * only saying "nothing here".
 */
function comboElsewhereIndex(t: TFn): { text: string; tab: string }[] {
  const tab = t("cws.tab.about");
  return [{ text: [t("cws.aboutTitle"), t("cws.aboutBody")].join(" "), tab }];
}

export interface ComboSettingsSearch {
  /** True once the user has actually typed something — an untouched field hides nothing. */
  active: boolean;
  matches: (id: ComboSettingId) => boolean;
  hits: number;
  /** Regex compile failure verbatim from the engine; `null` while the pattern is usable. */
  error: string | null;
  /** Distinct tab names carrying a hit for this query, empty when there are none. */
  otherTabs: string[];
  otherHits: number;
}

/**
 * Plain text by default; `.*` is an explicit opt-in, evaluated locally through the
 * same capped ECMAScript matcher every other search bar in the GUI uses. An invalid
 * pattern matches nothing rather than falling back to plain text, so the reported
 * error and the visible result never disagree.
 *
 * `flags` is what the anchored builder beside the field actually composed. It used
 * to be nothing at all — this function took a pattern and let `makeMatcher` pin
 * `i` — so the flag chips inside the popover changed its own preview and then
 * changed nothing about which of the three cards survived: a pattern deliberately
 * built as case-sensitive arrived here case-insensitive. It defaults to
 * `DEFAULT_SEARCH_FLAGS`, the same `i` this compiled before, so a caller that has
 * not been given a flags control keeps exactly the behaviour it has today rather
 * than silently changing what it finds.
 *
 * `g` and `y` are dropped inside `makeMatcher` before compiling. Both advance
 * `lastIndex` between calls, and this matcher is deliberately reused — once down
 * the three setting ids and again over the About tab's text — so a surviving `g`
 * would make the second card match, the third not, and the cross-tab note appear
 * or vanish purely on the order the tests happened to run in.
 *
 * Plain text is untouched by any of it: it is a substring search over visible
 * labels and stays case-insensitive whatever the flags say, because the flags
 * describe a regex that mode never compiles.
 */
export function comboSettingsSearch(
  query: string,
  useRegex: boolean,
  t: TFn,
  flags = DEFAULT_SEARCH_FLAGS,
): ComboSettingsSearch {
  const active = query.trim().length > 0;
  const matcher = makeMatcher(query, useRegex, flags);
  const index = comboSettingsIndex(t);
  const hitIds = new Set(COMBO_SETTING_IDS.filter((id) => matcher.test(index[id])));
  const other = active ? comboElsewhereIndex(t).filter((row) => matcher.test(row.text)) : [];
  return {
    active,
    matches: (id: ComboSettingId) => !active || hitIds.has(id),
    hits: hitIds.size,
    error: matcher.error,
    otherTabs: [...new Set(other.map((row) => row.tab))],
    otherHits: other.length,
  };
}
