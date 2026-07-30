/**
 * Language & voice screen structure.
 *
 * The prototype's screen carries three cards — interface language, narrator,
 * dim sum — and both switches must expose `role="switch"` + `aria-checked`,
 * which is the accessibility contract the shell's design handoff states. A
 * card silently dropping out of this screen is the failure this guards.
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

test("renders the language, narrator and dim sum cards with accessible switches", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;

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

  const titles = [...container.querySelectorAll(".m3-card-title")].map(n => n.textContent);
  expect(titles).toEqual(["Interface language", "Narrator", "Dim sum surprise"]);

  const switches = [...container.querySelectorAll('[role="switch"]')];
  expect(switches).toHaveLength(2);
  expect(switches.every(s => s.getAttribute("aria-checked") !== null)).toBe(true);
  // The narrator is off by default, so speaking a test line is not offered yet.
  expect(switches[0].getAttribute("aria-checked")).toBe("false");
  expect(switches[1].getAttribute("aria-checked")).toBe("true");

  const testButton = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Speak a test message"));
  expect(testButton?.disabled).toBe(true);

  await act(async () => { root.unmount(); });
});
