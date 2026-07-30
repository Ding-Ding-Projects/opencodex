/**
 * Language & voice screen structure.
 *
 * The prototype's screen carries a body-large page lead, three titled cards —
 * interface language, narrator, dim sum — an untitled funny-level card holding
 * both per-language sliders and the five-level ladder, and a settings search.
 * Both switches must expose `role="switch"` + `aria-checked`, which is the
 * accessibility contract the shell's design handoff states. A card or control
 * silently dropping out of this screen is the failure these guard.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import LanguageVoice from "../src/pages/LanguageVoice";
import { LanguageProvider } from "../src/i18n/provider";
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
        <LanguageProvider>
          <NotificationsProvider>
            <LanguageVoice />
          </NotificationsProvider>
        </LanguageProvider>
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

test("renders the language, narrator and dim sum cards with accessible switches", async () => {
  const { container, root } = await mount();

  const titles = [...container.querySelectorAll(".m3-card-title")].map(n => n.textContent);
  expect(titles).toEqual(["Interface language", "Narrator", "Dim sum surprise"]);

  const switches = [...container.querySelectorAll('[role="switch"]')];
  expect(switches).toHaveLength(2);
  expect(switches.every(s => s.getAttribute("aria-checked") !== null)).toBe(true);
  // The narrator is off by default; the dim sum surprise is on.
  expect(switches[0].getAttribute("aria-checked")).toBe("false");
  expect(switches[1].getAttribute("aria-checked")).toBe("true");

  // happy-dom exposes no speechSynthesis, so the narrator genuinely cannot run
  // here and the test button is disabled for that reason — not because the
  // narrator is merely switched off. (When speech IS available and the narrator
  // is off, the button stays pressable and warns instead of speaking.)
  const testButton = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Speak a test message"));
  expect(testButton?.disabled).toBe(true);

  await act(async () => { root.unmount(); });
});

test("leads with the body-large page lead the prototype opens on", async () => {
  const { container, root } = await mount();

  const lead = container.querySelector(".m3-page-lead");
  expect(lead?.textContent).toBe(
    "Language mode, per-language funny level, spoken narration, and the dim sum surprise.",
  );

  await act(async () => { root.unmount(); });
});

// Two independent sliders, one per language, are a shipping requirement — a single
// shared control does not satisfy it.
test("ships one funny-level slider per language, each 1–5 and persisted", async () => {
  const { container, root } = await mount();

  const sliders = [...container.querySelectorAll('input[type="range"]')] as unknown as HTMLInputElement[];
  expect(sliders.map(s => s.id)).toEqual(["ocx-fun-en", "ocx-fun-yue"]);
  expect(sliders.every(s => s.min === "1" && s.max === "5")).toBe(true);

  const labels = [...container.querySelectorAll(".m3-slider-row .m3-field-label")].map(n => n.textContent);
  expect(labels).toEqual(["Funny level — English", "Funny level — 廣東話"]);

  await act(async () => { typeInto(sliders[1], "5"); });

  expect(JSON.parse(localStorage.getItem("ocx-m3:funny") ?? "{}")).toEqual({ en: 3, yue: 5 });

  await act(async () => { root.unmount(); });
});

// The ladder is what makes the "voice changes, facts do not" promise checkable.
// It used to print one identical sentence at all five rungs, and this test
// asserted that — codifying the limitation instead of the promise. The voice
// overlay now supplies real per-level wording, so the invariant worth pinning is
// the interesting one: the tone moves, the facts do not.
test("the funny ladder changes voice across levels while the facts stay put", async () => {
  const { container, root } = await mount();

  const heading = [...container.querySelectorAll(".m3-field-label")]
    .find(n => n.textContent === "The same destructive warning at every level");
  expect(heading).toBeTruthy();

  const rungs = [...heading!.nextElementSibling!.children];
  expect(rungs).toHaveLength(5);
  expect(rungs.map(r => r.firstElementChild?.textContent))
    .toEqual(["Level 1", "Level 2", "Level 3", "Level 4", "Level 5"]);

  const texts = rungs.map(r => r.lastElementChild?.textContent ?? "");

  // Voice actually varies: a slider that changes nothing is the defect this
  // whole overlay exists to remove.
  expect(new Set(texts).size).toBeGreaterThan(1);

  // ...and every rung still states the two facts that must never be styled
  // away: what is destroyed, and that it cannot be taken back.
  for (const text of texts) {
    expect(text.toLowerCase()).toMatch(/delete|deletes|gone|vaporised/);
    expect(text.toLowerCase()).toMatch(/undo|cannot be undone|no take-backs|point of no return/);
  }

  await act(async () => { root.unmount(); });
});

test("show one now reveals a named dim sum dish without blocking anything", async () => {
  const { container, root } = await mount();

  const button = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Show one now"));
  expect(button).toBeTruthy();
  expect(container.querySelector('[role="status"]')).toBeNull();

  await act(async () => {
    button!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
  });

  const card = container.querySelector('[role="status"]');
  expect(card).toBeTruthy();
  // The dish is named for screen readers too — the art alone is not the label.
  expect(card?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBeTruthy();
  // Non-blocking: nothing modal, nothing focus-trapped.
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await act(async () => { root.unmount(); });
});

// Every settings surface carries its own search wired to the regex builder.
test("the settings search filters this surface and reports an honest no-match", async () => {
  const { container, root } = await mount();

  const search = container.querySelector('[role="search"] input') as unknown as HTMLInputElement;
  expect(search.placeholder).toBe("Search settings…");
  expect(container.querySelector('[role="search"] a[href="#regex"]')).toBeTruthy();

  await act(async () => { typeInto(search, "narrator"); });
  expect([...container.querySelectorAll(".m3-card-title")].map(n => n.textContent)).toEqual(["Narrator"]);

  await act(async () => { typeInto(search, "zzzz-no-such-setting"); });
  expect(container.textContent).toContain("No settings match on this surface.");

  await act(async () => { root.unmount(); });
});
