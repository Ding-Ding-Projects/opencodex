/**
 * Language & voice screen structure.
 *
 * The prototype's screen carries a body-large page lead, four titled cards —
 * interface language, narrator, the emoji decoration toggle, dim sum — an
 * untitled funny-level card holding both per-language sliders and the
 * five-level ladder, and a settings search. Every switch must expose
 * `role="switch"` + `aria-checked`, which is the accessibility contract the
 * shell's design handoff states. A card or control silently dropping out of
 * this screen is the failure these guard.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import LanguageVoice from "../src/pages/LanguageVoice";
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
            <LanguageVoice />
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

test("renders the language, narrator, emoji and dim sum cards with accessible switches", async () => {
  const { container, root } = await mount();

  const titles = [...container.querySelectorAll(".m3-card-title")].map(n => n.textContent);
  expect(titles).toEqual([
    "Interface language",
    "Narrator",
    "Show emojis in dialogs and message boxes",
    "Dim sum surprise",
  ]);

  // Every switch on this screen belongs to either the narrator card or the
  // emoji card, and every one of them is off on a fresh profile. This used to
  // be a screen-wide count of one, which read as "the dim sum surprise has no
  // off switch" — the real contract, and one the dim sum card asserts directly
  // a few lines below. The count also silently asserted that no other switch
  // could ever exist, so the narrator's Edge online-voice opt-in broke it by
  // existing, and the emoji toggle would break it again the same way.
  //
  // What is worth pinning instead is that none of the three defaults to on:
  // the narrator stays silent until asked, the network voice source — which
  // sends the narrated text to Microsoft — must never arrive switched on, and
  // emoji decoration stays off until a profile opts in.
  const narratorCard = [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector(".m3-card-title")?.textContent === "Narrator")!;
  const emojiCard = [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector(".m3-card-title")?.textContent === "Show emojis in dialogs and message boxes")!;
  const switches = [...container.querySelectorAll('[role="switch"]')];
  expect(switches).toHaveLength(3);
  expect(switches.filter(s => narratorCard.contains(s))).toHaveLength(2);
  expect(switches.filter(s => emojiCard.contains(s))).toHaveLength(1);
  expect(switches.map(s => s.getAttribute("aria-label"))).toEqual([
    "Enable narrator",
    "Use Microsoft Edge online voices",
    "Show emojis in dialogs and message boxes",
  ]);
  expect(switches.every(s => s.getAttribute("aria-checked") === "false")).toBe(true);

  // The preview rows are live output, not description: with the toggle off,
  // none of them carry a mark, and the sample copy renders exactly as it would
  // in a real snackbar with the same setting off.
  expect(emojiCard.textContent).toContain("Proxy port changed");
  expect(emojiCard.querySelector(".m3-emoji")).toBeNull();

  // The card still owes the reader a way to see one on demand rather than waiting
  // out 1-in-10 odds, so what replaced the switch is a preview and not a gap.
  const dimSumCard = [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector(".m3-card-title")?.textContent === "Dim sum surprise");
  expect(dimSumCard).toBeTruthy();
  expect(dimSumCard!.querySelector('[role="switch"]')).toBeNull();
  expect(dimSumCard!.textContent).toContain("Show one now");

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
test("ships one funny-level slider per language, each 1–5 and staged as a draft", async () => {
  const { container, root } = await mount();

  // Scoped to the funny-level card. It used to query the whole screen, which
  // asserted "these are the only two sliders anywhere on Language & voice" —
  // incidentally true at the time, and not the contract. The narrator's
  // per-language speed and pitch sliders are also range inputs, so the
  // screen-wide form would now fail on a screen that is more correct, not less.
  const funnyCard = [...container.querySelectorAll(".m3-card")]
    .find(card => card.querySelector('input[type="range"]#ocx-fun-en'))!;
  const sliders = [...funnyCard.querySelectorAll('input[type="range"]')] as unknown as HTMLInputElement[];
  expect(sliders.map(s => s.id)).toEqual(["ocx-fun-en", "ocx-fun-yue"]);
  expect(sliders.every(s => s.min === "1" && s.max === "5")).toBe(true);

  // Scoped for the same reason as the ids above: the narrator's per-language
  // speed and pitch sliders are `.m3-slider-row`s too.
  const labels = [...funnyCard.querySelectorAll(".m3-slider-row .m3-field-label")].map(n => n.textContent);
  expect(labels).toEqual(["Funny level — English", "Funny level — 廣東話"]);

  await act(async () => { typeInto(sliders[1], "5"); });

  // Moving a slider used to write `ocx-m3:funny` on the spot. It no longer does,
  // and the change is deliberate rather than a regression: the settings-draft
  // coordinator owns the only durable write, and it happens in its `apply()` —
  // reached from the app bar's Save action, which this screen does not mount. So
  // the assertion moved from "it persisted" to the pair that actually holds now:
  // the control repaints from the draft immediately, and nothing is written until
  // the user applies. The English slider is untouched, which is the real point of
  // shipping two of them.
  expect(sliders[1].value).toBe("5");
  expect(sliders[0].value).toBe("3");
  expect(localStorage.getItem("ocx-m3:funny")).toBeNull();

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
  // The name is plain text now rather than an aria-label on a `role="img"`
  // span: a text node is not an image, and labelling it as one made assistive
  // technology announce a picture where there was only a word. The photo beside
  // it is marked decorative precisely because this text carries the name.
  const text = card?.textContent ?? "";
  const { DISHES } = require("../src/shell/dimsum") as typeof import("../src/shell/dimsum");
  expect(DISHES.some(d => text.includes(d.name) && text.includes(d.zh))).toBe(true);
  // Non-blocking: nothing modal, nothing focus-trapped.
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await act(async () => { root.unmount(); });
});

// Every settings surface carries its own search wired to the regex builder.
test("the settings search filters this surface and reports an honest no-match", async () => {
  const { container, root } = await mount();

  const search = container.querySelector('[role="search"] input') as unknown as HTMLInputElement;
  expect(search.placeholder).toBe("Search settings…");
  // The builder opens beside this field; a link to the builder page would take the
  // user off the settings they were filtering.
  expect(container.querySelector('[role="search"] button[aria-haspopup="dialog"]')).toBeTruthy();
  expect(container.querySelector('[role="search"] a[href="#regex"]')).toBeNull();

  await act(async () => { typeInto(search, "narrator"); });
  expect([...container.querySelectorAll(".m3-card-title")].map(n => n.textContent)).toEqual(["Narrator"]);

  await act(async () => { typeInto(search, "zzzz-no-such-setting"); });
  expect(container.textContent).toContain("No settings match on this surface.");

  await act(async () => { root.unmount(); });
});
