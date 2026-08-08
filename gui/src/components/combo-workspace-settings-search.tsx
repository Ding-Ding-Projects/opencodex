import type { TFn } from "../i18n/shared";
import { makeMatcher } from "../pages/models-shared";

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
 */
export function comboSettingsSearch(query: string, useRegex: boolean, t: TFn): ComboSettingsSearch {
  const active = query.trim().length > 0;
  const matcher = makeMatcher(query, useRegex);
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
