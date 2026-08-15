/**
 * `TabGroupPicker` — the anchored "Move… into group…" surface, guarded here for
 * the first time. It shipped with the context-menu entry it opens from tested
 * (`tab-context-menu.test.tsx`), but nothing exercised the picker itself: its
 * filter, its keyboard model, its collapsed-group behaviour or its focus return.
 * That gap is recorded in `docs/FEATURE-INVENTORY.md` and closed here.
 *
 * Writing these tests found a real defect, not a documentation gap. `onPick` and
 * `onCreate` both called `closeMovePicker`, which focuses the anchor the panel
 * was opened beside — but *every* successful move reparents the tab's own button
 * (from a loose run directly under `.m3-tablist` to inside the target group's
 * `<div>`), so that anchor is never the node still on screen once React commits
 * the reparent. The existing "collapsed group swallows a background tab" case
 * already worked around this with `focusActiveOnCommit`; every *other* successful
 * move — into an already-open group, or into a brand-new one — quietly dropped
 * focus to `<body>`. Fixed in `TabStrip.tsx` by routing every successful move
 * through a by-id `focusTabOnCommit`, falling back to the active tab only for the
 * genuinely-vanishing case. See "choosing an existing, uncollapsed group focuses
 * the moved tab" and "creating a group focuses the tab it just seeded" below —
 * both failed with focus on `<body>` before that fix and are confirmed to fail
 * that way again by temporarily reverting it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TabStrip from "../src/shell/TabStrip";
import { useTabs, type Tab, type TabGroup } from "../src/shell/use-tabs";
import { TestLanguageProvider } from "./helpers/providers";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // happy-dom has no layout engine. A zero width means "not measured yet" to
  // `splitTabs`, which shows every tab — a tab in the overflow menu has no strip
  // button to right-click, and the picker's own placement math wants a rect too.
  Object.defineProperty(testWindow.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 0, height: 40, top: 0, left: 0, right: 0, bottom: 40, x: 0, y: 0, toJSON: () => ({}) }),
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/** Labels these pages render with, in this order. */
const PAGES = ["dashboard", "providers", "models", "combos", "logs"] as const;

function tab(n: number, extra: Partial<Tab> = {}): Tab {
  return { id: `t${n}`, page: PAGES[n - 1], pinned: false, ...extra };
}

function group(id: string, name: string, extra: Partial<TabGroup> = {}): TabGroup {
  return { id, name, collapsed: false, ...extra };
}

function seedTabs(tabs: Tab[], activeTab: string, groups: TabGroup[] = []): void {
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({ tabs, activeTab, groups }));
}

const noop = () => {};

function Harness() {
  const tabs = useTabs("dashboard", noop);
  return <TabStrip tabs={tabs} />;
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<TestLanguageProvider><Harness /></TestLanguageProvider>);
  });
  return { container, root };
}

const tabButton = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`);
const groupHeader = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-group-id="${id}"]`);

const ctxMenu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label^="Actions for"]');
const ctxItems = () => [...(ctxMenu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const ctxItem = (text: string) => ctxItems().find(el => el.textContent === text)!;

const picker = () => document.body.querySelector<HTMLElement>("[data-tab-group-picker]");
const pickerRows = () => [...(picker()?.querySelectorAll<HTMLButtonElement>("[data-group-option]") ?? [])];
const pickerRow = (groupId: string) => picker()!.querySelector<HTMLButtonElement>(`[data-group-option="${groupId}"]`)!;
const pickerSearch = () => picker()!.querySelector<HTMLInputElement>('input[type="search"]')!;
const pickerStatus = () => picker()!.querySelector<HTMLElement>('[role="status"]');
const pickerAlert = () => picker()!.querySelector<HTMLElement>('[role="alert"]');
const pickerNameField = () => picker()!.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
const pickerCreateButton = () =>
  [...picker()!.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === "Create")!;

function rightClick(el: Element, init: { shiftKey?: boolean; clientX?: number; clientY?: number } = {}) {
  const event = new testWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event as never);
  return event;
}

function key(target: Element | null, name: string, init: Record<string, unknown> = {}) {
  target?.dispatchEvent(
    new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as never,
  );
}

/** React shadows `value` with an instance property; writing through the
 * prototype setter bypasses that so the dispatched `input` event reads as typing. */
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

async function openPicker(container: HTMLElement, id: string) {
  await act(async () => { rightClick(tabButton(container, id)!); });
  await act(async () => { ctxItem("Move… into group…").click(); });
}

/* --------------------------------------------------------------- opening -- */

test("the menu keeps exactly one 'Move… into group…' entry no matter how many groups exist", async () => {
  seedTabs(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g2" }), tab(3, { groupId: "g3" }), tab(4)],
    "t1",
    [group("g1", "Work"), group("g2", "Personal"), group("g3", "Archive")],
  );
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t4")!); });
  // Never one item per group — that shape grows without bound and pushes the
  // entries below it around every time a group is added.
  expect(ctxItems().filter(el => el.textContent === "Move… into group…")).toHaveLength(1);
  expect(ctxItems().filter(el => el.textContent?.startsWith("Move"))).toHaveLength(1);

  await act(async () => { ctxItem("Move… into group…").click(); });
  expect(picker()).not.toBeNull();
  // The one entry opens the real surface, which lists all three.
  expect(pickerRows()).toHaveLength(3);

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------------- contents -- */

test("each row carries the group's name, colour, member count and current state", async () => {
  seedTabs(
    [
      tab(1, { groupId: "g1" }), tab(2, { groupId: "g1" }),
      tab(3, { groupId: "g2" }),
      tab(4),
    ],
    "t1",
    [group("g1", "Work", { color: "#ff8800" }), group("g2", "Personal")],
  );
  const { container, root } = await mount();
  await openPicker(container, "t4");

  const work = pickerRow("g1");
  expect(work.querySelector(".m3-menu-item, span")?.textContent).toBeDefined();
  expect(work.textContent).toContain("Work");
  // The count is the strip's own member count, not a number the picker invented.
  expect(work.textContent).toContain("2");
  expect(work.getAttribute("aria-label")).toBe("Move into Work, 2 tabs");
  expect(work.getAttribute("aria-current")).toBeNull();
  // Colour is decoration on an `aria-hidden` swatch — the row is never
  // identified by colour alone.
  const swatch = work.querySelector<HTMLElement>("[aria-hidden='true']");
  expect(swatch?.style.background).toBe("#ff8800");

  const personal = pickerRow("g2");
  expect(personal.textContent).toContain("Personal");
  expect(personal.textContent).toContain("1");
  expect(personal.getAttribute("aria-label")).toBe("Move into Personal, 1 tabs");

  await act(async () => { root.unmount(); });
});

test("the group a tab is already in is listed and marked, not hidden or disabled", async () => {
  seedTabs([tab(1, { groupId: "g1" }), tab(2)], "t1", [group("g1", "Work")]);
  const { container, root } = await mount();
  await openPicker(container, "t1");

  const row = pickerRow("g1");
  expect(row).not.toBeNull();
  expect(row.disabled).toBe(false);
  expect(row.getAttribute("aria-current")).toBe("true");
  // Different wording from an ordinary option: "move into" would be a small lie
  // about a row that only closes the picker.
  expect(row.getAttribute("aria-label")).toBe("Work, 1 tabs — the group this tab is already in");
  expect(row.textContent).toContain("Current");

  await act(async () => { root.unmount(); });
});

test("a collapsed group is tagged, so a move into it is made knowingly", async () => {
  seedTabs(
    [tab(1), tab(2, { groupId: "g2" })],
    "t1",
    [group("g1", "Open"), group("g2", "Archive", { collapsed: true })],
  );
  const { container, root } = await mount();
  await openPicker(container, "t1");

  expect(pickerRow("g1").textContent).not.toContain("Collapsed");
  expect(pickerRow("g2").textContent).toContain("Collapsed");

  await act(async () => { root.unmount(); });
});

test("an honest empty state when there are no groups yet, and the create path makes the first one", async () => {
  seedTabs([tab(1), tab(2)], "t1", []);
  const { container, root } = await mount();
  await openPicker(container, "t2");

  expect(pickerRows()).toHaveLength(0);
  expect(picker()!.querySelector('[role="list"]')).toBeNull();
  expect(pickerStatus()?.textContent).toBe("No groups yet. Name one below and this tab starts it.");

  await act(async () => { typeInto(pickerNameField(), "Fresh Start"); });
  expect(pickerCreateButton().disabled).toBe(false);
  await act(async () => { pickerCreateButton().click(); });

  expect(picker()).toBeNull();
  const header = groupHeader(container, container.querySelector("[data-group-id]")!.getAttribute("data-group-id")!);
  expect(header?.textContent).toContain("Fresh Start");
  expect(tabButton(container, "t2")?.closest("[data-group-id]")).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("the create button stays disabled on a blank or whitespace-only name", async () => {
  seedTabs([tab(1), tab(2)], "t1", []);
  const { container, root } = await mount();
  await openPicker(container, "t2");

  expect(pickerCreateButton().disabled).toBe(true);
  await act(async () => { typeInto(pickerNameField(), "   "); });
  expect(pickerCreateButton().disabled).toBe(true);

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------------ filter -- */

test("the filter is plain text by default and narrows the rows as you type", async () => {
  seedTabs(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g2" }), tab(3, { groupId: "g3" }), tab(4)],
    "t1",
    [group("g1", "Work"), group("g2", "Personal"), group("g3", "Workshop")],
  );
  const { container, root } = await mount();
  await openPicker(container, "t4");

  expect(pickerRows()).toHaveLength(3);
  // Focus lands in the field on open, the same contract every other converted
  // menu carries, so typing works without an extra Tab.
  expect(document.activeElement).toBe(pickerSearch());

  await act(async () => { typeInto(pickerSearch(), "work"); });
  // Case-insensitive, plain substring: matches "Work" and "Workshop" and not
  // "Personal" — proves this is not accidentally passing on a single-row list.
  expect(pickerRows().map(el => el.getAttribute("data-group-option")).sort()).toEqual(["g1", "g3"]);

  await act(async () => { typeInto(pickerSearch(), "zzzz"); });
  expect(pickerRows()).toHaveLength(0);
  expect(pickerStatus()?.textContent).toContain("zzzz");
  expect(pickerAlert()).toBeNull();

  await act(async () => { root.unmount(); });
});

/* ---------------------------------------------------------------- keyboard -- */

test("arrows rove the rows, ArrowUp off the first returns to the filter, and Home/End jump the ends", async () => {
  seedTabs(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g2" }), tab(3, { groupId: "g3" }), tab(4)],
    "t1",
    [group("g1", "Alpha"), group("g2", "Beta"), group("g3", "Gamma")],
  );
  const { container, root } = await mount();
  await openPicker(container, "t4");

  await act(async () => { key(pickerSearch(), "ArrowDown"); });
  expect(document.activeElement).toBe(pickerRow("g1"));

  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(document.activeElement).toBe(pickerRow("g2"));

  await act(async () => { key(document.activeElement, "End"); });
  expect(document.activeElement).toBe(pickerRow("g3"));

  // Wraps forward past the last row back to the first.
  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(document.activeElement).toBe(pickerRow("g1"));

  await act(async () => { key(document.activeElement, "Home"); });
  expect(document.activeElement).toBe(pickerRow("g1"));

  // ArrowUp off the first row goes to the field, not a wrap to the last row —
  // typing is always one key away from the top of the list.
  await act(async () => { key(document.activeElement, "ArrowUp"); });
  expect(document.activeElement).toBe(pickerSearch());

  await act(async () => { root.unmount(); });
});

test("Enter on a lone filtered survivor picks it", async () => {
  seedTabs(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g2" }), tab(3)],
    "t1",
    [group("g1", "Work"), group("g2", "Play")],
  );
  const { container, root } = await mount();
  await openPicker(container, "t3");

  await act(async () => { typeInto(pickerSearch(), "wo"); });
  expect(pickerRows()).toHaveLength(1);

  await act(async () => { key(pickerSearch(), "Enter"); });

  expect(picker()).toBeNull();
  const groups = JSON.parse(localStorage.getItem("ocx-m3:tabs")!).tabs as { id: string; groupId?: string }[];
  expect(groups.find(row => row.id === "t3")?.groupId).toBe("g1");

  await act(async () => { root.unmount(); });
});

test("a first Escape clears a non-empty query; a second closes the picker", async () => {
  seedTabs([tab(1, { groupId: "g1" }), tab(2)], "t1", [group("g1", "Work")]);
  const { container, root } = await mount();
  await openPicker(container, "t2");

  await act(async () => { typeInto(pickerSearch(), "xyz"); });
  await act(async () => { key(pickerSearch(), "Escape"); });
  expect(picker()).not.toBeNull();
  expect(pickerSearch().value).toBe("");

  await act(async () => { key(pickerSearch(), "Escape"); });
  expect(picker()).toBeNull();

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------- focus return -- */

test("Escape with nothing typed closes the picker and returns focus to the tab it opened from", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1", []);
  const { container, root } = await mount();
  await openPicker(container, "t3");

  await act(async () => { key(pickerSearch(), "Escape"); });

  expect(picker()).toBeNull();
  expect(document.activeElement).toBe(tabButton(container, "t3"));

  await act(async () => { root.unmount(); });
});

test("choosing the current group is a no-op close: nothing moves and focus returns to the tab", async () => {
  seedTabs([tab(1, { groupId: "g1" }), tab(2, { groupId: "g1" })], "t1", [group("g1", "Work")]);
  const { container, root } = await mount();
  await openPicker(container, "t1");

  const before = JSON.parse(localStorage.getItem("ocx-m3:tabs")!);
  await act(async () => { pickerRow("g1").click(); });

  expect(picker()).toBeNull();
  const after = JSON.parse(localStorage.getItem("ocx-m3:tabs")!);
  expect(after.tabs).toEqual(before.tabs);
  expect(document.activeElement).toBe(tabButton(container, "t1"));

  await act(async () => { root.unmount(); });
});

test("choosing an existing, uncollapsed group moves the tab and focuses it — not <body>", async () => {
  // g1 already has a member and is already rendered, so the tab being moved
  // (t2, a background tab) is reparented into an *existing* group container.
  // `visibleTabs` never hides it (the group is not collapsed), so this is not
  // the "vanished tab" case — and the defect this test caught did not care:
  // the anchor still unmounts because its parent in the tree changes.
  seedTabs([tab(1), tab(2), tab(3, { groupId: "g1" })], "t1", [group("g1", "Work")]);
  const { container, root } = await mount();
  await openPicker(container, "t2");

  await act(async () => { pickerRow("g1").click(); });

  expect(picker()).toBeNull();
  const t2 = tabButton(container, "t2");
  expect(t2).not.toBeNull();
  expect(t2?.closest("[data-group-id]")?.getAttribute("data-group-id")).toBe("g1");
  // The real regression: this used to be <body>.
  expect(document.activeElement).toBe(t2);
  expect(document.activeElement?.tagName).not.toBe("BODY");

  await act(async () => { root.unmount(); });
});

test("creating a group focuses the tab it just seeded — not <body>", async () => {
  seedTabs([tab(1), tab(2)], "t1", []);
  const { container, root } = await mount();
  await openPicker(container, "t2");

  await act(async () => { typeInto(pickerNameField(), "New Group"); });
  await act(async () => { pickerCreateButton().click(); });

  expect(picker()).toBeNull();
  const t2 = tabButton(container, "t2");
  expect(t2).not.toBeNull();
  expect(t2?.closest("[data-group-id]")).not.toBeNull();
  expect(document.activeElement).toBe(t2);
  expect(document.activeElement?.tagName).not.toBe("BODY");

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------- collapsed groups -- */

test("moving a background tab into a collapsed group leaves it collapsed, drops the tab off the strip, and focuses the active tab instead", async () => {
  // t2 is a background tab (t1 is active). Moving it into a collapsed group
  // means `visibleTabs` will hide it — the one case that really does vanish —
  // so focus has nowhere honest to land except the active tab.
  seedTabs([tab(1), tab(2)], "t1", [group("g1", "Archive", { collapsed: true })]);
  const { container, root } = await mount();
  await openPicker(container, "t2");

  expect(pickerRow("g1").textContent).toContain("Collapsed");
  await act(async () => { pickerRow("g1").click(); });

  expect(picker()).toBeNull();
  const state = JSON.parse(localStorage.getItem("ocx-m3:tabs")!);
  expect(state.tabs.find((row: { id: string }) => row.id === "t2").groupId).toBe("g1");
  // Still collapsed: `assignGroup` never touches it.
  expect(state.groups.find((row: { id: string }) => row.id === "g1").collapsed).toBe(true);

  // The header stays collapsed and now reports one member.
  const header = groupHeader(container, "g1");
  expect(header?.className).toContain("collapsed");
  expect(header!.querySelector(".m3-tabgroup-head")!.getAttribute("aria-expanded")).toBe("false");
  expect(header!.querySelector(".m3-tabgroup-count")?.textContent).toBe("1");

  // t2's button is gone from the strip — a collapsed group draws none of its
  // background members — so focus cannot follow it there.
  expect(tabButton(container, "t2")).toBeNull();
  expect(document.activeElement).toBe(tabButton(container, "t1"));
  expect(document.activeElement?.tagName).not.toBe("BODY");

  await act(async () => { root.unmount(); });
});

test("moving the ACTIVE tab into a collapsed group keeps it on the strip, still collapsed, and keeps focus on it", async () => {
  // `visibleTabs` never hides the active tab regardless of collapse, so this is
  // the other half of `vanishes`: collapsed is true but the tab does not
  // disappear, and focus should follow the tab itself, not fall back.
  seedTabs([tab(1), tab(2)], "t1", [group("g1", "Archive", { collapsed: true })]);
  const { container, root } = await mount();
  await openPicker(container, "t1");

  await act(async () => { pickerRow("g1").click(); });

  expect(picker()).toBeNull();
  const state = JSON.parse(localStorage.getItem("ocx-m3:tabs")!);
  expect(state.groups.find((row: { id: string }) => row.id === "g1").collapsed).toBe(true);

  const t1 = tabButton(container, "t1");
  expect(t1).not.toBeNull();
  expect(t1?.closest("[data-group-id]")?.getAttribute("data-group-id")).toBe("g1");
  expect(document.activeElement).toBe(t1);

  await act(async () => { root.unmount(); });
});
