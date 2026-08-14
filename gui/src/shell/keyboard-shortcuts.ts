/**
 * The one place an app-wide keyboard shortcut is defined.
 *
 * The house rule this exists to satisfy is specific about the failure mode it
 * is guarding against: a context menu that *shows* a shortcut is worse than one
 * that shows none, if the shortcut is wrong — "a wrong shortcut trains a user
 * to press a key that does nothing." The only way a shown shortcut cannot drift
 * from the key that actually does the thing is for both to read the same
 * value, so this module is that value: the binding a `keydown` handler matches
 * against, and the label a menu row renders beside its own action, come from
 * one `ShortcutDef` rather than two hand-typed copies of "Delete" that a later
 * edit can update in one place and forget in the other.
 *
 * Before this module existed the app had exactly one accelerator wired up at
 * all — Ctrl+Shift+F for the command palette, matched inline inside
 * `CommandPalette.tsx` against a hand-rolled `event.key === "F" || ...` check —
 * and the tab strip's Delete-to-close was a second, independently spelled
 * `e.key === "Delete"` with no relationship to anything a menu could read. Nothing
 * anywhere connected a binding to a display string, because nothing displayed
 * one. Adding the display is what makes the connection worth keeping honest.
 */

/** The subset of `KeyboardEvent` a binding needs to test itself against. Both a
 * native `KeyboardEvent` (the palette's `window` listener) and React's
 * synthetic `KeyboardEvent` (every handler inside the tab strip) satisfy this
 * shape, so one `matchesShortcut` serves both without a wrapper at each call
 * site. */
export interface ShortcutKeyEvent {
  key: string;
  /** The physical key, layout-independent. Optional because a handcrafted test
   * event is not required to set it — `matchesShortcut` falls back to `key`
   * alone when it is absent, exactly as a real browser event never is. */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ShortcutDef {
  /** Stable id, so a caller can look a binding up without repeating its keys. */
  id: string;
  /** Accepted `KeyboardEvent.key` spellings. More than one only for a letter
   * key, where Shift and the active layout can change the case a browser
   * reports ("F" vs "f") independently of whether Shift is itself part of the
   * chord being matched. */
  keys: string[];
  /** `KeyboardEvent.code` — the physical key, stable across layouts and shift
   * state. Checked as a fallback so an unusual layout that reports a `key` this
   * list did not anticipate still matches on the key that was physically hit. */
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Windows notation, as a Windows user would read it off their own keyboard —
   * "Ctrl+Shift+F", "Delete". This is what a menu row shows; it is prose only
   * in the sense that it names physical keys, never translated copy, so it
   * carries no i18n key of its own (the shared rules draw exactly this line:
   * key names are identifiers, not language).
   */
  label: string;
}

/**
 * Whether `event` is the chord `def` describes.
 *
 * Every modifier is checked for exact equality, including the ones `def` does
 * not set — a bare `Delete` binding must refuse `Ctrl+Delete` precisely because
 * a real menu action offered under the plain key would otherwise fire from a
 * chord the user pressed meaning something else entirely. The Windows key is
 * never part of an app shortcut, so a held `metaKey` always fails the match
 * rather than needing its own `meta` field on every definition.
 */
export function matchesShortcut(event: ShortcutKeyEvent, def: ShortcutDef): boolean {
  if (event.ctrlKey !== !!def.ctrl) return false;
  if (event.shiftKey !== !!def.shift) return false;
  if (event.altKey !== !!def.alt) return false;
  if (event.metaKey) return false;
  return def.keys.includes(event.key) || (!!event.code && event.code === def.code);
}

/**
 * The ARIA-spec spelling of `def`, for `aria-keyshortcuts`.
 *
 * `aria-keyshortcuts` is how a shortcut reaches assistive technology as a
 * shortcut rather than as text a screen reader reads as part of the label —
 * exposed as a distinct accessibility-tree property, not appended to the
 * accessible name, so it is never announced twice alongside a visible
 * (`aria-hidden`) badge showing the same thing. The spec's own modifier names
 * ("Control", "Alt", "Shift") differ from the short Windows notation `label`
 * shows on screen, which is why this is a second value rather than reusing it.
 */
export function ariaKeyShortcuts(def: ShortcutDef): string {
  const parts: string[] = [];
  if (def.ctrl) parts.push("Control");
  if (def.alt) parts.push("Alt");
  if (def.shift) parts.push("Shift");
  parts.push(def.keys[0]);
  return parts.join("+");
}

/**
 * Every app-wide keyboard shortcut, keyed by what it does.
 *
 * `satisfies Record<string, ShortcutDef>` rather than a wider annotation: it
 * keeps every entry checked against the shape while still letting
 * `SHORTCUTS.tabClose` narrow to its own literal `label`, which is what lets a
 * menu row's JSX read `SHORTCUTS.tabClose.label` instead of a second `"Delete"`.
 */
export const SHORTCUTS = {
  /** Opens (and, pressed again, closes) the command palette from anywhere in
   * the app. Registered in `CommandPalette.tsx`'s own `window` listener. */
  commandPalette: {
    id: "commandPalette",
    keys: ["F", "f"],
    code: "KeyF",
    ctrl: true,
    shift: true,
    label: "Ctrl+Shift+F",
  },
  /** Closes the focused tab. Registered twice, deliberately: once on the tab
   * strip itself (`TabStrip.tsx`'s `.m3-tablist` `onKeyDown`, acting on the
   * active tab) and once inside the open tab context menu (`onContextKeyDown`,
   * acting on whichever tab the menu was opened for) — so the "Delete" this
   * module lets the context menu's "Close tab" row display is true in both of
   * the places a user could plausibly press it. */
  tabClose: {
    id: "tabClose",
    keys: ["Delete"],
    code: "Delete",
    label: "Delete",
  },
} as const satisfies Record<string, ShortcutDef>;
