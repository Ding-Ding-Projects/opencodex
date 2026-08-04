/**
 * Tab groups and the four tab searches, at the pure layer.
 *
 * Everything here runs without React, because the cases that matter are the
 * ones a rendered assertion is worst at reaching: a tab pinned inside a
 * collapsed group, a group whose members were persisted out of order, a master
 * search unioning a window that has stopped answering. Mounting a strip to ask
 * "does the collapsed preference survive a search" tests the strip; asking the
 * reducer tests the promise.
 *
 * The cases chosen are the ones where a plausible implementation passes
 * everything else and still loses something the user set: a collapse that hides
 * a pinned tab, a pin that empties the group it was applied to, a reveal that
 * unfolds the group it was told not to, and a search that answers an empty query
 * with nothing.
 */

import { expect, test } from "bun:test";
import {
  createGroup, assignGroup, groupPinState, moveGroup, orderTabs, removeGroup, reviveTabs,
  setGroupDecor, setGroupPinned, toggleGroupCollapsed, togglePin, visibleTabs,
  groupDecorProps, readGroupDecor, moveTab,
  type Tab, type TabsState,
} from "../../shared/m3/tabs";
import {
  groupResults, masterResults, matchRows, revealsWithoutExpanding, stripResults, tabMatcher,
  type StripSnapshot, type TabResult,
} from "../src/shell/use-tabs";
import type { Page } from "../src/app-routing";

const PAGES: Page[] = ["dashboard", "providers", "models", "combos", "logs"];

const tab = (n: number, extra: Partial<Tab<Page>> = {}): Tab<Page> =>
  ({ id: `t${n}`, page: PAGES[n - 1], pinned: false, ...extra });

const state = (tabs: Tab<Page>[], groups: TabsState<Page>["groups"] = [], activeTab = tabs[0]?.id ?? ""): TabsState<Page> =>
  ({ tabs, groups, activeTab });

const group = (id: string, extra: Partial<TabsState<Page>["groups"][number]> = {}) =>
  ({ id, name: id, collapsed: false, ...extra });

const labelOf = (t: Tab<Page>) => t.page;

/* ------------------------------------------------------------- membership -- */

test("a group's members are drawn together however they were added", () => {
  const tabs = [tab(1, { groupId: "g1" }), tab(2), tab(3, { groupId: "g1" })];
  expect(orderTabs(tabs).map(t => t.id)).toEqual(["t1", "t3", "t2"]);
});

test("creating a group takes the tabs named and nothing else", () => {
  const next = createGroup(state([tab(1), tab(2), tab(3)]), "g1", "Staging", ["t1", "t3"]);
  expect(next.groups.map(g => g.name)).toEqual(["Staging"]);
  expect(next.tabs.filter(t => t.groupId === "g1").map(t => t.id)).toEqual(["t1", "t3"]);
});

test("removing a group frees its tabs rather than closing them", () => {
  const before = createGroup(state([tab(1), tab(2)]), "g1", "Staging", ["t1", "t2"]);
  const after = removeGroup(before, "g1");
  expect(after.groups).toEqual([]);
  // The tabs are the point. A "remove group" that took the tabs with it would be
  // a bulk close wearing another name.
  expect(after.tabs.map(t => t.id)).toEqual(["t1", "t2"]);
  expect(after.tabs.every(t => t.groupId === undefined)).toBe(true);
});

test("a tab cannot be assigned to a group that does not exist", () => {
  const before = state([tab(1)]);
  expect(assignGroup(before, "t1", "ghost")).toBe(before);
});

test("dropping a tab onto a member adopts that member's group", () => {
  const before = createGroup(state([tab(1), tab(2), tab(3)]), "g1", "Staging", ["t2"]);
  const after = moveTab(before, "t3", "t2");
  expect(after.tabs.find(t => t.id === "t3")?.groupId).toBe("g1");
});

/* -------------------------------------------------------------- collapsing -- */

test("a collapsed group hides its members but never the active tab", () => {
  const s = state(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g1" }), tab(3)],
    [group("g1", { collapsed: true })],
    "t1",
  );
  expect(visibleTabs(s).map(t => t.id)).toEqual(["t1", "t3"]);
  expect(visibleTabs({ ...s, activeTab: "t3" }).map(t => t.id)).toEqual(["t3"]);
});

test("collapsing a group moves the selection out of it", () => {
  const s = state([tab(1, { groupId: "g1" }), tab(2)], [group("g1")], "t1");
  expect(toggleGroupCollapsed(s, "g1").activeTab).toBe("t2");
});

// A pin is a promise that the tab stays on screen. A collapse that broke it
// would make the two features quietly incompatible, and the user would find out
// by watching a pinned tab disappear.
test("a collapse never hides a pinned member, and never moves the selection off one", () => {
  const s = state(
    [tab(1, { groupId: "g1", pinned: true }), tab(2, { groupId: "g1" }), tab(3)],
    [group("g1", { collapsed: true })],
    "t3",
  );
  expect(visibleTabs(s).map(t => t.id)).toEqual(["t1", "t3"]);

  const open = state(
    [tab(1, { groupId: "g1", pinned: true }), tab(2, { groupId: "g1" })],
    [group("g1")],
    "t1",
  );
  expect(toggleGroupCollapsed(open, "g1").activeTab).toBe("t1");
});

/* ------------------------------------------------------------------ pinning -- */

// Pinning a group has to be reversible to mean anything. A pin that erased
// membership would empty the group as it was applied, leaving nothing to unpin
// back into — the tabs would return loose and the grouping would be gone.
test("pinning a whole group is reversible, because membership survives the pin", () => {
  const before = createGroup(state([tab(1), tab(2), tab(3)]), "g1", "Staging", ["t1", "t2"]);
  const pinned = setGroupPinned(before, "g1", true);

  expect(pinned.tabs.filter(t => t.pinned).map(t => t.id).sort()).toEqual(["t1", "t2"]);
  expect(groupPinState(pinned.tabs, "g1")).toBe("all");
  // Still members, so the group is not empty and the accent still describes them.
  expect(pinned.tabs.filter(t => t.groupId === "g1").length).toBe(2);
  // And pinned tabs sort ahead of the group's run rather than into it.
  expect(pinned.tabs.slice(0, 2).every(t => t.pinned)).toBe(true);

  const loose = setGroupPinned(pinned, "g1", false);
  expect(loose.tabs.filter(t => t.pinned)).toEqual([]);
  expect(loose.tabs.filter(t => t.groupId === "g1").map(t => t.id).sort()).toEqual(["t1", "t2"]);
});

test("a half-pinned group reports itself as such, so one control can decide which way to go", () => {
  const s = createGroup(state([tab(1), tab(2)]), "g1", "Staging", ["t1", "t2"]);
  expect(groupPinState(s.tabs, "g1")).toBe("none");
  expect(groupPinState(togglePin(s, "t1").tabs, "g1")).toBe("some");
  expect(groupPinState(setGroupPinned(s, "g1", true).tabs, "g1")).toBe("all");
  // A group nobody is in is not "all pinned" on a technicality.
  expect(groupPinState([], "g1")).toBe("none");
});

test("pinning one tab keeps its group, so unpinning puts it back", () => {
  const s = createGroup(state([tab(1), tab(2)]), "g1", "Staging", ["t1"]);
  const pinned = togglePin(s, "t1");
  expect(pinned.tabs.find(t => t.id === "t1")?.groupId).toBe("g1");
  expect(togglePin(pinned, "t1").tabs.find(t => t.id === "t1")?.groupId).toBe("g1");
});

/* ------------------------------------------------------------------ ordering -- */

test("reordering the group list moves each group's run of tabs with it", () => {
  let s = createGroup(state([tab(1), tab(2), tab(3), tab(4)]), "g1", "One", ["t1"]);
  s = createGroup(s, "g2", "Two", ["t3"]);
  const moved = moveGroup(s, "g2", "g1");

  expect(moved.groups.map(g => g.id)).toEqual(["g2", "g1"]);
  // Both halves, or the header list and the strip would be two different answers
  // to the same question.
  expect(moved.tabs.findIndex(t => t.id === "t3")).toBeLessThan(moved.tabs.findIndex(t => t.id === "t1"));
});

/* -------------------------------------------------------------- persistence -- */

test("the whole structure survives a round trip through storage", () => {
  let s = createGroup(state([tab(1), tab(2), tab(3)]), "g1", "Staging", ["t1", "t2"]);
  s = setGroupDecor(s, "g1", { icon: "🚧", radius: 6, borderStyle: "dashed", separator: "line", caps: true });
  s = toggleGroupCollapsed(s, "g1");

  const revived = reviveTabs(JSON.parse(JSON.stringify(s)), (v): v is Page => PAGES.includes(v as Page), "dashboard");

  expect(revived.groups[0].name).toBe("Staging");
  expect(revived.groups[0].collapsed).toBe(true);
  expect(revived.groups[0].decor).toEqual({
    icon: "🚧", radius: 6, borderStyle: "dashed", separator: "line", caps: true,
  });
  expect(revived.tabs.filter(t => t.groupId === "g1").map(t => t.id)).toEqual(["t1", "t2"]);
});

test("a tab pointing at a group that no longer exists is ungrouped, not dropped", () => {
  const revived = reviveTabs(
    { tabs: [{ id: "t1", page: "dashboard", pinned: false, groupId: "ghost" }], groups: [], activeTab: "t1" },
    (v): v is Page => PAGES.includes(v as Page),
    "dashboard",
  );
  expect(revived.tabs).toHaveLength(1);
  expect(revived.tabs[0].groupId).toBeUndefined();
});

test("a stored strip is restored exactly as written, not re-sorted underneath the user", () => {
  const revived = reviveTabs(
    {
      tabs: [
        { id: "t1", page: "dashboard", pinned: false },
        { id: "t2", page: "providers", pinned: true },
      ],
      groups: [],
      activeTab: "t1",
    },
    (v): v is Page => PAGES.includes(v as Page),
    "dashboard",
  );
  // Sorting on the way in would rearrange a strip that arrived some other way —
  // a fixture, a hand edit — and startup is the worst moment to move somebody's
  // tabs. Every reducer that can disturb the order re-orders already.
  expect(revived.tabs.map(t => t.id)).toEqual(["t1", "t2"]);
});

/* -------------------------------------------------------------- decoration -- */

test("decoration is clamped and filtered to what a header can actually draw", () => {
  expect(readGroupDecor({ radius: 999, borderWidth: -5, size: 3, weight: 1200, letterSpacing: 40 }))
    .toEqual({ radius: 24, borderWidth: 0, size: 9, weight: 700, letterSpacing: 4 });
  // A value the renderer has no case for is dropped rather than passed through.
  expect(readGroupDecor({ borderStyle: "groove", separator: "wavy" })).toBeUndefined();
  expect(readGroupDecor({ icon: "🚧🚧🚧🚧", badge: "a".repeat(40) }))
    .toEqual({ icon: "🚧🚧", badge: "a".repeat(12) });
  expect(readGroupDecor(null)).toBeUndefined();
  expect(readGroupDecor({})).toBeUndefined();
});

test("an undecorated group emits no properties, so it follows a theme the user changes later", () => {
  expect(groupDecorProps(undefined)).toEqual({});
  expect(groupDecorProps(undefined, "#ff0000")).toEqual({ "--m3-group-color": "#ff0000" });
  expect(groupDecorProps({ bg: "#123456", radius: 8, italic: true, caps: true })).toEqual({
    "--g-bg": "#123456",
    "--g-radius": "8px",
    "--g-style": "italic",
    "--g-caps": "small-caps",
  });
});

test("clearing a decoration property removes it rather than storing today's default", () => {
  const s = setGroupDecor(createGroup(state([tab(1)]), "g1", "Staging"), "g1", { bg: "#123456", radius: 8 });
  const cleared = setGroupDecor(s, "g1", { bg: undefined });
  expect(cleared.groups[0].decor).toEqual({ radius: 8 });
});

/* --------------------------------------------------------- the four searches -- */

const snapshot = (tabs: TabResult[], over: Partial<StripSnapshot> = {}): StripSnapshot =>
  ({ windowId: "w1", windowNumber: 1, local: true, strip: "main", tabs, ...over });

test("a strip result carries everything needed to place it", () => {
  const s = state(
    [tab(1, { groupId: "g1", pinned: true }), tab(2)],
    [group("g1", { name: "Staging", collapsed: true })],
    "t2",
  );
  const rows = stripResults(s, labelOf, { windowId: "w1", windowNumber: 1, strip: "main" });

  // The rule asks results to identify the window, the strip, the group, the pin
  // and the label. A row that carries fewer is one the reader has to click to
  // understand, which is the opposite of searching.
  expect(rows[0]).toEqual({
    id: "t1",
    label: "dashboard",
    pinned: true,
    groupId: "g1",
    groupName: "Staging",
    groupCollapsed: true,
    active: false,
    windowId: "w1",
    windowNumber: 1,
    local: true,
    strip: "main",
  });
  expect(rows[1].groupName).toBeUndefined();
  expect(rows[1].active).toBe(true);
});

test("the group search reports each group's size and pin state", () => {
  let s = createGroup(state([tab(1), tab(2), tab(3)]), "g1", "Staging", ["t1", "t2"]);
  s = createGroup(s, "g2", "Empty");
  s = togglePin(s, "t1");

  expect(groupResults(s)).toEqual([
    { id: "g1", name: "Staging", color: undefined, collapsed: false, count: 2, pinned: "some" },
    // An emptied group is visibly empty rather than mysteriously absent: the
    // user made it, and it is a container they may be about to refill.
    { id: "g2", name: "Empty", color: undefined, collapsed: false, count: 0, pinned: "none" },
  ]);
});

test("the master search unions this window's strip with its peers, this window first", () => {
  const mine = snapshot([
    { id: "t1", label: "dashboard", pinned: false, groupCollapsed: false, active: true, windowId: "w1", windowNumber: 1, local: true, strip: "main" },
  ]);
  const theirs = snapshot(
    [{ id: "x1", label: "logs", pinned: true, groupCollapsed: false, active: false, windowId: "w2", windowNumber: 2, local: false, strip: "main" }],
    { windowId: "w2", windowNumber: 2, local: false },
  );

  const all = masterResults(mine, [theirs]);
  expect(all.map(r => `${r.windowNumber}:${r.id}`)).toEqual(["1:t1", "2:x1"]);
  // The window each row belongs to is stamped from the snapshot, so a row can
  // never claim a window it did not come from.
  expect(all[1].local).toBe(false);
  expect(all[1].windowId).toBe("w2");
});

// An empty query is not a filter, it is the unfiltered list. Answering it with
// nothing would make every one of the four searches look broken before the user
// has typed a character.
test("an empty query shows everything and an invalid pattern shows nothing", () => {
  const rows = [{ label: "Dashboard" }, { label: "Providers" }];
  expect(matchRows(rows, tabMatcher(""), r => r.label)).toHaveLength(2);
  expect(matchRows(rows, tabMatcher("   "), r => r.label)).toHaveLength(2);
  expect(matchRows(rows, tabMatcher("(?<", true), r => r.label)).toHaveLength(0);
  expect(matchRows(rows, tabMatcher("prov"), r => r.label).map(r => r.label)).toEqual(["Providers"]);
  // Plain text is the default, so a query that looks like a pattern is literal.
  expect(matchRows([{ label: "a+b" }, { label: "aab" }], tabMatcher("a+b"), r => r.label))
    .toEqual([{ label: "a+b" }]);
});

// The hard requirement: a search may reveal a result inside a collapsed group,
// and may NOT unfold the group to do it. Selecting is enough, because
// `visibleTabs` exempts the active tab — so the reader's collapsed preference
// survives being searched.
test("selecting a result inside a collapsed group reveals it without unfolding", () => {
  const s = state(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g1" }), tab(3)],
    [group("g1", { collapsed: true })],
    "t3",
  );
  expect(visibleTabs(s).map(t => t.id)).toEqual(["t3"]);
  expect(revealsWithoutExpanding(s, "t1")).toBe(true);

  const revealed = { ...s, activeTab: "t1" };
  expect(visibleTabs(revealed).map(t => t.id)).toEqual(["t1", "t3"]);
  // The preference itself is untouched. Expanding would undo a choice the user
  // made, in order to show them something one selection already shows.
  expect(revealed.groups[0].collapsed).toBe(true);
});

test("a result that is not in this strip reveals nothing", () => {
  expect(revealsWithoutExpanding(state([tab(1)]), "gone")).toBe(false);
});
