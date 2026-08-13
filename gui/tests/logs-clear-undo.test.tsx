/**
 * Clearing the logs from the dashboard.
 *
 * The failures worth guarding here are the ones that look fine on screen: a
 * delete that fired without asking, a confirmation that asked the user to agree
 * to an unspecified amount of loss, and — the worst of the three — a clear whose
 * undo silently did not get written but which still reported success. That last
 * one is indistinguishable from a working delete right up until someone needs
 * their logs back.
 */

import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";
import { readHistory } from "../src/shell/notifications-context";
import { ConfirmProvider } from "../src/shell/confirm";
import { readRevisions } from "../src/shell/revisions";
import Logs from "../src/pages/Logs";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

/** Requests the component made, so a test can prove a DELETE did or did not fire. */
let sent: { url: string; method: string }[] = [];
/** What DELETE /api/logs answers with; each test sets the case it is about. */
let clearResponse: { ok: boolean; snapshot: boolean; commit: string | null; label: string };
let clearStatus = 200;

const FOOTPRINT = {
  requestRows: 1204,
  appLines: 87,
  bytes: 654_321,
  appLogPath: "C:\\Users\\test\\.opencodex\\logs\\opencodex.log",
  usageLogPath: "C:\\Users\\test\\.opencodex\\usage.jsonl",
  retention: { maxLogBytes: 2_097_152, maxRotatedFiles: 3, maxTotalBytes: 8_388_608 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  for (const [key, value] of [["clientHeight", 800], ["clientWidth", 1200], ["offsetHeight", 800], ["offsetWidth", 1200], ["scrollHeight", 800]] as const) {
    Object.defineProperty(proto, key, { configurable: true, get() { return value; } });
  }
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } };
    },
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  // happy-dom has no top layer, so `showModal()` is stubbed to its observable part.
  const dialog = win.HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (dialog) {
    dialog.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    dialog.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    dialog.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#logs" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });

  sent = [];
  clearStatus = 200;
  clearResponse = { ok: true, snapshot: true, commit: "a".repeat(40), label: "cleared 1,204 request log rows and 87 app log lines" };

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    sent.push({ url, method });
    if (url.includes("/api/logs/footprint")) return jsonResponse(FOOTPRINT);
    if (url.includes("/api/logs") && method === "DELETE") return jsonResponse(clearResponse, clearStatus);
    if (url.includes("/api/logs")) return jsonResponse([]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function settle(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountLogs(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <ConfirmProvider>
            <Logs apiBase="http://localhost" />
          </ConfirmProvider>
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await settle();
  return { root, container };
}

function buttonLabelled(scope: ParentNode, text: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(node => node.textContent?.trim() === text);
  if (!match) throw new Error(`no button labelled "${text}"`);
  return match as unknown as HTMLButtonElement;
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click(); });
  await settle();
}

function deletes(): number {
  return sent.filter(call => call.method === "DELETE").length;
}

/**
 * The newest notification the screen raised. `NotificationsProvider` only owns
 * the context — the toast stack itself is rendered by the app shell, which this
 * harness does not mount — so the assertion reads the notice the provider
 * recorded rather than searching the DOM for a toast that lives elsewhere.
 */
function latestNotice(): { tone: string; title: string; body?: string } {
  const history = readHistory();
  if (!history.length) throw new Error("no notification was raised");
  return history[0];
}

test("the log file path and its retention bound are stated on the page", async () => {
  const { root, container } = await mountLogs();

  const text = container.textContent ?? "";
  // The whole point of writing the file is being able to open it, which needs
  // the path on screen rather than in a doc somewhere.
  expect(text).toContain(FOOTPRINT.appLogPath);
  expect(text).toContain(FOOTPRINT.usageLogPath);
  // The bound is stated, and stated as the server's real numbers: 8 MiB total.
  expect(text).toContain("8 MB");

  await act(async () => { root.unmount(); });
});

test("clearing asks first, and names the exact counts it is about to destroy", async () => {
  const { root, container } = await mountLogs();

  await click(buttonLabelled(container, "Clear logs"));

  // Nothing has been deleted yet — the dialog is a decision, not a progress note.
  expect(deletes()).toBe(0);
  const dialog = document.body.querySelector("dialog");
  expect(dialog).not.toBeNull();
  const body = dialog!.textContent ?? "";
  // Grouped and exact — the same rendering the caption above the button uses, so
  // the two cannot read as two different numbers for one fact.
  expect(body).toContain("1,204");
  expect(body).toContain("87");
  // And it says the deletion is recoverable, which is the reason it is safe to
  // agree to at all.
  expect(body.toLowerCase()).toContain("version history");

  await act(async () => { root.unmount(); });
});

test("cancelling the confirmation deletes nothing", async () => {
  const { root, container } = await mountLogs();

  await click(buttonLabelled(container, "Clear logs"));
  await click(buttonLabelled(document.body.querySelector("dialog")!, "Cancel"));

  expect(deletes()).toBe(0);

  await act(async () => { root.unmount(); });
});

test("confirming deletes, and records a revision naming what was cleared", async () => {
  const { root, container } = await mountLogs();

  await click(buttonLabelled(container, "Clear logs"));
  await click(buttonLabelled(document.body.querySelector("dialog")!, "Clear logs"));

  expect(deletes()).toBe(1);

  // The revision says WHAT changed rather than that something did — a history
  // whose rows all read "Updated" is one nobody can navigate.
  const revisions = readRevisions();
  expect(revisions).toHaveLength(1);
  expect(revisions[0].summary).toBe(clearResponse.label);

  await act(async () => { root.unmount(); });
});

test("a clear whose snapshot failed says so instead of reporting a clean success", async () => {
  // The defect: a delete that quietly lost its undo but looks exactly like one
  // that kept it. The user finds out only when they go looking for the logs.
  clearResponse = { ok: true, snapshot: false, commit: null, label: "cleared 1,204 request log rows" };
  const { root, container } = await mountLogs();

  await click(buttonLabelled(container, "Clear logs"));
  await click(buttonLabelled(document.body.querySelector("dialog")!, "Clear logs"));

  expect(deletes()).toBe(1);
  const notice = latestNotice();
  // Not "success": a warning tone and copy that says the undo is gone, so the
  // two outcomes cannot be mistaken for one another.
  expect(notice.tone).toBe("warn");
  expect(notice.body ?? "").toContain("cannot be undone");

  await act(async () => { root.unmount(); });
});

test("a failed clear reports the failure rather than an empty table", async () => {
  clearStatus = 500;
  clearResponse = { ok: false, snapshot: false, commit: null, label: "" };
  const { root, container } = await mountLogs();

  await click(buttonLabelled(container, "Clear logs"));
  await click(buttonLabelled(document.body.querySelector("dialog")!, "Clear logs"));

  expect(latestNotice().tone).toBe("error");
  expect(latestNotice().title).toBe("Could not clear the logs");
  // Nothing was recorded, because nothing happened.
  expect(readRevisions()).toHaveLength(0);

  await act(async () => { root.unmount(); });
});
