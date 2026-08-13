/**
 * Bulk selection on the Models page, which is grouped by provider.
 *
 * The grouping is the whole risk. Every action here is a per-provider API call,
 * so a selection that reached across groups would send one provider's rows to
 * another's endpoint.
 *
 * Most of that boundary is **structural rather than asserted**, and it is worth
 * being precise about which is which, because a test that cannot fail is worse
 * than no test — it reads as protection. The selection is a record keyed by
 * provider and each group derives its rows from its own `visible` slice, so a
 * hypothetical select-all that swept in another group's ids would be re-scoped
 * away before it could act: mutating the code that way changes nothing
 * observable, and these tests correctly do not pretend to catch it.
 *
 * What they do catch, verified by breaking the code and watching them go red:
 *
 *  - the per-provider shift-click anchor, which is the one piece of per-group
 *    state with a real behavioural difference (see the anchor test);
 *  - the skip — enable and disable apply to every row, delete applies only to
 *    models the user added themselves, and the rest are counted and explained
 *    rather than dropped from the total;
 *  - which rows an enable/disable request actually carries.
 *
 * The remaining tests pin observable behaviour a reader would expect to hold —
 * one bar per group with something to say, a shift-click that does not sweep
 * across a boundary — without claiming to be the thing that enforces it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";
import { ConfirmProvider } from "../src/shell/confirm";
import Models from "../src/pages/Models";

const domGlobals = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDescriptors: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let previousLanguage: unknown;
let testWindow: Window;
const originalFetch = globalThis.fetch;

/** Two providers, so "does this cross a group?" is a question the test can ask. */
const ALPHA = "alpha";
const BETA = "beta";

interface Row { provider: string; id: string; namespaced: string; disabled?: boolean; custom?: boolean; customId?: string }

const rows: Row[] = [
  { provider: ALPHA, id: "a-one", namespaced: `${ALPHA}/a-one`, custom: true, customId: "ca1" },
  { provider: ALPHA, id: "a-two", namespaced: `${ALPHA}/a-two`, custom: true, customId: "ca2" },
  // Not custom: enable/disable reaches it, delete must not.
  { provider: ALPHA, id: "a-three", namespaced: `${ALPHA}/a-three` },
  { provider: BETA, id: "b-one", namespaced: `${BETA}/b-one`, custom: true, customId: "cb1" },
];

let visibilityBodies: Array<{ scope: string; provider: string; targets: Array<{ id: string }>; enabled: boolean }>;
let deletedCustomIds: string[];

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  previousDescriptors = Object.fromEntries(
    domGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousDescriptors;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // The page polls; this test drives it explicitly instead.
  Object.defineProperty(testWindow, "setInterval", { configurable: true, value: () => 1 });

  visibilityBodies = [];
  deletedCustomIds = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/models")) return Response.json(rows);
    if (url.endsWith("/api/providers")) {
      return Response.json([
        { name: ALPHA, liveModels: false, models: rows.filter(r => r.provider === ALPHA).map(r => r.id) },
        { name: BETA, liveModels: false, models: rows.filter(r => r.provider === BETA).map(r => r.id) },
      ]);
    }
    if (url.endsWith("/api/selected-models")) {
      return Response.json({
        selected: { [ALPHA]: rows.filter(r => r.provider === ALPHA).map(r => r.id), [BETA]: [rows[3].id] },
        available: { [ALPHA]: rows.filter(r => r.provider === ALPHA).map(r => r.id), [BETA]: [rows[3].id] },
      });
    }
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") {
      visibilityBodies.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (url.includes("/api/custom-models/") && init?.method === "DELETE") {
      deletedCustomIds.push(decodeURIComponent(url.split("/api/custom-models/")[1]!));
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of domGlobals) {
    const descriptor = previousDescriptors[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: previousLanguage });
});

async function settle() {
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function mount(): Promise<HTMLElement> {
  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.append(container);
  let root!: Root;
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <ConfirmProvider>
            <Models apiBase="http://localhost" />
          </ConfirmProvider>
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await settle();
  await settle();
  return container;
}

/** The tick box for one model, found by the accessible name the row gives it. */
function checkFor(container: HTMLElement, namespaced: string): HTMLInputElement {
  const box = container.querySelector<HTMLInputElement>(`input.models-row-check[aria-label="Select ${namespaced}"]`);
  if (!box) throw new Error(`no tick box for ${namespaced}`);
  return box;
}

/** Every bulk bar currently on screen, in document order. */
function bars(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".m3-bulkbar")];
}

function buttonIn(scope: HTMLElement, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => (node.textContent ?? "").includes(text));
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

async function click(node: Element, init: { shiftKey?: boolean } = {}) {
  await act(async () => {
    node.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, cancelable: true, ...init }) as never);
  });
  await settle();
}

test("each provider group has its own bar, and selecting in one leaves the other alone", async () => {
  const container = await mount();
  expect(bars(container)).toHaveLength(0);

  await click(checkFor(container, `${ALPHA}/a-one`));
  // Exactly one bar: the group that has something to say, not every group.
  expect(bars(container)).toHaveLength(1);
  expect(bars(container)[0].textContent).toContain("1 selected");
  expect(checkFor(container, `${BETA}/b-one`).checked).toBe(false);

  await click(checkFor(container, `${BETA}/b-one`));
  expect(bars(container)).toHaveLength(2);
});

test("select all ticks this group's rows and leaves the other group's alone", async () => {
  const container = await mount();
  await click(checkFor(container, `${ALPHA}/a-one`));
  await click(buttonIn(bars(container)[0], "Select all"));

  for (const id of ["a-one", "a-two", "a-three"]) {
    expect(checkFor(container, `${ALPHA}/${id}`).checked).toBe(true);
  }
  // The other provider is untouched, and has no bar to show for it.
  expect(checkFor(container, `${BETA}/b-one`).checked).toBe(false);
  expect(bars(container)).toHaveLength(1);
});

test("a shift-click cannot extend a range across two groups", async () => {
  const container = await mount();
  // Anchor in alpha, then shift-click in beta. What stops the sweep is that the
  // range is computed over BETA's row order, which does not contain the alpha
  // anchor — `selectRange` falls back to a plain toggle rather than computing a
  // range from `indexOf` returning -1.
  await click(checkFor(container, `${ALPHA}/a-one`));
  await click(checkFor(container, `${BETA}/b-one`), { shiftKey: true });

  expect(checkFor(container, `${ALPHA}/a-one`).checked).toBe(true);
  expect(checkFor(container, `${ALPHA}/a-two`).checked).toBe(false);
  expect(checkFor(container, `${ALPHA}/a-three`).checked).toBe(false);
  expect(checkFor(container, `${BETA}/b-one`).checked).toBe(true);
});

test("shift-click does extend within one group", async () => {
  const container = await mount();
  await click(checkFor(container, `${ALPHA}/a-one`));
  await click(checkFor(container, `${ALPHA}/a-three`), { shiftKey: true });
  expect(checkFor(container, `${ALPHA}/a-two`).checked).toBe(true);
});

test("a group remembers its own anchor after you touch another group", async () => {
  // This is what the PER-PROVIDER anchor actually buys, and the previous test
  // does not prove it: the cross-group case is already handled by the range
  // being computed over one group's order. Here alpha's anchor must survive a
  // detour through beta.
  //
  // With a single shared anchor the detour overwrites it, the shift-click below
  // finds an anchor that is not in alpha's order, and it degrades to a plain
  // toggle — the range silently does nothing and a-two stays unticked.
  const container = await mount();
  await click(checkFor(container, `${ALPHA}/a-one`));
  await click(checkFor(container, `${BETA}/b-one`));
  await click(checkFor(container, `${ALPHA}/a-three`), { shiftKey: true });

  expect(checkFor(container, `${ALPHA}/a-two`).checked).toBe(true);
  // And the detour is still selected — extending alpha did not disturb beta.
  expect(checkFor(container, `${BETA}/b-one`).checked).toBe(true);
});

test("rows that are not custom are counted and excluded from delete, with a reason", async () => {
  const container = await mount();
  await click(checkFor(container, `${ALPHA}/a-one`));
  await click(buttonIn(bars(container)[0], "Select all"));

  const text = bars(container)[0].textContent ?? "";
  // Two counts in one sentence: what delete would touch, and what it would not.
  expect(text).toContain("2 selected");
  expect(text).toContain("1 excluded");
  expect(text).toContain("not a custom model");

  await click(buttonIn(bars(container)[0], "Delete selected"));
  const confirmButton = [...testWindow.document.querySelectorAll<HTMLButtonElement>("button")]
    .filter(node => (node.textContent ?? "").includes("Delete selected"))
    .at(-1)!;
  await click(confirmButton);

  // The discovered row is genuinely never deleted, not merely uncounted.
  expect(deletedCustomIds.sort()).toEqual(["ca1", "ca2"]);
});

test("enable and disable send only the selected rows, to their own provider", async () => {
  const container = await mount();
  await click(checkFor(container, `${ALPHA}/a-one`));
  await click(checkFor(container, `${ALPHA}/a-three`));
  await click(buttonIn(bars(container)[0], "Disable selected"));

  expect(visibilityBodies).toHaveLength(1);
  const body = visibilityBodies[0];
  expect(body.provider).toBe(ALPHA);
  expect(body.enabled).toBe(false);
  // Not a-two, which was never ticked, and nothing from beta.
  expect(body.targets.map(target => target.id).sort()).toEqual(["a-one", "a-three"]);
});
