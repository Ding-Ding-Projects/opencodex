/**
 * ACCESS-01: two providers both own `document.documentElement.lang`, and only
 * one of them knows School Mode exists.
 *
 * `LanguageProvider` (`src/i18n/provider.tsx`) computes the language attribute
 * from the *effective* locale: the raw draft with School Mode's forced
 * English and any active scheduled language-mode override layered on top, and
 * that is deliberate. School Mode exists so the product presents in English
 * regardless of what locale is saved.
 *
 * `SettingsDraftProvider` (`src/settings-drafts.tsx`) sets the same attribute
 * from the raw draft `locale` alone, with no idea School Mode or a schedule
 * override exists. `main.tsx` and `tests/helpers/providers.tsx` both nest
 * `LanguageProvider` *inside* `SettingsDraftProvider`, and React flushes a
 * child's effects before its parent's on every commit (mount included), so
 * the parent's naive write always lands last and wins, undoing whatever the
 * child correctly computed.
 *
 * Impact: a screen reader announces the document in the raw saved locale
 * (`zh-HK` here) while every visible word on screen is the English School Mode
 * forces (the exact mismatch `lang` exists to prevent), and it is wrong from
 * the first paint, not just after some later interaction.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { resetSchoolModeClientForTests, setSchoolModeStateForTests } from "../src/school-mode/client";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

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

  // The draft's saved locale is Cantonese, so the correct `lang` and the buggy
  // one disagree in a way that is impossible to get right by accident.
  localStorage.setItem("ocx-lang", "yue");
});

afterEach(async () => {
  resetSchoolModeClientForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(): Promise<Root> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<TestLanguageProvider><div>content</div></TestLanguageProvider>);
  });
  // Let both providers' mount-time effects, and any microtask they schedule,
  // settle before reading the attribute they raced to set.
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
  }
  return root;
}

test("School Mode active at mount: document.documentElement.lang stays English, not the raw saved locale", async () => {
  setSchoolModeStateForTests({ enabled: true });

  const root = await mount();

  // LanguageProvider (src/i18n/provider.tsx:48) is the one that knows School
  // Mode forces English. SettingsDraftProvider (src/settings-drafts.tsx:227)
  // fires after it (child effects before parent effects) and overwrites the
  // attribute with plain `locale`'s `htmlLang`, ignoring School Mode entirely.
  // Today this reads "zh-HK": the saved draft locale winning over the mode
  // that is supposed to override it everywhere.
  expect(document.documentElement.lang).toBe("en");

  await act(async () => { root.unmount(); });
});
