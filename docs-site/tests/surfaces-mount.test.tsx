/**
 * The three islands actually mount, and their controls actually do something.
 *
 * This is the failure a build cannot see. A React island that throws on its
 * first render produces a *successful build*, a valid `<astro-island>` element
 * in the HTML, and a JS chunk that fetches with a 200 — and no notification
 * bell, no changelog and no settings page. `client:only` makes it worse: there
 * is no server-rendered fallback underneath, so the reader gets an empty box
 * with nothing in the console except a React error nobody was watching for.
 *
 * So each of the three is rendered here for real, and then driven: change the
 * language mode and assert the rendered copy changed; move a funny slider and
 * assert the preview changed; type in the changelog search and assert releases
 * disappear. Asserting a component "renders without throwing" is worth having
 * and is not enough — a mode switch wired to nothing renders perfectly.
 *
 * `happy-dom` has no layout engine, so every `getBoundingClientRect` is zeros
 * and `computePlacement` is exercised against a degenerate viewport. That is
 * fine for these assertions — placement itself is unit-tested where it lives —
 * and it is why nothing here asserts a pixel.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/* The changelog's data module is the only thing between the viewer and a `?raw`
   import Bun cannot resolve, which is exactly why it is a module of its own. */
const FIXTURE = `# Changelog

## 3.0.0 — 2026-05-01

- feat(gui): the aurora borealis
- fix(cli): localised entirely within this kitchen

## 2.0.0 — 2025-04-02

- docs(readme): may I see it
`;

mock.module("../src/lib/changelog-data.ts", async () => {
  const { parseChangelog } = await import("../src/lib/changelog");
  return { RELEASES: parseChangelog(FIXTURE) };
});

let container: HTMLElement;
let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;

beforeAll(async () => {
  const window = new Window({ url: "http://localhost/settings/" });
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    "window", "document", "navigator", "location", "HTMLElement", "Node", "Element",
    "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "MutationObserver",
    "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage",
    "Blob", "URL",
  ]) {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  }
  globals.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  // React 19 refuses to flush `act()` without this and prints a warning that
  // reads like a harness nit while the assertions run against an uncommitted tree.
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
});

/*
  Unmount rather than just detaching the container.

  Every island here subscribes to a module-level store that outlives the test.
  Removing the node leaves those subscriptions live, so the next test's `notify`
  updates a tree nobody is rendering — which React reports as an un-acted update
  from a component the failing test never mentioned.
*/
afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  localStorage.clear();
  container?.remove();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const current = root;
  await act(async () => { current.render(node); });
  return container;
}

const text = (root: ParentNode) => (root.textContent ?? "").replace(/\s+/g, " ");

/**
 * Type into a controlled React input.
 *
 * Assigning `.value` and firing `input` is not enough: React patches a value
 * tracker onto the *instance*, sees the new value already recorded, and decides
 * nothing changed — so `onChange` never fires and the test asserts against a
 * component that was never told anything. Calling the prototype's setter writes
 * the value without going through the patched instance property, which leaves
 * the tracker stale and makes React treat the event as a real edit.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the corner surfaces", () => {
  test("mount, and expose a notification bell", async () => {
    const { default: ShellSurfaces } = await import("../src/components/ShellSurfaces");
    const root = await mount(<ShellSurfaces />);
    const bell = root.querySelector<HTMLButtonElement>(".ocx-notif-trigger");
    expect(bell).not.toBeNull();
    expect(bell!.getAttribute("aria-expanded")).toBe("false");
  });

  test("a notice appears as a toast and is readable in the centre after dismissal", async () => {
    const { default: ShellSurfaces } = await import("../src/components/ShellSurfaces");
    const { notify, dismissAll, clearHistory } = await import("../src/lib/notifications");
    clearHistory();
    dismissAll();

    const root = await mount(<ShellSurfaces />);
    await act(async () => { notify({ tone: "error", title: "the pattern will not compile" }); });

    // Toasts are portalled to <body>, not rendered inside the island.
    const toast = document.body.querySelector(".ocx-snack--error");
    expect(toast).not.toBeNull();
    // An error is assertive; everything else is polite.
    expect(toast!.getAttribute("role")).toBe("alert");

    const bell = root.querySelector<HTMLButtonElement>(".ocx-notif-trigger")!;
    await act(async () => { bell.click(); });
    const panel = root.querySelector("#ocx-notif-panel");
    expect(panel).not.toBeNull();
    expect(text(panel!)).toContain("the pattern will not compile");

    await act(async () => { dismissAll(); clearHistory(); });
  });
});

describe("the settings page", () => {
  test("mounts with its three sections and a searchable list", async () => {
    const { default: Settings } = await import("../src/components/Settings");
    const root = await mount(<Settings />);
    const tabs = [...root.querySelectorAll('[role="tab"]')].map(node => text(node));
    expect(tabs).toHaveLength(3);
    expect(text(root)).toContain("Interface language");
  });

  test("switching the interface language changes rendered copy", async () => {
    const { default: Settings } = await import("../src/components/Settings");
    const { setMode } = await import("../src/lib/i18n");
    const root = await mount(<Settings />);

    expect(text(root)).toContain("Interface language");
    await act(async () => { setMode("yue"); });
    // The wiring, not the dictionary: the dictionary is asserted elsewhere, and
    // a mode switch connected to nothing would pass that test and fail this one.
    expect(text(root)).toContain("介面語言");

    await act(async () => { setMode("bi"); });
    // Bilingual composes both tracks into one label rather than picking one.
    expect(text(root)).toContain("Interface language · 介面語言");

    await act(async () => { setMode("auto"); });
  });

  test("the funny slider changes the previewed message and never drops its fact", async () => {
    const { default: Settings } = await import("../src/components/Settings");
    const { setFunny, setMode } = await import("../src/lib/i18n");
    const root = await mount(<Settings />);

    await act(async () => { setMode("en"); setFunny({ en: 1, yue: 1 }); });
    const serious = text(root.querySelector(".ocx-preview")!);

    await act(async () => { setFunny({ en: 5, yue: 5 }); });
    const playful = text(root.querySelector(".ocx-preview")!);

    expect(playful).not.toBe(serious);
    // The disclosure's whole claim: the voice moved, the fact did not.
    expect(serious.toLowerCase()).toContain("export");
    expect(playful.toLowerCase()).toContain("export");

    await act(async () => { setFunny({ en: 3, yue: 3 }); setMode("auto"); });
  });

  test("the settings search reports matches that are on another tab", async () => {
    const { default: Settings } = await import("../src/components/Settings");
    const root = await mount(<Settings />);
    const field = root.querySelector<HTMLInputElement>('input[type="search"]')!;

    // A dim sum setting, typed while the language tab is open.
    await act(async () => { typeInto(field, "dim sum"); });

    const body = text(root);
    // "No setting matches" here would be a lie — the setting exists, one tab
    // over, and the reader would believe the first sentence they were given.
    expect(body).not.toContain("No setting matches.");
    expect(body).toContain("on another tab");
    expect(body).toContain("Dim sum");
  });
});

describe("the changelog viewer", () => {
  test("mounts and lists every release in the source", async () => {
    const { default: Changelog } = await import("../src/components/Changelog");
    const root = await mount(<Changelog />);
    const versions = [...root.querySelectorAll(".ocx-release-version")].map(node => text(node));
    expect(versions).toEqual(["3.0.0", "2.0.0"]);
  });

  test("searching narrows the list, and the count says so", async () => {
    const { default: Changelog } = await import("../src/components/Changelog");
    const root = await mount(<Changelog />);
    const field = root.querySelector<HTMLInputElement>('input[type="search"]')!;

    await act(async () => { typeInto(field, "aurora"); });

    const versions = [...root.querySelectorAll(".ocx-release-version")].map(node => text(node));
    expect(versions).toEqual(["3.0.0"]);
    expect(text(root.querySelector(".ocx-changelog-count")!)).toContain("1 of 2");
  });

  test("a date bound that excludes everything says both filters are involved", async () => {
    const { default: Changelog } = await import("../src/components/Changelog");
    const root = await mount(<Changelog />);
    const from = root.querySelector<HTMLInputElement>(".ocx-datefield-input")!;

    await act(async () => { typeInto(from, "2030-01-01"); });

    expect(text(root)).toContain("No release matches both filters.");
  });

  test("a half-typed date is kept, reported, and narrows nothing", async () => {
    const { default: Changelog } = await import("../src/components/Changelog");
    const root = await mount(<Changelog />);
    const from = root.querySelector<HTMLInputElement>(".ocx-datefield-input")!;

    await act(async () => { typeInto(from, "2026-0"); });

    // Still exactly as typed — not erased, not "corrected" to a date nobody asked for.
    expect(root.querySelector<HTMLInputElement>(".ocx-datefield-input")!.value).toBe("2026-0");
    expect(text(root)).toContain("is not a date this filter understands");
    // And the list is untouched, because an unparseable bound is not a bound.
    expect(root.querySelectorAll(".ocx-release-version")).toHaveLength(2);
  });

  test("every search field carries its own regex builder", async () => {
    const { default: Changelog } = await import("../src/components/Changelog");
    const root = await mount(<Changelog />);
    // The rule is the builder anchored beside the field, not on a separate page.
    expect(root.querySelectorAll('[aria-label="Open the regex builder"]').length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------ the strip follows the mode -- */

/*
  `navigate` is a virtual module that only exists inside Astro's Vite pipeline,
  and it is precisely the thing a test must not actually perform.
*/
mock.module("astro:transitions/client", () => ({ navigate: () => {} }));

describe("the tab strip speaks the reader's interface language", () => {
  test("a Cantonese interface renders a Cantonese strip over English articles", async () => {
    const { default: TabStrip } = await import("../src/components/TabStrip");
    const { setMode } = await import("../src/lib/i18n");

    const root = await mount(<TabStrip initialPath="/guides/docker/" initialTitle="Docker" />);
    // Default `auto` on an English page: the strip is English, exactly as it was
    // before the interface-language axis existed.
    expect(root.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("Tabs");

    await act(async () => { setMode("yue"); });
    // The article is still English; only the chrome moved. This is the wiring
    // that makes requirement 9 true of a component this stage does not own.
    expect(root.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("分頁");

    await act(async () => { setMode("auto"); });
  });
});
