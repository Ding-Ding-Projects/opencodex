import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { NotificationsProvider } from "../src/shell/notifications";
import { useNotifications, type NotificationsApi } from "../src/shell/notifications-context";

const DOM_GLOBALS = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof DOM_GLOBALS)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(DOM_GLOBALS.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  for (const key of DOM_GLOBALS) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  await testWindow.happyDOM?.close?.();
});

function NotificationHandle({ onReady }: { onReady: (notify: NotificationsApi["notify"]) => void }) {
  const { notify } = useNotifications();
  useEffect(() => onReady(notify), [notify, onReady]);
  return null;
}

test("a late notification after provider unmount is ignored", async () => {
  let lateNotify: NotificationsApi["notify"] | null = null;
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);

  await act(async () => {
    root?.render(
      <NotificationsProvider>
        <NotificationHandle onReady={notify => { lateNotify = notify; }} />
      </NotificationsProvider>,
    );
  });
  expect(lateNotify).toBeTypeOf("function");

  await act(async () => root?.unmount());
  root = null;
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });

  expect(() => lateNotify?.({ tone: "error", title: "late notice" })).not.toThrow();
});
