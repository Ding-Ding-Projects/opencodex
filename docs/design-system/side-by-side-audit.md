# Side-by-side audit: M3 prototype vs shipped app

This tracks defects found by capturing the Material 3 design prototype
(`design/OpenCodex M3.dc.html`) and comparing it side by side against the
built app, screen by screen.

> **Note on this file's history:** the implementation lane for defects 1-4
> below (branch `feat/b9-sbs`) was told this document had "just [been]
> created by the audit lane" and to read it before editing. It did not exist
> yet in this worktree when that lane started — worktrees for concurrent
> lanes are independent checkouts, and the audit lane's commit had not been
> integrated here. Rather than block on that, this lane created the file
> fresh with the four defects its own brief described in full, closed as
> that work landed, and left a placeholder row for the fifth item the audit
> is known to cover. Whoever integrates the sibling lanes should reconcile
> this file with the audit lane's own copy rather than take either as the
> sole source of truth.

## Defects

| # | Area | Summary | Status |
|---|------|---------|--------|
| 1 | `gui/src/pages/Subagents.tsx` | Featured-model editor had no dirty tracking and no unsaved-work protection; a reorder or removal could be lost with no prompt. | **Closed** |
| 2 | `gui/src/components/CodexPoolStrategySetting.tsx`, `gui/src/components/MemoryObservabilityCard.tsx` | Both hard-coded `color: "var(--danger, #c44)"`; `--danger` is never defined anywhere in the tree, so the muddy `#c44` fallback applied unconditionally, ignoring theme/seed/appearance settings. | **Closed** |
| 3 | `gui/src/components/CodexPoolStrategySetting.tsx` | Card used legacy `className="card"` / `"card-sub"` (styled only in `gui/src/styles.css`), rendering in the pre-M3 visual language while every card around it had already ported. | **Closed** |
| 4 | `gui/src/shell/AppBar.tsx` (notification bell popover) | Design specifies a tone icon, timestamp and source screen per entry (`design/OpenCodex M3.dc.html:1805-1811`); the popover rendered only title and body. | **Closed** |
| 5 | *(owned by a sibling lane — not detailed in this branch)* | Recorded by the audit as a fifth defect; this lane's brief covered only 1-4 above. | Not tracked here |

## Defect 1 — Subagents featured-slot editor had no dirty tracking

**Evidence:** `gui/src/pages/Subagents.tsx:137` captured `persisted.current`
(now `persisted` state) after every load/save but never compared it against
`chosen`, so the Save button carried no dirty state at all — it looked and
behaved identically whether there was something to save or not. Nothing
protected a reorder or removal from being silently discarded by a window
close or reload.

**Fix:**
- Added a `dirty` value: `JSON.stringify(chosen) !== JSON.stringify(persisted)` — order-sensitive, since a pure reorder is itself a saved change (it sets positions 1-5 in the Codex model picker).
- Save button is now `disabled={busy || !dirty}`, matching the existing dirty-gated Save convention already used elsewhere in the app (`ClaudeDesktop.tsx`, `Grok.tsx`, `combo-workspace-detail-panel.tsx`).
- Added a textual indicator beside the `{chosen.length}/5` counter: "Unsaved changes" / "Featured slots are up to date" (`sub.unsaved` / `sub.upToDate`, in `m3.ts` + `yue.ts`).
- Added a `beforeunload` guard scoped to this page's own `dirty` flag, reusing the exact pattern already established in `gui/src/settings-drafts.tsx` for the global settings draft — the only other "protect navigation away from unsaved changes" mechanism in the codebase.
- Converted the `persisted` ref to `useState`, since `dirty` reads it during render and a ref read outside an effect/handler is the stale-read hazard the `react-hooks/refs` lint rule flags (this also kept the diff lint-clean against the project's existing, largely-unrelated lint debt).

**Tests:** `gui/tests/subagents-unsaved-guard.test.tsx` (new — proven red against the pre-fix component, then green), plus the pre-existing `gui/tests/subagents-busy-race.test.tsx` updated for the new dirty-gated Save semantics.

## Defect 2 — hard-coded `--danger` fallback red

**Evidence:** `--danger` is defined zero times in the stylesheet tree (verified with a repo-wide search); `CodexPoolStrategySetting.tsx:147` and `MemoryObservabilityCard.tsx:417` both wrote `color: "var(--danger, #c44)"`, so the `#c44` fallback applied unconditionally regardless of theme, seed colour, or any appearance setting.

**Fix:** replaced both with `var(--m3-error)`, the design system's real error role (already used elsewhere in the same files' vicinity, e.g. `Subagents.tsx`'s remove button). No new token was introduced. Class names ending `--danger` (`m3-btn--danger`, `cwi-icon-btn--danger`, `m3-md-aside--danger`) were left untouched — those are unrelated, real, defined classes.

**Tests:** existing `gui/tests/account-pool-strategy.test.tsx` and `gui/tests/memory-observability-card.test.tsx` re-run clean; neither asserted on the literal colour value.

## Defect 3 — CodexPoolStrategySetting pre-M3 markup

**Evidence:** `CodexPoolStrategySetting.tsx:104,106` used `className="card"` / `"card-sub"`, defined only in the legacy `gui/src/styles.css`, not in the M3 stylesheet.

**Fix:** ported to the same M3 classes the neighbouring, already-ported `CodexAutoSwitchSetting.tsx` card uses — `m3-card` on the container, `m3-card-title` on the heading, `card-sub m3-card-sub` on the description text (matching that sibling's exact dual-class treatment rather than inventing a new one).

**Tests:** `gui/tests/account-pool-strategy.test.tsx` re-run clean.

## Defect 4 — notification bell popover missing tone/timestamp/source

**Evidence:** design (`design/OpenCodex M3.dc.html:1805-1811`) shows each notification-centre entry with a tone icon chip, `{{ n.when }}` and `{{ n.surface }}`; `AppBar.tsx:162-167` rendered only `n.title` and `n.body`.

**Fix:**
- `Notice` (`gui/src/shell/notifications-context.ts`) gained an optional `source?: Page` field, serialized/read with the rest of history and sanitized against `VALID_PAGES` on read so corrupt or retired-route history can never reach `PAGE_META_BY_ID` with a bad key.
- New `gui/src/shell/notification-source.ts`: a tiny module-scope mirror of "the page currently in front", written by `App.tsx`'s tab-router effect on every active-page change. `NotificationsProvider` sits *above* the tab router in the provider tree, so it has no other way to know which screen a `notify()` call came from without threading a `source` argument through every call site in the app.
- `notify()` (`gui/src/shell/notifications.tsx`) auto-stamps new notices with the current source page unless a caller already supplied one.
- `AppBar.tsx`'s popover now renders a tone icon chip (`role="img"` + localized tone name — the popover has no room for the full text row `pages/Notifications.tsx` uses per A11Y-TONE-01, so the icon itself carries the accessible name), a `<time>` element, and the source page's localized label via `PAGE_META_BY_ID`.

**Tests:** `gui/tests/appbar-notification-popover.test.tsx` (new — mounts the real `App` on the Subagents tab, lets its real failed load raise a real notice, and asserts all three fields render; proven red against the pre-fix `AppBar.tsx`, then green).
