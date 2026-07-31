---
title: Tab Groups & Tab Search
description: Grouping, collapsing, colouring and pinning dashboard tabs, and the four searches that find one across every window.
---

The dashboard's tab strip works like a browser's: tabs open, pin, reorder, overflow into a menu, and
survive a restart. This page covers the two parts that go beyond that — **groups**, which give a run
of related tabs a named, collapsible, decorated header, and the **four tab searches**, which find a
tab by its label from four different starting points.

Everything here matches against a tab's **visible label only**. No search on this strip reads page
contents, and none of them reaches the network.

## Groups

A group is a coloured header immediately before its members' run. The header is a real button
carrying the group's name and its member count, so the colour is decoration and never the only way to
tell two groups apart.

### Making one

| To | Do this |
| --- | --- |
| Create a group | Open **Find a tab** in the strip, then **New group** under *Groups by name*. |
| Put a tab in it | Drag the tab onto the group's header or onto any of its members. |
| …from the keyboard | Focus the tab and press <kbd>Alt</kbd>+<kbd>→</kbd>. |
| Take a tab out | <kbd>Alt</kbd>+<kbd>→</kbd> until it comes round to *No group*, or use the group picker on the tab's row in **Find a tab**. |
| Collapse or expand | Click the header, or press <kbd>Enter</kbd> on it. |
| Rename, recolour, reorder, ungroup | Right-click the header. |
| Edit its appearance | Right-click the header → **Edit group appearance…**, or <kbd>Shift</kbd>+right-click to open the editor directly. |

<kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> steps the focused tab along a *ring* of destinations — no
group, then each group in strip order. "Into", "between" and "out of" are the same motion at
different points on that ring, which is one thing to learn rather than three shortcuts to be told
about. On a group header, the same keys reorder the group itself, because there is no keyboard drag
and a group's place in the strip should not be a preference only a mouse can set.

### Collapsing

A collapsed group folds its members away and shows a count. Two tabs are never folded away:

- **The active tab.** Collapsing the group you are looking at moves the selection out of it first, so
  the strip never hides the page in front of you.
- **A pinned member.** A pin is a promise that the tab stays on screen, and a collapse that broke it
  would make the two features quietly incompatible.

Collapsing does not close anything, and the group survives being emptied — its name and colour are
things you chose, and an emptied group is a container you may be about to refill.

### Pinning

Pin one tab as usual, or pin a whole group from its header menu. A pinned tab moves into the strip's
fixed pinned region, ahead of every group run, so it stays visible when everything else overflows.

It **keeps its membership** while pinned. That is a deliberate difference from most browsers: "pin
this group" has to be reversible to mean anything, and a pin that erased membership would empty the
group as it was applied, leaving nothing to unpin back into. Unpinning returns each tab to the group
it came from.

## The group appearance editor

Right-click a header → **Edit group appearance…** (or <kbd>Shift</kbd>+right-click). The editor is
non-modal and anchored beside the header it edits, so the thing being changed stays visible. Escape
closes it and hands focus back to the header.

It covers:

- **Name and typography** — the group's name, every bundled and installed font, size, weight, letter
  spacing, italic, underline and small caps.
- **Colours** — group accent, name colour, a highlight behind the name, header fill, and the fills for
  the collapsed and hover states, plus the focus ring.
- **Icon or emoji, and a badge** — up to two characters before the name, and a short badge after it.
- **Border, shape and spacing** — border colour, width and style; corner radius; header padding; the
  gap to the members; and what separates the group's run from whatever precedes it.
- **Every state at once** — expanded, collapsed, hover and focus are drawn side by side, because you
  cannot hover a header while dragging a slider, and you cannot see a collapsed header while the
  group is open.

Each property has its own reset, and there is a reset for the whole group. Clearing a property stores
nothing, so the header falls back to the theme — and keeps following it if you change the theme
later, which a stored copy of today's default would not.

### Colours are continuous, and translated

Every colour control offers the platform's spectrum picker, an OKLCh triple of sliders (lightness,
chroma, hue) plus opacity, and free text that accepts any of fourteen notations — named colours,
HEX/HEX8, RGB(A), HSL(A), HSV, HWB, CIELAB, LCH, OKLab, OKLCH and CMYK. Open **More** to see the same
colour written every way, each copyable, with the active gamut named and a warning when a colour is
wider than sRGB and the screen will show the nearest one it can.

Where a colour will be read against another — the name against its highlight or the header fill — the
control states the WCAG contrast ratio and grade. It **reports** rather than refuses: it cannot see
your display or your reason. Nothing is chosen silently.

### Sharing an appearance

**Copy this appearance** turns the group's decoration into text you can paste anywhere; **Paste an
appearance** reads it back. Anything the header cannot draw is dropped on the way in, so a blob that
has been hand-edited cannot put a value into the store the strip would refuse to render.

### What decoration cannot do

Decoration never replaces the group's accessible name or its expanded/collapsed state. Both come from
the group's name and its collapsed flag, and both are announced whatever the icon, the small caps or
the colours are set to. A group whose label colour matches its background is still read correctly
aloud.

## The four searches

Open **Find a tab** from the strip. Four searches live in one panel, and each one has **its own**
query, mode, flags and anchored regex builder. They cannot drift into each other's state, because
there is no shared object for them to drift through.

| # | Search | Scope |
| --- | --- | --- |
| 1 | **This strip** | Every tab in this window. |
| 2 | **Inside \<group\>** | One field per group, bound to that group alone. |
| 3 | **Groups by name** | The groups themselves, by their visible names. |
| 4 | **Every open tab, every window** | Every tab in every window this app has open. |

Plain text is the default and regex is an explicit opt-in, so typing `c++` finds the tab you meant
rather than reporting a syntax error. Each field's builder button opens the regex builder anchored
beside it; applying a pattern writes the pattern, its flags **and** the mode switch in one commit — a
pattern dropped into a field still in plain-text mode would be matched literally, which silently
finds nothing and reads as a broken search. The line under each field always states which mode is
running and with which flags.

An empty query is the unfiltered list, not a filter that matches nothing. A pattern that will not
compile is the one case that hides rows, and the field says so rather than leaving a blank list to be
misread as "no matches".

### Reading a result

Every row says where the tab is: which window, which strip, which group, whether it is pinned, and
its visible label. A row in a collapsed group says so before you click it.

### Revealing without unfolding

Going to a result inside a collapsed group **reveals that one tab and leaves the group collapsed**.
The strip exempts the active tab from a collapse, so selecting is enough — and expanding instead
would undo a choice you made, in order to show you something one selection already shows.

### Acting without losing your place

Each row offers go-to, pin/unpin, close, and a group picker. Every one of them leaves the query, the
mode and the flags exactly as they were and leaves the panel open, because "find the four staging
tabs, deal with each, come back" is what a tab search is for.

Rows for tabs in **other** windows are acted on by message: the other window selects or closes its own
tab. Raising another window is usually refused by the platform, so the row tells you which window it
lives in before you click.

## Failure modes

| What happens | What you see |
| --- | --- |
| A pattern will not compile | The field says so, names the engine's error, and hides no rows silently. |
| An empty or whitespace query | The full list. Bulk closes still refuse an empty query outright — running it as "matches everything" would close the strip. |
| Stored tab state is corrupt or unreadable | The strip falls back to a single fresh tab rather than to nothing. |
| A tab points at a group that no longer exists | The tab is kept and becomes ungrouped. It is never dropped. |
| A group's members were stored out of order | One header is still drawn, with the members gathered under it. |
| A decoration value the header cannot draw | Dropped on read; numbers are clamped to the nearest drawable value rather than discarded. |
| Another window stops answering | Its rows disappear from the master search within about ten seconds. Nothing is left as a ghost. |
| `BroadcastChannel` is unavailable | The master search covers this window alone, which is every window it can see. |

## Security and privacy

- Searches match the **visible label** only. Page contents are never read, and nothing is transmitted.
- Patterns are compiled locally, capped at 400 characters, and never persisted.
- The cross-window registry carries tab labels and two commands between windows of this app on one
  origin. It holds nothing a reload would need, persists nothing, and reaches no network.
- Group decoration is read back through a validator before it is applied, so a hand-edited storage
  entry cannot inject a value into a style attribute.

## Accessibility

- The strip is a `tablist`; each tab is a `tab` with a roving `tabIndex` and an `aria-controls`
  pointing at **its own** panel, since every open tab keeps a live panel.
- A group header is a button with `aria-expanded` and an accessible name of "Group *name*, *n* tabs".
  It is deliberately **not** a `tab`.
- Every anchored surface — the group menu, the appearance editor, the search panel, the four regex
  builders — closes on <kbd>Escape</kbd> and returns focus to what opened it.
- Grouping a tab, pinning a group and moving a tab between groups change nothing that carries focus,
  so each is announced through a polite live region.
- Focus is always visible, and a custom focus-ring colour is its own property so a custom header fill
  cannot swallow the indicator.
- Motion respects `prefers-reduced-motion`.

## Verifying it

```bash
cd gui && bun test tests/tab-groups.test.ts tests/tab-group-strip.test.tsx
```

`tests/tab-groups.test.ts` holds the rules without React — the collapse that must not hide a pinned
tab, the pin that must stay reversible, the empty query that must not filter, and the reveal that
must not unfold. `tests/tab-group-strip.test.tsx` holds what only a rendered strip can show: the
header's role and accessible name, <kbd>Shift</kbd>+right-click reaching the editor directly, the
four fields never sharing a query, and the tab context menu still offering exactly its eight commands.

## Suggested articles

- [Web Dashboard](/guides/web-dashboard/) — the screens these tabs open, and how the dashboard talks
  to the proxy.
- [Launcher & Terminal](/guides/launcher-and-terminal/) — the other surface the shell owns.
- [Log Files](/guides/log-files/) — the search bar on the Logs screen uses the same regex builder.
- [Configuration](/reference/configuration/) — where the dashboard's own preferences live.
