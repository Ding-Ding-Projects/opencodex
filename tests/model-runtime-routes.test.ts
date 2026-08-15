import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleModelRuntimeRoutes } from "../src/server/management/model-runtime-routes";
import { setServerRef } from "../src/server/lifecycle";
import { setExistsCheckerForTests, setProbeRunnerForTests } from "../src/lib/model-runtime/executable-detect";
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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
  setExistsCheckerForTests(() => false);
  setProbeRunnerForTests(async () => false);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setServerRef(undefined);
  setExistsCheckerForTests(null);
  setProbeRunnerForTests(null);
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
