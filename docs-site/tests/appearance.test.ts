/**
 * The appearance runtime, and the feedback loop that froze the published site.
 *
 * The bug this file exists to prevent: `applyAppearance` writes `data-theme`,
 * and a `MutationObserver` watches `data-theme` so the site can follow
 * Starlight's own theme button. The observer has to ignore our *own* writes, and
 * the guard for that was a boolean set and cleared around `setAttribute`.
 * `MutationObserver` delivers at the microtask checkpoint — after the
 * synchronous block — so the guard was always back to `false` by the time the
 * observer ran. The observer adopted our write as the reader's, re-applied it,
 * mutated the attribute again, and re-entered itself. `setAttribute` queues a
 * mutation record even when the value does not change, so it never converged.
 *
 * A microtask loop never yields to the event loop, so the symptom was not a
 * slow page: it was a page that painted and then froze before `load`, with the
 * main thread permanently unreachable. Reproduced at a 430px viewport as a
 * renderer that could not evaluate `1+1`.
 *
 * These tests therefore assert on *how many times* the observer runs, not just
 * on the resulting theme — a correct final colour was never the thing that
 * broke. `queueMicrotask` is awaited explicitly because that is the exact
 * boundary the original guard fell through.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/** Let every pending microtask (and so every observer delivery) run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

let appearance: typeof import("../src/lib/appearance");

beforeEach(async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    "window", "document", "navigator", "location", "HTMLElement", "Node",
    "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "localStorage",
  ]) {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  }
  // The engine reads this to resolve "system"; happy-dom has no media engine.
  globals.matchMedia = (query: string) => ({
    matches: query.includes("dark"),
    addEventListener() {},
    removeEventListener() {},
  });

  // Fresh module per test: `applying` and `runtimeInstalled` are module state,
  // and a leaked guard from a previous test would mask exactly the bug here.
  appearance = await import(`../src/lib/appearance?t=${Date.now()}${Math.random()}`);
});

describe("theme observer", () => {
  test("applying an appearance does not re-enter the observer", async () => {
    let observerRuns = 0;
    const observer = new MutationObserver(() => { observerRuns++; });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    appearance.watchExternalThemeChanges(() => appearance.DEFAULT_APPEARANCE);
    appearance.applyAppearance(appearance.DEFAULT_APPEARANCE);
    await settle();

    // One write, therefore one delivery. Before the fix this grew without bound
    // and the loop never handed control back at all.
    expect(observerRuns).toBe(1);
    observer.disconnect();
  });

  test("the observer stops rather than rewriting a value that already agrees", async () => {
    let applyCalls = 0;
    const read = () => {
      applyCalls++;
      return appearance.DEFAULT_APPEARANCE;
    };
    appearance.watchExternalThemeChanges(read);

    // "system" under a dark OS resolves to "dark" — the value already present.
    // Adopting it would be a write carrying no new information, which is the
    // structural half of the loop.
    document.documentElement.setAttribute("data-theme", "dark");
    await settle();

    expect(applyCalls).toBeLessThanOrEqual(1);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("an external write that genuinely differs is still adopted", async () => {
    // A "light" reader is the case where Starlight's button and this store
    // really do disagree, and the observer must act — the loop guards must not
    // have bought stability by making the feature stop working.
    const stored = { ...appearance.DEFAULT_APPEARANCE, theme: "light" as const };
    appearance.writeAppearance(stored);
    appearance.watchExternalThemeChanges(() => appearance.readAppearance());

    document.documentElement.setAttribute("data-theme", "dark");
    await settle();

    expect(appearance.readAppearance().theme).toBe("dark");
  });

  test("repeated applies settle instead of compounding", async () => {
    let observerRuns = 0;
    const observer = new MutationObserver(() => { observerRuns++; });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    appearance.watchExternalThemeChanges(() => appearance.DEFAULT_APPEARANCE);
    // Two applies in one turn: the reason the guard is a counter and not a
    // boolean, since the first release would otherwise clear the second's hold.
    appearance.applyAppearance(appearance.DEFAULT_APPEARANCE);
    appearance.applyAppearance(appearance.DEFAULT_APPEARANCE);
    await settle();

    expect(observerRuns).toBeLessThanOrEqual(2);
    observer.disconnect();
  });
});

describe("stored preferences", () => {
  test("a corrupt entry falls back to defaults rather than rendering the site unreadable", () => {
    localStorage.setItem(appearance.STORAGE_KEY, '{"fontScale":900,"fontWeight":-5,"density":99,"seed":"red"}');
    const read = appearance.readAppearance();
    expect(read.fontScale).toBe(1);
    expect(read.fontWeight).toBe(400);
    expect(read.density).toBe(4);
    expect(read.seed).toBe(appearance.DEFAULT_APPEARANCE.seed);
  });

  test("a font id that is not offered resolves to a real stack", () => {
    expect(appearance.fontStackFor("nonsense" as never)).toBe(appearance.FONT_STACKS[0].stack);
  });

  test("normalizeSeed rejects anything that is not a hex colour", () => {
    expect(appearance.normalizeSeed("#2F6B4F")).toBe("#2F6B4F");
    expect(appearance.normalizeSeed("red; background:url(x)")).toBeNull();
    expect(appearance.normalizeSeed(42)).toBeNull();
  });
});
