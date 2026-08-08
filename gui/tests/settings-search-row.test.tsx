/**
 * The shared settings-search row, driven the way a user drives it.
 *
 * The defect that matters most here is the one the audit named as the reason to
 * build a shared component at all: **two search bars on one screen sharing
 * state.** Twenty-two hand-wired rows each owned their own `useState`, so the
 * mistake had not been made yet — but the obvious way to "share" a search bar is
 * a context or a module-level store, and either would make every field on a
 * screen filter every other one. The last test here fails loudly if that is ever
 * done, which is why it asserts on two independent fields rather than one.
 *
 * The rest cover the contract the row owes whatever surface renders it: the
 * regex opt-in defaults off, an invalid pattern is announced rather than swallowed,
 * an off-tab hit is stated in words, and the builder that opens is bound to this
 * field — seeded from it, and writing pattern *and* flags back into it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { SettingsSearchRow } from "../src/shell/SettingsSearch";
import { useSettingsSearch } from "../src/shell/use-settings-search";
import type { SettingsOption } from "../src/shell/settings-search";

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
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const OPTIONS: SettingsOption[] = [
  { id: "theme", label: "Theme", desc: "Light or dark", value: "Dark", tab: "Look" },
  { id: "density", label: "Density", desc: "Row spacing", value: "3", tab: "Look" },
  { id: "data-key", label: "Data-plane key", desc: "Manage the model API key", value: "Configured", tab: "Security" },
];

/** A surface: the shared row, plus the rows it left visible, so both can be asserted. */
function Surface({ activeTab, label }: { activeTab?: string; label?: string }) {
  const search = useSettingsSearch({ options: OPTIONS, activeTab });
  return (
    <section>
      <SettingsSearchRow search={search} label={label} />
      <ul>
        {search.visible.map(option => <li key={option.id} data-id={option.id}>{option.label}</li>)}
      </ul>
    </section>
  );
}

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  return { container, root };
}

const fields = (c: HTMLElement) => [...c.querySelectorAll<HTMLInputElement>('input[type="search"]')];
const field = (c: HTMLElement) => fields(c)[0]!;
const statusOf = (row: HTMLElement) => row.querySelector<HTMLElement>('[role="status"], [role="alert"]')!;
const visibleIds = (c: HTMLElement) => [...c.querySelectorAll("li")].map(li => li.getAttribute("data-id"));
const regexChip = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label="Regex mode"]')!;
const builderTrigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const panel = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="dialog"].m3-rxpop');

/** Bypasses React's value tracker so the dispatched event looks like real typing. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

/* ------------------------------------------------------- filtering this surface -- */

test("typing narrows the surface to the settings that matched", async () => {
  const { container, root } = await mount(<Surface />);
  expect(visibleIds(container)).toEqual(["theme", "density", "data-key"]);

  await act(async () => { typeInto(field(container), "density"); });
  expect(visibleIds(container)).toEqual(["density"]);

  await act(async () => { root.unmount(); });
});

test("a setting is reachable by the value it currently reads", async () => {
  const { container, root } = await mount(<Surface />);
  await act(async () => { typeInto(field(container), "configured"); });
  expect(visibleIds(container)).toEqual(["data-key"]);
  await act(async () => { root.unmount(); });
});

/* ------------------------------------------- an off-tab match is said out loud -- */

// The bare "no settings match" while the setting sits one tab over is the exact
// lie this component exists to stop telling.
test("a match on another tab is stated in words, naming the tab", async () => {
  const { container, root } = await mount(<Surface activeTab="Look" />);

  await act(async () => { typeInto(field(container), "data-plane"); });

  expect(visibleIds(container)).toEqual([]);
  const status = statusOf(container).textContent ?? "";
  expect(status).toContain("Security");
  expect(status).toContain("another tab");
  // And it must NOT claim there is nothing to find.
  expect(status).not.toContain("No settings match");

  await act(async () => { root.unmount(); });
});

test("a query that matches nowhere at all does say so", async () => {
  const { container, root } = await mount(<Surface activeTab="Look" />);
  await act(async () => { typeInto(field(container), "zzzzz"); });
  expect(statusOf(container).textContent).toContain("No settings match");
  await act(async () => { root.unmount(); });
});

// The defect that shipped in the first cut of the shared component: an empty
// query matches every option, so a tabbed surface announced "N match(es) on
// another tab" permanently — a result for a search nobody had run yet.
test("an untouched field on a tabbed surface claims nothing", async () => {
  const { container, root } = await mount(<Surface activeTab="Look" />);

  expect(statusOf(container).textContent).toBe("");
  // And the visible tab is still fully rendered — the fix must not hide rows.
  expect(visibleIds(container)).toEqual(["theme", "density"]);

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------ plain text default, regex opt-in -- */

test("regex mode is off until the user switches it on", async () => {
  const { container, root } = await mount(<Surface />);
  expect(regexChip(container).getAttribute("aria-pressed")).toBe("false");

  await act(async () => { regexChip(container).click(); });
  expect(regexChip(container).getAttribute("aria-pressed")).toBe("true");

  await act(async () => { root.unmount(); });
});

// While plain text is on, a bad pattern is just text and must find nothing quietly
// rather than being reported as invalid.
test("a regex-shaped query is literal text until regex mode is on", async () => {
  const { container, root } = await mount(<Surface />);

  await act(async () => { typeInto(field(container), "Theme("); });
  expect(statusOf(container).textContent).not.toContain("Invalid pattern");
  expect(field(container).getAttribute("aria-invalid")).toBe("false");

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------ invalid patterns report -- */

test("an invalid pattern is announced as an alert on the field, not swallowed", async () => {
  const { container, root } = await mount(<Surface />);

  await act(async () => { regexChip(container).click(); });
  await act(async () => { typeInto(field(container), "Theme("); });

  const status = statusOf(container);
  expect(status.getAttribute("role")).toBe("alert");
  expect(status.textContent).toContain("Invalid pattern");
  expect(field(container).getAttribute("aria-invalid")).toBe("true");
  // The field points at the message, so a screen reader reads the two together.
  expect(field(container).getAttribute("aria-describedby")).toBe(status.id);

  await act(async () => { root.unmount(); });
});

/* --------------------------------------------------------- the builder is bound -- */

test("the builder opens beside this field, seeded from it", async () => {
  const { container, root } = await mount(<Surface />);
  await act(async () => { typeInto(field(container), "narrator"); });
  await act(async () => { builderTrigger(container).click(); });

  const opened = panel(container);
  expect(opened).not.toBeNull();
  expect(opened!.querySelector<HTMLInputElement>("input[aria-invalid]")!.value).toBe("narrator");
  // Anchored, not a navigation to the builder page.
  expect(container.querySelector('a[href="#regex"]')).toBeNull();

  await act(async () => { root.unmount(); });
});

// The flags half of "synchronize query, pattern, flags, validation and mode
// bidirectionally": a builder whose `m` was switched on, applied to a field that
// still compiles `i`, previews one set of matches and then finds another.
test("applying the builder writes the pattern, the flags and regex mode back", async () => {
  const { container, root } = await mount(<Surface />);
  await act(async () => { builderTrigger(container).click(); });

  const pattern = panel(container)!.querySelector<HTMLInputElement>("input[aria-invalid]")!;
  await act(async () => { typeInto(pattern, "^Density"); });

  const mFlag = [...panel(container)!.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.textContent === "m")!;
  await act(async () => { mFlag.click(); });

  const apply = [...panel(container)!.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.textContent === "Use this pattern")!;
  await act(async () => { apply.click(); });

  expect(field(container).value).toBe("^Density");
  // Applying switches the host into regex mode, or the pattern would be matched
  // as literal text and silently find nothing.
  expect(regexChip(container).getAttribute("aria-pressed")).toBe("true");
  expect(visibleIds(container)).toEqual(["density"]);

  // Re-opening shows the flags the field is actually compiling, `m` included.
  await act(async () => { builderTrigger(container).click(); });
  const reopened = panel(container)!;
  expect(reopened.querySelector<HTMLInputElement>("input[aria-invalid]")!.value).toBe("^Density");
  const mAfter = [...reopened.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "m")!;
  expect(mAfter.getAttribute("aria-pressed")).toBe("true");

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------- two bars, two searches -- */

// The defect the shared component is most at risk of introducing. If the state
// ever moves into a context or a module-level store, typing in one field filters
// the other surface too and this fails.
test("two search bars on one screen do not share state", async () => {
  function TwoSurfaces() {
    return (
      <div>
        <div data-row="first"><Surface label="First search" /></div>
        <div data-row="second"><Surface label="Second search" /></div>
      </div>
    );
  }
  const { container, root } = await mount(<TwoSurfaces />);

  const first = container.querySelector<HTMLElement>('[data-row="first"]')!;
  const second = container.querySelector<HTMLElement>('[data-row="second"]')!;

  await act(async () => { typeInto(field(first), "density"); });
  await act(async () => { regexChip(first).click(); });

  expect(field(first).value).toBe("density");
  expect(visibleIds(first)).toEqual(["density"]);

  // The second bar has not been touched: empty query, plain text, nothing hidden.
  expect(field(second).value).toBe("");
  expect(regexChip(second).getAttribute("aria-pressed")).toBe("false");
  expect(visibleIds(second)).toEqual(["theme", "density", "data-key"]);

  await act(async () => { root.unmount(); });
});

test("each search bar gets its own builder, bound to its own query", async () => {
  function TwoSurfaces() {
    return (
      <div>
        <div data-row="first"><Surface label="First search" /></div>
        <div data-row="second"><Surface label="Second search" /></div>
      </div>
    );
  }
  const { container, root } = await mount(<TwoSurfaces />);
  const first = container.querySelector<HTMLElement>('[data-row="first"]')!;
  const second = container.querySelector<HTMLElement>('[data-row="second"]')!;

  await act(async () => { typeInto(field(second), "data-plane"); });
  await act(async () => { builderTrigger(second).click(); });

  // Exactly one panel is open, and it is inside the second row, seeded from the
  // second query — not from whichever field was touched last in some shared store.
  expect(panel(first)).toBeNull();
  expect(panel(second)).not.toBeNull();
  expect(panel(second)!.querySelector<HTMLInputElement>("input[aria-invalid]")!.value).toBe("data-plane");

  await act(async () => { root.unmount(); });
});

// Two rows on one screen must not collide on the id that binds a field to its
// message, or both fields describe the same status line and one of them lies.
test("each row's status line has its own id", async () => {
  function TwoSurfaces() {
    return (
      <div>
        <div data-row="first"><Surface label="First search" /></div>
        <div data-row="second"><Surface label="Second search" /></div>
      </div>
    );
  }
  const { container, root } = await mount(<TwoSurfaces />);
  const first = container.querySelector<HTMLElement>('[data-row="first"]')!;
  const second = container.querySelector<HTMLElement>('[data-row="second"]')!;

  expect(statusOf(first).id).not.toBe(statusOf(second).id);

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------------- accessibility -- */

test("the row is a search landmark whose field and controls are all named", async () => {
  const { container, root } = await mount(<Surface label="Search settings…" />);

  expect(container.querySelector('[role="search"]')).not.toBeNull();
  expect(field(container).getAttribute("aria-label")).toBe("Search settings…");
  expect(regexChip(container).getAttribute("aria-label")).toBe("Regex mode");
  expect(builderTrigger(container).getAttribute("aria-label")).toBe("Open regex builder");
  expect(builderTrigger(container).getAttribute("aria-expanded")).toBe("false");

  await act(async () => { root.unmount(); });
});
