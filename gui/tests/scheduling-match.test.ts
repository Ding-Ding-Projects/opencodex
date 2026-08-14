/**
 * Pure matching/precedence semantics for scheduled-settings rules: exactly
 * the cases the contract calls out by name — cross-midnight windows, date
 * boundaries, equal start/end, every-day vs. explicit weekdays, empty
 * schedules, and two rules colliding on precedence.
 */

import { describe, expect, test } from "bun:test";
import { matchingRulesByPrecedence, pickActiveRule, ruleActiveAt, ruleWindowMinutes, timezoneInfo } from "../src/scheduling/match";
import type { ScheduleRule } from "../src/scheduling/types";

let seq = 0;
function rule(partial: Partial<ScheduleRule>): ScheduleRule {
  seq += 1;
  return {
    id: `r${seq}`,
    createdAt: seq,
    label: `rule ${seq}`,
    enabled: true,
    priority: 0,
    days: "everyday",
    source: { kind: "local", values: {} },
    ...partial,
  };
}

/** Local-time constructor so every test is explicit about which wall clock it means. */
function at(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

describe("ruleWindowMinutes — the six explicit readings", () => {
  test("neither time set is the whole day", () => {
    expect(ruleWindowMinutes({})).toEqual({ start: 0, end: 1440 });
  });
  test("only a start time runs to the end of the day", () => {
    expect(ruleWindowMinutes({ startTime: "20:00" })).toEqual({ start: 1200, end: 1440 });
  });
  test("only an end time runs from the start of the day", () => {
    expect(ruleWindowMinutes({ endTime: "08:00" })).toEqual({ start: 0, end: 480 });
  });
  test("equal start and end means the whole day", () => {
    expect(ruleWindowMinutes({ startTime: "09:00", endTime: "09:00" })).toEqual({ start: 0, end: 1440 });
  });
  test("start before end is an ordinary same-day window", () => {
    expect(ruleWindowMinutes({ startTime: "09:00", endTime: "17:00" })).toEqual({ start: 540, end: 1020 });
  });
  test("start after end crosses midnight into the next day", () => {
    expect(ruleWindowMinutes({ startTime: "22:00", endTime: "06:00" })).toEqual({ start: 1320, end: 1800 });
  });
});

describe("ruleActiveAt — cross-midnight windows", () => {
  test("matches before midnight, on the start day", () => {
    const r = rule({ days: [1], startTime: "22:00", endTime: "06:00" }); // Monday
    expect(ruleActiveAt(r, at(2026, 8, 17, 23, 0))).toBe(true); // Monday 23:00
  });
  test("matches after midnight, on the day the window rolled into", () => {
    const r = rule({ days: [1], startTime: "22:00", endTime: "06:00" }); // Monday
    expect(ruleActiveAt(r, at(2026, 8, 18, 3, 0))).toBe(true); // Tuesday 03:00
  });
  test("does not match once the window has closed the next morning", () => {
    const r = rule({ days: [1], startTime: "22:00", endTime: "06:00" });
    expect(ruleActiveAt(r, at(2026, 8, 18, 6, 0))).toBe(false); // exactly 06:00 Tuesday — end is exclusive
    expect(ruleActiveAt(r, at(2026, 8, 18, 7, 0))).toBe(false);
  });
  test("does not match on an unrelated day even inside the same clock hours", () => {
    const r = rule({ days: [1], startTime: "22:00", endTime: "06:00" }); // only Monday nights
    expect(ruleActiveAt(r, at(2026, 8, 19, 23, 0))).toBe(false); // Wednesday 23:00
  });
  test("an everyday cross-midnight window matches every night", () => {
    const r = rule({ days: "everyday", startTime: "22:00", endTime: "06:00" });
    expect(ruleActiveAt(r, at(2026, 8, 20, 2, 0))).toBe(true);
  });
});

describe("ruleActiveAt — date boundaries", () => {
  test("inclusive of the start date", () => {
    const r = rule({ startDate: "2026-08-17" });
    expect(ruleActiveAt(r, at(2026, 8, 17, 0, 0))).toBe(true);
    expect(ruleActiveAt(r, at(2026, 8, 16, 23, 59))).toBe(false);
  });
  test("inclusive of the end date", () => {
    const r = rule({ endDate: "2026-08-17" });
    expect(ruleActiveAt(r, at(2026, 8, 17, 23, 59))).toBe(true);
    expect(ruleActiveAt(r, at(2026, 8, 18, 0, 0))).toBe(false);
  });
  test("an open-ended start date matches from that day onward indefinitely", () => {
    const r = rule({ startDate: "2026-08-17" });
    expect(ruleActiveAt(r, at(2030, 1, 1))).toBe(true);
  });
  test("a cross-midnight window is bounded by the date range on its own (start) day", () => {
    // endDate is 8-17: the Monday-night window that starts on the 17th and
    // rolls into the 18th is still allowed, because the anchor day (the 17th,
    // where the window *starts*) is within range — even though part of the
    // window falls on the 18th, which is outside it.
    const r = rule({ endDate: "2026-08-17", startTime: "22:00", endTime: "06:00" });
    expect(ruleActiveAt(r, at(2026, 8, 18, 3, 0))).toBe(true);
    // But a window that would only *start* on the 18th is excluded outright.
    expect(ruleActiveAt(r, at(2026, 8, 18, 23, 0))).toBe(false);
  });
});

describe("ruleActiveAt — equal start and end", () => {
  test("reads as the whole day on every matching day, and only that day", () => {
    const r = rule({ days: [3], startTime: "09:00", endTime: "09:00" }); // Wednesday only
    expect(ruleActiveAt(r, at(2026, 8, 19, 0, 0))).toBe(true); // Wed 00:00
    expect(ruleActiveAt(r, at(2026, 8, 19, 23, 59))).toBe(true); // Wed 23:59
    expect(ruleActiveAt(r, at(2026, 8, 20, 0, 1))).toBe(false); // Thu 00:01 — did not spill over
  });
});

describe("ruleActiveAt — every day vs. an explicit weekday set", () => {
  test("everyday matches regardless of weekday", () => {
    const r = rule({ days: "everyday" });
    for (let d = 17; d <= 23; d += 1) expect(ruleActiveAt(r, at(2026, 8, d, 12, 0)), `day ${d}`).toBe(true);
  });
  test("an explicit weekday set matches only those weekdays", () => {
    const r = rule({ days: [1, 3, 5] }); // Mon/Wed/Fri
    expect(ruleActiveAt(r, at(2026, 8, 17, 12, 0))).toBe(true); // Monday
    expect(ruleActiveAt(r, at(2026, 8, 18, 12, 0))).toBe(false); // Tuesday
    expect(ruleActiveAt(r, at(2026, 8, 19, 12, 0))).toBe(true); // Wednesday
  });
});

describe("ruleActiveAt — empty schedules", () => {
  test("an explicit, empty weekday set never matches, at any time", () => {
    const r = rule({ days: [] });
    expect(ruleActiveAt(r, at(2026, 8, 17, 12, 0))).toBe(false);
    expect(ruleActiveAt(r, at(2026, 8, 18, 0, 0))).toBe(false);
  });
  test("a rule with no time restriction and every day matches at any instant", () => {
    const r = rule({});
    expect(ruleActiveAt(r, at(2026, 1, 1, 0, 0))).toBe(true);
    expect(ruleActiveAt(r, at(2099, 12, 31, 23, 59))).toBe(true);
  });
  test("an end-time-only window of exactly 00:00 is a zero-width window that never matches", () => {
    // Explicit, tested rather than guessed: "up to 00:00" with no start is the
    // very first instant of the day, which is a window nothing can fall inside.
    const r = rule({ endTime: "00:00" });
    expect(ruleActiveAt(r, at(2026, 8, 17, 0, 0))).toBe(false);
    expect(ruleActiveAt(r, at(2026, 8, 17, 0, 1))).toBe(false);
  });
});

describe("precedence — two (or more) rules colliding", () => {
  test("higher priority wins regardless of creation order", () => {
    const low = rule({ priority: 1, label: "low" });
    const high = rule({ priority: 5, label: "high" });
    expect(pickActiveRule([low, high])?.label).toBe("high");
    expect(pickActiveRule([high, low])?.label).toBe("high");
  });
  test("a tie in priority goes to the more recently created rule", () => {
    const older = rule({ priority: 3, createdAt: 100, label: "older" });
    const newer = rule({ priority: 3, createdAt: 200, label: "newer" });
    expect(pickActiveRule([older, newer])?.label).toBe("newer");
    expect(pickActiveRule([newer, older])?.label).toBe("newer");
  });
  test("a disabled rule never wins even with the highest priority", () => {
    const disabled = rule({ priority: 100, enabled: false, label: "disabled" });
    const enabled = rule({ priority: 1, label: "enabled" });
    expect(pickActiveRule([disabled, enabled])?.label).toBe("enabled");
  });
  test("a rule that does not match right now never wins", () => {
    const notNow = rule({ priority: 100, days: [], label: "not now" }); // empty days: never matches
    const now = rule({ priority: 1, label: "now" });
    expect(pickActiveRule([notNow, now])?.label).toBe("now");
  });
  test("no matching rule returns null", () => {
    expect(pickActiveRule([rule({ days: [] })])).toBeNull();
    expect(pickActiveRule([])).toBeNull();
  });
  test("matchingRulesByPrecedence returns the full ordering, not just the winner", () => {
    const a = rule({ priority: 1, label: "a" });
    const b = rule({ priority: 5, label: "b" });
    const c = rule({ priority: 3, label: "c" });
    const ordered = matchingRulesByPrecedence([a, b, c]);
    expect(ordered.map(r => r.label)).toEqual(["b", "c", "a"]);
  });
  test("resolution is deterministic across repeated calls with the same input", () => {
    const rules = [rule({ priority: 2 }), rule({ priority: 2 }), rule({ priority: 5 })];
    const now = at(2026, 8, 17, 12, 0);
    const first = pickActiveRule(rules, now)?.id;
    const second = pickActiveRule(rules, now)?.id;
    expect(first).toBe(second);
  });
});

describe("timezoneInfo", () => {
  test("reports a zone name and a UTC offset in the ±HH:MM shape", () => {
    const info = timezoneInfo(new Date());
    expect(typeof info.tz).toBe("string");
    expect(info.tz.length).toBeGreaterThan(0);
    expect(info.offset).toMatch(/^[+-]\d{2}:\d{2}$/);
  });
});
