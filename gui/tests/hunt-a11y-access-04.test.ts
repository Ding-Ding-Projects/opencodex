/**
 * ACCESS-04: reordering a tab has exactly one way in, native HTML5
 * drag-and-drop, and that interaction model has no keyboard equivalent at
 * all in any browser.
 *
 * `TabStrip.tsx` gives each tab row `draggable` plus `onDragStart` /
 * `onDragOver` / `onDrop` (around line 981), and the drop handler
 * (`onDrop={e => { e.preventDefault(); if (dragId) tabs.moveTab(dragId, tab.id); ... }}`)
 * is the only place in the whole `gui/src` tree that calls `tabs.moveTab(...)`,
 * confirmed with `git grep -n "moveTab(" gui/src`, which returns exactly
 * that one call site plus the function's own definition in `use-tabs.ts`.
 *
 * The strip already has a real, working keyboard layer for everything else on
 * it: the `role="tablist"` keydown handler moves focus with ArrowLeft/
 * ArrowRight/Home/End, opens the context menu on Shift+F10, and closes the
 * active tab on its registered shortcut (around line 835). So this is not a
 * strip that ignores the keyboard generally; it is one specific action,
 * changing a tab's position, that a keyboard-only or switch-access user
 * cannot reach by any means today. Tab order is not cosmetic: pinning,
 * groups and the overflow menu are all built to preserve it, and drag is the
 * sole write path to it.
 *
 * This does not assume what shape a fix takes. A keyboard shortcut, or a
 * "Move left/right" row added to the tab's own context menu, both end up
 * calling `tabs.moveTab` from a second, new call site. It only asks whether
 * more than the one known pointer-only route exists. Today it does not.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TAB_STRIP = fileURLToPath(new URL("../src/shell/TabStrip.tsx", import.meta.url));

/** The exact, current, pointer-only call site: reordering's only route in today. */
const KNOWN_POINTER_ONLY_CALL =
  "onDrop={e => { e.preventDefault(); if (dragId) tabs.moveTab(dragId, tab.id); setDragId(null); setDropId(null); }}";

test("moveTab has a route in besides the one pointer-only drag-and-drop call site", () => {
  const text = readFileSync(TAB_STRIP, "utf8");
  expect(text).toContain(KNOWN_POINTER_ONLY_CALL);

  const callSites = [...text.matchAll(/\btabs\.moveTab\(/g)];
  expect(callSites.length).toBeGreaterThan(0);

  // Today this is exactly 1: the pointer-only onDrop handler above, and
  // nothing else in the file ever calls tabs.moveTab. A keyboard-only or
  // switch-access user therefore has no way to change a tab's position. A
  // correct fix adds a second, keyboard-reachable call site (a shortcut, a
  // context-menu command), and once it does this count rises to 2 or more
  // so the assertion below turns green.
  expect(callSites.length).toBeGreaterThan(1);
});
