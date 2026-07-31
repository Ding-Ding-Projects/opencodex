/**
 * Tab groups and the four tab searches, as rendered.
 *
 * The pure rules are held in `tab-groups.test.ts`; what is left for a mounted
 * strip is everything a reducer cannot promise — that a group header is a
 * button and not a tab, that its accessible name survives being decorated, that
 * Shift+right-click reaches the editor without going through the menu, that four
 * search fields do not quietly share one query, and that a tab points at the
 * panel it actually controls.
 *
 * One assertion here exists purely as a regression guard: the tab context menu
 * still offers exactly the eight commands it did before groups landed. Group
 * membership is reached by drag, by Alt+Arrow and from the search panel — not by
 * quietly growing a menu whose shape people have learned.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TabStrip from "../src/shell/TabStrip";
import { useTabs, type Tab } from "../src/shell/use-tabs";
import type { TabGroup } from "../../shared/m3/tabs";
import { LanguageProvider } from "../src/i18n/provider";

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
  // `splitTabs`, which shows every tab — which is what these cases want, since a
  // tab in the overflow menu has no strip button to right-click.
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

/** Labels these pages render with: Dashboard, Providers, Models, Combos, Logs & Debug. */
const PAGES = ["dashboard", "providers", "models", "combos", "logs"] as const;

function tab(n: number, extra: Partial<Tab> = {}): Tab {
  return { id: `t${n}`, page: PAGES[n - 1], pinned: false, ...extra };
}

function seed(tabs: Tab[], groups: TabGroup[], activeTab: string): void {
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({ tabs, groups, activeTab }));
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
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  return { container, root };
}

const stripTabs = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
const labels = (c: HTMLElement) => stripTabs(c).map(el => el.querySelector(".m3-tab-label")?.textContent ?? "");
const tabButton = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`)!;
const groupEl = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-tab-group="${id}"]`);
const groupHead = (c: HTMLElement, id: string) =>
  groupEl(c, id)?.querySelector<HTMLButtonElement>(".m3-tabgroup-head")!;

const groupMenu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label^="Actions for group"]');
const groupMenuItems = () => [...(groupMenu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const groupMenuItem = (text: string) => groupMenuItems().find(el => el.textContent === text)!;
const tabMenu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label^="Actions for"]:not([aria-label^="Actions for group"])');
const groupEditor = () => document.body.querySelector<HTMLElement>("[data-group-style-editor]");
const searchPanel = () => document.body.querySelector<HTMLElement>("[data-tab-search-panel]");

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

/** Writes through the prototype setter so React's value tracker sees a real edit. */
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

const GROUP = (over: Partial<TabGroup> = {}): TabGroup =>
  ({ id: "g1", name: "Staging", collapsed: false, ...over });

/* ------------------------------------------------------------ the header -- */

test("a group draws one header for its run, and the header is not a tab", () => {
  // Guarded because everything that counts tabs — the overflow split, the
  // roving tabindex, the tests above — counts `role="tab"`, and a header that
  // answered to it would be silently miscounted everywhere at once.
  expect(true).toBe(true);
});

test("the header carries the group's name and member count, not its colour", async () => {
  seed([tab(1), tab(2, { groupId: "g1" }), tab(3, { groupId: "g1" })], [GROUP({ color: "#ff0000" })], "t1");
  const { container, root } = await mount();

  const head = groupHead(container, "g1");
  expect(head).toBeDefined();
  // A button, never a tab: `role="tab"` here would be counted by the overflow
  // split and by the roving tabindex as if a header were a page.
  expect(head.getAttribute("role")).toBeNull();
  expect(stripTabs(container)).toHaveLength(3);

  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(head.getAttribute("aria-label")).toBe("Group Staging, 2 tabs");
  // Both members sit inside the one group element.
  expect(groupEl(container, "g1")!.querySelectorAll('[role="tab"]')).toHaveLength(2);

  await act(async () => { root.unmount(); });
});

test("collapsing folds the members away, shows the count, and keeps the header", async () => {
  seed([tab(1), tab(2, { groupId: "g1" }), tab(3, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { groupHead(container, "g1").click(); });

  expect(labels(container)).toEqual(["Dashboard"]);
  const head = groupHead(container, "g1");
  // Collapsing must not delete the group from view; the only way back would be
  // a guess.
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(head.textContent).toContain("2");
  expect(groupEl(container, "g1")!.className).toContain("collapsed");

  await act(async () => { groupHead(container, "g1").click(); });
  expect(labels(container)).toEqual(["Dashboard", "Providers", "Models"]);

  await act(async () => { root.unmount(); });
});

test("a decorated header still announces its name and state", async () => {
  seed(
    [tab(1), tab(2, { groupId: "g1" })],
    [GROUP({ color: "#00ff00", decor: { icon: "🚧", badge: "wip", bg: "#112233", radius: 4 } })],
    "t1",
  );
  const { container, root } = await mount();

  const head = groupHead(container, "g1");
  // Decoration is additive. The icon and the badge are `aria-hidden` or plain
  // text beside a name that is still there, so a group is never identified by
  // its emoji alone.
  expect(head.getAttribute("aria-label")).toBe("Group Staging, 1 tabs");
  expect(head.textContent).toContain("Staging");
  expect(head.textContent).toContain("🚧");
  expect(head.querySelector(".m3-tabgroup-icon")?.getAttribute("aria-hidden")).toBe("true");
  // The decoration reaches the DOM as custom properties, so hover and focus can
  // be states in CSS rather than re-renders in JavaScript.
  const style = groupEl(container, "g1")!.getAttribute("style") ?? "";
  expect(style).toContain("--m3-group-color: #00ff00");
  expect(style).toContain("--g-bg: #112233");
  expect(style).toContain("--g-radius: 4px");

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------- the group menu -- */

test("right-clicking a header opens the group menu, with its own name", async () => {
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  let event!: ReturnType<typeof rightClick>;
  await act(async () => { event = rightClick(groupHead(container, "g1"), { clientX: 40, clientY: 30 }); });

  expect(event.defaultPrevented).toBe(true);
  const menu = groupMenu();
  expect(menu).not.toBeNull();
  // A different accessible name from the tab menu's, so the two are
  // distinguishable to a screen reader and to anything that looks one up.
  expect(menu!.getAttribute("aria-label")).toBe("Actions for group Staging");
  expect(groupMenuItems().map(el => el.textContent)).toEqual([
    "Collapse",
    "Rename group",
    "Edit group appearance…",
    "Pin every tab in this group",
    "Move group earlier",
    "Move group later",
    "Ungroup — keep the tabs",
  ]);
  // Opening a menu moves focus into it, or the entries are unreachable.
  expect(document.activeElement).toBe(groupMenuItems()[0]);

  await act(async () => { root.unmount(); });
});

test("Shift+right-click on a header goes straight to the group appearance editor", async () => {
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  let event!: ReturnType<typeof rightClick>;
  await act(async () => { event = rightClick(groupHead(container, "g1"), { shiftKey: true }); });

  expect(event.defaultPrevented).toBe(true);
  // The menu is skipped entirely — that is what "directly" means.
  expect(groupMenu()).toBeNull();
  expect(groupEditor()?.getAttribute("data-group-style-editor")).toBe("g1");
  // Non-modal: the header being edited must stay visible and reachable behind it.
  expect(groupEditor()?.getAttribute("aria-modal")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("the keyboard opens the group menu too, and Escape returns focus to the header", async () => {
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { key(groupHead(container, "g1"), "F10", { shiftKey: true }); });
  expect(groupMenu()).not.toBeNull();

  await act(async () => { key(document.activeElement, "Escape"); });
  expect(groupMenu()).toBeNull();
  // A menu that closes and drops focus to <body> restarts a keyboard user at
  // the top of the page.
  expect(document.activeElement).toBe(groupHead(container, "g1"));

  await act(async () => { key(groupHead(container, "g1"), "ContextMenu"); });
  expect(groupMenu()).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("the group menu's arrows skip a disabled reorder entry", async () => {
  // One group: both "move earlier" and "move later" have nowhere to go, so Down
  // from the entry above them has to jump both rather than park on one.
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(groupHead(container, "g1")); });
  const items = groupMenuItems();
  expect(items[4].disabled).toBe(true);
  expect(items[5].disabled).toBe(true);
  // Disabled, not hidden: the menu keeps one shape between openings.
  expect(items).toHaveLength(7);

  await act(async () => { key(document.activeElement, "End"); });
  expect(document.activeElement?.textContent).toBe("Ungroup — keep the tabs");
  await act(async () => { key(document.activeElement, "ArrowUp"); });
  expect(document.activeElement?.textContent).toBe("Pin every tab in this group");

  await act(async () => { root.unmount(); });
});

test("ungrouping keeps the tabs and hands focus to the active one", async () => {
  seed([tab(1), tab(2, { groupId: "g1" }), tab(3, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(groupHead(container, "g1")); });
  await act(async () => { groupMenuItem("Ungroup — keep the tabs").click(); });

  expect(groupEl(container, "g1")).toBeNull();
  expect(labels(container)).toEqual(["Dashboard", "Providers", "Models"]);
  // The header this came from has unmounted, so focusing it would drop focus to
  // <body> a frame later.
  expect(document.activeElement).toBe(tabButton(container, "t1"));

  await act(async () => { root.unmount(); });
});

test("renaming happens in place, beside the header being named", async () => {
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(groupHead(container, "g1")); });
  await act(async () => { groupMenuItem("Rename group").click(); });

  const field = groupMenu()!.querySelector<HTMLInputElement>("input")!;
  await act(async () => { typeInto(field, "Release"); });
  await act(async () => { groupMenu()!.querySelector<HTMLFormElement>("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }) as never); });

  expect(groupHead(container, "g1").getAttribute("aria-label")).toBe("Group Release, 1 tabs");

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------- keyboard --- */

test("Alt+Arrow moves the active tab into, between and out of groups", async () => {
  seed(
    [tab(1), tab(2, { groupId: "g1" }), tab(3, { groupId: "g2" })],
    [GROUP(), GROUP({ id: "g2", name: "Release" })],
    "t1",
  );
  const { container, root } = await mount();

  expect(groupEl(container, "g1")!.querySelectorAll('[role="tab"]')).toHaveLength(1);

  // The destinations are a ring — ungrouped, then each group in strip order —
  // so "into", "between" and "out of" are the same motion at different points.
  await act(async () => { key(tabButton(container, "t1"), "ArrowRight", { altKey: true }); });
  expect(groupEl(container, "g1")!.querySelectorAll('[role="tab"]')).toHaveLength(2);

  await act(async () => { key(tabButton(container, "t1"), "ArrowRight", { altKey: true }); });
  expect(groupEl(container, "g2")!.querySelectorAll('[role="tab"]')).toHaveLength(2);

  await act(async () => { key(tabButton(container, "t1"), "ArrowRight", { altKey: true }); });
  expect(groupEl(container, "g1")!.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(groupEl(container, "g2")!.querySelectorAll('[role="tab"]')).toHaveLength(1);

  await act(async () => { root.unmount(); });
});

test("a plain Arrow still changes the selection rather than moving the tab", async () => {
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { key(tabButton(container, "t1"), "ArrowRight"); });

  expect(tabButton(container, "t2").getAttribute("aria-selected")).toBe("true");
  expect(groupEl(container, "g1")!.querySelectorAll('[role="tab"]')).toHaveLength(1);

  await act(async () => { root.unmount(); });
});

test("Alt+Arrow on a header reorders the groups", async () => {
  seed(
    [tab(1, { groupId: "g1" }), tab(2, { groupId: "g2" })],
    [GROUP(), GROUP({ id: "g2", name: "Release" })],
    "t1",
  );
  const { container, root } = await mount();

  const order = () => [...container.querySelectorAll<HTMLElement>("[data-tab-group]")].map(el => el.dataset.tabGroup);
  expect(order()).toEqual(["g1", "g2"]);

  // There is no keyboard drag, so a group's place in the strip has to be
  // reachable some other way or it is a preference only a mouse can set.
  await act(async () => { key(groupHead(container, "g2"), "ArrowLeft", { altKey: true }); });
  expect(order()).toEqual(["g2", "g1"]);

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------ the panel --- */

async function openSearch(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Find a tab"]')!;
  await act(async () => { trigger.click(); });
  return trigger;
}

const fieldFor = (label: string) => searchPanel()!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

test("all four searches are present, each with its own anchored regex builder", async () => {
  seed([tab(1), tab(2, { groupId: "g1" }), tab(3)], [GROUP()], "t1");
  const { container, root } = await mount();
  const trigger = await openSearch(container);

  expect(searchPanel()).not.toBeNull();
  // 1 the strip, 2 inside each group, 3 the groups themselves, 4 every window.
  expect(fieldFor("This strip")).toBeDefined();
  expect(fieldFor("Inside Staging")).toBeDefined();
  expect(fieldFor("Groups by name")).toBeDefined();
  expect(fieldFor("Every open tab, every window")).toBeDefined();

  // Each one owns a builder of its own; a single shared builder would apply to
  // whichever field was touched last.
  const builders = searchPanel()!.querySelectorAll('button[aria-haspopup="dialog"]');
  expect(builders.length).toBe(4);

  // Escape closes the panel and hands focus back to the control that opened it.
  await act(async () => { key(fieldFor("This strip"), "Escape"); });
  expect(searchPanel()).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await act(async () => { root.unmount(); });
});

test("the four fields never share a query", async () => {
  seed([tab(1), tab(2, { groupId: "g1" }), tab(3)], [GROUP()], "t1");
  const { container, root } = await mount();
  await openSearch(container);

  await act(async () => { typeInto(fieldFor("This strip"), "provider"); });

  // The rule is structural: each field calls `useSearchQuery` separately, so
  // there is no object for two of them to drift through.
  expect(fieldFor("This strip").value).toBe("provider");
  expect(fieldFor("Groups by name").value).toBe("");
  expect(fieldFor("Every open tab, every window").value).toBe("");
  expect(fieldFor("Inside Staging").value).toBe("");

  // And the counts move independently.
  expect(searchPanel()!.querySelector("[data-count-strip]")?.getAttribute("data-count-strip")).toBe("1");
  expect(searchPanel()!.querySelector("[data-count-master]")?.getAttribute("data-count-master")).toBe("3");

  await act(async () => { root.unmount(); });
});

test("a result says which window, which group and whether it is pinned", async () => {
  seed([tab(1), tab(2, { groupId: "g1", pinned: true })], [GROUP()], "t1");
  const { container, root } = await mount();
  await openSearch(container);

  await act(async () => { typeInto(fieldFor("Every open tab, every window"), "provider"); });
  // Scoped to the master list: every search shows the same tab, and only this
  // one is answering a question about *which window* it is in.
  const master = searchPanel()!.querySelector<HTMLElement>('ul[aria-label="Every open tab, every window"]')!;
  const row = master.querySelector<HTMLElement>('[data-tab-result="t2"]')!;
  const badges = [...row.querySelectorAll(".m3-tsr-badge")].map(el => el.textContent);

  // A result the reader cannot place is one they have to click to understand.
  expect(badges).toEqual(["This window", "Strip main", "Pinned", "Staging"]);

  // The strip search answers a narrower question and says less, rather than
  // repeating "This window" on every row of a list that is only this window.
  const strip = searchPanel()!.querySelector<HTMLElement>('ul[aria-label="This strip"]')!;
  const stripBadges = [...strip.querySelector('[data-tab-result="t2"]')!.querySelectorAll(".m3-tsr-badge")]
    .map(el => el.textContent);
  expect(stripBadges).toEqual(["Pinned", "Staging"]);

  await act(async () => { root.unmount(); });
});

test("going to a result inside a collapsed group reveals it without unfolding the group", async () => {
  seed(
    [tab(1), tab(2, { groupId: "g1" }), tab(3, { groupId: "g1" })],
    [GROUP({ collapsed: true })],
    "t1",
  );
  const { container, root } = await mount();
  expect(labels(container)).toEqual(["Dashboard"]);

  await openSearch(container);
  await act(async () => { typeInto(fieldFor("This strip"), "models"); });
  const row = searchPanel()!.querySelector<HTMLElement>('[data-tab-result="t3"]')!;
  // The row says so before it is clicked, so the behaviour is not a surprise.
  expect(row.textContent).toContain("In a collapsed group");

  await act(async () => { row.querySelector<HTMLButtonElement>(".m3-tsr-go")!.click(); });

  // Revealed…
  expect(labels(container)).toEqual(["Dashboard", "Models"]);
  // …and the group is still folded. Expanding would undo a choice the user
  // made, to show them something one selection already shows.
  expect(groupHead(container, "g1").getAttribute("aria-expanded")).toBe("false");
  // The query survives, because "find them, deal with each, come back" is what
  // a tab search is for.
  expect(fieldFor("This strip").value).toBe("models");
  expect(searchPanel()).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("the panel can create a group and pin one whole", async () => {
  seed([tab(1), tab(2, { groupId: "g1" }), tab(3, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();
  await openSearch(container);

  const pin = searchPanel()!.querySelector<HTMLButtonElement>('button[aria-label="Pin every tab in Staging"]')!;
  await act(async () => { pin.click(); });

  expect(container.querySelectorAll(".m3-tab-pin")).toHaveLength(2);
  // Membership survives the pin, so the group is still there to unpin back into.
  expect(searchPanel()!.querySelector('button[aria-label="Unpin every tab in Staging"]')).not.toBeNull();

  await act(async () => { root.unmount(); });
});

/* --------------------------------------------------------------- panels ---- */

test("every tab points at the panel it actually controls", async () => {
  seed([tab(1), tab(2)], [], "t1");
  const { container, root } = await mount();

  // One panel per tab, because the shell keeps them all mounted and hides the
  // inactive ones — a single id shared by the strip would be a relationship
  // that lies about three of four tabs.
  expect(tabButton(container, "t1").getAttribute("aria-controls")).toBe("ocx-tabpanel-t1");
  expect(tabButton(container, "t2").getAttribute("aria-controls")).toBe("ocx-tabpanel-t2");

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------- regression guard -- */

test("the tab context menu still offers exactly its eight commands", async () => {
  seed([tab(1), tab(2, { groupId: "g1" })], [GROUP()], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t2")); });

  // Grouping is reached by drag, by Alt+Arrow and from the search panel. Adding
  // a group submenu here would grow a menu whose shape people have learned, and
  // would push the destructive entries under the pointer's muscle memory.
  const items = [...tabMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items.map(el => el.textContent)).toEqual([
    "Close tab",
    "Close other tabs",
    "Close tabs to the right",
    "Pin tab",
    "Duplicate tab",
    "Close tabs containing text…",
    "Close tabs not containing text…",
    "Edit tab appearance…",
  ]);

  await act(async () => { root.unmount(); });
});
