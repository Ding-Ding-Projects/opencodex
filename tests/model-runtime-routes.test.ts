import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleModelRuntimeRoutes } from "../src/server/management/model-runtime-routes";
import { setServerRef } from "../src/server/lifecycle";
import { setExistsCheckerForTests, setProbeRunnerForTests } from "../src/lib/model-runtime/executable-detect";
import { resetPullQueueEngineForTests, setPullExecutorForTests } from "../src/lib/model-runtime/pull-queue-engine";
import { setPullQueueStorePathForTests } from "../src/lib/model-runtime/pull-queue-store";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10100 } as never));
}

function ctx(pathname: string, method: string, body?: unknown): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
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

let originalFetch: typeof fetch;
let responder: (url: string, init: RequestInit | undefined) => Promise<Response> | Response;
let queueDir: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
  setExistsCheckerForTests(() => false);
  setProbeRunnerForTests(async () => false);
  queueDir = mkdtempSync(join(tmpdir(), "ocx-pull-queue-routes-test-"));
  setPullQueueStorePathForTests(join(queueDir, "pull-queue.json"));
  resetPullQueueEngineForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setServerRef(undefined);
  setExistsCheckerForTests(null);
  setProbeRunnerForTests(null);
  setPullExecutorForTests(null);
  resetPullQueueEngineForTests();
  setPullQueueStorePathForTests(null);
  rmSync(queueDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("routing", () => {
  test("an unrelated path is not handled (returns null)", async () => {
    const result = await handleModelRuntimeRoutes(ctx("/api/pdf/inspect", "POST"));
    expect(result).toBeNull();
  });
});

describe("GET /api/model-runtime/health", () => {
  test("reports the real health state — never a fixed 'ok:true'", async () => {
    responder = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/health", "GET"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(["missing", "stopped", "unhealthy", "offline", "healthy"]).toContain(body.state);
  });
});

describe("GET /api/model-runtime/catalog", () => {
  test("unhealthy runtime → catalog is null, not fabricated", async () => {
    responder = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/catalog", "GET"));
    const body = await res!.json();
    expect(body.catalog).toBeNull();
    expect(body.health.state).not.toBe("healthy");
  });

  test("healthy runtime → catalog is built from real tags", async () => {
    responder = async url => {
      if (url.endsWith("/")) return new Response("Ollama is running", { status: 200 });
      if (url.endsWith("/api/version")) return jsonResponse({ version: "0.6.2" });
      if (url.includes("/api/tags")) return jsonResponse({ models: [{ name: "llama3.1:8b", size: 4_920_000_000 }] });
      if (url.includes("/api/ps")) return jsonResponse({ models: [] });
      if (url.includes("/api/show")) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/catalog", "GET"));
    const body = await res!.json();
    expect(body.health.state).toBe("healthy");
    expect(body.catalog.entries).toHaveLength(1);
    expect(body.catalog.entries[0].name).toBe("llama3.1:8b");
    expect(body.catalog.entries[0].fit).toBeDefined();
  });
});

describe("DELETE /api/model-runtime/models — local-machine gate", () => {
  test("refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/models", "DELETE", { name: "llama3.1:8b" }));
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "loopback-required" });
  });

  test("400 for a missing name", async () => {
    listeningOn("127.0.0.1");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/models", "DELETE", {}));
    expect(res?.status).toBe(400);
  });

  test("succeeds and calls the real /api/delete route", async () => {
    listeningOn("127.0.0.1");
    let deletedModel: string | undefined;
    responder = async (url, init) => {
      if (url.includes("/api/delete")) {
        deletedModel = (JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/models", "DELETE", { name: "llama3.1:8b" }));
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(deletedModel).toBe("llama3.1:8b");
  });

  test("a failed delete reports the failure rather than a false ok:true", async () => {
    listeningOn("127.0.0.1");
    responder = async () => new Response("not found", { status: 404 });
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/models", "DELETE", { name: "ghost:1b" }));
    expect(res?.status).toBe(502);
    expect((await res!.json()).ok).toBe(false);
  });
});

/** A responder that answers every route `buildOllamaCatalog`/`checkOllamaHealth`/the pull-queue's own `/api/tags` reconciliation call need, with a healthy daemon and one installed model. */
function healthyResponder(installed: string[] = ["already:here"]): (url: string, init: RequestInit | undefined) => Promise<Response> {
  return async url => {
    if (url.endsWith("/")) return new Response("Ollama is running", { status: 200 });
    if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.6.2" }), { status: 200 });
    if (url.includes("/api/tags")) return new Response(JSON.stringify({ models: installed.map(name => ({ name, size: 1_000_000 })) }), { status: 200 });
    if (url.includes("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (url.includes("/api/show")) return new Response(JSON.stringify({}), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
}

describe("POST /api/model-runtime/pull-queue/preflight — read-only, no gate", () => {
  test("returns 400 without a non-empty tags array", async () => {
    responder = healthyResponder();
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/preflight", "POST", { tags: [] }));
    expect(res?.status).toBe(400);
  });

  test("works over a non-loopback listener — this is a read, not a mutation", async () => {
    listeningOn("0.0.0.0");
    responder = healthyResponder(["already:here"]);
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/preflight", "POST", { tags: ["already:here", "brand-new:1b"] }));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.preflight.items).toHaveLength(2);
    expect(body.preflight.items[0].alreadyInstalled).toBe(true);
    expect(body.preflight.items[1].alreadyInstalled).toBe(false);
    expect(body.preflight.items[1].estimatedSizeBytes).toBeNull();
  });

  test("an unhealthy runtime still returns an honest preflight (no catalog to draw sizes from)", async () => {
    responder = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/preflight", "POST", { tags: ["x:1b"] }));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.preflight.items[0].estimatedSizeBytes).toBeNull();
  });
});

describe("GET /api/model-runtime/pull-queue — read-only, no gate, never triggers resume/processing", () => {
  test("reports the current (empty) state over a non-loopback listener without ever calling fetch", async () => {
    listeningOn("0.0.0.0");
    responder = async () => { throw new Error("GET /pull-queue must never make a network call by itself"); };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue", "GET"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.state.items).toEqual([]);
    expect(body.summary.outcome).toBe("empty");
  });
});

describe("POST /api/model-runtime/pull-queue/resume — local-machine gate", () => {
  test("refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/resume", "POST"));
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "loopback-required" });
  });

  test("succeeds over loopback and returns the (empty) state", async () => {
    listeningOn("127.0.0.1");
    responder = healthyResponder([]);
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/resume", "POST"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.state.items).toEqual([]);
  });
});

describe("POST /api/model-runtime/pull-queue/start — local-machine gate and validation", () => {
  test("refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/start", "POST", { tags: ["a:1"] }));
    expect(res?.status).toBe(403);
  });

  test("400 without a tags array", async () => {
    listeningOn("127.0.0.1");
    responder = healthyResponder();
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/start", "POST", {}));
    expect(res?.status).toBe(400);
  });

  test("409 when the runtime is not healthy — never silently queues work that would just fail", async () => {
    listeningOn("127.0.0.1");
    responder = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/start", "POST", { tags: ["a:1"] }));
    expect(res?.status).toBe(409);
  });

  test("a healthy runtime starts the batch and reports real per-item outcomes once it drains", async () => {
    listeningOn("127.0.0.1");
    responder = healthyResponder(["already:here"]);
    setPullExecutorForTests((async (_baseUrl, model, options = {}) => {
      options.onLine?.({ status: "success", digest: null, total: null, completed: null });
      return { ok: true };
    }) as Parameters<typeof setPullExecutorForTests>[0]);

    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/start", "POST", { tags: ["already:here", "new:1b"] }));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.state.items).toHaveLength(2);
    const skipped = body.state.items.find((i: { tag: string }) => i.tag === "already:here");
    expect(skipped.status).toBe("skipped");
  });
});

describe("POST /api/model-runtime/pull-queue/cancel — local-machine gate", () => {
  test("refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/cancel", "POST", {}));
    expect(res?.status).toBe(403);
  });

  test("404 for an unknown id", async () => {
    listeningOn("127.0.0.1");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/cancel", "POST", { id: "no-such-item" }));
    expect(res?.status).toBe(404);
  });

  test("omitting id cancels every non-terminal item and reports a summary", async () => {
    listeningOn("127.0.0.1");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/cancel", "POST", {}));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.summary).toBeDefined();
  });
});

describe("POST /api/model-runtime/pull-queue/retry — local-machine gate", () => {
  test("refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/retry", "POST", { id: "x" }));
    expect(res?.status).toBe(403);
  });

  test("400 for a missing id", async () => {
    listeningOn("127.0.0.1");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/retry", "POST", {}));
    expect(res?.status).toBe(400);
  });

  test("400 for an id that is not currently failed/cancelled", async () => {
    listeningOn("127.0.0.1");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/retry", "POST", { id: "no-such-item" }));
    expect(res?.status).toBe(400);
  });
});

describe("POST /api/model-runtime/pull-queue/clear — local-machine gate", () => {
  test("refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/clear", "POST"));
    expect(res?.status).toBe(403);
  });

  test("succeeds over loopback", async () => {
    listeningOn("127.0.0.1");
    const res = await handleModelRuntimeRoutes(ctx("/api/model-runtime/pull-queue/clear", "POST"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.summary.total).toBe(0);
  });
});
