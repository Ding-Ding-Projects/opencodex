import type { TFn, TKey } from "../i18n/shared";
import { makeMatcher } from "./models-shared";

/**
 * The settings the Claude Code tab owns, in render order. The settings-search row
 * above the cards filters against these ids, so a user who knows a setting's name
 * can type it instead of scanning four cards for it.
 */
export const CLAUDE_SETTING_IDS = [
  "enabled",
  "effectiveMode",
  "authMode",
  "fastMode",
  "maxContext",
  "autoContext",
  "autoCompactWindow",
  "injectAgents",
  "systemEnv",
  "webSearchSidecar",
  "visionSidecar",
  "quickstart",
  "smallFastModel",
  "modelMap",
  "aliases",
] as const;

export type ClaudeSettingId = (typeof CLAUDE_SETTING_IDS)[number];

/**
 * What each setting is searchable by: its label, its explanation, and the option
 * labels a user is likelier to remember than the control's own name ("Subscription",
 * "priority") — typing a remembered value has to find the control that produces it.
 */
export function claudeSettingsIndex(t: TFn): Record<ClaudeSettingId, string> {
  return {
    enabled: [t("claude.enabledLabel"), t("claude.enabledHint")].join(" "),
    effectiveMode: [
      t("claude.effectiveMode.label"),
      t("claude.effectiveMode.autoAbsent"),
      t("claude.effectiveMode.autoUnknown"),
    ].join(" "),
    authMode: [
      t("claude.authMode"),
      t("claude.authModeHint"),
      t("claude.authModeAuto"),
      t("claude.authModeSubscription"),
      t("claude.authModeProxy"),
    ].join(" "),
    fastMode: [
      t("claude.fastMode"),
      t("claude.fastModeDesc"),
      t("claude.fastAuto"),
      t("claude.fastOn"),
      t("claude.fastOff"),
    ].join(" "),
    maxContext: [t("claude.maxContext"), t("claude.maxContextDesc"), t("claude.maxContextAutomatic")].join(" "),
    autoContext: [t("claude.autoContext"), t("claude.autoContextDesc")].join(" "),
    autoCompactWindow: [
      t("claude.autoCompactWindow"),
      t("claude.autoCompactWindowDesc"),
      t("claude.autoCompactDefault"),
    ].join(" "),
    injectAgents: [t("claude.injectAgents"), t("claude.injectAgentsDesc")].join(" "),
    systemEnv: [t("claude.systemEnv"), t("claude.systemEnvDesc")].join(" "),
    webSearchSidecar: [
      t("claude.webSearchSidecar"),
      t("claude.webSearchSidecarHint"),
      t("claude.useMainSetting"),
    ].join(" "),
    visionSidecar: [
      t("claude.visionSidecar"),
      t("claude.visionSidecarHint"),
      t("claude.useMainSetting"),
    ].join(" "),
    quickstart: [t("claude.quickstart"), t("claude.manualEnv")].join(" "),
    smallFastModel: [
      t("claude.smallFastModel"),
      t("claude.smallFastModelAccurateHint"),
      t("claude.smallFastModelUnsetOption"),
    ].join(" "),
    modelMap: [t("claude.modelMap"), t("claude.modelMapHint"), t("claude.addMapping")].join(" "),
    aliases: [t("claude.aliases"), t("claude.aliasesHint")].join(" "),
  };
}

/**
 * The display label for each setting, keyed by id.
 *
 * Separate from the searchable text above, which joins a label to its hints and
 * option names — good for matching, wrong for showing. Kept here, beside
 * CLAUDE_SETTING_IDS, so a hand-written second list cannot drift out of step with
 * the first. It already had: the Desktop tab's cross-tab index listed nine of the
 * fourteen, so five settings were unfindable from that surface and the miss looked
 * like "no such setting" rather than "look on the other tab".
 */
const CLAUDE_SETTING_LABEL_KEYS: Record<ClaudeSettingId, TKey> = {
  enabled: "claude.enabledLabel",
  effectiveMode: "claude.effectiveMode.label",
  authMode: "claude.authMode",
  fastMode: "claude.fastMode",
  maxContext: "claude.maxContext",
  autoContext: "claude.autoContext",
  autoCompactWindow: "claude.autoCompactWindow",
  injectAgents: "claude.injectAgents",
  systemEnv: "claude.systemEnv",
  webSearchSidecar: "claude.webSearchSidecar",
  visionSidecar: "claude.visionSidecar",
  quickstart: "claude.quickstart",
  smallFastModel: "claude.smallFastModel",
  modelMap: "claude.modelMap",
  aliases: "claude.aliases",
};

/**
 * Every Claude Code setting, as {id, label}, derived from the one list of ids.
 * The Desktop tab uses this for its cross-tab index; adding a setting to
 * CLAUDE_SETTING_IDS now makes it findable from both surfaces or fails the build.
 */
export function claudeSettingLabels(t: TFn): { id: ClaudeSettingId; label: string }[] {
  return CLAUDE_SETTING_IDS.map(id => ({ id, label: t(CLAUDE_SETTING_LABEL_KEYS[id]) }));
}

/**
 * Settings that live on the sibling Desktop tab. A miss on this surface can still
 * point somewhere, which is the whole reason the shared row reports cross-tab hits
 * instead of only saying "nothing here".
 */
export function claudeElsewhereIndex(t: TFn): { id: string; text: string; tab: string }[] {
  const tab = t("claude.tabDesktop");
  return [
    { id: "desktopDefault", text: t("claudeDesktop.useAsDefault", { family: t("claudeDesktop.family.opus") }), tab },
    { id: "desktopMove", text: t("claudeDesktop.moveTo"), tab },
    { id: "desktopImport", text: t("claudeDesktop.importJson"), tab },
    { id: "desktopExport", text: t("claudeDesktop.exportJson"), tab },
  ];
}

export interface ClaudeSettingsSearch {
  /** True once the user has actually typed something — an untouched field hides nothing. */
  active: boolean;
  matches: (id: ClaudeSettingId) => boolean;
  hits: number;
  /** Regex compile failure verbatim from the engine; `null` while the pattern is usable. */
  error: string | null;
  /** Distinct tab names carrying a hit for this query, empty when there are none. */
  otherTabs: string[];
  otherHits: number;
}

/**
 * Plain text by default; `.*` is an explicit opt-in, evaluated locally through the
 * same capped ECMAScript matcher every other search bar on the dashboard uses.
 * An invalid pattern matches nothing rather than falling back to plain text, so the
 * reported error and the visible result never disagree.
 */
export function claudeSettingsSearch(query: string, useRegex: boolean, t: TFn): ClaudeSettingsSearch {
  const active = query.trim().length > 0;
  const matcher = makeMatcher(query, useRegex);
  const index = claudeSettingsIndex(t);
  const hitIds = new Set(CLAUDE_SETTING_IDS.filter(id => matcher.test(index[id])));
  const other = active ? claudeElsewhereIndex(t).filter(row => matcher.test(row.text)) : [];
  return {
    active,
    matches: (id: ClaudeSettingId) => !active || hitIds.has(id),
    hits: hitIds.size,
    error: matcher.error,
    otherTabs: [...new Set(other.map(row => row.tab))],
    otherHits: other.length,
  };
}
