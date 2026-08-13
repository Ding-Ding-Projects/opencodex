# Material 3 port — handoff

Status of the port of `design/OpenCodex M3.dc.html` into `gui/`, as of the first
stage. The plan of record is `design/PORT-TO-GUI.md`; this file records what has
actually landed, what has not, and where the seams are.

**Chosen approach:** full per-screen rewrite of all 19 screens, staged. Stage 1
(below) lands the foundation and the six new system screens. The thirteen
product screens still render their existing markup, restyled through the token
layer, and are rewritten one at a time in later stages.

---

## Landed

### 1. Token engine — `gui/src/theme/m3.ts`

Direct port of `Component.buildScheme` / `densityTokens` / `typeTokens` /
`applyTokens` from the prototype, typed and side-effect free.

| Export | Role |
|---|---|
| `buildScheme(seedHex, dark)` | seed → OKLCh → six tonal palettes → M3 role tokens |
| `densityTokens(1…5)` | `--h-btn`, `--h-row`, `--h-appbar`, `--sp-1…5`, … |
| `typeTokens(scale)` | `--t-display-s` … `--t-label-s` |
| `applyTokens(el, opts)` | writes every token, plus `--el-<id>-*` per-element overrides |
| `applyLayout(el, width)` | nav geometry for the measured window class |
| `windowClass(width)` | `compact` <600 · `medium` <1240 · `expanded` ≥1240 |

Tone → lightness uses `L = (tone + 16) / 116` above tone 8, exactly as the
prototype does, so no colour-science dependency is needed.

### 2. Preferences — `gui/src/theme/prefs-context.ts` + `prefs.tsx`

Persisted under `ocx-m3:v1`. Holds theme, seed, density, font id/scale/weight,
narrator settings and per-element overrides. `PrefsProvider` applies tokens on
every change and tracks the OS colour scheme and the viewport width.

Split into two files because Fast Refresh discards module state when a file
mixes component and non-component exports — which would have reset every
preference on each edit.

### 3. Shell — `gui/src/shell/`

| File | Role |
|---|---|
| `AdaptiveNav.tsx` | bottom bar / icon rail / permanent drawer + compact modal drawer |
| `AppBar.tsx` | title, live `v… · :port` status, notification centre, Appearance shortcut, account chip |
| `TabStrip.tsx` | browser-style tabs: pin, close, drag-reorder, overflow menu, roving `tabIndex` |
| `SnackbarHost.tsx` | bottom-left `aria-live="polite"` stack |
| `use-tabs.ts` | tab state, hash sync |
| `notifications*.ts(x)` | snackbars + capped, persisted history |
| `narrator.ts` | single-utterance speech queue that supersedes rather than stacks |
| `revisions.ts` | append-only revision log |
| `m3-ui.tsx` | Card / Button / Segmented / Slider / Field / TextInput / TextArea / Chip / Toggle / Empty / Dialog / Banner / SelectField |
| `page-meta.ts` | nav order, icons and label keys for all 19 pages |

`App.tsx` is rebuilt around these. `styles/m3-shell.css` holds every shell rule;
no colour in it is a literal.

**Deviation from `PORT-TO-GUI.md`:** tab state persists under `ocx-m3:tabs`, not
inside `ocx-m3:v1`. Appearance prefs and tab state change at very different
rates, and sharing one key means two independent writers racing to clobber each
other's last write.

### 4. `styles.css` re-pointed

Every legacy token is now an alias onto an `--m3-*` role token
(`--surface` → `--m3-surface-container-low`, `--accent` → `--m3-primary`, …).
Class names are unchanged, so the thirteen not-yet-rewritten screens pick up the
new palette, density and typography immediately. The `light-dark()` values
survive only as the one-frame pre-paint fallback.

Legacy chrome removed: the ambient `body::before` gradient wash is gone, and the
glass-rail tokens now resolve to opaque tonal surfaces with `--glass-blur: none`.
Status and chart colours stay functional data colours, as the spec requires.

### 5. Six new system screens

| Screen | Notes |
|---|---|
| **Appearance** | theme, seed picker (free hex + 8 curated), density 1–5, font family/scale/weight, live preview, per-element editors with individual reset |
| **Language & voice** | interface language; narrator off by default, one utterance at a time, language selectable |
| **Regex builder** | ECMAScript `RegExp` evaluated locally. Caps enforced: 400-char pattern, 20 000-char sample, 200 matches, forced advance on a zero-width match. Token palette, flags, presets, named groups, copy + Markdown export |
| **Changelog** | reads `/api/changelog`; ISO date range (typed *and* native picker, invalid input reported inline without discarding text) composed with regex-capable search, Markdown export stating the range |
| **Version history** | append-only; a restore is recorded as a new revision and the dialog says so |
| **Notifications** | full history, tone filter, plain-text search with `.*` opt-in |

### 6. i18n — `gui/src/i18n/m3.ts`

~135 new keys live in their own module rather than `en.ts`. The five translated
dictionaries stay typed `Record<ProductKey, string>`, so a missing *product*
translation is still a compile error; M3 keys resolve through `M3_OVERRIDES`
with an English fallback and can be filled in per locale, per screen, without
breaking the build. Nav labels are translated for all five; the rest currently
renders English outside `en`.

### 7. Supporting backend (minimal, needed by the Changelog screen)

- `scripts/generate-changelog.ts` — regenerates `CHANGELOG.md` from release
  tags. Runtime-agnostic (`execFileSync`, no `import.meta.dir`), so it runs under
  both Bun and Node. Already run: 98 releases.
- `src/server/management/changelog-routes.ts` — `GET /api/changelog`, wired into
  `management-api.ts`. Answers `{ available: false, releases: [] }` when no
  `CHANGELOG.md` is packaged, so the screen can explain itself instead of erroring.

### 8. Desktop app + installer

- `electron/main.mjs` — spawns `bin/ocx.mjs start --port 10100` as a child,
  waits for `/healthz` to answer as `service: "opencodex"`, then loads the
  dashboard the proxy serves. If a healthy proxy is already listening it
  *attaches* instead of spawning a competitor, and leaves it running on quit
  because it did not start it. Tray, start-at-login, native menus, and external
  links handed to the real browser.
- `electron/preload.mjs` — exposes `window.opencodexDesktop = { isDesktop, platform }`
  and nothing else. No Node API is bridged.
- `electron-builder.yml` — NSIS installer (not one-click: the proxy writes to
  `~/.opencodex` and rewrites the native Codex config, so the user should see
  where it goes). Uninstall deliberately leaves `~/.opencodex` alone — it holds
  providers, accounts and API keys.
- `.github/workflows/desktop-installer.yml` — `workflow_dispatch`, plus every
  `v*` tag. Uploads `opencodex-desktop-windows-<sha>`.

Two decisions worth keeping:

**`asar: false`.** The proxy is Bun reading TypeScript off disk and exec'ing a
bundled `bun.exe`. Neither survives an asar archive — you cannot exec a binary
inside one, and Bun's loader cannot read one. Unpacked keeps every path in
`bin/ocx.mjs` true as written.

**`electron` is not a repo dependency.** electron-builder downloads the runtime
itself from the pinned `electronVersion`, which keeps a ~100 MB download out of
every existing CI job that runs `bun install`. Bump the version in
`electron-builder.yml`, not in `package.json`.

The workflow runs on a Windows runner by necessity, not preference: `bun install`
unpacks a platform-specific Bun binary, so a Windows `.exe` can only be produced
on Windows. There is an explicit step that fails the build if that binary is
still the ~450-byte placeholder stub, using the same 1 MB threshold
`bin/ocx.mjs` uses — otherwise the installer would ship and then refuse to start.

#### Platform support

**Windows is the only supported desktop target.** The macOS (`dmg`) and Linux
(`AppImage`) targets that were in the first draft have been removed rather than
left declared-but-unbuilt — a target nobody builds is a promise the project is
not keeping.

**The rule this creates: Windows is not allowed to be the lesser platform.**
Anything that works on another operating system has to work on Windows too.
Concretely, when touching the desktop app or the proxy:

- If a capability exists on macOS or Linux — a service/daemon integration, a
  tray behaviour, a path convention, a shell integration, an auto-start
  mechanism — there must be a Windows equivalent before it is considered done.
  Windows-only gaps are bugs, not platform limitations to document and move on
  from.
- Where the platforms genuinely differ (no POSIX signals, `schtasks` needing
  elevation, locked state DBs, `%APPDATA%` vs `~`), the Windows path gets a real
  implementation, not a `process.platform !== "win32"` guard that quietly skips
  the feature.
- `bin/ocx.mjs` already carries several of these branches — signal forwarding,
  the tray-update handoff, service reinstall falling back to a detached start
  when elevation is refused. Follow that pattern: branch to make Windows work,
  never to opt it out.

If a platform is added back later, that rule does not relax. It exists so the
desktop app never becomes the place where feature parity quietly erodes.

### 9. Network hosting — `ocx host`

`src/cli/host.ts` — `status` / `enable` / `disable`, the supported way to reach
the proxy and dashboard from another device.

Most of this already existed server-side and was simply unreachable: binding to
a non-loopback hostname already flips `isApiAuthRequired()`, which forces a
credential onto every `/api/*` and data-plane request, and
`assertServerAuthConfig()` already refuses to start without one. What was
missing was a safe way to turn it on — previously you hand-edited
`config.hostname` and hoped you had a key.

Four properties to preserve if this is touched:

1. **Off by default, never implicit.** `enable` is the only path, needs `--yes`,
   and names what becomes reachable.
2. **No credential, no exposure.** `enable` refuses unless a data-plane
   credential exists or `--new-key` mints one — mirroring the server assertion
   so you cannot write a config that fails at the next startup.
3. **No session bootstrap over the network.** `issueGuiSession()` refuses any
   non-loopback `Host`, so a remote browser gets a 401 and must paste the key,
   which `gui/src/api.ts` holds in memory only (never localStorage). This is the
   intended posture, not a gap — `status` explains it rather than apologising
   for it.
4. **Plaintext once.** A generated key prints exactly once, like
   `ocx access key create`; `status` never echoes it back.

`tests/cli-host.test.ts` pins each refusal, because the refusals are the
feature. Every enable-path test asserts the bind is *still loopback* afterwards.

### 10. CI — `.github/workflows/gui-preview.yml`

Typecheck → lint → test → build, then uploads `gui/dist` as an artifact
(`opencodex-dashboard-<sha>`, 14-day retention) with a `HOW-TO-RUN.txt`
explaining how to serve it and which screens work without a proxy.

Not a Pages deploy on purpose: `deploy-docs.yml` already owns the Pages
environment for the docs site.

---

## Verification

Run locally, all green:

- `bun test tests` (in `gui/`) — **373 pass, 0 fail**
- `bun x tsc -b` (gui) and `bun x tsc --noEmit` (root) — clean
- `bun run lint` — clean
- `bun x vite build` — succeeds

The first CI run caught six failures, all now fixed:

| Test | Why it broke | Fix |
|---|---|---|
| `sidebar-codex-auth` | asserted on `NAV` in `App.tsx` | retargeted at `shell/page-meta.ts` |
| `grok-page` (nav) | same | same |
| `dashboard-tabs` (order) | same | reads `ORDER` in `page-meta.ts` |
| `dashboard-tabs` (divider) | Q3 said "no divider"; M3 requires one between product and system groups | rewritten to "exactly one divider, between the groups" |
| `app-stop` | sliced to `const brand`, which no longer exists; asserted `alert()` | new slice bound, asserts the persistent error snackbar |
| `claude-toggle-race` | rendered `App` bare; it now needs `PrefsProvider` + `NotificationsProvider` | wraps with the same stack `main.tsx` mounts |

That last one exposed a **real regression, not just a stale test**: the shell had
dropped the Claude connection switch that used to sit on the sidebar's Claude
row. It is restored — `NavItem` takes a `trailing` slot, the switch renders as a
sibling of the nav button (never nested, since a control inside a button is not
operable), and the single-in-flight-PUT guard came back with it.

**Still not run:** the desktop installer build. Bun is now available locally and
`node_modules/bun/bin/bun.exe` verified at 98 MB — so the installer's central
assumption holds — but a full `electron-builder` run has not been done. The
first `desktop-installer` workflow run is the real signal. The likeliest first
failure is a missing runtime file in the `files` allowlist in
`electron-builder.yml`: if the app launches and then reports the proxy exited,
check that list before anything else.

---

## Not landed

### 11. Export + account-change history

- `ocx export <path|-> --yes` — full-state bundle (config, Codex accounts with
  OAuth credentials, auth record). Refuses without `--yes`; warning on stderr so
  piping stays clean; mode 600; nothing masked because a masked backup cannot
  be restored.
- `src/lib/state-history.ts` — local-only git repo inside `~/.opencodex`,
  committing config/accounts/auth on account add/remove. **The user has
  explicitly accepted that secrets live in this local history**; the boundary
  that remains non-negotiable is local-only (no remote is ever configured,
  nothing pushes, the generated README in the repo says so). Fully async behind
  a sequential queue — the first, synchronous version destabilised OAuth flow
  timing, caught by tests/codex-auth-api.test.ts. On Windows a missing git is
  auto-installed once via winget (silent); elsewhere it logs and degrades.
- `ocx export --history` lists snapshots.

### 12. Remote access & backup screen + generic OAuth pools + keep-alive tabs

Landed after the 13-screen rewrite, same session. This section is the port's own
record of *what happened*; it is not where a user or a maintainer should read up
on these features. The user-facing homes are
[`reference/configuration.md`](../../docs-site/src/content/docs/reference/configuration.md)
(the pool keys and the two-credential model),
[`reference/cli.md`](../../docs-site/src/content/docs/reference/cli.md) (`ocx host`,
`ocx export`), and [`guides/docker.md`](../../docs-site/src/content/docs/guides/docker.md).

- **Keep-alive tabs**: every open tab's page stays mounted (hidden when
  inactive) instead of remounting on switch — the remount was visible stutter.
  `renderPage()` in App.tsx keeps one literal JSX line per page for the
  source-text tests.
- **Generic OAuth account pool** (`src/oauth/provider-pool.ts`): the Anthropic
  pool engine extracted and provider-parameterized; anthropic-routing.ts is a
  compatibility facade. Any `authMode: "oauth"` provider opts in via
  `providers[<name>].accountPool` (default OFF). Same 429 cooldown/failover,
  affinity, quota/RR/fill-first strategies. core.ts's two pool sites are
  generic; recovery kind `oauth-pool-429` joined the usage log. Documented under
  [`providers[<name>].accountPool`](../../docs-site/src/content/docs/reference/configuration.md)
  in the config reference, including that `quota` needs a per-account usage
  signal only Anthropic has.
- **App-bar account switcher** (`shell/AccountSwitcher.tsx`): switch the routed
  Codex account from any page; server refusals surface verbatim.
- **Remote access & backup screen** (`pages/Network.tsx` + `/api/host*` routes)
  — the GUI face of `ocx host` / `ocx export`: expose/disable with confirm,
  one-time data-plane key display, custom user-chosen keys (12+ chars,
  plaintext warning), full-state export download, account-change history.
  Routes share `src/lib/host-control.ts` with the CLI so they cannot drift.
- **Credential model**: management (`/api/*`, dashboard) is intentionally open;
  the data-plane key authenticates model traffic. Remote deployments need an
  external authenticated boundary around management routes.

#### Auth roadmap (user-requested three-step authentication)

- **TOTP second factor + dim-sum pairing verification** (pick on the remote
  device the dish shown on the host machine): planned as an optional step-up on
  non-loopback management sessions. Task #13.
- **Passkeys are blocked on TLS**: WebAuthn requires a secure context, and the
  remote dashboard is plain `http://` on a LAN IP — browsers refuse the API
  there. `ocx host` needs TLS support first. Do not fake this with a
  password-manager field pretending to be a passkey.

### ~~Stage 2+ — the thirteen product screens~~ DONE

All thirteen landed in `f0c7bb07` as a restyle-in-place: data wiring untouched,
markup moved to the m3-card / pill-tablist / m3-table / role="switch"
vocabulary, colours all `--m3-*` roles. Source-text tests were retargeted with
supersession comments; the combined tree verified green (gui 380/0, both
typechecks, lint, build, privacy, parity).

### `ui.tsx` retired down to `Tooltip`

The pre-M3 primitive module is now one component. `Switch`, `Notice`, `Select`,
`SelectOption` and `EmptyState` are deleted, along with their `styles.css` rules
and the `select-position.ts` helper that existed solely to place the hand-rolled
listbox's portaled menu.

Two of those swaps changed behaviour rather than only appearance, and both were
bugs the old primitives could not express:

- `Notice` had exactly two tones, `ok` and `err`, so **every warning in the
  product had been shipping as an error**. `Banner` carries the same four tones
  the notification system does. Each former `<Notice>` was re-decided per site
  rather than renamed: page state that persists until its condition clears
  became an inline `Banner`; a one-shot outcome ("saved", "switched", "removed")
  became `notify()`, and the `useState` + `setTimeout` driving it was deleted.
- `Select` was a hand-rolled listbox. `SelectField` wraps the native control, so
  touch users get the platform picker back — at the cost of markup inside an
  `<option>`, which is why `ClaudeCode`'s helper-model picker passes plain slugs
  instead of `modelLabel()`'s icon-prefixed node.

`Tooltip` stays: it still has one caller (the shadow-call hint on Models) and
there is no M3 tooltip to move it to yet. `.notice` / `.notice-ok` /
`.notice-err` stay in `styles.css` for the same reason — the un-ported
Add-Codex-Account modal writes those class names by hand.

### Deferred by scope

- ~~**Docker.**~~ Landed — `Dockerfile` + `scripts/docker-entrypoint.sh`. Documented for
  users in [`docs-site/.../guides/docker.md`](../../docs-site/src/content/docs/guides/docker.md),
  which is where it belongs; this file is not the place to look it up.
- ~~**Codex account switching.**~~ Landed as the app-bar switcher in item 12 above
  (`gui/src/shell/AccountSwitcher.tsx`).
- **Funny-level voice ladder** (levels 1–5). The mechanism is not built. It needs
  array-valued dictionary entries; `M3_OVERRIDES` is the natural place to add
  the shape. Note the rule the prototype demonstrates: facts are identical at
  every level, only voice changes — the destructive warning reads the same at
  level 1 and level 5.
- **Dim sum surprise.** Built (`gui/src/shell/DimSumCard.tsx` + `shell/dimsum.ts`,
  one draw per launch, off-switch on Appearance) but each dish still renders an
  emoji placeholder rather than a photo, and `dimsum.ts` says so in the source.
  Real bundled dish images are the remaining half.
- **Bundled fonts.** `FONT_CHOICES` names Roboto Flex / Roboto Mono / Noto Sans
  HK, but no font files are bundled — the stacks fall through to system faces
  today. `docs/design-system/foundations.md` forbids CDN fonts, so these must be
  vendored into `gui/public/` before the family picker means anything.
- **Settings search across every settings surface.** Built. `gui/src/shell/settings-registry.ts`
  holds one index of every setting; each screen contributes its rows in
  `gui/src/shell/settings-registry-entries.ts`, and `useSettingsSearch` takes a
  `scope` naming the page a surface is, so a query reports matches on other pages
  by their navigation name. 80 settings across 14 pages are registered. Rows are
  i18n keys resolved at query time rather than strings captured at render time,
  because the index has to describe screens that are not mounted — which also
  rules out registering from a component effect. What it still does not carry is a
  setting's live value on a page that is not open, or navigation to the hit.

---

## Seams worth knowing

- `data-theme` is still written on `<html>` in both directions, because legacy
  page CSS branches on it. Do not remove it until the last screen is rewritten.
- `WIDE_PAGES` in `App.tsx` opts a page out of the 1180px centred column.
- `recordRevision()` from `shell/revisions.ts` is called only by Appearance so
  far. Every provider/account/key/combo mutation should call it as its screen is
  rewritten — that is what fills the Version history screen.
- `notify()` from `shell/notifications-context.ts` replaces `alert()` for
  informational messages. A *decision* (stop proxy, remove provider, permanent
  delete, reset credit, restore, exit) is still blocking — but it goes through
  `useConfirm()` from `shell/confirm-context.ts`, never the native
  `window.confirm()`. That one drew an OS box the app could neither theme nor
  label, so every decision in the product read "OK".

  ```ts
  const confirm = useConfirm();
  if (!(await confirm({ title, body, confirmLabel, tone: "danger" }))) return;
  ```

  The promise resolves `false` for Cancel, Escape, the scrim and the provider
  unmounting, so an awaiting handler always continues. `confirmLabel` names the
  action ("Exit", "Restore", "Download export"); `tone: "danger"` is for the ones
  that cannot be taken back. `ConfirmProvider` is mounted in `main.tsx` inside
  `NotificationsProvider`, so a confirmation renders above a live snackbar.
  Nothing in `gui/src` may call the global `confirm`, `alert` or `prompt`.

- Collecting a *value* goes through `usePrompt()` from the same module and the
  same provider — `(request) => Promise<string | null>`, `null` for every
  dismissal route, `""` a deliberate answer rather than a cancellation.

  ```ts
  const prompt = usePrompt();
  const alias = await prompt({ title, label, initialValue, confirmLabel });
  if (alias === null) return;
  ```

  `label` is required: `window.prompt()` gave the box no accessible name, and
  inside Electron it does not merely look wrong — `prompt` is unimplemented and
  *throws*. Confirmations and prompts share one queue, so only one modal is ever
  on screen. Management requests no longer open a credential prompt.
