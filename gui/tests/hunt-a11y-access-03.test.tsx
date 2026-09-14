/**
 * ACCESS-03: the snackbar host's `aria-live="polite"` region does not exist in
 * the DOM until the first notice arrives, and arrives already holding that
 * notice's text.
 *
 * `SnackbarHost` (`src/shell/SnackbarHost.tsx:42`) returns `null` while
 * `live.length === 0`. Assistive tech announces a live region by observing
 * DOM *mutations inside an already-registered node*. A region that is
 * inserted into the document at the same moment it already contains its
 * first message is, per the WAI-ARIA authoring guidance on live regions
 * (and every screen reader's actual implementation of it), commonly missed
 * entirely, because there was nothing registered yet for the mutation
 * observer to be watching when the text landed.
 *
 * This is not only a first-run gap. `info`/`success` notices auto-dismiss
 * after `AUTO_DISMISS_MS` (`notifications-context.ts`), so `live` routinely
 * empties back to zero between notifications during ordinary use, unmounting
 * the host each time, and the very next `notify()` call re-triggers the same
 * "container and content inserted together" failure. Most snackbar
 * announcements a screen reader user would rely on in a normal session are at
 * risk, not just the app's very first one.
 *
 * The fix is to keep the `aria-live` container mounted (even empty) and only
 * conditionally render the notices inside it, matching how App.tsx already
 * mounts `<SnackbarHost />` unconditionally.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import SnackbarHost from "../src/shell/SnackbarHost";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsContext, type Notice, type NotificationsApi } from "../src/shell/notifications-context";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;

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
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountWithLive(live: Notice[]): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  const api: NotificationsApi = {
    live,
    history: [],
    unreadCount: 0,
    notify: () => "unused",
    dismiss: () => {},
    markAllRead: () => {},
    clearHistory: () => {},
  };
  await act(async () => {
    root = createRoot(host);
    root.render(
      <TestLanguageProvider>
        <NotificationsContext.Provider value={api}>
          <SnackbarHost />
        </NotificationsContext.Provider>
      </TestLanguageProvider>,
    );
  });
}

test("the aria-live region exists before any notice arrives, not only after", async () => {
  await mountWithLive([]);

  // The region has to be present and registered *before* content lands in it
  // for a mutation observer (i.e. a screen reader) to have anything to watch.
  // SnackbarHost currently returns null for an empty `live` array, so this is
  // absent at the exact moment it matters most: before the first announcement.
  // A correct fix keeps `<div aria-live="polite">` mounted unconditionally and
  // renders the notices inside it, so this assertion holds both here and once
  // a real notice is pushed into `live` on a later render.
  expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
});
