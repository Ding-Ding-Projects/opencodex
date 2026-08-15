import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";

/**
 * WP-B9-1 (side-by-side audit, defect 1): the Save button carried no dirty
 * tracking at all, so reordering or removing a featured model and then
 * navigating away — closing the window, reloading — lost the work silently.
 * This proves both halves of the fix: the Save control reflects whether
 * there is anything to save, and a reload/close is actually stopped while
 * there is.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let available: string[] = [];
let chosen: string[] = [];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  available = ["a-1", "a-2", "a-3"];
  chosen = ["a-1", "a-2"];

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      const body = JSON.stringify({ available, chosen });
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => ({ available, chosen }),
      } as unknown as Response;
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  // Imported here, not at module scope — see the sibling busy-race test for why.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <Subagents apiBase="" />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? ""),
  ) as unknown as HTMLButtonElement[];
}

function saveButton(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Save");
  if (!btn) throw new Error("Save button not found");
  return btn as unknown as HTMLButtonElement;
}

/** Fires a cancelable `beforeunload` and reports whether the page tried to stop it. */
function dispatchBeforeUnload(): boolean {
  const event = new testWindow.Event("beforeunload", { cancelable: true }) as unknown as Event;
  testWindow.dispatchEvent(event as never);
  return event.defaultPrevented;
}

test("reordering or removing a featured model and closing the window no longer loses it silently", async () => {
  await mount();

  // Untouched load: nothing to save, and closing the window must not be stopped.
  expect(saveButton().disabled).toBe(true);
  expect(container.textContent).toContain("Featured slots are up to date");
  expect(dispatchBeforeUnload()).toBe(false);

  // This is the failing half without the fix: removing a featured model left
  // the Save button exactly as it was — enabled or not, it said nothing — and
  // a window close right afterward went through unstopped, taking the edit
  // with it. Watch this assertion fail against the pre-fix component before
  // trusting it: revert the `dirty` gating and `beforeunload` guard in
  // src/pages/Subagents.tsx and this test goes red.
  await act(async () => {
    removeButtons()[1]!.click(); // removes a-2, the second featured slot
  });

  expect(removeButtons().length).toBe(1);
  expect(saveButton().disabled).toBe(false);
  expect(container.textContent).toContain("Unsaved changes");
  // The actual data-loss guard: a close/reload right now is stopped rather
  // than silently discarding the edit that was just made.
  expect(dispatchBeforeUnload()).toBe(true);
});

test("saving clears the dirty state and the close-window guard along with it", async () => {
  await mount();

  await act(async () => {
    removeButtons()[1]!.click();
  });
  expect(saveButton().disabled).toBe(false);
  expect(dispatchBeforeUnload()).toBe(true);

  await act(async () => {
    saveButton().click();
  });

  expect(saveButton().disabled).toBe(true);
  expect(container.textContent).toContain("Featured slots are up to date");
  // Once persisted, the same close/reload is safe again — there is nothing
  // left an unstopped navigation could lose.
  expect(dispatchBeforeUnload()).toBe(false);
});
