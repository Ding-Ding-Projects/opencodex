# Side-by-side audit — pages the prototype never covered

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
