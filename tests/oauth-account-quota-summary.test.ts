import { describe, expect, test } from "bun:test";
import { buildAccountQuotaSummary } from "../src/oauth/account-quota-summary";

describe("account quota summary DTO", () => {
  test("separates credential readiness from quota capacity and exposes no secret-shaped fields", () => {
    const summary = buildAccountQuotaSummary([
      { accountId: "a", health: { status: "healthy" }, quota: { customWindows: [{ label: "Gem", percent: 100 }], updatedAt: 1 } },
      { accountId: "b", health: { status: "cooldown", until: new Date(2_000).toISOString(), reason: "quota" }, quota: null, unavailable: true },
      { accountId: "c", health: { status: "reauth_required", reason: "refresh_failed" }, quota: null },
      { accountId: "d", health: { status: "healthy" }, quota: null },
    ], "a", 1_000);
    expect(summary).toEqual({
      total: 4,
      activeAccountId: "a",
      ready: 2,
      coolingDown: 1,
      reauthRequired: 1,
      unavailable: 1,
      unknownQuota: 3,
      knownQuota: 1,
    });
    expect(Object.keys(summary).some(key => /token|project|raw|secret/i.test(key))).toBe(false);
  });

  test("does not turn stale or missing reset values into a future reset", () => {
    const summary = buildAccountQuotaSummary([
      { accountId: "a", health: { status: "healthy" }, quota: { weeklyPercent: 90, weeklyResetAt: 999, updatedAt: 1 } },
    ], "a", 1_000);
    expect(summary.nextResetAt).toBeUndefined();
  });
});
