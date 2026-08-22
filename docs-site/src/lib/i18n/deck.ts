/**
 * The copy this stage's surfaces render — the changelog viewer, the settings
 * page, the notifications and the dim sum card.
 *
 * ## Additive, on purpose
 *
 * `src/lib/strings.ts` already holds the chrome for the tab strip, the four tab
 * searches, the site search, the settings search and the regex builder, complete
 * in all five documentation locales. This deck does **not** restate any of it.
 * Where a key already exists there — `settings.search`, `settings.none`,
 * `settings.elsewhere`, every `tabs.*` and every `search.*` — this stage's
 * surfaces use that key and inherit its five translations for free.
 *
 * The two files are merged into one lookup table by `index.ts`, so a caller sees
 * a single `t()` over the union. Splitting them at the source is what keeps two
 * concurrent stages out of each other's file while still producing one
 * dictionary.
 *
 * ## Every key resolves here or nowhere
 *
 * `DeckKey` is `keyof typeof en`, so a translation cannot invent a key, and a
 * translation that omits one falls back to the English written here rather than
 * rendering blank.
 *
 * ## What is deliberately NOT here
 *
 *  - **Documentation prose.** The 161 content pages are Starlight's, routed by
 *    URL locale. This is chrome.
 *  - **Funny-level variants.** They live in `voice.ts` as an overlay. Level 3
 *    *is* the wording below; restating it there would be a second copy to keep
 *    in step, and the first drift would make the slider lie.
 *  - **Anything with a pluralised count baked into the sentence.** Counts are
 *    interpolated, and the templates say "{count} release(s)" rather than
 *    pretending four languages share English's plural rule.
 */

export const en = {
  /* ------------------------------------------------------- notifications -- */
  "notif.title": "Notifications",
  "notif.open": "Open notifications",
  "notif.unread": "{count} unread",
  "notif.empty": "Nothing has happened yet.",
  "notif.emptyHint": "Messages the site shows you stay here after they leave the corner.",
  "notif.clear": "Clear history",
  "notif.markAllRead": "Mark all as read",
  "notif.dismiss": "Dismiss",
  "notif.close": "Close notifications",
  "notif.justNow": "just now",
  "notif.minutesAgo": "{n} min ago",
  "notif.hoursAgo": "{n} h ago",
  "notif.daysAgo": "{n} d ago",
  "notif.historyCleared": "Notification history cleared.",
  "notif.live": "Recent messages",

  /* ------------------------------------------------------------- dim sum -- */
  "dimsum.title": "A dim sum appeared",
  "dimsum.dismiss": "Dismiss",
  "dimsum.why": "Why this?",
  "dimsum.explain": "One launch in ten shows a dish. It sees itself out.",
  "dimsum.settings": "Settings",

  /* ----------------------------------------------------------- changelog -- */
  "changelog.title": "Changelog",
  "changelog.lead": "Every released version of opencodex, newest first.",
  "changelog.search": "Search the changelog",
  "changelog.searchPh": "Search release entries",
  "changelog.from": "From",
  "changelog.to": "To",
  "changelog.dateHint": "YYYY-MM-DD, or pick from the calendar.",
  "changelog.invalidDate": "“{value}” is not a date this filter understands. Use YYYY-MM-DD.",
  "changelog.openCalendar": "Open the calendar",
  "changelog.preset7": "Last 7 days",
  "changelog.preset30": "Last 30 days",
  "changelog.preset90": "Last 90 days",
  "changelog.presetYear": "This year",
  "changelog.presetAll": "All time",
  "changelog.prevMonth": "Previous month",
  "changelog.nextMonth": "Next month",
  "changelog.month": "Month",
  "changelog.year": "Year",
  "changelog.today": "Today",
  "changelog.pickStart": "Choose the start date",
  "changelog.pickEnd": "Choose the end date",
  "changelog.clearFilters": "Clear filters",
  "changelog.shown": "{shown} of {total} release(s), {entries} entr(y/ies).",
  "changelog.noResults": "No release matches both filters.",
  "changelog.noResultsHint": "Widen the dates or change the search text — the two compose, so either one can be what is excluding everything.",
  "changelog.undated": "no date recorded",
  "changelog.export": "Export Markdown",
  "changelog.exportAs": "Export as…",
  "changelog.copy": "Copy",
  "changelog.copied": "Copied the filtered changelog to the clipboard.",
  "changelog.copyFailed": "The clipboard refused the copy. The export button writes the same text to a file.",
  "changelog.exported": "Exported {count} release(s) as Markdown.",
  "changelog.rangeAll": "all dates",
  "changelog.rangeTo": "up to {to}",
  "changelog.rangeFrom": "from {from}",
  "changelog.rangeBoth": "{from} to {to}",
  "changelog.exportNote": "Range: {range}. Search: {search}.",
  "changelog.searchNone": "none",
  "changelog.empty": "No changelog entries were found in the source file.",
  "changelog.entriesHidden": "{count} further entr(y/ies) in this release do not match the search.",
  "changelog.kindFeat": "Features",
  "changelog.kindFix": "Fixes",
  "changelog.kindPerf": "Performance",
  "changelog.kindDocs": "Documentation",
  "changelog.kindTest": "Tests",
  "changelog.kindRefactor": "Refactoring",
  "changelog.kindCi": "Build & CI",
  "changelog.kindChore": "Housekeeping",
  "changelog.kindOther": "Other",

  /* ------------------------------------------------------------ settings -- */
  "settings.title": "Settings",
  "settings.lead": "Everything here is stored in this browser only. Nothing is sent anywhere.",
  "settings.reset": "Reset this section",
  "settings.resetAll": "Reset every setting",
  "settings.resetDone": "Settings reset to their defaults.",
  "settings.value": "Currently: {value}",
  "settings.sectionLanguage": "Language & voice",
  "settings.sectionNotifications": "Notifications",
  "settings.sectionDelight": "Dim sum",

  "school.title": "School mode",
  "school.description": "Forces this documentation surface to English and temporarily removes playful language, bilingual controls and private vocabulary from the visible settings. Stored choices return when it is off.",
  "school.on": "School mode is on",
  "school.off": "School mode is off",
  "school.turnOn": "Turn on School mode",
  "school.turnOff": "Turn off School mode",
  "school.languageForced": "English is forced while School mode is on. Stored language and funny-level choices are kept for later.",
  "school.resetHint": "This site uses browser storage for the equivalent. Clearing this site's stored data resets the mode.",

  "vocab.title": "Personal vocabulary",
  "vocab.description": "Choose a local JSON file to replace authored interface wording on this site. Nothing is uploaded, and the file name is not retained.",
  "vocab.noFile": "No local vocabulary file is active.",
  "vocab.choose": "Choose a local JSON file",
  "vocab.replace": "Replace local JSON file",
  "vocab.loaded": "A validated local vocabulary file is active.",
  "vocab.invalid": "The selected file was not applied because it failed validation.",
  "vocab.clear": "Clear local vocabulary",
  "vocab.cleared": "Local vocabulary cleared; original wording is active again.",
  "vocab.loading": "Validating the local file…",
  "vocab.fileHint": "Version 1 uses a bounded entries object. Duplicate, unsafe, oversized, malformed or unknown fields are rejected as one file.",
  "vocab.invalidReason": "Validation result: {reason}.",
  "vocab.searchHint": "The settings search and its anchored regex builder include this row while School mode is off.",

  "lang.mode": "Interface language",
  "lang.modeHint": "This is the language of the interface — the strip, the menus, this page. The language of the documentation itself is chosen with the language menu in the header.",
  "lang.auto": "Follow the page",
  "lang.autoHint": "The interface speaks whatever language the article does.",
  "lang.resolved": "On this page that means {mode}.",

  "funny.title": "Funny level",
  "funny.en": "English playfulness",
  "funny.yue": "廣東話 playfulness",
  "funny.hint": "1 is fully professional, 5 is maximum playfulness. Each language has its own level.",
  "funny.disclosure": "This styles every message the site shows you, warnings and errors included. It never changes the facts — a message always names the real thing it is about.",
  "funny.level1": "Serious",
  "funny.level2": "Plain",
  "funny.level3": "Normal",
  "funny.level4": "Playful",
  "funny.level5": "Maximum",
  "funny.preview": "Preview",
  "funny.previewHint": "The same message, at the level you have chosen.",
  "funny.coverage": "{voiced} of {total} messages carry level-specific wording. The rest read the same at every level, because “Save” has one sensible rendering.",
  "funny.noOverlay": "The sliders restyle the English and 廣東話 voices. The interface is currently {mode}, which has translated wording but no level variants — set the interface language to English, 廣東話 or bilingual to hear them.",
  "funny.categories": "Categories restyled",
  "funny.noFinancial": "This site shows no financial messages, so that category has nothing to restyle.",

  "notifpref.autoDismiss": "Auto-dismiss after",
  "notifpref.autoDismissHint": "Informational messages disappear on their own after the delay above. Warnings and errors always wait for you.",
  "notifpref.seconds": "{n} seconds",
  "notifpref.keepHistory": "Keep a history",
  "notifpref.keepHistoryHint": "Dismissed messages stay readable in the notification centre.",
  "notifpref.test": "Show a test notification",
  "notifpref.testBody": "This is what a notification looks like at your current settings.",

  "dimsumpref.enabled": "Dim sum surprise",
  "dimsumpref.always": "Always on",
  "dimsumpref.hint": "One launch in ten, never on your first visit, never while you are in the middle of something, and it dismisses itself. There is no switch: an interruption this polite does not need one. The picture is bundled with the site — nothing is fetched and nothing is counted.",
  "dimsumpref.preview": "Show me one now",

  /* ------------------------------------------------------------- generic -- */
  "common.on": "On",
  "common.off": "Off",
  "common.close": "Close",
  "common.loading": "Loading…",
} as const;

/** Every key this deck declares. */
export type DeckKey = keyof typeof en;

/** A translation is free to be partial; the English above is the floor. */
export type DeckDict = Partial<Record<DeckKey, string>>;
