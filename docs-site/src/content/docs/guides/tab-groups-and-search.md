---
title: Tab groups and tab search
description: Group the dashboard's tabs, move a tab into a group from an anchored picker rather than an ever-growing menu, and find any tab across this strip, inside a group, by group name, or across every open window.
---

The opencodex dashboard is tabbed like a browser: every page you open gets a tab, tabs reorder by
drag, pin to the front, and move into named, coloured, collapsible **groups**. This page is about the
group half and the search half — what each command does, what it deliberately refuses to do, and
which keys drive it.

Everything here lives in the strip along the top of the dashboard. Nothing is stored on the server:
the whole strip — order, pins, groups, collapsed state and per-tab appearance — is written to your
own browser's local storage under `ocx-m3:tabs`, so it survives a reload and never leaves the
machine.

## The tab menu

Right-click any tab — or press <kbd>Shift</kbd>+<kbd>F10</kbd> or the <kbd>Menu</kbd> key with a tab
focused — and the menu opens with eleven entries, always the same eleven, in the same order.
Entries that cannot do anything right now are **disabled rather than hidden**, because a menu whose
items move between openings is a menu whose muscle memory is wrong.

| Entry | What it does |
| --- | --- |
| Close tab | Closes it. Disabled on the last remaining tab — the strip never empties. |
| Close other tabs | Everything but this one. Pinned tabs survive. |
| Close tabs to the right | Everything after it in strip order. Pinned tabs survive. |
| Pin tab / Unpin tab | Says what it will do, not what the tab currently is. |
| Duplicate tab | A second tab on the same page, carrying the original's appearance. |
| Close tabs containing text… | Opens the bulk close with a preview. |
| Close tabs not containing text… | The exact negation of the same query. |
| Edit tab appearance… | Font, size, weight, colour, background and badge for this one tab. |
| New group… | Names a new group and puts this tab in it. |
| **Move… into group…** | Opens the group picker described below. |
| Remove from group | Takes the tab out of its group without closing it. |

Two commands have a faster route: <kbd>Shift</kbd>+right-click goes straight to the appearance
editor, and <kbd>Delete</kbd> closes the focused tab without opening the menu at all. Double-clicking
a tab pins it; middle-clicking closes it.

## Moving a tab into a group

**"Move… into group…" opens a picker, not a list of groups inside the menu.** That is a deliberate
shape, and it is the reason the entry ends in an ellipsis. A menu that grows one entry per group
grows without bound: with ten groups, "Remove from group" is somewhere off the bottom of a menu
whose other ten entries never moved, and every command below the group list is at a different
height every time you open it.

The picker opens anchored beside the tab you right-clicked, never on top of it — it takes the space
below the tab, or above it when there is more room there, and scrolls inside itself rather than
running off the screen. Nothing behind it is frozen; it is a panel, not a modal.

It shows:

- **Every group, with its name, its colour and how many tabs it holds.** The colour is decoration —
  the row's accessible name is the group's name and count, so a group is never identified by colour
  alone.
- **A marker on the group the tab is already in.** Choosing that row simply closes the picker.
- **A marker on any collapsed group.** Moving a tab into a collapsed group is allowed and leaves the
  group collapsed — you collapsed it, and a move is not a request to undo that. Because the tab then
  lands somewhere the strip will not draw, the picker says so before you choose rather than after.
- **A search field with the full regex builder beside it**, exactly like every other search surface
  in opencodex. Plain text is the default; the `.*` builder opens anchored to that field and hands
  the finished pattern straight back to it.
- **A create-new-group row.** Type a name, press <kbd>Enter</kbd>, and the group is created with this
  tab already in it — one commit, so there is never a moment where an empty group exists.
- **An honest empty state.** With no groups yet the picker says so and points at the create row,
  which is different from "your filter matched nothing" and is worded differently.

### Keyboard

| Key | In the picker |
| --- | --- |
| <kbd>↓</kbd> from the search field | Moves to the first group |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Moves between groups; <kbd>↑</kbd> from the first row returns to the search field |
| <kbd>Home</kbd> / <kbd>End</kbd> | First / last group |
| <kbd>Enter</kbd> | Moves the tab into the focused group. In the search field with exactly one match, moves it into that one |
| <kbd>Esc</kbd> | Clears a non-empty filter first; a second press closes the picker |

Focus lands on the search field when the picker opens, and returns to the tab it was opened from
whichever way it closes — moved, cancelled or dismissed by clicking away.

**A pinned tab cannot join a group**, so the menu entry is disabled for one. Pinned tabs occupy a
fixed region that must stay visible when everything else overflows, and a member of a collapsible
group cannot promise that.

## Groups themselves

Right-click a **group header** for its own menu: collapse or expand, rename, edit the group's
appearance, or ungroup. "Ungroup" releases the members — it never closes them.

Dragging works in both directions: drag a tab onto a group header to join it, and drag a group
header to reorder the groups themselves. The picker above exists because dragging is the only other
route in, and a drag is unreachable from the keyboard.

A group's colour tints its whole run in the strip, and a collapsed group still draws its header with
a member count, so collapsing never makes a group disappear.

## The four tab searches

The magnifier in the strip opens a panel with four independent searches. Each owns its own query,
its own plain-text-or-regex mode, and its own anchored regex builder — nothing is shared between
them, so a pattern typed in one cannot silently narrow another.

| Search | Scope |
| --- | --- |
| Tabs in this window | Every tab in this strip, including the ones in the overflow menu |
| Tabs in *group* | One search per group, keyed to that group so a query cannot cross a boundary |
| Groups by name | Finds the group rather than the tab |
| Every open tab | This window plus every other window with the dashboard open |

The last one unions this strip with snapshots the other windows broadcast, and can activate or close
a tab in another window from here. Revealing a result that sits inside a collapsed group does not
expand that group permanently.

Every search matches against a tab's **visible label** and nothing else. Page contents are never
read.

## Closing many tabs at once

"Close tabs containing text…" and "Close tabs not containing text…" open the same panel in two
modes. Before anything closes it shows the exact list of tabs that would go and a count against the
total; pinned tabs are excluded unless you explicitly opt in, and the panel says how many were
spared. An empty query is refused **in words** rather than by a silently greyed button, because an
empty query would match every tab and close the strip.

The preview and the close read one function, so the number you review cannot disagree with what the
strip loses.

## Suggested articles

- [Web dashboard](/guides/web-dashboard) — every screen these tabs open, and the rest of the shell.
- [Exporting lists and acting in bulk](/guides/export-and-bulk-actions) — the same
  "never overstate what was done" rule applied to lists.
- [Settings](/settings) — theme, density, fonts and the appearance system the per-tab editor writes
  into.
