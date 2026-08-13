/**
 * Changelog export confirmation.
 *
 * The download and the clipboard copy are two different outcomes and must not
 * share one line of copy. The regression this guards is the export toast falling
 * back to the button's own label — "Export as Markdown" announced in the past
 * tense reads as though the file is still on its way, and it is indistinguishable
 * from the copy confirmation for anyone scanning the notification centre.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Changelog from "../src/pages/Changelog";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsContext, type Notice, type NotificationsApi } from "../src/shell/notifications-context";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const releases = [
  { version: "v1.4.0", date: "2026-07-20", entries: ["feat(gui): changelog viewer", "fix(cli): stop eating the exit code"] },
  { version: "v1.3.0", date: "2026-06-02", entries: ["chore: bump deps"] },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

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

  // An anchor click would otherwise ask happy-dom to navigate to a blob: URL.
  Object.defineProperty(testWindow.HTMLAnchorElement.prototype, "click", { configurable: true, value() { /* download */ } });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:changelog" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => { /* noop */ } });

  globalThis.fetch = (async () => jsonResponse({ available: true, releases })) as typeof fetch;
});

afterEach(() => {
  testWindow.close();
  globalThis.fetch = originalFetch;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(apiBase: string): Promise<{ container: HTMLElement; root: Root; notices: Notice[] }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const notices: Notice[] = [];
  const api = {
    live: [],
    history: [],
    unreadCount: 0,
    notify: (input: Omit<Notice, "id" | "at" | "read">) => {
      notices.push({ ...input, id: `n${notices.length}`, at: 0, read: false });
      return `n${notices.length}`;
    },
    dismiss: () => {},
    markAllRead: () => {},
    clearHistory: () => {},
  } satisfies NotificationsApi;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsContext.Provider value={api}>
          <Changelog apiBase={apiBase} />
        </NotificationsContext.Provider>
      </TestLanguageProvider>,
    );
  });

  return { container, root, notices };
}

function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled ${label} — found ${[...container.querySelectorAll("button")].map(b => b.textContent).join(" | ")}`);
  return found as HTMLButtonElement;
}

test("the download confirmation names the file, not the button", async () => {
  const { container, root, notices } = await mount("http://x/export");

  await act(async () => {
    buttonLabelled(container, "Export as Markdown").click();
  });

  expect(notices).toHaveLength(1);
  expect(notices[0].tone).toBe("success");
  expect(notices[0].title).toBe("changelog.md downloaded");
  // The range travels with it, so the toast says which slice of history landed.
  expect(notices[0].body).toBe("Range: all releases");

  await act(async () => { root.unmount(); });
});

test("the copy confirmation stays distinct from the download one", async () => {
  const { container, root, notices } = await mount("http://x/copy");

  const written: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text); } },
  });

  await act(async () => {
    buttonLabelled(container, "Copy as Markdown").click();
  });
  // The clipboard write resolves a microtask after the click.
  await act(async () => { await Promise.resolve(); });

  expect(notices.map(n => n.title)).toEqual(["Markdown copied to the clipboard"]);
  expect(written[0]).toContain("## v1.4.0 — 2026-07-20");

  await act(async () => { root.unmount(); });
});
