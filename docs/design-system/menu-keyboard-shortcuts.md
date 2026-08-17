# Menu keyboard shortcuts

Every context-menu item that has a keyboard shortcut displays it, right-aligned
beside the label, in the platform's own notation — and the shortcut it displays
is read from the same declaration the key handler matches against, so the two
cannot drift apart.

That last clause is the whole feature. A menu label is not executable: writing
`Del` into the markup and testing `e.key === "Delete"` two hundred lines away
produces two facts that agree on the day they are written and diverge silently
the first time either is edited. The menu then goes on teaching a keystroke that
stopped working, which is worse than a menu that never mentioned it — the user
presses the key, nothing happens, and they have no way to tell whether the app is
broken or they misread the column.

## Where the logic lives

| Module | Responsibility |
|---|---|
| `gui/src/shell/shortcuts.ts` | The chords themselves, `matchesShortcut`, and the two formatters |
| `gui/src/shell/MenuItem.tsx` | The single menu row, its shortcut column, and `menuShortcutProps` |
| `gui/src/styles/m3-shell.css` | `.m3-menu-shortcut`, the right-aligned column |
| `gui/src/i18n/m3.ts`, `gui/src/i18n/yue.ts` | `menu.shortcut`, the column's tooltip |

## The registry

`SHORTCUTS` maps a `ShortcutId` to one or more chords. A chord names the DOM
`KeyboardEvent.key` it fires on, the modifiers that must be held, and optionally
a `code` and alternate `key` values for the same physical press.

```ts
commandPalette: [{ key: "F", keyAliases: ["f"], code: "KeyF", ctrl: true, shift: true }],
contextMenu:    [{ key: "ContextMenu", ignoreModifiers: ["shift"] }, { key: "F10", shift: true }],
closeTab:       [{ key: "Delete" }],
closeMenuRow:   [{ key: "Delete" }, { key: "Backspace" }],
```

Three properties are worth stating outright, because each one is a decision
rather than a default:

- **A modifier not named must be absent.** `closeTab` matches a bare Delete and
  not Ctrl+Delete, which is what makes printing `Del` beside "Close tab" a true
  statement rather than an approximate one. This tightened the tab strip's
  previous `e.key === "Delete"`, which fired with any modifier held.
- **More than one chord is normal, not a fallback.** The keyboard's right-click
  is the Menu key on a keyboard that has one and Shift+F10 on a keyboard that
  does not. Both are live simultaneously.
- **`ignoreModifiers` is used exactly once.** The Menu key *is* the request, and
  the handlers this replaced never checked modifiers on it; narrowing it would
  have taken Shift+Menu away from whoever presses it, and nothing displays that
  chord, so nothing would have become more honest.

`matchesShortcut(id, event)` is typed against a structural `ShortcutEvent`
rather than `KeyboardEvent`, so a `window` listener and a React `onKeyDown` both
pass their event straight in.

### Who matches what

| Surface | Registration site | Ids |
|---|---|---|
| Command palette | `CommandPalette.tsx`, on `window` | `commandPalette` |
| Element appearance menu | `ElementAppearanceHost.tsx`, on `document` | `contextMenu` |
| Tab strip | `TabStrip.tsx`, on the `role="tablist"` element | `contextMenu`, `closeTab` |
| Tab overflow menu | `TabStrip.tsx`, on the overflow `role="menu"` | `closeMenuRow` |

## Notation

`formatShortcut(id, platform)` renders the **first** chord in the platform's own
convention. A native menu shows one chord; a column listing every synonym is a
column nobody reads.

| Id | Windows / Linux | Apple | `aria-keyshortcuts` |
|---|---|---|---|
| `commandPalette` | `Ctrl+Shift+F` | `⌃⇧F` | `Control+Shift+F` |
| `contextMenu` | `Menu` | `Menu` | `ContextMenu Shift+F10` |
| `closeTab` | `Del` | `⌦` | `Delete` |
| `closeMenuRow` | `Del` | `⌦` | `Delete Backspace` |

The Apple column is `⌃⇧F` and not `⌘⇧F` deliberately: the handler tests
`ctrlKey`, so Control is the key that actually works there. A formatter that
"helpfully" promoted it to Command would print a chord the app does not answer.

Key legends are **not translated**. `Del` is what is printed on the key, and a
reader hunting for a translated one will not find it. What is translated is the
column's tooltip (`menu.shortcut`, "Keyboard shortcut: {keys}"), because a
two-letter abbreviation with no context tells a first-time reader nothing.

`ariaKeyShortcuts(id)` emits every chord, space separated, using WAI-ARIA's own
modifier vocabulary (`Control`, `Alt`, `Shift`, `Meta`) and the DOM `key` value —
which is why the ARIA column above says `Control` where the visible one says
`Ctrl`, and `Delete` where it says `Del`.

## Said once, not twice

The visible column carries `aria-hidden="true"`; the keys reach assistive
technology through `aria-keyshortcuts` on the button. Doing both is the failure
this arrangement exists to avoid — a screen reader reading the button's text
content announces "Close tab Del", then announces the shortcut properly a moment
later, so the user who most needs the information hears it twice, once in a form
that is not a shortcut at all.

`aria-keyshortcuts` goes on **the control the key operates**, which is not always
the row. In the overflow menu the row activates a tab and the ✕ beside it closes
one, and Delete does the second, so the attribute sits on the ✕.

## Every menu, and what each one shows

`MenuItem` is the single `role="menuitem*"` button in the shell. Every menu
renders through it, so the column is structural: a new menu gets it by
construction, and giving an existing command a binding is one `shortcut` prop
rather than an edit in two files that can disagree.

| Menu | Surface | Shows |
|---|---|---|
| Tab context menu | `TabStrip.tsx` | `Del` on **Close tab**, conditionally — see below |
| Tab group menu | `TabStrip.tsx` | Nothing; no command has a binding |
| Tab overflow menu | `TabStrip.tsx` | `Del` beside the ✕ of the focused row |
| New-tab page list | `TabStrip.tsx` | Nothing; opening a page has no binding |
| Element appearance chain menu | `ElementAppearanceHost.tsx` | Nothing; see below |
| Account switcher | `AccountSwitcher.tsx` | Nothing; rows are values, not commands |
| Cost range menu | `CostMeter.tsx` | Nothing; rows are values |
| Viewport preview menu | `ViewportPreview.tsx` | Nothing; rows are values |

Nothing is padded. An item with no binding renders no element at all, so a menu
whose commands have no shortcuts looks exactly as it did before — no empty
gutter, no placeholder dash.

### Two entries that are deliberately conditional

**"Close tab" shows `Del` only when the right-clicked tab is the active one.**
Delete on the strip closes the *active* tab; the menu acts on the tab that was
right-clicked. Those are the same tab often enough that suppressing the shortcut
entirely would hide a real binding, and different often enough that printing it
unconditionally would be a lie with consequences: press it after right-clicking a
background tab and the tab you were looking at closes instead. A shortcut that
appears and disappears is a smaller surprise than one that closes the wrong
thing.

**The overflow menu prints `Del` on the focused row only.** The menu's Delete
acts on whichever row the arrows are sitting on. Printed on every row it would
promise each of them a key that closes a different one.

### Two absences that are the correct answer

**The appearance chain menu shows nothing.** Shift+F10 and the Menu key *open*
that menu; no key activates a row of it. The one press that reaches an editor
directly does so only when the chain holds a single target — precisely the case
where the menu is never shown.

**Activation keys are not shortcuts.** Enter and Space activate the focused item,
Escape closes the menu, arrows move within it. Those are the `role="menu"`
contract, they are identical on every row, and putting them in the column would
fill it with noise that says nothing about the command beside it. Mouse chords
are excluded for a different reason: Shift+right-click opening the appearance
editor is real and documented, but it is not a keyboard shortcut and has no place
in `aria-keyshortcuts` — a screen-reader user told "shift plus right click" has
been handed an instruction they may not be able to follow.

## Adding a shortcut

1. Add the chord to `SHORTCUTS` in `gui/src/shell/shortcuts.ts`.
2. Call `matchesShortcut(id, event)` in the handler that owns the surface,
   instead of comparing `event.key` by hand.
3. Set `shortcut={id}` on the `MenuItem` for that command — and only where the
   binding genuinely reaches that command from that surface.

Step 3 is where the rule is actually kept or broken. A shortcut that only fires
while a different surface has focus is the wrong shortcut, and a menu is where a
user learns it.

## Verification

- `bun run typecheck` and `cd gui && bun run build` — a renamed `ShortcutId` is a
  compile error at both the handler and the menu, which is the property the whole
  design is buying.
- By hand: open the tab context menu on the active tab and on a background tab,
  and confirm `Del` appears only on the first; arrow through the overflow menu
  and confirm the column follows focus; confirm Ctrl+Delete on the strip no
  longer closes a tab.

## Suggested articles

- [Components](./components.md) — the menu, button and field anatomy this row sits in
- [Appearance editors](./appearance-editors.md) — the editors the appearance chain menu opens
- [Mobile shell](./mobile-shell.md) — anchored panels, long-press and the 44px touch floor
