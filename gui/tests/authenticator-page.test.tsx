/**
 * The Authenticator page end to end against a scripted server: the empty
 * state, a populated list with a live code, search filtering, the clock-skew
 * banner, and the full add-account flow — generate a secret, see the QR and
 * secret, confirm with the right code, watch the entry land in the list —
 * all through the real components rather than through the API module alone.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import Authenticator from "../src/pages/Authenticator";
import { TestProviders } from "./helpers/providers";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

interface Entry {
  id: string;
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
  groupId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

let entries: Entry[] = [];
let groups: { id: string; name: string; order: number }[] = [];
let nextId = 1;
let serverTime = Date.now();
let lastPendingId = "";
const REAL_CODE = "654321";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function toMeta(e: Entry) {
  return e;
}

function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = new URL(String(req ? req.url : input), "http://localhost");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = url.pathname;

  if (path === "/api/host/authenticator" && method === "GET") {
    return Promise.resolve(json({ entries: entries.map(toMeta), groups, serverTime }));
  }

  if (path === "/api/host/authenticator/code" && method === "GET") {
    const id = url.searchParams.get("id");
    const entry = entries.find(e => e.id === id);
    if (!entry) return Promise.resolve(json({ error: "not found" }, 404));
    return Promise.resolve(json({
      code: REAL_CODE, nextCode: "111111", digits: entry.digits, period: entry.period,
      periodStart: 0, periodEnd: 30_000, secondsRemaining: 25, serverTime,
    }));
  }

  if (path === "/api/host/authenticator/pending" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    lastPendingId = `pending-${nextId++}`;
    return Promise.resolve(json({
      pendingId: lastPendingId,
      otpauthUri: `otpauth://totp/${encodeURIComponent(body.issuer ?? "")}:${encodeURIComponent(body.account ?? "")}?secret=JBSWY3DPEHPK3PXP`,
      secret: "JBSWY3DPEHPK3PXP",
      issuer: body.issuer ?? "",
      account: body.account ?? "",
      algorithm: body.algorithm ?? "SHA1",
      digits: body.digits ?? 6,
      period: body.period ?? 30,
      expiresAt: Date.now() + 600_000,
      serverTime,
    }));
  }

  if (path === "/api/host/authenticator/pending/confirm" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.pendingId !== lastPendingId) return Promise.resolve(json({ error: "not found", reason: "not-found" }, 404));
    if (body.code !== REAL_CODE) return Promise.resolve(json({ error: "wrong", reason: "wrong-code", attemptsRemaining: 7 }, 400));
    const entry: Entry = {
      id: `entry-${nextId++}`, issuer: "Example", account: "alice@example.com",
      algorithm: "SHA1", digits: 6, period: 30, groupId: null, order: entries.length,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    entries.push(entry);
    return Promise.resolve(json({ entry: toMeta(entry) }));
  }

  return Promise.resolve(json({}));
}

function boot(): void {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://127.0.0.1:10100/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    fetch: { configurable: true, value: serve },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: serve });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

function teardown(): void {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
}

beforeEach(() => {
  entries = [];
  groups = [];
  nextId = 1;
  serverTime = Date.now();
  lastPendingId = "";
  // The resource cache in `client-resource.ts` is a module-level singleton
  // keyed by `ocx-authenticator:${apiBase}` — every test here uses the same
  // apiBase, so without this an earlier test's cached snapshot (e.g. the
  // empty list) would still be what a later test's fresh mount renders first.
  clearClientResourceStoresForTests();
});
afterEach(() => {});

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms));
  });
}

async function waitFor(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !predicate(); i++) await tick();
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestProviders>
        <Authenticator apiBase="" />
      </TestProviders>,
    );
  });
  await tick();
  return { container, root };
}

test("renders the empty state when there are no accounts", async () => {
  boot();
  try {
    const { container, root } = await mount();
    await waitFor(() => container.textContent?.includes("No accounts yet") ?? false);
    expect(container.textContent).toContain("No accounts yet");
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});

test("renders an existing entry with its live code", async () => {
  entries.push({
    id: "entry-1", issuer: "GitHub", account: "alice", algorithm: "SHA1", digits: 6, period: 30,
    groupId: null, order: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  boot();
  try {
    const { container, root } = await mount();
    await waitFor(() => container.textContent?.includes("GitHub") ?? false);
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("alice");
    await waitFor(() => container.textContent?.includes("654") ?? false);
    expect(container.textContent).toContain("654");
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});

test("search filters the list to matching entries", async () => {
  entries.push(
    { id: "e1", issuer: "GitHub", account: "alice", algorithm: "SHA1", digits: 6, period: 30, groupId: null, order: 0, createdAt: "", updatedAt: "" },
    { id: "e2", issuer: "GitLab", account: "bob", algorithm: "SHA1", digits: 6, period: 30, groupId: null, order: 1, createdAt: "", updatedAt: "" },
  );
  boot();
  try {
    const { container, root } = await mount();
    await waitFor(() => container.textContent?.includes("GitLab") ?? false);

    const search = container.querySelector<HTMLInputElement>('input[role="searchbox"], input[aria-label="Search accounts"]')
      ?? [...container.querySelectorAll("input")].find(i => i.placeholder === "Search accounts" || i.getAttribute("aria-label") === "Search accounts");
    expect(search).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(search, "bob");
      search!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await waitFor(() => !container.textContent?.includes("GitHub"));
    expect(container.textContent).not.toContain("GitHub");
    expect(container.textContent).toContain("GitLab");
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});

test("shows the clock-skew banner when the server clock disagrees by more than 5 seconds", async () => {
  entries.push({ id: "e1", issuer: "X", account: "a", algorithm: "SHA1", digits: 6, period: 30, groupId: null, order: 0, createdAt: "", updatedAt: "" });
  serverTime = Date.now() + 15_000;
  boot();
  try {
    const { container, root } = await mount();
    await waitFor(() => container.textContent?.includes("clock") ?? false);
    expect(container.textContent).toContain("clock");
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});

test("does not show the clock-skew banner when clocks agree", async () => {
  entries.push({ id: "e1", issuer: "X", account: "a", algorithm: "SHA1", digits: 6, period: 30, groupId: null, order: 0, createdAt: "", updatedAt: "" });
  boot();
  try {
    const { container, root } = await mount();
    await waitFor(() => container.textContent?.includes("X") ?? false);
    expect(container.textContent).not.toContain("clock is about");
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});

test("full generate-and-confirm flow adds a real entry", async () => {
  boot();
  try {
    const { container, root } = await mount();
    await waitFor(() => container.textContent?.includes("No accounts yet") ?? false);

    const addButton = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Add account"));
    expect(addButton).toBeTruthy();
    await act(async () => { addButton!.click(); });
    await waitFor(() => container.textContent?.includes("Add an account") ?? false);

    const accountInput = [...container.querySelectorAll("input")].find(i => i.getAttribute("aria-label") === "Account" || i.id === "auth-add-account");
    expect(accountInput).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(accountInput, "alice@example.com");
      accountInput!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });

    const continueButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Continue");
    expect(continueButton).toBeTruthy();
    await act(async () => { continueButton!.click(); });

    // The confirm step: a QR (inline <svg role="img">) plus a code field.
    await waitFor(() => !!container.querySelector('svg[role="img"]'));
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    expect(container.textContent).toContain("Confirm the code");

    const codeInput = container.querySelector<HTMLInputElement>("#auth-confirm-code");
    expect(codeInput).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(codeInput, REAL_CODE);
      codeInput!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });

    const confirmButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Confirm and add");
    expect(confirmButton).toBeTruthy();
    await act(async () => { confirmButton!.click(); });

    await waitFor(() => container.textContent?.includes("Example") ?? false);
    expect(container.textContent).toContain("Example");
    expect(container.textContent).toContain("alice@example.com");
    expect(entries.length).toBe(1);
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});

test("a wrong confirmation code is refused and reports attempts remaining, without adding an entry", async () => {
  boot();
  try {
    const { container, root } = await mount();
    const addButton = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Add account"));
    await act(async () => { addButton!.click(); });
    await waitFor(() => container.textContent?.includes("Add an account") ?? false);

    const accountInput = [...container.querySelectorAll("input")].find(i => i.id === "auth-add-account");
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(accountInput, "bob");
      accountInput!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    const continueButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Continue");
    await act(async () => { continueButton!.click(); });
    await waitFor(() => !!container.querySelector("#auth-confirm-code"));

    const codeInput = container.querySelector<HTMLInputElement>("#auth-confirm-code");
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(codeInput, "000000");
      codeInput!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    const confirmButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Confirm and add");
    await act(async () => { confirmButton!.click(); });

    await waitFor(() => container.textContent?.includes("did not match") ?? false);
    expect(container.textContent).toContain("did not match");
    expect(container.textContent).toContain("7");
    expect(entries.length).toBe(0);
  } finally {
    // The rollover timer inside `useAuthenticatorCode` schedules a real
    // `window.setTimeout` for the next code refresh; without unmounting first,
    // its cleanup never runs, and the timer can fire after `teardown()` has
    // restored the real globals — calling `fetch` from inside a LATER test
    // file's mocked environment. `onboarding-wizard.test.tsx` caught exactly
    // this once, as a stray `/api/host/authenticator/code` call.
    await act(async () => { root.unmount(); });
    teardown();
  }
});
