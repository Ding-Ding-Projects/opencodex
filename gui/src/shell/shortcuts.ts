/**
 * Every keyboard binding the shell owns, written down exactly once.
 *
 * ## Why this file exists at all
 *
 * A context menu has to show the shortcut beside the command it belongs to, and
 * the only way that stays true is for the menu and the key handler to read the
 * *same* declaration. Writing "Del" into the menu by hand and matching
 * `e.key === "Delete"` somewhere else produces two facts that agree on the day
 * they are written and drift the first time either is edited — and the drift is
 * silent, because a menu label is not executable. The label goes on telling
 * people to press a key that stopped doing anything, which is worse than showing
 * nothing at all: it trains a keystroke that fails.
 *
 * So the chords live here, `matchesShortcut` is what the handlers call, and
 * `formatShortcut` / `ariaKeyShortcuts` are what the menus render. Renaming a
 * chord is a compile error at both ends; changing a key changes the label in the
 * same edit.
 *
 * ## What is deliberately NOT here
 *
 * Activation keys are not shortcuts. Enter and Space activate the focused menu
 * item, Escape closes a menu, arrows move within one — those are the roving
 * `role="menu"` contract, they are identical on every item, and putting them in
 * a shortcut column would fill it with noise that says nothing about the command
 * it sits beside.
 *
 * Mouse chords are not shortcuts either. Shift+right-click opens the appearance
 * editor directly, which is real and documented, but it is not a *keyboard*
 * shortcut and has no place in `aria-keyshortcuts` — a screen-reader user told
 * "shift plus right click" has been handed an instruction they may not be able
 * to follow.
 */

/** Every command in the shell that has a keyboard binding. */
export type ShortcutId =
  /** Open the command palette, from anywhere in the app. */
  | "commandPalette"
  /** The keyboard's right-click: open the context menu for whatever has focus. */
  | "contextMenu"
  /** Close the active tab, while the tab strip has focus. */
  | "closeTab"
  /** Close the focused row of the tab strip's overflow menu. */
  | "closeMenuRow";

type ModifierName = "ctrl" | "alt" | "shift" | "meta";

/**
 * One physical key press.
 *
 * A modifier not named here must be *absent* for the chord to match, which is
 * what makes a displayed "Delete" honest: Ctrl+Delete is a different press and
 * this label never claimed it. `ignoreModifiers` opts one modifier back out of
 * that rule, for the one key where it genuinely does not change the request.
 */
interface Chord {
  /** The `KeyboardEvent.key` this fires on, and the name `aria-keyshortcuts` uses. */
  key: string;
  /**
   * Other `key` values that are the same press.
   *
   * Shift changes the character a letter key reports, so a Shift chord on `F`
   * arrives as `"F"` on most engines and `"f"` on some. Both are the same key.
   */
  keyAliases?: readonly string[];
  /**
   * `KeyboardEvent.code`, matched as a fallback.
   *
   * A non-US layout can report a different `key` for the same physical key; the
   * `code` is positional and survives that.
   */
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** Modifiers whose state this chord does not care about. */
  ignoreModifiers?: readonly ModifierName[];
}

/**
 * The bindings themselves.
 *
 * More than one chord per command is normal and is not a fallback: the keyboard
 * right-click is the Menu key on a keyboard that has one and Shift+F10 on a
 * keyboard that does not, and both are live at once. Only the first is shown in
 * a menu — a native menu shows one chord, and a column listing every synonym is
 * a column nobody reads — but every one of them is exposed through
 * `aria-keyshortcuts`, which is a list by specification.
 */
export const SHORTCUTS: Record<ShortcutId, readonly Chord[]> = {
  // Registered by `CommandPalette.tsx` on `window`.
  commandPalette: [{ key: "F", keyAliases: ["f"], code: "KeyF", ctrl: true, shift: true }],
  // Registered by `ElementAppearanceHost.tsx` on `document`, and by the tab
  // strip's own `onKeyDown` for the tab menu.
  //
  // The Menu key ignores Shift because it always has: this key *is* the request,
  // and the handlers it replaces tested `key === "ContextMenu"` with no modifier
  // check at all. Tightening it here would quietly take Shift+Menu away from
  // anyone who happened to be pressing it, for no gain — nothing displays this
  // chord, so nothing is made more honest by narrowing it.
  contextMenu: [
    { key: "ContextMenu", ignoreModifiers: ["shift"] },
    { key: "F10", shift: true },
  ],
  // Registered by `TabStrip.tsx` on the `role="tablist"` element.
  closeTab: [{ key: "Delete" }],
  // Registered by `TabStrip.tsx` on the overflow `role="menu"` element.
  closeMenuRow: [{ key: "Delete" }, { key: "Backspace" }],
};

/**
 * The shape both DOM and React keyboard events satisfy.
 *
 * Typed structurally rather than as `KeyboardEvent` so the same matcher serves a
 * `window` listener and a React `onKeyDown` without either side casting.
 */
export interface ShortcutEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function modifierHeld(event: ShortcutEvent, name: ModifierName): boolean {
  if (name === "ctrl") return event.ctrlKey;
  if (name === "alt") return event.altKey;
  if (name === "shift") return event.shiftKey;
  return event.metaKey;
}

function chordMatches(chord: Chord, event: ShortcutEvent): boolean {
  const modifiers: ModifierName[] = ["ctrl", "alt", "shift", "meta"];
  for (const name of modifiers) {
    if (chord.ignoreModifiers?.includes(name)) continue;
    if (modifierHeld(event, name) !== !!chord[name]) return false;
  }
  if (event.key === chord.key) return true;
  if (chord.keyAliases?.includes(event.key)) return true;
  return !!chord.code && event.code === chord.code;
}

/** Whether this key press is the binding for `id`. The handlers' only test. */
export function matchesShortcut(id: ShortcutId, event: ShortcutEvent): boolean {
  return SHORTCUTS[id].some(chord => chordMatches(chord, event));
}

/* ------------------------------------------------------------ notation --- */

export type ShortcutPlatform = "apple" | "windows";

/**
 * Apple writes a chord as bare glyphs in a fixed order; everywhere else writes
 * words joined by `+`. Both are the platform's own notation rather than a house
 * style, because a shortcut column is read against the keys a person is looking
 * at, and `⌘` is what is printed on that key.
 */
const MODIFIER_GLYPH: Record<ShortcutPlatform, Record<ModifierName, string>> = {
  // ⌃⌥⇧⌘, in that order, is the Apple Style Guide's ordering.
  apple: { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" },
  windows: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" },
};

const MODIFIER_ORDER: Record<ShortcutPlatform, readonly ModifierName[]> = {
  apple: ["ctrl", "alt", "shift", "meta"],
  windows: ["meta", "ctrl", "alt", "shift"],
};

/**
 * Key names as the platform prints them.
 *
 * Not localized, and that is deliberate rather than an omission: these are the
 * legends on a physical keyboard, so translating "Del" leaves a reader hunting
 * for a key that does not exist. Anything absent falls through to the DOM `key`
 * value, which is already the right answer for letters and function keys.
 */
const KEY_LABEL: Record<ShortcutPlatform, Record<string, string>> = {
  apple: {
    Delete: "⌦",
    Backspace: "⌫",
    Escape: "⎋",
    Enter: "↩",
    Tab: "⇥",
    " ": "Space",
    ContextMenu: "Menu",
  },
  windows: {
    Delete: "Del",
    Escape: "Esc",
    Insert: "Ins",
    " ": "Space",
    ContextMenu: "Menu",
  },
};

function keyLabel(chord: Chord, platform: ShortcutPlatform): string {
  return KEY_LABEL[platform][chord.key] ?? chord.key;
}

function chordLabel(chord: Chord, platform: ShortcutPlatform): string {
  const parts = MODIFIER_ORDER[platform]
    .filter(name => chord[name])
    .map(name => MODIFIER_GLYPH[platform][name]);
  parts.push(keyLabel(chord, platform));
  // Apple notation is unseparated glyphs; every other platform joins with `+`.
  return platform === "apple" ? parts.join("") : parts.join("+");
}

/**
 * Which notation this machine reads in.
 *
 * Read once at module load. A person does not change operating system mid
 * session, and re-deriving it per render would put a `navigator` read inside
 * every menu item.
 */
export const SHORTCUT_PLATFORM: ShortcutPlatform = detectShortcutPlatform();

function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "windows";
  // `userAgentData.platform` is the un-deprecated source where it exists; the
  // cast is because it is not in the DOM lib this project builds against.
  const modern = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const raw = modern || navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(raw) ? "apple" : "windows";
}

/**
 * What a menu prints beside the command, or `null` when there is no binding.
 *
 * `null` rather than an empty string on purpose: the caller renders nothing at
 * all for it, and the rule is explicit that an item without a shortcut shows
 * nothing rather than an empty column.
 */
export function formatShortcut(id: ShortcutId, platform: ShortcutPlatform = SHORTCUT_PLATFORM): string | null {
  const primary = SHORTCUTS[id][0];
  return primary ? chordLabel(primary, platform) : null;
}

/** WAI-ARIA modifier names, which are their own vocabulary rather than the platform's. */
const ARIA_MODIFIER: Record<ModifierName, string> = {
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

const ARIA_MODIFIER_ORDER: readonly ModifierName[] = ["ctrl", "alt", "shift", "meta"];

/**
 * The `aria-keyshortcuts` value: every chord, space separated, each written as
 * WAI-ARIA specifies — modifier names from its own list, then the DOM `key`.
 *
 * This is the announcement route. The visible column is `aria-hidden` beside it,
 * so the keys are stated once, as a shortcut, rather than twice — once as a
 * shortcut and once as a stray fragment of text after the command's name.
 */
export function ariaKeyShortcuts(id: ShortcutId): string | null {
  const chords = SHORTCUTS[id];
  if (!chords.length) return null;
  return chords
    .map(chord => [
      ...ARIA_MODIFIER_ORDER.filter(name => chord[name]).map(name => ARIA_MODIFIER[name]),
      chord.key,
    ].join("+"))
    .join(" ");
}
