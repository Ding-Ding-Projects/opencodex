import { describe, expect, test } from "bun:test";
import { usageSummaryExpiresAt } from "../src/server/management/logs-usage-routes";
import { summarizeUsage, type UsageRange } from "../src/usage/summary";
import type { PersistedUsageEntry } from "../src/usage/log";

const DAY_MS = 24 * 60 * 60 * 1000;

function entryAt(timestamp: number): PersistedUsageEntry {
  return {
    requestId: "req-1",
    timestamp,
    provider: "custom",
    model: "test-model",
    usageStatus: "reported",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

/**
 * The invariant, not the constant: the cached summary must expire at exactly
 * the instant the oldest row stops being counted. Asserting the `+1` alone
 * would pin an implementation detail; asserting the agreement with
 * summarizeUsage() pins the thing that actually has to be true.
 */
describe("usage summary cache boundary", () => {
  for (const [range, windowMs] of [["7d", 7 * DAY_MS], ["30d", 30 * DAY_MS]] as const) {
    test(`${range}: the cache expires exactly when the oldest row stops counting`, () => {
      const timestamp = Date.UTC(2026, 6, 1, 12, 0, 0);
      const entries = [entryAt(timestamp)];
      // Ask at the instant the row is at the very edge of the window, and make
      // the fallback (next local midnight) far enough away that it cannot be
      // mistaken for the row-derived bound.
      const now = timestamp + windowMs;

      // The row IS still counted at `now` — summarizeUsage's cutoff is inclusive.
      const atBoundary = summarizeUsage(entries, range as UsageRange, now, "all");
      expect(atBoundary.summary.inputTokens).toBe(100);

      // ...and is NOT counted one millisecond later.
      const pastBoundary = summarizeUsage(entries, range as UsageRange, now + 1, "all");
      expect(pastBoundary.summary.inputTokens).toBe(0);

      // So the cache must expire at exactly `now + 1`, never later. Before the
      // fix this returned the next local midnight, and the overcounted total
      // was served until then.
      expect(usageSummaryExpiresAt(entries, range as UsageRange, "all", now)).toBe(now + 1);
    });
  }

  test("a row already outside the window contributes no bound", () => {
    const timestamp = Date.UTC(2026, 6, 1, 12, 0, 0);
    const entries = [entryAt(timestamp)];
    // One ms past eligibility: the row cannot expire again, so the only bound
    // left is the next local midnight — which is strictly in the future.
    const now = timestamp + 7 * DAY_MS + 1;
    expect(summarizeUsage(entries, "7d", now, "all").summary.inputTokens).toBe(0);
    expect(usageSummaryExpiresAt(entries, "7d", "all", now)).toBeGreaterThan(now);
  });

  test("the unbounded range never derives an expiry from a row", () => {
    const timestamp = Date.UTC(2026, 6, 1, 12, 0, 0);
    const now = timestamp + DAY_MS;
    // "all" has no rolling window, so no row can fall out of it.
    const midnight = usageSummaryExpiresAt([], "all", "all", now);
    expect(usageSummaryExpiresAt([entryAt(timestamp)], "all", "all", now)).toBe(midnight);
  });
});
