# Porting the Material 3 redesign into `gui/`

Everything in this prototype was derived from files in the attached `opencodex`
checkout. Nothing here is invented UI — copy comes from `gui/src/i18n/en.ts`, the
component inventory from `gui/src/pages/*` and `gui/src/components/*`, and the
current design tokens from `gui/src/styles.css` + `docs/design-system/foundations.md`.

## Files in this project

| File | Role |
|---|---|
| `OpenCodex M3.dc.html` | The whole prototype: M3 token engine, adaptive shell, tab system, 19 screens |
| `ocx-i18n.js` | Localization + funny-level voice layer (en / 廣東話 / bilingual, levels 1–5) |
| `ocx-data.js` | Offline mock data shaped like the real `/api/*` payloads |

## 1. Token layer — replaces `gui/src/styles.css` `:root`

The engine lives in `Component.buildScheme(seed, dark)`. It converts the seed hex
to OKLCh, derives six tonal palettes (primary / secondary / tertiary / neutral /
neutral-variant / error) and maps them onto the M3 role tokens. Tone → lightness
uses `L = (tone + 16) / 116` for tone > 8 (exact for neutrals, since OKLab L of a
grey equals `Y^(1/3)`), which is why the ramp matches HCT closely without shipping
a colour library.

Port as a small module, e.g. `gui/src/theme/m3.ts`:

```ts
export function buildScheme(seedHex: string, dark: boolean): Record<string, string>
export function densityTokens(level: 1|2|3|4|5): Record<string, string>
export function typeTokens(scale: number): Record<string, string>
export function applyTokens(el: HTMLElement, opts): void
```

Call `applyTokens(document.documentElement, …)` from a `useEffect` in `App.tsx`
where the existing `data-theme` effect is. Delete the `light-dark()` token block
in `styles.css` and keep the class names, re-pointing each to a `--m3-*` var —
that lets the 13 pages keep rendering while they are migrated one at a time.

Role tokens emitted: `--m3-primary`, `-on-primary`, `-primary-container`,
`-on-primary-container` (same four for secondary / tertiary / error), `-surface`,
`-on-surface`, `-surface-variant`, `-on-surface-variant`,
`-surface-container-lowest|low|(base)|high|highest`, `-surface-dim`,
`-surface-bright`, `-inverse-surface`, `-inverse-on-surface`, `-inverse-primary`,
`-outline`, `-outline-variant`, `-scrim`, plus `--m3-ok` / `--m3-warn` (+containers)
for status. **Status and chart colours stay functional data colours** — the global
instructions exempt them from the M3 chrome rule.

Density (`--h-btn`, `--h-row`, `--h-appbar`, `--h-tab`, `--h-nav`, `--pad-card`,
`--sp-1…5`) interpolates level 1 (M3 comfortable) → 5 (today's console density).
Type tokens follow the M3 scale (`--t-display-s` … `--t-label-s`) times a scale
multiplier. Shape: `--r-s 8`, `--r-m 12`, `--r-l 16`, `--r-xl 28`, pills at 999.

## 2. Shell — replaces the `.app` grid in `App.tsx`

| Prototype element | Replaces | Notes |
|---|---|---|
| Adaptive nav (rail 600–1239 / drawer ≥1240 / bottom bar <600) | `.sidebar` + `.mobile-topbar` + `.drawer-scrim` | Breakpoints measured in JS (`measure()`), not media queries |
| Top app bar | (new) | Title, status, preview-size, notification, appearance, avatar |
| Browser-style tab strip | `.page-tabs` | Owns page navigation now; per-tab pin / close / drag-reorder / overflow |
| Snackbar host (bottom-left) | `Notice` / `alert()` / `confirm()` calls | Informational messages must stop being modal |
| Blocking dialog | `.modal-overlay` | Decisions only: stop proxy, remove provider, permanent delete, reset credit, restore |

Nav order and icons map 1:1 to the `NAV` array in `App.tsx`; the six system pages
(Appearance, Language & voice, Regex builder, Changelog, Version history,
Notifications) are additions required by `SHARED_INSTRUCTIONS.md`.

Tab state (`{id, page, pinned}[]`, order, active id) persists under
`localStorage["ocx-m3:v1"]` alongside appearance and language prefs. Keep the
existing hash routing: the active tab's page should still write `#page`, so
back/forward and deep links keep working (`use-app-route-state.ts`).

## 3. Screen map

**Provenance, stated plainly.** The files read while building this prototype were:
`gui/README.md`, `gui/src/App.tsx`, `gui/src/styles.css`,
`docs/design-system/foundations.md`, `gui/src/icons.tsx`, `gui/src/ui.tsx`,
`gui/src/pages/Dashboard.tsx`, `dashboard-overview-section.tsx`,
`dashboard-overview-head.tsx`, `gui/src/provider-icons.ts`, and the whole of
`gui/src/i18n/en.ts`.

Assets copied into the project from the repo (not redrawn): `gui/public/logo.png`
(pre-tinted to `assets/logo-ink-light.png`, inverted for dark mode, because a
cross-origin `mask-image` is refused in this sandbox) and eleven marks from
`gui/public/provider-icons/` into `assets/provider-icons/`, resolved through the
id→file map lifted verbatim from `provider-icons.ts`. Providers with no shipped
mark (e.g. `zai`) get a tonal monogram chip rather than an invented icon.

Every screen's copy, section headings, tab sets, filter options, table columns,
badge states, empty states and confirmation wording were derived from the `en.ts`
key namespaces (which is why the strings match the shipping product exactly), and
the visual system from `styles.css` + `foundations.md`. The per-screen component
files below were **not** opened — they are the port targets, listed so each screen
lands in the right place. Read them before porting; where a screen's real markup
differs from what the `en.ts` keys implied, the source file wins.

| Screen | `en.ts` namespace it was built from | Target files to port into |
|---|---|---|
| Dashboard | `dash.*` | `pages/Dashboard.tsx`, `dashboard-overview-head.tsx`, `dashboard-overview-section.tsx`, `dashboard-shared.ts` |
| Codex Auth | `codexAuth.*`, `quota.*`, `accountPool.*`, `anthropicPool.*` | `pages/CodexAuth.tsx`, `components/CodexAccountPool.tsx`, `codex-account-pool-*.tsx`, `QuotaBars.tsx`, `CodexAutoSwitchSetting.tsx`, `AccountPoolStrategyControls.tsx` |
| Providers | `prov.*`, `pws.*`, `modal.*` + `provider-icons.ts` (read) | `pages/Providers.tsx`, `components/provider-workspace/*` |
| Models | `models.*` | `pages/Models.tsx`, `models-shared.ts`, `models-groups.ts` |
| Combos | `cws.*` | `pages/Combos.tsx`, `components/combo-workspace-*.tsx` |
| Subagents | `sub.*` | `pages/Subagents.tsx` |
| Logs & Debug | `logs.*`, `debug.*` | `pages/Logs.tsx`, `Debug.tsx`, `debug-log-viewer.tsx`, `debug-settings-panel.tsx` |
| Usage | `usage.*` | `pages/Usage.tsx` |
| Storage | `storage.*` | `pages/Storage.tsx` |
| API | `api.*` | `pages/ApiKeys.tsx`, `api-keys-panels.tsx` |
| Claude | `claude.*`, `claudeDesktop.*` | `pages/Claude.tsx`, `ClaudeCode.tsx`, `ClaudeDesktop.tsx`, `claude-code-sections.tsx` |
| Grok | `grok.*` | `pages/Grok.tsx`, `grok-groups.ts` |
| Startup | `startup.*` | `pages/Startup.tsx`, `startup-sections.tsx`, `startup-health-ui.ts` |

Shell and token work is grounded in files that *were* read: `App.tsx` (nav array,
theme effect, drawer behaviour, Claude toggle), `styles.css` (every token value),
`foundations.md` (the documented scales), `provider-icons.ts` (brand marks and the
`PROVIDER_DISPLAY_NAMES` casing used in the Providers header), `icons.tsx` (the icon inventory the
Material Symbols names map onto) and `ui.tsx` (Switch, Select, Notice, EmptyState,
Tooltip — the primitives the M3 components replace).

## 4. Global-instruction requirements and where they landed

1. **M3 Expressive conformance** — token engine + component anatomy above; no
   legacy chrome left (pill buttons, hairline cards, glass rail all replaced).
2. **Appearance controls** — Appearance screen: theme, density 1–5, infinite seed
   picker (`<input type="color">` + hex field + 8 curated swatches), font family
   from bundled faces with CJK-safe fallback, size scale, weight, live preview.
3. **Per-element appearance editors** — same screen: target chips (nav rail, tab
   strip, app bar, cards, tables, buttons) writing `--el-<target>-*` vars, stored
   per element, individually resettable. Extend `elementTargets` in `ocx-data.js`
   as more surfaces get vars.
4. **Language modes + funny sliders** — Language & voice screen. `makeI18n()` in
   `ocx-i18n.js` is the port target for `i18n/provider.tsx`: keys hold either one
   string or a 5-entry array (levels 1–5), per language. Facts are identical at
   every level; only voice changes. The ladder preview shows the same destructive
   warning at all five levels so the rule is visible, not just claimed.
5. **TTS narrator** — off by default, serialized single-utterance queue that
   supersedes rather than stacks, language selectable, follows the funny level.
6. **Dim sum surprise** — one 10% draw per launch, non-blocking card, auto-dismiss,
   never on first run / error / update, and **no off switch**: it cannot be opted
   out of, which is exactly why the politeness rules above are mandatory rather
   than nice-to-have. Ships with a labelled image placeholder: **drop real bundled
   dish photos in before shipping** (no network fetch, alt text names the dish).
7. **Non-blocking notifications** — snackbars bottom-left, stack, errors persist,
   optional action (Undo / View details), plus a notification centre and the
   Notifications screen for history.
8. **Regex builder** — its own screen: guided token palette, raw pattern editor,
   flags, sample text, live matches, named capture groups, copy/export, presets,
   "use in search" hand-off. Engine named exactly (ECMAScript RegExp, evaluated
   locally). Safety: 400-char pattern cap, 20 000-char sample cap, 200-match cap,
   zero-width advance. Every search bar and every settings surface has the `.*`
   opt-in toggle and a builder shortcut; plain text stays the default.
9. **Settings search on every settings surface** — `settingsSearch()` indexes
   `settingsIndex` in `ocx-data.js` and reports cross-tab hits by name. Replace
   that array with a generated index over the real settings components.
10. **Changelog viewer** — every released version, date filter (typed ISO +
    native picker + presets, invalid input reported inline without discarding
    text), regex-capable text search that composes with the date filter, copy and
    Markdown export stating the exported range.
11. **Version history** — append-only revisions across providers, accounts, keys,
    combos **and settings**; restore is recorded as a new revision (the dialog
    says so), so an undo can be undone.

## 5. Accessibility contract to keep

Roving `tabIndex` on the tab strip with Arrow/Home/End and Delete-to-close;
`role="switch"` + `aria-checked` on every toggle; `role="progressbar"` with
`aria-valuenow` on quota bars; 44 px minimum hit targets (sliders are 44 px tall);
visible 3 px focus ring on `:focus-visible`; `prefers-reduced-motion` collapses
all transitions; `aria-live="polite"` snackbar host; every icon `aria-hidden`
with a text label beside it or an `aria-label` on its control.

## 6. Known gaps before this is production code

- Data is mocked. Wire each screen to the existing hooks (`use-dashboard-data.ts`,
  `use-providers-fetch.ts`, `useCodexAccountPool.ts`, …) unchanged — the shapes in
  `ocx-data.js` were written to match them.
- Fonts load from Google Fonts here. The dashboard must open offline, so bundle
  Roboto Flex, Roboto Mono, Noto Sans HK and Material Symbols Rounded locally
  (`docs/design-system/foundations.md` forbids CDN fonts) before shipping.
- Dim sum images are placeholders.
- Cantonese strings cover this prototype's surface only; the remaining ~1 200
  `en.ts` keys still need `yue` entries and funny-level arrays for sentence-level
  copy.
