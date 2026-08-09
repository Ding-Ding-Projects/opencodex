import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

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
let openResult: Window | null = null;
let openCalls: unknown[][] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#notifications" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/healthz")) return jsonResponse({ version: "0.0.0-test", port: 10100, uptime: 1 });
    if (url.includes("/api/claude-code")) return jsonResponse({ enabled: false });
    if (url.includes("/api/providers")) return jsonResponse([]);
    if (url.includes("/api/models")) return jsonResponse([]);
    if (url.includes("/api/usage")) return jsonResponse({ summary: { requests: 0, totalTokens: 0, coverageRatio: 1 } });
    if (url.includes("/api/sidecar-settings")) return jsonResponse({ webSearch: { model: "" }, vision: { model: "" } });
    return jsonResponse({});
  }) as typeof fetch;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    fetch: { configurable: true, value: mockFetch },
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __APP_BUILD__: { configurable: true, value: "test" },
    __APP_COMMIT__: { configurable: true, value: "0123456789abcdef" },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "open", {
    configurable: true,
    value: (...args: unknown[]) => { openCalls.push(args); return openResult; },
  });
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
  openResult = null;
  openCalls = [];
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  const { resetApiAuthFetchForTests } = await import("../src/api");
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  }
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter unavailable");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

test("the App reports a blocked popup without claiming the remote dashboard opened", async () => {
  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
  resetApiAuthFetchForTests();
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });

  const [
    { createRoot },
    { LanguageProvider },
    { PrefsProvider },
    { NotificationsProvider },
    { ConfirmProvider },
    { default: App },
  ] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/theme/prefs"),
    import("../src/shell/notifications"),
    import("../src/shell/confirm"),
    import("../src/App"),
  ]);

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <PrefsProvider>
          <NotificationsProvider>
            <ConfirmProvider><App /></ConfirmProvider>
          </NotificationsProvider>
        </PrefsProvider>
      </LanguageProvider>,
    );
  });

  await waitFor(() => !!container.querySelector('button[aria-label="Connect to another OpenCodex"]'));
  await act(async () => {
    (container.querySelector('button[aria-label="Connect to another OpenCodex"]') as HTMLButtonElement).click();
  });
  await setInput(container.querySelector<HTMLInputElement>("#ocx-remote-host")!, "remote.example.test");
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(openCalls).toEqual([[
    "http://remote.example.test:10100/#/dashboard",
    "_blank",
    "noopener,noreferrer",
  ]]);
  expect(container.textContent).toContain("The browser blocked the remote dashboard tab");
  expect(container.textContent).not.toContain("Opened the remote dashboard");
  expect(container.querySelector("dialog")).not.toBeNull();

  openResult = testWindow as unknown as Window;
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(openCalls).toHaveLength(2);
  expect(container.textContent).toContain("Opened the remote dashboard");
  expect(container.querySelector("dialog")).toBeNull();
});
