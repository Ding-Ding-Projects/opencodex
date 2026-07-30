import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import {
  clearOAuthPoolState,
  getEligibleOAuthAccounts,
  isOAuthPoolEnabled,
  oauthPoolConfig,
  resolveOAuthAccountForSession,
  rotateOAuthAccountOn429,
} from "../src/oauth/provider-pool";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { clearAccountQuotaCache } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * The generic OAuth pool ("auto account switcher for all providers, like the
 * Codex pool"). Anthropic's 21 behavioural tests exercise the shared engine
 * through its facade; what this file pins is the generalization itself:
 * per-provider config resolution, per-provider state isolation, and the
 * default-off posture for every provider.
 */

const PROVIDER = "xai";
const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearOAuthPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
});

afterEach(() => {
  clearOAuthPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTempDir(home);
});

function configWithPool(enabled: boolean): OcxConfig {
  return {
    providers: {
      [PROVIDER]: { adapter: "openai", authMode: "oauth", accountPool: { enabled } },
    },
  } as unknown as OcxConfig;
}

async function seedTwoAccounts(): Promise<{ idA: string; idB: string }> {
  await saveCredential(PROVIDER, {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential(PROVIDER, {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  const set = getAccountSet(PROVIDER)!;
  const idA = set.accounts.find(a => a.credential.accountId === "uuid-aaaa")!.id;
  const idB = set.accounts.find(a => a.credential.accountId === "uuid-bbbb")!.id;
  await setActiveAccount(PROVIDER, idA);
  return { idA, idB };
}

describe("per-provider pool config", () => {
  test("non-anthropic providers read providers[<name>].accountPool", () => {
    expect(isOAuthPoolEnabled(configWithPool(true), PROVIDER)).toBe(true);
    expect(isOAuthPoolEnabled(configWithPool(false), PROVIDER)).toBe(false);
  });

  test("default is OFF for every provider — absent config means no pool", () => {
    const config = { providers: { [PROVIDER]: { adapter: "openai", authMode: "oauth" } } } as unknown as OcxConfig;
    expect(isOAuthPoolEnabled(config, PROVIDER)).toBe(false);
    expect(oauthPoolConfig(config, PROVIDER)).toEqual({});
  });

  test("anthropic keeps its historical config home, not providers[].accountPool", () => {
    const config = {
      anthropicAccountPool: { enabled: true },
      providers: { anthropic: { adapter: "anthropic", authMode: "oauth", accountPool: { enabled: false } } },
    } as unknown as OcxConfig;
    expect(isOAuthPoolEnabled(config, "anthropic")).toBe(true);
  });
});

describe("generic selection and failover", () => {
  test("pool disabled always returns the store's active account", async () => {
    const { idA } = await seedTwoAccounts();
    const selection = resolveOAuthAccountForSession(PROVIDER, "session-1", configWithPool(false));
    expect(selection).toEqual({ accountId: idA, reason: "pool-disabled" });
  });

  test("429 cools the failed account and fails over to the sibling", async () => {
    const { idA, idB } = await seedTwoAccounts();
    const config = configWithPool(true);

    const next = rotateOAuthAccountOn429(config, PROVIDER, idA, "30", "session-1");
    expect(next).toBe(idB);
    // The cooled account drops out of eligibility until the cooldown lapses.
    expect(getEligibleOAuthAccounts(PROVIDER)).toEqual([idB]);
    // The session that hit the 429 is re-affined to the survivor.
    const selection = resolveOAuthAccountForSession(PROVIDER, "session-1", config);
    expect(selection).toEqual({ accountId: idB, reason: "affinity" });
  });

  test("state is isolated per provider — cooling xai leaves anthropic untouched", async () => {
    const { idA } = await seedTwoAccounts();
    rotateOAuthAccountOn429(configWithPool(true), PROVIDER, idA, "30", null);
    // Same account id under a different provider key is not cooled.
    expect(getEligibleOAuthAccounts("anthropic")).toEqual([]);
    const anthropicHealthUnaffected = resolveOAuthAccountForSession("anthropic", null, configWithPool(true));
    expect(anthropicHealthUnaffected.reason).toBe("none");
  });

  test("all accounts cooled reports all-cooled instead of picking a dead account", async () => {
    const { idA, idB } = await seedTwoAccounts();
    const config = configWithPool(true);
    rotateOAuthAccountOn429(config, PROVIDER, idA, "30", null);
    rotateOAuthAccountOn429(config, PROVIDER, idB, "30", null);
    const selection = resolveOAuthAccountForSession(PROVIDER, "session-2", config);
    expect(selection).toEqual({ accountId: null, reason: "all-cooled" });
  });
});
