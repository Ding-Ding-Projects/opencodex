import { afterEach, describe, expect, test } from "bun:test";
import { fetchAntigravityWithRetry } from "../src/adapters/google-http";
import { getAntigravityAccountCooldown, clearAntigravityAccountCooldown } from "../src/oauth/antigravity-routing";
import { assertAntigravityBearerUrl } from "../src/providers/antigravity-trust";
import type { AdapterRequest } from "../src/adapters/base";

const originalFetch = globalThis.fetch;
const request: AdapterRequest = {
  url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
  method: "POST",
  headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
  body: "{}",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAntigravityAccountCooldown("account-a");
});

describe("Antigravity account cooldown recording", () => {
  test("rejects arbitrary, private, and metadata bearer destinations before dispatch", () => {
    expect(() => assertAntigravityBearerUrl("https://attacker.example/v1internal:streamGenerateContent?alt=sse")).toThrow(/known HTTPS/);
    expect(() => assertAntigravityBearerUrl("https://127.0.0.1/v1internal:streamGenerateContent?alt=sse")).toThrow(/known HTTPS/);
    expect(() => assertAntigravityBearerUrl("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?foo=bar")).toThrow(/known HTTPS/);
  });
  test("records hard quota exhaustion and does not retry the paid POST", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }), {
        status: 429,
        headers: { "retry-after": "10" },
      });
    }) as typeof fetch;
    const response = await fetchAntigravityWithRetry(request, { accountId: "account-a", timeoutMs: 1_000 });
    expect(response.status).toBe(429);
    expect(calls).toBe(1);
    expect(getAntigravityAccountCooldown("account-a")?.reason).toBe("quota_exhausted");
  });

  test("records geo blocks without exposing the provider body", async () => {
    globalThis.fetch = (async () => new Response("User location is not supported for the API use.", { status: 403 })) as typeof fetch;
    const response = await fetchAntigravityWithRetry(request, { accountId: "account-a", timeoutMs: 1_000 });
    expect(response.status).toBe(403);
    expect(getAntigravityAccountCooldown("account-a")?.reason).toBe("geo_blocked");
    const text = await response.text();
    expect(text).toContain("location not supported");
    expect(text).not.toContain("test-token");
  });

  test("fails over one known host on a stream 503 without changing the request path", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com")) return new Response("", { status: 503 });
      return new Response("data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}]}}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const response = await fetchAntigravityWithRetry(request, { accountId: "account-a", timeoutMs: 1_000 });
    expect(response.status).toBe(200);
    expect(urls).toEqual([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    ]);
  });
});
