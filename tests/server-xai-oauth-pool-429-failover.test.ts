import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import {
  clearOAuthPoolState,
  getEligibleOAuthAccounts,
  getOAuthAccountHealthSnapshot,
} from "../src/oauth/provider-pool";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { clearAccountQuotaCache } from "../src/providers/quota";
import { XAI_GROK_CLI_BASE_URL } from "../src/providers/xai-transport";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * End-to-end proof that the generalized pool's 429 failover actually runs on the request
 * path for a non-anthropic provider — cool the rate-limited account, re-resolve the FULL
 * account wiring, and replay the same request on the sibling's bearer. The unit tests pin
 * the selection engine; this pins that the server loop is wired to it for xai too, and
 * that it stops instead of spinning once every account is cooled.
 */

const CHAT_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/chat/completions`;

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-xai-pool-429-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-xai-pool-429-"));
  process.env.OPENCODEX_HOME = testDir;
  clearOAuthPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("xai");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOAuthPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("xai");
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTempDir(testDir);
});

function xaiPoolConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        models: ["grok-4.5"],
        accountPool: { enabled: true },
      },
    },
  } as OcxConfig;
}

/** Two logged-in xai accounts with long-lived tokens, active pinned to A. */
async function seedTwoAccounts(): Promise<{ idA: string; idB: string }> {
  await saveCredential("xai", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
    source: "oauth",
  });
  await saveCredential("xai", {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
    source: "oauth",
  });
  const set = getAccountSet("xai")!;
  const idA = set.accounts.find(a => a.credential.accountId === "uuid-aaaa")!.id;
  const idB = set.accounts.find(a => a.credential.accountId === "uuid-bbbb")!.id;
  await setActiveAccount("xai", idA);
  return { idA, idB };
}

function successBody(text: string): string {
  return JSON.stringify({
    id: "chatcmpl-xai-pool-429",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

/**
 * Upstream keyed by bearer rather than by call order: the assertion is about WHICH
 * account served the retry, which a status queue cannot tell you.
 */
function installPoolFetch(rateLimited: Set<string>): { bearers: string[] } {
  const bearers: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CHAT_ENDPOINT) {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      bearers.push(bearer);
      if (rateLimited.has(bearer)) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        });
      }
      return new Response(successBody("ok on the sibling account"), {
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { bearers };
}

async function post(server: ReturnType<typeof startServer>): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "xai/grok-4.5", input: "hello", stream: false }),
  });
}

describe("xai OAuth pool 429 failover", () => {
  test("a 429 on the active account replays the request on the sibling account", async () => {
    const { idA, idB } = await seedTwoAccounts();
    saveConfig(xaiPoolConfig());
    const observed = installPoolFetch(new Set(["Bearer access-a"]));
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      const json = await response.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(item => item.type === "message")?.content?.[0]?.text)
        .toBe("ok on the sibling account");
      // One attempt per account, in pool order — not a retry on the same rejected bearer.
      expect(observed.bearers).toEqual(["Bearer access-a", "Bearer access-b"]);

      // The rate-limited account is cooled for the upstream's Retry-After and drops out
      // of eligibility, so the next session does not walk straight back into the 429.
      const cooled = getOAuthAccountHealthSnapshot("xai", idA);
      expect(cooled?.cooldownSource).toBe("retry-after");
      expect(getEligibleOAuthAccounts("xai")).toEqual([idB]);
    } finally {
      server.stop(true);
    }
  });

  test("every account rate-limited surfaces the 429 instead of looping", async () => {
    const { idA, idB } = await seedTwoAccounts();
    saveConfig(xaiPoolConfig());
    const observed = installPoolFetch(new Set(["Bearer access-a", "Bearer access-b"]));
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(429);
      // Each account is tried exactly once; the loop ends when nothing eligible is left.
      expect(observed.bearers).toEqual(["Bearer access-a", "Bearer access-b"]);
      expect(getEligibleOAuthAccounts("xai")).toEqual([]);
      expect(getOAuthAccountHealthSnapshot("xai", idA)).not.toBeNull();
      expect(getOAuthAccountHealthSnapshot("xai", idB)).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
