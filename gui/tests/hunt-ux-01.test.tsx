import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import DesktopUpdaterBanner from "../src/shell/DesktopUpdaterBanner";
import { NotificationsProvider } from "../src/shell/notifications";
import { TestLanguageProvider } from "./helpers/providers";

/**
 * Candidate UX-01.
 *
 * `DesktopUpdaterBanner` tracks four distinct non-happy states for the desktop
 * updater ("failed", "offline", "cancelled", "corrupt" -- see the `status` union
 * in DesktopUpdaterBanner.tsx and the matching `STATUS` set plus `errorStatus()`
 * classifier in electron/auto-updater.mjs). `VISIBLE_STATUSES` renders a banner
 * for all four, and the button row deliberately offers "Try again" for all four.
 *
 * But the title/body ternary chain in DesktopUpdaterBanner.tsx only branches on
 * "ready", "downloading" and "available"; every other status -- including
 * "offline", "cancelled" and "corrupt" -- falls through to the same
 * `desktopUpdater.failedTitle` ("Desktop update needs attention") and
 * `desktopUpdater.failedBody` ("The update did not finish: {error}") copy.
 *
 * The clearest case is "cancelled": auto-updater.mjs's `cancel()` handler
 * publishes `{ status: "cancelled", error: null }` for a user who explicitly
 * clicked "Cancel download". With `error` null, the body's `state.error ??
 * t("desktopUpdater.unknownError")` falls back to "The update could not be
 * verified.", so a deliberate, successful cancellation reads as:
 *
 *   "Desktop update needs attention"
 *   "The update did not finish: The update could not be verified."
 *
 * That is a mislabelled state, not merely a vague one: nothing failed and
 * nothing needs verifying, the user just clicked Cancel, yet the copy uses
 * alarming "needs attention" / "could not be verified" language and offers a
 * "Try again" button as if recovering from an error. The same generic copy
 * also swallows "offline", which the main process already detected and named
 * distinctly (see `errorStatus()`), instead of telling the user to check
 * their connection.
 */

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

type DesktopUpdateState = {
  status: "current" | "checking" | "available" | "downloading" | "ready" | "failed" | "offline" | "cancelled" | "corrupt";
  version: string | null;
  progress: number;
  releaseNotesUrl?: string;
  error?: string | null;
};

async function renderBannerWithState(state: DesktopUpdateState) {
  const updater = {
    state: async () => state,
    start: async () => state,
    check: async () => state,
    install: async () => ({ ok: true }) as const,
    cancel: async () => state,
    onState: (listener: (next: DesktopUpdateState) => void) => { listener(state); return () => {}; },
  };
  (testWindow as unknown as { opencodexDesktop?: unknown }).opencodexDesktop = { isDesktop: true, updater };

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

describe("hunt-ux-01: desktop updater banner mislabels cancelled/offline as a generic failure", () => {
  test("a user-cancelled download is not presented as a failure needing attention", async () => {
    await renderBannerWithState({ status: "cancelled", version: "2.7.43", progress: 40, error: null });

    // The user clicked Cancel; nothing failed and nothing needs "verifying".
    // A correct fix gives "cancelled" its own copy instead of borrowing the
    // failure strings.
    expect(container.textContent).not.toContain("Desktop update needs attention");
    expect(container.textContent).not.toContain("could not be verified");
  });

  test("an offline check is not presented with the same generic copy as every other failure", async () => {
    await renderBannerWithState({
      status: "offline",
      version: "2.7.43",
      progress: 0,
      error: "getaddrinfo ENOTFOUND update.electronjs.org",
    });

    // The main process already classified this as "offline" (see
    // errorStatus() in electron/auto-updater.mjs); the banner should say so
    // in terms a user can act on rather than reusing the generic failure title.
    expect(container.textContent).not.toContain("Desktop update needs attention");
  });
});
