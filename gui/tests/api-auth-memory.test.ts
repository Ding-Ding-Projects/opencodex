import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  installApiAuthFetch,
  isApiAuthFetchInstalledForTests,
  resetApiAuthFetchForTests,
  setTokenRequester,
} from "../src/api";

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
});

afterEach(() => {
  window.prompt = originalPrompt;
  setTokenRequester(null);
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("the legacy auth bootstrap is a no-op and never reads browser storage", () => {
  let getItemCalls = 0;
  const storage = sessionStorage;
  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = (() => {
    getItemCalls += 1;
    return originalGetItem("unused");
  }) as typeof storage.getItem;
  try {
    installApiAuthFetch();
    expect(isApiAuthFetchInstalledForTests()).toBe(true);
    expect(getItemCalls).toBe(0);
  } finally {
    storage.getItem = originalGetItem;
  }
});

test("401 responses never open a token prompt or invoke the legacy requester", async () => {
  let promptCalls = 0;
  let requesterCalls = 0;
  window.prompt = () => {
    promptCalls += 1;
    return "should-never-be-collected";
  };
  setTokenRequester(async () => {
    requesterCalls += 1;
    return "should-never-be-collected";
  });
  const seen: Array<{ url: string; headers: Headers }> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(window, "fetch", { configurable: true, value: mockFetch });
  installApiAuthFetch();

  expect((await fetch("/api/config")).status).toBe(401);
  expect(promptCalls).toBe(0);
  expect(requesterCalls).toBe(0);
  expect(seen[0]?.headers.get("x-opencodex-api-key")).toBeNull();
});

test("management and data-plane requests use the native fetch without injected credentials", async () => {
  const seen: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    });
    return Response.json({ ok: true });
  };
  Object.assign(globalThis, { fetch: fetchImpl });
  Object.assign(window, { fetch: fetchImpl });
  installApiAuthFetch();
  await window.fetch("/api/config");
  await window.fetch("/api/settings", { method: "PUT", body: "{}" });
  await window.fetch("/v1/models");

  expect(seen).toHaveLength(3);
  for (const request of seen) {
    expect(request.headers.get("x-opencodex-api-key")).toBeNull();
    expect(request.headers.get("x-opencodex-gui-origin")).toBeNull();
    expect(request.headers.get("x-opencodex-csrf-token")).toBeNull();
  }
});
