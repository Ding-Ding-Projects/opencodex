/**
 * The bottom nav's four labels must not be able to grow past their own track.
 *
 * ## What actually broke
 *
 * `.m3-bottom-nav` is a CSS grid of four `1fr` tracks. `.m3-nav-label` already
 * declared `overflow: hidden; text-overflow: ellipsis`, but a grid item's
 * `min-width` defaults to `auto` — "never shrink below your own content" — so
 * at bilingual widths ("Codex Auth · Codex 登入" and friends) every item grew
 * past its track instead of clipping. The labels ran into each other with no
 * gap and the fourth fell off the right edge of the screen. Invisible in
 * English, where the labels are short enough that `auto`'s refusal to shrink
 * never mattered.
 *
 * The fix needs BOTH declarations, not either alone — proven empirically,
 * not assumed: dropping the grid item's `min-width: 0` alone leaves the four
 * items' own boxes overflowing the viewport again; dropping the label's
 * `min-width: 0` alone leaves the label spilling out of its now-correctly-
 * sized item and colliding with its neighbour's text. Both were watched fail
 * red and pass green independently with
 * `AUDIT_WIDTH=320 bun run scripts/bottom-nav-overflow-audit.ts` before this
 * comment was written.
 *
 * ## Why this is the cheap half, not the real check
 *
 * happy-dom, which this suite runs on, has no layout engine — every
 * `getBoundingClientRect` it returns is a stub (see the doc comment atop
 * `mobile-shell.test.tsx`). A test built on that stub cannot tell a working
 * `min-width: 0` from a deleted one; it can only confirm the CSS text is
 * present, which is true whether or not the rule does anything. That is
 * exactly the gap `scripts/bottom-nav-overflow-audit.ts` exists to close: it
 * loads the real built dashboard in headless Chrome, in bilingual mode, at a
 * phone width, and measures every nav item's and every label's real
 * `getBoundingClientRect` — asserting no two items overlap, no label spills
 * past its own item, and nothing extends past the viewport edge. That script,
 * not this file, is the proof the fix works.
 *
 * This file is the same "cheap half, real audit elsewhere" split
 * `touch-target-floor.test.ts` already uses for the 48dp touch-target floor:
 * a fast, always-on guard against the *specific* regression that actually
 * happened, so a copy-paste or a "simplify this rule" pass cannot quietly
 * delete the fix between audits.
 *
 *   bun run build:gui
 *   AUDIT_WIDTH=320 bun run scripts/bottom-nav-overflow-audit.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SHELL_CSS = readFileSync(new URL("../src/styles/m3-shell.css", import.meta.url), "utf8");

/** The exact rule block for the bottom nav's grid item, isolated by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(SHELL_CSS);
  if (!match) throw new Error(`no rule found for ${selector} in m3-shell.css`);
  return match[1];
}

describe("the bottom nav cannot overflow its own track", () => {
  test("this test is actually looking at the stylesheet", () => {
    // Guard the guard: a stylesheet that shrank to nothing would pass every
    // assertion below vacuously.
    expect(SHELL_CSS.length).toBeGreaterThan(10_000);
    expect(SHELL_CSS).toContain(".m3-bottom-nav");
  });

  test("the grid item releases the default min-width: auto that grid items get", () => {
    // Without this, `.m3-bottom-nav .m3-nav-item` refuses to shrink below its
    // own content's width and grows past its `1fr` track — this is the half
    // of the bug that pushed the fourth item off the screen edge.
    expect(rule(".m3-bottom-nav .m3-nav-item")).toMatch(/min-width\s*:\s*0\b/);
  });

  test("the label releases the same default inside its own flex column", () => {
    // `.m3-nav-item` is `display: flex; flex-direction: column` in the
    // bottom nav, and the label is a flex item along that column's cross
    // axis. Proven empirically (not assumed from the spec) that Chrome's
    // flex layout gives it the SAME automatic minimum-size refusal the grid
    // item gets: fixing only the item above and leaving this rule as
    // `font-size: var(--t-label-m)` still failed the real-layout audit, with
    // every label spilling out of its own (now correctly narrow) item and
    // overlapping its neighbour's text — the exact "ran into each other with
    // no gap" symptom, just moved one level down.
    const label = rule(".m3-bottom-nav .m3-nav-label");
    expect(label).toMatch(/min-width\s*:\s*0\b/);
    expect(label).toMatch(/max-width\s*:\s*100%/);
  });

  test("the label still declares the ellipsis it inherits, so clipping is visible rather than silent", () => {
    // `.m3-nav-label` (the base rule, not the bottom-nav override) is what
    // actually asks for `text-overflow: ellipsis`; the bottom-nav rule only
    // needs to make sure the box that rule clips actually gets constrained.
    // If this ever stops being inherited, a bilingual label that is now
    // correctly boxed would still just clip flush with no "…" to say so.
    const base = rule(".m3-nav-label");
    expect(base).toContain("overflow: hidden");
    expect(base).toContain("text-overflow: ellipsis");
  });

  test("the real-layout audit this guard defers to is checked in", () => {
    // The cheap half above cannot prove the CSS actually constrains anything
    // in a real engine — see the module doc comment. Fail loudly if the
    // script it defers to is ever deleted out from under it.
    const script = readFileSync(new URL("../../scripts/bottom-nav-overflow-audit.ts", import.meta.url), "utf8");
    expect(script).toContain("m3-bottom-nav");
    expect(script.length).toBeGreaterThan(1_000);
  });
});
