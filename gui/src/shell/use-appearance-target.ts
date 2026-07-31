/**
 * Marks a piece of chrome as editable, and gives it the three routes in.
 *
 * Spread the result onto the element:
 *
 * ```tsx
 * <aside className="m3-nav" {...useAppearanceTarget("navRail")}>
 * ```
 *
 * and that element gains all three of the required entry points at once:
 *
 *  - **Right-click** (`contextmenu` from a mouse), the desktop route.
 *  - **Press and hold**, the touch route — see `use-long-press.ts` for why the
 *    platform's own selection and callout have to be suppressed for it.
 *  - **Shift+F10 / the ContextMenu key**, the keyboard route, which is the one
 *    that is easiest to forget and the only one some users have. It is here
 *    rather than left to each call site precisely so it cannot be forgotten:
 *    one hook, three routes, no surface that accidentally ships two of them.
 *
 * The element also gets `data-m3-el`, which is what the appearance system
 * already uses to find a styled surface, so marking a target and styling it are
 * the same act rather than two lists that can disagree.
 *
 * ## Why the editor opens directly, with no menu in between
 *
 * A tab's right-click menu has ten commands and appearance is one of them. A nav
 * rail's has exactly one, so a menu there is a dialog whose only content is a
 * button that opens another dialog. The editor opens straight away instead, and
 * that is also what makes the touch route worth having: a held press on a phone
 * lands on the thing being edited rather than on a menu about it.
 */

import { useCallback, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useElementAppearance } from "./element-appearance-context";
import { useLongPress } from "./use-long-press";

export interface AppearanceTargetProps {
  "data-m3-el": string;
  onContextMenu: (event: ReactMouseEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  style?: CSSProperties;
}

export function useAppearanceTarget(id: string, options: { style?: CSSProperties } = {}): AppearanceTargetProps {
  const { open } = useElementAppearance();
  const host = useRef<HTMLElement | null>(null);

  const openFrom = useCallback((element: HTMLElement | null) => {
    host.current = element;
    open(id, element);
  }, [id, open]);

  const longPress = useLongPress(useCallback(() => {
    // The element the gesture started on, not the deepest child under the
    // finger: the panel anchors to the surface being styled, and anchoring it
    // to a label inside that surface would place it somewhere the user did not
    // press.
    openFrom(host.current);
  }, [openFrom]));

  return {
    "data-m3-el": id,
    onContextMenu: (event: ReactMouseEvent) => {
      // Let the long-press hook swallow the menu the platform fires at the end
      // of a touch gesture; a genuine right-click falls through to us.
      longPress.onContextMenu(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      openFrom(event.currentTarget as HTMLElement);
    },
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      // A more specific handler inside this surface wins. The tab strip is the
      // case that matters: Shift+F10 on a *tab* opens that tab's menu, and its
      // handler calls `preventDefault`, so by the time the event reaches the
      // strip it is already spoken for.
      //
      // The alternative — only firing when the key was pressed on this element
      // itself — reads tidier and is wrong: a nav rail's buttons are the only
      // things in it that can hold focus, so requiring focus on the container
      // would leave the rail with no keyboard route at all.
      if (event.defaultPrevented) return;
      event.preventDefault();
      openFrom(event.currentTarget as HTMLElement);
    },
    onPointerDown: (event: React.PointerEvent) => {
      host.current = event.currentTarget as HTMLElement;
      longPress.onPointerDown(event);
    },
    onPointerMove: longPress.onPointerMove,
    onPointerUp: longPress.onPointerUp,
    onPointerCancel: longPress.onPointerCancel,
    style: { ...longPress.style, ...options.style },
  };
}
