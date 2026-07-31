# The phone surface

The dashboard has one shell. On a narrow, touch-driven viewport it changes its
**layout**, never its components — there is no second implementation of the tab
strip, the menus, the searches or the appearance editors, because two surfaces
that render the same thing twice start disagreeing about it the first time
either is edited.

## What changed, and why `#/mobile` is no longer special

`App.tsx` used to short-circuit before the shell rendered:

```tsx
if (page === "mobile") return <MobileRemote apiBase={API_BASE} />;
```

The reasoning in the comment was that a nav rail and a tab strip are the wrong
furniture for a thumb. What it actually produced was a dead end: a phone could
reach the chat, the session list and an API-key field, and **none** of the other
twenty-one routes — no settings, no appearance, no logs, no changelog.

The remote is now a route like any other (`case "mobile"` in `renderPage`), and
the shell adapts instead. `windowClass === "compact"` already swapped the rail
for a modal drawer and added a bottom bar; the work was making the strip, the
menus and the anchored panels actually hold up at 320px.

## The two invariants

1. **The body never scrolls horizontally.** Wide content — tables, code blocks,
   the heatmap, the tab strip — scrolls inside its own container. A page that
   pans sideways drags every fixed control away from the thumb reaching for it.
2. **Nothing anchored is ever wider than the viewport.** `clampToViewport` can
   *move* a panel but not shrink one, so a hard-coded 360px confirmation on a
   320px screen was clamped perfectly and still hung 48px off the edge — with
   the destructive button on the part that left. Panel widths are
   `min(Npx, calc(100vw - Mpx))`; the clamping was never the problem.

## Anchored panels

All placement resolves through **`shared/m3/anchor.ts`** — `computePlacement`
flips above when there is more room there, clamps horizontally so a trigger near
an edge shifts the panel instead of letting it render off-screen, and caps the
height to the space actually available. It returns both anchor-relative and
viewport coordinates.

Every anchored panel in the shell is `position: fixed`. That is not a
preference: `.m3-page`, `.m3-main-col` and the tab strip's own menus are scroll
or clip containers, and an absolutely positioned descendant is clipped at its
container's edge rather than the viewport's. The regex builder was `absolute`
with a private copy of the placement maths, and at 320px — where the horizontal
clamp resolves to a large negative offset — it was cut off on the left on every
open. The private copy is gone.

### The modal fallback

Below **560px** the per-element appearance editor and the tab-search panel stop
pretending to be anchored and dock to the bottom edge as a sheet. A 340px panel
"beside" a 44px button on a 320px screen is a panel covering the element it is
editing, which is the one thing a non-modal design exists to prevent. The sheet
keeps the part of the dialog contract that matters: Escape closes, an outside
press closes, and focus returns to the element that opened it.

The threshold is 560 rather than the shell's own 600px compact breakpoint,
because it answers a different question — "does a panel fit *beside* something",
not "which navigation is showing".

## Touch

### Outside-dismiss

Every anchored surface dismissed on `mousedown` alone, which is a mouse-only
contract; a touch that the browser does not synthesise a mouse event for never
reached those listeners, so on a phone menus stayed open until something inside
them was pressed. `shell/outside-press.ts` registers `pointerdown` *and*
`mousedown` — firing twice is harmless, because every handler is "close this".

### Press and hold

`shell/use-long-press.ts` is the touch equivalent of right-click, and it has to
fight the platform deliberately: a held press already means *start a selection*,
*show the callout* and *open the native menu*, all fired while the finger is
still down.

- `user-select: none`, `touch-action: manipulation` and `-webkit-touch-callout:
  none` on the target — refusing to be selectable, rather than cancelling
  `selectstart` after the fact, which still flashes the highlight on some
  browsers.
- `contextmenu` is prevented **only while a touch press is in flight**. Right
  click keeps the browser's own menu everywhere else; a shell that swallows it
  globally takes away Copy and Inspect for the sake of one gesture.
- A **mouse never arms the timer** — it has right-click already, and arming
  would fire mid-drag while a tab is being reordered.
- Movement past 10px **cancels**: a flick that starts on a tab is a scroll.

`shell/use-appearance-target.ts` bundles all three routes — right-click,
press-and-hold, Shift+F10 / ContextMenu — so a surface cannot ship two of them
and forget the third. Spread it onto an element and it also gains `data-m3-el`,
which is what the appearance system already uses to find a styled surface.

### Targets and insets

`@media (pointer: coarse)` lifts every control to the 44px floor. That block did
not exist in the GUI stylesheet — the floor lived only in the sheet the docs site
loads — so `.m3-tab-close` (28px), `.m3-chip` (36px) and the remote's own
controls were all under it.

`index.html` now sets `viewport-fit=cover`. Without it every
`env(safe-area-inset-*)` in the app evaluates to 0, so the notch and
home-indicator handling the app had carried since the remote landed was written
and did nothing.

## Tabs

The strip is the desktop `TabStrip`, with two additions that benefit both
surfaces:

- **Groups.** `gui/src/shell/use-tabs.ts` stopped re-implementing the tab rules
  and now imports them from `shared/m3/tabs.ts`, which already had the full
  grouped model. Create, name, recolour, collapse, reorder by drag, and a group
  appearance editor that is the *same* panel a tab gets.
- **Scrolling.** On coarse pointers `.m3-tablist` scrolls horizontally. Pinned
  tabs are deliberately exempt from the overflow menu — staying visible is what
  a pin means — so on a phone they are the one thing that can exceed the list
  box with nowhere to go. They were being clipped.

### The four searches

`shell/TabSearchPanel.tsx`, reached from the search control in the strip. Four
independent queries, each with its own mode, flags and anchored regex builder,
plain text always the default:

| Search | Scope |
| --- | --- |
| This strip | Every tab in this window |
| Inside a group | One field **per group**, so a query cannot cross a boundary |
| Groups by name | The group-management surface's own search |
| Every open tab | This window unioned with every peer window |

Matching runs against the **visible tab label only**, never page contents.

Cross-window awareness comes from `shared/m3/tab-registry.ts` (moved out of the
docs site so both surfaces share one presence protocol). Windows announce their
strips over a `BroadcastChannel`; peers unheard from past a deadline are dropped,
because a window that is closed, crashed or frozen in the back/forward cache
sends no goodbye. With no `BroadcastChannel` it degrades to this window alone,
and the search then honestly shows every tab it can see.

## Verification

```bash
cd gui && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src --max-warnings=0 && bun test tests
```

`gui/tests/mobile-shell.test.tsx` covers route reachability, strip/group/pin
persistence across a reload, edge placement, the long-press contract, and the
settings search's cross-tab reporting.

**What those tests assert from the stylesheet rather than from layout, and why:**
happy-dom has no layout engine — every `getBoundingClientRect` is zero and no
cascade is resolved — so "is this target 44px" and "does the body scroll
sideways" cannot be *measured* there. Asserting them against a stub would prove
only that the stub was written to agree. The rules are read out of
`m3-shell.css` and checked instead, which is a real check of the thing that
decides the outcome in a browser. Placement, which is pure arithmetic, is tested
as arithmetic.

## Related

- [Foundations](foundations.md) — tokens, type scale, density
- [Components](components.md) — the shared component inventory
- [Contributing](contributing.md) — how to add a surface without forking one
