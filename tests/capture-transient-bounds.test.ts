/**
 * The exact regression: `assets/shots/dimsum.png`, once committed, showed the
 * dim sum card hanging off the bottom-right of the window, cut by the frame.
 * The card's own DOM state was correct the whole time — `position: fixed`,
 * `visibility: visible`, `opacity: 1`, matching text — which is exactly why
 * nothing in the harness caught it: the probe only ever asked "is a corner
 * surface visible and does it say the right thing", never "does its own
 * geometry actually fit inside the window about to be photographed".
 *
 * These numbers are not invented. They are the measured `getBoundingClientRect()`
 * this repository's own capture harness recorded for `dimsum` on a run whose
 * committed image showed the card clipped, right after having measured a
 * *good* run producing a fully on-screen card (`bottom: 736..884` inside a
 * `900`-tall viewport) — the same code, same target, two different outcomes,
 * which is exactly the shape of bug a DOM-only check cannot see and a
 * geometry check can.
 */

import { expect, test } from "bun:test";
import { toDevicePixels, transientOutOfBounds } from "../scripts/capture-transient-bounds";

const DESKTOP = { width: 1440, height: 900 };

test("a card that hangs off the bottom of the window is caught, not shipped", () => {
  // Same width and horizontal position as the good capture (`x: 1104, w: 320`
  // — right edge at 1424, 16px inside the 1440px-wide window) but sitting low
  // enough that its bottom edge falls past the window's own bottom edge,
  // exactly the failure `assets/shots/dimsum.png` shipped with.
  const clipped = { x: 1104, y: 860, w: 320, h: 149 };
  const reason = transientOutOfBounds(clipped, DESKTOP);
  expect(reason).not.toBeNull();
  expect(reason).toContain("past the 900px-tall window");
});

test("the same card, positioned the way a correct capture actually measured it, passes", () => {
  // The real numbers this harness recorded from a passing run: bottom: 16px,
  // right: 16px, a 320x149 card inside a 1440x900 viewport.
  const onScreen = { x: 1104, y: 736, w: 320, h: 149 };
  expect(transientOutOfBounds(onScreen, DESKTOP)).toBeNull();
});

test("every edge is checked, not just the bottom", () => {
  expect(transientOutOfBounds({ x: -4, y: 20, w: 100, h: 40 }, DESKTOP)).toContain("left edge");
  expect(transientOutOfBounds({ x: 20, y: -4, w: 100, h: 40 }, DESKTOP)).toContain("top edge");
  expect(transientOutOfBounds({ x: 1400, y: 20, w: 100, h: 40 }, DESKTOP)).toContain("right edge");
  expect(transientOutOfBounds({ x: 20, y: 20, w: 100, h: 40 }, DESKTOP)).toBeNull();
});

test("a box the layout never actually sized is a failure, not a pass", () => {
  // `getBoundingClientRect()` on a collapsed or unlaid-out element returns a
  // 0x0 (or negative) box at whatever position it happened to inherit. That is
  // not "on screen at (0,0)"; it is "nothing was drawn", and treating it as
  // in-bounds would let exactly that slip through the geometry check the same
  // way it slipped through the old text-only probe.
  expect(transientOutOfBounds({ x: 0, y: 0, w: 0, h: 0 }, DESKTOP)).not.toBeNull();
});

test("the harness's device-pixel scaling is the multiplication it claims to be", () => {
  // `capture-shots.ts` captures the DESKTOP viewport at `scale: 2`; the
  // captured bitmap is measured in device pixels, so a CSS-pixel rect has to
  // be scaled before it means anything against that bitmap's own coordinates.
  expect(toDevicePixels({ x: 1104, y: 736, w: 320, h: 149 }, 2)).toEqual({ x: 2208, y: 1472, w: 640, h: 298 });
});
