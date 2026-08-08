/**
 * The "is it running?" button.
 *
 * The offline banner used to name a command and stop there, which inside the
 * desktop shell means telling someone to open a terminal that is not in front of
 * them. Every case here is about the button being honest: absent where it could
 * not work, silent about success until the port actually answers, and never
 * hiding the command it replaces.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { StartProxyButton } from "../src/components/StartProxyButton";
import { LanguageProvider } from "../src/i18n/provider";
import { NotificationsProvider } from "../src/shell/notifications";
import SnackbarHost from "../src/shell/SnackbarHost";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(onStarted?: () => void): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <NotificationsProvider>
          <StartProxyButton onStarted={onStarted} />
          {/* The host is what actually paints a notification. Mounting only the
              provider stores the message and renders nothing, so an assertion on
              the visible text passes or fails for the wrong reason. */}
          <SnackbarHost />
        </NotificationsProvider>
      </LanguageProvider>,
    );
  });
  return { container, root };
}

const buttonIn = (c: HTMLElement) => c.querySelector("button");

test("renders nothing in a browser, where it could not work", async () => {
  // No desktop bridge. A button that cannot start a local process turns a
  // solvable problem into one the user believes they already tried.
  const { container, root } = await mount();
  expect(buttonIn(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("appears in the desktop shell and starts the proxy", async () => {
  let calls = 0;
  (window as unknown as { opencodexDesktop: unknown }).opencodexDesktop = {
    isDesktop: true, platform: "win32",
    proxy: { status: async () => ({ running: false, port: 10100, pid: null, managed: false }),
             start: async () => { calls += 1; return { ok: true as const, port: 10100, adopted: false }; } },
  };
  let started = 0;
  const { container, root } = await mount(() => { started += 1; });
  const button = buttonIn(container);
  expect(button).not.toBeNull();

  await act(async () => { button!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never); });
  await act(async () => { await Promise.resolve(); });

  expect(calls).toBe(1);
  expect(started).toBe(1);
  await act(async () => { root.unmount(); });
});

test("a failure reports the reason instead of a silent no-op", async () => {
  // The bridge returns `{ ok: false, error }` rather than throwing, and the
  // reason has to reach the user — otherwise the button looks like it did
  // nothing, which is the same dead end it was written to remove.
  (window as unknown as { opencodexDesktop: unknown }).opencodexDesktop = {
    isDesktop: true, platform: "win32",
    proxy: { status: async () => ({ running: false, port: 10100, pid: null, managed: false }),
             start: async () => ({ ok: false as const, error: "The proxy launcher is missing from this build" }) },
  };
  let started = 0;
  const { container, root } = await mount(() => { started += 1; });

  await act(async () => { buttonIn(container)!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never); });
  await act(async () => { await Promise.resolve(); });

  // The success callback must NOT fire on a failed start — that is what would
  // reload the dashboard into the same broken state and look like a crash.
  expect(started).toBe(0);
  expect(document.body.textContent).toContain("The proxy launcher is missing from this build");
  await act(async () => { root.unmount(); });
});

test("a thrown bridge is reported, not left pending", async () => {
  (window as unknown as { opencodexDesktop: unknown }).opencodexDesktop = {
    isDesktop: true, platform: "win32",
    proxy: { status: async () => ({ running: false, port: 10100, pid: null, managed: false }),
             start: async () => { throw new Error("ipc channel closed"); } },
  };
  let started = 0;
  const { container, root } = await mount(() => { started += 1; });

  await act(async () => { buttonIn(container)!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never); });
  await act(async () => { await Promise.resolve(); });

  expect(started).toBe(0);
  // And the button is usable again rather than stuck disabled after a throw.
  expect(buttonIn(container)?.hasAttribute("disabled")).toBe(false);
  await act(async () => { root.unmount(); });
});
