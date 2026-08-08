/**
 * "A press landed outside this panel" — for every anchored, non-modal surface.
 *
 * Each of them dismissed on `mousedown` alone, which is a mouse-only contract.
 * A touch that a browser does not synthesise a mouse event for — and it is under
 * no obligation to, particularly once a `touch-action` or a long-press handler
 * is in play — never reached those listeners, so on a phone the menus, the
 * bulk-close confirmation and the appearance editors stayed open until something
 * inside them was pressed. An anchored surface that cannot be dismissed by
 * tapping past it is a modal that never said so.
 *
 * Both events are registered rather than picking one. `pointerdown` is the
 * event that actually covers mouse, touch and pen, but `mousedown` stays for two
 * reasons: a browser without Pointer Events still has to be able to close a
 * menu, and the existing tests dispatch a `MouseEvent` because that is what the
 * surfaces used to listen for. Firing the callback twice is harmless — every
 * caller's handler is "close this", which is idempotent — and that is cheaper
 * than a capability check that would be wrong on exactly one browser.
 */

/**
 * Registers the listeners and returns the matching cleanup.
 *
 * The handler keeps the `MouseEvent` signature every caller already had —
 * `PointerEvent` extends it, so the same function serves both and no call site
 * had to change shape to gain touch support.
 */
export function onOutsidePress(handler: (event: MouseEvent) => void): () => void {
  document.addEventListener("pointerdown", handler);
  document.addEventListener("mousedown", handler);
  return () => {
    document.removeEventListener("pointerdown", handler);
    document.removeEventListener("mousedown", handler);
  };
}
