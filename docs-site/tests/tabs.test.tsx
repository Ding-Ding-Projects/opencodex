/**
 * The tab shell, exercised without a browser.
 *
 * Two things are checked here, and they fail in very different ways:
 *
 *  1. The pure decisions in `shared/m3/tabs.ts` — overflow capacity, pin
 *     protection, what a bulk close would remove, group ordering. These are the
 *     rules the dashboard and this site must agree on, and the reason they live
 *     in a shared module at all is that re-deriving them guarantees the two
 *     surfaces drift. A test that only exercised the docs-site copy would miss
 *     exactly that.
 *  2. That the strip actually mounts. A React island that throws on its first
 *     render produces a *successful build*, a valid `<astro-island>` in the
 *     HTML, a JS bundle that fetches with a 200 — and no tab strip. Nothing
 *     short of running the component catches it.
 *
 * `astro:transitions/client` is mocked rather than stubbed at the bundler
 * level: it is a virtual module that only exists inside Astro's Vite pipeline,
 * and the one thing the strip uses from it — `navigate` — is precisely what a
 * test must not actually perform.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const navigations: string[] = [];
mock.module("astro:transitions/client", () => ({
  navigate: (href: string) => { navigations.push(href); },
}));

let container: HTMLElement;

beforeAll(() => {
  const window = new Window({ url: "http://localhost/guides/docker/" });
  const globals = globalThis as Record<string, unknown>;
  for (const key of ["window", "document", "navigator", "location", "HTMLElement", "Node", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  }
  // happy-dom has no layout engine, so `ResizeObserver` never fires and every
  // measured width is 0. `splitTabs` reads a width of 0 as "not measured yet"
  // and shows every tab, which is the correct behaviour to assert here — the
  // overflow arithmetic is tested directly below instead of through layout.
  globals.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  // React 19 refuses to flush `act()` without this, and prints a warning that
  // looks like a test-harness nit while the assertions silently run against a
  // tree that has not committed.
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  localStorage.clear();
  navigations.length = 0;
});

/* --------------------------------------------------------- pure decisions -- */

import {
  adoptPage,
  bulkCloseTargets,
  clampToViewport,
  closeOthersTargets,
  closeToRightTargets,
  orderTabs,
  reviveTabs,
  splitTabs,
  tabMatcher,
  visibleTabs,
  type Tab,
  type TabsState,
} from "../../shared/m3/tabs";

const tab = (id: string, page: string, extra: Partial<Tab> = {}): Tab => ({ id, page, pinned: false, ...extra });

describe("overflow", () => {
  test("an unmeasured strip shows every tab rather than guessing", () => {
    const tabs = [tab("a", "/a/"), tab("b", "/b/"), tab("c", "/c/")];
    expect(splitTabs(tabs, "a", 0).overflow).toEqual([]);
  });

  test("pinned and active tabs are never overflowed", () => {
    const tabs = [tab("p", "/p/", { pinned: true }), tab("a", "/a/"), tab("b", "/b/"), tab("z", "/z/")];
    // Room for two tabs at the 132px floor plus the 4px gap.
    const split = splitTabs(tabs, "z", 2 * 132 + 4);
    expect(split.visible.map(t => t.id).sort()).toEqual(["p", "z"]);
    expect(split.overflow.map(t => t.id)).toEqual(["a", "b"]);
  });
});

describe("close targets", () => {
  const tabs = [tab("p", "/p/", { pinned: true }), tab("a", "/a/"), tab("b", "/b/"), tab("c", "/c/")];

  test("close others spares pinned tabs", () => {
    expect(closeOthersTargets(tabs, "a")).toEqual(["b", "c"]);
  });

  test("close to the right of an unknown id closes nothing", () => {
    // The guard that stops `findIndex` returning -1 from meaning "the whole strip".
    expect(closeToRightTargets(tabs, "nope")).toEqual([]);
  });

  test("close to the right spares pinned tabs", () => {
    expect(closeToRightTargets(tabs, "a")).toEqual(["b", "c"]);
  });
});

describe("bulk close", () => {
  const rows = [
    { id: "p", label: "Providers", pinned: true },
    { id: "d", label: "Docker", pinned: false },
    { id: "c", label: "CLI", pinned: false },
  ];

  test("the two directions are exact inverses over the same predicate", () => {
    const matcher = tabMatcher("c");
    if (!matcher.ok) throw new Error("expected a matcher");
    const containing = bulkCloseTargets(rows, matcher.test);
    const notContaining = bulkCloseTargets(rows, matcher.test, { invert: true });
    // Every unpinned row is in exactly one of the two sets.
    expect([...containing, ...notContaining].sort()).toEqual(["c", "d"]);
  });

  test("an empty query is refused rather than matching everything", () => {
    const matcher = tabMatcher("   ");
    expect(matcher.ok).toBe(false);
  });

  test("an invalid pattern reports itself instead of throwing", () => {
    const matcher = tabMatcher("(unclosed", true);
    expect(matcher.ok).toBe(false);
    if (!matcher.ok && matcher.reason === "invalid") expect(matcher.error.length).toBeGreaterThan(0);
    else throw new Error("expected an invalid-pattern result");
  });

  test("a match-all leaves one tab standing, and the preview says so", () => {
    const all = tabMatcher("", false);
    expect(all.ok).toBe(false);
    const everything = bulkCloseTargets(rows, () => true, { includePinned: true, keepId: "d" });
    expect(everything).toEqual(["p", "c"]);
  });
});

describe("groups", () => {
  test("members of a group are contiguous however they were added", () => {
    const tabs = [tab("a", "/a/", { groupId: "g1" }), tab("b", "/b/"), tab("c", "/c/", { groupId: "g1" })];
    expect(orderTabs(tabs).map(t => t.id)).toEqual(["a", "c", "b"]);
  });

  test("pinned tabs sort ahead of everything and stay out of groups' runs", () => {
    const tabs = [tab("a", "/a/", { groupId: "g1" }), tab("p", "/p/", { pinned: true })];
    expect(orderTabs(tabs).map(t => t.id)).toEqual(["p", "a"]);
  });

  test("a collapsed group hides its members but never the active tab", () => {
    const state: TabsState = {
      tabs: [tab("a", "/a/", { groupId: "g1" }), tab("b", "/b/", { groupId: "g1" }), tab("c", "/c/")],
      groups: [{ id: "g1", name: "Guides", collapsed: true }],
      activeTab: "a",
    };
    expect(visibleTabs(state).map(t => t.id)).toEqual(["a", "c"]);
    expect(visibleTabs({ ...state, activeTab: "c" }).map(t => t.id)).toEqual(["c"]);
  });

  test("a tab pointing at a group that no longer exists is ungrouped, not dropped", () => {
    const revived = reviveTabs(
      { tabs: [{ id: "a", page: "/a/", pinned: false, groupId: "ghost" }], groups: [], activeTab: "a" },
      (v): v is string => typeof v === "string",
      "/home/",
    );
    expect(revived.tabs).toHaveLength(1);
    expect(revived.tabs[0].groupId).toBeUndefined();
  });
});

describe("restoring", () => {
  test("corrupt storage falls back to a fresh single-tab strip", () => {
    const revived = reviveTabs("not an object", (v): v is string => typeof v === "string", "/home/", "Home");
    expect(revived.tabs.map(t => t.page)).toEqual(["/home/"]);
    expect(revived.activeTab).toBe(revived.tabs[0].id);
  });

  test("a route the validator rejects is discarded", () => {
    const revived = reviveTabs(
      { tabs: [{ id: "a", page: "javascript:alert(1)", pinned: false }], groups: [], activeTab: "a" },
      (v): v is string => typeof v === "string" && v.startsWith("/"),
      "/home/",
    );
    expect(revived.tabs.map(t => t.page)).toEqual(["/home/"]);
  });

  test("the loaded document wins over the persisted active tab", () => {
    const stored: TabsState = {
      tabs: [tab("a", "/a/"), tab("b", "/b/")],
      groups: [],
      activeTab: "b",
    };
    // Already open: select it rather than opening a second tab on the same page.
    expect(adoptPage(stored, "/a/").activeTab).toBe("a");
    // Not open: retarget the front tab.
    const fresh = adoptPage(stored, "/c/", "See");
    expect(fresh.tabs.find(t => t.id === "b")?.page).toBe("/c/");
    // Unless it is pinned, in which case a new tab is opened beside it.
    const pinned: TabsState = { ...stored, tabs: [tab("a", "/a/"), tab("b", "/b/", { pinned: true })], activeTab: "b" };
    const opened = adoptPage(pinned, "/c/");
    expect(opened.tabs).toHaveLength(3);
    expect(opened.tabs.find(t => t.id === opened.activeTab)?.page).toBe("/c/");
  });
});

describe("anchored surfaces stay on screen", () => {
  test("a menu opened near the right edge slides back inside it", () => {
    expect(clampToViewport({ x: 900, y: 40 }, { width: 300, height: 200 }, { width: 500, height: 400 }))
      .toEqual({ left: 192, top: 40 });
  });

  test("a menu wider than the viewport pins to the corner instead of leaving by both edges", () => {
    // The phone case: the lower bound wins, so the surface starts at the pad
    // and overflows off one side rather than off both.
    expect(clampToViewport({ x: 900, y: 900 }, { width: 600, height: 700 }, { width: 500, height: 400 }))
      .toEqual({ left: 8, top: 8 });
  });
});

/* ------------------------------------------------------------- the island -- */

describe("the strip mounts", () => {
  test("renders a tab for the loaded document", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { default: TabStrip } = await import("../src/components/TabStrip");
    const React = await import("react");

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(TabStrip, { initialPath: "/guides/docker/", initialTitle: "Docker" }));
    });

    const strip = container.querySelector(".m3-tabstrip");
    expect(strip).not.toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    // `astro:page-load` has not fired in this harness, so the label is whatever
    // the mount pass read from `document.title`.
    expect(container.querySelector(".m3-tab-label")?.textContent).toBeTruthy();
    // Mounting must not navigate: the document is already the page it shows.
    expect(navigations).toEqual([]);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  test("persists the strip under its own key", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { default: TabStrip } = await import("../src/components/TabStrip");
    const React = await import("react");

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(TabStrip, { initialPath: "/guides/docker/", initialTitle: "Docker" }));
    });

    const raw = localStorage.getItem("ocx-docs:tabs");
    expect(raw).toBeTruthy();
    const state = JSON.parse(raw!);
    expect(state.tabs[0].page).toBe("/guides/docker/");

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
