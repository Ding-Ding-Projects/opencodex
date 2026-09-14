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

/**
 * Additional coverage added while repairing EDGE-03. The fall-back case above proves the
 * fixed 24h stride can collide two iterations onto the same calendar date. The two cases
 * below check the opposite-direction transition (spring-forward) and a longer 30-day range
 * that spans a transition, so the calendar-day walk in the repair is verified in both
 * directions and at both supported range sizes, not just the one combination the finder
 * happened to reproduce first.
 */
describe("EDGE-03: summarizeUsage day grid across a DST spring-forward boundary and a 30d range", () => {
  test("a 7d window straddling the US spring-forward transition keeps the transition day", () => {
    // 2026-03-08 is the US spring-forward date in America/New_York (a 23-hour civil day,
    // EST -05:00 to EDT -04:00 at 2am local). The fixed 24h stride does not collide two
    // iterations onto the same date the way it does across a fall-back: a shortened civil
    // day instead pushes the next step's local time earlier by an extra hour. For a step
    // that lands just after local midnight, that extra hour is enough to walk backward
    // across the whole shortened day: the pre-fix grid silently skips 2026-03-08 entirely
    // and reaches one calendar day further into the past (2026-03-02) than the 7-day
    // window promises, while the day count still reads 7.
    const entries: PersistedUsageEntry[] = [];
    const now = new Date("2026-03-09T04:00:00Z").getTime(); // 2026-03-09 00:00 America/New_York
    const result = summarizeUsage(entries, "7d", now, "all");
    const dates = result.days.map(d => d.date);
    expect(dates).toEqual([
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
    expect(result.days).toHaveLength(7);
  });

  test("a 30d window spanning the US fall-back transition still yields 30 distinct calendar days", () => {
    // Same "now" as the fall-back case above, but over the full 30-day range instead of
    // 7d, so the walk runs through many more fixed-24h steps before it ever reaches the
    // collision at the transition itself. The pre-fix grid drops the oldest promised day
    // (2025-10-04) the same way it drops 2025-10-27 in the 7d case, leaving only 29
    // distinct entries instead of 30.
    const entries: PersistedUsageEntry[] = [];
    const now = new Date("2025-11-03T04:17:00Z").getTime(); // 2025-11-02 23:17 America/New_York
    const result = summarizeUsage(entries, "30d", now, "all");
    const dates = result.days.map(d => d.date);
    expect(dates).toContain("2025-10-04");
    expect(result.days).toHaveLength(30);
    expect(new Set(dates).size).toBe(30);
  });
});
