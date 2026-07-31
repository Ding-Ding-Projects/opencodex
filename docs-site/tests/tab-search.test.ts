/**
 * The four tab searches and the two bulk closes.
 *
 * The bulk-close cases are the ones that protect work. "Close tabs containing"
 * and "close tabs NOT containing" have to be exact inverses over the same rows,
 * with the same casing and the same flags — if they ever stop being inverses,
 * the pair silently closes tabs that neither action claims to. And the preview
 * the reader reviews has to be the set that actually closes, which is only true
 * while both read `bulkCloseTargets`.
 *
 * The registry cases cover presence, which is the part of a cross-window feature
 * that fails quietly: a window that is closed, discarded or frozen sends no
 * goodbye, and a search that never expires a peer offers the reader tabs in
 * windows that no longer exist.
 */

import { describe, expect, test } from "bun:test";
import {
  TAB_MATCH_FLAGS,
  bulkCloseTargets,
  closeOthersTargets,
  closeToRightTargets,
  tabMatcher,
  type Tab,
  type TabRow,
} from "../../shared/m3/tabs";
import { computePlacement, fixedPanelStyle } from "../../shared/m3/anchor";
import { livePeers, numberWindows, type WindowSnapshot } from "../../shared/m3/tab-registry";

const rows: TabRow[] = [
  { id: "a", label: "Docker", pinned: false },
  { id: "b", label: "Docker Compose", pinned: false },
  { id: "c", label: "CLI reference", pinned: true },
  { id: "d", label: "Providers", pinned: false },
];

const testOf = (query: string, regex = false, flags: string = TAB_MATCH_FLAGS) => {
  const matcher = tabMatcher(query, regex, flags);
  if (!matcher.ok) throw new Error(`expected a runnable matcher for ${JSON.stringify(query)}`);
  return matcher.test;
};

describe("the matcher every search bar compiles", () => {
  test("plain text is case-insensitive and literal", () => {
    expect(testOf("docker")("Docker Compose")).toBe(true);
    expect(testOf("c++")("C++ notes")).toBe(true);
  });

  test("an empty query is refused rather than treated as match-all", () => {
    const matcher = tabMatcher("   ", false);
    expect(matcher.ok).toBe(false);
    expect(matcher.ok === false && matcher.reason).toBe("empty");
  });

  test("an invalid pattern reports the engine's own message", () => {
    const matcher = tabMatcher("(unclosed", true);
    expect(matcher.ok).toBe(false);
    expect(matcher.ok === false && matcher.reason).toBe("invalid");
  });

  test("a global pattern does not go sticky between rows", () => {
    const test = testOf("o", true, "gi");
    expect(test("Docker")).toBe(true);
    expect(test("Docker")).toBe(true);
  });
});

describe("the two bulk closes", () => {
  test("containing closes what matches, minus the pinned tab", () => {
    expect(bulkCloseTargets(rows, testOf("docker"))).toEqual(["a", "b"]);
  });

  test("not-containing is the exact negation over the same rows", () => {
    const test = testOf("docker");
    const inside = bulkCloseTargets(rows, test);
    const outside = bulkCloseTargets(rows, test, { invert: true });
    const unpinned = rows.filter(r => !r.pinned).map(r => r.id);
    expect([...inside, ...outside].sort()).toEqual(unpinned.sort());
    expect(inside.some(id => outside.includes(id))).toBe(false);
  });

  test("a pin protects a tab from both actions by default", () => {
    expect(bulkCloseTargets(rows, testOf("cli"))).toEqual([]);
    expect(bulkCloseTargets(rows, testOf("zzz"), { invert: true })).not.toContain("c");
  });

  test("including pinned tabs is what it says", () => {
    expect(bulkCloseTargets(rows, testOf("cli"), { includePinned: true })).toEqual(["c"]);
  });

  test("a match-all leaves exactly one tab, and prefers the active one", () => {
    const all = bulkCloseTargets(rows, () => true, { includePinned: true, keepId: "d" });
    expect(all).toHaveLength(rows.length - 1);
    expect(all).not.toContain("d");
  });

  test("the preview and the close are the same call, so they cannot disagree", () => {
    const test = testOf("docker");
    expect(bulkCloseTargets(rows, test)).toEqual(bulkCloseTargets(rows, test));
  });

  test("a regex applies the same pin rule as plain text", () => {
    expect(bulkCloseTargets(rows, testOf("^doc", true, "i"))).toEqual(["a", "b"]);
  });
});

describe("the context-menu closes", () => {
  /* These take real tabs rather than the label/pin rows the bulk closes use:
     they are ordered operations over the strip, so they need the strip's order. */
  const tabs: Tab[] = rows.map(row => ({ id: row.id, page: `/${row.id}/`, pinned: row.pinned, label: row.label }));

  test("close-others spares pinned tabs", () => {
    expect(closeOthersTargets(tabs, "a")).toEqual(["b", "d"]);
  });

  test("close-to-the-right of an unknown id closes nothing", () => {
    expect(closeToRightTargets(tabs, "nope")).toEqual([]);
  });

  test("close-to-the-right is ordered, and still spares a pin", () => {
    expect(closeToRightTargets(tabs, "a")).toEqual(["b", "d"]);
  });
});

describe("anchored placement", () => {
  const viewport = { width: 430, height: 932 };
  const panel = { width: 480, height: 600 };

  test("a panel wider than a phone is pinned to the left edge, not pushed off both", () => {
    const anchor = { top: 60, bottom: 104, left: 380, right: 424 };
    const placement = computePlacement(anchor, panel, viewport);
    expect(placement.viewportLeft).toBeGreaterThanOrEqual(0);
    expect(placement.viewportLeft).toBeLessThanOrEqual(8);
  });

  test("a trigger near the bottom flips the panel above it", () => {
    const anchor = { top: 860, bottom: 904, left: 20, right: 64 };
    const placement = computePlacement(anchor, panel, viewport);
    expect(placement.side).toBe("above");
    const style = fixedPanelStyle(placement);
    expect(style.bottom).toBeDefined();
    expect(style.top).toBeUndefined();
  });

  test("a trigger at the top opens below it and is capped to the room there", () => {
    const anchor = { top: 8, bottom: 52, left: 20, right: 64 };
    const placement = computePlacement(anchor, panel, viewport);
    expect(placement.side).toBe("below");
    expect(placement.maxHeight).toBeLessThanOrEqual(viewport.height - anchor.bottom);
    const style = fixedPanelStyle(placement);
    expect(style.top).toBe(anchor.bottom + 8);
  });

  test("the anchor-relative left and the viewport left describe the same point", () => {
    const anchor = { top: 60, bottom: 104, left: 200, right: 244 };
    const placement = computePlacement(anchor, { width: 200, height: 300 }, { width: 1200, height: 900 });
    expect(placement.left + anchor.left).toBe(placement.viewportLeft);
  });
});

describe("the cross-window registry", () => {
  const peer = (id: string, openedAt: number, seenAt: number): WindowSnapshot =>
    ({ windowId: id, openedAt, seenAt, tabs: [], groups: [] });

  test("windows are numbered by when they opened, with this one included", () => {
    const numbers = numberWindows([peer("b", 200, 0), peer("c", 300, 0)], 100, "a");
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
    expect(numbers.get("c")).toBe(3);
  });

  test("a tie is broken by id, so the numbering is stable rather than arbitrary", () => {
    const first = numberWindows([peer("z", 100, 0)], 100, "a");
    const second = numberWindows([peer("z", 100, 0)], 100, "a");
    expect(first.get("a")).toBe(second.get("a"));
  });

  test("a peer that has stopped announcing is dropped", () => {
    const now = 100_000;
    const live = livePeers([peer("fresh", 0, now - 1_000), peer("gone", 0, now - 60_000)], now);
    expect(live.map(p => p.windowId)).toEqual(["fresh"]);
  });
});
