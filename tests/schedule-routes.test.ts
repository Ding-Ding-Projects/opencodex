import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleScheduleRoutes } from "../src/server/management/schedule-routes";
import { setServerRef } from "../src/server/lifecycle";
import { hasVaultSecret } from "../src/lib/os-credential-vault";
import { removeTempDir } from "./helpers/temp-dir";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

/**
 * `/api/schedule/*` — the privileged process's SSRF/redirect/size/loopback
 * boundary, and the round trip into the OS credential vault for a Home
 * Assistant token.
 */

function ctx(pathname: string, method: string, body?: unknown, query = ""): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathname}${query}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
    url,
    config: { port: 10100, hostname: "127.0.0.1", providers: {} } as OcxConfig,
    deps: {} as ManagementContext["deps"],
    refreshCodexCatalogBestEffort: async () => {},
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

let originalFetch: typeof fetch;
let responder: (url: string, init: RequestInit | undefined) => Promise<Response>;
let testDir: string;
let previousHome: string | undefined;

// Every test in this file gets an isolated OPENCODEX_HOME, whether or not it
// happens to touch the vault — a real Home Assistant token round-trip is
// covered by two of these tests, and an isolated config dir is what keeps
// them (and anything that reads `hasVaultSecret` without expecting to find
// anything) from ever looking at bytes in the developer's own `~/.opencodex`.
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-schedule-routes-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setServerRef(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTempDir(testDir);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("POST /api/schedule/resolve-api — URL boundary", () => {
  test("refuses a plain http:// URL that is not loopback", async () => {
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "http://example.com/schedule.json" }));
    const body = await res!.json();
    expect(res!.status).toBe(400);
    expect(body.reason).toBe("invalid-url");
  });

  test("accepts https://", async () => {
    responder = async () => jsonResponse({ version: 1, values: { theme: "dark" } });
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    const body = await res!.json();
    expect(body).toEqual({ ok: true, values: { theme: "dark" } });
  });

  test("accepts loopback http://127.0.0.1", async () => {
    responder = async () => jsonResponse({ version: 1, values: {} });
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "http://127.0.0.1:9999/schedule.json" }));
    expect((await res!.json()).ok).toBe(true);
  });

  test("refuses a URL carrying embedded credentials", async () => {
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://user:pass@example.com/schedule.json" }));
    expect((await res!.json()).reason).toBe("invalid-url");
  });

  test("never follows a redirect — a 3xx is reported as refused, and fetch is called exactly once", async () => {
    let calls = 0;
    responder = async () => { calls += 1; return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } }); };
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("refused");
    expect(calls).toBe(1);
  });

  test("an oversized response is refused rather than buffered whole", async () => {
    responder = async () => {
      const huge = "x".repeat(200_000);
      return jsonResponse({ version: 1, values: {}, padding: huge });
    };
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("too-large");
  });

  test("non-JSON response is reported as malformed", async () => {
    responder = async () => new Response("<html>not json</html>", { status: 200 });
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    expect((await res!.json())).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("a response missing the version envelope is malformed", async () => {
    responder = async () => jsonResponse({ theme: "dark" }); // no {version:1, values:...}
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    expect((await res!.json())).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("values are allowlisted — an unknown field and an out-of-range value are both dropped", async () => {
    responder = async () => jsonResponse({ version: 1, values: { theme: "dark", density: 999, evilField: "<script>" } });
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    expect((await res!.json()).values).toEqual({ theme: "dark" });
  });

  test("a network failure surfaces as reason network, not a 500", async () => {
    responder = async () => { throw new TypeError("fetch failed"); };
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    expect(res!.status).toBe(200);
    expect((await res!.json())).toMatchObject({ ok: false, reason: "network" });
  });

  test("a non-2xx HTTP status is refused", async () => {
    responder = async () => new Response("nope", { status: 500 });
    const res = await handleScheduleRoutes(ctx("/api/schedule/resolve-api", "POST", { url: "https://example.com/schedule.json" }));
    expect((await res!.json())).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("POST /api/schedule/ha-state", () => {
  test("refuses a malformed entity id", async () => {
    const res = await handleScheduleRoutes(ctx("/api/schedule/ha-state", "POST", { baseUrl: "https://ha.local", entityId: "not-an-entity", tokenRef: "tok" }));
    expect((await res!.json()).reason).toBe("invalid-entity");
  });

  test('reports "no-token" when nothing is stored for the tokenRef', async () => {
    const res = await handleScheduleRoutes(ctx("/api/schedule/ha-state", "POST", { baseUrl: "https://ha.local", entityId: "input_boolean.evening", tokenRef: "never-stored-ref" }));
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-token");
  });

  test("with a stored token, fetches /api/states/<entity> and returns the state — never the token", async () => {
    setServerRef({ hostname: "127.0.0.1", port: 10100 } as never); // PUT ha-token needs the loopback gate open
    const putRes = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "PUT", { tokenRef: "ha-tok-1", token: "sekrit-long-lived-token" }));
    expect((await putRes!.json()).ok).toBe(true);
    expect(hasVaultSecret("ha-tok-1")).toBe(true);

    let seenAuth: string | null = null;
    responder = async (url, init) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      expect(url).toContain("/api/states/input_boolean.evening");
      return jsonResponse({ entity_id: "input_boolean.evening", state: "on" });
    };
    const stateRes = await handleScheduleRoutes(ctx("/api/schedule/ha-state", "POST", { baseUrl: "https://ha.local", entityId: "input_boolean.evening", tokenRef: "ha-tok-1" }));
    const body = await stateRes!.json();
    expect(body).toEqual({ ok: true, state: "on" });
    expect(JSON.stringify(body)).not.toContain("sekrit-long-lived-token");
    expect(seenAuth).toBe("Bearer sekrit-long-lived-token");
  }, 20_000);
});

describe("/api/schedule/ha-token — loopback gate and CRUD", () => {
  test("GET reports not configured for an unknown ref, without requiring loopback", async () => {
    setServerRef({ hostname: "0.0.0.0", port: 10100 } as never);
    const res = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "GET", undefined, "?tokenRef=totally-unknown"));
    expect((await res!.json())).toEqual({ configured: false });
  });

  test("PUT is refused on a non-loopback listener before touching the vault", async () => {
    setServerRef({ hostname: "0.0.0.0", port: 10100 } as never);
    const res = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "PUT", { tokenRef: "gate-test", token: "value" }));
    expect(res!.status).toBe(403);
    expect((await res!.json())).toMatchObject({ reason: "loopback-required" });
    expect(hasVaultSecret("gate-test")).toBe(false);
  });

  test("DELETE is refused on an unknown listener (fails closed)", async () => {
    setServerRef(undefined);
    const res = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "DELETE", { tokenRef: "gate-test" }));
    expect(res!.status).toBe(403);
  });

  test("PUT succeeds on a loopback listener and GET then reports configured", async () => {
    setServerRef({ hostname: "127.0.0.1", port: 10100 } as never);
    const putRes = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "PUT", { tokenRef: "crud-ref", token: "a-real-token-value" }));
    expect((await putRes!.json())).toEqual({ ok: true });

    const getRes = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "GET", undefined, "?tokenRef=crud-ref"));
    expect((await getRes!.json())).toEqual({ configured: true });

    const delRes = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "DELETE", { tokenRef: "crud-ref" }));
    expect((await delRes!.json())).toEqual({ ok: true });

    const getAfter = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "GET", undefined, "?tokenRef=crud-ref"));
    expect((await getAfter!.json())).toEqual({ configured: false });
  }, 20_000);

  test("PUT rejects an empty token and an invalid tokenRef", async () => {
    setServerRef({ hostname: "127.0.0.1", port: 10100 } as never);
    const empty = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "PUT", { tokenRef: "ok-ref", token: "" }));
    expect(empty!.status).toBe(400);
    const badRef = await handleScheduleRoutes(ctx("/api/schedule/ha-token", "PUT", { tokenRef: "bad ref!", token: "value" }));
    expect(badRef!.status).toBe(400);
  });
});

describe("routing", () => {
  test("an unrelated path falls through with null", async () => {
    expect(await handleScheduleRoutes(ctx("/api/unrelated", "GET"))).toBeNull();
  });
});
