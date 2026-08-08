/**
 * Press-and-hold, as the touch equivalent of right-click.
 *
 * Every "Edit appearance…" surface in this shell is reached by `contextmenu`,
 * which on a phone is not reachable at all: there is no second button and no
 * modifier key. A held press is the gesture users already expect to mean "show
 * me what else this thing can do", so that is what it is wired to — the same
 * handler right-click opens, not a parallel touch-only one.
 *
 * ## Fighting the browser, on purpose
 *
 * A long press on a touch screen already means three things to the browser:
 * start a text selection, show the selection callout, and (on Android) open the
 * native context menu. All three fire while the finger is still down, so a
 * naive `setTimeout` handler opens our panel *underneath* the platform's own
 * menu and leaves a blue selection highlight behind it.
 *
 * So the default is suppressed deliberately, and narrowly:
 *
 *  - `touch-action: manipulation` and `user-select: none` are set on the target
 *    (via `longPressStyle`), which is what actually stops the selection and the
 *    iOS callout. `-webkit-touch-callout` is included for older iOS, where
 *    `user-select` alone does not suppress it.
 *  - `contextmenu` is prevented **only while a touch press is in flight**. The
 *    rest of the app keeps the browser's own menu, because a shell that swallows
 *    right-click everywhere takes away Copy and Inspect for the sake of one
 *    gesture — the same rule the tab strip already follows for the mouse.
 *
 * ## What does NOT trigger it
 *
 *  - **A mouse.** `pointerType === "mouse"` is ignored outright: a mouse has
 *    right-click already, and arming a timer on mouse-down would fire the menu
 *    in the middle of dragging a tab to reorder it.
 *  - **A scroll.** Movement past `MOVE_TOLERANCE_PX` cancels, because a flick
 *    that starts on a tab is a scroll, not a press. Without this the strip opens
 *    a menu every time somebody scrolls the page with a thumb on it.
 *
 * The keyboard path is not here and does not need to be: `Shift+F10` and the
 * `ContextMenu` key already open the same menus, and this adds a gesture rather
 * than replacing a route.
 */

import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

/** How long the finger must stay down. Matches the platform convention. */
export const LONG_PRESS_MS = 500;
/** Past this much movement it is a scroll, not a press. */
export const MOVE_TOLERANCE_PX = 10;

/**
 * The style a long-press target needs.
 *
 * Exported as an object rather than a class because the targets are a mix of
 * shell chrome with its own stylesheet rules and elements styled inline; a
 * single spread works for both, and there is no cascade order to lose an
 * argument with.
 */
export const longPressStyle: CSSProperties = {
  touchAction: "manipulation",
  userSelect: "none",
  WebkitUserSelect: "none",
  // Not in React's CSSProperties, and the one property that actually suppresses
  // the iOS selection callout on an element that is not an input.
  WebkitTouchCallout: "none",
} as CSSProperties;

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
  style: CSSProperties;
}

/**
 * @param onLongPress Called with the viewport point the finger was held at, so
 *   the caller can anchor exactly where right-click would have.
 */
export function useLongPress(
  onLongPress: (x: number, y: number) => void,
  options: { delayMs?: number; enabled?: boolean } = {},
): LongPressHandlers {
  const { delayMs = LONG_PRESS_MS, enabled = true } = options;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** True from the moment a touch press arms until the gesture is over, so the
   * `contextmenu` suppression is scoped to this gesture and nothing else. */
  const pressing = useRef(false);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    origin.current = null;
    pressing.current = false;
  }, []);

  // A component unmounting mid-press must not leave a timer that fires into a
  // handler closing over state that is gone.
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    // A mouse has right-click; arming here would also fire mid-drag.
    if (!enabled || event.pointerType === "mouse") return;
    cancel();
    fired.current = false;
    pressing.current = true;
    origin.current = { x: event.clientX, y: event.clientY };
    const { clientX, clientY } = event;
    // `onLongPress` is closed over rather than read from a ref: the callback
    // that matters is the one live when the press *started*, and callers pass a
    // `useCallback` so this is stable across renders anyway.
    timer.current = setTimeout(() => {
      timer.current = null;
      fired.current = true;
      onLongPress(clientX, clientY);
    }, delayMs);
  }, [cancel, delayMs, enabled, onLongPress]);

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    const start = origin.current;
    if (!start || timer.current === null) return;
    if (Math.abs(event.clientX - start.x) > MOVE_TOLERANCE_PX
      || Math.abs(event.clientY - start.y) > MOVE_TOLERANCE_PX) {
      cancel();
    }
  }, [cancel]);

  const onPointerUp = useCallback(() => {
    // `pressing` stays true for the rest of the event loop turn so the
    // `contextmenu` the platform fires *after* the finger lifts is still
    // suppressed; clearing it here would let that one through.
    const didFire = fired.current;
    cancel();
    pressing.current = didFire;
  }, [cancel]);

  const onContextMenu = useCallback((event: { preventDefault: () => void }) => {
    // Only a touch gesture's own menu is swallowed. A right-click arrives with
    // no press in flight and is left entirely alone, so the surfaces that want
    // to handle it still can and the ones that do not keep the browser's.
    if (pressing.current) event.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: cancel,
    onContextMenu,
    style: longPressStyle,
  };
}
