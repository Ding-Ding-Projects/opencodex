/**
 * Version history as a two-origin timeline.
 *
 * The screen used to show only the dashboard's own revision log, which meant the
 * proxy's git history of the config directory — the log that actually records an
 * account being added or removed — was invisible here. These tests pin the three
 * things that make the merge trustworthy:
 *
 *  - every row says which log it came from, in words, not by icon alone;
 *  - a failed server read renders as a failure and never as "no history";
 *  - restoring a git snapshot goes through /api/host/restore exactly as
 *    Network.tsx does, including the 409 force path, and is recorded as a NEW
 *    client revision rather than rewinding anything.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import VersionHistory from "../src/pages/VersionHistory";
import { LanguageProvider } from "../src/i18n/provider";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsContext, type Notice, type NotificationsApi } from "../src/shell/notifications-context";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const REVISIONS = [
  { id: "r1", scope: "provider", label: "groq", summary: "Provider added", at: 1_000, before: "{\"base\":\"https://api.groq.com\"}" },
];

const SNAPSHOTS = [
  { hash: "aaaaaaaaaaaabbbb", short: "aaaaaaa", subject: "Add Codex account", at: new Date(2_000).toISOString() },
];

interface Call { url: string; init?: RequestInit }
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers the history GET from `SNAPSHOTS` and the restore POST from `replies`. */
function stubFetch(replies: Response[], historyStatus = 200) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/api/host/history")) {
      return historyStatus === 200 ? json({ snapshots: [], entries: SNAPSHOTS }) : json({ error: "nope" }, historyStatus);
    }
    return replies.shift() ?? json({ success: true });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem("ocx-m3:revisions", JSON.stringify(REVISIONS));
});

afterEach(() => {
  testWindow.close();
  globalThis.fetch = originalFetch;
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
      notices.push({ ...input, id: String(notices.length), at: 0, read: false });
      return String(notices.length);
    },
    dismiss: () => {},
    markAllRead: () => {},
    clearHistory: () => {},
  } satisfies NotificationsApi;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <LanguageProvider>
          <NotificationsContext.Provider value={api}>
            <VersionHistory apiBase={apiBase} />
          </NotificationsContext.Provider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });
  return { container, root, notices };
}

const rowTexts = (container: HTMLElement) =>
  [...container.querySelectorAll("ul li button")].map(n => n.textContent ?? "");

const findButton = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find(b => b.textContent?.trim() === text);

test("both logs land on one timeline, newest first, each row naming its own log", async () => {
  stubFetch([]);
  const { container, root } = await mount("http://merge.test");

  const rows = rowTexts(container);
  expect(rows).toHaveLength(2);
  // The git snapshot is newer (2000ms) than the client revision (1000ms).
  expect(rows[0]).toContain("Add Codex account");
  expect(rows[0]).toContain("Account-change history");
  expect(rows[0]).toContain("aaaaaaa");
  expect(rows[1]).toContain("groq");
  expect(rows[1]).toContain("Revisions");

  await act(async () => { root.unmount(); });
});

test("unticking an origin hides that log without touching the other", async () => {
  stubFetch([]);
  const { container, root } = await mount("http://origin.test");
  expect(rowTexts(container)).toHaveLength(2);

  const serverChip = [...container.querySelectorAll("button.m3-chip")]
    .find(c => c.textContent?.includes("Account-change history"))!;
  expect(serverChip.getAttribute("aria-pressed")).toBe("true");

  await act(async () => { serverChip.click(); });
  expect(serverChip.getAttribute("aria-pressed")).toBe("false");
  expect(rowTexts(container)).toHaveLength(1);
  expect(rowTexts(container)[0]).toContain("groq");

  // Unticking the other one too is an honest empty result, not a silent "all".
  const localChip = [...container.querySelectorAll("button.m3-chip")]
    .find(c => c.textContent?.includes("Revisions"))!;
  await act(async () => { localChip.click(); });
  expect(rowTexts(container)).toHaveLength(0);
  expect(container.querySelector(".m3-empty-title")?.textContent).toBe("No match.");

  await act(async () => { root.unmount(); });
});

test("a failed server read is reported, never rendered as an empty history", async () => {
  localStorage.setItem("ocx-m3:revisions", "[]");
  stubFetch([], 500);
  const { container, root } = await mount("http://failed.test");

  const alert = [...container.querySelectorAll("[role=alert]")].map(n => n.textContent ?? "").join(" ");
  expect(alert).toContain("Could not read the account-change history");
  // With no client revisions either, the empty state must not claim nothing happened
  // while the alert above says the other log is unreadable.
  expect(container.querySelector(".m3-empty-title")?.textContent).toBe("No revisions recorded");
  expect(rowTexts(container)).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("restoring a git snapshot warns about in-flight work and the restart, and appends a revision", async () => {
  stubFetch([json({ success: true, kept: ["auth.json"] })]);
  const { container, root, notices } = await mount("http://restore-server.test");

  // Select the snapshot row, then open the confirm.
  await act(async () => { (container.querySelectorAll("ul li button")[0] as HTMLButtonElement).click(); });
  await act(async () => { findButton(container, "Restore")!.click(); });

  const dialog = container.querySelector("dialog")!;
  const copy = dialog.textContent ?? "";
  expect(copy).toContain("finishes any request still in flight");
  expect(copy).toContain("restarts");
  // Append-only has to be stated for the server path too.
  expect(copy).toContain("committed to the history first, so this restore can itself be undone");

  await act(async () => { findButton(dialog, "Restore")!.click(); });

  const post = calls.find(c => c.url.includes("/api/host/restore"))!;
  expect(post.init?.method).toBe("POST");
  expect(JSON.parse(String(post.init?.body))).toEqual({ commit: "aaaaaaaaaaaabbbb" });
  expect(notices.map(n => n.title)).toContain("State restored — the proxy is restarting");

  // Append-only in fact, not just in copy: the original revision survives and a
  // new entry records the restore above it.
  const stored = JSON.parse(localStorage.getItem("ocx-m3:revisions") || "[]");
  expect(stored).toHaveLength(2);
  expect(stored[0].restored).toBe(true);
  expect(stored[0].label).toBe("Add Codex account");
  expect(stored[1].id).toBe("r1");

  await act(async () => { root.unmount(); });
});

test("a 409 with sessions in progress asks again instead of cutting the work off", async () => {
  stubFetch([
    json({ reason: "sessions-in-progress", activeTurnCount: 3 }, 409),
    json({ success: true }),
  ]);
  const { container, root } = await mount("http://restore-409.test");

  await act(async () => { (container.querySelectorAll("ul li button")[0] as HTMLButtonElement).click(); });
  await act(async () => { findButton(container, "Restore")!.click(); });
  await act(async () => { findButton(container.querySelector("dialog")!, "Restore")!.click(); });

  // The first POST did not force, and the second dialog states the live count.
  const forceDialog = container.querySelector("dialog")!;
  expect(forceDialog.textContent).toContain("3 request(s) are still running");

  await act(async () => { findButton(forceDialog, "Restore")!.click(); });

  const posts = calls.filter(c => c.url.includes("/api/host/restore"));
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(posts[0].init?.body))).toEqual({ commit: "aaaaaaaaaaaabbbb" });
  expect(JSON.parse(String(posts[1].init?.body))).toEqual({ commit: "aaaaaaaaaaaabbbb", force: true });

  await act(async () => { root.unmount(); });
});

test("the date range and the search compose, and a bad pattern reports itself", async () => {
  stubFetch([]);
  const { container, root } = await mount("http://filter.test");
  expect(rowTexts(container)).toHaveLength(2);

  const search = container.querySelector("[role=search] input") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "codex");
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(rowTexts(container)).toHaveLength(1);
  expect(rowTexts(container)[0]).toContain("Add Codex account");

  // `.*` is an explicit opt-in; an uncompilable pattern says so rather than
  // quietly falling back to the plain-text match above.
  const regexChip = [...container.querySelectorAll("button.m3-chip")].find(c => c.textContent === ".*")!;
  await act(async () => { regexChip.click(); });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "(unclosed");
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(container.querySelector("#history-regex-error")?.textContent).toContain("Invalid pattern");
  expect(search.getAttribute("aria-invalid")).toBe("true");

  await act(async () => { root.unmount(); });
});
