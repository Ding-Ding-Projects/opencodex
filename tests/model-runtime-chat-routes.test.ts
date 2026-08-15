import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleModelRuntimeChatRoutes } from "../src/server/management/model-runtime-chat-routes";
import { setServerRef } from "../src/server/lifecycle";
import { resetChatEngineForTests, setChatExecutorForTests } from "../src/lib/model-runtime/chat-engine";
import { setChatStorePathForTests } from "../src/lib/model-runtime/chat-store";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10100 } as never));
}

function ctx(pathname: string, method: string, body?: unknown, search = ""): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathname}${search}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }),
    url,
    config: { port: 10100, hostname: "127.0.0.1", providers: {} } as OcxConfig,
    deps: {} as ManagementContext["deps"],
    refreshCodexCatalogBestEffort: async () => {},
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Answers health/version healthy for every `checkOllamaHealth()` call the routes make. */
function healthyResponder(): (url: string) => Promise<Response> {
  return async url => {
    if (url.endsWith("/")) return new Response("Ollama is running", { status: 200 });
    if (url.endsWith("/api/version")) return jsonResponse({ version: "0.6.2" });
    throw new Error(`unexpected ${url}`);
  };
}

let dir: string;
let originalFetch: typeof fetch;
let responder: (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chat-routes-test-"));
  setChatStorePathForTests(join(dir, "chat-sessions.json"));
  resetChatEngineForTests();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setServerRef(undefined);
  setChatStorePathForTests(null);
  resetChatEngineForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("routing", () => {
  test("an unrelated path is not handled (returns null)", async () => {
    expect(await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/models", "DELETE"))).toBeNull();
  });

  test("the plain model-runtime prefix without /chat/ is not handled either", async () => {
    expect(await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/health", "GET"))).toBeNull();
  });
});

describe("session CRUD — no loopback gate (real inference/local-state action, not install)", () => {
  test("POST /sessions creates a session while the listener is non-loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "llama3.2:3b", title: "Hi" }));
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.session.model).toBe("llama3.2:3b");
    expect(body.session.title).toBe("Hi");
  });

  test("POST /sessions 400s without a model", async () => {
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", {}));
    expect(res?.status).toBe(400);
  });

  test("GET /sessions lists what was created", async () => {
    await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "GET"));
    const body = await res!.json();
    expect(body.sessions).toHaveLength(1);
  });

  test("GET /sessions/:id 404s for an unknown id", async () => {
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions/ghost", "GET"));
    expect(res?.status).toBe(404);
  });

  test("PATCH /sessions/:id updates settings", async () => {
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    const res = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}`, "PATCH", { title: "Renamed" }));
    expect(res?.status).toBe(200);
    expect((await res!.json()).session.title).toBe("Renamed");
  });

  test("DELETE /sessions/:id removes it, then a second delete 404s", async () => {
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    const first = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}`, "DELETE"));
    expect(first?.status).toBe(200);
    const second = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}`, "DELETE"));
    expect(second?.status).toBe(404);
  });
});

describe("POST /sessions/:id/messages — real streaming response", () => {
  test("409s when the runtime is not healthy, never silently starting a doomed turn", async () => {
    responder = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    const res = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}/messages`, "POST", { content: "hi" }));
    expect(res?.status).toBe(409);
  });

  test("a healthy runtime returns a real streamed body carrying the message ids on response headers", async () => {
    responder = healthyResponder();
    setChatExecutorForTests(async (_b, _m, _msgs, _o, opts) => {
      opts.onToken?.({ content: "hi there", done: false, stats: null });
      opts.onToken?.({ content: "", done: true, stats: null });
      return { ok: true, stats: null };
    });
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    const res = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}/messages`, "POST", { content: "hi" }));
    expect(res?.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toContain("x-ndjson");
    expect(res!.headers.get("X-Chat-Assistant-Message-Id")).toBeTruthy();
    expect(res!.headers.get("X-Chat-User-Message-Id")).toBeTruthy();
    const text = await res!.text();
    expect(text).toContain("hi there");
  });

  test("empty content 400s before any streaming begins", async () => {
    responder = healthyResponder();
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    const res = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}/messages`, "POST", { content: "" }));
    expect(res?.status).toBe(400);
  });
});

describe("POST /sessions/:id/stop", () => {
  test("404s for an unknown session", async () => {
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions/ghost/stop", "POST"));
    expect(res?.status).toBe(404);
  });

  test("succeeds as a no-op when nothing is streaming", async () => {
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    const res = await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}/stop`, "POST"));
    expect(res?.status).toBe(200);
  });
});

describe("GET /export", () => {
  test("400s→404s for a named session that does not exist", async () => {
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/export", "GET", undefined, "?sessionId=ghost"));
    expect(res?.status).toBe(404);
  });

  test("exports real session content and never the raw attachment bytes", async () => {
    responder = healthyResponder();
    setChatExecutorForTests(async (_b, _m, _msgs, _o, opts) => {
      opts.onToken?.({ content: "hello", done: false, stats: null });
      opts.onToken?.({ content: "", done: true, stats: null });
      return { ok: true, stats: null };
    });
    const created = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/sessions", "POST", { model: "a" }));
    const { session } = await created!.json();
    await handleModelRuntimeChatRoutes(ctx(`/api/model-runtime/chat/sessions/${session.id}/messages`, "POST", { content: "hi" }));

    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/export", "GET"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.sessions).toHaveLength(1);
    expect(JSON.stringify(body)).toContain("hello");
  });

  test("format=md returns a downloadable Markdown document", async () => {
    const res = await handleModelRuntimeChatRoutes(ctx("/api/model-runtime/chat/export", "GET", undefined, "?format=md"));
    expect(res?.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toContain("text/markdown");
    expect(res!.headers.get("Content-Disposition")).toContain("attachment");
  });
});
