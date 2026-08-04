import { describe, expect, test } from "bun:test";
import { runtimeRequest } from "../src/cli/runtime-api";
import { stopProxyGracefully } from "../src/lib/process-control";
import { fetchClaudeContextWindows } from "../src/cli/claude";
import type { OcxConfig } from "../src/types";

describe("CLI management requests without an admin-token gate", () => {
  test("runtimeRequest leaves management headers credential-free", async () => {
    let headers: Headers | undefined;
    await runtimeRequest("/api/config", {}, {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });
    expect(headers?.get("x-opencodex-api-key")).toBeNull();
    expect(headers?.get("accept")).toBe("application/json");
  });

  test("graceful stop sends no management credential", async () => {
    let headers: Headers | undefined;
    const result = await stopProxyGracefully(1234, {
      readRuntime: () => ({ port: 10100, hostname: "127.0.0.1" }),
      waitExit: () => true,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "data-secret",
        OPENCODEX_ADMIN_AUTH_TOKEN: "admin-secret",
      },
      fetchFn: async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(null, { status: 200 });
      },
    });
    expect(result).toBe(true);
    expect(headers?.get("x-opencodex-api-key")).toBeNull();
  });

  test("Claude context discovery sends no management credential", async () => {
    let headers: Headers | undefined;
    const config = {
      port: 10100,
      defaultProvider: "test",
      providers: {},
      apiKeys: [{
        id: "configured",
        name: "Configured data key",
        key: "ocx_data_configured-secret",
        createdAt: "2026-07-28T00:00:00.000Z",
      }],
    } as OcxConfig;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ contextWindows: { "gpt-test": 200_000 } });
    }) as typeof fetch;
    try {
      expect(await fetchClaudeContextWindows(config, 10100)).toEqual({ "gpt-test": 200_000 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(headers?.get("x-opencodex-api-key")).toBeNull();
  });
});
