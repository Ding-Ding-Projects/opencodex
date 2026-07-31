import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installApiAuthFetch, resetApiAuthFetchForTests, setTokenRequester } from "../src/api";

const LEGACY_TOKEN_KEY = "opencodex-api-token";
const globals = ["document", "window", "navigator", "sessionStorage", "fetch"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let originalPrompt: typeof window.prompt;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    fetch: { configurable: true, value: testWindow.fetch.bind(testWindow) },
  });
  originalPrompt = window.prompt;
  resetApiAuthFetchForTests();
  sessionStorage.clear();
});

afterEach(() => {
  window.prompt = originalPrompt;
  // Module-level state that outlives a test: a requester left registered would
  // answer the next test's 401 from a torn-down tree.
  setTokenRequester(null);
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function installMockAuthFetch(handler: typeof fetch): Promise<void> {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: handler });
  Object.defineProperty(window, "fetch", { configurable: true, value: handler });
  installApiAuthFetch();
  // installApiAuthFetch replaces window.fetch — keep globalThis in sync for bare `fetch()`.
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
}

test("installApiAuthFetch deletes legacy sessionStorage token without reading it", () => {
  sessionStorage.setItem(LEGACY_TOKEN_KEY, "legacy-secret");
  let getItemCalls = 0;
  const storage = sessionStorage;
  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = ((key: string) => {
    getItemCalls += 1;
    return originalGetItem(key);
  }) as typeof storage.getItem;

  try {
    installApiAuthFetch();
    expect(getItemCalls).toBe(0);
    expect(originalGetItem(LEGACY_TOKEN_KEY)).toBeNull();
  } finally {
    storage.getItem = originalGetItem;
  }
});

test("prompted API tokens stay memory-only and are not written to sessionStorage", async () => {
  sessionStorage.setItem(LEGACY_TOKEN_KEY, "legacy-secret");

  let authorized = false;
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key") === "fresh-token") {
      authorized = true;
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => "fresh-token";

  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(200);
  expect(authorized).toBe(true);
  expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
  expect(sessionStorage.length).toBe(0);
});

test("a registered requester is used in preference to window.prompt", async () => {
  // The desktop shell is the whole point of the registry. Electron does not
  // implement `window.prompt` — it throws — so before the React tree registered
  // an M3 dialog, a 401 inside the app had no way to ask for a token and every
  // authenticated call after it failed. `window.prompt` throwing here proves the
  // registered requester is reached first rather than merely reached as well.
  let promptCalls = 0;
  let asked: string | null = null;
  window.prompt = () => {
    promptCalls += 1;
    throw new Error("prompt() is not supported");
  };
  setTokenRequester(async message => { asked = message; return "  from-the-dialog  "; });

  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key") === "from-the-dialog") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  // 200, not a rejection: the retry carried the token the dialog returned, with
  // its surrounding whitespace trimmed the same way the native path trims it.
  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(0);
  // The requester is handed the same explanation the native prompt showed, so
  // there is only one copy of it to keep accurate.
  expect(asked).toContain("ocx host token");
});

test("unregistering falls back to window.prompt rather than leaving nothing to ask with", async () => {
  // `setTokenRequester(null)` runs when the React tree unmounts. Anything still
  // making requests after that — or before it mounted — has to keep the old
  // route, or a 401 becomes a silent, permanent failure.
  setTokenRequester(async () => "never-used");
  setTokenRequester(null);

  let promptCalls = 0;
  window.prompt = () => {
    promptCalls += 1;
    return "fallback-token";
  };
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key") === "fallback-token") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);
});

test("cross-origin /api/* requests do not receive the API key or token prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-OpenCodex-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-OpenCodex-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/api/config");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

test("concurrent 401s share one token prompt and all retry with the stored token", async () => {
  // Repro for #647: many /api/* requests start without a token (dashboard fan-out).
  // Delivering 401s one-by-one after each auth cycle finishes matches the browser case where
  // window.prompt blocks the main thread: each continuation still holds a captured null token
  // and must reuse the in-memory token from an earlier request instead of prompting again.
  let promptCalls = 0;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key") === "shared-token") {
      return new Response("{}", { status: 200 });
    }
    await new Promise<void>((resolve) => {
      release401.push(resolve);
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "shared-token";
  };
  await installMockAuthFetch(mockFetch);

  const endpoints = [
    "/api/config",
    "/api/providers",
    "/api/models",
    "/api/selected-models",
    "/api/disabled-models",
    "/api/effort-caps",
    "/api/sidecar-settings",
    "/api/injection-model",
    "/api/v2",
    "/api/keys",
    "/api/provider-presets",
    "/api/key-providers",
    "/api/oauth/providers",
    "/api/codex-auth/accounts",
  ];
  const pending = endpoints.map((path) => fetch(path).then((r) => r.status));
  // Let every request reach the 401 gate before any response is delivered.
  for (let i = 0; i < 20 && release401.length < endpoints.length; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(endpoints.length);

  for (let i = 0; i < endpoints.length; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([200]);
});

test("stale concurrent 401 does not clear a token refreshed by another request", async () => {
  // Codex/CodeRabbit race: request A prompts and stores T2; request B still holding stale T1
  // must not wipe T2 (clearTokenIfCurrent) before its re-read / shared gate join.
  let promptCalls = 0;
  let acceptV1 = true;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const key = headers.get("X-OpenCodex-API-Key");
    if (key === "token-v2") return new Response("{}", { status: 200 });
    if (acceptV1 && key === "token-v1") return new Response("{}", { status: 200 });
    if (key === "token-v1") {
      await new Promise<void>((resolve) => {
        release401.push(resolve);
      });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "token-v1";
  };
  await installMockAuthFetch(mockFetch);
  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  acceptV1 = false;
  promptCalls = 0;
  window.prompt = () => {
    promptCalls += 1;
    return "token-v2";
  };

  const pending = [fetch("/api/config"), fetch("/api/providers")].map((p) => p.then((r) => r.status));
  for (let i = 0; i < 20 && release401.length < 2; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(2);

  for (let i = 0; i < 2; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([200]);
});

test("canceling the token prompt once does not reopen it for the rest of the 401 fan-out", async () => {
  let promptCalls = 0;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key")) {
      return new Response("{}", { status: 200 });
    }
    await new Promise<void>((resolve) => {
      release401.push(resolve);
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return null;
  };
  await installMockAuthFetch(mockFetch);

  const endpoints = ["/api/config", "/api/providers", "/api/models", "/api/keys"];
  const pending = endpoints.map((path) => fetch(path).then((r) => r.status));
  for (let i = 0; i < 20 && release401.length < endpoints.length; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(endpoints.length);

  for (let i = 0; i < endpoints.length; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([401]);
});

test("data-plane requests never receive the management token or prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-OpenCodex-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-OpenCodex-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/v1/models")).status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(0);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/v1/models");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

// Electron does not implement `window.prompt` — it throws. That exception came
// straight out of the fetch wrapper, so in the desktop app one 401 broke every
// caller that touched it, Exit included: "Could not exit cleanly: prompt() is
// not supported", and then it did not exit.
test("a prompt that throws is an unauthenticated request, not an exception", async () => {
  let calls = 0;
  await installMockAuthFetch(async () => {
    calls += 1;
    return new Response("nope", { status: 401 });
  });
  window.prompt = () => {
    throw new Error("prompt() is not supported.");
  };

  // The point is that this resolves at all. Before, it rejected.
  const res = await fetch("/api/anything");
  expect(res.status).toBe(401);
  expect(calls).toBeGreaterThan(0);
});

test("a registered requester is used instead of window.prompt", async () => {
  const { setTokenRequester } = await import("../src/api");
  let promptCalls = 0;
  window.prompt = () => {
    promptCalls += 1;
    return "from-native-prompt";
  };
  setTokenRequester(async () => "from-the-dialog");

  const seen: string[] = [];
  await installMockAuthFetch(async (input, init) => {
    const key = new Headers(init?.headers).get("X-OpenCodex-API-Key");
    if (key) seen.push(key);
    return new Response("", { status: key === "from-the-dialog" ? 200 : 401 });
  });

  await fetch("/api/anything");
  expect(seen).toContain("from-the-dialog");
  // The app's own dialog wins outright; the native one is never reached.
  expect(promptCalls).toBe(0);
  setTokenRequester(null);
});
