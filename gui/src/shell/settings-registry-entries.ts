/**
 * What each settings surface contributes to the shared cross-page index.
 *
 * One file rather than a `registerSettingsPage` call inside each page component,
 * for the reason `settings-registry.ts` sets out at length: the index has to
 * describe screens that are **not open**, and a registration that runs on mount
 * only ever knows about the screen you are already looking at. Importing this
 * module is therefore what makes the index complete, and `use-settings-search.ts`
 * imports it for that side effect so no surface can forget to.
 *
 * Keeping the blocks together has a second benefit the eight-row list it
 * replaces was already relying on: coverage is checkable by reading down one
 * file. A per-page registration scattered across fifteen components is a
 * completeness question nobody can answer without opening fifteen files.
 *
 * ## The rule for adding a row
 *
 * A row belongs to the page that owns the setting's **real editor**, not to
 * every page that displays it. `Settings` is the app's aggregate view — it shows
 * theme, density, cleanup policy and a dozen more, each with a `settings.jumpTo`
 * link to the screen that actually edits them — so it registers nothing of its
 * own. Registering its mirrored rows would report the same setting twice under
 * two page names and send half the users to the screen that cannot fully edit it.
 *
 * Every key below resolves in the dictionaries today. That is not a stylistic
 * preference: a row whose key resolves to nothing renders as an empty label and
 * points the user at a tab to look for a setting that is not named there, which
 * is worse than a shorter index. `TKey` makes a missing key a compile error, so
 * the way to add a row for a setting whose copy does not exist yet is to write
 * the copy first.
 */

import { registerSettingsPage } from "./settings-registry";

/* ------------------------------------------------------------- dashboard -- */

/**
 * The proxy, routing and agent settings. Their editors are the Dashboard's own
 * cards; `Settings` mirrors them, which is why the `jump` targets on that page
 * all name `dashboard` and why they are registered here rather than there.
 */
export const DASHBOARD_SETTINGS = registerSettingsPage({
  page: "dashboard",
  navKey: "nav.dashboard",
  rows: [
    { id: "codexAutoStart", tkey: "dash.codexAutoStart" },
    { id: "shadowCall", tkey: "dash.shadowCallIntercept" },
    { id: "shadowCallModel", tkey: "dash.shadowCallModel" },
    { id: "webSearchSidecar", tkey: "dash.webSearchSidecar" },
    { id: "visionSidecar", tkey: "dash.visionSidecar" },
    { id: "multiAgent", tkey: "dash.multiAgent", keywordKeys: ["models.v2Mode_v1", "models.v2Mode_default", "models.v2Mode_v2"] },
    { id: "multiAgentGuidance", tkey: "dash.multiAgentGuidance" },
    { id: "injectionModel", tkey: "dash.injectionLabel" },
    { id: "injectionEffort", tkey: "dash.injectionEffortLabel" },
    { id: "syncCodexSubagentDefaults", tkey: "dash.syncCodexSubagentDefaults" },
    { id: "effortCap", tkey: "dash.effortCapLabel", keywordKeys: ["dash.effortCapNone"] },
    { id: "subagentEffortCap", tkey: "dash.subagentEffortCapLabel" },
  ],
});

/* --------------------------------------------------------------- startup -- */

export const STARTUP_SETTINGS = registerSettingsPage({
  page: "startup",
  navKey: "nav.startup",
  rows: [
    { id: "routing", tkey: "startup.routing", keywordKeys: ["startup.routing.proxy", "startup.routing.native"] },
    { id: "restartProtection", tkey: "startup.restartProtection", keywordKeys: ["startup.protection.service", "startup.protection.shim"] },
    { id: "preference", tkey: "startup.preference", keywordKeys: ["startup.enabled", "startup.disabled"] },
    { id: "trayLogin", tkey: "startup.tray.login", descKey: "startup.tray.notProtection" },
    { id: "trayInstall", tkey: "startup.tray.install" },
    { id: "trayStart", tkey: "startup.tray.start" },
    { id: "trayStop", tkey: "startup.tray.stop" },
    { id: "trayUninstall", tkey: "startup.tray.uninstall", descKey: "startup.tray.uninstallConfirm" },
  ],
});

/* ---------------------------------------------------------------- models -- */

export const MODELS_SETTINGS = registerSettingsPage({
  page: "models",
  navKey: "nav.models",
  rows: [
    { id: "contextCap", tkey: "models.contextCapLabel" },
    { id: "v2Threads", tkey: "models.v2ThreadsLabel" },
  ],
});

/* --------------------------------------------------------------- storage -- */

export const STORAGE_SETTINGS = registerSettingsPage({
  page: "storage",
  navKey: "nav.storage",
  rows: [
    { id: "enabled", tkey: "storage.policy.enabled", descKey: "storage.policy.enabledHint" },
    { id: "threshold", tkey: "storage.policy.threshold" },
    { id: "target", tkey: "storage.policy.target" },
    {
      id: "schedule",
      tkey: "storage.policy.schedule",
      keywordKeys: [
        "storage.policy.schedule.manual",
        "storage.policy.schedule.startup",
        "storage.policy.schedule.daily",
        "storage.policy.schedule.weekly",
      ],
    },
    {
      id: "mode",
      tkey: "storage.policy.mode",
      descKey: "storage.policy.permanentWarn",
      keywordKeys: ["storage.policy.mode.quarantine", "storage.policy.mode.permanent"],
    },
    { id: "lastRun", tkey: "storage.policy.lastRun" },
    { id: "nextRun", tkey: "storage.policy.nextRun" },
  ],
});

/* ------------------------------------------------------------ codex auth -- */

export const CODEX_AUTH_SETTINGS = registerSettingsPage({
  page: "codex-auth",
  navKey: "nav.codexAuth",
  rows: [
    {
      id: "accountMode",
      tkey: "codexAuth.accountModeTitle",
      descKey: "codexAuth.accountModePoolDesc",
      keywordKeys: ["codexAuth.accountModePool", "codexAuth.accountModeDirect"],
    },
    {
      id: "strategy",
      tkey: "accountPool.strategy",
      descKey: "accountPool.strategyDesc",
      keywordKeys: [
        "accountPool.strategyQuota",
        "accountPool.strategyRoundRobin",
        "accountPool.strategyFillFirst",
        "accountPool.strategyHint",
      ],
    },
    { id: "stickyLimit", tkey: "accountPool.stickyLimit", descKey: "accountPool.stickyLimitHelp" },
  ],
});

/* ------------------------------------------------------------------- api -- */

export const API_SETTINGS = registerSettingsPage({
  page: "api",
  navKey: "nav.api",
  rows: [
    { id: "keys", tkey: "api.title", descKey: "api.subtitle" },
  ],
});

/* ---------------------------------------------------------------- claude -- */

/**
 * The fifteen ids in `pages/claude-settings-search.ts`, in the same order.
 * That module keeps the labels the Claude tab renders; this keeps the same
 * settings addressable from every *other* screen, which previously they were not
 * from any of them.
 */
export const CLAUDE_SETTINGS = registerSettingsPage({
  page: "claude",
  navKey: "nav.claude",
  rows: [
    { id: "enabled", tkey: "claude.enabledLabel", descKey: "claude.enabledHint" },
    { id: "effectiveMode", tkey: "claude.effectiveMode.label" },
    {
      id: "authMode",
      tkey: "claude.authMode",
      descKey: "claude.authModeHint",
      keywordKeys: ["claude.authModeAuto", "claude.authModeSubscription", "claude.authModeProxy"],
    },
    {
      id: "fastMode",
      tkey: "claude.fastMode",
      descKey: "claude.fastModeDesc",
      keywordKeys: ["claude.fastAuto", "claude.fastOn", "claude.fastOff"],
    },
    { id: "maxContext", tkey: "claude.maxContext", descKey: "claude.maxContextDesc" },
    { id: "autoContext", tkey: "claude.autoContext", descKey: "claude.autoContextDesc" },
    { id: "autoCompactWindow", tkey: "claude.autoCompactWindow", descKey: "claude.autoCompactWindowDesc" },
    { id: "injectAgents", tkey: "claude.injectAgents", descKey: "claude.injectAgentsDesc" },
    { id: "systemEnv", tkey: "claude.systemEnv", descKey: "claude.systemEnvDesc" },
    { id: "webSearchSidecar", tkey: "claude.webSearchSidecar", descKey: "claude.webSearchSidecarHint" },
    { id: "visionSidecar", tkey: "claude.visionSidecar", descKey: "claude.visionSidecarHint" },
    { id: "quickstart", tkey: "claude.quickstart", keywordKeys: ["claude.manualEnv"] },
    { id: "smallFastModel", tkey: "claude.smallFastModel" },
    { id: "modelMap", tkey: "claude.modelMap", descKey: "claude.modelMapHint" },
    { id: "aliases", tkey: "claude.aliases", descKey: "claude.aliasesHint" },
  ],
});

/* ------------------------------------------------------------------ grok -- */

export const GROK_SETTINGS = registerSettingsPage({
  page: "grok",
  navKey: "nav.grok",
  rows: [
    { id: "grok", tkey: "grok.title", descKey: "grok.subtitle" },
  ],
});

/* ------------------------------------------------------------ appearance -- */

export const APPEARANCE_SETTINGS = registerSettingsPage({
  page: "appearance",
  navKey: "nav.appearance",
  rows: [
    {
      id: "theme",
      tkey: "appearance.themeTitle",
      descKey: "appearance.themeSub",
      keywordKeys: ["theme.light", "theme.dark", "theme.system"],
    },
    { id: "seed", tkey: "appearance.seedTitle", descKey: "appearance.seedSub" },
    { id: "density", tkey: "appearance.densityTitle", descKey: "appearance.densitySub" },
    { id: "font", tkey: "appearance.font", descKey: "appearance.typeSub" },
    { id: "fontScale", tkey: "appearance.fontScale", descKey: "appearance.typeTitle" },
    { id: "fontWeight", tkey: "appearance.fontWeight", descKey: "appearance.typeTitle" },
    {
      id: "logo",
      tkey: "appearance.logoTitle",
      descKey: "appearance.logoSub",
      keywordKeys: [
        "appearance.logoUploadLabel",
        "appearance.logoReplaceLabel",
        "appearance.logoResetLabel",
        "appearance.logoPresetShipped",
        "appearance.logoPresetCircle",
        "appearance.logoPresetSquare",
        "appearance.logoPresetOutline",
      ],
    },
    // Renaming the app is the setting somebody looks for by the *word* rather
    // than by the screen — "rename", "title", "call it something else" — and
    // none of those words appear in the label. The keywords carry them, so the
    // palette and every settings search bar in the app find the row from any
    // of them rather than only from "App name".
    {
      id: "appName",
      tkey: "appearance.appNameTitle",
      descKey: "appearance.appNameSub",
      keywordKeys: [
        "appearance.appNameLabel",
        "appearance.appNameSave",
        "appearance.appNameReset",
        "appearance.appNameWhere",
      ],
    },
  ],
});

/* -------------------------------------------------------------- language -- */

export const LANGUAGE_SETTINGS = registerSettingsPage({
  page: "language",
  navKey: "nav.language",
  rows: [
    { id: "mode", tkey: "lang.mode", descKey: "lang.sub" },
    // Suppressed while School Mode is forcing English presentation, per the
    // universal contract: Cantonese, bilingual, funny-level, personal-
    // vocabulary and dim-sum "behave as if they are not installed" — omitted
    // from search and the palette, not merely hidden from the card. See
    // `visibleSettingsRows()` in `settings-registry.ts` for where this flag
    // is actually enforced, and `schoolMode` below for the control that owns
    // the mode itself, which is never suppressed.
    { id: "funnyEn", tkey: "lang.funnyEn", descKey: "lang.funnyLadder", schoolModeSuppressed: true },
    { id: "funnyYue", tkey: "lang.funnyYue", descKey: "lang.funnyLadder", schoolModeSuppressed: true },
    { id: "narrator", tkey: "narrator.title", descKey: "narrator.sub", keywordKeys: ["narrator.langBoth"] },
    // The voice, speed and pitch controls are separately findable: somebody who
    // wants the narrator to stop sounding like a robot searches for "voice" or
    // "speed", not for "narrator", and landing on the card is not the same as
    // knowing the controls are on it.
    { id: "narratorVoice", tkey: "narrator.voice", descKey: "narrator.voiceSub", keywordKeys: ["narrator.voiceAuto"] },
    { id: "narratorRate", tkey: "narrator.rateShort", descKey: "narrator.voiceSub" },
    { id: "narratorPitch", tkey: "narrator.pitchShort", descKey: "narrator.voiceSub" },
    {
      id: "narratorEdge",
      tkey: "narrator.edgeTitle",
      descKey: "narrator.edgeDisclosure",
      keywordKeys: ["narrator.edgeEnable", "narrator.edgeCantonese"],
    },
    { id: "showEmojis", tkey: "emoji.title", descKey: "emoji.sub" },
    { id: "dimsum", tkey: "dimsum.toggle", schoolModeSuppressed: true },
    {
      id: "vocabulary",
      tkey: "vocab.title",
      descKey: "vocab.sub",
      keywordKeys: ["vocab.uploadLabel", "vocab.replaceLabel", "vocab.clearLabel"],
      schoolModeSuppressed: true,
    },
    // Never suppressed — "the mode control itself remains discoverable and
    // accessible" even while the mode it controls is on.
    {
      id: "schoolMode",
      tkey: "schoolMode.title",
      descKey: "schoolMode.sub",
      keywordKeys: ["schoolMode.renameLabel", "schoolMode.credentialTitle"],
    },
  ],
});

/* ---------------------------------------------------------------- schedule -- */

export const SCHEDULE_SETTINGS = registerSettingsPage({
  page: "schedule",
  navKey: "nav.schedule",
  rows: [
    { id: "rules", tkey: "schedule.title", descKey: "schedule.subtitle" },
    { id: "addRule", tkey: "schedule.addRule" },
    { id: "precedence", tkey: "schedule.priority", descKey: "schedule.precedenceNote" },
    { id: "source", tkey: "schedule.source", keywordKeys: ["schedule.sourceLocal", "schedule.sourceApi", "schedule.sourceHomeAssistant"] },
  ],
});

/* --------------------------------------------------------- notifications -- */

export const NOTIFICATIONS_SETTINGS = registerSettingsPage({
  page: "notifications",
  navKey: "nav.notifications",
  rows: [
    { id: "history", tkey: "notif.historyTitle", descKey: "notif.historySub" },
    {
      id: "tone",
      tkey: "notif.toneAll",
      keywordKeys: ["notif.toneError", "notif.toneWarn", "notif.toneSuccess", "notif.toneInfo"],
    },
    { id: "clear", tkey: "notif.clear" },
  ],
});

/* --------------------------------------------------------------- network -- */

export const NETWORK_SETTINGS = registerSettingsPage({
  page: "network",
  navKey: "nav.network",
  rows: [
    { id: "exposed", tkey: "network.exposed", keywordKeys: ["network.endpointWords"] },
    { id: "urls", tkey: "network.urls" },
    { id: "mobile", tkey: "network.mobileTitle", descKey: "network.mobileHint" },
    { id: "customKey", tkey: "network.customKeyTitle", descKey: "network.customKeyHint" },
    { id: "export", tkey: "network.exportTitle", descKey: "network.exportSub", keywordKeys: ["network.exportWarning"] },
    { id: "history", tkey: "network.historyTitle", descKey: "network.historySub" },
  ],
});

/* ---------------------------------------------------------------- mobile -- */

export const MOBILE_SETTINGS = registerSettingsPage({
  page: "mobile",
  navKey: "nav.mobile",
  rows: [
    { id: "model", tkey: "mobile.model" },
    { id: "proxy", tkey: "mobile.proxy", keywordKeys: ["mobile.exposed", "mobile.loopback"] },
    { id: "pairing", tkey: "mobile.pairing", keywordKeys: ["mobile.pairedState", "mobile.unpairedState", "mobile.forget"] },
    // The key itself is never indexed here either, for the reason `Mobile.tsx`
    // gives at its own option: this corpus is handed to the regex builder and
    // rendered into a plain textarea, so indexing the value would paint a live
    // proxy credential on the screen.
    { id: "apiKey", tkey: "mobile.apiKey", descKey: "mobile.apiKeyHint" },
  ],
});

/* ------------------------------------------------------------------ logs -- */

export const LOGS_SETTINGS = registerSettingsPage({
  page: "logs",
  navKey: "nav.logs",
  rows: [
    { id: "debug", tkey: "debug.debug", descKey: "debug.captureSub" },
    { id: "usage", tkey: "debug.usage", descKey: "debug.captureSub" },
    { id: "injection", tkey: "debug.injection", descKey: "debug.captureSub" },
    { id: "claude", tkey: "debug.claude", descKey: "debug.captureSub" },
    {
      id: "stream",
      tkey: "debug.streamsAria",
      keywordKeys: ["debug.streamProvider", "debug.streamUsage", "debug.streamInjection"],
    },
    { id: "follow", tkey: "debug.follow" },
    { id: "reset", tkey: "debug.reset" },
  ],
});
