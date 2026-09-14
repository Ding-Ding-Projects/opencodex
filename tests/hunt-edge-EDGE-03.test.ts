import { afterAll, describe, expect, test } from "bun:test";
import { summarizeUsage } from "../src/usage/summary";
import type { PersistedUsageEntry } from "../src/usage/log";

/**
 * EDGE-03: `buildDayGrid` in `src/usage/summary.ts` (private helper, backing
 * the exported `summarizeUsage`) pre-populates a day's worth of grid buckets
 * with a FIXED 24-hour stride:
 *
 *   for (let i = days - 1; i >= 0; i--) {
 *     const key = localDateKey(now - i * DAY_MS);
 *     grid.set(key, { date: key, ... });
 *   }
 *
 * where `DAY_MS = 86_400_000` (exactly 24h) and `localDateKey` reads the
 * HOST'S LOCAL calendar date (`getFullYear`/`getMonth`/`getDate`, not UTC).
 * A civil day is not always 24 hours in a timezone that observes DST: the
 * "fall back" day is 25 hours long. Walking backward from `now` in fixed
 * 24h jumps across that 25-hour day does not fully cross it, so two
 * different loop iterations (`i` values) land on the SAME local calendar
 * date, `grid.set` collapses them into one Map entry, and the grid ends up
 * with one FEWER unique calendar day than the range promises: a "7d" summary
 * returns 6 days, silently dropping the oldest one (here 2025-10-27) instead
 * of showing it as an empty/zero day.
 *
 * Confirmed concretely (not just by reading the source) with a standalone
 * reimplementation swept across every UTC hour around the US fall-back
 * transition (2025-11-02, when America/New_York goes from EDT to EST): with
 * `now = 2025-11-03T04:17:00Z` (2025-11-02 23:17 local), the 7-day walk
 * produces `2025-10-28 .. 2025-11-02` with `2025-11-02` repeated and
 * `2025-10-27` never generated at all.
 *
 * This test drives the real exported `summarizeUsage` (not a reimplementation)
 * with `TZ=America/New_York`, `range: "7d"`, that exact `now`, and zero usage
 * entries, and checks `result.days.length`. It is a finder-authored
 * regression test (`hunt/edge-cases` lane); it does not fix anything.
 */

const previousTz = process.env.TZ;
process.env.TZ = "America/New_York";

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("EDGE-03: summarizeUsage day grid across a DST fall-back boundary", () => {
  test("control: an ordinary 7d window (no DST transition in range) yields exactly 7 days", () => {
    // A week fully inside standard time, nowhere near a transition.
    const now = new Date("2025-11-20T04:17:00Z").getTime();
    const result = summarizeUsage([], "7d", now, "all");
    expect(result.days).toHaveLength(7);
    expect(new Set(result.days.map(d => d.date)).size).toBe(7);
  });

  test("a 7d window straddling the US fall-back transition silently loses a day", () => {
    const entries: PersistedUsageEntry[] = [];
    const now = new Date("2025-11-03T04:17:00Z").getTime(); // 2025-11-02 23:17 America/New_York
    const result = summarizeUsage(entries, "7d", now, "all");

    // The range promises 7 calendar days ending "today" (2025-11-02 local):
    // 2025-10-27, 10-28, 10-29, 10-30, 10-31, 11-01, 11-02. The fixed 24h
    // stride collapses 11-02 with itself and never generates 10-27 at all,
    // so only 6 buckets exist instead of 7.
    const dates = result.days.map(d => d.date);
    expect(dates).toContain("2025-10-27");
    expect(result.days).toHaveLength(7);
  });
});
