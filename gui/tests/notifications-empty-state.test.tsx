/**
 * NOTIF-EMPTY-01 — the notification history has three distinct "nothing" states
 * and they used to share one message. A search that matched nothing rendered
 * "Nothing yet · Messages … land here" above a history the user could plainly see
 * was not empty, which reads as a broken screen rather than as a filter.
 *
 * These mount the real page against a real DOM, so the assertions are about what
 * the screen renders after a keystroke rather than about what the source contains.
 *
 * `react-dom/client` is imported dynamically, after the DOM globals are in place:
 * it decides at module-init time whether native `input` events exist, and a copy
 * initialised without a document never dispatches `onChange` again.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { M3_EN } from "../src/i18n/m3";
import NotificationsPage from "../src/pages/Notifications";
import { NotificationsContext, type Notice, type NotificationsApi } from "../src/shell/notifications-context";

const domGlobals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: Element;

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as Element;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    await act(async () => { root?.unmount(); });
    root = null;
  }
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

function notice(id: string, title: string): Notice {
  return { id, tone: "info", title, at: Date.UTC(2026, 6, 29, 12, 0), read: true };
}

function api(history: Notice[]): NotificationsApi {
  return {
    live: [],
    history,
    unreadCount: 0,
    notify: () => id(),
    dismiss: () => {},
    markAllRead: () => {},
    clearHistory: () => {},
  };
}

let seq = 0;
function id(): string { return `n${++seq}`; }

async function mount(history: Notice[]): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host as never);
  await act(async () => {
    root?.render(
      <TestLanguageProvider>
        <NotificationsContext.Provider value={api(history)}>
          <NotificationsPage />
        </NotificationsContext.Provider>
      </TestLanguageProvider>,
    );
  });
}

function searchField(): HTMLInputElement {
  return host.querySelector("input") as unknown as HTMLInputElement;
}

/** Types into the search field the way React's own change detection sees it. */
async function search(text: string): Promise<void> {
  const input = searchField();
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    // Bypasses React's value tracker so the dispatched event counts as a change.
    setter?.call(input, text);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function clickRegexToggle(): Promise<void> {
  const toggle = Array.from(host.querySelectorAll("button.m3-chip"))
    .find(b => (b.textContent ?? "").trim() === ".*") as unknown as HTMLButtonElement;
  await act(async () => {
    toggle.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as unknown as Event);
  });
}

const NO_MATCH = M3_EN["notif.noMatch"];
const EMPTY = M3_EN["notif.empty"];

test("a search that matches nothing says so instead of claiming the history is empty", async () => {
  await mount([notice("a", "Proxy started"), notice("b", "Model cache invalidated")]);
  expect(host.textContent).toContain("Proxy started");
  expect(host.textContent).not.toContain(NO_MATCH);

  await search("nothing here matches");
  expect(host.textContent).toContain(NO_MATCH);
  // The wrong copy is the whole defect: "Nothing yet" over a history that is not.
  expect(host.textContent).not.toContain(EMPTY);
  expect(host.textContent).not.toContain("Proxy started");
});

test("the tone filter reaches the same no-match copy, not the empty-history copy", async () => {
  await mount([notice("a", "Proxy started")]);
  const errors = Array.from(host.querySelectorAll("button.m3-chip"))
    .find(b => (b.textContent ?? "").trim() === M3_EN["notif.toneError"]) as unknown as HTMLButtonElement;
  await act(async () => {
    errors.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as unknown as Event);
  });
  expect(host.textContent).toContain(NO_MATCH);
  expect(host.textContent).not.toContain(EMPTY);
});

test("the no-match state is announced rather than silently swapped in", async () => {
  await mount([notice("a", "Proxy started")]);
  await search("zzz");
  const status = host.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status?.textContent).toContain(NO_MATCH);
});

test("a genuinely empty history still invites the user to expect messages", async () => {
  await mount([]);
  expect(host.textContent).toContain(EMPTY);
  expect(host.textContent).toContain(M3_EN["notif.emptyBody"]);
  expect(host.textContent).not.toContain(NO_MATCH);
});

test("an unreadable pattern reports itself and does not also claim a no-match", async () => {
  await mount([notice("a", "Proxy started")]);
  await clickRegexToggle();
  await search("([");
  const alert = host.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert?.textContent).toContain(M3_EN["regex.invalid"]);
  expect(host.textContent).not.toContain(NO_MATCH);
  expect(host.textContent).not.toContain(EMPTY);
});

test("the search field describes itself by the error only while the error exists", async () => {
  await mount([notice("a", "Proxy started")]);
  expect(searchField().getAttribute("aria-describedby")).toBeNull();

  await clickRegexToggle();
  await search("([");
  const described = searchField().getAttribute("aria-describedby") ?? "";
  // The error is one of the descriptions; the flags row this field compiles under
  // is the other, and it exists only in regex mode.
  expect(described.split(" ")).toContain("notif-regex-error");
  expect(described.split(" ")).toContain("notif-regex-flags-state");
  // Every referenced id has to resolve. A dangling `aria-describedby` points at
  // nothing and quietly costs the field its accessible description, which is the
  // whole defect this test exists for — asserting the literal attribute value
  // would have caught the first description going missing and nothing else.
  for (const id of described.split(" ")) {
    expect(testWindow.document.getElementById(id)).not.toBeNull();
  }
});
