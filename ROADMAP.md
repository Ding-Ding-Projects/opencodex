# Roadmap

What is done, what is in flight, and what is known to be missing. Every row was checked against the
tree and `git log` on **2026-07-30**; nothing here is a prediction, and an item is only "done" when
the code exists in this repository. Where something is on `main` but not in a tagged release, this
file says so instead of implying users have it.

Release state at the time of writing: the newest non-preview tag is **v2.7.42** (2026-07-28). Every
feature commit listed as "on `main`" below landed after it and has not shipped in a tagged release.

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
| Runtime verification | An isolated source run returned a healthy keyless OpenAI forward route and HTTP 400—not an admission-key 401—for malformed unauthenticated loopback input. A real Electron launch on an off-screen Windows desktop with a fresh profile rendered Online, 1 Ready, 0 Needs setup, and OpenAI (Codex login), with no provider-key prompt. A final launch audit caught that the documented `ocx codex` command was missing; the implemented launcher passed 16/16 focused CLI/help tests, returned `codex-cli 0.145.0`, and completed a real loopback-routed `codex exec` with the exact `READY` response and exit 0. |
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

## Done, on `main`, not yet in a tagged release

| Item | Commit |
| --- | --- |
| Material 3 dashboard shell and the six system screens | `c72f6616` |
| Desktop app packaged as a downloadable installer | `e6cd29bb` |
| Desktop build narrowed to the Windows target; nav Claude toggle restored | `f19016a7` |
| All thirteen product screens rewritten onto the M3 prototype | `f0c7bb07` |
| Frameless desktop window — the M3 app bar is the chrome | `72871770` |
| Dim sum surprise — one draw per launch, off-switch on Appearance (dishes still render an emoji placeholder, not a photo) | `3df26e8a` |
| `ocx host` — reach the proxy and dashboard from other devices | `1a316b5f` |
| `ocx changelog` and the in-app changelog viewer | `4c41de91` |
| `ocx export` full-state bundle + local-only git history of account changes | `1b2558e0` |
| Home Assistant usage-meter integration; auto-release on green CI | `7a6cdd3a` |
| Estimated API cost meter in the app bar | `34b1dea0` |
| App logs written to `~/.opencodex/logs/opencodex.log`, rotated at 2 MiB keeping 3 generations (8 MiB ceiling); clearing the logs commits them to the local git history first, and restoring appends rather than rewinds | uncommitted |
| QR pairing for the mobile remote — one-click remote access that generates its own data-plane key, a QR carrying a single-use 5-minute pairing token, and a phone that claims it once and remembers the key. The claim route is deliberately unauthenticated and rate limited; `/api/host` now reports `restartPending` so the dashboard stops claiming a bind the socket has not taken yet | uncommitted |

## Design parity with `design/`

Three waves, one agent per screen, each verified by a second agent that re-read the prototype rather
than trusting the report. **378 differences closed across all 19 screens**; GUI tests went 383 → 494.

Parity is **not** 100%, and the remainder is listed honestly under Known gaps below rather than
rounded away. The largest single category is cross-page settings search; the rest are per-screen
notes recorded in the wave reports. Three of the verifiers caught defects their own implementing
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

Checked in the tree; each of these is genuinely absent, not merely undocumented.

### Language and voice

- **No Cantonese and no bilingual interface language.** `gui/src/i18n/shared.ts` offers `en`, `de`,
  `ko`, `zh` (Simplified), `ru`, `ja` only.
- **No funny-level sliders.** Nothing in `gui/src` reads a per-language playfulness level, so the
  two independent 1–5 controls (one per language) do not exist and no copy responds to one.
- The narrator (`gui/src/shell/narrator.ts`, off by default, one utterance at a time) speaks the
  chosen interface locale; there is no English-then-Cantonese serialized mode because there is no
  Cantonese locale to serialize.

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

- ~~**Bundled fonts are not bundled.**~~ Fixed. Eleven woff2 files (Roboto Flex, Roboto, Roboto Mono,
  Noto Sans HK — Latin subsets, 0.41 MB total) live in `gui/public/fonts` with `@font-face`
  declarations in `gui/src/styles/fonts.css`. Nothing is fetched at runtime. **Noto Sans HK's CJK
  coverage is deliberately not bundled**: one weight is 6.7 MB and three would be ~20 MB in every
  clone and installer, duplicating a face Windows (Microsoft JhengHei) and macOS (PingFang) already
  ship. The stacks name it first and fall through to the system's Chinese face. If that is ever
  revisited, subset it to the glyphs the interface actually uses rather than shipping the whole font.
- The appearance editor covers theme, seed, density, font id/scale/weight and per-element overrides.
  Word-depth typography (variable axes, underline styles, small caps, spacing) is not there.
- **Dim sum dishes are emoji, not photos.** `gui/src/shell/dimsum.ts` labels its own art as a
  placeholder; bundled images are the remaining half of that feature.

### Search

- A full regex builder screen exists (`gui/src/pages/RegexBuilder.tsx`), every collection search
  offers a plain-text default with a `.*` regex opt-in, and the **settings-search row now ships on
  the settings surfaces** (Codex Auth, Providers, Models, Storage, Startup, Claude Code) with a
  builder shortcut beside it.
- What remains is **cross-page settings search**. Each surface builds its own local index, so
  `settings.otherTab` can only name another card on the same screen — not another page. The
  prototype's `settingsIndex` (`design/ocx-data.js`) is one flat array of `{tab, label, desc, value}`;
  a shared `useSettingsSearch(sectionId, localEntries)` in `gui/src/shell/` would let each screen
  contribute its rows and query the whole set. That is the honest remaining half of "a search on
  every settings surface".
- The regex-builder hand-off carries a pattern into a search bar but **drops flags**: the receiving
  rows compile with a fixed `"i"`, matching the prototype, so a pattern built as case-sensitive
  arrives case-insensitive. Either the builder should stop sending flags a row cannot represent, or
  the rows need a flags affordance and the copy to label it.

## Non-goals

- Patching Codex binaries. opencodex writes a provider table and catalog and proxies requests.
- Bypassing provider rate limits or terms. Pools spread load across accounts the user already has;
  no rotation strategy protects against provider enforcement, and the docs say so wherever a pool is
  described.
