import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

/**
 * Side-by-side audit defect 4: the app bar's notification popover rendered
 * only a notice's title and body, dropping the tone icon, timestamp and
 * source screen the design specifies (`OpenCodex M3.dc.html` ~1805-1811).
 *
 * This mounts the real `App` (per `remote-connection-app.test.tsx`'s
 * established pattern) on the Subagents tab and lets its own real failed
 * load raise a real notice, rather than injecting one synthetically — the
 * popover's rendering is what is under test, not a fake notification shape.
 */

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "__APP_VERSION__",
  "__APP_BUILD__",
  "__APP_COMMIT__",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#/subagents" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/healthz")) return jsonResponse({ version: "0.0.0-test", port: 10100, uptime: 1 });
    if (url.includes("/api/claude-code")) return jsonResponse({ enabled: false });
    // Subagents' own initial load fails against this — the one real notice
    // this test needs, raised by the page it names as its source.
    if (url.includes("/api/subagent-models")) return jsonResponse({ error: "boom" }, false);
    return jsonResponse({});
  }) as typeof fetch;
  // `writable`/`enumerable` explicitly true on every entry: the default for an
  // omitted flag in a property descriptor is `false`, and a later test file in
  // the same process (bun runs the whole `tests/` directory as one process)
  // that does a plain `globalThis.__APP_VERSION__ = …` assignment throws
  // against a non-writable property left behind here. This bit a sibling test
  // in exactly that shape — alphabetically later, silently poisoned — before
  // this file added the explicit flags.
  const globalDescriptor = { configurable: true, writable: true, enumerable: true };
  Object.defineProperties(globalThis, {
    document: { ...globalDescriptor, value: testWindow.document },
    window: { ...globalDescriptor, value: testWindow },
    navigator: { ...globalDescriptor, value: testWindow.navigator },
    localStorage: { ...globalDescriptor, value: testWindow.localStorage },
    sessionStorage: { ...globalDescriptor, value: testWindow.sessionStorage },
    fetch: { ...globalDescriptor, value: mockFetch },
    __APP_VERSION__: { ...globalDescriptor, value: "0.0.0-test" },
    __APP_BUILD__: { ...globalDescriptor, value: "test" },
    __APP_COMMIT__: { ...globalDescriptor, value: "0123456789abcdef" },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.localStorage.setItem("ocx-m3:onboarding", JSON.stringify({ completed: true, at: 1 }));

  const proto = testWindow.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    (this.querySelector("input, button") as HTMLElement | null)?.focus();
  };
  proto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  const { resetApiAuthFetchForTests } = await import("../src/api");
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true, writable: true, enumerable: true, value: previousGlobals[key],
    });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  }
}

test("the notification bell popover shows a notice's tone, timestamp and source screen", async () => {
  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
  resetApiAuthFetchForTests();
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });

  const [{ createRoot }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("../src/App"),
  ]);

  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });

  // `.m3-badge-count` is the bell's unread-count dot. It was `.m3-badge` until
  // that name turned out to be shared with the inline status pill rendered by
  // `Badge` (shell/m3-ui.tsx) -- one class, two rules, and the pill inherited
  // the dot's `position: absolute` and rendered in the window corner. This
  // wait wants the DOT specifically, so it takes the dot's own name.
  await waitFor(() => !!container.querySelector(".m3-badge-count"));

  const bell = container.querySelector('button[aria-label="Notifications"]') as HTMLButtonElement;
  expect(bell).toBeTruthy();
  await act(async () => {
    bell.click();
  });

  const panel = container.querySelector('[role="dialog"][aria-label="Notifications"]');
  expect(panel).toBeTruthy();
  expect(panel!.textContent).toContain("Failed to load models");

  // 1. Tone icon: an accessible name for the tone, not colour alone.
  const toneIcon = panel!.querySelector('[role="img"]');
  expect(toneIcon).toBeTruthy();
  expect(toneIcon!.getAttribute("aria-label")).toBe("Error");

  // 2. Timestamp: a real, dated <time> element — "recently" is not a timestamp.
  const time = panel!.querySelector("time");
  expect(time).toBeTruthy();
  expect(time!.getAttribute("dateTime")).toBeTruthy();
  expect(Number.isNaN(Date.parse(time!.getAttribute("dateTime")!))).toBe(false);

  // 3. Source screen: which page's action raised the notice.
  expect(panel!.textContent).toContain("Subagents");
});
