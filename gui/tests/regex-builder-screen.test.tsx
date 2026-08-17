/**
 * Regex builder screen structure.
 *
 * The prototype's regex section leads with body-large copy and the engine line,
 * groups the guided palette into six labelled sections, and puts the matches and
 * capture-groups panels side by side. A section quietly dropping out — most
 * easily the capture-groups panel, which only appears once a pattern declares a
 * named group — is the regression this guards.
 *
 * The capture index is asserted deliberately: a named group that follows unnamed
 * ones is not `$1`, and numbering the names in the order they are found is the
 * wrong answer the panel must not go back to.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import RegexBuilder from "../src/pages/RegexBuilder";
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
            <RegexBuilder />
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

test("leads with the page lead, the engine line and the three named cards", async () => {
  const { container, root } = await mount();

  expect(container.querySelector(".m3-page-lead")?.textContent).toBe(
    "Build and test a pattern, then use it in any search bar that has the .* toggle switched on.",
  );

  const titles = [...container.querySelectorAll(".m3-card-title")].map(n => n.textContent);
  expect(titles).toEqual(["Guided construction", "Matches", "Capture groups"]);

  await act(async () => { root.unmount(); });
});

test("groups the guided palette into the prototype's six sections", async () => {
  const { container, root } = await mount();

  const headings = [...container.querySelectorAll("h3")].map(n => n.textContent);
  expect(headings).toEqual([
    "Literals",
    "Character classes",
    "Anchors",
    "Groups",
    "Alternation",
    "Quantifiers",
  ]);

  await act(async () => { root.unmount(); });
});

test("lists named capture groups at the index the engine really assigns them", async () => {
  const { container, root } = await mount();

  const pattern = container.querySelector("#ocx-rx-pattern") as unknown as HTMLInputElement;
  // Two unnamed groups first, so a panel that numbers names in order would say $1.
  await act(async () => { typeInto(pattern, "(a)(?:x)(b)(?<tail>c+)"); });

  const groupsPanel = [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector(".m3-card-title")?.textContent === "Capture groups");
  const cells = [...(groupsPanel?.querySelectorAll("li span") ?? [])].map(n => n.textContent);
  expect(cells.slice(0, 2)).toEqual(["$3", "tail"]);

  await act(async () => { root.unmount(); });
});

test("says a pattern declares no named group, and stays silent when there is no pattern", async () => {
  const { container, root } = await mount();

  const groupsPanel = () => [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector(".m3-card-title")?.textContent === "Capture groups");
  const pattern = container.querySelector("#ocx-rx-pattern") as unknown as HTMLInputElement;

  await act(async () => { typeInto(pattern, "\\d+"); });
  expect(groupsPanel()?.querySelector("p")?.textContent)
    .toBe("This pattern declares no named capture group.");

  // Nothing typed yet: an empty box beats a sentence about a pattern that does not exist.
  await act(async () => { typeInto(pattern, ""); });
  expect(groupsPanel()?.querySelector("p")?.textContent).toBe("");

  // Invalid: the error line already says what is wrong, so the panel does not add to it.
  await act(async () => { typeInto(pattern, "(?<"); });
  expect(groupsPanel()?.querySelector("p")?.textContent).toBe("");

  await act(async () => { root.unmount(); });
});

test("labels each capture once, by its declared name where it has one", async () => {
  const { container, root } = await mount();

  const pattern = container.querySelector("#ocx-rx-pattern") as unknown as HTMLInputElement;
  const sample = container.querySelector("#ocx-rx-sample") as unknown as HTMLInputElement;
  await act(async () => { typeInto(sample, "ab"); });
  await act(async () => { typeInto(pattern, "(a)(?<tail>b)"); });

  const matchesPanel = [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector(".m3-card-title")?.textContent === "Matches");
  const label = [...(matchesPanel?.querySelectorAll("li span") ?? [])].map(n => n.textContent).pop();
  // Not "$1=a  $2=b  tail=b" — the named group must not be printed a second time.
  expect(label).toBe("$1=a  tail=b");

  await act(async () => { root.unmount(); });
});

test("states the local-evaluation safety caps the builder actually enforces", async () => {
  const { container, root } = await mount();

  const note = [...container.querySelectorAll("p")].map(n => n.textContent ?? "")
    .find(text => text.includes("Evaluated locally"));
  expect(note).toContain("400");
  expect(note).toContain("20000");
  expect(note).toContain("200");

  await act(async () => { root.unmount(); });
});
