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
  "network.mobileHint": "Scan to open the remote control. Paste the API key into its Control tab once — it is stored on that device only.",
  "network.mobileQrAlt": "QR code for {url}",
  // Honest coverage. The level styles the copy where voice actually reads —
  // headings, empty states, confirmations, errors — and every other string keeps
  // its neutral wording rather than being padded with five near-identical
  // variants of the word "Save".
  "lang.funnyCoverage": "The level restyles {en} English and {yue} Cantonese messages today, including errors and destructive warnings. Everything else keeps its neutral wording. The facts never change at any level.",

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
  "mobile.sessionsFailed": "Could not read the session log",
  "mobile.proxy": "Proxy",
  "mobile.exposed": "Reachable from other devices",
  "mobile.loopback": "This machine only",
  "mobile.noCredential": "Published to the network with no credential configured.",
  "mobile.apiKey": "API key",
  "mobile.apiKeyHint": "Needed when the proxy is published to the network. Kept in memory for this session only — never written to storage, so you will re-enter it after a reload.",
  "mobile.keyPlaceholder": "ocx_…",
  "mobile.tokens": "{n} tokens",
  "mobile.httpStatus": "The proxy answered {status} with no detail.",
  "mobile.modelsFailed": "Could not reach the proxy to load models.",
  "mobile.retry": "Retry",
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
  "onboard.langSub": "English, Cantonese, or both side by side. Change it any time on Language & voice.",
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
  "onboard.netExposeHint": "Off by default. Other devices cannot reach it until you turn this on.",
  // Said before they type a password, not after the server refuses one:
  // publishing the proxy publishes the dashboard with it.
  "onboard.netExposeWarn": "This also publishes the dashboard, which can change providers, read logs and export your accounts. The password below is the only thing between the two. Only do this on a network you trust.",
  "onboard.netKey": "Connection password",
  "onboard.netKeyPlaceholder": "A password other devices will use",
  "onboard.netKeyRule": "At least {n} characters. Do not reuse a password you use anywhere else.",
  "onboard.netExposeAction": "Publish and set password",
  "onboard.netExposed": "Published to your network",
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
