import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { NotificationsProvider } from "../src/shell/notifications";

/**
 * The Desktop tab is a settings surface, so it owes its user its own settings search:
 * plain text by default, `.*` as an explicit opt-in, an invalid pattern that matches
 * nothing and says so, and a cross-tab hit reported by the tab that actually owns it.
 *
 * Mounted rather than shape-tested because the interesting failures are interactive —
 * a query that empties the screen, or a field that quietly shares its mode with the
 * per-lane model filters below it.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function model(route: string, label: string, family: string) {
  return {
    route,
    label,
    available: true,
    contextWindow: 200_000,
    effortSupported: true,
    assignment: { family, alias: `alias-${label}` },
  };
}

// Seven Opus models so the lane's own search input is in play (LANE_SEARCH_MIN = 4)
// and the two fields can be told apart.
const MODELS = [
  ...Array.from({ length: 7 }, (_, i) => model(`prov/opus-${i}`, `Opus Model ${i}`, "opus")),
  model("prov/only-sonnet", "Sonnet Model", "sonnet"),
];

function payload() {
  return {
    profile: {
      version: 1,
      assignments: Object.fromEntries(MODELS.map(m => [m.route, m.assignment])),
      defaults: { opus: "prov/opus-0", fable: null, sonnet: "prov/only-sonnet", haiku: null },
    },
    models: MODELS,
    rendered: [],
    port: 10100,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const body = String(url).includes("/status")
        ? { applied: true, appliedAt: null, stale: false, health: { lastRequestAt: null, requestCount: 0, errorCount: 0 } }
        : payload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  // Imported here, not at module scope: `react-dom/client` has to be resolved AFTER the
  // happy-dom globals are installed, or its input value-tracker never sees this document
  // and every typed character silently fails to reach React.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      // The screen reports save/import outcomes through the notification system
      // now, so the provider it reads has to exist even when a test never
      // triggers one — without it the whole screen throws on mount.
      <LanguageProvider><NotificationsProvider><ClaudeDesktop apiBase="" /></NotificationsProvider></LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function settingsInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[aria-label="Search settings…"]');
  expect(el).toBeTruthy();
  return el!;
}

/** The `.*` chip belonging to the settings row, not to a lane's model filter. */
function settingsRegexChip(): HTMLButtonElement {
  const row = settingsInput().closest('[role="search"]')!;
  const chip = row.querySelector<HTMLButtonElement>("button.m3-chip");
  expect(chip).toBeTruthy();
  return chip!;
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    // Through the native prototype setter, so React's value tracker sees a real change.
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });
}

test("the Desktop tab heads its own settings search, above the controls it describes", async () => {
  await mount();

  expect([...container.querySelectorAll("h2")].map(h => h.textContent)).toContain("Settings");

  const input = settingsInput();
  // Labelled, keyboard reachable, and carrying the builder shortcut beside it.
  expect(input.getAttribute("placeholder")).toBe("Search settings…");
  const row = input.closest('[role="search"]')!;
  // A button that opens the builder beside this field, not a link to the builder
  // page: navigating away abandoned the query the user was in the middle of typing.
  const builder = row.querySelector('button[aria-haspopup="dialog"]');
  expect(builder?.getAttribute("aria-label")).toBe("Open regex builder");
  expect(row.querySelector('a[href="#regex"]')).toBeNull();

  // Above the assignments it describes, not buried under four families.
  const stack = container.querySelector(".ocx-group-stack")!;
  expect(row.compareDocumentPosition(stack) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
});

test("plain text is the default and finds a setting by an option label", async () => {
  await mount();
  expect(settingsRegexChip().getAttribute("aria-pressed")).toBe("false");

  await type(settingsInput(), "Sonnet");

  const hits = container.querySelector("[data-settings-hits]")!;
  expect(hits.textContent).toContain("Move to");
  expect(container.textContent).not.toContain("No settings match on this surface.");
});

test("an untouched field lists nothing — the controls below already show every setting", async () => {
  await mount();
  expect(container.querySelector("[data-settings-hits]")).toBeNull();
});

test("a query matching nothing here says so instead of emptying the screen", async () => {
  await mount();
  await type(settingsInput(), "zzzz-no-such-setting");

  expect(container.textContent).toContain("No settings match on this surface.");
  // The assignments stay put: the search reports, it does not hide the controls.
  expect(container.querySelector(".ocx-group-stack")).not.toBeNull();
});

test("a setting that lives on the Code tab is reported by that tab's name", async () => {
  await mount();
  await type(settingsInput(), "Auth Mode");

  expect(container.textContent).toContain("match(es) on other tabs");
  expect(container.textContent).toContain("Code");
});

test("the `.*` chip is an explicit opt-in, and an invalid pattern matches nothing and says why", async () => {
  await mount();
  await act(async () => { settingsRegexChip().click(); });
  expect(settingsRegexChip().getAttribute("aria-pressed")).toBe("true");

  await type(settingsInput(), "Import|Export");
  expect(container.querySelector("[data-settings-hits]")?.textContent).toContain("Import JSON");

  await type(settingsInput(), "Import(");
  expect(container.textContent).toContain("Invalid pattern");
  // No silent fallback to substring search: the reported error and the result agree.
  expect(container.querySelector("[data-settings-hits]")).toBeNull();
  expect(settingsInput().getAttribute("aria-invalid")).toBe("true");
});

test("the settings field owns its own query and mode — the lane filters are untouched", async () => {
  await mount();
  await act(async () => { settingsRegexChip().click(); });
  await type(settingsInput(), "Move to");

  const laneInput = container.querySelector<HTMLInputElement>("input.claude-lane-search")!;
  expect(laneInput.value).toBe("");
  const laneChip = laneInput.closest('[role="search"]')!.querySelector("button.m3-chip")!;
  expect(laneChip.getAttribute("aria-pressed")).toBe("false");
  // And the lane still renders every model: a settings query is not a model filter.
  expect(container.querySelectorAll(".claude-model-card").length).toBeGreaterThan(0);
});
