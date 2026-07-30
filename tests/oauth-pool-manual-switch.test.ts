import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  bindOAuthSessionAffinity,
  clearOAuthPoolState,
  resolveOAuthAccountForSession,
} from "../src/oauth/provider-pool";
import {
  clearPoolRotationState,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  POOL_KEY_ANTHROPIC,
} from "../src/codex/pool-rotation";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * Picking an account in the dashboard is an operator override, so it has to beat the
 * pool's own routing state: a session already affined to the old account, and the RR
 * ring pointing somewhere else. That reset used to live on the anthropic-only route,
 * which meant a pooled xai/kimi/kiro operator watched their choice get ignored for the
 * rest of the session. This pins it for EVERY pooled provider's config home.
 */

const ACCOUNT_A = "aaaa1111";
const ACCOUNT_B = "bbbb2222";

interface PooledProviderCase {
  provider: string;
  /** Anthropic keeps the historical rotation key; everyone else is namespaced. */
  rotationKey: string;
  config: () => OcxConfig;
}

const CASES: PooledProviderCase[] = [
  {
    provider: "xai",
    rotationKey: "oauth:xai",
    config: () => ({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          accountPool: { enabled: true, strategy: "round-robin", stickyLimit: 1 },
        },
      },
    } as unknown as OcxConfig),
  },
  {
    provider: "anthropic",
    rotationKey: POOL_KEY_ANTHROPIC,
    config: () => ({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
      },
      anthropicAccountPool: { enabled: true, strategy: "round-robin", stickyLimit: 1 },
    } as unknown as OcxConfig),
  },
];

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function writeAccounts(provider: string): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    [provider]: {
      activeAccountId: ACCOUNT_A,
      accounts: [
        { id: ACCOUNT_A, credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "a@example.com", accountId: "acct-1" } },
        { id: ACCOUNT_B, credential: { access: "t2", refresh: "r2", expires: 9999999999999, email: "b@example.com", accountId: "acct-2" } },
      ],
    },
  }), { mode: 0o600 });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-pool-switch-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-pool-switch-"));
  process.env.OPENCODEX_HOME = testDir;
  clearOAuthPoolState();
  clearPoolRotationState();
});

afterEach(() => {
  clearOAuthPoolState();
  clearPoolRotationState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTempDir(testDir);
});

describe("manual account switch resets pool routing", () => {
  for (const pooled of CASES) {
    test(`${pooled.provider}: PUT active clears session affinity and seeds the RR ring`, async () => {
      const config = pooled.config();
      saveConfig(config);
      writeAccounts(pooled.provider);

      const server = startServer(0);
      try {
        // A live session is bound to account A, and the ring has been advanced past it.
        bindOAuthSessionAffinity(pooled.provider, "session-1", ACCOUNT_A);
        expect(resolveOAuthAccountForSession(pooled.provider, "session-1", config))
          .toEqual({ accountId: ACCOUNT_A, reason: "affinity" });
        pickRoundRobinAccount(pooled.rotationKey, [ACCOUNT_A, ACCOUNT_B], 1);

        // Operator picks account B in the dashboard.
        const res = await fetch(new URL("/api/oauth/accounts/active", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: pooled.provider, accountId: ACCOUNT_B }),
        });
        expect(res.status).toBe(200);
        const listed = await fetch(new URL(`/api/oauth/accounts?provider=${pooled.provider}`, server.url))
          .then(r => r.json()) as { activeAccountId: string };
        expect(listed.activeAccountId).toBe(ACCOUNT_B);

        // The ring now points at B. Peek first — resolving consumes the seeded sticky.
        expect(peekRoundRobinAccount(pooled.rotationKey, [ACCOUNT_A, ACCOUNT_B], 1)).toBe(ACCOUNT_B);

        // The previously bound session is no longer pinned to A.
        const rebound = resolveOAuthAccountForSession(pooled.provider, "session-1", config);
        expect(rebound.accountId).toBe(ACCOUNT_B);
        expect(rebound.reason).not.toBe("affinity");
      } finally {
        await server.stop(true);
      }
    });

    /**
     * The B case above cannot prove the ring was reseeded on its own: after one pick at
     * stickyLimit 1 the smooth-weight state already favours B, so the peek returns B
     * whether or not the route seeded anything. Switching to A — the account an unseeded
     * ring would NOT land on — is the assertion that actually discriminates.
     */
    test(`${pooled.provider}: switching to the account the ring would not pick reseeds it`, async () => {
      const config = pooled.config();
      saveConfig(config);
      writeAccounts(pooled.provider);

      const server = startServer(0);
      try {
        // One pick leaves the ring leaning towards B...
        pickRoundRobinAccount(pooled.rotationKey, [ACCOUNT_A, ACCOUNT_B], 1);
        expect(peekRoundRobinAccount(pooled.rotationKey, [ACCOUNT_A, ACCOUNT_B], 1)).toBe(ACCOUNT_B);

        // ...and the operator picks A anyway.
        const res = await fetch(new URL("/api/oauth/accounts/active", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: pooled.provider, accountId: ACCOUNT_A }),
        });
        expect(res.status).toBe(200);

        // The ring must follow the operator, not its own weights.
        expect(peekRoundRobinAccount(pooled.rotationKey, [ACCOUNT_A, ACCOUNT_B], 1)).toBe(ACCOUNT_A);
      } finally {
        await server.stop(true);
      }
    });
  }
});
