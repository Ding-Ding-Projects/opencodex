/**
 * The phone surface.
 *
 * `#/mobile` used to short-circuit the whole shell and render three panels, so
 * the twenty-one other pages were unreachable from a phone. It is a route like
 * any other now, and the shell adapts instead. These are the guards on that:
 * every route reachable, the strip surviving a reload with its groups, anchored
 * panels staying on screen at 320px, press-and-hold reaching the appearance
 * editor without starting a text selection, and nothing wider than the viewport.
 *
 * ## What is asserted from the stylesheet rather than from layout
 *
 * happy-dom has no layout engine: every `getBoundingClientRect` is zero and no
 * cascade is resolved, so "is this target 44px" and "does the body scroll
 * sideways" cannot be *measured* here. Asserting them against a stub would prove
 * only that the stub was written to agree. So the rules themselves are read out
 * of `m3-shell.css` and checked — that is a real check of the thing that decides
 * the outcome in a browser, and it fails honestly if somebody deletes the block.
 * Placement, which IS pure arithmetic, is tested as arithmetic.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TabStrip from "../src/shell/TabStrip";
import ElementAppearanceHost from "../src/shell/ElementAppearanceHost";
import { useTabs, type Tab, type TabGroup } from "../src/shell/use-tabs";
import { TestLanguageProvider } from "./helpers/providers";
import { PrefsProvider } from "../src/theme/prefs";
import { PAGE_META } from "../src/shell/page-meta";
import { VALID_PAGES } from "../src/app-routing";
import { computePlacement } from "../../shared/m3/anchor";
import { computeViewportPlacement } from "../src/shell/use-anchored-placement";
import { clampToViewport } from "../../shared/m3/tabs";
import { elsewhereFor } from "../src/pages/settings-elsewhere";
import { makeMatcher } from "../src/pages/models-shared";
import { LONG_PRESS_MS } from "../src/shell/use-long-press";

const SHELL_CSS = readFileSync(new URL("../src/styles/m3-shell.css", import.meta.url), "utf8");

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
/** Width the stubbed layout reports; the strip measures this to decide overflow. */
let stubbedWidth = 0;

/** A phone. Every viewport-sensitive assertion below is made at this width. */
const PHONE_WIDTH = 320;
const PHONE_HEIGHT = 568;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/", width: PHONE_WIDTH, height: PHONE_HEIGHT });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  stubbedWidth = PHONE_WIDTH;
  Object.defineProperty(testWindow.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function (this: HTMLElement) {
      return { width: stubbedWidth, height: 40, top: 0, left: 0, right: stubbedWidth, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
    },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const noop = () => {};

function seed(tabs: Tab[], activeTab: string, groups: TabGroup[] = []): void {
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({ tabs, groups, activeTab }));
}

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
    root.render(
      <TestLanguageProvider>
        <PrefsProvider>
          <ElementAppearanceHost>
            <Harness />
          </ElementAppearanceHost>
        </PrefsProvider>
      </TestLanguageProvider>,
    );
  });
  return { container, root };
}

/* ------------------------------------------------- every route reachable -- */

test("the navigation footer stays in normal scroll flow for tall compact menus", () => {
  const footer = SHELL_CSS.match(/\.m3-nav-foot\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(footer).toContain("margin-top: auto");
  expect(footer).not.toContain("position: sticky");
  expect(footer).not.toContain("bottom:");
  expect(footer).not.toContain("z-index:");
});

test("shared menus have a narrow viewport width cap instead of a defeating minimum", () => {
  const menu = SHELL_CSS.match(/\.m3-menu\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(menu).toContain("max-width: calc(100vw - 16px)");
  expect(menu).toContain("min-width: min(220px, calc(100vw - 16px))");
});

test("every route the app has is offered by the new-tab search", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();

  const newTab = container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!;
  await act(async () => { newTab.click(); });
  const offered = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="New tab"] .m3-menu-item')]
    .map(el => el.textContent);

  // Not "a shortlist of the important ones": the menu offers one row per route,
  // and the route table is the source of truth for how many that is.
  expect(offered).toHaveLength(PAGE_META.length);
  expect(PAGE_META).toHaveLength(VALID_PAGES.size);
  // The remote control is in there rather than being the surface you are stuck
  // on — the whole point of it no longer short-circuiting the shell.
  expect(offered).toContain("Remote control");

  await act(async () => { root.unmount(); });
});

test("every route in the table renders through the shell's switch", async () => {
  // `renderPage` is a `switch` over the `Page` union with no `default`, so a
  // route added to the union without a case is a *compile* error. This asserts
  // the other half — that the union and the runtime set have not drifted.
  const meta = new Set(PAGE_META.map(entry => entry.id));
  for (const page of VALID_PAGES) expect(meta.has(page)).toBe(true);
  expect(meta.size).toBe(VALID_PAGES.size);
});

/* ------------------------------------------------------------ persistence -- */

test("the strip, its pins, its groups and its collapsed state survive a reload", async () => {
  seed(
    [
      { id: "t1", page: "dashboard", pinned: true },
      { id: "t2", page: "logs", pinned: false, groupId: "g1" },
      { id: "t3", page: "usage", pinned: false, groupId: "g1" },
      { id: "t4", page: "settings", pinned: false },
    ],
    "t4",
    [{ id: "g1", name: "Investigating", collapsed: false, color: "#8844ff" }],
  );
  stubbedWidth = 2000;
  const first = await mount();

  expect(first.container.querySelector('[data-group-id="g1"]')).not.toBeNull();
  expect(first.container.querySelector(".m3-tabgroup-name")?.textContent).toBe("Investigating");

  // Collapse it, then throw the whole tree away and build a new one from
  // storage — which is what a reload is.
  await act(async () => {
    first.container.querySelector<HTMLButtonElement>(".m3-tabgroup-head")!.click();
  });
  await act(async () => { first.root.unmount(); });

  const second = await mount();
  const group = second.container.querySelector<HTMLElement>('[data-group-id="g1"]')!;
  expect(group).not.toBeNull();
  expect(group.className).toContain("collapsed");
  expect(group.querySelector(".m3-tabgroup-head")!.getAttribute("aria-expanded")).toBe("false");
  // The collapsed group still reports its membership rather than looking empty.
  expect(group.querySelector(".m3-tabgroup-count")?.textContent).toBe("2");
  // The pin survived and sorted to the front.
  const labels = [...second.container.querySelectorAll(".m3-tab-label")].map(el => el.textContent);
  expect(labels[0]).toBe("Dashboard");

  await act(async () => { second.root.unmount(); });
});

/* -------------------------------------------------------------- placement -- */

test("a panel anchored at the right edge of a phone is moved onto the screen, not off it", () => {
  const viewport = { width: PHONE_WIDTH, height: PHONE_HEIGHT };
  // A trigger hard against the right edge, and a panel wider than the space
  // remaining to its left.
  const anchor = { top: 100, bottom: 144, left: 276, right: 320 };
  const placed = computePlacement(anchor, { width: 300, height: 260 }, viewport);

  expect(placed.viewportLeft).toBeGreaterThanOrEqual(8);
  expect(placed.viewportLeft + 300).toBeLessThanOrEqual(PHONE_WIDTH);
});

test("a panel anchored at the left edge is not pushed off that one either", () => {
  const placed = computePlacement(
    { top: 100, bottom: 144, left: 0, right: 44 },
    { width: 300, height: 260 },
    { width: PHONE_WIDTH, height: PHONE_HEIGHT },
  );
  expect(placed.viewportLeft).toBeGreaterThanOrEqual(8);
  expect(placed.viewportLeft + 300).toBeLessThanOrEqual(PHONE_WIDTH);
});

test("a panel with no room below flips above its trigger instead of running off the bottom", () => {
  const placed = computePlacement(
    { top: 500, bottom: 544, left: 20, right: 200 },
    { width: 300, height: 400 },
    { width: PHONE_WIDTH, height: PHONE_HEIGHT },
  );
  expect(placed.side).toBe("above");
  // Anchored by its bottom edge, so growing content cannot slide it over the
  // trigger it is supposed to sit above.
  expect(placed.viewportBottom).toBeGreaterThan(0);
});

test("viewport placement clamps a scrolled anchor and height to the visible side", () => {
  const viewport = { width: 320, height: 240 };
  const above = computeViewportPlacement(
    { top: -100, bottom: -56, left: 20, right: 64 },
    { width: 300, height: 400 },
    viewport,
  );
  expect(above.viewportTop).toBeGreaterThanOrEqual(8);
  expect(above.viewportTop).toBeLessThanOrEqual(viewport.height - 8);
  expect(above.maxHeight).toBeLessThanOrEqual(viewport.height - 16);

  const below = computeViewportPlacement(
    { top: 244, bottom: 288, left: 20, right: 64 },
    { width: 300, height: 400 },
    viewport,
  );
  expect(below.viewportBottom).toBeGreaterThanOrEqual(8);
  expect(below.viewportBottom).toBeLessThanOrEqual(viewport.height - 8);
  expect(below.maxHeight).toBeLessThanOrEqual(viewport.height - 16);
});

test("viewport placement does not force the 220px minimum into a short edge gap", () => {
  const placed = computeViewportPlacement(
    { top: 20, bottom: 64, left: 20, right: 64 },
    { width: 300, height: 400 },
    { width: PHONE_WIDTH, height: 80 },
  );
  expect(placed.maxHeight).toBeLessThanOrEqual(8);
});

test("clampToViewport keeps a pointer-positioned menu on a phone screen", () => {
  // Right-click (or press-and-hold) near the bottom-right corner.
  const placed = clampToViewport(
    { x: 310, y: 550 },
    { width: 260, height: 320 },
    { width: PHONE_WIDTH, height: PHONE_HEIGHT },
  );
  expect(placed.left).toBeGreaterThanOrEqual(8);
  expect(placed.top).toBeGreaterThanOrEqual(8);
  expect(placed.left + 260).toBeLessThanOrEqual(PHONE_WIDTH);
});

test("the tab search panel docks to the bottom edge on a phone rather than anchoring off it", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();

  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Find a tab"]')!;
  expect(trigger).not.toBeNull();
  await act(async () => { trigger.click(); });

  const panel = document.body.querySelector<HTMLElement>("[data-tab-search-panel]")!;
  expect(panel).not.toBeNull();
  // 320px is below the 560px threshold, so it is a sheet: full-bleed, and
  // therefore incapable of hanging off either edge.
  expect(panel.getAttribute("data-narrow")).toBe("true");
  expect(panel.style.left).toBe("0px");
  expect(panel.style.right).toBe("0px");

  await act(async () => { root.unmount(); });
});

test("the regex builder opens fixed and inside the viewport, not clipped by its scroll container", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();

  // The new-tab menu's page search is a `SearchField`, i.e. the builder opening
  // from inside a scrolling `.m3-menu` — the case that used to cut it off.
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')!.click(); });
  const trigger = document.body.querySelector<HTMLButtonElement>('[role="menu"][aria-label="New tab"] button[aria-haspopup="dialog"]')!;
  expect(trigger).not.toBeNull();
  await act(async () => { trigger.click(); });

  const panel = document.body.querySelector<HTMLElement>(".m3-rxpop")!;
  expect(panel).not.toBeNull();
  // `fixed` is the only positioning that escapes an `overflow` ancestor's clip.
  expect(panel.style.position).toBe("fixed");
  // Placed in viewport coordinates, and on the screen: the stubbed anchor sits
  // at x 0..320 on a 320px viewport, so a panel that ignored the clamp would
  // land at a negative left.
  expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(0);
  // Exactly one vertical edge is pinned — setting `top` on a panel that flipped
  // above would leave it sitting on top of its own trigger.
  expect(panel.style.top !== "" || panel.style.bottom !== "").toBe(true);
  expect(panel.style.top === "" || panel.style.bottom === "").toBe(true);

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------- long press -- */

function pointer(target: Element, type: string, init: Record<string, unknown> = {}) {
  // happy-dom's MouseEvent carries clientX/clientY and the `pointerType` the
  // handler reads; a real PointerEvent is not needed to exercise the logic.
  const event = new testWindow.MouseEvent(type, { bubbles: true, cancelable: true, ...init }) as unknown as Event;
  Object.assign(event, { pointerType: "touch", ...init });
  target.dispatchEvent(event);
  return event;
}

test("press and hold on the tab strip opens the appearance editor", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();

  const strip = container.querySelector<HTMLElement>(".m3-tabstrip")!;
  expect(strip.getAttribute("data-m3-el")).toBe("tabStrip");
  expect(document.body.querySelector("[data-element-style-editor]")).toBeNull();

  await act(async () => { pointer(strip, "pointerdown", { clientX: 40, clientY: 20 }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 40)); });

  const editor = document.body.querySelector<HTMLElement>("[data-element-style-editor]");
  expect(editor).not.toBeNull();
  expect(editor!.getAttribute("data-element-style-editor")).toBe("tabStrip");

  await act(async () => { root.unmount(); });
});

test("a long press cannot start a text selection, and eats the platform's own menu", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();

  const strip = container.querySelector<HTMLElement>(".m3-tabstrip")!;
  // The selection is prevented by refusing to be selectable at all, rather than
  // by cancelling `selectstart` after the fact — a cancelled selection still
  // flashes the highlight on some browsers.
  expect(strip.style.userSelect).toBe("none");
  expect(strip.style.touchAction).toBe("manipulation");

  await act(async () => { pointer(strip, "pointerdown", { clientX: 40, clientY: 20 }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 40)); });

  // The context menu the platform fires at the end of a held press is swallowed,
  // so our editor is not buried under the browser's own menu.
  const menuEvent = pointer(strip, "contextmenu", { clientX: 40, clientY: 20 });
  expect(menuEvent.defaultPrevented).toBe(true);

  await act(async () => { root.unmount(); });
});

test("a drag that starts as a press is a scroll, not a long press", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();
  const strip = container.querySelector<HTMLElement>(".m3-tabstrip")!;

  await act(async () => { pointer(strip, "pointerdown", { clientX: 40, clientY: 200 }); });
  // A thumb flicking the page up, still within the hold window.
  await act(async () => { pointer(strip, "pointermove", { clientX: 42, clientY: 120 }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 40)); });

  expect(document.body.querySelector("[data-element-style-editor]")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("a mouse never arms the hold timer, because it has right-click and it drags tabs", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }], "t1");
  const { container, root } = await mount();
  const strip = container.querySelector<HTMLElement>(".m3-tabstrip")!;

  await act(async () => { pointer(strip, "pointerdown", { clientX: 40, clientY: 20, pointerType: "mouse" }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 40)); });

  expect(document.body.querySelector("[data-element-style-editor]")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("Shift+F10 reaches the editor from inside the surface, but a tab's own menu wins", async () => {
  seed([{ id: "t1", page: "dashboard", pinned: false }, { id: "t2", page: "logs", pinned: false }], "t1");
  stubbedWidth = 2000;
  const { container, root } = await mount();

  const key = (target: Element | null, name: string, shift = false) =>
    target?.dispatchEvent(
      new testWindow.KeyboardEvent("keydown", { key: name, shiftKey: shift, bubbles: true, cancelable: true }) as unknown as KeyboardEvent,
    );

  // On a tab, the tab's own menu answers — the strip must not also open its
  // appearance editor behind it.
  await act(async () => { key(container.querySelector('[role="tab"]'), "F10", true); });
  expect(document.body.querySelector('[role="menu"][aria-label^="Actions for"]')).not.toBeNull();
  expect(document.body.querySelector("[data-element-style-editor]")).toBeNull();
  await act(async () => { key(document.activeElement, "Escape"); });

  // On the strip itself, nothing more specific claims it, so the editor opens.
  await act(async () => { key(container.querySelector(".m3-tabstrip"), "F10", true); });
  expect(document.body.querySelector("[data-element-style-editor]")?.getAttribute("data-element-style-editor")).toBe("tabStrip");

  await act(async () => { root.unmount(); });
});

/* --------------------------------------------------------- settings search -- */

test("the settings search says when a match lives on another tab", () => {
  const elsewhere = elsewhereFor("nav.settings");
  const matcher = makeMatcher("funny", false);

  // The English labels these keys resolve to. The registry is shared, so a
  // setting registered once is findable from every search bar in the app.
  const hits = elsewhere.filter(entry => matcher.test(`${entry.tkey} ${entry.descKey ?? ""}`));
  expect(hits.length).toBeGreaterThan(0);
  // And it names the tab to go to, rather than reporting a bare "found nothing here".
  expect(hits.every(entry => entry.tabKey.startsWith("nav."))).toBe(true);
  expect(hits.some(entry => entry.tabKey === "nav.language")).toBe(true);
  // A screen never reports itself as elsewhere.
  expect(elsewhere.every(entry => entry.tabKey !== "nav.settings")).toBe(true);
});

test("the settings search matches a current value, not only a label", () => {
  // Settings.tsx filters on `${row.label} ${row.desc} ${row.value}`, so a user
  // who remembers what a setting is *set to* can find it by that.
  const matcher = makeMatcher("8787", false);
  expect(matcher.test("Proxy port The port the proxy listens on 8787")).toBe(true);
  expect(matcher.test("Proxy port The port the proxy listens on 9000")).toBe(false);
});

/* ------------------------------------------------------ the stylesheet rules -- */

test("the coarse-pointer block lifts every named control to the 44px floor", () => {
  const block = SHELL_CSS.slice(SHELL_CSS.indexOf("@media (pointer: coarse) {"));
  expect(block).not.toBe("");
  const body = block.slice(0, block.indexOf("\n}"));

  // The controls that were under the floor before this block existed. This list
  // is hand-written on purpose: a rule that only checked the selectors already
  // present would pass on a block that had quietly lost one. The snackbar pair
  // is here because it was missing from this block for exactly that reason —
  // nothing failed while a phone's dismiss button sat at 36x36.
  for (const selector of [".m3-tab-close", ".m3-tab-btn", ".m3-tabgroup-head", ".m3-chip", ".m3-menu-item", ".m3-mob__navbtn", ".m3-mob__model", ".m3-nav-item", ".m3-snack-close", ".m3-snack-action"]) {
    // Anchored to a declaration position, so a selector merely mentioned in a
    // comment inside the block cannot stand in for the rule itself.
    expect(body).toMatch(new RegExp(`\\${selector}\\s*[,{]`));
  }
  // Every min-height in the block is at least 44px — a rule that named a
  // selector and then set 36px would pass a "contains" check and fail the user.
  const heights = [...body.matchAll(/min-height:\s*(\d+)px/g)].map(match => Number(match[1]));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
});

test("no anchored panel is allowed to be wider than a 320px viewport", () => {
  // These are `position: fixed`, so a width past the viewport is horizontal
  // overflow on the document itself — the one thing a phone layout must not do.
  const files = [
    "../src/shell/TabStrip.tsx",
    "../src/shell/TabAppearanceEditor.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    // A bare numeric `width:` on a fixed panel cannot shrink; `min(…, calc(100vw …))` can.
    expect(source).toContain("calc(100vw -");
    expect(source).not.toMatch(/position:\s*"fixed",[\s\S]{0,200}?width:\s*\d+,/);
  }
});

test("the grids that overflowed a phone now have a collapsible track floor", () => {
  // `minmax(240px, 1fr)` never shrinks below 240 and pushes its container open.
  // `minmax(min(100%, 240px), 1fr)` keeps the desktop track and collapses instead.
  for (const rule of [".m3-grid", ".m3-launch-grid"]) {
    const index = SHELL_CSS.lastIndexOf(rule + " {");
    expect(index).toBeGreaterThan(-1);
    const declaration = SHELL_CSS.slice(index, SHELL_CSS.indexOf("}", index));
    expect(declaration).toContain("minmax(min(100%,");
  }
});

test("the tab strip scrolls inside itself rather than clipping pinned tabs", () => {
  // Pinned tabs are exempt from the overflow menu by design, so on a phone they
  // are the one thing that can exceed the list box with nowhere to go.
  const index = SHELL_CSS.indexOf("@media (pointer: coarse), (max-width: 600px) {");
  expect(index).toBeGreaterThan(-1);
  const block = SHELL_CSS.slice(index, SHELL_CSS.indexOf("\n}", index));
  expect(block).toContain(".m3-tablist");
  expect(block).toContain("overflow-x: auto");
  // Never the other axis: a vertically scrolling tab strip is a rendering bug.
  expect(block).toContain("overflow-y: hidden");
});

test("the safe-area insets the app already declared can now actually resolve", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  // Without `viewport-fit=cover` every `env(safe-area-inset-*)` in the app
  // evaluates to 0, so the handling is written and does nothing.
  expect(html).toContain("viewport-fit=cover");
  expect(SHELL_CSS).toContain("env(safe-area-inset-bottom)");
});
