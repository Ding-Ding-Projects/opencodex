/**
 * Pure "is this rule active right now" matching, and the precedence rule that
 * decides which of several matching rules wins.
 *
 * Everything here takes a `Date` and returns a value — no `localStorage`, no
 * timers, no network — so the semantics the contract requires (cross-midnight
 * windows, date boundaries, equal start/end, empty schedules, weekday vs.
 * every day) can be pinned with plain unit tests against constructed `Date`
 * instants, in `gui/tests/scheduling-match.test.ts`.
 *
 * All arithmetic here uses the JS `Date` object's *local* getters/constructor
 * arguments — `getDay()`, `getFullYear()`, `new Date(y, m, d, hh, mm)` — never
 * UTC or raw millisecond offsets. That is what makes it automatically follow
 * "the user's configured local timezone" (whatever the OS/browser resolves
 * that to) and stay correct across a DST transition: asking for "day D at
 * 22:00" always means the wall-clock instant a person would call 22:00 on day
 * D, however many real hours away the *previous* wall-clock instant was.
 */

import type { ScheduleDays, ScheduleRule, Weekday } from "./types";

/**
 * The local IANA zone name (when the runtime can report one) and the current
 * UTC offset, formatted for the "rules use your local timezone" disclosure
 * the contract requires on the schedule editor.
 */
export function timezoneInfo(now: Date = new Date()): { tz: string; offset: string } {
  let tz = "UTC";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* Some embedded/test environments have no Intl.DateTimeFormat support. */
  }
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return { tz, offset: `${sign}${hh}:${mm}` };
}

function dateKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shifts by whole calendar days, letting `Date` normalize month/year rollover. */
function shiftDays(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
}

function minutesOfTime(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * The effective `[start, end)` window for one calendar day, in minutes past
 * that day's local midnight. `end` may exceed 1440 — that is how a
 * cross-midnight window is expressed: it continues into the next calendar day.
 *
 * None of these readings are the only plausible one, so they are spelled out
 * and pinned by tests rather than left to fall out of the arithmetic:
 *
 *  - neither time set          -> the whole day, `[0, 1440)`
 *  - only a start time         -> from that time to the end of the day
 *  - only an end time          -> from the start of the day to that time
 *  - start time equals end time -> the whole day (a zero-width window would
 *    be useless to anyone, and "all day" is what most scheduling tools mean
 *    by "same time to same time")
 *  - start time is after end time -> crosses midnight into the next day
 */
export function ruleWindowMinutes(rule: Pick<ScheduleRule, "startTime" | "endTime">): { start: number; end: number } {
  const hasStart = typeof rule.startTime === "string";
  const hasEnd = typeof rule.endTime === "string";
  if (!hasStart && !hasEnd) return { start: 0, end: 1440 };
  if (hasStart && !hasEnd) return { start: minutesOfTime(rule.startTime!), end: 1440 };
  if (!hasStart && hasEnd) return { start: 0, end: minutesOfTime(rule.endTime!) };
  const start = minutesOfTime(rule.startTime!);
  const end = minutesOfTime(rule.endTime!);
  if (end === start) return { start: 0, end: 1440 };
  if (end > start) return { start, end };
  return { start, end: end + 1440 };
}

function dayMatches(days: ScheduleDays, weekday: Weekday): boolean {
  if (days === "everyday") return true;
  return days.includes(weekday);
}

function withinDateRange(rule: Pick<ScheduleRule, "startDate" | "endDate">, key: string): boolean {
  if (rule.startDate && key < rule.startDate) return false;
  if (rule.endDate && key > rule.endDate) return false;
  return true;
}

/**
 * Whether `rule` is active at the instant `now`.
 *
 * Checked against two candidate anchor days — today and yesterday — because a
 * cross-midnight window that started yesterday can still be active after
 * midnight today. The date range and day-of-week conditions are evaluated
 * against the *anchor* day (the day the window starts on), never against
 * `now`'s own calendar day: a Monday-only rule with a 22:00–06:00 window is
 * active from Monday 22:00 through Tuesday 06:00, even though part of that
 * span falls on a Tuesday the rule never separately selected.
 *
 * An explicit, empty weekday set (`days: []` — every box unticked, "every
 * day" not chosen either) can never match; that is the empty-schedule case
 * the contract asks to have defined rather than guessed at.
 */
export function ruleActiveAt(rule: ScheduleRule, now: Date = new Date()): boolean {
  if (Array.isArray(rule.days) && rule.days.length === 0) return false;
  const { start, end } = ruleWindowMinutes(rule);
  for (const anchorOffset of [0, -1] as const) {
    const anchor = shiftDays(now, anchorOffset);
    const key = dateKeyLocal(anchor);
    if (!withinDateRange(rule, key)) continue;
    if (!dayMatches(rule.days, anchor.getDay() as Weekday)) continue;
    const windowStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 0, start);
    const windowEnd = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 0, end);
    if (now.getTime() >= windowStart.getTime() && now.getTime() < windowEnd.getTime()) return true;
  }
  return false;
}

/**
 * Every enabled, time-matching rule, ordered by precedence: highest
 * `priority` first; a tie broken by whichever rule was created more
 * recently (`createdAt`). Deterministic — the same set of rules and the same
 * instant always resolve to the same ordering — and it is exactly the
 * sentence `schedule.precedenceNote` puts in front of the user, so the UI and
 * the runtime can never disagree about who is "in charge" right now.
 *
 * The full ordering (not just the winner) is what lets the runtime cascade
 * past a rule whose remote source says "not right now" (a Home Assistant
 * entity reading `off`) to the next-best matching rule, per the contract's
 * "off... leaves the local base settings or *another matching rule* in
 * effect".
 */
export function matchingRulesByPrecedence(rules: readonly ScheduleRule[], now: Date = new Date()): ScheduleRule[] {
  return rules
    .filter(rule => rule.enabled && ruleActiveAt(rule, now))
    .sort((a, b) => (b.priority - a.priority) || (b.createdAt - a.createdAt));
}

/**
 * The rule that wins when more than one enabled rule matches `now`, ignoring
 * whether its remote source (if it has one) actually confirms — this is pure
 * time-and-priority precedence. See `matchingRulesByPrecedence` for the
 * ordering rule stated in full, and `scheduling/runtime.ts` for how a remote
 * source's own "not right now" answer can still fall through to the next
 * entry in that ordering.
 */
export function pickActiveRule(rules: readonly ScheduleRule[], now: Date = new Date()): ScheduleRule | null {
  return matchingRulesByPrecedence(rules, now)[0] ?? null;
}
