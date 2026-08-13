/**
 * Appearance screen structure.
 *
 * The prototype leads the screen with body-large copy, then a settings-search
 * row, then the settings card whose seed section proves the derived palette on
 * six role swatches. Two things are easy to lose in a refactor and are what
 * this guards: the six role swatches (without them a seed is applied blind),
 * and the settings search actually filtering *this* surface while reporting a
 * match that lives on another one instead of silently finding nothing.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Appearance from "../src/pages/Appearance";
import { TestLanguageProvider } from "./helpers/providers";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <TestLanguageProvider>
          <NotificationsProvider>
            <Appearance />
          </NotificationsProvider>
        </TestLanguageProvider>
      </PrefsProvider>,
    );
  });

  return { container, root };
}

/**
 * React shadows `value` with an instance property so it can tell a real edit from
 * a programmatic assignment. Writing through the prototype setter bypasses that
 * tracker, which is what makes the dispatched `input` event look like typing.
 */
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

test("leads with body-large copy and proves the seed on six role swatches", async () => {
  const { container, root } = await mount();

  const lead = container.querySelector(".m3-page-lead");
  expect(lead?.textContent).toContain("Theme, density, seed colour, and typography");

  const swatches = [...(container.querySelector("[data-role-swatches]")?.children ?? [])]
    .map(node => node.textContent);
  expect(swatches).toEqual(["primary", "container", "secondary", "tertiary", "error", "surface"]);

  await act(async () => { root.unmount(); });
});

test("the per-element editor names its colour group and its reset target", async () => {
  const { container, root } = await mount();

  // The colour pair is a labelled group, not two unlabelled swatches floating
  // beside the font, radius and padding controls.
  const labels = [...container.querySelectorAll(".m3-field-label")].map(node => node.textContent);
  expect(labels).toContain("Colour");

  // The per-target reset is the row's only outlined button; the two beside it
  // (reset-all and reset-appearance) are text buttons.
  const resetButton = () => container.querySelector("button.m3-btn--outlined");

  // The first target is selected on mount, so the button names it outright.
  expect(resetButton()?.textContent).toBe("Reset Navigation rail");

  // Switching target retargets the button rather than leaving generic copy that
  // could be read as clearing every override.
  const cardChip = [...container.querySelectorAll("button")].find(node => node.textContent === "Cards");
  await act(async () => { cardChip?.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as never); });
  expect(resetButton()?.textContent).toBe("Reset Cards");

  await act(async () => { root.unmount(); });
});

test("the live preview names the three Material button styles the prototype shows", async () => {
  const { container, root } = await mount();

  // Spans, not buttons — the preview is a specimen sheet, not three dead controls.
  const specimens = [...container.querySelectorAll("span.m3-btn")].map(node => node.textContent);
  expect(specimens).toEqual(["Filled", "Tonal", "Outlined"]);

  await act(async () => { root.unmount(); });
});

test("the settings search filters this surface and reports matches on another tab", async () => {
  const { container, root } = await mount();

  const search = container.querySelector<HTMLInputElement>("input[aria-label='Search settings…']");
  expect(search).toBeTruthy();

  const hitLabels = () =>
    [...(container.querySelector("[data-settings-hits]")?.children ?? [])]
      .map(node => node.firstElementChild?.textContent);

  // Unfiltered, the index lists every setting this surface owns.
  expect(hitLabels()).toEqual(["Theme", "Seed colour", "Density", "Interface font", "Text size", "Text weight"]);

  await act(async () => { typeInto(search!, "density"); });
  expect(hitLabels()).toEqual(["Density"]);

  // A miss here is not a dead end while the setting exists on another surface.
  await act(async () => { typeInto(search!, "funny"); });
  expect(hitLabels()).toEqual([]);
  expect(container.querySelector("[role='status']")?.textContent).toContain("Language & voice");

  // A genuine miss says so rather than pretending something matched.
  await act(async () => { typeInto(search!, "nothing-matches-this"); });
  expect(container.querySelector("[role='status']")?.textContent).toBe("No settings match on this surface.");

  await act(async () => { root.unmount(); });
});
