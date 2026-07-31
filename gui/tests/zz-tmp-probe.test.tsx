/** Throwaway adversarial probes. Delete after reading. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import TabStrip from "../src/shell/TabStrip";
import { useTabs, type Tab } from "../src/shell/use-tabs";
import { LanguageProvider } from "../src/i18n/provider";

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

const PAGES = ["dashboard", "providers", "models", "combos", "logs"] as const;
const tab = (n: number, extra: Partial<Tab> = {}): Tab => ({ id: `t${n}`, page: PAGES[n - 1], pinned: false, ...extra });
const seedTabs = (tabs: Tab[], activeTab: string) =>
  localStorage.setItem("ocx-m3:tabs", JSON.stringify({ tabs, activeTab }));

function Harness() {
  const tabs = useTabs("dashboard", () => {});
  return <TabStrip tabs={tabs} />;
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  return { container, root };
}

const tabButton = (c: HTMLElement, id: string) => c.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`)!;
const stripTabs = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
const labels = (c: HTMLElement) => stripTabs(c).map(el => el.querySelector(".m3-tab-label")?.textContent ?? "");
const ctxItems = () =>
  [...(document.body.querySelector('[role="menu"][aria-label^="Actions for"]')?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const ctxItem = (text: string) => ctxItems().find(el => el.textContent === text)!;
const bulkPanel = () => document.body.querySelector<HTMLElement>("[data-bulk-close]");
const bulkCount = () => Number(bulkPanel()!.querySelector("[data-bulk-count]")!.getAttribute("data-bulk-count"));

function key(target: Element | null, name: string, init: Record<string, unknown> = {}) {
  target?.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as never);
}
function rightClick(el: Element, init: Record<string, unknown> = {}) {
  el.dispatchEvent(new testWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init }) as never);
}
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

/* ------------------------------------------------------------------ probe 1 */

test("PROBE: Delete on a focused tab leaves focus on <body>", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t2");
  const { container, root } = await mount();

  const button = tabButton(container, "t2");
  await act(async () => { button.focus(); });
  expect(document.activeElement).toBe(button);

  await act(async () => { key(button, "Delete"); });

  expect(labels(container)).toEqual(["Dashboard", "Models"]);
  console.log("PROBE1 activeElement after Delete =", document.activeElement?.tagName, document.activeElement?.className);
  expect(document.activeElement).not.toBe(document.body);

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------------ probe 2 */

test("PROBE: clicking the strip close button leaves focus on <body>", async () => {
  seedTabs([tab(1), tab(2), tab(3)], "t2");
  const { container, root } = await mount();

  const closeBtn = container.querySelector<HTMLButtonElement>(`[data-tab-id="t2"] .m3-tab-close`)!;
  await act(async () => { closeBtn.focus(); });
  expect(document.activeElement).toBe(closeBtn);

  await act(async () => { closeBtn.click(); });

  console.log("PROBE2 activeElement after close click =", document.activeElement?.tagName, document.activeElement?.className);
  expect(document.activeElement).not.toBe(document.body);

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------------ probe 3 */

test("PROBE: flags chosen in the builder are dropped by the bulk close", async () => {
  seedTabs([tab(1), tab(2), tab(3), tab(4), tab(5)], "t1");
  const { container, root } = await mount();

  await act(async () => { rightClick(tabButton(container, "t1")); });
  await act(async () => { ctxItem("Close tabs containing text…").click(); });

  // Open the anchored builder from inside the bulk panel.
  await act(async () => {
    bulkPanel()!.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
  });
  const pop = bulkPanel()!.querySelector<HTMLElement>('[role="dialog"].m3-rxpop')!;
  const patternField = pop.querySelector<HTMLInputElement>("input[aria-invalid]")!;

  // Case-sensitive on purpose: turn the seeded `i` flag off.
  const iChip = [...pop.querySelectorAll<HTMLButtonElement>(".m3-chip")].find(c => c.textContent === "i")!;
  await act(async () => { iChip.click(); });
  await act(async () => { typeInto(patternField, "dashboard"); });

  const previewRows = pop.querySelectorAll(".m3-rxpop-row").length;
  console.log("PROBE3 builder flags shown =", pop.querySelector(".m3-rxpop-slash:last-of-type")?.textContent);
  console.log("PROBE3 builder preview match rows =", previewRows);
  expect(previewRows).toBe(0); // case-sensitive: no label is literally "dashboard"

  const apply = [...pop.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Use this pattern")!;
  await act(async () => { apply.click(); });

  console.log("PROBE3 bulk count after applying =", bulkCount());
  // The builder previewed zero. If flags survived, the bulk close also sees zero.
  expect(bulkCount()).toBe(0);

  await act(async () => { root.unmount(); });
});
