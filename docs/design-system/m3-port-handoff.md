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
| `m3-ui.tsx` | Card / Button / Segmented / Slider / Field / Chip / Toggle / Empty |
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
- `.github/workflows/desktop-installer.yml` — `workflow_dispatch` with an OS
  choice, plus every `v*` tag. Uploads `opencodex-desktop-<os>-<sha>`.

Two decisions worth keeping:

**`asar: false`.** The proxy is Bun reading TypeScript off disk and exec'ing a
bundled `bun.exe`. Neither survives an asar archive — you cannot exec a binary
inside one, and Bun's loader cannot read one. Unpacked keeps every path in
`bin/ocx.mjs` true as written.

**`electron` is not a repo dependency.** electron-builder downloads the runtime
itself from the pinned `electronVersion`, which keeps a ~100 MB download out of
every existing CI job that runs `bun install`. Bump the version in
`electron-builder.yml`, not in `package.json`.

The workflow needs one runner per OS: `bun install` unpacks a platform-specific
Bun binary, so a Windows `.exe` must be produced on a Windows runner. There is
an explicit step that fails the build if that binary is still the ~450-byte
placeholder stub, using the same 1 MB threshold `bin/ocx.mjs` uses — otherwise
the installer would ship and then refuse to start.

### 9. CI — `.github/workflows/gui-preview.yml`

Typecheck → lint → test → build, then uploads `gui/dist` as an artifact
(`opencodex-dashboard-<sha>`, 14-day retention) with a `HOW-TO-RUN.txt`
explaining how to serve it and which screens work without a proxy.

Not a Pages deploy on purpose: `deploy-docs.yml` already owns the Pages
environment for the docs site.

---

## Verification

Run locally, all green:

- `npx tsc -b` — clean
- `npx eslint .` — clean (0 errors, 0 warnings)
- `npx vite build` — succeeds

**Not run:** the GUI test suite. It is `bun test tests`, and Bun is not on this
machine's PATH; `vitest` is not the runner and cannot substitute. The
`gui-preview` workflow runs it on every push touching `gui/**`, so the first CI
run is the real signal. Eleven test files reference `App`/routing
(`app-stop`, `sidebar-codex-auth`, `dashboard-tabs`, `providers-hash-history`,
`claude-toggle-race`, and the `*-layout` files) and are the most likely to need
updating against the new shell — the sidebar Claude toggle in particular moved
out of the nav.

**Also not run:** the desktop installer build. It needs Bun plus a full
`electron-builder` run and has only been syntax- and schema-checked locally
(`node --check` on the Electron entry points, YAML parse on all three configs).
The first `desktop-installer` workflow run is the real signal. The likeliest
first failure is a missing runtime file in the `files` allowlist in
`electron-builder.yml` — if the app launches and then reports the proxy exited,
check that list before anything else.

---

## Not landed

### Stage 2+ — the thirteen product screens

Not started. Each keeps its current markup and data wiring, restyled through the
token aliases. Port targets and the `en.ts` namespace each screen was derived
from are tabulated in `design/PORT-TO-GUI.md` §3. Read the real component file
before porting: where its markup differs from what the `en.ts` keys implied, the
source file wins.

Suggested order — highest visual payoff first, and each is independent:
Dashboard → Codex Auth → Providers → Models → Combos → Logs & Debug → Usage →
Storage → API → Claude → Grok → Subagents → Startup.

### Deferred by scope

- **Docker.** Not started.
- **Codex account switching.** Not started.
- **Funny-level voice ladder** (levels 1–5). The mechanism is not built. It needs
  array-valued dictionary entries; `M3_OVERRIDES` is the natural place to add
  the shape. Note the rule the prototype demonstrates: facts are identical at
  every level, only voice changes — the destructive warning reads the same at
  level 1 and level 5.
- **Dim sum surprise.** Not built. Needs bundled dish photos before it can ship
  at all; the prototype's placeholder is explicitly labelled as such.
- **Bundled fonts.** `FONT_CHOICES` names Roboto Flex / Roboto Mono / Noto Sans
  HK, but no font files are bundled — the stacks fall through to system faces
  today. `docs/design-system/foundations.md` forbids CDN fonts, so these must be
  vendored into `gui/public/` before the family picker means anything.
- **Settings search across every settings surface.** Not built; needs a generated
  index over the real settings components.

---

## Seams worth knowing

- `data-theme` is still written on `<html>` in both directions, because legacy
  page CSS branches on it. Do not remove it until the last screen is rewritten.
- `WIDE_PAGES` in `App.tsx` opts a page out of the 1180px centred column.
- `recordRevision()` from `shell/revisions.ts` is called only by Appearance so
  far. Every provider/account/key/combo mutation should call it as its screen is
  rewritten — that is what fills the Version history screen.
- `notify()` from `shell/notifications-context.ts` replaces `alert()` for
  informational messages. `confirm()` is still correct for decisions
  (stop proxy, remove provider, permanent delete, reset credit, restore).
