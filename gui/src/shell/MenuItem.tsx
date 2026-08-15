/**
 * The one menu row in this app, and the shortcut column it carries.
 *
 * Every `role="menuitem*"` button in the shell renders through `MenuItem` — the
 * tab strip's context menu and its group, overflow and new-tab menus, the
 * element appearance chain menu, the account switcher, the cost-range menu and
 * the viewport picker. That is not tidiness: the rule is that *every*
 * context-menu item with a keyboard shortcut displays it, and a rule enforced by
 * remembering to add a column is a rule that lapses the first time somebody adds
 * a menu. Rendering the column from one place makes it structural — a new menu
 * gets it by construction, and giving an existing command a binding is a single
 * `shortcut` prop rather than an edit in two files that can disagree.
 *
 * Nothing is padded. An item with no binding renders no column at all, so a menu
 * whose commands have no shortcuts looks exactly as it did before — no empty
 * gutter, no placeholder dash.
 *
 * ## Said once, not twice
 *
 * The visible column is `aria-hidden`, and the keys reach assistive technology
 * through `aria-keyshortcuts` on the button instead. Both is the failure mode
 * worth naming: a screen reader that reads the button's whole text content
 * announces "Close tab Del" and then announces the shortcut properly a moment
 * later, so the one user who most needs the information hears it twice, once in
 * a form that is not a shortcut at all.
 */

import type { ComponentProps } from "react";
import { useT } from "../i18n/shared";
import { ariaKeyShortcuts, formatShortcut, type ShortcutId } from "./shortcuts";

/**
 * `aria-keyshortcuts` for a command, or nothing when it has no binding.
 *
 * Spread onto the control the shortcut actually operates — which is not always
 * the row itself. In the overflow menu the row activates a tab and the ✕ beside
 * it closes one, and Delete does the second, so the attribute belongs on the ✕.
 */
export function menuShortcutProps(shortcut?: ShortcutId): { "aria-keyshortcuts"?: string } {
  const value = shortcut ? ariaKeyShortcuts(shortcut) : null;
  return value ? { "aria-keyshortcuts": value } : {};
}

/**
 * The visible, right-aligned key notation. Renders nothing without a binding.
 *
 * The tooltip is the only translated string here. The keys themselves are
 * keyboard legends and stay literal in every language — but "Del" on its own is
 * a two-letter abbreviation with no context, and a reader who does not already
 * know what that column is has nothing to go on. The tooltip says what it is,
 * in their language, without adding a second announcement: `aria-hidden` keeps
 * the whole element, `title` included, out of the accessibility tree.
 */
export function MenuShortcut({ shortcut }: { shortcut?: ShortcutId }) {
  const t = useT();
  const keys = shortcut ? formatShortcut(shortcut) : null;
  if (!keys) return null;
  return (
    <span className="m3-menu-shortcut" aria-hidden="true" title={t("menu.shortcut", { keys })}>
      {keys}
    </span>
  );
}

export type MenuItemProps = ComponentProps<"button"> & {
  /**
   * The command this row runs, when it has a keyboard binding.
   *
   * Leave it off when it does not. Every id here must be one the handler for
   * *this* surface actually matches on: a shortcut that only fires while some
   * other surface has focus is the wrong shortcut, and a menu is where a user
   * learns it, so getting it wrong teaches a keystroke that does nothing.
   */
  shortcut?: ShortcutId;
};

export function MenuItem({ shortcut, children, className, ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      className={className ?? "m3-menu-item"}
      {...menuShortcutProps(shortcut)}
      {...rest}
    >
      {children}
      <MenuShortcut shortcut={shortcut} />
    </button>
  );
}
