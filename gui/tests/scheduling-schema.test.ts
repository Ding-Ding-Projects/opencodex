/**
 * Bounds, validation and versioning for the stored scheduled-settings rule
 * list — the same "read defensively, validate down to nothing rather than
 * carry a bad value through" contract `readPrefs` follows in
 * `theme/prefs-context.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_RULES, PRIORITY_MAX, PRIORITY_MIN, REFRESH_MINUTES_MAX, REFRESH_MINUTES_MIN,
  newRuleId, readScheduleState, sanitizeScheduleValues, writeScheduleState,
} from "../src/scheduling/schema";
import { SCHEDULE_SCHEMA_VERSION } from "../src/scheduling/types";
import type { ScheduleRule, ScheduleState } from "../src/scheduling/types";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem: (key: string) => (key in store ? store[key]! : null),
    setItem: (key: string, value: string) => { store[key] = value; },
    raw: store,
  };
}

function validLocalRule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    id: newRuleId(),
    createdAt: Date.now(),
    label: "Evening dark mode",
    enabled: true,
    priority: 0,
    days: "everyday",
    source: { kind: "local", values: { theme: "dark" } },
    ...overrides,
  };
}

describe("round-tripping a valid rule", () => {
  test("a fully-populated local rule survives write then read unchanged", () => {
    const storage = memoryStorage();
    const rule = validLocalRule({
      startDate: "2026-01-01", endDate: "2026-12-31", startTime: "20:00", endTime: "06:00",
      priority: 7, days: [1, 3, 5],
      source: { kind: "local", values: { theme: "dark", seed: "#2F6B4F", density: 3, fontScale: 1.1, fontWeight: 500, locale: "yue", funnyEn: 4, funnyYue: 2 } },
    });
    writeScheduleState({ version: SCHEDULE_SCHEMA_VERSION, rules: [rule] }, storage);
    const read = readScheduleState(storage);
    expect(read.rules).toEqual([rule]);
  });

  test("an api rule and a homeAssistant rule both round-trip", () => {
    const storage = memoryStorage();
    const api: ScheduleRule = { id: newRuleId(), createdAt: 1, label: "API rule", enabled: true, priority: 0, days: "everyday", source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 30 } };
    const ha: ScheduleRule = { id: newRuleId(), createdAt: 2, label: "HA rule", enabled: false, priority: -3, days: [0, 6], source: { kind: "homeAssistant", baseUrl: "https://ha.example.com", entityId: "input_boolean.evening", tokenRef: "tok-1", values: { theme: "light" }, refreshMinutes: 5 } };
    writeScheduleState({ version: SCHEDULE_SCHEMA_VERSION, rules: [api, ha] }, storage);
    expect(readScheduleState(storage).rules).toEqual([api, ha]);
  });
});

describe("bounds and validation", () => {
  test("an unrecognised version resets to an empty, valid state", () => {
    const storage = memoryStorage({ "ocx-m3:schedule": JSON.stringify({ version: 999, rules: [validLocalRule()] }) });
    expect(readScheduleState(storage)).toEqual({ version: SCHEDULE_SCHEMA_VERSION, rules: [] });
  });

  test("missing, corrupt or non-object storage all yield an empty state", () => {
    expect(readScheduleState(memoryStorage())).toEqual({ version: SCHEDULE_SCHEMA_VERSION, rules: [] });
    expect(readScheduleState(memoryStorage({ "ocx-m3:schedule": "not json" }))).toEqual({ version: SCHEDULE_SCHEMA_VERSION, rules: [] });
    expect(readScheduleState(memoryStorage({ "ocx-m3:schedule": "42" }))).toEqual({ version: SCHEDULE_SCHEMA_VERSION, rules: [] });
    expect(readScheduleState(memoryStorage({ "ocx-m3:schedule": JSON.stringify({ version: 1, rules: "not an array" }) }))).toEqual({ version: SCHEDULE_SCHEMA_VERSION, rules: [] });
  });

  test("a rule missing a required field is dropped, not carried through half-valid", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [{ id: "x", createdAt: 1, /* no label */ enabled: true, priority: 0, days: "everyday", source: { kind: "local", values: {} } }],
      }),
    });
    expect(readScheduleState(storage).rules).toEqual([]);
  });

  test("more than MAX_RULES rules are truncated on read and on write", () => {
    const many = Array.from({ length: MAX_RULES + 20 }, (_, i) => validLocalRule({ id: `r${i}`, createdAt: i }));
    const storage = memoryStorage();
    writeScheduleState({ version: SCHEDULE_SCHEMA_VERSION, rules: many }, storage);
    expect(JSON.parse(storage.raw["ocx-m3:schedule"]!).rules).toHaveLength(MAX_RULES);
    expect(readScheduleState(storage).rules).toHaveLength(MAX_RULES);
  });

  test("priority is clamped to [PRIORITY_MIN, PRIORITY_MAX]", () => {
    const storage = memoryStorage();
    writeScheduleState({
      version: SCHEDULE_SCHEMA_VERSION,
      rules: [validLocalRule({ id: "over", priority: PRIORITY_MAX + 500 }), validLocalRule({ id: "under", priority: PRIORITY_MIN - 500 })],
    }, storage);
    const [over, under] = readScheduleState(storage).rules;
    expect(over!.priority).toBe(PRIORITY_MAX);
    expect(under!.priority).toBe(PRIORITY_MIN);
  });

  test("an api rule's refreshMinutes is clamped to [REFRESH_MINUTES_MIN, REFRESH_MINUTES_MAX]", () => {
    const storage = memoryStorage();
    const rule: ScheduleRule = { id: "a", createdAt: 1, label: "x", enabled: true, priority: 0, days: "everyday", source: { kind: "api", url: "https://example.com", refreshMinutes: 999999 } };
    writeScheduleState({ version: SCHEDULE_SCHEMA_VERSION, rules: [rule] }, storage);
    const read = readScheduleState(storage).rules[0]!;
    expect(read.source.kind).toBe("api");
    if (read.source.kind === "api") expect(read.source.refreshMinutes).toBe(REFRESH_MINUTES_MAX);
  });

  test("a plain HTTP api URL (not loopback) is refused; loopback HTTP is accepted", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [
          { id: "insecure", createdAt: 1, label: "x", enabled: true, priority: 0, days: "everyday", source: { kind: "api", url: "http://example.com/schedule.json", refreshMinutes: 15 } },
          { id: "loopback", createdAt: 2, label: "y", enabled: true, priority: 0, days: "everyday", source: { kind: "api", url: "http://127.0.0.1:8080/schedule.json", refreshMinutes: 15 } },
        ],
      }),
    });
    const rules = readScheduleState(storage).rules;
    expect(rules.map(r => r.id)).toEqual(["loopback"]);
  });

  test("a URL carrying embedded credentials is refused", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [{ id: "x", createdAt: 1, label: "x", enabled: true, priority: 0, days: "everyday", source: { kind: "api", url: "https://user:pass@example.com/schedule.json", refreshMinutes: 15 } }],
      }),
    });
    expect(readScheduleState(storage).rules).toEqual([]);
  });

  test("a malformed Home Assistant entity id is refused", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [{ id: "x", createdAt: 1, label: "x", enabled: true, priority: 0, days: "everyday", source: { kind: "homeAssistant", baseUrl: "https://ha.local", entityId: "not-a-valid-entity-id", tokenRef: "tok", values: {}, refreshMinutes: 15 } }],
      }),
    });
    expect(readScheduleState(storage).rules).toEqual([]);
  });

  test("an invalid calendar date (e.g. Feb 30) is dropped rather than silently rolled forward", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [{ id: "x", createdAt: 1, label: "x", enabled: true, priority: 0, days: "everyday", startDate: "2026-02-30", source: { kind: "local", values: {} } }],
      }),
    });
    expect(readScheduleState(storage).rules[0]!.startDate).toBeUndefined();
  });

  test("duplicate weekdays are de-duplicated and sorted", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [{ id: "x", createdAt: 1, label: "x", enabled: true, priority: 0, days: [5, 1, 1, 3], source: { kind: "local", values: {} } }],
      }),
    });
    expect(readScheduleState(storage).rules[0]!.days).toEqual([1, 3, 5]);
  });

  test("an out-of-range weekday number is dropped from the set", () => {
    const storage = memoryStorage({
      "ocx-m3:schedule": JSON.stringify({
        version: 1,
        rules: [{ id: "x", createdAt: 1, label: "x", enabled: true, priority: 0, days: [1, 9, -1], source: { kind: "local", values: {} } }],
      }),
    });
    expect(readScheduleState(storage).rules[0]!.days).toEqual([1]);
  });
});

describe("sanitizeScheduleValues — the same bounds a rule's local values get, reused for a network response", () => {
  test("drops unknown fields and out-of-range discrete values", () => {
    expect(sanitizeScheduleValues({
      theme: "purple", density: 99, funnyEn: 0, locale: "klingon",
      seed: "#2F6B4F", extra: "not a real field",
    })).toEqual({ seed: "#2F6B4F" });
  });

  test("clamps continuous values (font scale/weight) rather than dropping them", () => {
    expect(sanitizeScheduleValues({ fontScale: 50, fontWeight: -10 })).toEqual({ fontScale: 1.6, fontWeight: 300 });
  });

  test("keeps every real field when all are valid", () => {
    expect(sanitizeScheduleValues({
      theme: "dark", seed: "#123", density: 2, fontId: "roboto-flex", fontStack: "'Roboto Flex', sans-serif",
      fontScale: 1.2, fontWeight: 600, locale: "bi", funnyEn: 5, funnyYue: 1,
    })).toEqual({
      theme: "dark", seed: "#123", density: 2, fontId: "roboto-flex", fontStack: "'Roboto Flex', sans-serif",
      fontScale: 1.2, fontWeight: 600, locale: "bi", funnyEn: 5, funnyYue: 1,
    });
  });

  test("a non-object input yields no values at all", () => {
    expect(sanitizeScheduleValues(null)).toEqual({});
    expect(sanitizeScheduleValues("theme:dark")).toEqual({});
    expect(sanitizeScheduleValues(42)).toEqual({});
  });
});

describe("newRuleId", () => {
  test("produces a stable-looking, unique-per-call identifier", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRuleId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^sched-[a-z0-9]+-[a-z0-9]+$/);
  });
});
