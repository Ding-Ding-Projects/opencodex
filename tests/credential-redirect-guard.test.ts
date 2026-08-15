/**
 * B3 security port #1 (upstream c19f571a, PR #1471): Codex OAuth credential forwarding
 * must be pinned to the canonical ChatGPT backend, and the credential-bearing sidecar
 * fetches must refuse cross-origin redirects.
 *
 * Before the fix, `createResponsesPassthroughAdapter`'s "forward" branch copied the
 * caller's live Codex bearer, chatgpt-account-id, and session_id onto *any* provider
 * configured `authMode: "forward"`, regardless of that provider's `baseUrl`. A user (or a
 * config generated on their behalf) who points a "forward" provider at a non-canonical
 * host hands that host their live OAuth session. The fix requires the provider's baseUrl
 * to resolve to the exact canonical ChatGPT backend before any credential is copied.
 *
 * Separately, Bun's default fetch follows 3xx redirects and — while it drops
 * `Authorization` across an origin change — it forwards nonstandard headers unchanged,
 * which is exactly where the Codex identity lives (`chatgpt-account-id`, `session_id`,
 * `x-codex-turn-metadata`). The first describe block proves that runtime behavior
 * directly rather than asserting it from memory; the sidecar fetches must therefore set
 * `redirect: "manual"` so a redirect is refused rather than silently followed.
 */
import { describe, expect, test } from "bun:test";
import { CODEX_FORWARD_BASE_URL } from "../src/providers/openai-tiers";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";

const LEAKED_BEARER = "Bearer SENTINEL-DO-NOT-FORWARD-TOKEN";
const LEAKED_ACCOUNT_ID = "sentinel-account-should-not-leak";
const LEAKED_SESSION_ID = "sentinel-session-should-not-leak";

describe("Bun forwards nonstandard headers across a redirect", () => {
  test("Authorization is dropped but Codex identity headers are not", async () => {
    const captured: Record<string, string | null> = {};
    const target = Bun.serve({
      port: 0,
      fetch(req) {
        captured.authorization = req.headers.get("authorization");
        captured.account = req.headers.get("chatgpt-account-id");
        captured.session = req.headers.get("session_id");
        return new Response("ok");
      },
    });
    const origin = Bun.serve({
      port: 0,
      fetch: () => new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${target.port}/landed` },
      }),
    });

    try {
      await fetch(`http://127.0.0.1:${origin.port}/start`, {
        headers: {
          authorization: LEAKED_BEARER,
          "chatgpt-account-id": LEAKED_ACCOUNT_ID,
          session_id: LEAKED_SESSION_ID,
        },
      });
    } finally {
      origin.stop(true);
      target.stop(true);
    }

    // The half that looks safe...
    expect(captured.authorization).toBeNull();
    // ...and the half that is not. This is why the sidecar fetches below must set
    // `redirect: "manual"` instead of relying on Authorization-stripping alone.
    expect(captured.account).toBe(LEAKED_ACCOUNT_ID);
    expect(captured.session).toBe(LEAKED_SESSION_ID);
  });
});

describe("createResponsesPassthroughAdapter refuses to forward credentials off-host", () => {
  test("a non-canonical forward provider does not receive the caller's Codex bearer", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      // Not the canonical chatgpt.com/backend-api/codex host — an operator misconfiguration,
      // or a compromised config, pointing "forward" mode at an attacker-controlled gateway.
      baseUrl: "https://not-the-real-chatgpt.example/backend-api/codex",
      authMode: "forward",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [] },
    }, {
      headers: new Headers({
        authorization: LEAKED_BEARER,
        "chatgpt-account-id": LEAKED_ACCOUNT_ID,
        session_id: LEAKED_SESSION_ID,
      }),
    });

    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["chatgpt-account-id"]).toBeUndefined();
    expect(request.headers.session_id).toBeUndefined();
  });

  test("a non-canonical forward provider does not receive a pool account override either", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://not-the-real-chatgpt.example/backend-api/codex",
      authMode: "forward",
      _codexAccountOverride: {
        accessToken: "SENTINEL-POOL-ACCESS-TOKEN",
        chatgptAccountId: "sentinel-pool-account",
      },
    } as unknown as Parameters<typeof createResponsesPassthroughAdapter>[0];
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [] },
    }, { headers: new Headers() });

    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["chatgpt-account-id"]).toBeUndefined();
  });

  test("the canonical forward provider still forwards the caller's Codex bearer (no regression)", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: CODEX_FORWARD_BASE_URL,
      authMode: "forward",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [] },
    }, {
      headers: new Headers({
        authorization: LEAKED_BEARER,
        "chatgpt-account-id": LEAKED_ACCOUNT_ID,
        session_id: LEAKED_SESSION_ID,
      }),
    });

    expect(request.headers.authorization).toBe(LEAKED_BEARER);
    expect(request.headers["chatgpt-account-id"]).toBe(LEAKED_ACCOUNT_ID);
    expect(request.headers.session_id).toBe(LEAKED_SESSION_ID);
    expect(request.url).toBe(`${CODEX_FORWARD_BASE_URL}/responses`);
  });

  test("the outbound URL for a canonical provider is pinned to the exact constant, not a trailing-slash variant", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      // Trailing slash normalizes as canonical (see isCanonicalOpenAiForwardProvider), but
      // the outbound URL must be built from the exact pinned constant, not this raw string.
      baseUrl: `${CODEX_FORWARD_BASE_URL}/`,
      authMode: "forward",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input: [] },
    }, { headers: new Headers({ authorization: LEAKED_BEARER }) });

    expect(request.url).toBe(`${CODEX_FORWARD_BASE_URL}/responses`);
    expect(request.headers.authorization).toBe(LEAKED_BEARER);
  });
});

describe("credential-bearing sidecars refuse to follow redirects", () => {
  const sites: Array<{ file: string; label: string }> = [
    { file: "../src/server/images.ts", label: "images relay" },
    { file: "../src/server/live.ts", label: "live relay" },
    { file: "../src/server/search.ts", label: "search relay" },
    { file: "../src/web-search/executor.ts", label: "web-search sidecar" },
    { file: "../src/vision/describe.ts", label: "vision sidecar" },
  ];

  for (const { file, label } of sites) {
    test(`${label} sets redirect: "manual"`, async () => {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).toContain('redirect: "manual"');
    });
  }
});
