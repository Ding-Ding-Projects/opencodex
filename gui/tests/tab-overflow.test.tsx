/**
 * Tab strip overflow.
 *
 * Two things are easy to lose here and are what this guards. First, the overflow
 * menu must render an overflowed tab with the same identity it has in the strip
 * — icon, label, badge, per-tab colour — because a dropdown of plain grey text
 * silently discards the customization the appearance editor exists to set.
 * Second, pinned tabs must never be overflowed: staying visible is what pinning
 * means, and a capacity calculation that treats them as ordinary tabs is a
 * silent regression nothing else would catch.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TabStrip from "../src/shell/TabStrip";
import { splitTabs, tabStyleProps, useTabs, type Tab } from "../src/shell/use-tabs";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
/** Width the stubbed layout reports for every element, including the tab list. */
let stubbedWidth = 0;

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

  // happy-dom has no layout engine, so every rect is zero-sized and nothing ever
  // overflows. Reporting a width is what makes the real measuring path run.
  stubbedWidth = 0;
  Object.defineProperty(testWindow.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: stubbedWidth, height: 40, top: 0, left: 0, right: stubbedWidth, bottom: 40, x: 0, y: 0, toJSON: () => ({}) }),
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const PAGES = ["dashboard", "providers", "models", "combos", "logs"] as const;

function tab(n: number, extra: Partial<Tab> = {}): Tab {
  return { id: `t${n}`, page: PAGES[n - 1], pinned: false, ...extra };
}

function seedTabs(tabs: Tab[], activeTab: string): void {
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({ tabs, activeTab }));
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

const strip = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
// Matched by prefix, not by the whole string: the label carries the hidden-tab
// count ("Hidden tabs (3)"), so pinning the exact text would make every test
// depend on how many tabs happened to overflow.
const trigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label^="Hidden tabs"]');
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label^="Hidden tabs"]');
const menuItems = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('.m3-tab-btn[role="menuitem"]') ?? [])];
const menuCloses = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('.m3-tab-close[role="menuitem"]') ?? [])];

function key(target: Element | null, name: string) {
  target?.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true }) as unknown as KeyboardEvent);
}

/* ------------------------------------------------------------ split rules -- */

test("an unmeasured strip overflows nothing", () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4), tab(5)];
  expect(splitTabs(tabs, "t1", 0).overflow).toEqual([]);
  expect(splitTabs(tabs, "t1", 0).visible).toHaveLength(5);
});

test("tabs beyond the measured capacity overflow in strip order", () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4), tab(5)];
  const { visible, overflow } = splitTabs(tabs, "t1", 300);
  expect(visible.map(t => t.id)).toEqual(["t1", "t2"]);
  expect(overflow.map(t => t.id)).toEqual(["t3", "t4", "t5"]);
});

test("a wider strip overflows fewer tabs, and a full-width one none", () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4), tab(5)];
  expect(splitTabs(tabs, "t1", 300).overflow).toHaveLength(3);
  expect(splitTabs(tabs, "t1", 560).overflow).toHaveLength(1);
  expect(splitTabs(tabs, "t1", 900).overflow).toHaveLength(0);
});

test("pinned tabs are never overflowed, however narrow the strip", () => {
  const tabs = [tab(1, { pinned: true }), tab(2, { pinned: true }), tab(3, { pinned: true }), tab(4), tab(5)];
  const { visible, overflow } = splitTabs(tabs, "t5", 200);
  expect(visible.map(t => t.id)).toEqual(["t1", "t2", "t3", "t5"]);
  expect(overflow.map(t => t.id)).toEqual(["t4"]);
});

test("the active tab is never overflowed, so activating one pulls it into the strip", () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4), tab(5)];
  const { visible, overflow } = splitTabs(tabs, "t5", 300);
  expect(visible.map(t => t.id)).toContain("t5");
  expect(overflow.map(t => t.id)).not.toContain("t5");
});

test("a per-tab style reaches both the surface and the label", () => {
  const { surface, label } = tabStyleProps({ bg: "var(--m3-tertiary-container)", color: "var(--m3-on-tertiary-container)", size: 15, weight: 600 });
  expect(surface).toEqual({ background: "var(--m3-tertiary-container)" });
  expect(label).toEqual({ color: "var(--m3-on-tertiary-container)", fontSize: "15px", fontWeight: 600 });
  expect(tabStyleProps(undefined)).toEqual({ surface: {}, label: {} });
});

/* -------------------------------------------------------------- the menu -- */

test("the trigger counts the overflowed tabs and carries menu semantics", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();

  expect(strip(container)).toHaveLength(2);
  const button = trigger(container)!;
  expect(button).not.toBeNull();
  expect(button.textContent).toContain("3");
  expect(button.getAttribute("aria-haspopup")).toBe("menu");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(menu()).toBeNull();

  await act(async () => { root.unmount(); });
});

test("nothing overflows, no trigger", async () => {
  seedTabs([tab(1), tab(2)], "t1");
  stubbedWidth = 900;
  const { container, root } = await mount();

  expect(strip(container)).toHaveLength(2);
  expect(trigger(container)).toBeNull();

  await act(async () => { root.unmount(); });
});

test("Enter opens the menu and moves focus onto the first item", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();

  await act(async () => { key(trigger(container), "Enter"); });
  expect(trigger(container)!.getAttribute("aria-expanded")).toBe("true");
  expect(menuItems()).toHaveLength(3);
  expect(document.activeElement).toBe(menuItems()[0]);

  await act(async () => { root.unmount(); });
});

test("the menu keeps each overflowed tab's icon, label, badge and colour", async () => {
  seedTabs(
    [
      tab(1), tab(2),
      tab(3, { style: { color: "var(--m3-tertiary)", bg: "var(--m3-tertiary-container)", size: 15, weight: 600, badge: "3" } }),
      tab(4), tab(5),
    ],
    "t1",
  );
  stubbedWidth = 300;
  const { container, root } = await mount();

  await act(async () => { trigger(container)!.click(); });
  const [first] = menuItems();
  // Identity, not a plain text row: the page icon is there beside the label.
  expect(first.querySelector("svg")).not.toBeNull();
  expect(first.querySelector(".m3-tab-label")?.textContent).toBe("Models");
  expect(first.textContent).toContain("3");
  // The customization survives the trip out of the strip.
  expect(first.style.color).toBe("var(--m3-tertiary)");
  expect(first.style.fontSize).toBe("15px");
  expect(first.style.fontWeight).toBe("600");
  expect(first.closest(".m3-tab")?.getAttribute("style")).toContain("var(--m3-tertiary-container)");

  await act(async () => { root.unmount(); });
});

test("arrows, Home and End rove the menu, and Escape returns focus to the trigger", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();

  await act(async () => { key(trigger(container), "Enter"); });
  expect(document.activeElement).toBe(menuItems()[0]);

  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(document.activeElement).toBe(menuItems()[1]);
  expect(menuItems()[1].tabIndex).toBe(0);
  expect(menuItems()[0].tabIndex).toBe(-1);

  await act(async () => { key(document.activeElement, "End"); });
  expect(document.activeElement).toBe(menuItems()[2]);
  await act(async () => { key(document.activeElement, "Home"); });
  expect(document.activeElement).toBe(menuItems()[0]);
  await act(async () => { key(document.activeElement, "ArrowUp"); });
  expect(document.activeElement).toBe(menuItems()[2]);

  // ArrowRight reaches the row's close control, ArrowLeft comes back.
  await act(async () => { key(document.activeElement, "ArrowRight"); });
  expect(document.activeElement).toBe(menuCloses()[2]);
  await act(async () => { key(document.activeElement, "ArrowLeft"); });
  expect(document.activeElement).toBe(menuItems()[2]);

  await act(async () => { key(document.activeElement, "Escape"); });
  expect(menu()).toBeNull();
  expect(trigger(container)!.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger(container));

  await act(async () => { root.unmount(); });
});

test("choosing an overflowed tab activates it and puts it in the strip", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();

  await act(async () => { trigger(container)!.click(); });
  // t3 / "Models" is the first overflowed tab.
  await act(async () => { menuItems()[0].click(); });

  expect(menu()).toBeNull();
  const selected = strip(container).find(el => el.getAttribute("aria-selected") === "true");
  expect(selected?.querySelector(".m3-tab-label")?.textContent).toBe("Models");
  expect(document.activeElement).toBe(selected);
  // The count is unchanged: one tab traded places with another.
  expect(trigger(container)!.textContent).toContain("3");

  await act(async () => { root.unmount(); });
});

test("closing from the menu drops the tab and the count follows", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();

  await act(async () => { trigger(container)!.click(); });
  expect(menuItems()).toHaveLength(3);
  await act(async () => { menuCloses()[0].click(); });

  expect(menuItems()).toHaveLength(2);
  expect(menuItems()[0].querySelector(".m3-tab-label")?.textContent).toBe("Combos");
  expect(trigger(container)!.textContent).toContain("2");

  // Delete on a focused row closes it too, the same path the strip's own close uses.
  await act(async () => { key(document.activeElement, "Delete"); });
  expect(menuItems()).toHaveLength(1);
  expect(trigger(container)!.textContent).toContain("1");

  await act(async () => { root.unmount(); });
});

test("emptying the overflow closes the menu and hands focus back to the strip", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();

  expect(trigger(container)!.textContent).toContain("1");
  await act(async () => { trigger(container)!.click(); });
  await act(async () => { menuCloses()[0].click(); });

  expect(menu()).toBeNull();
  expect(trigger(container)).toBeNull();
  expect(document.activeElement).toBe(strip(container).find(el => el.getAttribute("aria-selected") === "true"));

  await act(async () => { root.unmount(); });
});

test("the count follows a window resize", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();
  expect(trigger(container)!.textContent).toContain("3");

  stubbedWidth = 560;
  await act(async () => { window.dispatchEvent(new testWindow.Event("resize") as unknown as Event); });
  expect(trigger(container)!.textContent).toContain("1");
  expect(strip(container)).toHaveLength(4);

  stubbedWidth = 900;
  await act(async () => { window.dispatchEvent(new testWindow.Event("resize") as unknown as Event); });
  expect(trigger(container)).toBeNull();
  expect(strip(container)).toHaveLength(5);

  await act(async () => { root.unmount(); });
});

test("opening a tab keeps the count accurate without a resize", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  stubbedWidth = 300;
  const { container, root } = await mount();
  expect(trigger(container)!.textContent).toContain("1");

  const newTab = container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!;
  await act(async () => { newTab.click(); });
  const usage = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="New tab"] .m3-menu-item')]
    .find(el => el.textContent === "Usage")!;
  await act(async () => { usage.click(); });

  // Four tabs, two of them fitting: the new one is active, so t2 and t3 overflow.
  expect(trigger(container)!.textContent).toContain("2");

  await act(async () => { root.unmount(); });
});
