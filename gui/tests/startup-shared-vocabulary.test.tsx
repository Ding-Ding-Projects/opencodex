import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";
import Startup from "../src/pages/Startup";

/**
 * Startup used to draw its screen lead and its inline warnings from local inline
 * style objects, so a theme change to the shared vocabulary skipped this screen
 * and the lead rendered a type size smaller than the prototype's. Both now come
 * from the shared classes, and a silent regression to bespoke inline styling
 * would leave the class names absent while the screen still looked plausible.
 */
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
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
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

const AT_RISK_HEALTH = {
  status: "at-risk",
  routingKind: "opencodex-local",
  routingInjected: true,
  localRoutingDependency: true,
  autostartEnabled: false,
  rebootSafe: false,
  protection: "none",
  serviceInstalled: false,
  serviceViable: false,
  serviceEnabled: false,
  serviceRunning: false,
  serviceStale: false,
  serviceConflict: false,
  serviceSupported: true,
  shimInstalled: false,
  shimHealthy: false,
  shimCoverage: "none",
  platform: "darwin",
  recommendedCommand: "ocx service install",
  // Drives the stale-diagnostic banner at the top of the screen as well as the
  // at-risk recovery notice, so one render covers both notice call sites.
  diagnosticStale: true,
  commands: { installService: "ocx service install", installShim: "ocx shim install", restoreNative: "ocx restore" },
};

test("Startup renders its lead and warnings with the shared classes, not bespoke inline styles", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/startup-health")) return Response.json(AT_RISK_HEALTH);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <Startup apiBase="http://test" />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await settle();
  await waitFor(() => container.querySelectorAll(".dash-notice").length > 0);

  // The screen lead is the prototype's body-large paragraph, shared with every
  // other ported screen rather than re-declared here.
  expect(container.querySelectorAll("p.m3-page-lead").length).toBe(1);

  // Both the stale-diagnostic banner and the at-risk recovery hint use the
  // shared warn notice. The `dash-` prefix is historical, not a dashboard scope.
  const notices = [...container.querySelectorAll(".dash-notice")];
  expect(notices.length).toBeGreaterThanOrEqual(2);
  for (const notice of notices) {
    expect(notice.classList.contains("dash-notice--warn")).toBe(true);
    // A notice that only informs must never take the error role's colour, and
    // must not have been re-implemented with a local background declaration.
    expect((notice as HTMLElement).style.background).toBe("");
  }

  await act(async () => { root.unmount(); });
  container.remove();
});
