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

  test("generation cancellation prevents a stale g1 flight from consuming after g2", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    let consumes = 0;
    const scheduler = new ResetCreditAutoRedeemScheduler({
      isEnabled: () => true,
      refreshAuthoritative: async accountId => {
        started();
        await gate;
        return { ...state, accountId, generation: "g1" };
      },
      consume: async () => { consumes++; return "reset"; },
      now: () => 950,
    }, 100);
    schedulers.push(scheduler);
    scheduler.schedule(state);
    scheduler.recover(state.accountId);
    await began;
    scheduler.schedule({ ...state, generation: "g2" });
    release();
    await Bun.sleep(20);
    expect(consumes).toBe(0);
  });

  test("dispose invalidates an in-flight refresh before consume", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let consumes = 0;
    const scheduler = new ResetCreditAutoRedeemScheduler({
      isEnabled: () => true,
      refreshAuthoritative: async () => { await gate; return state; },
      consume: async () => { consumes++; return "reset"; },
      now: () => 950,
    }, 100);
    scheduler.schedule(state);
    scheduler.recover(state.accountId);
    scheduler.dispose();
    release();
    await Bun.sleep(20);
    expect(consumes).toBe(0);
  });

  test("does not clear a newer persisted operation identity", async () => {
    const local = new Map<string, ResetCreditAutoRedeemIntent>();
    let cleared = 0;
    const scheduler = new ResetCreditAutoRedeemScheduler({
      isEnabled: () => true,
      refreshAuthoritative: async () => state,
      consume: async intent => {
        local.set(intent.accountId, { ...intent, operationId: "newer-operation" });
        return "reset";
      },
      saveIntent: intent => local.set(intent.accountId, intent),
      loadIntent: accountId => local.get(accountId) ?? null,
      clearIntent: () => { cleared++; },
      now: () => 950,
    }, 100);
    schedulers.push(scheduler);
    scheduler.schedule(state);
    scheduler.recover(state.accountId);
    await Bun.sleep(20);
    expect(cleared).toBe(0);
  });
});
