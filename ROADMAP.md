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
| App logs written to `~/.opencodex/logs/opencodex.log`, rotated at 2 MiB keeping 3 generations (8 MiB ceiling); clearing the logs commits them to the local git history first, and restoring appends rather than rewinds | uncommitted |
| QR pairing for the mobile remote — one-click remote access that generates its own data-plane key, a QR carrying a single-use 5-minute pairing token, and a phone that claims it once and remembers the key. The claim route is deliberately unauthenticated and rate limited; `/api/host` now reports `restartPending` so the dashboard stops claiming a bind the socket has not taken yet | uncommitted |

## Design parity with `design/`

Three waves, one agent per screen, each verified by a second agent that re-read the prototype rather
than trusting the report. **378 differences closed across all 19 screens**; GUI tests went 383 → 494.

Parity is **not** 100%, and the remainder is listed honestly under Known gaps below rather than
rounded away. The largest single category was cross-page settings search; as of the 2026-08-13
re-check the mechanism ships and what remains of it is that its cross-page index is hand-curated at
eight of the prototype's fourteen entries. The rest are per-screen notes recorded in the wave
reports. Those figures — 378 differences, 383 → 494 tests — are from the 2026-07-30 sweep and have
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
- **The narrator speaks one language, not two.** `gui/src/shell/narrator.ts` is 46 lines: it holds a
  single `lang` string, builds one `SpeechSynthesisUtterance` from it, and `configureNarrator()`
  takes `{ enabled, lang }`. So there is still **no English-then-Cantonese serialized mode**. The
  reason this file used to give — that there was no Cantonese locale to serialize — stopped being
  true on 2026-07-30; the gap is now purely that the narrator has one track where bilingual mode has
  two. It remains off by default and supersedes a pending utterance rather than stacking.
- **No narrator voice picker, and no rate or pitch controls.** `prefs.narratorLang` is a single
  language string; nothing enumerates the machine's installed voices, nothing persists a stable
  platform voice identity, and there is no per-language picker. A listener gets whichever voice the
  platform picks for that language tag.

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
- What genuinely remains is that `SETTINGS_ELSEWHERE` is **hand-curated, not generated**. It holds
  eight entries across five tabs (Codex Auth, Models, Grok, API, Language & voice) where the
  prototype's `settingsIndex` in `design/ocx-data.js` reports fourteen. The shortfall is deliberate
  and documented in the file: it lists only entries whose keys genuinely resolve today, because a
  row pointing at a key that renders as nothing sends the user to a tab to look for something that
  is not there. A generated index over the real settings components is the honest remaining half —
  until then, a setting is discoverable from another page only if someone remembered to register it.
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
- **The flags gap survives on the search bars that compile their own `RegExp`.** API keys,
  Appearance, Changelog, Grok, Language & voice, Notifications, Storage, Subagents and Usage each
  still build `new RegExp(query, "i")` directly, so a pattern built as case-sensitive arrives
  case-insensitive there. These are collection searches rather than the shared settings row; moving
  them onto `settingsMatcher` is what would close it. Logs was the tenth and is done.

## Non-goals

- Patching Codex binaries. opencodex writes a provider table and catalog and proxies requests.
- Bypassing provider rate limits or terms. Pools spread load across accounts the user already has;
  no rotation strategy protects against provider enforcement, and the docs say so wherever a pool is
  described.
