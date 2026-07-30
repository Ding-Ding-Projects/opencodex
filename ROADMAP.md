# Roadmap

What is done, what is in flight, and what is known to be missing. Every row was checked against the
tree and `git log` on **2026-07-30**; nothing here is a prediction, and an item is only "done" when
the code exists in this repository. Where something is on `main` but not in a tagged release, this
file says so instead of implying users have it.

Release state at the time of writing: the newest non-preview tag is **v2.7.42** (2026-07-28). Every
feature commit listed as "on `main`" below landed after it and has not shipped in a tagged release.

## Done and released

Behaviour documented on [opencodex.me](https://opencodex.me/) and shipped in a tagged release.

| Area | Item |
| --- | --- |
| Proxy | Responses-compatible proxy for Codex CLI / App / SDK with per-provider adapters |
| Clients | Claude Code (`/v1/messages`), opencode, Grok Build, GitHub Copilot App integrations |
| Accounts | OAuth multiauth store, Codex account pool, API-key pools, Token Guardian refresh |
| Anthropic | Opt-in experimental Anthropic OAuth account pool (`anthropicAccountPool`, #294) |
| Dashboard | Web dashboard on the proxy port, management API behind an admin credential |
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

## In flight (uncommitted in the working tree on 2026-07-30)

These files exist and typecheck, and the tests named in [`HANDOFF.md`](./HANDOFF.md) pass; they are
not committed, so nothing about them is released.

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
  serve plain HTTP; the data-plane key and the admin token cross the network in cleartext.
- **No second factor.** Management auth is a single admin token plus a loopback-only session
  bootstrap. The TOTP + dim-sum pairing step-up sketched in
  [`docs/design-system/m3-port-handoff.md`](docs/design-system/m3-port-handoff.md) is not built.
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

- A full regex builder screen exists (`gui/src/pages/RegexBuilder.tsx`), and the Changelog and
  Notifications searches each offer a plain-text default with a regex opt-in. What is missing is a
  **search on every settings surface**: no per-surface index over option labels, descriptions, and
  current values exists anywhere in `gui/src`, and the existing search fields have no anchored
  builder affordance beside them.

## Non-goals

- Patching Codex binaries. opencodex writes a provider table and catalog and proxies requests.
- Bypassing provider rate limits or terms. Pools spread load across accounts the user already has;
  no rotation strategy protects against provider enforcement, and the docs say so wherever a pool is
  described.
