/**
 * The tab context menu, the bulk closes and the new-tab search.
 *
 * Three shipped defects are pinned here. First, right-clicking a tab showed the
 * browser's own menu: there was no `onContextMenu` handler anywhere in the GUI,
 * so every tab-management command the strip was supposed to offer simply did not
 * exist. Second, the "+" menu printed all twenty-three pages as a bare list with
 * nothing to filter it. Third, `TabStyle` and `setTabStyle` had existed in
 * `use-tabs.ts` since the strip landed with nothing in the app able to write
 * them, so a tab's colour, font and badge were unreachable.
 *
 * The cases that matter most are the ones where a plausible implementation
 * passes everything else and still loses a user's tabs: a bulk close that runs
 * on an empty query, a "not containing" variant that is not the exact negation
 * of "containing", a preview whose count is computed separately from the close
 * it previews, and a tidy-up command that sweeps away the pinned tabs pinning
 * exists to protect.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TabStrip from "../src/shell/TabStrip";
import {
  bulkCloseTargets, clampToViewport, closeOthersTargets, closeToRightTargets, tabMatcher,
  useTabs, type Tab,
} from "../src/shell/use-tabs";
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
  // `splitTabs`, which shows every tab — exactly what these cases want, because
  // a tab in the overflow menu has no strip button to right-click.
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

/** Labels these pages render with, in this order: Dashboard, Providers, Models,
 * Combos, Logs & Debug. Several assertions below match against those words. */
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
    root.render(<TestLanguageProvider><Harness /></TestLanguageProvider>);
  });
  return { container, root };
}

const stripTabs = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
const labels = (c: HTMLElement) => stripTabs(c).map(el => el.querySelector(".m3-tab-label")?.textContent ?? "");
const tabButton = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`)!;

const ctxMenu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label^="Actions for"]');
const ctxItems = () => [...(ctxMenu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const ctxItem = (text: string) => ctxItems().find(el => el.textContent === text)!;

const styleEditor = () => document.body.querySelector<HTMLElement>("[data-tab-style-editor]");
const bulkPanel = () => document.body.querySelector<HTMLElement>("[data-bulk-close]");
const bulkInput = () => bulkPanel()!.querySelector<HTMLInputElement>('input[type="search"]')!;
const bulkCount = () => Number(bulkPanel()!.querySelector("[data-bulk-count]")!.getAttribute("data-bulk-count"));
const bulkPreview = () => [...bulkPanel()!.querySelectorAll("[data-bulk-target]")].map(el => el.textContent ?? "");
const bulkConfirm = () =>
  [...bulkPanel()!.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.startsWith("Close "))!;

const newMenu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label="New tab"]');
const newMenuItems = () => [...(newMenu()?.querySelectorAll<HTMLButtonElement>(".m3-menu-item") ?? [])];

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

/**
 * React shadows `value` with an instance property so it can tell a real edit from
 * a programmatic assignment. Writing through the prototype setter bypasses that
 * tracker, which is what makes the dispatched `input` event look like typing.
 */
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

/* ------------------------------------------------------------ pure targets -- */

test("close-others and close-to-right both spare pinned tabs", () => {
  const tabs = [tab(1), tab(2, { pinned: true }), tab(3), tab(4)];

  // The shipped regression this guards: a tidy-up that treats a pin as ordinary
  // makes pinning worthless exactly when it is reached for.
  expect(closeOthersTargets(tabs, "t1")).toEqual(["t3", "t4"]);
  expect(closeToRightTargets(tabs, "t1")).toEqual(["t3", "t4"]);
  // Everything to the left survives, pinned or not.
  expect(closeToRightTargets(tabs, "t3")).toEqual(["t4"]);
});

test("close-to-right on an id the strip no longer has closes nothing", () => {
  // `findIndex` returning -1 would make `slice(0)` the whole strip, so a stale
  // id would close every tab instead of none.
  expect(closeToRightTargets([tab(1), tab(2)], "gone")).toEqual([]);
});

test("the matcher refuses an empty query and reports an invalid pattern", () => {
  expect(tabMatcher("")).toEqual({ ok: false, reason: "empty" });
  expect(tabMatcher("   ")).toEqual({ ok: false, reason: "empty" });

  const bad = tabMatcher("(?<", true);
  expect(bad.ok).toBe(false);
  // Reported, not thrown: an uncaught throw during render takes the shell down.
  expect(bad.ok === false && bad.reason).toBe("invalid");
});

test("plain text matches case-insensitively and does not compile its input", () => {
  const plain = tabMatcher("mod");
  expect(plain.ok && plain.test("Models")).toBe(true);
  // A plain-text query that happens to look like a pattern is matched literally.
  const literal = tabMatcher("a+b");
  expect(literal.ok && literal.test("a+b")).toBe(true);
  expect(literal.ok && literal.test("aab")).toBe(false);
});

test("'not containing' is the exact negation of 'containing'", () => {
  const rows = [
    { id: "t1", label: "Dashboard", pinned: false },
    { id: "t2", label: "Providers", pinned: false },
    { id: "t3", label: "Models", pinned: false },
    { id: "t4", label: "Combos", pinned: false },
  ];
  // "e" is in Providers and Models and in neither Dashboard nor Combos, so the
  // never-empty clamp — which would spare a row from the "containing" side and
  // break the union — is not in play.
  const matcher = tabMatcher("e");
  if (!matcher.ok) throw new Error("matcher should compile");

  const containing = bulkCloseTargets(rows, matcher.test, { keepId: "t1" });
  const notContaining = bulkCloseTargets(rows, matcher.test, { invert: true, keepId: "t1" });

  // Every row is on exactly one side. A second predicate built from the same
  // inputs would drift in casing or flags and leave a row on both or neither.
  expect([...containing, ...notContaining].sort()).toEqual(["t1", "t2", "t3", "t4"]);
  expect(containing.filter(id => notContaining.includes(id))).toEqual([]);
});

test("a bulk close never empties the strip, and spares the active tab first", () => {
  const rows = [
    { id: "t1", label: "Dashboard", pinned: false },
    { id: "t2", label: "Providers", pinned: false },
  ];
  const matcher = tabMatcher("s");
  if (!matcher.ok) throw new Error("matcher should compile");

  // Both labels match. One tab has to survive, and it is the one in front.
  expect(bulkCloseTargets(rows, matcher.test, { keepId: "t2" })).toEqual(["t1"]);
  expect(bulkCloseTargets(rows, matcher.test, { keepId: "t1" })).toEqual(["t2"]);
});

test("pinned tabs are out of a bulk close unless the override is on", () => {
  const rows = [
    { id: "t1", label: "Dashboard", pinned: true },
    { id: "t2", label: "Providers", pinned: false },
  ];
  const matcher = tabMatcher("s");
  if (!matcher.ok) throw new Error("matcher should compile");

  expect(bulkCloseTargets(rows, matcher.test)).toEqual(["t2"]);
  expect(bulkCloseTargets(rows, matcher.test, { includePinned: true, keepId: "t1" })).toEqual(["t2"]);
});

test("a pointer-positioned surface is clamped into the viewport", () => {
  const viewport = { width: 1000, height: 800 };
  // Near the bottom-right corner the raw pointer position would render most of
  // the menu off screen, where its lower entries are unreachable.
  expect(clampToViewport({ x: 980, y: 780 }, { width: 260, height: 300 }, viewport))
    .toEqual({ left: 732, top: 492 });
  // Comfortably inside, the pointer position is used as-is.
  expect(clampToViewport({ x: 100, y: 120 }, { width: 260, height: 300 }, viewport))
    .toEqual({ left: 100, top: 120 });
  // Larger than the viewport: pinned to the top-left rather than pushed off both edges.
  expect(clampToViewport({ x: 500, y: 500 }, { width: 2000, height: 2000 }, viewport))
    .toEqual({ left: 8, top: 8 });
});

/* ------------------------------------------------------------- the menu ---- */

test("right-clicking a tab opens the menu and suppresses the browser's own", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  const { container, root } = await mount();

  expect(ctxMenu()).toBeNull();
  let event!: ReturnType<typeof rightClick>;
  await act(async () => { event = rightClick(tabButton(container, "t2"), { clientX: 120, clientY: 40 }); });

  // Without preventDefault the browser menu opens on top of this one and the
  // tab commands are buried under Reload/Inspect.
  expect(event.defaultPrevented).toBe(true);
  const menu = ctxMenu();
  expect(menu).not.toBeNull();
  expect(menu!.getAttribute("aria-label")).toBe("Actions for Providers");
  expect(ctxItems().map(el => el.textContent)).toEqual([
    "Close tab",
    "Close other tabs",
    "Close tabs to the right",
    "Pin tab",
    "Duplicate tab",
    "Close tabs containing text…",
    "Close tabs not containing text…",
    "Edit tab appearance…",
    "New group…",
    // One entry with an ellipsis, opening `TabGroupPicker` — never one entry
    // per group, which is the shape that grows without bound and pushes
    // "Remove from group" to a different height on every opening.
    "Move… into group…",
    "Remove from group",
  ]);
  // Opening a menu moves focus into it, or the entries are unreachable by keyboard.
  expect(document.activeElement).toBe(ctxItems()[0]);

  await act(async () => { root.unmount(); });
});

test("the pin entry says what it will do, not what the tab is", async () => {
  seedTabs([tab(1, { pinned: true }), tab(2)], "t2");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t1")); });
  expect(ctxItem("Unpin tab")).toBeDefined();
  await act(async () => { key(document.activeElement, "Escape"); });

  await act(async () => { rightClick(tabButton(container, "t2")); });
  expect(ctxItem("Pin tab")).toBeDefined();

  await act(async () => { root.unmount(); });
});

test("Shift+right-click goes straight to the appearance editor", async () => {
  seedTabs([tab(1), tab(2)], "t1");
  const { container, root } = await mount();

  let event!: ReturnType<typeof rightClick>;
  await act(async () => { event = rightClick(tabButton(container, "t2"), { shiftKey: true }); });

  expect(event.defaultPrevented).toBe(true);
  // The menu is skipped entirely — that is what "directly" means.
  expect(ctxMenu()).toBeNull();
  expect(styleEditor()?.getAttribute("data-tab-style-editor")).toBe("t2");
  expect(styleEditor()?.getAttribute("aria-label")).toBeNull();
  // Non-modal: the tab being edited must stay visible and reachable behind it.
  expect(styleEditor()?.getAttribute("aria-modal")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("the appearance editor writes the tab's style and resets one property at a time", async () => {
  seedTabs([tab(1), tab(2)], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t2"), { shiftKey: true }); });
  const badge = styleEditor()!.querySelector<HTMLInputElement>('input[aria-label="Badge"]')!;
  await act(async () => { typeInto(badge, "wip"); });

  // Live, in the strip itself — nothing writes `TabStyle` today, which is the
  // defect this proves fixed.
  expect(tabButton(container, "t2").parentElement?.textContent).toContain("wip");

  const reset = [...styleEditor()!.querySelectorAll<HTMLButtonElement>("button")]
    .find(el => el.getAttribute("aria-label") === "Reset Badge to the theme")!;
  expect(reset.disabled).toBe(false);
  await act(async () => { reset.click(); });
  expect(tabButton(container, "t2").parentElement?.textContent).not.toContain("wip");

  await act(async () => { root.unmount(); });
});

test("Escape closes the menu and gives focus back to the tab it came from", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t3")); });
  await act(async () => { key(document.activeElement, "Escape"); });

  expect(ctxMenu()).toBeNull();
  // Dropping focus to <body> restarts a keyboard user at the top of the page —
  // and the tab it returns to is the right-clicked one, not the selected one.
  expect(document.activeElement).toBe(tabButton(container, "t3"));

  await act(async () => { root.unmount(); });
});

test("the keyboard opens the menu too, by ContextMenu and by Shift+F10", async () => {
  seedTabs([tab(1), tab(2)], "t1");
  const { container, root } = await mount();

  await act(async () => { key(tabButton(container, "t1"), "ContextMenu"); });
  expect(ctxMenu()).not.toBeNull();
  await act(async () => { key(document.activeElement, "Escape"); });
  expect(ctxMenu()).toBeNull();

  // A menu reachable only by mouse is not a menu for anyone driving the keyboard.
  await act(async () => { key(tabButton(container, "t1"), "F10", { shiftKey: true }); });
  expect(ctxMenu()).not.toBeNull();
  expect(document.activeElement).toBe(ctxItems()[0]);

  await act(async () => { root.unmount(); });
});

test("arrows rove the menu and skip past a disabled entry", async () => {
  // One tab, ungrouped: every close entry is disabled, and so is "Remove from
  // group" — so roving has to jump both the block at the top and the one at the
  // bottom rather than parking on either.
  seedTabs([tab(1)], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t1")); });
  const items = ctxItems();
  expect(items[0].disabled).toBe(true);
  expect(items[1].disabled).toBe(true);
  expect(items[2].disabled).toBe(true);
  expect(items[5].disabled).toBe(true);
  expect(items[6].disabled).toBe(true);
  // "Move… into group…" stays enabled with no groups yet: the picker's own
  // create-a-group row is the route to the first one, so disabling it here
  // would hide the only keyboard path into grouping behind grouping.
  expect(items[9].disabled).toBe(false);
  // The tab is in no group, so there is nothing to remove it from.
  expect(items[10].disabled).toBe(true);
  // Disabled, not hidden: the menu keeps one shape, so its entries do not move
  // between openings.
  expect(items).toHaveLength(11);

  // Focus opens on the first *enabled* entry. Landing on a disabled one would
  // leave focus outside the menu, and every arrow key after that would miss it.
  const focused = () => document.activeElement?.textContent;
  expect(focused()).toBe("Pin tab");

  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(focused()).toBe("Duplicate tab");
  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(focused()).toBe("Edit tab appearance…");
  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(focused()).toBe("New group…");
  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(focused()).toBe("Move… into group…");
  // Wrapping skips the disabled entry at the end and the block at the top.
  await act(async () => { key(document.activeElement, "ArrowDown"); });
  expect(focused()).toBe("Pin tab");
  await act(async () => { key(document.activeElement, "ArrowUp"); });
  expect(focused()).toBe("Move… into group…");

  await act(async () => { root.unmount(); });
});

test("an outside click closes the menu", async () => {
  seedTabs([tab(1), tab(2)], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t2")); });
  await act(async () => {
    document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }) as never);
  });

  expect(ctxMenu()).toBeNull();

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------- menu commands ---- */

test("close others and close to the right leave the pinned tabs alone", async () => {
  // Seeded with the pinned tab second, and restored with it first: a strip read
  // back out of storage is normalised to the same pinned-first order every
  // mutation maintains, so it cannot come back in an arrangement no command
  // could ever have produced. That matters beyond tidiness — `splitTabs` never
  // overflows a pinned tab, which is only a promise it can keep if the pinned
  // run is contiguous at the front.
  seedTabs([tab(1), tab(2, { pinned: true }), tab(3), tab(4)], "t1");
  const { container, root } = await mount();
  expect(labels(container)).toEqual(["Providers", "Dashboard", "Models", "Combos"]);

  await act(async () => { rightClick(tabButton(container, "t1")); });
  await act(async () => { ctxItem("Close tabs to the right").click(); });
  // Models and Combos go; Providers is pinned and stays.
  expect(labels(container)).toEqual(["Providers", "Dashboard"]);

  await act(async () => { rightClick(tabButton(container, "t1")); });
  await act(async () => { ctxItem("Close other tabs").click(); });
  expect(labels(container)).toEqual(["Providers", "Dashboard"]);

  await act(async () => { root.unmount(); });
});

test("duplicate opens a second tab on the same page and focuses it", async () => {
  seedTabs([tab(1), tab(2)], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t2")); });
  await act(async () => { ctxItem("Duplicate tab").click(); });

  expect(labels(container)).toEqual(["Dashboard", "Providers", "Providers"]);
  const selected = stripTabs(container).find(el => el.getAttribute("aria-selected") === "true");
  expect(selected?.querySelector(".m3-tab-label")?.textContent).toBe("Providers");
  expect(document.activeElement).toBe(selected);

  await act(async () => { root.unmount(); });
});

/* ---------------------------------------------------------- bulk closing -- */

async function openBulk(container: HTMLElement, id: string, entry: string) {
  await act(async () => { rightClick(tabButton(container, id)); });
  await act(async () => { ctxItem(entry).click(); });
}

test("the bulk close refuses an empty query and an invalid pattern", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  const { container, root } = await mount();

  await openBulk(container, "t1", "Close tabs containing text…");
  expect(bulkPanel()).not.toBeNull();
  // The menu entry that opened this has unmounted with the menu, so focus has to
  // be moved deliberately or it lands on <body>.
  expect(document.activeElement).toBe(bulkInput());

  // Nothing typed: the button is dead and the reason is stated, because a user
  // who cannot see why an action is refused assumes the surface is broken.
  expect(bulkConfirm().disabled).toBe(true);
  expect(bulkPanel()!.querySelector('[role="alert"]')?.textContent).toContain("An empty query matches every tab");
  expect(bulkCount()).toBe(0);

  // Whitespace is still empty.
  await act(async () => { typeInto(bulkInput(), "   "); });
  expect(bulkConfirm().disabled).toBe(true);

  const regexMode = [...bulkPanel()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(el => el.textContent === "Regular expression")!;
  await act(async () => { regexMode.click(); });
  await act(async () => { typeInto(bulkInput(), "(?<"); });

  expect(bulkConfirm().disabled).toBe(true);
  expect(bulkPanel()!.querySelector('[role="alert"]')?.textContent).toContain("Invalid pattern");
  // Nothing closed while the pattern was broken.
  expect(labels(container)).toHaveLength(3);

  await act(async () => { root.unmount(); });
});

test("the previewed count is exactly what closes", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  const { container, root } = await mount();

  await openBulk(container, "t1", "Close tabs containing text…");
  // "e" is in Providers, Models and Logs & Debug, and in neither Dashboard nor
  // Combos — three of five, so the never-empty clamp is not what is measured.
  await act(async () => { typeInto(bulkInput(), "e"); });

  expect(bulkCount()).toBe(3);
  expect(bulkPreview()).toEqual(["Providers", "Models", "Logs & Debug"]);

  const before = labels(container).length;
  await act(async () => { bulkConfirm().click(); });

  // The count, the preview and the strip all agree. A preview computed
  // separately from the close is how a confirmation surface starts lying.
  expect(before - labels(container).length).toBe(3);
  expect(labels(container)).toEqual(["Dashboard", "Combos"]);
  expect(bulkPanel()).toBeNull();

  await act(async () => { root.unmount(); });
});

test("the 'not containing' variant closes the complement of the same query", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  const { container, root } = await mount();

  await openBulk(container, "t1", "Close tabs not containing text…");
  await act(async () => { typeInto(bulkInput(), "e"); });

  // The exact rows the "containing" case above left standing.
  expect(bulkPreview()).toEqual(["Dashboard", "Combos"]);
  await act(async () => { bulkConfirm().click(); });
  expect(labels(container)).toEqual(["Providers", "Models", "Logs & Debug"]);

  await act(async () => { root.unmount(); });
});

test("a bulk close spares the pinned tabs and says how many", async () => {
  seedTabs([tab(1), tab(2, { pinned: true }), tab(3), tab(4)], "t1");
  const { container, root } = await mount();

  await openBulk(container, "t1", "Close tabs containing text…");
  // "o" is in every one of Dashboard, Providers, Models and Combos.
  await act(async () => { typeInto(bulkInput(), "o"); });

  expect(bulkPreview()).not.toContain("Providers");
  expect(bulkPanel()!.textContent).toContain("Pinned tabs stay open");

  await act(async () => { bulkConfirm().click(); });
  expect(labels(container)).toContain("Providers");

  await act(async () => { root.unmount(); });
});

test("Escape closes the bulk surface without closing anything", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t1");
  const { container, root } = await mount();

  await openBulk(container, "t2", "Close tabs containing text…");
  await act(async () => { typeInto(bulkInput(), "o"); });
  expect(bulkCount()).toBeGreaterThan(0);

  await act(async () => { key(bulkInput(), "Escape"); });

  expect(bulkPanel()).toBeNull();
  expect(labels(container)).toHaveLength(3);
  expect(document.activeElement).toBe(tabButton(container, "t2"));

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------- new-tab search -- */

test("the new-tab menu filters its page list and says so when nothing matches", async () => {
  seedTabs([tab(1)], "t1");
  const { container, root } = await mount();

  const plus = container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!;
  await act(async () => { plus.click(); });

  const all = newMenuItems().length;
  // The list this replaces was every page, unfiltered, with no way to narrow it.
  expect(all).toBeGreaterThan(20);
  const search = newMenu()!.querySelector<HTMLInputElement>('input[aria-label="Search pages"]')!;
  // Focus lands in the field, so the menu can be used by typing rather than by
  // pressing Down twenty times.
  expect(document.activeElement).toBe(search);

  // "logs" and not "log": "log" also matches Changelog, and a filter test that
  // happens to leave two rows would not prove anything was filtered out.
  await act(async () => { typeInto(search, "logs"); });
  expect(newMenuItems().map(el => el.textContent)).toEqual(["Logs & Debug"]);

  // Arrows move out of the field and into the results.
  await act(async () => { key(search, "ArrowDown"); });
  expect(document.activeElement).toBe(newMenuItems()[0]);
  await act(async () => { key(document.activeElement, "ArrowUp"); });
  expect(document.activeElement).toBe(search);

  // Arrow keys inside the anchored regex builder belong to the builder. Before
  // the target check they bubbled to the row's handler and threw focus into the
  // page list while a pattern was still being written.
  await act(async () => { newMenu()!.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click(); });
  const patternField = newMenu()!.querySelector<HTMLInputElement>('[role="dialog"] input[aria-invalid]')!;
  await act(async () => { key(patternField, "ArrowDown"); });
  expect(document.activeElement).toBe(patternField);
  await act(async () => { key(patternField, "Escape"); });
  // The builder closes; the menu it opened from stays.
  expect(newMenu()).not.toBeNull();

  await act(async () => { typeInto(search, "zzzz"); });
  expect(newMenuItems()).toHaveLength(0);
  // Words, not a blank menu: an empty dropdown reads as a rendering failure.
  expect(newMenu()!.textContent).toContain("No page matches");

  await act(async () => { root.unmount(); });
});

test("choosing a filtered page opens it in a new tab", async () => {
  seedTabs([tab(1)], "t1");
  const { container, root } = await mount();

  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!.click(); });
  const search = newMenu()!.querySelector<HTMLInputElement>('input[aria-label="Search pages"]')!;
  await act(async () => { typeInto(search, "storage"); });
  await act(async () => { newMenuItems()[0].click(); });

  expect(labels(container)).toEqual(["Dashboard", "Storage"]);
  expect(newMenu()).toBeNull();

  await act(async () => { root.unmount(); });
});
