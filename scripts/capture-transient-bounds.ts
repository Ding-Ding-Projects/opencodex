/**
 * Whether a corner surface's own measured geometry proves it is genuinely on
 * screen — pure, so it can be tested directly rather than only by trusting
 * `capture-shots.ts`'s much larger integration run.
 *
 * ## Why this exists
 *
 * `capture-shots.ts`'s `PROBE` already answers "is a corner surface (a toast,
 * the dim sum card) visible, and does its *text* say what the target expects".
 * That is a DOM-visibility question — `display`, `visibility`, `opacity`,
 * `aria-hidden` — and it says nothing about *where* the surface sits relative
 * to the window PrintWindow is about to photograph. A `position: fixed`
 * corner surface is never supposed to need this: `bottom: 16px; right: 16px`
 * cannot geometrically produce a box outside the viewport. But "cannot
 * geometrically happen" is exactly the kind of claim this project's own
 * screenshot harness exists to stop trusting on its own — the module doc
 * comment at the top of `capture-shots.ts` is a whole file of examples where
 * "looks right" and "is right" came apart, and `assets/shots/dimsum.png` was
 * a fresh one: a properly `position: fixed`, correctly laid-out dim sum card,
 * captured with its bottom edge past the window's own bottom edge, and
 * nothing in the harness noticed because nothing checked.
 *
 * So this is the missing check: after the probe finds a transient element and
 * confirms its text, `capture-shots.ts` also asks this function whether that
 * element's own `getBoundingClientRect()` actually fits inside the window it
 * is about to be photographed against. A `null` result means it fits; a
 * string means it does not, and names the edge and the overflow so the
 * failure is actionable rather than "the corner surface is loitering" with no
 * further detail.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * `null` when `rect` sits fully inside `[0, viewport.width] x [0, viewport.height]`.
 * Otherwise, a human-readable reason naming which edge overflows and by how
 * much — the four checks are independent (not `else if`) only in the sense
 * that each is reported on its own terms; the first one found is returned,
 * because a single overflowing rect rarely wants more than one explanation at
 * a time and a caller that wants every violation can call this repeatedly
 * against shrunk viewports if it ever needs to.
 */
export function transientOutOfBounds(rect: Rect, viewport: Size): string | null {
  if (rect.w <= 0 || rect.h <= 0) return `has a ${rect.w}x${rect.h} box, so nothing was actually laid out`;
  if (rect.x < 0) return `left edge is ${rect.x}px, ${-rect.x}px off the left edge of the ${viewport.width}px-wide window`;
  if (rect.y < 0) return `top edge is ${rect.y}px, ${-rect.y}px off the top edge of the ${viewport.height}px-tall window`;
  const right = rect.x + rect.w;
  if (right > viewport.width) {
    return `right edge is ${right}px, ${right - viewport.width}px past the ${viewport.width}px-wide window`;
  }
  const bottom = rect.y + rect.h;
  if (bottom > viewport.height) {
    return `bottom edge is ${bottom}px, ${bottom - viewport.height}px past the ${viewport.height}px-tall window — this is exactly how the dim sum card got captured hanging off the frame`;
  }
  return null;
}

/** CSS-pixel rect to the device-pixel rect PrintWindow's bitmap is measured in. */
export function toDevicePixels(rect: Rect, scale: number): Rect {
  return { x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), w: Math.round(rect.w * scale), h: Math.round(rect.h * scale) };
}
