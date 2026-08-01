/**
 * Bulk removal in the Combos rail.
 *
 * The interesting assertions are not "two rows got deleted". They are the three
 * ways a bulk action lies, checked against the rendered surface: the count on
 * the bar must equal the rows that will change, an excluded row must be excluded
 * *and* explained, and a run where one removal fails must not report success.
 * Every one of those is invisible to the type system and cheap to break.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ComboItem } from "../src/combo-workspace-data";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import { ConfirmProvider } from "../src/shell/confirm";
import { HISTORY_KEY } from "../src/shell/notifications-context";
import { NotificationsProvider } from "../src/shell/notifications";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

function combo(id: string): ComboItem {
  return {
    id,
    model: `combo/${id}`,
    alias: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5", clientKey: `ct-${id}` }],
  };
}

const combos = [combo("alpha"), combo("beta"), combo("gamma")];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
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

async function flush() {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
}

interface Mounted {
  container: HTMLElement;
  removed: string[];
}

async function mount(onRemove?: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>): Promise<Mounted> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const removed: string[] = [];
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <NotificationsProvider>
          <ConfirmProvider>
            <ComboWorkspace
              combos={combos}
              providers={[{ name: "openai" }]}
              models={[{ provider: "openai", id: "gpt-5" }]}
              loading={false}
              onRefresh={() => {}}
              onSave={async () => ({ ok: true })}
              onRemove={async id => {
                removed.push(id);
                return onRemove ? await onRemove(id) : { ok: true };
              }}
              onAdd={() => {}}
              adding={false}
              onCloseAdd={() => {}}
              onCreated={() => {}}
            />
          </ConfirmProvider>
        </NotificationsProvider>
      </LanguageProvider>,
    );
  });
  await flush();
  return { container, removed };
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>(".combos-workspace-rail-check")];
}

function bar(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".m3-bulkbar");
}

/**
 * What the app told the user, read from the notification history.
 *
 * The provider is context-only — the snackbar stack is mounted by the app root,
 * not by this component — so asserting on rendered toast text here would be
 * asserting about a tree the test never built. The history is the same record
 * the notification centre shows, and the provider writes it on every notify.
 */
function notices(): Array<{ tone: string; title: string }> {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
}

function lastNoticeTitle(): string {
  return notices()[0]?.title ?? "";
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => (node.textContent ?? "").includes(text));
}

async function click(node: Element, init: { shiftKey?: boolean } = {}) {
  await act(async () => {
    node.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

test("the bar stays hidden until something is ticked", async () => {
  const { container } = await mount();
  // A bar that is always there is chrome; one that appears when it has something
  // to say is an answer.
  expect(bar(container)).toBeNull();
  expect(checkboxes(container)).toHaveLength(3);

  await click(checkboxes(container)[0]);
  expect(bar(container)).toBeTruthy();
  expect(bar(container)!.textContent).toContain("1 selected");
});

test("shift-click selects the run between the two rows", async () => {
  const { container } = await mount();
  await click(checkboxes(container)[0]);
  await click(checkboxes(container)[2], { shiftKey: true });
  expect(checkboxes(container).filter(box => box.checked)).toHaveLength(3);
  expect(bar(container)!.textContent).toContain("3 selected");
});

test("select all, invert and clear agree with the ticked rows", async () => {
  const { container } = await mount();
  await click(checkboxes(container)[0]);

  await click(buttonWithText(container, "Select all")!);
  expect(checkboxes(container).filter(box => box.checked)).toHaveLength(3);

  await click(buttonWithText(container, "Invert")!);
  // Inverting a full selection empties it, which takes the bar with it.
  expect(bar(container)).toBeNull();

  await click(checkboxes(container)[1]);
  await click(buttonWithText(container, "Clear selection")!);
  expect(bar(container)).toBeNull();
});

test("removing runs once per ticked row and reports the real count", async () => {
  const { container, removed } = await mount();
  await click(checkboxes(container)[0]);
  await click(checkboxes(container)[1]);
  await click(buttonWithText(container, "Remove selected")!);

  // Destructive, so it must stop for a decision rather than just running.
  const confirmButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter(node => (node.textContent ?? "").includes("Remove selected"))
    .at(-1)!;
  await click(confirmButton);
  await flush();

  expect(removed).toEqual(["alpha", "beta"]);
  expect(lastNoticeTitle()).toContain("2 succeeded");
});

test("a failure inside the run is reported instead of a clean success", async () => {
  // The failure this guards: a batch that half worked reporting "Done". A user
  // who believes that stops looking, and finds out later.
  const { container, removed } = await mount(async id =>
    id === "beta" ? { ok: false, error: "nope" } : { ok: true });
  await click(checkboxes(container)[0]);
  await click(checkboxes(container)[1]);
  await click(buttonWithText(container, "Remove selected")!);
  const confirmButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter(node => (node.textContent ?? "").includes("Remove selected"))
    .at(-1)!;
  await click(confirmButton);
  await flush();

  expect(removed).toEqual(["alpha", "beta"]);
  expect(lastNoticeTitle()).toContain("1 succeeded");
  expect(lastNoticeTitle()).toContain("1 failed");
  expect(notices()[0]?.tone).toBe("error");
});

test("the combo being edited is excluded, counted separately, and explained", async () => {
  const { container, removed } = await mount();

  // Open alpha and dirty it. Removing it now would throw away edits the user
  // never chose to discard, so it must drop out of the batch — visibly.
  await click(container.querySelectorAll(".combos-workspace-rail-row")[0]);
  const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(alias, "edited-alias");
    alias.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await flush();

  // The bar only exists once something is ticked, so tick one row to summon it
  // before asking it to select the rest.
  await click(checkboxes(container)[1]);
  await click(buttonWithText(container, "Select all")!);
  const text = bar(container)!.textContent ?? "";
  // Two counts in one sentence: what will change, and what will not and why.
  expect(text).toContain("2 selected");
  expect(text).toContain("1 excluded");
  expect(text).toContain("open with unsaved changes");

  await click(buttonWithText(container, "Remove selected")!);
  const confirmButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter(node => (node.textContent ?? "").includes("Remove selected"))
    .at(-1)!;
  await click(confirmButton);
  await flush();

  // The excluded row is genuinely not touched, not merely uncounted.
  expect(removed).toEqual(["beta", "gamma"]);
});

test("cancelling the confirmation removes nothing", async () => {
  const { container, removed } = await mount();
  await click(checkboxes(container)[0]);
  await click(buttonWithText(container, "Remove selected")!);
  const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => (node.textContent ?? "").trim() === "Cancel");
  expect(cancel).toBeTruthy();
  await click(cancel!);
  expect(removed).toEqual([]);
});
