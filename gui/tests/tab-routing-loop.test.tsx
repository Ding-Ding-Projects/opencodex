/**
 * The tab strip and the hash router must converge.
 *
 * A pair of effects in `App` used to bind these two in both directions with no
 * fixed point, and the symptom was not subtle: the app flipped between two tabs
 * forever, pushing a history entry per flip, with a blank page behind it.
 *
 * Every case here counts renders. A correct wiring settles in a bounded number
 * of them; the loop this file exists to prevent does not settle at all, so an
 * assertion on the *final* state alone would hang rather than fail. The render
 * budget is what turns "never settles" into a failure a suite can report.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";

import { useTabRouting } from "../src/shell/use-tab-routing";
import type { TabsApi } from "../src/shell/use-tabs";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#appearance" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/** Two tabs on different pages, the second active — the shape that oscillated. */
function seedTabs(): void {
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({
    tabs: [
      { id: "ta", page: "terminal", pinned: false },
      { id: "tb", page: "appearance", pinned: false },
    ],
    activeTab: "tb",
  }));
}

interface Harness {
  api: () => TabsApi;
  renders: () => number;
  root: Root;
}

/**
 * `renderCount` is kept in the mount closure so each harness counts its own
 * committed renders. Counting from an effect avoids mutating a ref during
 * render, which would make the test harness itself unsafe under concurrent
 * rendering while still measuring every render that can affect the UI.
 */
async function mountHarness(): Promise<Harness> {
  const { createRoot } = await import("react-dom/client");
  let latest!: TabsApi;
  let count = 0;

  function Harness() {
    latest = useTabRouting();
    useEffect(() => {
      count += 1;
    });
    return null;
  }

  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  return { api: () => latest, renders: () => count, root };
}

test("selecting the other tab settles instead of ping-ponging", async () => {
  seedTabs();
  const h = await mountHarness();
  const settled = h.renders();

  await act(async () => { h.api().selectTab("ta"); });

  // The fix costs one render for the selection and one for the route catching
  // up. The loop costs an unbounded number, so any small budget separates them;
  // this one is loose enough not to break on an extra legitimate commit.
  expect(h.renders() - settled).toBeLessThan(8);
  expect(h.api().activeTab).toBe("ta");
  expect(h.api().activePage).toBe("terminal");

  await act(async () => { h.root.unmount(); });
});

test("the strip and the hash agree once it has settled", async () => {
  seedTabs();
  const h = await mountHarness();

  await act(async () => { h.api().selectTab("ta"); });

  // A strip showing one page while the URL claims another is the state the loop
  // passed through twice per cycle, so pinning agreement pins the absence of it.
  expect(window.location.hash.replace(/^#\/?/, "")).toBe("terminal");
  expect(h.api().activePage).toBe("terminal");

  await act(async () => { h.root.unmount(); });
});

test("an external hash change retargets the strip, once", async () => {
  seedTabs();
  const h = await mountHarness();
  const settled = h.renders();

  // Back/Forward, or a pasted link: the hash moves and the strip must follow it
  // rather than argue with it.
  await act(async () => {
    window.location.hash = "#terminal";
    window.dispatchEvent(new testWindow.Event("hashchange"));
  });

  expect(h.renders() - settled).toBeLessThan(8);
  expect(h.api().activePage).toBe("terminal");
  expect(h.api().activeTab).toBe("ta");

  await act(async () => { h.root.unmount(); });
});

test("opening a page the strip does not have settles too", async () => {
  seedTabs();
  const h = await mountHarness();
  const settled = h.renders();

  await act(async () => { h.api().openPage("usage", true); });

  expect(h.renders() - settled).toBeLessThan(8);
  expect(h.api().activePage).toBe("usage");
  expect(h.api().tabs).toHaveLength(3);

  await act(async () => { h.root.unmount(); });
});

// Clicking through the nav used to append a tab for every page that was not
// already open, so a few minutes of looking around left a strip of a dozen tabs
// nobody asked for. Navigating is what clicking means; a new tab is something
// the user requests.
test("a plain nav click navigates the current tab instead of adding one", async () => {
  seedTabs();
  const h = await mountHarness();

  await act(async () => { h.api().openPage("usage"); });

  expect(h.api().tabs).toHaveLength(2);
  expect(h.api().activePage).toBe("usage");
  // The tab that was active is the one that moved — not a third one.
  expect(h.api().activeTab).toBe("tb");

  await act(async () => { h.api().openPage("storage"); });
  expect(h.api().tabs).toHaveLength(2);
  expect(h.api().activePage).toBe("storage");

  await act(async () => { h.root.unmount(); });
});

test("ctrl-click still opens a new tab, because that is the ask", async () => {
  seedTabs();
  const h = await mountHarness();

  await act(async () => { h.api().openPage("usage", true); });

  expect(h.api().tabs).toHaveLength(3);
  expect(h.api().activePage).toBe("usage");

  await act(async () => { h.root.unmount(); });
});

test("a page already open is focused rather than opened twice", async () => {
  seedTabs();
  const h = await mountHarness();

  await act(async () => { h.api().openPage("terminal"); });

  expect(h.api().tabs).toHaveLength(2);
  expect(h.api().activeTab).toBe("ta");

  await act(async () => { h.root.unmount(); });
});

test("a pinned tab is never retargeted out from under the user", async () => {
  // Pinning means "keep this tab where it is". Navigating it on a plain click
  // would quietly move the thing that was pinned, so this opens a new tab —
  // the same thing a browser does.
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({
    tabs: [{ id: "ta", page: "appearance", pinned: true }],
    activeTab: "ta",
  }));
  const h = await mountHarness();

  await act(async () => { h.api().openPage("usage"); });

  expect(h.api().tabs).toHaveLength(2);
  expect(h.api().tabs.find(t => t.id === "ta")?.page).toBe("appearance");
  expect(h.api().activePage).toBe("usage");

  await act(async () => { h.root.unmount(); });
});

// Two tabs on the *same* page is reachable from the "+" menu, which opens a
// duplicate deliberately. `setActivePage` resolves a page to the first tab
// carrying it, so a duplicate is the case most likely to fight the selection.
test("duplicate tabs on one page do not fight over which is active", async () => {
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({
    tabs: [
      { id: "ta", page: "usage", pinned: false },
      { id: "tb", page: "usage", pinned: false },
    ],
    activeTab: "tb",
  }));
  const h = await mountHarness();
  const settled = h.renders();

  await act(async () => { h.api().selectTab("ta"); });

  expect(h.renders() - settled).toBeLessThan(8);
  expect(h.api().activeTab).toBe("ta");

  await act(async () => { h.root.unmount(); });
});
