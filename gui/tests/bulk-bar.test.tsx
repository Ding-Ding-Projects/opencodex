/**
 * The bulk bar, and the three sentences it must never get wrong.
 *
 * The bar's whole job is saying what a bulk action will do *before* it does it,
 * so what is pinned here is the wording and the arithmetic behind it — not that
 * buttons render. A bar that says "5 selected" while four rows will change is
 * worse than no bar, because it is believed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import BulkBar from "../src/shell/BulkBar";
import { TestLanguageProvider } from "./helpers/providers";
import { PrefsProvider } from "../src/theme/prefs";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

interface Options {
  items?: { id: string; label: string; skipReason?: string | null }[];
  selected?: string[];
  scope?: "page" | "matching" | "all";
  progress?: { done: number; total: number; onCancel: () => void } | null;
  onRun?: (ids: string[]) => void;
}

async function render(options: Options = {}): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <TestLanguageProvider>
          <BulkBar
            items={options.items ?? [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]}
            selected={new Set(options.selected ?? [])}
            scope={options.scope ?? "page"}
            actions={[{ id: "go", label: "Revoke", destructive: true, run: options.onRun ?? (() => {}) }]}
            onSelectAll={() => {}}
            onSelectNone={() => {}}
            onInvert={() => {}}
            progress={options.progress ?? null}
          />
        </TestLanguageProvider>
      </PrefsProvider>,
    );
  });
  return { container, root };
}

test("renders nothing at all when nothing is selected", async () => {
  // A bar that is always there is chrome. One that appears when it has something
  // to say is an answer.
  const { container, root } = await render({ selected: [] });
  expect(container.textContent).toBe("");
  await act(async () => { root.unmount(); });
});

test("names the scope, because 'select all' means three different things", async () => {
  const { container, root } = await render({ selected: ["a", "b"], scope: "matching" });
  expect(container.textContent).toContain("matching the current search");
  await act(async () => { root.unmount(); });
});

test("counts what will change, not what is ticked", async () => {
  // Three ticked, one protected. "3 selected" would be a lie about the outcome.
  const { container, root } = await render({
    items: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta", skipReason: "pinned" },
      { id: "c", label: "Gamma" },
    ],
    selected: ["a", "b", "c"],
  });
  expect(container.textContent).toContain("2 selected");
  expect(container.textContent).toContain("1 excluded");
  expect(container.textContent).toContain("pinned");
  await act(async () => { root.unmount(); });
});

test("hands the action only the items that will actually change", async () => {
  const seen: string[][] = [];
  const { container, root } = await render({
    items: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta", skipReason: "pinned" }],
    selected: ["a", "b"],
    onRun: ids => seen.push(ids),
  });
  const run = [...container.querySelectorAll("button")].find(b => b.textContent === "Revoke")!;
  await act(async () => { run.click(); });
  expect(seen).toEqual([["a"]]);
  await act(async () => { root.unmount(); });
});

test("offers no action when everything selected is excluded", async () => {
  const { container, root } = await render({
    items: [{ id: "b", label: "Beta", skipReason: "pinned" }],
    selected: ["b"],
  });
  const run = [...container.querySelectorAll("button")].find(b => b.textContent === "Revoke")!;
  expect(run.disabled).toBe(true);
  await act(async () => { root.unmount(); });
});

test("while running it reports progress and offers cancel, not the actions", async () => {
  let cancelled = false;
  const { container, root } = await render({
    selected: ["a"],
    progress: { done: 3, total: 10, onCancel: () => { cancelled = true; } },
  });
  expect(container.textContent).toContain("3 of 10");
  // The destructive action must not be clickable again mid-run.
  expect([...container.querySelectorAll("button")].some(b => b.textContent === "Revoke")).toBe(false);
  const cancel = [...container.querySelectorAll("button")].find(b => b.textContent === "Cancel")!;
  await act(async () => { cancel.click(); });
  expect(cancelled).toBe(true);
  await act(async () => { root.unmount(); });
});
