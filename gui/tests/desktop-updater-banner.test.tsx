import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import DesktopUpdaterBanner from "../src/shell/DesktopUpdaterBanner";
import { NotificationsProvider } from "../src/shell/notifications";
import { TestLanguageProvider } from "./helpers/providers";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: testWindow.document },
    window: { configurable: true, writable: true, value: testWindow },
    navigator: { configurable: true, writable: true, value: testWindow.navigator },
    localStorage: { configurable: true, writable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, writable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previousGlobals[key] });
});

async function renderBanner() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <DesktopUpdaterBanner />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
}

describe("desktop updater banner", () => {
  test("does not render a desktop update surface in a browser", async () => {
    await renderBanner();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("keeps a ready update visible with restart and later actions", async () => {
    let state = {
      status: "ready" as const,
      version: "2.7.43",
      progress: 100,
      releaseNotesUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/tag/v2.7.43",
      error: null,
    };
    let installed = 0;
    const updater = {
      state: async () => state,
      start: async () => state,
      check: async () => state,
      install: async () => { installed += 1; return { ok: true }; },
      cancel: async () => { state = { ...state, status: "cancelled" as const }; return state; },
      onState: (listener: (next: typeof state) => void) => { listener(state); return () => {}; },
    };
    (testWindow as unknown as { opencodexDesktop?: unknown }).opencodexDesktop = { isDesktop: true, updater };

    await renderBanner();
    expect(container.textContent).toContain("2.7.43");
    expect(container.querySelector(`a[href="${state.releaseNotesUrl}"]`)).toBeTruthy();
    const restart = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Restart to install update"));
    expect(restart).toBeTruthy();
    await act(async () => { restart?.click(); });
    expect(installed).toBe(1);
    const later = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Later"));
    expect(later).toBeTruthy();
    await act(async () => { later?.click(); });
    expect(container.textContent).not.toContain("2.7.43");
  });
});
