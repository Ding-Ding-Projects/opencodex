import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { TestLanguageProvider } from "./helpers/providers";
import { ConfirmProvider } from "../src/shell/confirm";
import { NotificationsContext, type Notice, type NotificationsApi } from "../src/shell/notifications-context";

/**
 * A stale error flag must not paint a successful redeem as a failure (PR #475).
 *
 * The original defect: the surface kept the message text and its error flag in
 * two separate pieces of state, so a later success reused the earlier failure's
 * colour. The inline notice is now a snackbar, and each `notify()` call carries
 * its own tone in the same call as its text — so the assertion moved from "which
 * CSS class is on screen" to "which tone was reported", which is the same
 * contract expressed against the component that actually renders it now.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const account: CodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  isMain: false,
  paused: false,
  hasCredential: true,
  quota: { resetCredits: 2, updatedAt: 1 },
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [
      { id: "main", email: "main@example.test", isMain: true, paused: false, hasCredential: true, quota: null },
      account,
    ],
    activeId: null,
    loadState: "ready",
    switchingId: null,
    pauseUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    pauseExhaustedAccounts: async () => ({ ok: true, pausedCount: 0 }),
    saveAlias: async () => ({ ok: true }),
    removeAccount: async () => ({ ok: false, reason: "request" }),
    syncAfterAccountAdded: async () => ({ ok: true }),
    pauseRefresh: () => ({ __brand: "codex-pool-pause" }) as never,
    resumeRefresh: () => {},
    subscribeLoadObserver: () => () => {},
    readLastThreshold: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  originalFetch = globalThis.fetch;
  // Removing an account asks through the M3 confirmation now, not `window.confirm`.
  // happy-dom has no top layer, so the native modal methods are stubbed to the one
  // thing a test can observe: the `open` attribute.
  const dialogProto = win.HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (dialogProto) {
    dialogProto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    dialogProto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    dialogProto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  }

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits" && !url.pathname.endsWith("/consume")) {
        return Response.json({ credits: [] });
      }
      if (url.pathname === "/api/codex-auth/reset-credits/consume" && (init?.method ?? "GET") === "POST") {
        return Response.json({ code: "already_redeemed", remaining: 2 });
      }
      if (url.pathname.startsWith("/api/codex-auth/")) {
        return Response.json({ accounts: [], activeCodexAccountId: null, autoSwitchThreshold: 80 });
      }
      return Response.json({});
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

/** Every notification the surface raised, in order, with its tone. */
let notices: Notice[] = [];

async function mountPool(controller: CodexAccountPoolController) {
  const { createRoot } = await import("react-dom/client");
  notices = [];
  const api: NotificationsApi = {
    live: [],
    history: [],
    unreadCount: 0,
    notify: (input) => {
      const id = `n${notices.length}`;
      notices.push({ ...input, id, at: 0, read: false });
      return id;
    },
    dismiss: () => {},
    markAllRead: () => {},
    clearHistory: () => {},
  };
  await act(async () => {
    root = createRoot(host);
    root.render(
      <TestLanguageProvider>
        <NotificationsContext.Provider value={api}>
          <ConfirmProvider>
            <CodexAccountPool apiBase="" controller={controller} />
          </ConfirmProvider>
        </NotificationsContext.Provider>
      </TestLanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("a successful redeem reports its own tone, not the failed remove's", async () => {
  await mountPool(makeController());

  // Seed toastError=true via a failed remove.
  const removeBtn = [...host.querySelectorAll("button")].find((btn) =>
    (btn.getAttribute("aria-label") ?? "").includes("pool@example.test")
    && (btn.getAttribute("aria-label") ?? "").toLowerCase().includes("remove"),
  );
  expect(removeBtn).toBeTruthy();
  await act(async () => { removeBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  // The removal is a decision, so it opens the M3 confirmation rather than
  // running straight away. Agreeing to it is what makes the request fail.
  const confirmRemove = [...host.querySelectorAll("dialog button")]
    .find((btn) => btn.textContent === "Remove");
  expect(confirmRemove).toBeTruthy();
  await act(async () => { confirmRemove!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  expect(notices.map((notice) => notice.tone)).toEqual(["error"]);

  const resetBtn = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement | null;
  expect(resetBtn).toBeTruthy();
  await act(async () => { resetBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  const useCredit = [...host.querySelectorAll("button")].find((btn) =>
    (btn.textContent ?? "").includes("Use 1 Credit"),
  );
  expect(useCredit).toBeTruthy();
  await act(async () => { useCredit!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const confirmReset = [...host.querySelectorAll("button")].find((btn) => {
    const text = (btn.textContent ?? "").trim();
    return text === "Use Credit" || text.startsWith("Resetting");
  });
  expect(confirmReset).toBeTruthy();
  await act(async () => { confirmReset!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  // The redeem succeeded, so the message it raised is a success — the earlier
  // failure is still in the list (it happened) but cannot colour this one.
  expect(notices.map((notice) => notice.tone)).toEqual(["error", "success"]);
  expect(notices.at(-1)!.title).toContain("reset");
});
