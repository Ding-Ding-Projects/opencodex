# Side-by-side audit: design prototype vs shipped app

Nineteen composites, one per screen, at `assets/design-shots/side-by-side/<name>.png`. Each places
`assets/design-shots/<name>.png` (design intent, mock data, `en` locale) on the left and
`assets/shots/<name>.png` (shipped app, seeded data, `bi` bilingual locale) on the right, both at
their real captured size (2880×1800 physical pixels, 1440×900 CSS pixels), labelled and divided.

This is a read-only visual review. No source was changed to produce it.

## How to read this document

- **DEFECT** — the app is worse than the design and a user would notice. Ranked by user impact.
- **DIVERGENCE** — deliberate, and the repository already records why.
- **STALE PROTOTYPE** — the app moved on; the design mockup was never updated to match.
- **ARTIFACT** — an accident of how these two specific screenshot sets were produced (different
  locale, different mock data, different capture rig), not a real difference between the products.

Counts: **5 DEFECT · 4 DIVERGENCE · 11 STALE PROTOTYPE · 6 ARTIFACT** (across 26 distinct findings;
four of the ARTIFACT entries are global and touch all 19 screens rather than one each).

---

## Read this before any per-screen finding below

Four things are true of *every* screen in this comparison and explain the majority of what looks
different at first glance. Getting these wrong would silently promote harmless capture noise into
false defects, so they are stated once, up front, rather than repeated 19 times.

### ARTIFACT — bilingual vs. English capture locale (all 19 screens)

The app's own capture harness deliberately seeds `localStorage["ocx-lang"] = "bi"` before every
shot — `scripts/capture-shots.ts:581`, with its own doc comment explaining why: *"the shots are the
project's own evidence that the three language modes are real… It is also the harshest layout case
in the app: every label carries `English · 廣東話`, so a row that clips or a button that overflows
shows up here first."* The design prototype's capture rig (`scripts/design-capture-shots.ts`)
applies no such override and simply runs in the prototype's default `en` locale.

Consequently almost every nav-rail item, card title, button and section header in the shipped shots
carries a `· 廣東話` suffix the design shots do not, cards run visibly taller, and more scrolling is
needed to reach the same content. This alone explains the large majority of "the app looks denser /
more crowded" impressions below. It is not a defect — it is the intended stress case for the
bilingual-mode requirement — and where the bilingual text genuinely fit without clipping (verified
directly: sampling the shipped `dashboard.png` at full resolution, the nav rail's actual
surface-container boundary sits at physical x≈580, and "Codex Auth · Codex 登入" renders completely
inside it), it is evidence the requirement is being met, not violated.

### ARTIFACT — design capture has no window chrome (all 19 screens)

`design/shell/main.mjs:106-111` deliberately opens a bare content window ("No chrome of any kind
beyond the OS's own default window frame… the harness photographs only the client area"), so every
design shot's top row is the prototype's own `<header data-screen-label="Top app bar">` — page title
+ online status + a small icon row. The shipped app is a **frameless** desktop window
(`m3-port-handoff.md` item 8: *"Custom Material 3 window controls (no native title bar or overlay)"*)
whose real top bar is `gui/src/shell/WindowControls.tsx` / `AppBar.tsx`: product name, version, port,
a live cost-meter chip, the icon row, and the OS minimize/maximize/close controls the frameless
window has to draw itself. Every screen's design/shipped pair therefore differs in that top strip by
construction — see DIVERGENCE below, it is recorded, not a gap.

### ARTIFACT — mock data volume and shape (all 19 screens)

Per the task brief: different provider names, request counts, storage sizes (design: `17.15 GiB` /
`41,882 files`; shipped: `1.1 MB` / `2 files`, because the shipped capture ran against a throwaway
test `CODEX_HOME` fixture), usage totals (`9,148` vs `22` requests), changelog entries, log rows,
etc. are content, not layout, and are not treated as defects anywhere below.

### ARTIFACT — Material Symbols Rounded icon glyphs are not comparable (all 19 screens)

Confirmed in the capture worker's own report and re-confirmed here: the design renders icons as
ligatures of the network-loaded "Material Symbols Rounded" font; the shipped app never loads that
font at all and renders the same glyph geometry as hand-authored SVGs
(`gui/src/icons.tsx`). Icon **shape** is therefore excluded from this comparison; icon **placement,
size, colour role and alignment** are still compared normally.

---

## DEFECT (ranked by user impact)

### 1. Providers — the design's primary diagnostic action does not exist anywhere in the shipped app

- **Screen:** Providers
- **Design shows:** a "Test connection" button sitting directly beside "Remove" in the provider
  detail panel — the second most prominent action on the screen after the tab strip itself.
- **App shows:** no such control anywhere. `gui/src/components/provider-workspace/ProviderOverview.tsx`
  (the shipped equivalent of that detail panel — see its own header comment, *"2-column layout: left
  (CONNECTION + Auth summary) / right (STATS + Notes)"*) has no test-connection button, and a search
  of every `.tsx` file under `gui/src/components/provider-workspace/` for a click handler that tests
  a connection returns nothing. The string exists — `gui/src/i18n/en.ts:998`,
  `"pws.testConnection": "Test connection"`, translated into all seven shipped locales — but nothing
  in the tree ever renders it as a control.
- **Fix:** wire a button in `ProviderOverview.tsx` to whatever server route validates a provider's
  reachability (mirrored on the CLI as `ocx provider test`), rendering `t("pws.testConnection")`.
- **Why it ranks first:** this is the single most useful piece of feedback on the screen where a
  misconfigured provider is diagnosed, and today the only route to it is leaving the app for a
  terminal.

### 2. Codex Auth — the account-pool rotation-strategy card is still pre-M3 markup

- **Screen:** Codex Auth (below the fold of the captured viewport; confirmed directly in source)
- **Design shows:** every card on every screen uses the same M3 tonal-surface card component —
  rounded corners, `--m3-surface-container` background, consistent border and elevation.
- **App shows:** `gui/src/components/CodexPoolStrategySetting.tsx:104` opens
  `<div className="card" style={{ marginTop: 16 }} …>` and its subtitle at line 106 uses
  `className="card-sub"` — both classes live only in the legacy `gui/src/styles.css`, not in
  `gui/src/styles/m3-shell.css`. This card is mounted from `CodexAccountPool.tsx`, which renders on
  the Codex Auth screen directly below the account-pool list visible in
  `assets/design-shots/side-by-side/codex-auth.png`.
- **Fix:** replace `className="card"` / `"card-sub"` with the `m3-card` / `m3-card__sub` vocabulary
  every sibling card already uses.
- **Why it ranks here:** it is the one card on a heavily-used screen that visibly reads as a
  different product — different surface tone, border and radius — immediately below cards that are
  correctly M3, and it is unreachable by the per-element appearance editor and density tokens because
  it isn't wired into that system at all.

### 3. A hard-coded `#c44` red bypasses the theme, dark mode and the user's seed colour

- **Screens:** Codex Auth (rotation-strategy error text) and Dashboard (Memory & observability card)
- **Design shows:** every error/danger state in the mockup uses the M3 error role consistently — the
  same tonal red used for the "Needs attention" chip on Providers, the reauth banner on Codex Auth,
  etc. — so it always follows the active theme and seed colour.
- **App shows:** two sites, both written the same way —
  `gui/src/components/CodexPoolStrategySetting.tsx:147`:
  `style={{ marginTop: 8, color: "var(--danger, #c44)" }}`, and
  `gui/src/components/MemoryObservabilityCard.tsx:417`: `style={{ color: "var(--danger, #c44)" }}`.
  `--danger` is not defined anywhere in `gui/` or `shared/`, so the fallback is not a fallback: `#c44`
  is unconditionally what renders, in both light and dark mode, whatever seed colour is chosen.
- **Fix:** replace both with `var(--m3-error)`.
- **Why it ranks here:** it is the only red text in the app that a theme change, a dark-mode toggle or
  a custom seed colour cannot move, and depending on the active surface it can land as a genuine
  low-contrast pairing — exactly the class of defect the Material Design conformance rule exists to
  catch.

### 4. Notifications — the bell popover drops tone and timestamp the design specifies

- **Screen:** Notifications (the app-bar bell dropdown, not the full Notifications page — the full
  page, captured in `notifications.png`, does carry a tone icon and timestamp correctly)
- **Design shows** (`design/OpenCodex M3.dc.html:1805-1811`): each entry in the popover renders a
  36px tone-coloured icon circle (`n.chipBg`/`n.chipFg`/Material Symbol per tone), a title, a body,
  and a monospace `{{ n.when }}` · `{{ n.surface }}` row underneath — when it happened and which
  screen produced it.
- **App shows** (`gui/src/shell/AppBar.tsx:162-167`):
  ```tsx
  {history.slice(0, 8).map(n => (
    <div key={n.id} className="m3-menu-item" …>
      <div style={{ fontWeight: 500 }}>{n.title}</div>
      {n.body && <div …>{n.body}</div>}
    </div>
  ))}
  ```
  — title and optional body only. No icon, no tone, no timestamp, no source screen.
- **Fix:** carry the same tone-icon + timestamp treatment the full Notifications page and the
  snackbar host already use into this popover's row markup.
- **Why it ranks here:** it is the one surface a user opens *specifically because* the bell shows a
  badge, and today a persistent error and a routine success render identically there, with no way to
  tell whether an entry is from a minute ago or yesterday's session.

### 5. Subagents — the Save action carries no dirty-state indicator

- **Screen:** Subagents
- **Design shows:** a numbered Featured list with reorder/remove controls; no explicit Save button is
  needed because the mockup implies changes apply immediately.
- **App shows:** a real `Save · 儲存` button (visible, green-filled, top-right of the Featured card in
  `assets/design-shots/side-by-side/subagents.png`), which is a reasonable, deliberate improvement
  over implicit autosave — **but** `gui/src/pages/Subagents.tsx` tracks `persisted.current` (line
  137) purely as a snapshot to diff against on save; nothing in the file compares the live draft to
  it to decide whether the button should read as enabled/dirty or grey/clean, and there is no
  navigation leave-guard. A user can reorder or drop a featured model, believe the change is applied
  because the row visibly moved, then navigate away and lose it silently.
- **Fix:** derive an `isDirty` flag from a shallow comparison against `persisted.current`, reflect it
  on the Save button's state, and gate navigation on it the way the app already gates other unsaved
  work.
- **Why it ranks last of the five:** real but narrower in scope than the others — it costs a user
  data only when they reorder and then leave without noticing, rather than being wrong on every
  visit to the screen.

---

## DIVERGENCE (deliberate, and recorded)

- **Custom frameless title bar replacing the design's plain "Top app bar."** Every screen. Recorded
  in `docs/design-system/m3-port-handoff.md` item 8: *"Custom Material 3 window controls (no native
  title bar or overlay)."* The design prototype never modelled window chrome at all (see the global
  ARTIFACT note above); the shipped app is a real frameless Windows desktop app and has to draw its
  own minimize/maximize/close plus product identity, version, port and a live cost meter. Not a gap —
  a necessary consequence of being a real installed app rather than a static mockup.
- **Icons are hand-authored SVGs, not a ligature icon font.** Every screen. Recorded in
  `gui/src/icons.tsx`'s header comment (per the capture worker's own report) as a deliberate choice
  generated from the same glyph geometry, so the app never has to fetch or bundle Material Symbols.
- **Noto Sans HK's CJK glyph coverage is deliberately not bundled.** Language & voice and every
  Cantonese/bilingual label. Recorded in `ROADMAP.md` under *Appearance*: bundling three weights would
  add ~20 MB to every install, duplicating a face Windows and macOS already ship; the font stack
  names Noto Sans HK first and falls through to the OS's own Chinese face. The prototype, by
  contrast, fetches the real webfont over the network, which is why its Cantonese sometimes renders in
  a visibly different weight/shape from the shipped app's OS fallback — expected, and explicitly
  chosen, not a bug.
- **Only errors and warnings persist; success/info snackbars auto-dismiss.** Not visible in these
  static captures (no snackbar was on screen at shutter time on any of the 19 shots), but recorded in
  `m3-port-handoff.md`'s *Seams worth knowing* section as `notice.tone !== "error"` deciding
  persistence on `main` — a considered choice, not an oversight, even though the note there also
  flags an uncommitted branch that would widen it to `["warn", "error"]`.

---

## STALE PROTOTYPE (the app moved on, the mockup didn't)

- **Providers, Models, Combos and Version history all replaced the design's single flowing column
  (list, then an inline detail/edit panel beneath the selected row) with a two-pane rail-and-detail
  workspace** — `ProviderRail.tsx` + `ProviderWorkspaceShell.tsx` on Providers, the equivalent
  provider-filter rail on Models, a combo rail + "How it works" panel on Combos, and a
  revision-list-left/diff-right split on Version history. This is applied consistently across all
  four screens with matching visual language (same rail width, same card treatment), so it reads as a
  single deliberate architectural decision made sometime after the design was drawn, not four
  independent slips — but it is **not written down anywhere** in `m3-port-handoff.md`, `ROADMAP.md`
  or `components.md`, so per this audit's own rule it cannot be counted as a recorded DIVERGENCE. It
  is very plausibly a real improvement for screens that manage many items, but it changes what "the
  Providers screen" *is* enough that it deserves its own line in the design-system docs rather than
  being inferred from four screens' worth of screenshots. Recommended: add a short section to
  `m3-port-handoff.md` naming the rail-and-detail pattern and which screens use it.
- **Providers gained a whole "overview" landing state** (Ready/Needs attention/Disabled stat chips +
  "Recently used" list) that renders by default before any provider is selected
  (`workspaceSelected` starts `null` in `gui/src/pages/Providers.tsx:36`, which
  `ProviderWorkspaceShell` resolves to `ProviderOverviewDashboard`). The design has no equivalent —
  its capture always opens with a provider already selected.
- **API gained an entire "OpenAI-compatible client profile" section** (GitHub Copilot Desktop
  integration-key generation, an "OpenAI Direct is excluded" notice) rendered above the Endpoints
  list the design shows at the top of the page. A genuinely new feature that pushes the design's
  "Active keys" section further down the page than it used to be.
- **Grok gained a "Grok Build is not wired up" diagnostic banner** with a live file path to the
  managed config block — not present in the design at all.
- **Appearance gained "App logo" and "App name" rows** — the mandatory app-logo-customization and
  app-rename features this project's own conventions require, added after the design was drawn.
- **Language & voice gained the whole School Mode card**, and the language-mode picker grew from the
  design's 3 buttons (English / Cantonese / Bilingual) to 8 (adding German, Korean, Chinese, Russian,
  Japanese).
- **Notifications gained a tone-filter chip row (All/Errors/Warnings/Successes/Info) and its own
  search bar**, matching `ROADMAP.md`'s "Notifications | full history, tone filter" entry — a
  landed feature the design predates.
- **Changelog gained a "Last 7 days" preset and a "Clear dates" button** beyond the design's four
  presets.
- **Startup moved from one combined "Install" button covering all three protection rows to a
  per-row Install button**, matching each row's own independent installed/not-installed state — more
  useful than the design's single button given the rows can be in different states.
- **Logs & Debug gained a whole "where your logs live" info card** (file path, size, rotation policy,
  a Clear logs action) above the request table — the design has no equivalent card at all.
- **Storage's bucket table gained a "Newest" column** beside the design's single date column.

---

## ARTIFACT (screen-specific, beyond the four global ones above)

- **Logs & Debug: the header stat says "22 request rows" while the request table renders the empty
  state "No requests yet."** These come from two different data sources —
  `gui/src/pages/Logs.tsx:674` derives the stat line from `footprint.requestRows` (an on-disk log-file
  stat), while the table's empty/populated state at `gui/src/pages/Logs.tsx:1102` is driven by a
  separately-fetched `logs` array. In real use these stay in sync because the same running proxy
  produces both continuously; in the capture, the log **file** on disk apparently retained rows from
  a prior run while the **live in-memory request list** the table reads did not carry them forward
  across whatever restart happened between seeding and the screenshot. Flagged rather than silently
  discounted because it is the one place the shipped app's own numbers visibly disagree with each
  other in a screenshot meant to represent real usage — worth a quick sanity check that this can't
  happen from an ordinary app restart, even though it reads as a capture/seed timing issue rather
  than a shipped defect.
- **Regex builder and Logs & Debug preset chips carry different names between the two sets**
  (design: "Model id / Request id / Base URL host / Rollout file"; shipped: "Response id / 4xx/5xx
  status / vendor/model / API key shape"). Content curation, not a layout or component difference —
  the chip component, spacing and typography are otherwise pixel-equivalent between the two.

---

## Composites

19 of 19 pairs built, one PNG each, in `assets/design-shots/side-by-side/`: `api.png`,
`appearance.png`, `changelog.png`, `claude.png`, `codex-auth.png`, `combos.png`, `dashboard.png`,
`grok.png`, `history.png`, `language.png`, `logs.png`, `models.png`, `notifications.png`,
`providers.png`, `regex.png`, `startup.png`, `storage.png`, `subagents.png`, `usage.png`. Each is a
single 1956×684 image: the two source screenshots scaled to a 960px-wide panel apiece, side by side,
labelled "DESIGN (prototype, mock data)" / "SHIPPED (app, seeded data)", divided by a vertical rule.

---

# Part two — the nine pages the prototype never covered

Everything above compares the nineteen screens that exist in **both** the prototype and the app.
Nine shipped pages have no prototype counterpart at all — `schedule`, `network`, `settings`,
`terminal`, `mobile`, `docs`, `locks`, `authenticator`, `pdf` — so they were never comparable to
anything, and are exactly where the drift patterns found above would hide unnoticed. They were
swept separately against the shared component library instead; that record follows.

This is also the largest single reason the app can *feel* unlike its design while being correct:
the implementation grew from 19 pages to 28 and the prototype was never updated, so a third of the
product has nothing to be found consistent with.

`docs/design-system/m3-port-handoff.md` and `ROADMAP.md`'s *Design parity with `design/`* section
record three waves of per-screen comparison against `design/OpenCodex M3.dc.html`, closing 378
differences across the prototype's **19 screens**, plus a further 2026-08-13 survey of the same 19.

Nine shipped pages were never part of any of that, for the simple reason that they have no
prototype counterpart to compare against — `design/OpenCodex M3.dc.html` contains zero matches for
any of their page ids. They were built after the prototype, or for surfaces (a phone remote, an
embedded terminal, an offline docs browser) the prototype never modelled. That made them exactly
where the same drift the 19-screen waves closed could sit unnoticed, since nothing had ever looked.

This file is that missing pass. It does not re-survey the 19; see the files above for those.

## Scope

| Page id | File | Lines |
| --- | --- | --- |
| `schedule` | `gui/src/pages/ScheduledSettings.tsx` | 473 |
| `network` | `gui/src/pages/Network.tsx` | 776 |
| `settings` | `gui/src/pages/Settings.tsx` | 784 |
| `terminal` | `gui/src/pages/Terminal.tsx` | 219 |
| `mobile` | `gui/src/pages/Mobile.tsx` | 810 |
| `docs` | `gui/src/pages/Docs.tsx` | 213 |
| `locks` | `gui/src/pages/Locks.tsx` | 291 |
| `authenticator` | `gui/src/pages/Authenticator.tsx` | 340 |
| `pdf` | `gui/src/pages/PdfTools.tsx` | 554 |

All nine are wired into `gui/src/app-routing.ts`, `gui/src/shell/page-meta.ts` and `gui/src/App.tsx`.

## What was checked

1. **Hand-rolled status pills.** The canonical shape is the prototype's `badgeStyle(tone)`
   (`design/OpenCodex M3.dc.html:2330-2339`) — five tones, pill-shaped, backed by the `--m3-*`
   container/on-container role pairs. `gui/src/components/codex-account-pool-m3.ts`'s `CHIP_TONES`
   is the closest existing GUI-side echo of it. A shared `Badge` component is being promoted into
   `gui/src/shell/m3-ui.tsx` by a sibling lane, in flight as of this audit — **it does not exist in
   the tree yet** (checked: no `Badge` export anywhere under `gui/src`, only an unrelated i18n
   string `"tabs.styleBadge"`). Any call site written against it in this pass would fail to compile
   until that lane lands.
2. **Hand-rolled empty states.** The canonical shape is `Empty` (`gui/src/shell/m3-ui.tsx:151-158`),
   a padded, centred, titled block. The same sibling lane is adding an optional `icon` prop to it.
3. Beyond the two known patterns, this pass also checked, on all nine, since nobody had:
   every list/table/panel for an empty state that says something useful; every interactive element
   for a visible focus state and a keyboard path; every overlay for painting its own surface,
   staying viewport-bounded, and scrolling internally instead of clipping — this repository has
   shipped both a transparent overlay and a height-capped one that silently deleted its own content
   (see `docs/design-system/mobile-shell.md`'s "Anchored panels" section for the fix to the first
   case); and whether each page reaches for the shared component library or hand-rolls buttons,
   cards and fields inline.

## Per-page verdict

| Page | Badge drift | Empty-state drift | Other findings |
| --- | --- | --- | --- |
| `ScheduledSettings.tsx` | none | none (already uses `Empty`) | hand-rolled a `role="radiogroup"` pair that is byte-for-byte the shared `Segmented` component's own markup — **fixed**, now imports and uses `Segmented` |
| `Network.tsx` | none | none (uses `Empty` for both the truly-empty and no-search-match history states, matching the sibling pattern in `Locks.tsx`) | clean |
| `Settings.tsx` | none | none | clean — already uses `Segmented` and `Empty` |
| `Terminal.tsx` | none | none | clean — its scrolling transcript (`.m3-term-out`) is a good example of the height-capped-but-`overflow:auto` pattern done correctly |
| `Mobile.tsx` | plain `--m3-ok`/`--m3-error` text colouring (`.m3-mob__ok`/`.m3-mob__bad`), not a pill/tone-map — reviewed, not drift; see note below | its loading/error/empty hint text (`.m3-mob__hint`) is a distinct, lighter pattern from `Empty` — reviewed, not converted; see note below | imports nothing from `shell/m3-ui.tsx` at all — a deliberate, documented, separate design language for the full-bleed phone surface (see the page's own header comment and `docs/design-system/mobile-shell.md`); its regex-builder popover row is explicitly engineered against the exact clipping bug this audit was told to watch for (`.m3-mob__search`'s own comment: "No `overflow` of any kind... a clipping ancestor would cut it off at the first line") |
| `Docs.tsx` | none | none (uses `Empty` for no-search-results, an unresolved internal link, and the initial no-article-selected state) | its two-pane layout's scrolling nav (`.m3-docs-nav`) uses `overflow-y: auto` with a bounded `max-height`, not `overflow: hidden` — correctly avoids the clipping failure mode |
| `Locks.tsx` | none | none | clean; its anchored `LockWizard`/`UnlockPrompt` (shared, not page-local) already clamp to the viewport and scroll internally |
| `Authenticator.tsx` | none | none | hand-rolled `<input className="m3-input">` for its search field instead of the shared `TextInput` — **fixed**, now uses `TextInput` (the export button stays a raw `<button>` deliberately, per its own comment: `Button` does not forward a ref, and this one anchors an export gate and returns focus) |
| `PdfTools.tsx` | none | one branch used a plain `<p role="status">` for "no history entries match this search" where its own sibling branch two lines above already used `Empty` for "no history entries at all" — **fixed**, now `Empty` in both | its own `.m3-pdf-history-*` / `.m3-pdf-capabilities` classes were referenced in the JSX and **never defined anywhere in `gui/src/styles/*.css`** — the recent-operations list was rendering as a bare bulleted list with no row layout and no way to tell a failed operation from a finished one short of reading its detail sentence. **Fixed**: added the missing rules to `gui/src/styles/m3-shell.css`, modelled on the already-correct `.m3-history-*` pattern `Network.tsx` uses for its own history list |

Nine pages, three genuine drift findings, all small enough to fix in place — nothing here was large
enough to warrant its own lane.

## Notes on what was reviewed and deliberately left alone

- **`Mobile.tsx`'s separate design language.** The page's own header comment states the reasoning:
  "A phone is not a small desktop... this is its own full-bleed surface... rather than the admin UI
  squeezed into 390px." Its `.m3-mob__ok`/`.m3-mob__bad` status colouring is plain text colour, the
  same pattern `Network.tsx` and `Settings.tsx` already use elsewhere (`style={{ color: "var(--m3-error)"
  }}`) — not a duplicated tone-to-colour *map*, which is the specific thing pattern 1 above is about.
  Its `.m3-mob__hint` is a single-line, unpadded status line used uniformly for loading, error and
  empty states alike; `Empty` is a padded, card-styled, titled block designed for the desktop card
  layout. Converting the hint text to `Empty` would fight the page's own documented compact-surface
  intent rather than fix drift. Left as-is.
- **`PdfTools.tsx`'s history search omits the standalone `.*` toggle chip** that `Network.tsx`,
  `Settings.tsx`, `Docs.tsx` and `Locks.tsx` all render next to their search field. It uses the
  shared `SearchField` composite (`gui/src/shell/RegexBuilderButton.tsx`) instead, whose own doc
  comment frames it as "a convenience only" for a simpler search bar; the regex-mode toggle is still
  reachable from inside the builder popover it opens. Not a duplicated implementation, and not
  broken — a minor consistency gap, not fixed here.

## Left for the sibling `Badge` lane

No hand-rolled tone-to-colour map was found on any of the nine pages, so nothing here is blocked on
`Badge` landing in `gui/src/shell/m3-ui.tsx`. If a future pass finds one, the call site should import
`Badge` from `"../shell/m3-ui"` directly — do not create a second badge component.

## Verification

```bash
cd gui && bun install --frozen-lockfile   # node_modules was empty in this worktree
bun x tsc -b --force                      # gui's own project-reference build, clean
bun test tests/authenticator-page.test.tsx tests/m3-dialog.test.tsx tests/mobile-shell.test.tsx
bun test tests/scheduling-generation-guard.test.tsx tests/scheduling-match.test.ts tests/scheduling-schema.test.ts
bun x eslint src/pages/ScheduledSettings.tsx src/pages/Authenticator.tsx src/pages/PdfTools.tsx
```

`ScheduledSettings.tsx` carries one pre-existing, unrelated `react-hooks/set-state-in-effect` lint
error at line 156 (a `setState` called synchronously in an effect body) — present before this pass
(verified against the pre-edit file with `git stash`) and outside this audit's scope.

## Related

- [`m3-port-handoff.md`](m3-port-handoff.md) — the 19-screen port record this file extends
- [`mobile-shell.md`](mobile-shell.md) — the phone surface's own design rationale
- [Components](components.md) — the shared component inventory
