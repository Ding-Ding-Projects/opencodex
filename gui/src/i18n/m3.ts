/**
 * Copy for the Material 3 shell and the six system screens.
 *
 * Kept out of `en.ts` on purpose. The five translated dictionaries are typed
 * `Record<TKey, string>` so that a missing translation is a *compile* error for
 * the 1 500 product keys — a guarantee worth keeping. Adding this block there
 * would have forced 130 placeholder strings into every locale to restore the
 * build, which converts that guarantee into noise.
 *
 * Instead these keys resolve through `M3_OVERRIDES` with an English fallback, so
 * a locale can be filled in incrementally, one screen at a time, without ever
 * breaking the build. Untranslated keys render in English rather than as a raw
 * key name.
 */

import type { Locale } from "./shared";

export const M3_EN = {
  // ---- shell ----
  "nav.appearance": "Appearance",
  "nav.language": "Language & voice",
  "nav.regex": "Regex builder",
  "nav.changelog": "Changelog",
  "nav.history": "Version history",
  "nav.notifications": "Notifications",
  "nav.network": "Remote access & backup",
  "nav.terminal": "Terminal",
  "nav.mobile": "Remote control",
  "network.mobileTitle": "Open on a phone",
  "network.mobileHint": "Pairing shows a QR code that carries a one-time code as well as the address. The phone spends it on the way in and keeps a key of its own, so nothing gets typed and nothing gets read out.",
  "network.pairStart": "Pair a phone",
  "network.pairWarn": "This code is a credential. Anyone who scans it before your phone does gets a key that can send requests through this proxy and spend your provider accounts. It is good for one device and expires in five minutes.",
  "network.pairQrAlt": "Pairing QR code for {url}",
  "network.pairCopyLink": "Copy pairing link",
  "network.pairExpiresIn": "Expires in {time}",
  "network.pairExpired": "This code has expired. Generate a new one.",
  "network.pairRegenerate": "New code",
  "network.pairClose": "Done",
  "network.pairFailed": "Could not generate a pairing code",
  "network.pairNeedsRestart": "Restart the proxy first (ocx stop && ocx start). Until then it is still listening on this machine only, so a phone would scan the code and fail to connect — and the code lasts five minutes.",
  // Honest coverage. The level styles the copy where voice actually reads —
  // headings, empty states, confirmations, errors — and every other string keeps
  // its neutral wording rather than being padded with five near-identical
  // variants of the word "Save".
  //
  // The category list is the disclosure the setting owes the user: nothing is
  // exempt, errors and destructive warnings included, so it says so here rather
  // than letting a level-5 warning be a surprise.
  "lang.funnyCoverage": "The level restyles {en} English and {yue} Cantonese messages today — every category, including error, warning, destructive, security, financial and accessibility copy. Everything else keeps its neutral wording. The facts never change at any level: the same file, the same account, the same consequence, at 1 and at 5.",

  "mobile.title": "opencodex remote",
  "mobile.chat": "Chat",
  "mobile.sessions": "Sessions",
  "mobile.control": "Control",
  "mobile.model": "Model",
  "mobile.prompt": "Message",
  "mobile.send": "Send",
  "mobile.stop": "Stop",
  "mobile.transcript": "Conversation",
  "mobile.chatHint": "Pick a model above and send a message. It routes through this proxy like any other client, so it is logged and counted the same way.",
  "mobile.emptyReply": "(the model returned nothing)",
  "mobile.stopped": "(stopped before the reply started)",
  "mobile.sendFailed": "Could not send that message",
  "mobile.noSessions": "No requests yet",
  "mobile.sessionsFailed": "Could not read the session log. It needs the admin token, which lives on the desktop — pairing gives this device a key for sending requests, not for reading the proxy's own settings.",
  "mobile.hostUnavailable": "Could not read the proxy's status. It needs the admin token, which lives on the desktop.",
  "mobile.proxy": "Proxy",
  "mobile.exposed": "Reachable from other devices",
  "mobile.loopback": "This machine only",
  "mobile.noCredential": "Published to the network with no credential configured.",
  "mobile.apiKey": "API key",
  "mobile.apiKeyHint": "Needed when the proxy is published to the network. Pairing fills this in for you; type one here only if you are not using a QR code.",
  "mobile.keyPlaceholder": "ocx_…",
  "mobile.pairing": "This device",
  "mobile.pairedState": "Paired",
  "mobile.unpairedState": "Not paired",
  "mobile.pairedHint": "The key from pairing is saved in this browser, so you will not be asked to scan again. It can send requests through the proxy; it cannot change any setting. Revoke it from API keys on the desktop, where it is listed as \"Paired device\".",
  "mobile.unpairedHint": "Open Remote access on the desktop, choose Pair a phone, and scan the code with this device's camera.",
  "mobile.pairingClaiming": "Pairing this device…",
  "mobile.paired": "Paired",
  "mobile.pairedBody": "This device has its own key now, saved here so you will not scan again.",
  "mobile.pairFailed": "Pairing failed",
  "mobile.pairFailed.expired": "That code had already expired. Codes last five minutes — generate a new one on the desktop and scan again.",
  "mobile.pairFailed.no-pairing": "The desktop is not offering a pairing code right now. Open Remote access there, choose Pair a phone, then scan.",
  "mobile.pairFailed.mismatch": "That code was not accepted. It may already have been used — each one pairs a single device. Generate a new one and scan again.",
  "mobile.pairFailed.rate-limited": "Too many pairing attempts on this proxy. Wait a minute, then scan a fresh code.",
  "mobile.pairFailed.no-connection": "Could not reach the proxy to finish pairing. Check this device is on the same network, then try again.",
  "mobile.pairFailed.sandbox": "The desktop is running in debug mode (OPENCODEX_DEBUG_SANDBOX), which never issues a key and never saves settings. Scanning again will not help — restart the desktop without that setting to pair for real.",
  "mobile.debugSandbox": "The desktop is in debug mode, so it will not issue a key and this device cannot pair. Restart the desktop without OPENCODEX_DEBUG_SANDBOX to pair for real.",
  "export.title": "Export {label}",
  "export.rows": "{count} record(s) available.",
  "export.formats": "Formats",
  "export.formatsHint": "Pick one, or several to get an archive containing each.",
  "export.willLose": "What these formats cannot carry:",
  "export.archive": "Archive",
  "export.archiveNone": "No archive — download the file itself",
  "export.zip": "ZIP",
  "export.httpError": "The export failed with HTTP {status}.",
  "export.sevenZipUnavailable": "7z — not available on this machine",
  "export.method": "Compression method",
  "export.level": "Compression level",
  "export.levelHint": "Higher compresses smaller and takes longer. Extraction needs comparable memory.",
  "export.levelStore": "0 — store, no compression",
  "export.dictionary": "Dictionary size",
  "export.dictionaryHint": "Larger finds longer matches. Whoever extracts this needs about as much memory as you do.",
  "export.solid": "Solid archive",
  "export.solidHint": "Solid is smaller, but reading one file may decompress others. Turn it off to extract single files quickly.",
  "export.volume": "Split into volumes",
  "export.volumeHint": "Leave empty for one file. Every part is needed to extract.",
  "export.password": "Password",
  "export.passwordHint": "AES-256. Treat this as single-use — it is passed to 7-Zip on its command line, which other programs on this machine can see.",
  "export.encryptHeaders": "Encrypt file names too",
  "export.encryptHeadersHint": "On by default. 7-Zip leaves names readable unless this is set.",
  "export.headersReadable": "File names will stay READABLE to anyone who has this archive, even though the contents are encrypted. A name like \"salary-review.csv\" gives away most of what it is.",
  "export.openAfter": "Open in Visual Studio Code",
  "export.openAfterHint": "Writes the export to a folder and opens it as a workspace.",
  "export.vsCodeMissing": "Visual Studio Code was not found on this machine.",
  "export.run": "Export",
  "export.working": "Exporting…",
  "export.capsFailed": "Could not read what this list can be exported as.",
  "mobile.forget": "Forget this device",
  "mobile.forgetConfirm": "Delete the paired key from this browser? The proxy will refuse this device until you scan a new pairing code. The key itself stays listed on the desktop under API keys until you revoke it there.",
  "mobile.forgotten": "Key deleted from this device",
  "mobile.forgottenBody": "Pair again to keep using the remote. Revoke the old key from API keys on the desktop if nobody else should hold it.",
  "mobile.keyRejectedBody": "The proxy refused this device's key. It was probably revoked or replaced on the desktop — scan a new pairing code from Remote access.",
  "mobile.keyMissingBody": "The proxy needs a key and this device has none. Scan a pairing code from Remote access on the desktop.",
  "mobile.tokens": "{n} tokens",
  "mobile.httpStatus": "The proxy answered {status} with no detail.",
  "mobile.modelsFailed": "Could not reach the proxy to load models.",
  "mobile.retry": "Retry",
  // The settings search names the bottom bar as one of the things it can find,
  // so the bar needs a name of its own — "opencodex remote" is what the whole
  // screen is called, and searching for that to reach a three-way switch is not
  // a thing anyone would think to type.
  "mobile.panelNav": "Panel",
  // Said instead of the key, never beside it: the search corpus is also the
  // regex builder's sample text, so the value has to describe the field rather
  // than repeat it.
  "mobile.keySet": "Saved in this browser",
  "nav.settings": "Settings",

  // ---- settings surface ----
  "settings.title": "Settings",
  "settings.sub": "Every adjustable value in one place. Each change is recorded in the local history, so any of it can be undone.",
  "settings.groupProxy": "Proxy",
  "settings.groupRouting": "Routing",
  "settings.groupAgents": "Agents",
  "settings.groupStorage": "Storage",
  "settings.groupAppearance": "Appearance",
  "settings.groupPrivacy": "Privacy & history",
  "settings.savedTitle": "Setting saved",
  "settings.savedBody": "Recorded in the local history — restore it from Version history if this was a mistake.",
  "settings.saveFailed": "Could not save that setting",
  "settings.jumpTo": "Open {page}",
  "settings.historyNote": "Every change on this page writes a snapshot to the local git history in your config directory. Nothing is pushed anywhere.",

  // ---- onboarding ----
  "onboard.title": "Welcome to opencodex",
  "onboard.sub": "Three steps, and you can change any of it later.",
  "onboard.skip": "Skip setup",
  "onboard.back": "Back",
  "onboard.next": "Next",
  "onboard.finish": "Finish",
  "onboard.stepOf": "Step {n} of {total}",
  "onboard.langTitle": "Pick a language",
  // First-run disclosure. The funny level is opt-in behaviour that reaches error
  // and warning copy, so the user is told that here — before they meet a level-5
  // delete confirmation — rather than only on the settings screen they may never
  // open. What it cannot change is said in the same breath.
  "onboard.langSub": "English, Cantonese, or both side by side. Change it any time on Language & voice, along with a funny level per language — that styles every message, errors and destructive warnings included, and never the facts.",
  "onboard.providerTitle": "Connect a provider",
  "onboard.providerSub": "opencodex routes Codex and Claude Code to whatever you point it at. Sign in now, or do it later on Providers.",
  "onboard.providerSkip": "I'll do this later",
  "onboard.doneTitle": "You're set",
  "onboard.doneSub": "The proxy is running. Point Codex at it, or open a CLI straight from the dashboard.",
  "onboard.dontShow": "Don't show this again",
  "onboard.networkTitle": "Reach it from other devices",
  "onboard.networkSub": "opencodex runs on this machine. You can find one already running on your network, or publish this one so a phone or laptop can use it.",
  "onboard.netScan": "Find on my network",
  "onboard.netScanning": "Looking…",
  "onboard.netNone": "Nothing answering on this network. That is normal if this is your only install.",
  "onboard.netThisMachine": "this machine",
  "onboard.netConnect": "Open",
  "onboard.netExpose": "Publish this one to my network",
  "onboard.netExposeHint": "Off by default. Turning it on makes this proxy — and this dashboard — reachable by every other device on your network.",
  // Said before they type a password, not after the server refuses one:
  // publishing the proxy publishes the dashboard with it.
  "onboard.netExposeWarn": "This also publishes the dashboard, which can change providers, read logs and export your accounts. The password below is the only thing between the two. Only do this on a network you trust.",
  "onboard.netKey": "Connection password",
  "onboard.netKeyPlaceholder": "A password other devices will use",
  "onboard.netKeyRule": "At least {n} characters. Do not reuse a password you use anywhere else.",
  "onboard.netExposeAction": "Publish and create a key",
  "onboard.netAutoKeyHint": "One click. opencodex generates the key itself, so there is no password to invent here and none to type on your phone — pair it later by scanning a QR code from Remote access.",
  "onboard.netOwnKey": "Use a key I choose instead",
  "onboard.netOwnKeyAction": "Publish with my key",
  "onboard.netExposed": "Published to your network",
  "onboard.netExposedPending": "Saved. Restart the proxy (ocx stop && ocx start) before another device can connect.",
  "onboard.netExposeFailed": "Could not publish the proxy",
  "nav.primaryAria": "Primary navigation",

  "tabs.listAria": "Open pages",
  "tabs.close": "Close {name}",
  "tabs.overflow": "All tabs",
  // The overflow menu lists only the tabs that did NOT fit, and its badge counts
  // only those — so labelling it "All tabs" told the user five tabs were missing
  // from a list that was never claiming to hold them. Named for what it contains.
  "tabs.hidden": "Hidden tabs ({count})",
  "tabs.newTab": "New tab",

  // ---- the tab context menu ----
  // Named per tab, because several menus can have existed in one session and a
  // screen reader announcing a bare "Tab actions" cannot say which tab it acts on.
  "tabs.menuAria": "Actions for {name}",
  "tabs.closeTab": "Close tab",
  "tabs.closeOthers": "Close other tabs",
  "tabs.closeRight": "Close tabs to the right",
  "tabs.pin": "Pin tab",
  "tabs.unpin": "Unpin tab",
  "tabs.duplicate": "Duplicate tab",
  "tabs.closeContaining": "Close tabs containing text…",
  "tabs.closeNotContaining": "Close tabs not containing text…",
  "tabs.editAppearance": "Edit tab appearance…",

  // ---- the bulk closes ----
  "tabs.bulkContainTitle": "Close tabs containing text",
  "tabs.bulkNotContainTitle": "Close tabs not containing text",
  // Said before the user types, not after they wonder why a tab survived: this
  // matches the visible label only, and never reads what a page is showing.
  "tabs.bulkScope": "Matched against each tab's visible label. Page contents are never read.",
  "tabs.bulkQuery": "Text to match against tab labels",
  "tabs.bulkQueryPlaceholder": "Text in the tab label",
  "tabs.bulkBuilder": "Build a pattern for this bulk close",
  "tabs.bulkMode": "Match mode",
  "tabs.bulkModePlain": "Plain text",
  "tabs.bulkModeRegex": "Regular expression",
  "tabs.bulkEmpty": "Type something first. An empty query matches every tab, which would close the lot.",
  "tabs.bulkInvalid": "Invalid pattern: {error}",
  "tabs.bulkCount": "Would close {count} of {total} open tabs",
  "tabs.bulkPreview": "Tabs that would close",
  "tabs.bulkPinnedSpared": "Pinned tabs stay open: {count} of them.",
  "tabs.bulkIncludePinned": "Close pinned tabs too",
  "tabs.bulkConfirm": "Close {count}",
  "tabs.cancel": "Cancel",

  // ---- the new-tab search ----
  "tabs.searchPages": "Search pages",
  "tabs.searchPlaceholder": "Filter pages",
  "tabs.searchBuilder": "Build a pattern to filter pages",
  "tabs.searchNone": "No page matches “{query}”.",
  "tabs.searchInvalid": "Invalid pattern: {error}",

  // ---- the four tab-discovery searches ----
  // Four searches, four fields, four independent queries. They are named for
  // their scope rather than numbered, because a user reading "Search" four times
  // has no way to tell which list they are about to filter.
  "tabs.searchAll": "Find a tab",
  "tabs.searchClose": "Close the tab search",
  "tabs.searchStrip": "Tabs in this window",
  "tabs.searchStripPlaceholder": "Text in the tab label",
  "tabs.searchInGroup": "Tabs in {name}",
  "tabs.searchGroups": "Groups by name",
  "tabs.searchGroupsPlaceholder": "Text in the group name",
  "tabs.noGroups": "No groups yet. Right-click a tab — or press and hold it — to start one.",
  "tabs.searchEverywhere": "Every open tab",
  "tabs.windowN": "Window {n}",

  // ---- the per-tab appearance editor ----
  "tabs.styleFor": "Appearance for {name}",
  "tabs.styleClose": "Close the appearance editor",
  "tabs.stylePreview": "Preview",
  "tabs.styleColor": "Label colour",
  "tabs.styleColorPicker": "Pick a label colour",
  "tabs.styleBg": "Background",
  "tabs.styleBgPicker": "Pick a background colour",
  "tabs.styleFont": "Font",
  "tabs.styleFontInherit": "Inherit from the theme",
  "tabs.styleSize": "Label size",
  "tabs.styleWeight": "Label weight",
  "tabs.styleBadge": "Badge",
  "tabs.styleBadgeHint": "Up to {max} characters, shown after the label.",
  "tabs.styleReset": "Reset",
  "tabs.styleResetOne": "Reset {name} to the theme",
  "tabs.styleResetAll": "Reset every property",
  "tabs.styleInherits": "inherits the theme",
  // The swatch only speaks hex. A token or a named colour is kept exactly as
  // typed in the field beside it; the swatch is showing a stand-in, not the value.
  "tabs.styleSwatchFallback": "The swatch cannot show this value — the field beside it holds what is applied.",

  // ---- tab groups ----
  // A group is named and counted in its accessible name, never identified by
  // colour alone: the accent is decoration, and two groups a colour-blind reader
  // cannot tell apart would otherwise be two groups with no names.
  "tabs.groupAria": "{name}, {count} tabs",
  "tabs.groupMenuAria": "Actions for the group {name}",
  "tabs.group": "Group",
  "tabs.newGroup": "New group…",
  "tabs.addTo": "Add to {name}",
  "tabs.removeFromGroup": "Remove from group",
  "tabs.collapse": "Collapse group",
  "tabs.expand": "Expand group",
  "tabs.renameGroup": "Rename group…",
  "tabs.ungroup": "Ungroup",
  "tabs.groupName": "Group name",
  "tabs.groupNamePlaceholder": "What these tabs are for",
  "tabs.groupSave": "Save",
  "tabs.editGroupAppearance": "Edit group appearance…",
  "tabs.groupStyleFor": "Appearance for the group {name}",
  "tabs.groupAccent": "Group colour",
  "tabs.groupAccentPicker": "Pick a group colour",

  "appbar.noAccount": "No account signed in",

  // Named exactly, because the two credentials are not interchangeable: the
  // management API rejects a data-plane key, and a user who pastes one gets a
  // silent re-prompt loop with no clue which secret is wanted.
  "auth.adminTokenPrompt": "OpenCodex ADMIN token — print it on the proxy machine with: ocx host token\n\nThis is the management credential. A data-plane API key (the one from `ocx host enable --new-key`, sent by Codex/Claude Code with model requests) will NOT work here — the server rejects data-plane credentials for /api/*.",

  "dash.stopFailedTitle": "Could not stop the proxy",

  "search.regexHint": "Match with a regular expression instead of plain text",

  // ---- notifications ----
  "notif.dismiss": "Dismiss",
  "notif.centre": "Notifications",
  "notif.empty": "Nothing yet",
  "notif.emptyBody": "Messages from the proxy and from actions you take land here.",
  "notif.viewAll": "View all notifications",
  "notif.historyTitle": "Notification history",
  "notif.historySub": "Every message shown since this dashboard was first opened.",
  "notif.clear": "Clear history",
  "notif.search": "Search notifications",
  "notif.toneAll": "All",
  "notif.toneError": "Errors",
  "notif.toneWarn": "Warnings",
  "notif.toneSuccess": "Successes",
  "notif.toneInfo": "Info",

  // ---- logs & debug ----
  "debug.captureTitle": "Capture",
  "debug.captureSub": "Each stream is opt-in and costs throughput while it is on.",
  "debug.streamsAria": "Debug log streams",
  // The Capture switches are M3 switches: their state is a thumb position and an
  // `aria-checked`, with no word anywhere on the card. The settings search indexes
  // what a control reads, so the two words it would have read have to exist —
  // otherwise a user who remembers switching usage extraction on can search for
  // "on" and be told this screen has no such setting.
  "debug.stateOn": "On",
  "debug.stateOff": "Off",
  "debug.claudeInbound.thinking": "Thinking",
  "debug.claudeInbound.effort": "Effort",
  "debug.claudeInbound.beta": "Beta",
  "debug.claudeInbound.metadata": "Metadata",
  "debug.claudeInbound.system": "System",

  // ---- appearance ----
  "appearance.title": "Appearance",
  "appearance.themeTitle": "Theme",
  "appearance.themeSub": "System follows your operating system's light/dark setting.",
  "appearance.reset": "Reset appearance",
  "appearance.resetDone": "Appearance reset to defaults",
  "appearance.resetRecorded": "Appearance reset to defaults",
  "appearance.seedTitle": "Seed colour",
  "appearance.seedSub": "One colour derives the whole Material 3 palette. Any hex works — the eight below are curated starting points.",
  "appearance.seedPicker": "Pick a seed colour",
  "appearance.seedHex": "Seed colour hex value",
  "appearance.seedInvalid": "Enter a hex colour such as #2F6B4F",
  "appearance.densityTitle": "Density",
  "appearance.densitySub": "1 is Material's comfortable spacing; 5 matches the compact console layout.",
  "appearance.density": "Density level",
  "appearance.typeTitle": "Typography",
  // Was "All faces are bundled", which was not true of anything: no font files
  // existed and no @font-face was declared, so four of the five choices quietly
  // rendered as whatever the system had. The faces are bundled now; the sentence
  // says what is actually bundled, because the CJK coverage deliberately is not.
  "appearance.typeSub": "Latin faces are bundled — the dashboard never fetches a font over the network. Chinese text uses your system's font.",
  "appearance.fontFamily": "Font family",
  "appearance.fontScale": "Text size",
  "appearance.fontWeight": "Text weight",
  "appearance.previewHeadline": "Live preview",
  "appearance.previewBody": "Body copy renders at the size, weight and family you picked, on the surface colours the seed derives.",
  "appearance.previewPrimary": "Primary",
  "appearance.previewTonal": "Tonal",
  "appearance.previewOutlined": "Outlined",
  "appearance.elementsTitle": "Per-element styling",
  "appearance.elementsSub": "Override one surface at a time. Each override is stored separately and can be reset on its own.",
  "appearance.elNavRail": "Navigation rail",
  "appearance.elTabStrip": "Tab strip",
  "appearance.elAppBar": "Top app bar",
  "appearance.elCard": "Cards",
  "appearance.elTable": "Data tables",
  "appearance.elButton": "Filled buttons",
  "appearance.elBg": "Background",
  "appearance.elColor": "Text colour",
  "appearance.elRadius": "Corner radius",
  "appearance.elPad": "Padding",
  "appearance.elInherit": "inherits theme",
  "appearance.elReset": "Reset this element",
  // The in-place editor's name. It says which surface it is editing, because
  // the panel is anchored beside one and a bare "Edit appearance" beside a
  // second one open elsewhere would be two dialogs with the same name.
  "appearance.editElement": "Edit appearance: {name}",
  "appearance.editElementHint": "Press and hold, right-click, or press Shift+F10 on any part of the app chrome to restyle it in place.",
  "appearance.pxValue": "{n}px",
  "appearance.motionTitle": "Motion",
  "appearance.motionSub": "Transitions collapse automatically when your system asks for reduced motion.",
  "appearance.reducedMotion": "Reduced motion",
  "appearance.reducedMotionOsOnly": "Reduced motion follows your operating system setting and cannot be changed here.",

  // ---- language & voice ----
  "lang.title": "Interface language",
  "lang.sub": "Applies immediately. Untranslated strings fall back to English.",
  "narrator.title": "Narrator",
  "narrator.sub": "Reads status messages aloud using your browser's speech synthesis. Off by default.",
  "narrator.enable": "Enable narrator",
  "narrator.enableHint": "One message is spoken at a time; a newer message replaces a pending one rather than queueing behind it.",
  "narrator.language": "Narrator language",
  "narrator.test": "Speak a test message",
  "narrator.sample": "The opencodex proxy is running and ready.",
  "narrator.spoke": "Test message sent to the narrator",
  "narrator.unavailable": "This browser does not expose speech synthesis, so the narrator cannot run here.",

  // ---- remote access & backup ----
  "network.hostTitle": "Network access",
  "network.hostSub": "Reach this proxy and dashboard from other devices — the same controls as `ocx host`.",
  "network.exposed": "Reachable from other devices",
  "network.exposeWhatItDoes": "Turning this on publishes the proxy and this dashboard to every device on your network. A key is generated for you as part of enabling it.",
  "network.restartPending": "Saved, but not in effect yet. The proxy is still listening where it was — restart it (ocx stop && ocx start) before another device can connect.",
  "network.debugSandbox": "Debug mode (OPENCODEX_DEBUG_SANDBOX). Settings on this screen are not saved and no key will be issued — the controls work, but every change here is forgotten when the proxy stops. Logs, usage and other files are still written as usual. Restart without that setting to make changes stick.",
  "network.enableConfirm": "Expose the proxy to your network? Anyone on it who has a key can drive the proxy and every provider account behind it. Only do this on a network you trust. A restart applies the change.",
  "network.enabled": "Network access enabled",
  "network.disabled": "Network access disabled",
  "network.restartHint": "Restart the proxy to apply (ocx stop && ocx start).",
  "network.changeFailed": "Could not change network access",
  "network.urls": "Open from another device",
  "network.keyShownOnce": "Data-plane key — shown once, store it now",
  "network.adminToken": "Admin token",
  "network.adminTokenHint": "What the remote dashboard and API ask for. Treat it like a password.",
  "network.copy": "Copy",
  "network.copied": "Copied",
  "network.reveal": "Reveal",
  "network.hide": "Hide",
  "network.tokenUnavailable": "No admin token exists yet — it is created when the proxy first starts.",
  "network.customKeyTitle": "Custom key",
  "network.customKeyHint": "Choose your own key value (12+ characters, no spaces). It is stored in PLAINTEXT in config.json and included in exports — never reuse a password you use anywhere else.",
  "network.customKeyPlaceholder": "your-memorable-key-value",
  "network.customKeyAdd": "Add custom key",
  "network.customKeyAdded": "Custom key stored",
  "network.customKeyFailed": "Could not store the custom key",
  "network.exportTitle": "Export everything",
  "network.exportSub": "One file: config, Codex accounts with OAuth credentials, and the auth record — the same bundle as `ocx export`.",
  "network.exportWarning": "⚠️ The export contains PLAINTEXT SECRETS: provider API keys and OAuth access/refresh tokens. Anyone holding the file can use every account in it. Store it encrypted; delete it when done.",
  "network.exportConfirm": "Download the full state export? It contains every API key and OAuth token in plaintext.",
  "network.exportButton": "Download export",
  "network.exported": "Export downloaded",
  "network.exportedHint": "Store it encrypted. Delete it when the backup or migration is done.",
  "network.exportFailed": "Export failed",
  "network.historyTitle": "Account-change history",
  "network.historySub": "Local-only git snapshots recorded on every account add or remove (`ocx export --history`).",
  "network.historyEmpty": "No snapshots yet",
  "network.historyEmptyBody": "Snapshots are recorded automatically when an account or key is added or removed.",
  "network.historyFailed": "Could not read the account-change history",

  // The local revision log records WHAT changed; it does not hold a replay path back
  // to the setting it came from, so pressing its button never put anything back. It
  // said "Restored" anyway. These name the action for what it does, and point at the
  // snapshot restore that genuinely undoes a change.
  "history.localAction": "Note in history",
  "history.localNotedTitle": "Noted in the history",
  "history.localNotedBody": "The local log records what changed — it cannot put the old value back. To undo it, restore a snapshot from below taken before the change.",
  "history.localCannotRestore": "This entry is a record of a change, not a copy of the state before it. Snapshot entries can be restored.",
  "network.historySearch": "Search snapshots",
  "network.historyNoMatch": "No snapshot matches",
  "network.historyNoMatchBody": "Nothing in the history matches that search. Clear it to see every snapshot again.",

  // The screen carries two independent search bars — one over the snapshot list, one
  // over the screen's own settings — so each builder trigger says which field it
  // builds for. Two buttons both announced "Open regex builder" is a screen reader
  // reading the same name twice and meaning different fields.
  "network.settingsBuilder": "Build a pattern to search these settings",
  "network.historyBuilder": "Build a pattern to search the snapshots",
  // The exposure switch renders as a bare M3 switch with no words on it, so the
  // settings index has to supply the ones a user would actually type to find it.
  "network.stateOn": "On",
  "network.stateOff": "Off",
  // A keyword bag, not a sentence: the endpoint row shows `hostname:port` and
  // nothing else, so none of the words someone searches for are on screen.
  "network.endpointWords": "hostname port endpoint address",

  // One-click restore. The copy names what will happen in unambiguous words — which
  // files move, that in-flight work finishes first, and that the proxy restarts —
  // because this is the one control that rewrites credentials on disk.
  "network.restore": "Restore",
  "network.restoreAria": "Restore the state from {label}",
  "network.restoreConfirm": "Restore config, accounts and credentials to this snapshot?\n\n{label}\n\nOpenCodex finishes any request still in flight, writes the files back, then restarts. Your current state is committed to the history first, so this restore can itself be undone.",
  "network.restoreBusySessions": "{count} request(s) still running",
  "network.restoreForceConfirm": "{count} request(s) are still running and did not finish in time. Restore anyway? Those requests will be cut off.",
  "network.restored": "State restored — the proxy is restarting",
  "network.restoredKept": "Kept (absent from that snapshot): {files}",
  "network.restoreFailed": "Restore failed",

  // ---- OAuth account pool, for every provider ----
  // Anthropic keeps its own `anthropicPool.*` copy: its warning names a specific,
  // known enforcement risk, and flattening that into a generic sentence would lose
  // the one thing a user needs to read before enabling it there. These keys are the
  // honest generic version for every other provider.
  "pool.title": "{provider} account pool (experimental)",
  "pool.enabledDesc": "On 429, cools the account and fails over. New sessions rotate across the accounts that are not cooling.",
  "pool.disabledDesc": "Uses only the active {provider} account.",
  "pool.experimentalWarning": "Experimental. A provider may treat automated multi-account rotation as abuse and restrict the accounts involved, and accounts inside one organization often share a quota — pooling those will not buy you anything. Leave this off unless you understand the risk for this provider.",
  "pool.needTwoAccounts": "Add at least two {provider} accounts before enabling the pool.",
  "pool.loadFailed": "{provider} pool settings could not be loaded.",
  "pool.saveFailed": "{provider} pool settings could not be saved.",
  // Named because it is the difference between a setting that works and one that
  // silently does nothing: quota picking needs per-account usage numbers, and only
  // providers that report them can use it.
  "pool.noQuotaSignalHelp": "This provider does not report per-account usage, so the quota strategy rotates round-robin over eligible accounts instead of picking the least-used one.",

  // ---- launcher ----
  "launch.title": "Launch",
  "launch.sub": "Open the agent CLIs and their desktop apps on this machine.",
  "launch.cli": "CLI",
  "launch.desktop": "Desktop app",
  "launch.open": "Open",
  "launch.opening": "Opening {label}…",
  "launch.opened": "{label} opened",
  "launch.failed": "Could not open {label}",
  "launch.notInstalled": "Not installed",
  "launch.install": "Get it",
  "launch.installing": "Installing {label}…",
  "launch.installed": "{label} installed",
  "launch.installFailed": "Could not install {label}",
  "launch.installOpenPage": "Open download page",
  // Shown instead of an install button when no official package exists for a
  // target. Saying why keeps it from reading as a broken button.
  "launch.installManual": "No official package — opens the download page",
  "launch.installRestart": "Installed. Restart opencodex so it appears on PATH.",
  "launch.installLog": "Installer output",
  // The action on the one launch failure that has a fix. Opening a CLI needs a
  // terminal window, opencodex will not open a legacy console, and Windows
  // Terminal is missing on Windows 10 and on trimmed images.
  "launch.wtInstall": "Install Windows Terminal",
  "launch.wtRestart": "Windows Terminal is installed, but this opencodex session cannot see it yet. Restart opencodex, then open the CLI again.",

  "terminal.title": "Terminal",
  "terminal.subtitle": "Run commands without leaving opencodex. Sessions start in your home directory.",
  "terminal.idleTitle": "No session",
  "terminal.idleBody": "Pick a shell or a CLI above to start one.",
  "terminal.stop": "Stop",
  "terminal.send": "Run",
  "terminal.inputLabel": "Command",
  "terminal.inputPlaceholder": "Type a command and press Enter",
  "terminal.exited": "Session has exited",
  "terminal.transcript": "{label} output",
  "terminal.startFailed": "Could not start {label}",
  "terminal.writeFailed": "Could not send that to the session",
  "terminal.blockedTitle": "Terminal disabled",
  "terminal.blocked": "The embedded terminal is only available when the proxy is bound to this machine.",
  // Said before the session starts and again while it runs: this transport pipes
  // stdio rather than allocating a pseudo-terminal, so a full-screen interface
  // draws nothing. Non-interactive commands work normally.
  "terminal.fullScreenWarn": "This CLI's full-screen interface needs a real console and will not draw here. Non-interactive commands (--help, exec, --version) work. Use Launch to open the full experience in a console.",
  "launch.emptyTitle": "Nothing to launch yet",
  "launch.emptyBody": "None of the agent CLIs or desktop apps were found on this machine. Install one and it appears here.",
  "launch.loadFailed": "Could not read the launcher targets",

  // ---- window controls and exit ----
  "window.minimize": "Minimise",
  "window.maximize": "Maximise",
  "window.restoreDown": "Restore down",
  "window.close": "Close to tray",
  "window.exit": "Exit app",
  // Says what it does, at every funny level: finish, stop, close. No ambiguity about
  // whether the proxy keeps running afterwards — that is the whole point of the button.
  "window.exitConfirm": "Exit OpenCodex? Any request still in flight is finished first, then the proxy stops and the app closes. Codex and Grok are handed back to their own configs.",
  "window.exitBusyConfirm": "{count} request(s) are still running and did not finish in time. Exit anyway? Those requests will be cut off.",
  "window.exiting": "Finishing in-flight work, then closing…",
  "window.exitFailed": "Could not exit cleanly",

  // ---- confirmation dialogs ----
  // Headlines and action labels for the seven decisions that used to be drawn by
  // `window.confirm()`. The bodies are not here: each one already existed beside
  // the feature it guards, and duplicating them under a `confirm.*` name would be
  // two strings to keep in step. What the native dialog could not express was a
  // title and a labelled button — "OK" on a dialog about dumping every credential
  // in plaintext told the reader nothing — so only those are new.
  "confirm.stopTitle": "Stop the proxy",
  "confirm.exitTitle": "Exit OpenCodex",
  "confirm.exitAction": "Exit",
  // Separate from "Exit" because it agrees to something more: cutting off work
  // that is still running. Same wording rule for the restore pair below.
  "confirm.exitForceAction": "Exit anyway",
  "confirm.restoreTitle": "Restore this snapshot",
  "confirm.restoreForceAction": "Restore anyway",
  "confirm.exposeTitle": "Expose the proxy to your network",
  "confirm.exposeAction": "Expose",
  // The second wave: four more decisions the browser was still drawing, found by
  // a wider grep than the first pass used. Same rule — the body already exists
  // beside the feature, only the headline and the labelled button are new.
  "confirm.removeAccountTitle": "Remove this account",
  "confirm.removeKeyTitle": "Remove this API key",
  "confirm.removeAction": "Remove",
  "confirm.restartTitle": "Restart the proxy",
  "confirm.restartAction": "Restart",
  "confirm.deleteModelTitle": "Delete this model",
  "confirm.deleteAction": "Delete",

  // ---- prompts ----
  // Headline, field label and button for the awaitable text prompt. The native
  // `prompt()` these replace had no field label at all — a screen reader
  // announced the box as "edit, blank" — and threw outright inside Electron, so
  // renaming a credential in the desktop app raised an exception rather than
  // asking anything.
  "prompt.aliasTitle": "Set a display name",
  "prompt.aliasAction": "Save",
  "auth.adminTokenTitle": "Admin token needed",
  "auth.adminTokenLabel": "Admin token",
  "auth.adminTokenAction": "Use this token",

  // ---- app-bar account switcher ----
  "switcher.title": "Codex accounts",
  "switcher.aria": "Active account: {email}. Switch account.",
  "switcher.active": "active",
  "switcher.paused": "paused",
  "switcher.weeklyUsed": "{pct}% weekly used",
  "switcher.switched": "Switched active account",
  "switcher.failed": "Could not switch account",

  // ---- app-bar cost meter ----
  "cost.rangeAll": "lifetime",
  "cost.range30d": "30 days",
  "cost.range7d": "7 days",
  "cost.menuTitle": "Estimated cost range",
  "cost.aria": "Estimated API cost {amount} over {range}. Change range.",
  "cost.title": "Estimated API cost ({range}) — click to change the range",

  // ---- dim sum surprise ----
  "dimsum.title": "Dim sum time!",
  "dimsum.hint": "A 1-in-100 launch treat. Turn it off under Appearance.",
  "dimsum.toggle": "Dim sum surprise",
  "dimsum.toggleHint": "Roughly one launch in a hundred shows a small dim sum card. Never on your first run or right after an update.",

  // ---- regex builder ----
  "regex.title": "Regex builder",
  "regex.sub": "Build and test a pattern, then use it in any search bar that has the .* toggle switched on.",
  "regex.engineLabel": "Engine",
  "regex.engineValue": "ECMAScript RegExp",
  "regex.engineNote": "Engine: ECMAScript RegExp, evaluated locally in this browser. Nothing you type is sent anywhere.",
  "regex.presets": "Presets",
  "regex.palette": "Token palette",
  "regex.pattern": "Pattern",
  "regex.patternCap": "{used} of {cap} characters",
  "regex.flags": "Flags",
  "regex.invalid": "Invalid pattern",
  "regex.copy": "Copy pattern",
  "regex.copied": "Pattern copied",
  "regex.copyFailed": "Could not write to the clipboard",
  "regex.export": "Export as Markdown",
  "regex.exported": "Markdown copied to the clipboard",
  "regex.sample": "Sample text",
  "regex.sampleCap": "{used} of {cap} characters",
  "regex.matches": "Matches",
  "regex.matchCount": "Matches",
  "regex.matchCountValue": "{count} match(es)",
  "regex.matchTruncated": "Stopped at the {cap}-match cap — refine the pattern to see the rest.",
  "regex.noMatches": "No matches in the sample text.",
  "regex.colIndex": "Index",
  "regex.colMatch": "Match",
  "regex.flagG": "global — find every match, not just the first",
  "regex.flagI": "ignore case",
  "regex.flagM": "multiline — ^ and $ match line boundaries",
  "regex.flagS": "dotall — . also matches a newline",
  "regex.flagU": "unicode",
  "regex.flagY": "sticky — match only at lastIndex",
  "regex.tokDigit": "any digit",
  "regex.tokWord": "any word character",
  "regex.tokSpace": "any whitespace",
  "regex.tokAny": "any character",
  "regex.tokClass": "character class",
  "regex.tokPlus": "one or more",
  "regex.tokStar": "zero or more",
  "regex.tokOpt": "optional",
  "regex.tokRange": "between 1 and 3 times",
  "regex.tokNamed": "named capture group",
  "regex.tokGroup": "non-capturing group",
  "regex.tokStart": "start of input",
  "regex.tokEnd": "end of input",
  "regex.tokBoundary": "word boundary",
  "regex.tokAlt": "either side",
  "regex.presetResponseId": "Response id",
  "regex.presetStatus": "4xx / 5xx status",
  "regex.presetModel": "vendor/model",
  "regex.presetToken": "API key shape",

  // ---- changelog ----
  "changelog.filterTitle": "Filter releases",
  "changelog.filterSub": "Date range and text search compose — narrowing one keeps the other applied.",
  "changelog.from": "From",
  "changelog.to": "To",
  "changelog.badDate": "Not a valid date — the filter is ignored until it is.",
  "changelog.last7": "Last 7 days",
  "changelog.last30": "Last 30 days",
  "changelog.last90": "Last 90 days",
  "changelog.clearDates": "Clear dates",
  "changelog.search": "Search release notes",
  "changelog.export": "Export as Markdown",
  "changelog.exported": "Markdown copied to the clipboard",
  "changelog.exportRange": "Range: {from} to {to}",
  "changelog.exportAll": "Range: all releases",
  "changelog.unavailable": "No changelog packaged",
  "changelog.unavailableBody": "This build has no CHANGELOG.md. Run `bun scripts/generate-changelog.ts` to produce one from the release tags.",
  "changelog.noResults": "No releases match",
  "changelog.noResultsBody": "Widen the date range or clear the search to see more.",

  // ---- storage ----
  "storage.col.share": "Share",

  // ---- version history ----
  "history.title": "Version history",
  "history.sub": "Append-only. Restoring an entry records a new revision, so an undo can itself be undone.",
  "history.clear": "Clear history",
  "history.clearConfirm": "Delete the whole revision log? This cannot be undone.",
  "history.search": "Search revisions",
  "history.empty": "No revisions recorded",
  "history.emptyBody": "Changes to providers, accounts, keys, combos and settings are recorded here as you make them.",
  "history.colWhen": "When",
  "history.colScope": "Scope",
  "history.colWhat": "What",
  "history.colChange": "Change",
  "history.restore": "Restore",
  "history.restoreConfirm": "Restore \"{label}\"? This is recorded as a new revision rather than removing the later ones, so you can undo the restore.",
  "history.restored": "Restored",
  "history.restoredFrom": "Restored from the revision of {at}",
  "history.restoredTag": "restore",
  "history.scopeAll": "All",
  "history.scopeProvider": "Providers",
  "history.scopeAccount": "Accounts",
  "history.scopeKey": "API keys",
  "history.scopeCombo": "Combos",
  "history.scopeSettings": "Settings",

  // ---- grok (M3 restyle: column header for the registration switch) ----
  "grok.colEnabled": "Registered",

  // ---- providers (M3 restyle: pill tablist + rail landmarks) ----
  "pws.sectionsAria": "Provider sections",

  // ---- combos (M3 restyle: pill tablist label) ----
  "cws.tabsAria": "Combo sections",

  // Missed by the first pass because the request was written in prose rather than
  // as a key/value pair. Both blocked a control that was otherwise built and ready.
  "codexAuth.subtitle": "ChatGPT accounts available to the proxy, their rate-limit windows, and the account the next request will use.",
  // The version stat's hint. Deliberately names the channel rather than asserting
  // freshness: the prototype's "npm latest" reads as "you are up to date", which the
  // dashboard cannot know until an update check has actually run.
  "dash.channelHint": "{channel} channel",

  // ---- design parity (all 19 screens) ----
  // Copy taken verbatim from design/OpenCodex M3.dc.html and design/ocx-i18n.js.
  //
  // Added here rather than en.ts deliberately: the five translated dictionaries are
  // Record<TKey, string>, so a key added there is a compile error in all five until
  // somebody translates it. These resolve with an English fallback, which is exactly
  // what lets a screen be ported before its translations exist.
  //
  // settings.* is one shared row that six screens asked for independently — the
  // per-surface settings search that belongs on every surface where settings live.
  "common.settings": "Settings",
  "settings.search": "Search settings…",
  "settings.otherTab": "{count} match(es) on other tabs: {tabs}",
  "settings.noMatch": "No settings match on this surface.",
  "settings.openBuilder": "Open regex builder",
  "codexAuth.addAccount": "Add account",
  "regex.groups": "Capture groups",
  "regex.groupLiterals": "Literals",
  "regex.groupClasses": "Character classes",
  "regex.groupAnchors": "Anchors",
  "regex.groupGroups": "Groups",
  "regex.groupAlternation": "Alternation",
  "regex.groupQuantifiers": "Quantifiers",
  "regex.safety": "Evaluated locally, never transmitted. Pattern capped at {pattern} characters, sample at {sample}, matches at {matches}, with zero-width advance so a catastrophic pattern cannot hang the page.",
  "regex.useHere": "Use in search",
  "regex.build": "Guided construction",
  "regex.tokLiteral": "literal text",
  "regex.tokEscapedDot": "escaped dot — a literal .",
  "regex.tokBackslash": "a literal backslash",
  "regex.tokNegated": "any character except /",
  "regex.tokUnicodeScript": "Unicode script — needs the u flag",
  "regex.tokCapture": "capture group",
  "regex.tokLookahead": "lookahead",
  "regex.tokLazy": "one or more, lazy",
  "lang.subtitle": "Language mode, per-language funny level, spoken narration, and the dim sum surprise.",
  "lang.mode": "Language mode",
  "lang.funnyEn": "Funny level — English",
  "lang.funnyYue": "Funny level — 廣東話",
  "lang.funnyLadder": "The same destructive warning at every level",
  "lang.funnyLevel": "Level {n}",
  "narrator.offTitle": "Narrator is off",
  "narrator.offBody": "Turn it on first — it stays off until you ask for it.",
  "narrator.langBoth": "Both (serialized)",
  "dimsum.showNow": "Show one now",
  "lang.revisionSummary": "Interface language set to {name}",
  "lang.narratorRevision": "Narration settings changed",
  "grok.revisionSummary": "Registered models set to {on} of {total}",
  "sub.nativeProvider": "OpenAI native",
  "sub.revisionSaved": "Featured subagent models set to {models}",
  "sub.savedTitle": "Saved {n} models.",
  "sub.savedBody": "Start a new Codex session (or run {cmd}) to see them as spawn_agent overrides.",
  // Not rendered anywhere: it is what the Startup search indexes the hero under.
  // The hero shows a verdict ("Protected", "Action required") and never the word
  // "status", so without this a user typing the obvious thing found nothing on a
  // screen whose whole top half is a status.
  "startup.overallStatus": "Overall status",
  "startup.tray.uninstallConfirm": "Remove the login tray icon? The proxy keeps running — only the tray controller is removed, and restart protection is unaffected.",
  "startup.tray.installedRecorded": "Installed the Windows login tray",
  "startup.tray.removedRecorded": "Removed the Windows login tray",
  "api.keyDeleted": "Deleted API key",
  "api.keyCreated": "Created API key",
  "api.copyValueAria": "Copy {label}",
  "api.deleteConfirmTitle": "Delete API key \"{name}\"?",
  "api.deleteConfirmBody": "{prefix} stops working immediately for every app configured with it.",
  "api.deleteConfirmAction": "Delete key",
  "appearance.subtitle": "Theme, density, seed colour, and typography. Changes apply to the live interface and persist across restarts.",
  "appearance.rolePrimary": "primary",
  "appearance.roleContainer": "container",
  "appearance.roleSecondary": "secondary",
  "appearance.roleTertiary": "tertiary",
  "appearance.roleError": "error",
  "appearance.roleSurface": "surface",
  "appearance.font": "Interface font",
  "appearance.elFont": "Font — {target}",
  "appearance.elColorCaption": "text / background",
  "appearance.elResetAll": "Reset all ({count})",
  "appearance.elResetDone": "Reset to defaults",
  "appearance.resetAllDone": "All per-element overrides reset",
  "appearance.previewHeadlineSample": "Headline small",
  "appearance.previewTitleSample": "Title medium",
  "appearance.previewBodySample": "Body medium — the quick brown fox jumps over the lazy dog. 廣東話樣本文字，睇下字型同大小夠唔夠清楚。",
  "regex.regexMode": "Regex mode",
  "pws.removeConfirmDetail": "Its configuration is deleted from this proxy's config file. Accounts and API keys stored for it are removed with it.",
  "prov.removeIrreversible": "This cannot be undone.",
  "prov.revisionJsonSaved": "Edited the raw provider config",
  "prov.networkError": "Network error — is the proxy running?",
  "prov.updateFail": "Update failed.",
  "prov.revisionAdded": "Added the provider",
  "prov.revisionRemoved": "Deleted the provider",
  "prov.revisionEnabled": "Enabled the provider",
  "prov.revisionDisabled": "Disabled the provider",
  "prov.revisionSettingsSaved": "Edited the provider settings",
  "usage.card.estCost": "Est. cost",
  "usage.card.costHint": "list price",
  "usage.card.requestsHint": "{count} measured",
  "usage.card.totalTokensHint": "{count} reported",
  "usage.card.coverageHint": "{count} unpriced",
  "models.ctxValue": "{value} ctx",
  "models.noMatch": "No models match your search.",
  "search.openBuilder": "Open regex builder",
  "changelog.subtitle": "Every released version, with its date and categorized changes. Filter by date, search the text, and export what you see.",
  "changelog.presets": "Presets",
  "changelog.thisYear": "This year",
  "changelog.copy": "Copy as Markdown",
  "logs.search": "Search request id, model, provider…",
  "logs.searchAria": "Search logs",
  "logs.sectionsAria": "Logs sections",
  "logs.tokens.inOut": "{in} in · {out} out",

  // ---- logs on disk, and the undo that guards deleting them ----
  // The copy states counts, paths and the retention bound in words, because the
  // one thing a delete confirmation must never do is ask someone to agree to an
  // unspecified amount of loss.
  "logs.file.title": "Log files",
  "logs.file.where": "Written to {path} — open it in any text editor.",
  "logs.file.usage": "Request rows: {path}",
  "logs.file.retention": "Each log file is capped at {size} and {count} older files are kept, so the log folder never exceeds {total}.",
  "logs.file.footprint": "{rows} request rows · {lines} app log lines · {size} on disk",
  "logs.clear": "Clear logs",
  "logs.clearTitle": "Clear the logs on this machine",
  "logs.clearBody": "Deletes {rows} request rows and {lines} app log lines. The Logs table, the Debug tab and the Usage totals are all built from these files, so all three go back to empty.\n\nThey are committed to the local version history first, so you can put them back from Version history. That history never leaves this machine.",
  "logs.cleared": "Logs cleared",
  "logs.clearedBody": "Saved to version history as \"{label}\". Open Version history to put them back.",
  "logs.clearedNoSnapshot": "The logs are cleared, but the version history could not be written — this one cannot be undone.",
  "logs.clearFailed": "Could not clear the logs",
  "logs.clearNothing": "There are no logs to clear.",
  "logs.revisionLabel": "Logs",
  "notif.toneErrorOne": "Error",
  "notif.toneWarnOne": "Warning",
  "notif.toneSuccessOne": "Success",
  "notif.toneInfoOne": "Info",
  "dash.revision.settings": "Dashboard settings",
  "dash.revision.changed": "{setting} set to {value}",
  "dash.revision.cleared": "{setting} cleared",
  "storage.cleanup.estimate": "{count} archived file(s) · ~{size}",
  "storage.card.archived": "Archived",
  "storage.card.archivedFiles": "{count} files",
  "storage.cleanup.previewAndClean": "Preview and clean",
  "history.diff": "Diff",
  "history.revisions": "Revisions",
  "history.label": "Label",
  "history.labelUpdated": "Label updated",

  // ---- log snapshots on the shared timeline ----
  // A log snapshot restores differently from a credential snapshot — no drain,
  // no restart — so it names itself rather than borrowing the other's button.
  "history.snapshotLogs": "Log files",
  "history.snapshotState": "Accounts & settings",
  "history.snapshotMixed": "Accounts, settings & logs",
  "history.restoreLogs": "Restore logs",
  "history.restoreLogsConfirm": "Put the logs back as they were at \"{label}\"?\n\nThe logs as they stand now are committed first, so this restore can itself be undone. No requests are interrupted and the proxy does not restart.",
  "history.logsRestored": "Logs restored",
  "history.logsRestoredBody": "{count} file(s) written back, and recorded as a new revision — so you can undo this too.",
  "history.logsRestoredKept": "Log files added since that revision were left in place: {files}",
  "history.logsRestoreFailed": "Could not restore the logs",

  // ---- design parity (all 19 screens) ----
  // Copy taken verbatim from design/OpenCodex M3.dc.html and design/ocx-i18n.js.
  //
  // Added here rather than en.ts deliberately: the five translated dictionaries are
  // Record<TKey, string>, so a key added there is a compile error in all five until
  // somebody translates it. These resolve with an English fallback, which is exactly
  // what lets a screen be ported before its translations exist.
  //
  // settings.* is one shared row that six screens asked for independently — the
  // per-surface settings search that belongs on every surface where settings live.
  "changelog.downloaded": "changelog.md downloaded",
  "notif.noMatch": "No notifications match your search.",
  "regex.noGroups": "This pattern declares no named capture group.",
  "appearance.previewFilled": "Filled",
  "appearance.elResetTarget": "Reset {target}",
  "appearance.elColourGroup": "Colour",
  "logs.noMatch": "No requests match your search.",
  "grok.search": "Search models and aliases…",
  "grok.noMatch": "No models match your search.",
  "pws.groupNeedsAttention": "Needs attention ({count})",

  // ---- anchored regex builder (shell/RegexBuilderButton.tsx) ----
  // The builder that opens beside a search bar instead of navigating to its own
  // page. Only the strings the popover adds live here; everything it renders in
  // common with the full page reuses the `regex.*` keys above, because two
  // wordings for one control is how the two surfaces start describing the same
  // pattern differently.
  // ---- the shared settings search (shell/SettingsSearch.tsx) ----
  // Two facts the per-surface rows used to leave unsaid. `otherTabHere` is the
  // near miss — the setting is on this screen, one tab over — and is deliberately
  // worded differently from `settings.otherTab`, which sends the user to another
  // screen entirely; a single message for both told the user to go somewhere they
  // already were. `matchCount` carries its denominator because "3 matches" says
  // nothing about whether the search narrowed anything down.
  "settings.otherTabHere": "{count} match(es) on another tab of this screen: {tabs}",
  "settings.matchCount": "{count} of {total} settings match",

  "regexpop.apply": "Use this pattern",
  "regexpop.applyHint": "Replaces the search text with this pattern and switches this field to regex mode.",
  "regexpop.applyHintPlain": "Replaces the search text with this pattern.",
  "regexpop.close": "Close the builder",

  // ---- shared by the appearance editors ----
  // "Inherits" rather than "None" or a copy of the current value: an unset
  // property follows whatever the theme says today *and* tomorrow, which is a
  // different thing from being set to today's default.
  "ap.inherits": "Inherits",
  "ap.none": "None",
  "ap.reset": "Reset",
  "ap.resetOne": "Reset {name}",
  "ap.use": "Use",

  // ---- infinite colour picker ----
  "color.title": "Colour picker",
  "color.field": "Chroma and lightness field",
  "color.fieldHint": "Drag, or use the arrow keys. Shift for larger steps, Page Up/Down for lightness, Home/End for chroma. The traced line is the edge of sRGB.",
  "color.hue": "Hue",
  "color.alpha": "Opacity",
  "color.lightness": "Lightness",
  "color.chroma": "Chroma",
  "color.value": "Value",
  "color.valueHint": "Any CSS colour: a name, #hex, rgb(), hsl(), hwb(), lab(), lch(), oklab() or oklch().",
  "color.invalid": "Not a colour this can read. What you typed has been kept.",
  "color.gamut": "Gamut",
  "color.contrastAgainst": "Contrast against {name}",
  "color.contrastSurface": "the page",
  "color.contrastText": "body text",
  "color.clip": "Just outside sRGB. It is stored as oklch(), so a wide-gamut display shows it exactly and everything else shows the nearest sRGB colour.",
  "color.clipFar": "Well outside sRGB. On an ordinary display this will look noticeably different from the colour shown here.",
  "color.swatches": "Preset colours",
  "color.eyedropper": "Pick a colour from the screen",
  "color.recent": "Recent colours",
  "color.translator": "Every colour space",
  "color.copy": "Copy the {space} value",
  "color.copied": "Copied",

  // ---- font picker ----
  "font.family": "Typeface",
  "font.search": "Search typefaces",
  "font.searchPh": "Search typefaces…",
  "font.openBuilder": "Build a typeface search pattern",
  "font.noMatch": "No typeface matches that search.",
  "font.sample": "Handgloves 廣東話 0123",
  "font.installed": "Use my installed fonts",
  "font.installedHint": "Asks this browser for the real list of fonts on this computer.",
  "font.custom": "Another family",
  "font.customPh": "Type any family name",
  "font.customHint": "Anything installed works, even if it is not listed above.",
  "font.axes": "Variable axes",
  "font.axisLabel": "{name} ({tag})",
  "font.axesLoading": "Reading the font…",
  // "Could not be read" and "has none" are different facts, and only the second
  // is a reason to stop offering axis sliders.
  "font.axesUnknown": "This font's axes could not be read, so none are offered. Grant access to installed fonts to read them.",
  "font.axesNone": "This is a static font — it has no variable axes.",
  "font.noteNotPrompted": "These families were measured, not listed. Grant access to see every font installed on this computer.",
  "font.noteUnsupported": "This browser cannot list installed fonts, so the families above were measured by rendering them. Any family name still works in the field below.",
  "font.noteDenied": "Access to installed fonts was declined, so the families above were measured instead. Any family name still works in the field below.",
  "font.noteFailed": "Installed fonts could not be read, so the families above were measured instead. Any family name still works in the field below.",
  "font.noteNoSurface": "Nothing could be measured here, so only the bundled families are listed.",

  // ---- word-depth typography ----
  "type.groupFace": "Typeface",
  "type.groupDecoration": "Lines",
  "type.groupCase": "Case and position",
  "type.groupColour": "Colour",
  "type.groupShadow": "Shadow and glow",
  "type.groupLayout": "Spacing and alignment",
  "type.size": "Size",
  "type.weight": "Weight",
  "type.slant": "Slant",
  "type.italic": "Italic",
  "type.oblique": "Oblique",
  "type.obliqueAngle": "Oblique angle",
  "type.underline": "Underline",
  "type.lineSolid": "Solid",
  "type.lineDouble": "Double",
  "type.lineDotted": "Dotted",
  "type.lineDashed": "Dashed",
  "type.lineWavy": "Wavy",
  "type.underlineColor": "Underline colour",
  "type.underlineThickness": "Underline thickness",
  "type.strike": "Strikethrough",
  "type.strikeSingle": "Single",
  "type.strikeDouble": "Double",
  "type.overline": "Overline",
  "type.overlineOn": "On",
  "type.caps": "Capitalization",
  "type.upper": "UPPERCASE",
  "type.lower": "lowercase",
  "type.capitalize": "Capitalize Each Word",
  "type.smallCaps": "Small caps",
  "type.allSmallCaps": "All small caps",
  "type.script": "Super/subscript",
  "type.super": "Superscript",
  "type.sub": "Subscript",
  "type.color": "Text colour",
  "type.highlight": "Highlight",
  "type.highlightHint": "Paints the whole box behind the element, not only the glyph runs — CSS has no text-only highlight outside a selection.",
  "type.outline": "Outline width",
  "type.outlineColor": "Outline colour",
  "type.shadowX": "Shadow across",
  "type.shadowY": "Shadow down",
  "type.shadowBlur": "Shadow blur",
  "type.shadowColor": "Shadow colour",
  "type.glow": "Glow",
  "type.glowColor": "Glow colour",
  "type.letterSpacing": "Character spacing",
  "type.wordSpacing": "Word spacing",
  "type.lineHeight": "Line height",
  "type.baseline": "Baseline shift",
  "type.direction": "Text direction",
  "type.ltr": "Left to right",
  "type.rtl": "Right to left",
  "type.align": "Alignment",
  "type.alignStart": "Start",
  "type.alignCenter": "Centre",
  "type.alignEnd": "End",
  "type.alignJustify": "Justify",
  // Kept visible rather than hidden, per the rule that a property the platform
  // cannot honour must still say so. "Unknown" is its own state because a
  // missing capability API is not evidence the feature is missing.
  "type.unsupported": "This browser does not support {css}, so this control will have no effect here. Your setting is still saved.",
  "type.unknown": "Support for {css} could not be checked here. Your setting is saved either way.",
  "type.partial": "{caveat}",

  // ---- per-element typography, on the Appearance screen ----
  "appearance.elTypeTitle": "Typography for {target}",
  "appearance.elTypeSub": "Everything a word processor offers, applied to this one surface. Nothing here has a default — unset means it follows the theme.",
  "appearance.elTypeReset": "Reset typography for {target}",
  "appearance.elTypeSearch": "Search typography settings",
  "appearance.elTypeNoMatch": "No typography setting matches that search.",
  "appearance.fontPickerTitle": "Interface typeface",
  "appearance.fontPickerSub": "Every font installed on this computer, plus the four bundled with the dashboard. Chinese text always falls back to a face that covers it.",
} as const;

export type M3Key = keyof typeof M3_EN;

/**
 * Per-locale translations. Partial by design: anything absent falls back to
 * `M3_EN`, so a locale can be completed screen by screen.
 */
export const M3_OVERRIDES: Partial<Record<Locale, Partial<Record<M3Key, string>>>> = {
  de: {
    "nav.appearance": "Darstellung",
    "nav.language": "Sprache & Stimme",
    "nav.regex": "Regex-Builder",
    "nav.changelog": "Änderungsprotokoll",
    "nav.history": "Versionsverlauf",
    "nav.notifications": "Benachrichtigungen",
    "nav.primaryAria": "Hauptnavigation",
    "tabs.newTab": "Neuer Tab",
    "tabs.overflow": "Alle Tabs",
    "notif.dismiss": "Schließen",
    "notif.centre": "Benachrichtigungen",
  },
  ko: {
    "nav.appearance": "모양",
    "nav.language": "언어 및 음성",
    "nav.regex": "정규식 빌더",
    "nav.changelog": "변경 내역",
    "nav.history": "버전 기록",
    "nav.notifications": "알림",
    "nav.primaryAria": "기본 탐색",
    "tabs.newTab": "새 탭",
    "tabs.overflow": "모든 탭",
    "notif.dismiss": "닫기",
    "notif.centre": "알림",
  },
  zh: {
    "nav.appearance": "外观",
    "nav.language": "语言与语音",
    "nav.regex": "正则表达式构建器",
    "nav.changelog": "更新日志",
    "nav.history": "版本历史",
    "nav.notifications": "通知",
    "nav.primaryAria": "主导航",
    "tabs.newTab": "新标签页",
    "tabs.overflow": "所有标签页",
    "notif.dismiss": "关闭",
    "notif.centre": "通知",
  },
  ja: {
    "nav.appearance": "外観",
    "nav.language": "言語と音声",
    "nav.regex": "正規表現ビルダー",
    "nav.changelog": "変更履歴",
    "nav.history": "バージョン履歴",
    "nav.notifications": "通知",
    "nav.primaryAria": "メインナビゲーション",
    "tabs.newTab": "新しいタブ",
    "tabs.overflow": "すべてのタブ",
    "notif.dismiss": "閉じる",
    "notif.centre": "通知",
  },
  ru: {
    "nav.appearance": "Оформление",
    "nav.language": "Язык и голос",
    "nav.regex": "Конструктор regex",
    "nav.changelog": "Список изменений",
    "nav.history": "История версий",
    "nav.notifications": "Уведомления",
    "nav.primaryAria": "Основная навигация",
    "tabs.newTab": "Новая вкладка",
    "tabs.overflow": "Все вкладки",
    "notif.dismiss": "Закрыть",
    "notif.centre": "Уведомления",
  },
};
