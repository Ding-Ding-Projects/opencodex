# Roadmap

What is done, what is in flight, and what is known to be missing. Nothing here is a prediction, and
an item is only "done" when the code exists in this repository.

**Audit dates are per-row, not per-file.** The original sweep was **2026-07-30**. The Known gaps
section and the release-state paragraph below were re-checked against the tree on **2026-08-13**;
every other row still carries its 2026-07-30 date and has not been re-verified since. A row is not
re-dated on faith — if it says 2026-07-30, that is the last time anyone actually looked.

That re-check mattered. Six features listed here as missing had in fact shipped between 2026-07-30
and 2026-07-31 — the day of the original audit and the day after it — so the audit recorded them as
absent hours before they landed and nothing corrected it afterwards. Cantonese, the bilingual mode,
the funny-level ladder, word-depth typography, dim sum photographs and the shared settings search
were all described here as unbuilt while their code sat on `main`. Those rows are rewritten below.

Release state, re-checked 2026-08-13: the newest non-preview `v*` tag is still **v2.7.42**
(2026-07-28), but `v*` is no longer the only release series. `.github/workflows/auto-release.yml`
publishes a real GitHub release per green run, tagged `build-<run_number>`, and refuses to publish
one without a Windows installer attached. Ten such tags exist, from **build-120** (2026-08-02) to
**build-152** (2026-08-09), and build-152 points at the current `main` tip. Every feature commit in
the table below is an ancestor of build-120, so all of it has shipped in a tagged release — the
opposite of what this file said until now.

## Completed — Windows release integrity and automatic conflict repair (2026-08-09)

| Work | Current state |
| --- | --- |
| Merge reconciliation | The integration source tip is semantically resolved into the current `main` tree with no unmerged paths; lifecycle, GUI identity, loopback process gates, fail-closed updater/export behavior, and current management-plane semantics are retained. |
| Unsigned Squirrel delivery | Every installer path clears signing inputs, requires `NotSigned`, validates `Setup.exe` + `RELEASES` + a referenced full `.nupkg`, and attaches the update feed to its release. Stable packaging now finishes before npm publication, and super-express requires successful Windows CI for the exact SHA. |
| Failure evidence | Every artifact producer defensively collects allowlisted outputs and run/SHA/job/runner metadata behind `always()` without masking the original failure. Step-specific YAML tests guard the collector, upload, and real release asset arguments. |
| Verification | Typecheck, privacy, GUI lint/build, docs build, and focused workflow, Squirrel, export, and storage tests are green locally. Exact-commit GitHub Actions and release evidence remain pending until the integration commit lands. |

## Completed — plug-and-play local startup (2026-08-04)

This refresh was implemented and verified on `codex/plug-and-play-startup` for integration into
`main`. The older roadmap rows retain their original 2026-07-30 audit date.

| Work | Current state |
| --- | --- |
| Fresh local default | Already present in `getDefaultConfig()`: built-in `openai` ChatGPT-forward route, no provider API key. `ocx start` is the primary first-run command. |
| `ocx init` default | An empty selection resolves to provider 1, the keyless OpenAI/ChatGPT route. Covered by the focused startup verification. |
| Provider readiness | The shared configuration-state helper, management-API fields, and GUI consumers distinguish forward, OAuth, local, key-optional, loopback, Vertex external-auth, and keyed routes instead of reducing them to `hasApiKey`. A non-empty configured environment reference counts without probing whether that variable exists (preventing an environment-existence oracle); only the active mirrored `apiKey` counts, and explicit key auth still requires a key on loopback. |
| Windows pinned-port recovery | Reclamation is non-terminating. A fresh all-state snapshot reaches dead CLOSE_WAIT/ESTABLISHED-only rows after LISTEN disappears, while current, live, unparseable, protected, or indeterminate owners fail the whole deletion set closed. |
| Reader path | README plus English, Japanese, Korean, Russian, and Simplified Chinese installation and quickstart guides distinguish ChatGPT/Codex login, optional upstream credentials, and the non-loopback OpenCodex admission key. English provider and dashboard guides carry the detailed readiness model; translated counterparts were audited and did not contradict the keyless default. |
| Implementation verification | Independent review reran 125 focused root tests with 0 failures; the final reclaim subset was 29/29. The complete GUI suite was 874/874 with 10,221 assertions across 131 files. A 474-file root campaign reached every file, but its outer shell lost the first 396 files' buffered verdicts at timeout, so only the explicitly captured final 78-file range is claimed green: 1,030/1,030 after replacing a flaky 1-second subprocess-output test budget; its exact 12-file rerun was 164/164. TypeScript, privacy scan, GUI build, documentation build, and diff checks passed; GUI lint had 0 errors and one pre-existing hook warning. Exact-commit CI remains the authoritative whole-suite verdict. |
| Runtime verification | An isolated source run returned a healthy keyless OpenAI forward route and HTTP 400—not an admission-key 401—for malformed unauthenticated loopback input. A real Electron launch on an off-screen Windows desktop with a fresh profile rendered Online, 1 Ready, 0 Needs setup, and OpenAI (Codex login), with no provider-key prompt. |
| Documentation verification | `bun install --frozen-lockfile` succeeded; the final post-localization `bun run build` completed 186 pages and indexed 190 HTML files. `check-dist` reported 190 pages OK and 186 carrying the tab strip, and the rendered credential/admission-key content was checked in every updated locale. |
| Review | Two independent final reviews found no remaining concrete integration blocker and no P0–P2 security finding. The GitHub release/workflow result remains an external exact-commit verdict rather than a predicted success. |

## Done and released

Behaviour documented on [opencodex.me](https://opencodex.me/) and shipped in a tagged release.

| Area | Item |
| --- | --- |
| Proxy | Responses-compatible proxy for Codex CLI / App / SDK with per-provider adapters |
| Clients | Claude Code (`/v1/messages`), opencode, Grok Build, GitHub Copilot App integrations |
| Accounts | OAuth multiauth store, Codex account pool, API-key pools, Token Guardian refresh |
| Anthropic | Opt-in experimental Anthropic OAuth account pool (`anthropicAccountPool`, #294) |
| Dashboard | Web dashboard on the proxy port; management routes are open, while non-loopback `/v1/*` traffic uses a separate OpenCodex admission key |
| Ops | `ocx service` (launchd / systemd / Task Scheduler), `ocx doctor`, usage log |

## Done, on `main`, and shipped in a `build-*` release

Re-checked 2026-08-13. This section was headed "not yet in a tagged release" until then. Every
commit below is an ancestor of `build-120` (2026-08-02) and of every later build tag through
`build-152`, so users on a current installer have all of it. The rows marked "uncommitted" were
uncommitted as of the 2026-07-30 sweep and have not been re-checked.

| Item | Commit |
| --- | --- |
| Material 3 dashboard shell and the six system screens | `c72f6616` |
| Desktop app packaged as a downloadable installer | `e6cd29bb` |
| Desktop build narrowed to the Windows target; nav Claude toggle restored | `f19016a7` |
| All thirteen product screens rewritten onto the M3 prototype | `f0c7bb07` |
| Frameless desktop window — the M3 app bar is the chrome | `72871770` |
| Dim sum surprise — one draw per launch, no off switch | `3df26e8a` |
| Dim sum photographs — eleven bundled `.webp` dish photos replace the emoji placeholders | `58fb0eb7` |
| `ocx host` — reach the proxy and dashboard from other devices | `1a316b5f` |
| `ocx changelog` and the in-app changelog viewer | `4c41de91` |
| `ocx export` full-state bundle + local-only git history of account changes | `1b2558e0` |
| Canonical `ocx memory-sync` adapter with read-only project-profile inventory | uncommitted |
| Home Assistant usage-meter integration; auto-release on green CI | `7a6cdd3a` |
| Estimated API cost meter in the app bar | `34b1dea0` |
| Published price bands — OpenAI Fast tier (×2, ×2.5 on `gpt-5.5`) and the >272,000-token long-context rate (×2 input, ×1.5 output), applied to both the direct and API-equivalent cost lanes and named beside the figure they multiplied. A request whose prompt size or served tier cannot decide a band is reported unpriced rather than estimated at the cheaper one | uncommitted |
| App logs written to `~/.opencodex/logs/opencodex.log`, rotated at 2 MiB keeping 3 generations (8 MiB ceiling); clearing the logs commits them to the local git history first, and restoring appends rather than rewinds | uncommitted |
| QR pairing for the mobile remote — one-click remote access that generates its own data-plane key, a QR carrying a single-use 5-minute pairing token, and a phone that claims it once and remembers the key. The claim route is deliberately unauthenticated and rate limited; `/api/host` now reports `restartPending` so the dashboard stops claiming a bind the socket has not taken yet | uncommitted |

## Design parity with `design/`

Three waves, one agent per screen, each verified by a second agent that re-read the prototype rather
than trusting the report. **378 differences closed across all 19 screens**; GUI tests went 383 → 494.

Parity is **not** 100%, and the remainder is listed honestly under Known gaps below rather than
rounded away. The largest single category was cross-page settings search; as of the 2026-08-13
re-check the mechanism ships and its index is registry-driven at 80 settings across 14 pages, past
the prototype's fourteen entries. The rest are per-screen notes recorded in the wave reports. Those figures — 378 differences, 383 → 494 tests — are from the 2026-07-30 sweep and have
not been re-counted since. Three of the verifiers caught defects their own implementing
agent had missed — a history entry written for a change that never happened, an uncapped regex over
every log line, and a page claiming to bundle fonts it did not have — which is the argument for
keeping the verify pass rather than trusting a self-report.

## Landed since the last release (committed on 2026-07-30)

Previously listed here as uncommitted; all of it is now on `main`.

| Item | Where |
| --- | --- |
| Provider-agnostic OAuth account pool | `src/oauth/provider-pool.ts`, `src/oauth/pool-constants.ts` |
| Container deployment | `Dockerfile`, `scripts/docker-entrypoint.sh`, `.dockerignore` |
| Remote access & backup screen + `/api/host*` routes | `gui/src/pages/Network.tsx`, `src/server/management/host-routes.ts`, `src/lib/host-control.ts` |
| App-bar Codex account switcher | `gui/src/shell/AccountSwitcher.tsx` |
| One-press launching of the agent CLIs and desktop apps | `src/lib/app-launcher.ts`, `gui/src/components/LaunchCard.tsx`, `src/cli/launch.ts` |
| Undoable deletion — every delete commits the state before it destroys it | `src/lib/state-history.ts`, `src/codex/auth-api.ts`, `src/server/management/oauth-account-routes.ts` |
| One-click restore with a finish-and-hand-off drain, append-only | `src/lib/state-history.ts`, `src/server/management/host-routes.ts`, `gui/src/pages/Network.tsx` |
| Graceful "Exit app" that warns on live sessions | `src/server/management/host-routes.ts`, `gui/src/shell/WindowControls.tsx` |
| Custom Material 3 window controls (no native title bar or overlay) | `electron/main.mjs`, `electron/preload.mjs`, `gui/src/shell/WindowControls.tsx` |
| Account pool GUI for every OAuth provider, not just Anthropic | `gui/src/components/provider-workspace/OAuthAccountPoolSettings.tsx` |

## Known gaps

Re-checked in the tree on **2026-08-13**. Everything not struck through is genuinely absent, not
merely undocumented.

Five entries here asserted an absence that was false and are struck through with the commit that
settled it: Cantonese and the bilingual mode, the funny-level sliders, word-depth typography, dim
sum photographs, and the hand-wired settings search. A sixth — cross-page settings search — was
half wrong: the mechanism ships and the remaining shortfall is narrower than the entry claimed, so
it is rewritten rather than struck. They are kept visible rather than deleted, because a reader who
was told last month that a feature was missing needs to see it corrected, not silently vanish.

### Language and voice

- ~~**No Cantonese and no bilingual interface language.**~~ Fixed in `499c1bc8` (2026-07-30).
  `gui/src/i18n/shared.ts` declares `Locale` as `en | yue | bi | de | ko | zh | ru | ja`, and
  `LOCALES` lists 廣東話 and `English + 廣東話` beside the rest. `gui/src/i18n/yue.ts` is 2,684 lines
  of Hong Kong Cantonese, typed as a *partial* dictionary on purpose so an untranslated key falls
  through the chain instead of forcing ~1,500 placeholder strings. `bi` is a rendering mode rather
  than a dictionary: `resolveKey()` in `resolve.ts` resolves both tracks and joins them with a
  middle dot, and joins only when they differ, so an untranslated key does not print in English
  twice. `bilingualParts()` hands a surface the two halves unjoined for a two-line row or a chip,
  and `translateWithBilingualVars()` interpolates the matching half of each variable into each
  track — without it, a bilingual name substituted into a bilingual template rendered the name
  twice per half.
- ~~**No funny-level sliders.**~~ Fixed in `499c1bc8` (2026-07-30). `gui/src/i18n/voice.ts` is 1,531
  lines of level-specific copy; `resolveTrack()` consults `voiceFor()` *first*, ahead of the
  dictionaries, so the level styles whatever is under it. Language & voice
  (`gui/src/pages/LanguageVoice.tsx`) renders two independent sliders — `lang.funnyEn` and
  `lang.funnyYue` — each with a live five-rung ladder showing the same destructive warning at all
  five levels.
  - **It is a curated overlay, not five full dictionaries, and the screen says so.** The product
    dictionary is ~2,000 keys; five variants of all of them would be ~10,000 strings per language,
    most of them labels like "Save" with one sensible rendering. The overlay covers the eleven
    categories in `VOICE_CATEGORIES` — destructive, security, financial, accessibility, error,
    warning, success, progress, empty, guidance, delight — and every other key falls through to the
    neutral string. `voiceCoverage()` and `voiceCategoryCoverage()` report the real numbers so the
    settings screen states them rather than implying the whole app is rewritten.
  - **Level 3 is deliberately absent** from the overlay: the shipped neutral wording *is* level 3,
    and a second copy of it would drift from the dictionaries and make the slider lie. The one
    exception is the destructive warning rendered as the ladder, which carries an explicit level 3
    in both tracks so the Cantonese rung reads as Cantonese under an English interface locale.
- **The narrator speaks both languages, serialized.** `configureNarrator()` now takes an ordered
  list of tracks, and the bilingual chip stores its own `"both"` value rather than the same `"en"`
  the English chip stores — which is why picking it used to light two chips and narrate in English
  only. English speaks first, Cantonese follows once the first utterance ends, each in its own
  `SpeechSynthesisUtterance` with its own `lang`, voice, rate and pitch. It remains off by default
  and still supersedes rather than stacking; supersession now spans the pair, so interrupting after
  the English half has started drops the Cantonese half instead of letting a stale second language
  arrive on top of a newer message.
- **The narrator has a voice picker per narrated language, with rate and pitch.**
  `gui/src/shell/narrator-voices.ts` enumerates what the platform actually reports, subscribes to
  `voiceschanged` because the list arrives late (measured here: **0 voices** on the first
  synchronous `getVoices()`, **3** after the event fired twice), and unsubscribes on teardown.
  `prefs.narratorVoices` persists `SpeechSynthesisVoice.voiceURI` — the platform's stable identity,
  never the display name, which is neither unique nor stable across installs. Bilingual mode gets
  two independent pickers, because choosing an English voice says nothing about which Cantonese
  voice should read the other half. Nothing ships with a named voice selected: "Choose
  automatically" is the default and leaves `utterance.voice` unset so the platform decides.
  - **Still open: the status line depends on what the platform admits to.** A voice's `lang` is
    self-reported, so a machine carrying a Cantonese voice that reports only `zh` is treated as
    region-unknown and offered, while one reporting `zh-CN` is excluded as the wrong dialect. Both
    are the honest reading of the metadata, but neither is a guarantee about pronunciation.
- **Cantonese narration has real voices, from Microsoft Edge's read-aloud service.** Windows installs
  no Cantonese voice at all — this machine reports three `en-US` voices and nothing else — so the
  local picker alone left the product's Cantonese narration effectively unusable. `src/server/
  management/narrator-tts.ts` lists the service's 322 voices and synthesizes MP3 over its WebSocket;
  `narrator-routes.ts` exposes `/api/narrator/edge-voices` and `/api/narrator/edge-speak`, and the
  renderer decodes the clip through the Web Audio API. That closes the gap with three neural
  Cantonese voices (`zh-HK-HiuMaanNeural`, `zh-HK-HiuGaaiNeural`, `zh-HK-WanLungNeural`).
  - **It is opt-in, and off by default, because the narrated text leaves the machine.** The
    disclosure saying so sits on the control that enables it. A stored Edge voice makes no network
    request at all while the source is off; it speaks with a local voice and the surface says so.
  - **The endpoint is undocumented and unsupported.** Microsoft can change or block it at any time.
    Offline, blocked and refused all degrade to a local voice with the reason shown, never to
    silence. The handshake also validates `Sec-MS-GEC-Version` against the `User-Agent`'s Edge major
    version and answers a bare `403` when they disagree or when the version has aged out — so those
    two constants must be bumped **as a pair**, and a sudden blanket `403` means the pin is stale
    rather than that the protocol changed.
  - **Still open: no automated test covers the live service.** The client, the routes and the
    renderer's queue behaviour are tested, but the synthesis path is proved by a real request made
    by hand (322 voices listed; 14,976 bytes of valid MP3 from `zh-HK-HiuMaanNeural` through the
    route) rather than by CI, which cannot depend on an undocumented third-party endpoint.
  - **Both routes are driveable from a shell.** `ocx narrator voices|speak|status` (`src/cli/
    narrator.ts`) calls the same two routes, so the catalogue and the synthesiser are not
    picker-only — which is what the headless parity guard requires of every management endpoint.
    `--edge` is required by every path that reaches the network and the refusal without it carries
    the disclosure; `lib/narrator-control.ts` holds the bounds and the request validation that the
    route and the CLI both apply, so an over-long line is refused locally rather than on the wire.
    Installed platform voices are enumerated through the OS speech platform (Windows only today),
    which is a near — not identical — match for what the browser's picker reports. The narrator's
    own settings stay per-visitor browser state, and `status` says so rather than inventing a
    server-side default.

### Remote access

- **No TLS.** `Bun.serve` is started without a `tls` option, so `ocx host` and the container both
  serve plain HTTP; the data-plane key crosses the network in cleartext.
- **Management API is intentionally open.** The admin-token gate and GUI-session bootstrap were
  removed. Any non-loopback deployment must add an external authenticated boundary before exposing
  `/api/*`, which includes provider settings, exports, and account controls.
- **Passkeys are blocked on the TLS gap**, not merely unimplemented: WebAuthn requires a secure
  context, which a plain-HTTP LAN origin is not.

### Pooling

- **`quota` has no usage signal outside Anthropic.** `supportsPerAccountQuota()` covers `anthropic`
  only, so for every other provider a configured `quota` strategy runs as `round-robin` (unless
  `autoSwitchThreshold` is `0`). Per-account quota probes for other providers would be needed to
  make the configured strategy literal.
- **No mid-session rotation, soft-avoid ladder, or probe lease** in the OAuth pool. This is
  deliberate — subscription OAuth is ToS-sensitive — and is a decision to revisit consciously, not a
  bug to fix quietly.

### Appearance

- ~~**Bundled fonts are not bundled.**~~ Fixed in `5d18a875` (2026-07-30). Eleven woff2 files (Roboto Flex, Roboto, Roboto Mono,
  Noto Sans HK — Latin subsets, 0.41 MB total) live in `gui/public/fonts` with `@font-face`
  declarations in `gui/src/styles/fonts.css`. Nothing is fetched at runtime. **Noto Sans HK's CJK
  coverage is deliberately not bundled**: one weight is 6.7 MB and three would be ~20 MB in every
  clone and installer, duplicating a face Windows (Microsoft JhengHei) and macOS (PingFang) already
  ship. The stacks name it first and fall through to the system's Chinese face. If that is ever
  revisited, subset it to the glyphs the interface actually uses rather than shipping the whole font.
- ~~**Word-depth typography is not there.**~~ Fixed in `4ba0f747` (2026-07-31). All four things that
  sentence named are present in `gui/src/components/appearance/TypographyEditor.tsx`:
  - **Variable axes** — `FontPicker.tsx` renders a slider per axis, and the axes are read from the
    font's own `fvar` table by `readVariationAxes()` in `shared/m3/fonts.ts` (a minimal SFNT reader:
    table directory, then `fvar`, then `name`), not from a hard-coded table. It reports
    loading, unknown and none as distinct states rather than showing an empty list for all three.
  - **Underline styles** — solid, dotted, dashed, double and wavy, plus underline colour and
    thickness. Overline and single/double strikethrough are there too.
  - **Small caps** — both `small-caps` and `all-small-caps`, alongside upper, lower, capitalize,
    superscript and subscript.
  - **Spacing** — letter spacing, word spacing, line height and baseline shift.

  Also present: weight, slant, italic, oblique with an angle, text colour, highlight, outline with
  colour, shadow (x, y, blur, colour), glow with colour, alignment and text direction. A property
  the platform cannot honour stays visible with a capability note (`type.unsupported`,
  `type.partial`, `type.unknown`) rather than disappearing or silently dropping a saved value.
- ~~**Dim sum dishes are emoji, not photos.**~~ Fixed in `58fb0eb7` (2026-07-30). Eleven `.webp`
  photographs live in `gui/public/dimsum/`, one per dish in `DISHES`, and `photoSrc()` in
  `gui/src/shell/dimsum.ts` resolves `dimsum/<id>.webp` — a local file in the build output, never a
  network fetch. `DimSumCard.tsx` renders the photo optimistically and swaps in the emoji only on
  `onError`; the emoji is now a fallback so that adding a twelfth dish cannot render a broken image,
  not the shipped art. The alt text names the dish.

### Search

- A full regex builder screen exists (`gui/src/pages/RegexBuilder.tsx`) and every collection search
  offers a plain-text default with a `.*` regex opt-in.
- ~~**Settings search is hand-wired per surface.**~~ Fixed in `e5897a08` (2026-07-31). The behaviour
  lives once in `gui/src/shell/settings-search.ts` (matcher and result, no React, no `t()`, so a
  test can compute the same answer the screen shows) and `use-settings-search.ts` (state). A surface
  declares an option list rather than reimplementing a matcher. `SettingsSearchRow` from
  `SettingsSearch.tsx` — field, `.*` opt-in, anchored builder, status line — is rendered by Claude
  Code, Debug, Mobile, Network, Startup, Storage and the tab appearance editor; `settingsMatcher` is
  reused directly by Codex Auth's account pool, the provider catalog, provider models and Claude
  Desktop. The hand-wiring it replaced had already drifted: six near-identical rows disagreed about
  whether they searched values or only labels, and about whether a hit on another tab was reported
  at all.
- ~~**Cross-page settings search does not exist.**~~ Partly fixed in `ee0c3186` (2026-07-31), and the
  old wording here was wrong: `settings.otherTab` can name another *page*, not only another card on
  the same screen. `runSettingsSearch` reports two kinds of off-screen hit separately, because they
  need different actions — `otherTabs`/`otherTabHits` for another tab of the same surface (one
  click away) and `elsewhereTabs`/`elsewhereHits` for another screen (navigate). The list feeding
  the second is `SETTINGS_ELSEWHERE` in `gui/src/pages/settings-elsewhere.ts`: **one** shared array
  imported by every surface, which filters out its own rows, so registering a setting once makes it
  findable from every search bar.
- ~~What genuinely remains is that `SETTINGS_ELSEWHERE` is **hand-curated, not generated**, at eight
  entries where the prototype reports fourteen.~~ Closed. `gui/src/shell/settings-registry.ts` holds
  the contract and `settings-registry-entries.ts` the contributions: **80 settings across 14 pages**
  — Dashboard 12, Claude 15, Startup 8, Storage 7, Logs & Debug 7, Appearance 6, Remote access 6,
  Language & voice 5, Remote control 4, Codex Auth 3, Notifications 3, Models 2, API 1, Grok 1. All
  eight hand-written rows are gone; `settings-elsewhere.ts` is now a shim deriving its list from the
  registry.
  - `useSettingsSearch` reads it through a new `scope` argument with three states, not two: a page
    id means the surface *is* that page, `"all"` means nothing on screen is here (what a popover or
    dialog needs, since a dialog is not a page), and omitting it opts out — which is what every
    caller that was not rewired silently gets, so no unwired surface changed behaviour.
  - Rows are i18n **keys** resolved at query time rather than strings captured at render time,
    because the index has to describe screens that are **not mounted** — a mount-time registry would
    have rebuilt the same blindness with more machinery. It also makes a row pointing at a
    nonexistent key a compile error instead of a search result leading nowhere, and keeps the
    cross-page note in the reader's own language. Page ids reuse the router's `Page` union, so an
    entry for a screen that does not exist fails to compile.
  - `Settings` registers none of its own rows. It is the aggregate view, and a setting belongs to
    the page owning its real editor — a mirror that registered too would report the same setting
    twice under two page names.
  - Still open: the registry indexes labels, descriptions and option names but **not a setting's
    live value** on a page that is not open, because a screen that has never read a control cannot
    honestly say what it is set to. Selecting a cross-page hit reports where the setting lives
    rather than navigating there. `Settings.tsx` and `Appearance.tsx` still build their searches by
    hand and reach the registry through the shim, so they match labels and descriptions but not the
    registry's keyword terms.
- The regex-builder hand-off **no longer drops flags on the shared row**, and did when this was
  written. `useSettingsSearch` holds `flags` as state with `setFlags`; `SettingsSearchRow` seeds
  `RegexBuilderButton` from its own query *and* its own flags and writes the pattern, the flags and
  regex mode back, so the round trip is bidirectional. `settingsMatcher` strips the stateful flags
  (`g`, `y`) before compiling, since a matcher reused across options would otherwise skip every
  other one depending on call order. Each row owns its own builder — two search bars on one screen
  get two builders that cannot see each other.
- ~~The builder's **hand-off** into the Logs search dropped flags too.~~ Fixed. The record in
  `gui/src/pages/logs-search-handoff.ts` now carries `flags` beside the pattern, and that file owns
  the key, the shape and the validation for both ends — `RegexBuilder.tsx` had declared a private
  second copy of the key, which is how it came to write a field nothing read. Flags out of storage
  are treated as untrusted input: real `RegExp` flag characters only, no duplicates, capped at one
  of each, and rejected whole rather than filtered down, because a half-honoured flags string
  compiles fine and then searches under rules nobody chose. A record carrying no `flags` — written
  by an earlier build and still sitting in `sessionStorage` — falls back to the field's existing
  `"i"` rather than being refused. The Logs row holds flags as state, compiles them minus `g` and
  `y`, and shows them as a chip row with a line naming the literal it actually compiles, so a
  carried flag is visible and correctable instead of silent.
- ~~**The flags gap survives on the nine search bars the audit named.**~~ Closed for those nine. API
  keys, Appearance (both bars), Changelog, Grok, Language & voice (the page search and each narrator
  track's voice picker), Notifications, Storage, Subagents and Usage each built
  `new RegExp(query, "i")` directly, so a pattern built as case-sensitive arrived case-insensitive
  there. All eleven now hold `flags` as state seeded from `DEFAULT_SEARCH_FLAGS`, write the pattern
  *and* the flags back from `RegexBuilderButton`'s `onApply`, and compile through `settingsMatcher`
  — which strips `g` and `y` before compiling, since a matcher reused down a list would otherwise
  keep every other row depending on call order. Moving onto the shared matcher also gave Changelog
  and Notifications the 400-character pattern bound they had been missing entirely.
  - `Appearance.makeMatcher`, `Storage.makeSettingsMatcher` and `LanguageVoice.useMatcher` survive
    as thin adapters rather than being deleted: the first two report a bare "invalid" notice and
    want a boolean where the shared result carries the compiler's message, and the third
    deliberately keeps its own answer to an unusable pattern (see below).
  - `settingsMatcher` trims before matching, and five of these bars did not. In plain-text mode a
    query with leading or trailing whitespace now finds what the same query without it finds, which
    is the only behaviour these eleven searches changed outside the regex path.
  - **Two bars keep matching *everything* on an invalid pattern** rather than adopting
    `settingsMatcher`'s match-nothing: the Language & voice page search and `filterVoices` behind
    each narrator track's picker. A half-typed pattern must not blank a page the user is reading or
    a list of 322 voices, so the error is surfaced beside the field and the list is left alone.
    Both are documented at the call site.
- Every one of those bars shows the flags it is compiling. `gui/src/shell/SearchFlagsRow.tsx` is the
  shared affordance — the `FLAGS` chips plus a line naming the literal the field compiles to, and a
  sentence saying so whenever `g` or `y` was dropped. It renders only in regex mode, because plain
  text is a case-insensitive substring search whatever the chips say and a control that looks live
  while changing nothing is the decorative affordance the interface rules forbid. Its
  "these were ignored" line is derived by calling `stripStatefulFlags` rather than by a hand-written
  `g`/`y` check, so the row and the matcher cannot disagree about what was dropped. `Logs.tsx` keeps
  the inline copy this was generalized from; the two are held together by the shared
  `search.flags*` translation keys they both render.
- `gui/tests/collection-search-flags.test.ts` is the guard. It carries a **hand-written** inventory
  of the eleven bars, because a rule shaped "wherever flags are held, hold them correctly" passes
  cleanly on a bar that holds none — only a list can fail for a surface that never adopted the
  contract. Each row asserts the flags state, the exact matcher call, the `flags={…}` hand-down, the
  write-back out of `onApply` and the chip row's own id; a separate row forbids the hard-coded
  compile coming back. Every one of those assertion classes was watched failing before it was
  trusted: reverting a matcher to `"i"`, deleting a chip row, dropping the flags out of `onApply`,
  reintroducing `new RegExp(query, "i")`, stopping `stripStatefulFlags` from stripping, and removing
  a row from the inventory each turn it red, and restoring each turns it green.
- ~~**Still open: two shared matchers the original list of nine did not name.**~~ Closed for the
  seven surfaces this named. `gui/src/pages/models-shared.ts`'s `makeMatcher` takes a third `flags`
  argument and `gui/src/pages/history-model.ts`'s `filterTimeline` an optional `flags` on
  `TimelineFilter`; both default to `DEFAULT_SEARCH_FLAGS`, which is the same `"i"` they used to
  compile in — deliberately, because between them they feed more call sites than the seven named
  here, and a default that changed what an unflagged call finds would have been a silent regression
  across all of them rather than a fix. Both strip `g` and `y` through `stripStatefulFlags` before
  compiling: `RegExp.prototype.test` carries `lastIndex` between calls, so one matcher reused down a
  list keeps every other row, and which half survives depends on nothing but the order the rows were
  tested in. `comboSettingsSearch` in `gui/src/components/combo-workspace-settings-search.tsx` takes
  and forwards `flags` for the same reason — it is a third entry point rather than a surface, since
  it wraps `makeMatcher` for the combo detail's Config tab.
  - The seven surfaces named above turned out to render **eight** fields. `Models.tsx` has two
    search bars, the model catalogue search and its own settings search; and the field filed here
    under `combo-workspace-settings-search.tsx` is rendered by `combo-workspace-detail-panel.tsx`,
    that file being the matcher rather than the screen. Each of the eight now holds `flags` as
    state seeded from `DEFAULT_SEARCH_FLAGS`, writes the pattern *and* the flags back from
    `RegexBuilderButton`'s `onApply`, seeds the builder from its own flags so the round trip is
    bidirectional, and renders a `SearchFlagsRow` beneath the field under its own state-line id —
    `models-regex-flags-state`, `models-settings-flags-state`, `settings-regex-flags-state`,
    `claude-desktop-settings-flags-state`, `cwi-search-flags-state`, `cws-settings-flags-state`,
    `codex-pool-settings-flags-state`, `history-regex-flags-state`. The ids are per field and never
    shared: two bars on one screen own two independent flag sets, and one id pointing at both would
    describe each with the other's state. Each field names its row in `aria-describedby` only in
    regex mode, because that is the only mode the row renders in and a description pointing at an
    element that is not on the page is announced as nothing at all.
  - The rows sit under the search row rather than inside it. Each of these rows is already a single
    flex line carrying the field, the `.*` chip and the builder trigger, and six more chips in it
    would squeeze the input to nothing in the narrow columns three of these surfaces are checked at
    — the models workspace's main column, the combo rail and the combo detail panel.
  - `gui/tests/models-shared-matcher-flags.test.ts`, `gui/tests/history-model-filter-flags.test.ts`
    and `gui/tests/combo-settings-flags.test.ts` are the guards: 27 tests, all passing. Each asserts
    the user-visible defect in one pair — a pattern composed as case-sensitive staying
    case-sensitive — that an unflagged call still behaves exactly as the pinned `"i"` did, that `g`
    and `y` do not make a list drop every other row, that plain text is untouched by the flags since
    it never compiles a regex for them to describe, and that the trim, the empty query, the
    400-character cap and the match-nothing-and-say-so shape all survive carrying them.
  - **Still open here: the wiring is asserted for one of the eight fields, not for eight.**
    `combo-settings-flags.test.ts` checks the combo panel's flags state, its matcher call, the
    `flags=` hand-down, the write-back out of `onApply` and its chip row's id by exact source
    string. The other seven are covered only at the matcher level, and a matcher test passes on a
    field that hands it no flags, because the test hands them itself. The hand-written inventory in
    `gui/tests/collection-search-flags.test.ts` is still the eleven bars of the entry above and was
    not extended to these eight, so a field reverting to a query and a mode and no flags at all
    would go unnoticed. That inventory is where they belong.
- **Still open: `makeMatcher` feeds six more call sites the entry above did not name, and a third
  shared matcher sits behind the tab searches.** Each of the six still takes the matcher's default
  while rendering a builder whose flags it discards: `claude-desktop-lane.ts`'s `laneView` behind
  every model-family lane filter on Claude Desktop (one builder per lane),
  `claude-settings-search.ts`'s `claudeSettingsSearch` behind `claude-code-settings.tsx`, both
  matchers in `use-dashboard-data.ts` behind `dashboard-models-section.tsx` and
  `dashboard-overview-panels.tsx`, and `ProviderWorkspaceShell.tsx` and `ProviderSettings.tsx` in
  the provider workspace. Separately, `shared/m3/tabs.ts`'s `tabMatcher` already accepts `flags`
  and resets `lastIndex` per call, but every caller pins the `TAB_MATCH_FLAGS` constant: the tab
  search panel, the tab strip's bulk-close and page searches, and the font picker all seed their
  builder from that constant and never read back what it returns. Closing either is the same shape
  of change as the one above, and adding those fields to `collection-search-flags.test.ts` is what
  should keep the guard red until they are done. Every `settingsMatcher` caller, by contrast, now
  passes flags — that family is complete.

## Non-goals

- Patching Codex binaries. opencodex writes a provider table and catalog and proxies requests.
- Bypassing provider rate limits or terms. Pools spread load across accounts the user already has;
  no rotation strategy protects against provider enforcement, and the docs say so wherever a pool is
  described.
