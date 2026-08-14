/**
 * The renderer's School Mode client: the module-level singleton that mirrors
 * the server's shared record — polling, action functions, and the honesty
 * rules around a server or a record that cannot be reached.
 *
 * No DOM is needed here: `fetch`, `setInterval` and `setTimeout` are all
 * ordinary globals in this test environment, and `client.ts` itself never
 * touches `document` or `window`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  configureSchoolModeApiBase,
  disableSchoolMode,
  enableSchoolMode,
  getSchoolModeSnapshot,
  isSchoolModeActive,
  renameSchoolMode,
  resetSchoolModeClientForTests,
  setSchoolModeCredential,
  setSchoolModeStateForTests,
  SCHOOL_MODE_DEFAULT_STATE,
  startSchoolModeSync,
  subscribeSchoolMode,
  validateSchoolModeName,
  validateSchoolModeSecret,
  SCHOOL_MODE_MIN_SECRET_LENGTH,
  SCHOOL_MODE_MAX_SECRET_LENGTH,
} from "../src/school-mode/client";

const originalFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

afterEach(() => {
  resetSchoolModeClientForTests();
  restoreFetch();
});

describe("before anything has synced", () => {
  beforeEach(() => resetSchoolModeClientForTests());

  test("reads the safe default — off, nothing loaded yet", () => {
    expect(isSchoolModeActive()).toBe(false);
    expect(getSchoolModeSnapshot()).toEqual(SCHOOL_MODE_DEFAULT_STATE);
  });

  test("a plain read never calls fetch — only startSchoolModeSync() does", () => {
    let calls = 0;
    globalThis.fetch = (() => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
    isSchoolModeActive();
    getSchoolModeSnapshot();
    const unsubscribe = subscribeSchoolMode(() => {});
    unsubscribe();
    expect(calls).toBe(0);
  });
});

describe("setSchoolModeStateForTests — the direct-injection seam", () => {
  beforeEach(() => resetSchoolModeClientForTests());

  test("isSchoolModeActive reflects an injected enabled state immediately", () => {
    expect(isSchoolModeActive()).toBe(false);
    setSchoolModeStateForTests({ enabled: true });
    expect(isSchoolModeActive()).toBe(true);
  });

  test("notifies subscribers synchronously", () => {
    let notified = 0;
    subscribeSchoolMode(() => { notified++; });
    setSchoolModeStateForTests({ enabled: true });
    expect(notified).toBe(1);
  });
});

describe("startSchoolModeSync", () => {
  beforeEach(() => resetSchoolModeClientForTests());

  test("fetches immediately and applies a successful response", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
      enabled: true, hasCustomName: true, customName: "Focus mode", hasCredential: true,
      updatedAt: 42, recordReadable: true, recordWatchable: true, recordDir: "/tmp/school-mode",
    }), { status: 200 }))) as typeof fetch;

    startSchoolModeSync();
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = getSchoolModeSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.customName).toBe("Focus mode");
    expect(snapshot.hasCredential).toBe(true);
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.fetchError).toBeUndefined();
  });

  test("is idempotent — calling it twice does not double the poll interval", async () => {
    let calls = 0;
    globalThis.fetch = (() => { calls++; return Promise.resolve(new Response(JSON.stringify({ enabled: false }), { status: 200 })); }) as typeof fetch;
    startSchoolModeSync();
    startSchoolModeSync();
    await Promise.resolve();
    await Promise.resolve();
    // Exactly one immediate fetch — a second `startSchoolModeSync()` call must
    // not have started a second interval stacked on top of the first.
    expect(calls).toBe(1);
  });

  test("a non-OK response reports fetchError and does not claim the mode is off", async () => {
    setSchoolModeStateForTests({ enabled: true, loaded: true });
    globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 500 }))) as typeof fetch;
    startSchoolModeSync();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = getSchoolModeSnapshot();
    expect(snapshot.fetchError).toBeTruthy();
    // The last known state is preserved rather than silently flipped to "off".
    expect(snapshot.enabled).toBe(true);
  });

  test("a network failure reports fetchError and preserves the last known state", async () => {
    setSchoolModeStateForTests({ enabled: true, loaded: true });
    globalThis.fetch = (() => Promise.reject(new Error("network is down"))) as typeof fetch;
    startSchoolModeSync();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = getSchoolModeSnapshot();
    expect(snapshot.fetchError).toContain("network is down");
    expect(snapshot.enabled).toBe(true);
  });

  test("resetSchoolModeClientForTests stops the interval and restores the default state", async () => {
    let calls = 0;
    globalThis.fetch = (() => { calls++; return Promise.resolve(new Response(JSON.stringify({ enabled: true }), { status: 200 })); }) as typeof fetch;
    startSchoolModeSync();
    await Promise.resolve();
    await Promise.resolve();
    expect(getSchoolModeSnapshot().enabled).toBe(true);

    resetSchoolModeClientForTests();
    expect(getSchoolModeSnapshot()).toEqual(SCHOOL_MODE_DEFAULT_STATE);

    const callsAtReset = calls;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(callsAtReset);
  });
});

describe("action functions", () => {
  beforeEach(() => resetSchoolModeClientForTests());

  test("enableSchoolMode posts to /api/school-mode/enable and applies the response", async () => {
    let requested: { url: string; method: string | undefined } | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      requested = { url: String(url), method: init?.method };
      return Promise.resolve(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    }) as typeof fetch;

    const result = await enableSchoolMode();
    expect(result.ok).toBe(true);
    expect(requested?.url).toBe("/api/school-mode/enable");
    expect(requested?.method).toBe("POST");
    expect(getSchoolModeSnapshot().enabled).toBe(true);
  });

  test("disableSchoolMode sends the secret and surfaces a refused credential", async () => {
    let body: unknown;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Promise.resolve(new Response(JSON.stringify({ error: "invalid-credential", message: "nope" }), { status: 401 }));
    }) as typeof fetch;

    const result = await disableSchoolMode("wrong-pin");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-credential");
    expect(result.message).toBe("nope");
    expect(body).toEqual({ secret: "wrong-pin" });
  });

  test("setSchoolModeCredential sends both secrets when changing an existing one", async () => {
    let body: unknown;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Promise.resolve(new Response(JSON.stringify({ hasCredential: true }), { status: 200 }));
    }) as typeof fetch;

    await setSchoolModeCredential("newnewnew", "oldoldold");
    expect(body).toEqual({ newSecret: "newnewnew", currentSecret: "oldoldold" });
  });

  test("renameSchoolMode sends the new name and updates the snapshot", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ hasCustomName: true, customName: "Quiet time" }), { status: 200 }))) as typeof fetch;
    const result = await renameSchoolMode("Quiet time");
    expect(result.ok).toBe(true);
    expect(getSchoolModeSnapshot().customName).toBe("Quiet time");
  });

  test("a network failure from an action reports a message rather than throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    const result = await enableSchoolMode();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("offline");
  });

  test("configureSchoolModeApiBase prefixes every request", async () => {
    let requestedUrl = "";
    globalThis.fetch = ((url: string) => {
      requestedUrl = String(url);
      return Promise.resolve(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    }) as typeof fetch;
    configureSchoolModeApiBase("http://127.0.0.1:9999");
    await Promise.resolve();
    await Promise.resolve();
    expect(requestedUrl.startsWith("http://127.0.0.1:9999/api/school-mode")).toBe(true);
    // configureSchoolModeApiBase also starts the sync loop — clean it up so it
    // does not keep polling for the rest of this file's tests.
    resetSchoolModeClientForTests();
  });
});

describe("shared validation, re-exported from the pure contract module", () => {
  test("agrees with the server's bounds on a short secret", () => {
    expect(validateSchoolModeSecret("a".repeat(SCHOOL_MODE_MIN_SECRET_LENGTH - 1))).toEqual({ ok: false, reason: "too-short" });
  });
  test("agrees with the server's bounds on a long secret", () => {
    expect(validateSchoolModeSecret("a".repeat(SCHOOL_MODE_MAX_SECRET_LENGTH + 1))).toEqual({ ok: false, reason: "too-long" });
  });
  test("null is always a valid name", () => {
    expect(validateSchoolModeName(null)).toBe(true);
  });
  test("an empty name is not", () => {
    expect(validateSchoolModeName("")).toBe(false);
  });
});
