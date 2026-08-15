import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearCodexQuotaPrimeState,
  fetchMainAccountInfo,
  listCodexAuthAccounts,
} from "../src/codex/auth-api";
import { purgeCodexAccountRuntimeState } from "../src/codex/account-lifecycle";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearMainAccountInfoCache } from "../src/codex/main-account-cache";
import { clearAccountQuota } from "../src/codex/quota";
import { clearThreadAccountMap } from "../src/codex/routing";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * Regression coverage for devlog b3-proxyhang (2026-08-15).
 *
 * The reproduced defect: loading the desktop dashboard for the first time
 * fires `GET /api/codex-auth/accounts` (passive, forceRefresh=false) roughly
 * half a second after the proxy's own startup prime already attempted the
 * same main account's WHAM usage fetch — both ordinary, unremarkable
 * traffic, no reload required. Under real concurrent request load that
 * second `fetch()` to `https://chatgpt.com/backend-api/wham/usage` was
 * observed to permanently freeze the whole `Bun.serve()` listener (Bun
 * 1.3.14, Windows): not just that one request, but every other route on the
 * same process, including a plain `GET /healthz` hit from a completely
 * separate process outside the browser entirely.
 *
 * The response on the real machine was a 401 (the local Codex token was not
 * one the mock upstream accepted), which matters here: a SUCCESSFUL WHAM
 * fetch is cached for five minutes (`MAIN_CACHE_TTL`) and a second passive
 * call within that window already short-circuits on the cache, independent
 * of anything this fix adds. A 401 is deliberately never cached (see
 * `fetchMainAccountInfoAttempt`'s `!resp.ok` branch), so — exactly like the
 * real reproduction — nothing but the new throttle stands between a passive
 * mount-time re-check and a second real network attempt. Every mock fetch
 * below returns 401 for this reason, not because the fix is 401-specific.
 *
 * See `src/codex/wham-fetch-throttle.ts` and `fetchWhamUsage` in
 * `src/codex/auth-api.ts` for the fix: a passive WHAM fetch is refused
 * outright when another attempt for the SAME account started within the last
 * few seconds, so the second real network attempt this bug needs to trigger
 * never happens.
 *
 * This test cannot force Bun's runtime to freeze on demand — that reproduces
 * only under real concurrent `Bun.serve()` load, verified separately via the
 * project's own screenshot-capture harness (`scripts/capture-shots.ts`)
 * driving the real packaged Electron app. What it CAN verify, and what
 * distinguishes "fixed" from "not fixed" here, is the mechanism the fix
 * actually relies on: that the dashboard-mount call pattern never issues a
 * second real fetch to the WHAM endpoint for the same account within the
 * cooldown window. Revert `fetchWhamUsage` back to a bare `fetch(...)` call
 * (no throttle) and the first test below fails, because both the prime and
 * the mount-time call would reach the network — `whamCalls` becomes 2, not 1.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-wham-fetch-throttle-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  } as OcxConfig;
}

function writeMainAuth(): void {
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  writeFileSync(
    join(TEST_CODEX_HOME, "auth.json"),
    JSON.stringify({ tokens: { access_token: "main_access", account_id: "main_acct" } }),
  );
}

function seedPoolAccount(config: OcxConfig, id: string): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id, email: `${id}@example.test`, isMain: false },
  ];
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

/** Never cached (`!resp.ok`) — see the file-level comment for why that matters here. */
function whamUnauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
}

describe("passive WHAM usage fetch throttle (b3-proxyhang)", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) removeTempDir(TEST_DIR);
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    writeMainAuth();
    clearAccountQuota();
    clearThreadAccountMap();
    clearMainAccountInfoCache();
    clearCodexQuotaPrimeState();
  });

  afterEach(() => {
    clearAccountQuota();
    clearThreadAccountMap();
    clearMainAccountInfoCache();
    clearCodexQuotaPrimeState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTempDir(TEST_DIR);
  });

  test("the exact reproduced sequence (startup prime, then a mount-time re-fetch) never issues a second real network call", async () => {
    const originalFetch = globalThis.fetch;
    let whamCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return whamUnauthorized();
        }
        return originalFetch(input);
      }) as typeof fetch;

      // 1. The proxy's own startup prime: `primeCodexPoolQuotas` -> `fetchMainAccountInfo(false)`.
      await fetchMainAccountInfo(false);
      expect(whamCalls).toBe(1);

      // 2. Ordinary dashboard-mount timing: `GET /api/codex-auth/accounts` calls
      // `listCodexAuthAccounts(config)` (forceRefresh defaults to false) well within
      // the throttle window — this is the exact call that reproduced the freeze.
      const config = makeConfig();
      const accounts = await listCodexAuthAccounts(config);
      const main = accounts.find(a => a.id === MAIN_CODEX_ACCOUNT_ID);
      expect(main).toBeDefined();

      // The whole point: the second passive attempt must NOT have reached the
      // network. Reverting fetchWhamUsage to a bare fetch() call fails this line,
      // because whamCalls would be 2 — the exact pattern that froze the proxy.
      expect(whamCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("clearing the throttle (as a confirmed identity change or account removal already does) lets the next passive call through", async () => {
    const originalFetch = globalThis.fetch;
    let whamCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return whamUnauthorized();
        }
        return originalFetch(input);
      }) as typeof fetch;

      await fetchMainAccountInfo(false);
      expect(whamCalls).toBe(1);

      // A recent-enough attempt is throttled...
      await fetchMainAccountInfo(false);
      expect(whamCalls).toBe(1);

      // ...but the throttle is not permanent: clearing it (exactly what
      // `purgeCodexAccountRuntimeState` already does on a confirmed identity
      // change or account removal) lets the very next passive call through.
      purgeCodexAccountRuntimeState(MAIN_CODEX_ACCOUNT_ID);
      await fetchMainAccountInfo(false);
      expect(whamCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an explicit forceRefresh always reaches the network, even immediately after a passive fetch", async () => {
    const originalFetch = globalThis.fetch;
    let whamCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return whamUnauthorized();
        }
        return originalFetch(input);
      }) as typeof fetch;

      await fetchMainAccountInfo(false);
      expect(whamCalls).toBe(1);

      // A user pressing "refresh" a moment later must not be silently told to
      // wait: forceRefresh bypasses the throttle by design.
      await fetchMainAccountInfo(true);
      expect(whamCalls).toBe(2);
      await fetchMainAccountInfo(true);
      expect(whamCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the throttle is per-account: a pool account fetch is never blocked by the main account's recent fetch", async () => {
    const originalFetch = globalThis.fetch;
    let whamCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return whamUnauthorized();
        }
        return originalFetch(input);
      }) as typeof fetch;

      await fetchMainAccountInfo(false);
      expect(whamCalls).toBe(1);

      // A DIFFERENT account, requested immediately after, must reach the network:
      // priming several accounts' quotas back-to-back is normal, expected traffic
      // and must stay exactly as concurrent as it always was.
      const config = makeConfig();
      seedPoolAccount(config, "p1");
      const accounts = await listCodexAuthAccounts(config);
      const pool = accounts.find(a => a.id === "p1");
      expect(pool).toBeDefined();
      expect(whamCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
