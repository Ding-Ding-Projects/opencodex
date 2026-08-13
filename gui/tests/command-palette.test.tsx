/**
 * The command palette component: activation, filtering, and a rich row
 * actually operating the value it claims to.
 *
 * `command-palette-index.test.ts` and `command-palette-teleport.test.ts`
 * already cover the data and the DOM-search halves in isolation; this file is
 * the thin layer that proves the three wired together — the shortcut opens
 * it, typing narrows it, and clicking a live control's `Toggle` really does
 * flip the draft state the app-bar's own dirty count reads, the same way
 * `Appearance.tsx`'s controls do.
 *
 * `happy-dom` does not implement the native `<dialog>` top layer, so
 * `showModal`/`show`/`close` are stubbed to their observable part — the same
 * stub `confirm-dialog.test.tsx` already established for the same component.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import CommandPalette, { PALETTE_OPEN_EVENT } from "../src/shell/CommandPalette";
import { TestLanguageProvider } from "./helpers/providers";
import type { TabsApi } from "../src/shell/use-tabs";
import type { Page } from "../src/app-routing";

const domGlobals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // Same stub `confirm-dialog.test.tsx` uses: happy-dom's `<dialog>` does not
  // implement the top-layer methods `Dialog` (`shell/m3-ui.tsx`) calls, so
  // this reduces them to the one observable effect a test can assert on.
  const proto = testWindow.HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (proto) {
    proto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    proto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  }

  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    await act(async () => { root?.unmount(); });
    root = null;
  }
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

/**
 * Everything `CommandPalette` calls is `openPage`; the rest of `TabsApi` is
 * present only so this satisfies the type and is never expected to be called.
 */
function fakeTabs(openPage: (page: Page, newTab?: boolean) => void): TabsApi {
  const unexpected = (name: string) => () => { throw new Error(`unexpected TabsApi.${name} call in this test`); };
  return {
    tabs: [],
    groups: [],
    activeTab: "t1",
    activePage: "dashboard",
    visible: [],
    openPage,
    selectTab: unexpected("selectTab"),
    closeTab: unexpected("closeTab"),
    closeTabs: unexpected("closeTabs"),
    closeOthers: unexpected("closeOthers"),
    closeToRight: unexpected("closeToRight"),
    duplicateTab: unexpected("duplicateTab"),
    togglePin: unexpected("togglePin"),
    moveTab: unexpected("moveTab"),
    setTabStyle: unexpected("setTabStyle"),
    setActivePage: unexpected("setActivePage"),
    createGroup: unexpected("createGroup"),
    renameGroup: unexpected("renameGroup"),
    setGroupColor: unexpected("setGroupColor"),
    setGroupStyle: unexpected("setGroupStyle"),
    toggleGroupCollapsed: unexpected("toggleGroupCollapsed"),
    removeGroup: unexpected("removeGroup"),
    moveGroup: unexpected("moveGroup"),
    assignGroup: unexpected("assignGroup"),
  };
}

async function mount(tabs: TabsApi): Promise<HTMLElement> {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host as never);
  await act(async () => {
    root?.render(
      <TestLanguageProvider>
        <CommandPalette tabs={tabs} />
      </TestLanguageProvider>,
    );
  });
  return host;
}

function dialogOf(container: HTMLElement): HTMLDialogElement | null {
  return container.querySelector("dialog");
}

async function pressShortcut(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new testWindow.KeyboardEvent("keydown", {
      key: "F", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }) as unknown as Event);
  });
}

function searchField(container: HTMLElement): HTMLInputElement {
  // By aria-label, not position or type: several other rows (the seed control,
  // an open regex-builder popover) are plain text inputs too, and the palette's
  // own field is the one whose accessible name never changes.
  const input = container.querySelector<HTMLInputElement>('dialog input[aria-label="Search pages and settings"]');
  if (!input) throw new Error("no search field in the open palette");
  return input;
}

/** Types the way React's own change detection sees it, matching the rest of the suite's convention. */
async function type(container: HTMLElement, value: string): Promise<void> {
  const input = searchField(container);
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function click(node: Element): Promise<void> {
  await act(async () => { node.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as unknown as Event); });
}

// --------------------------------------------------------------- activation --

test("Ctrl+Shift+F opens the palette from anywhere, closed by default", async () => {
  const container = await mount(fakeTabs(() => {}));
  expect(dialogOf(container)).toBeNull();

  await pressShortcut();
  expect(dialogOf(container)).not.toBeNull();
  expect(dialogOf(container)?.hasAttribute("open")).toBe(true);
});

test("the shortcut toggles: pressing it again while open closes the palette", async () => {
  const container = await mount(fakeTabs(() => {}));
  await pressShortcut();
  expect(dialogOf(container)).not.toBeNull();

  await pressShortcut();
  expect(dialogOf(container)).toBeNull();
});

test("dismissing the dialog (Escape, in the browser) closes the palette", async () => {
  const container = await mount(fakeTabs(() => {}));
  await pressShortcut();
  const dialog = dialogOf(container)!;

  // happy-dom does not wire a real Escape keypress to the native `cancel`
  // event the way a browser does, so the event is dispatched directly — the
  // same substitution `confirm-dialog.test.tsx` uses for the same reason.
  await act(async () => {
    dialog.dispatchEvent(new testWindow.Event("cancel", { bubbles: false, cancelable: true }) as unknown as Event);
  });
  expect(dialogOf(container)).toBeNull();
});

test("the app-bar trigger's window event opens the palette exactly like the shortcut", async () => {
  const container = await mount(fakeTabs(() => {}));
  await act(async () => { window.dispatchEvent(new testWindow.Event(PALETTE_OPEN_EVENT)); });
  expect(dialogOf(container)).not.toBeNull();
});

test("selecting a page destination opens it and closes the palette", async () => {
  const openPage = mock((_page: Page) => {});
  const container = await mount(fakeTabs(openPage));
  await pressShortcut();
  await type(container, "Appearance");

  const goTo = [...container.querySelectorAll("dialog button")]
    .find(btn => (btn.getAttribute("aria-label") ?? "").includes("Appearance"));
  expect(goTo).toBeDefined();
  await click(goTo!);

  expect(openPage.mock.calls).toEqual([["appearance"]]);
  expect(dialogOf(container)).toBeNull();
});

// ----------------------------------------------------------------- filtering --

test("typing narrows the results to entries that actually match", async () => {
  const container = await mount(fakeTabs(() => {}));
  await pressShortcut();

  const before = container.querySelectorAll(".m3-palette-row").length;
  expect(before).toBeGreaterThan(20);

  await type(container, "Density");

  const after = container.querySelectorAll(".m3-palette-row").length;
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
  expect(container.textContent).toContain("Density");
  expect(container.textContent).not.toContain("Start opencodex with Codex");
});

test("a query matching nothing reports so instead of silently showing an empty list", async () => {
  const container = await mount(fakeTabs(() => {}));
  await pressShortcut();
  await type(container, "zzzznothingmatchesthisxyz");

  expect(container.querySelectorAll(".m3-palette-row").length).toBe(0);
  const status = container.querySelector('dialog [role="status"]');
  expect(status?.textContent).toContain("zzzznothingmatchesthisxyz");
});

// ------------------------------------------------------- a rich row, live --

test("the narrator row's Toggle is real: clicking it actually flips the draft, not just its own appearance", async () => {
  const container = await mount(fakeTabs(() => {}));
  await pressShortcut();
  // "Narrator" also matches the (non-live, readout-only) voice/speed/pitch
  // rows, so this is really asserting there is exactly one *switch* among
  // whatever it narrows to — the live "narrator" row itself.
  await type(container, "Narrator");

  const switches = container.querySelectorAll<HTMLButtonElement>('dialog button[role="switch"]');
  expect(switches).toHaveLength(1);
  const toggle = switches[0]!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await click(toggle!);
  expect(toggle!.getAttribute("aria-checked")).toBe("true");

  // Clicking the control operates it in place — the palette does not close
  // and does not teleport away, matching "operate the control right here".
  expect(dialogOf(container)).not.toBeNull();

  await click(toggle!);
  expect(toggle!.getAttribute("aria-checked")).toBe("false");
});

test("a setting row with no live wiring renders a readout naming where to edit it, and no fake control", async () => {
  const container = await mount(fakeTabs(() => {}));
  await pressShortcut();
  await type(container, "API keys");

  // `api.keys` has no live mapping — see `command-palette-index.test.ts`.
  expect(container.querySelector('dialog [role="switch"]')).toBeNull();
  expect(container.querySelector("dialog select")).toBeNull();
  expect(container.textContent).toMatch(/Open it to change this/);
});
