import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import CodexAuth from "../src/pages/CodexAuth";
import type { CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { TestLanguageProvider } from "./helpers/providers";
import { ConfirmProvider } from "../src/shell/confirm";
import { NotificationsProvider } from "../src/shell/notifications";

/**
 * Codex Auth parity: the prototype's top action row (refresh, then add account) and
 * the Settings block — heading, this surface's own settings search, then the cards
 * the search describes. The add button used to live in the pool heading, which put
 * the one control that grows the pool below every card it would appear among.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

function makeController(): CodexAccountPoolController {
  return {
    accounts: [
      { id: "main", email: "main@example.test", isMain: true, paused: false, hasCredential: true, quota: null },
      { id: "pool-1", email: "pool@example.test", isMain: false, paused: false, hasCredential: true, quota: null },
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
    removeAccount: async () => ({ ok: true }),
    syncAfterAccountAdded: async () => ({ ok: true }),
    pauseRefresh: () => ({ __brand: "codex-pool-pause" }) as never,
    resumeRefresh: () => {},
    subscribeLoadObserver: () => () => {},
    readLastThreshold: () => undefined,
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
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
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

async function mountPool(lead?: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <ConfirmProvider>
            <CodexAccountPool
              apiBase=""
              controller={makeController()}
              lead={lead ? <p className="m3-page-lead">{lead}</p> : null}
            />
          </ConfirmProvider>
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

function settingsInput(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('input[aria-label="Search settings…"]');
  expect(el).toBeTruthy();
  return el!;
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
  });
}

test("the page lead renders in the shared lead class, above the action row", async () => {
  await mountPool("ChatGPT accounts available to the proxy");

  const lead = host.querySelector(".m3-page-lead");
  expect(lead?.textContent).toContain("ChatGPT accounts available to the proxy");

  // Lead first, then the buttons — a screen explains itself before it offers actions.
  const refresh = [...host.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes("Refresh quotas"))!;
  expect(lead!.compareDocumentPosition(refresh) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
});

test("the Codex Auth page supplies the real subtitle as its lead", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <ConfirmProvider>
            <CodexAuth apiBase="" />
          </ConfirmProvider>
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  expect(host.querySelector(".m3-page-lead")?.textContent).toContain(
    "ChatGPT accounts available to the proxy",
  );
});

test("the top action row carries refresh and add account, and the pool heading no longer repeats add", async () => {
  await mountPool();

  const row = host.querySelector(".m3-row")!;
  const labels = [...row.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
  expect(labels[0]).toContain("Refresh quotas");
  expect(labels[1]).toContain("Add account");

  // Exactly one control adds an account; the old pool-heading duplicate is gone.
  const adders = [...host.querySelectorAll("button")]
    .filter((b) => (b.textContent ?? "").trim().startsWith("Add"));
  expect(adders.length).toBe(1);
});

test("the settings block heads its own search, above the cards it describes", async () => {
  await mountPool();

  const headings = [...host.querySelectorAll("h2")].map((h) => h.textContent);
  expect(headings).toContain("Settings");

  const search = host.querySelector('[role="search"]')!;
  const autoSwitchCard = host.querySelector(".codex-auto-switch-card")!;
  expect(search).toBeTruthy();
  expect(autoSwitchCard).toBeTruthy();
  // The search sits above the auto-switch card, not above the account cards.
  expect(search.compareDocumentPosition(autoSwitchCard) & 4).toBeTruthy();
});

test("a query matching nothing on this surface says so instead of emptying the screen", async () => {
  await mountPool();
  await type(settingsInput(), "zzzz-no-such-setting");

  expect(host.textContent).toContain("No settings match on this surface.");
  // The cards stay put: the search reports, it does not hide the controls.
  expect(host.querySelector(".codex-auto-switch-card")).toBeTruthy();
});

test("the rotation strategy is findable by an option label, not just its own name", async () => {
  await mountPool();
  await type(settingsInput(), "round-robin");

  const hits = host.querySelector("[data-settings-hits]")!;
  expect(hits.textContent).toContain("Rotation strategy");
  expect(hits.textContent).not.toContain("Automatic account switching");
  expect(host.textContent).not.toContain("No settings match on this surface.");
});

test("a setting that lives on another screen is reported by that screen's name", async () => {
  await mountPool();
  await type(settingsInput(), "Claude account pool");

  expect(host.textContent).toContain("Providers");
  expect(host.textContent).not.toContain("No settings match on this surface.");
});

test("an invalid regex reports the pattern error rather than a silent empty list", async () => {
  await mountPool();

  const regexChip = [...host.querySelectorAll("button")]
    .find((b) => (b.getAttribute("title") ?? "") === "Regex mode")!;
  await act(async () => { regexChip.click(); });
  await type(settingsInput(), "(unclosed");

  const note = host.querySelector('[role="alert"]');
  expect(note?.textContent).toContain("Invalid pattern");
  expect(settingsInput().getAttribute("aria-invalid")).toBe("true");
});
