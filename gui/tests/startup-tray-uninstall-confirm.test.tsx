import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";
import Startup from "../src/pages/Startup";

/**
 * Removing the Windows login tray used to run behind `window.confirm`, whose
 * body was the button's own label — it told the user nothing about what removal
 * costs, and happy-dom answers it `false`, so the path was untestable. It is now
 * an in-app blocking dialog. Two invariants are defended here: the click alone
 * must never reach the API, and the tray removal must land in Version history so
 * the user can see (and undo) that a record disappeared.
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

const HEALTH = {
  status: "protected",
  routingKind: "opencodex-local",
  routingInjected: true,
  localRoutingDependency: true,
  autostartEnabled: true,
  rebootSafe: true,
  protection: "service",
  serviceInstalled: true,
  serviceViable: true,
  serviceEnabled: true,
  serviceRunning: true,
  serviceStale: false,
  serviceConflict: false,
  serviceSupported: true,
  shimInstalled: true,
  shimHealthy: true,
  shimCoverage: "full",
  platform: "win32",
  recommendedCommand: null,
  diagnosticStale: false,
  commands: { installService: "ocx service install", installShim: "ocx shim install", restoreNative: "ocx restore" },
};

const TRAY_INSTALLED = { supported: true, installed: true, running: false, stale: false, summary: "installed" };
const TRAY_GONE = { supported: true, installed: false, running: false, stale: false, summary: "removed" };

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => (button.textContent ?? "").trim() === label);
  if (!match) throw new Error(`no button labelled ${label}`);
  return match;
}

test("removing the login tray asks first, then records the removal", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const posts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/startup-health")) return Response.json(HEALTH);
    if (url.includes("/api/windows-tray")) {
      if (init?.method === "POST") {
        posts.push(String(init.body));
        return Response.json({ status: TRAY_GONE });
      }
      return Response.json(TRAY_INSTALLED);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <Startup apiBase="http://host" />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await waitFor(() => (container.textContent ?? "").includes("Remove login tray"));

  // The trigger opens the dialog and nothing else — a stray POST here would mean
  // the tray was removed before the user ever saw what removal does.
  await act(async () => { findButton(container, "Remove login tray").click(); });
  expect(posts).toEqual([]);
  const dialog = container.querySelector("dialog");
  expect(dialog?.textContent ?? "").toContain("The proxy keeps running");

  const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => (button.textContent ?? "").trim() === "Remove login tray");
  await act(async () => { confirm!.click(); });
  await waitFor(() => posts.length === 1);
  expect(posts[0]).toContain("uninstall");

  await waitFor(() => JSON.parse(localStorage.getItem("ocx-m3:revisions") || "[]").length === 1);
  const [revision] = JSON.parse(localStorage.getItem("ocx-m3:revisions") || "[]") as { scope: string; summary: string }[];
  expect(revision?.scope).toBe("settings");
  expect(revision?.summary).toBe("Removed the Windows login tray");

  await act(async () => { root.unmount(); });
  container.remove();
});
