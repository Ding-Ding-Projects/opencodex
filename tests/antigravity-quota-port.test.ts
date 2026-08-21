import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveCredential } from "../src/oauth/store";
import { clearAccountQuotaCache, fetchProviderAccountQuotas, supportsPerAccountQuota } from "../src/providers/quota";
import { fetchAntigravityLiveQuota } from "../src/providers/antigravity-quota";
import { removeTempDir } from "./helpers/temp-dir";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-antigravity-port-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuotaCache();
  removeTempDir(home);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
});

describe("Antigravity quota security boundary", () => {
  test("uses HTTPS known daily/prod peers and rejects redirect-following", async () => {
    const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const result = await fetchAntigravityLiveQuota({
      accessToken: "token", projectId: "project", baseUrl: DAILY, timeoutMs: 500,
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({ url, redirect: init?.redirect });
        return url.startsWith(DAILY) ? json({}, 404) : json({ buckets: [{ modelId: "gemini-test", remainingFraction: 0.5 }] });
      },
    });
    expect(result?.customWindows?.[0]?.percent).toBe(50);
    expect(requests.every(request => request.redirect === "error")).toBe(true);
    expect(requests.every(request => request.url.startsWith(DAILY) || request.url.startsWith(PROD))).toBe(true);
  });

  test("does not send an OAuth bearer to cleartext configured destinations", async () => {
    const seen: string[] = [];
    const result = await fetchAntigravityLiveQuota({
      accessToken: "token", projectId: "project", baseUrl: "http://daily-cloudcode-pa.googleapis.com", timeoutMs: 500,
      fetchImpl: async (input, init) => {
        seen.push(String(input));
        return json({ buckets: [{ modelId: "gemini-test", remainingFraction: 0.5 }] });
      },
    });
    expect(result).toBeNull();
    expect(seen).toEqual([]);
  });

  test("keeps a terminal account failure isolated from its sibling", async () => {
    await saveCredential("google-antigravity", {
      access: "first-token", refresh: "first-refresh", expires: Date.now() + 3_600_000,
      accountId: "first", projectId: "first-project",
    });
    await saveCredential("google-antigravity", {
      access: "second-token", refresh: "second-refresh", expires: Date.now() + 3_600_000,
      accountId: "second", projectId: "second-project",
    });
    const seen: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(`${url}|${auth}`);
      if (auth.endsWith("first-token")) return json({}, 401);
      if (url.endsWith(":retrieveUserQuota")) return json({ buckets: [{ modelId: "gemini-test", remainingFraction: 0.2 }] });
      if (url.endsWith(":retrieveUserQuotaSummary")) return json({}, 404);
      return json({}, 404);
    }) as typeof fetch;
    const rows = await fetchProviderAccountQuotas("google-antigravity", true, DAILY);
    expect(supportsPerAccountQuota("google-antigravity")).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.accountId !== rows.find(inner => inner.quota === null)?.accountId)?.quota?.customWindows?.[0]?.percent).toBe(80);
    expect(rows.some(row => row.quota === null && row.unavailable === true)).toBe(true);
    expect(seen.some(entry => entry.includes("first-token"))).toBe(true);
    expect(seen.some(entry => entry.includes("second-token"))).toBe(true);
  });
});
