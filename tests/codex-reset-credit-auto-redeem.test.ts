import { afterEach, describe, expect, test } from "bun:test";
import { ResetCreditAutoRedeemScheduler, type ResetCreditAutoRedeemIntent, type ResetCreditAutoRedeemState } from "../src/codex/reset-credit-auto-redeem";

const state: ResetCreditAutoRedeemState = { accountId: "acct-a", generation: "g1", available: 1, expiresAt: 1_000 };
const intents = new Map<string, ResetCreditAutoRedeemIntent>();
const schedulers: ResetCreditAutoRedeemScheduler[] = [];

afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.dispose(); intents.clear(); });

describe("pre-expiry reset-credit auto redemption", () => {
  test("is off by default and dispatches nothing", async () => {
    let refreshes = 0;
    let consumes = 0;
    const scheduler = new ResetCreditAutoRedeemScheduler({
      isEnabled: () => false,
      refreshAuthoritative: async () => { refreshes++; return state; },
      consume: async () => { consumes++; return "reset"; },
      now: () => 950,
    }, 100);
    schedulers.push(scheduler);
    scheduler.schedule(state);
    scheduler.recover(state.accountId);
    await Bun.sleep(10);
    expect(refreshes).toBe(0);
    expect(consumes).toBe(0);
  });

  test("refreshes authoritatively and refuses a changed generation", async () => {
    let consumes = 0;
    const scheduler = new ResetCreditAutoRedeemScheduler({
      isEnabled: () => true,
      refreshAuthoritative: async () => ({ ...state, generation: "g2" }),
      consume: async () => { consumes++; return "reset"; },
      now: () => 950,
    }, 100);
    schedulers.push(scheduler);
    scheduler.schedule(state);
    await Bun.sleep(20);
    expect(consumes).toBe(0);
  });

  test("concurrent recovery and timer share one idempotent consume", async () => {
    let refreshes = 0;
    let consumes = 0;
    const scheduler = new ResetCreditAutoRedeemScheduler({
      isEnabled: () => true,
      refreshAuthoritative: async () => { refreshes++; return state; },
      consume: async intent => { consumes++; expect(intent.operationId).toBeDefined(); await Bun.sleep(5); return "already_redeemed"; },
      saveIntent: intent => intents.set(intent.accountId, intent),
      loadIntent: accountId => intents.get(accountId) ?? null,
      clearIntent: intent => intents.delete(intent.accountId),
      now: () => 950,
    }, 100);
    schedulers.push(scheduler);
    scheduler.schedule(state);
    scheduler.recover(state.accountId);
    scheduler.recover(state.accountId);
    await Bun.sleep(30);
    expect(refreshes).toBe(1);
    expect(consumes).toBe(1);
    expect(intents.size).toBe(0);
  });
});
