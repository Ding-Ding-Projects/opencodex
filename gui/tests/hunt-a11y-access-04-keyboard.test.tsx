/**
 * ACCESS-04 repair: Ctrl+Arrow/Home/End reorders a tab from the keyboard.
 *
 * `hunt-a11y-access-04.test.ts` proves `tabs.moveTab` now has a second call
 * site besides the pointer-only `onDrop` handler. This file proves that
 * second call site actually behaves correctly when driven from a real
 * `role="tablist"` `keydown`: the right tab moves, past the right neighbour,
 * and focus is still on it afterwards — including the one case that can
 * silently drop focus rather than move it, a reorder that reparents the
 * tab's button into a group's own `<div>` (see `focusTabOnCommit`'s doc
 * comment in `TabStrip.tsx`).
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
  // `splitTabs`, which shows every tab, the same reason `tab-context-menu.test.tsx`
  // needs it: a tab in the overflow menu has no strip button to press keys on.
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
const PAGES = ["dashboard", "providers", "models", "combos"] as const;

function tab(n: number, extra: Partial<Tab> = {}): Tab {
  return { id: `t${n}`, page: PAGES[n - 1], pinned: false, ...extra };
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

const stripTabs = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
const labels = (c: HTMLElement) => stripTabs(c).map(el => el.querySelector(".m3-tab-label")?.textContent ?? "");
const tabButton = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`)!;

function key(target: Element | null, name: string, init: Record<string, unknown> = {}) {
  target?.dispatchEvent(
    new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as never,
  );
}

test("Ctrl+ArrowRight moves the focused tab past its right neighbour and keeps focus on it", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  const { container, root } = await mount();
  expect(labels(container)).toEqual(["Dashboard", "Providers", "Models"]);

  const t1 = tabButton(container, "t1");
  await act(async () => { t1.focus(); });
  expect(document.activeElement).toBe(t1);

  await act(async () => { key(t1, "ArrowRight", { ctrlKey: true }); });

  // t1 ("Dashboard") swapped with its right neighbour; the active tab id is
  // unchanged, only its position moved, which is what proves this went
  // through `tabs.moveTab` rather than through `selectTab`.
  expect(labels(container)).toEqual(["Providers", "Dashboard", "Models"]);
  expect(document.activeElement).toBe(tabButton(container, "t1"));
  expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");

  await act(async () => { root.unmount(); });
});

test("Ctrl+ArrowLeft, Ctrl+End and Ctrl+Home reorder too, and a boundary press is a no-op", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4)], "t2");
  const { container, root } = await mount();
  expect(labels(container)).toEqual(["Dashboard", "Providers", "Models", "Combos"]);

  const t2 = tabButton(container, "t2"); // "Providers", the active (and only focusable) tab
  await act(async () => { t2.focus(); });

  await act(async () => { key(t2, "ArrowLeft", { ctrlKey: true }); });
  expect(labels(container)).toEqual(["Providers", "Dashboard", "Models", "Combos"]);
  expect(document.activeElement).toBe(tabButton(container, "t2"));

  // t2 is now leftmost: nothing further to swap past, so this is a no-op
  // rather than a wrap to the far end — the same boundary a drag would hit.
  await act(async () => { key(document.activeElement, "ArrowLeft", { ctrlKey: true }); });
  expect(labels(container)).toEqual(["Providers", "Dashboard", "Models", "Combos"]);

  await act(async () => { key(document.activeElement, "End", { ctrlKey: true }); });
  expect(labels(container)).toEqual(["Dashboard", "Models", "Combos", "Providers"]);
  expect(document.activeElement).toBe(tabButton(container, "t2"));

  await act(async () => { key(document.activeElement, "Home", { ctrlKey: true }); });
  expect(labels(container)).toEqual(["Providers", "Dashboard", "Models", "Combos"]);
  expect(document.activeElement).toBe(tabButton(container, "t2"));

  await act(async () => { root.unmount(); });
});

test("a reorder that lands the tab inside a group still keeps focus on it", async () => {
  // t1 loose, t2 already a member of group g1, t3 loose: moving t1 onto t2
  // adopts t2's group (the same rule the drag-and-drop `onDrop` handler
  // relies on), which reparents t1's button from a plain sibling of the
  // tablist into the group's own `<div data-group-id="g1">`. React remounts
  // a button whose parent changes, so this is the one case a naive fix could
  // pass every other assertion and still drop focus to <body>.
  seedTabs(
    [tab(1), tab(2, { groupId: "g1" }), tab(3)],
    "t1",
    [{ id: "g1", name: "Work", collapsed: false }],
  );
  const { container, root } = await mount();
  // `orderTabs` keys a loose tab by its own id and a grouped tab by its
  // group, slotted on first appearance — t1 is loose and appears first, so
  // it stays first; only t2 sits inside the group run.
  expect(labels(container)).toEqual(["Dashboard", "Providers", "Models"]);
  expect(tabButton(container, "t1").closest("[data-group-id]")).toBeNull();

  const t1 = tabButton(container, "t1");
  await act(async () => { t1.focus(); });

  await act(async () => { key(t1, "ArrowRight", { ctrlKey: true }); });

  expect(labels(container)).toEqual(["Providers", "Dashboard", "Models"]);
  const moved = tabButton(container, "t1");
  expect(moved.closest("[data-group-id]")?.getAttribute("data-group-id")).toBe("g1");
  expect(document.activeElement).toBe(moved);

  await act(async () => { root.unmount(); });
});

test("a plain ArrowRight without Ctrl still only moves focus and never reorders", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  const { container, root } = await mount();

  const t1 = tabButton(container, "t1");
  await act(async () => { t1.focus(); });
  await act(async () => { key(t1, "ArrowRight"); });

  // Plain ArrowRight is the existing "move focus" behaviour, unchanged: the
  // strip order is untouched and the *next* tab is now active and focused.
  expect(labels(container)).toEqual(["Dashboard", "Providers", "Models"]);
  expect(document.activeElement).toBe(tabButton(container, "t2"));
  expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");

  await act(async () => { root.unmount(); });
});
