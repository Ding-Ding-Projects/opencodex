import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { DashboardInjectionPanel } from "../src/pages/dashboard-overview-sections";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;
let requests: unknown[] = [];

type Dash = ReturnType<typeof useDashboardData>;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  try {
    if (root) {
      const current = root;
      await act(async () => { current.unmount(); });
    }
  } finally {
    root = null;
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

/**
 * The two pickers this panel owns, by accessible name. They are native
 * `<select>` elements now — the hand-rolled listbox button is gone — so a choice
 * is made by setting `.value` and firing `change` rather than by opening a menu
 * and clicking an option element.
 */
function selectByLabel(label: string): HTMLSelectElement | null {
  return host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

function dash(overrides: Partial<Dash> = {}): Dash {
  return {
    t: (key: keyof typeof en) => en[key],
    injectionModel: "anthropic/claude-sonnet-5",
    injectionEffort: "high",
    injectionEfforts: ["low", "medium", "high"],
    injectionAvailable: [{ provider: "anthropic", model: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5" }],
    injectionSaving: false,
    multiAgentGuidanceEnabled: false,
    syncCodexSubagentDefaults: true,
    saveInjection: async (patch) => { requests.push(patch); },
    ...overrides,
  } as unknown as Dash;
}

async function mount(d: Dash) {
  // ReactDOM must observe the happy-dom globals installed by beforeEach. A static
  // import binds to the prior document state and corrupts sibling suites.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<DashboardInjectionPanel apiBase="" d={d} />);
  });
}

test("renders independent guidance and native-default controls with editable selection", async () => {
  await mount(dash());

  const model = selectByLabel("Sub-agent delegation")!;
  const effort = selectByLabel("Reasoning effort")!;
  const defaults = host.querySelector<HTMLButtonElement>('button[aria-label="Use as native Codex subagent defaults"]')!;
  const guidance = host.querySelector<HTMLButtonElement>('button[aria-label="OpenCodex multi-agent guidance"]')!;

  expect(model.disabled).toBe(false);
  expect(effort.disabled).toBe(false);
  expect(defaults.disabled).toBe(false);
  // Supersession: the Material 3 restyle swapped the legacy `.switch` button
  // (aria-pressed) for the M3 `Toggle`, whose accessibility contract is
  // role="switch" + aria-checked. Same invariant, current attribute pair.
  expect(defaults.getAttribute("role")).toBe("switch");
  expect(defaults.getAttribute("aria-checked")).toBe("true");
  expect(guidance.getAttribute("aria-checked")).toBe("false");
  expect(host.textContent).not.toContain("Guidance active");
});

test("requires a selected model before enabling native Codex subagent defaults", async () => {
  await mount(dash({
    injectionModel: "",
    injectionEffort: "",
    injectionEfforts: [],
    syncCodexSubagentDefaults: false,
  }));

  const model = selectByLabel("Sub-agent delegation")!;
  const defaults = host.querySelector<HTMLButtonElement>('button[aria-label="Use as native Codex subagent defaults"]')!;
  expect(model.disabled).toBe(false);
  expect(defaults.disabled).toBe(true);
});

test("sends the native-default opt-in independently from guidance", async () => {
  await mount(dash({
    syncCodexSubagentDefaults: false,
  }));

  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Use as native Codex subagent defaults"]')!.click();
    await Promise.resolve();
  });

  expect(requests).toEqual([{ syncCodexSubagentDefaults: true }]);
});

test("sends model clearing through the shared save path", async () => {
  await mount(dash());

  const model = selectByLabel("Sub-agent delegation")!;
  // "None" is still the empty-valued entry it was in the legacy listbox, so
  // choosing it still means "clear the model" rather than "pick a model named None".
  expect([...model.options].find(option => option.textContent === "None")?.value).toBe("");
  await choose(model, "");

  expect(requests).toEqual([{ model: null, effort: "high" }]);
});
