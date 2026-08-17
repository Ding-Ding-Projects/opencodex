/**
 * `resolveScheduleTick` — the per-tick resolution step: which rule wins by
 * time/priority, and (walking down that order) the first candidate that
 * actually yields a usable value. Exercises the cascade past a definite
 * Home Assistant "off", the sticky per-rule cache on a transient failure,
 * the "refresh on activation and on a bounded interval, not every tick"
 * timing, and that a failure is reported without ever claiming a remote
 * setting was applied when it was not.
 *
 * These tests replace `global.fetch` directly rather than mocking
 * `api-client.ts`'s exports, so the real `resolveApiValues`/`fetchHaState`
 * request-building and response-parsing code runs — the cascade/cache logic
 * under test is `resolveScheduleTick`'s, but the network boundary it calls
 * through is the real one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveScheduleTick } from "../src/scheduling/runtime";
import type { ScheduleRule, ScheduleValues } from "../src/scheduling/types";

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

const NOW = new Date(2026, 7, 17, 12, 0);
const API_BASE = "http://proxy.local";

let originalFetch: typeof fetch;
let calls: { url: string }[] = [];
let responder: (url: string) => Promise<Response>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  responder = async () => new Response(JSON.stringify({ ok: false, reason: "network", error: "no responder configured" }), { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    return responder(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function freshCaches() {
  return { cache: new Map<string, ScheduleValues>(), lastFetchedAt: new Map<string, number>() };
}

describe("local source", () => {
  test("resolves immediately, with no network call", async () => {
    const r = rule({ source: { kind: "local", values: { theme: "dark" } } });
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.activeRule?.id).toBe(r.id);
    expect(result.override).toEqual({ ruleId: r.id, ruleLabel: r.label, values: { theme: "dark" } });
    expect(result.failure).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("api source", () => {
  test("a successful fetch is used and cached", async () => {
    responder = async () => jsonOk({ ok: true, values: { theme: "dark", density: 4 } });
    const r = rule({ source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 15 } });
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.override).toEqual({ ruleId: r.id, ruleLabel: r.label, values: { theme: "dark", density: 4 } });
    expect(result.failure).toBeNull();
    expect(cache.get(r.id)).toEqual({ theme: "dark", density: 4 });
  });

  test("a failed fetch with no prior cache reports the failure and yields no override", async () => {
    responder = async () => jsonOk({ ok: false, reason: "network", error: "connection refused" });
    const r = rule({ source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 15 } });
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.override).toBeNull();
    expect(result.failure).toEqual({ ruleId: r.id, ruleLabel: r.label, sourceKind: "api", reason: "network", error: "connection refused" });
  });

  test("a failed fetch after a prior success retains the last-good value (sticky cache) and still reports the failure", async () => {
    const r = rule({ source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 15 } });
    const { cache, lastFetchedAt } = freshCaches();
    // First tick: succeeds, populates the cache.
    responder = async () => jsonOk({ ok: true, values: { theme: "dark" } });
    await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    // Force the next attempt to be due immediately, then fail it.
    lastFetchedAt.set(r.id, 0);
    responder = async () => jsonOk({ ok: false, reason: "timeout", error: "timed out" });
    const second = await resolveScheduleTick({ rules: [r], now: new Date(NOW.getTime() + 60_000), apiBase: API_BASE, cache, lastFetchedAt });
    expect(second.override).toEqual({ ruleId: r.id, ruleLabel: r.label, values: { theme: "dark" } });
    expect(second.failure).toEqual({ ruleId: r.id, ruleLabel: r.label, sourceKind: "api", reason: "timeout", error: "timed out" });
  });

  test("malformed JSON from the resolve-api route is reported as a failure, never applied", async () => {
    responder = async () => new Response("not json", { status: 200 });
    const r = rule({ source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 15 } });
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.override).toBeNull();
    expect(result.failure?.reason).toBeDefined();
  });

  test("not yet due for refresh serves the cache without calling fetch again", async () => {
    responder = async () => jsonOk({ ok: true, values: { theme: "dark" } });
    const r = rule({ source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 15 } });
    const { cache, lastFetchedAt } = freshCaches();
    await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(calls).toHaveLength(1);
    // 5 minutes later — well inside the 15-minute refresh interval.
    await resolveScheduleTick({ rules: [r], now: new Date(NOW.getTime() + 5 * 60_000), apiBase: API_BASE, cache, lastFetchedAt });
    expect(calls).toHaveLength(1); // no new fetch
  });

  test("due for refresh (interval elapsed) fetches again", async () => {
    responder = async () => jsonOk({ ok: true, values: { theme: "dark" } });
    const r = rule({ source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 15 } });
    const { cache, lastFetchedAt } = freshCaches();
    await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(calls).toHaveLength(1);
    await resolveScheduleTick({ rules: [r], now: new Date(NOW.getTime() + 16 * 60_000), apiBase: API_BASE, cache, lastFetchedAt });
    expect(calls).toHaveLength(2);
  });
});

describe("homeAssistant source", () => {
  function haRule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
    return rule({
      source: { kind: "homeAssistant", baseUrl: "https://ha.example.com", entityId: "input_boolean.evening", tokenRef: "tok-1", values: { theme: "dark" }, refreshMinutes: 15 },
      ...overrides,
    });
  }

  test('"on" applies the rule\'s own locally-typed values', async () => {
    responder = async () => jsonOk({ ok: true, state: "on" });
    const r = haRule();
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.override).toEqual({ ruleId: r.id, ruleLabel: r.label, values: { theme: "dark" } });
    expect(result.failure).toBeNull();
  });

  test('a definite "off" is not a failure — it cascades to the next matching rule', async () => {
    responder = async () => jsonOk({ ok: true, state: "off" });
    const off = haRule({ priority: 5, label: "off-rule" });
    const fallback = rule({ priority: 1, label: "fallback", source: { kind: "local", values: { theme: "light" } } });
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [off, fallback], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.activeRule?.label).toBe("off-rule"); // still "in charge" by time/priority
    expect(result.override).toEqual({ ruleId: fallback.id, ruleLabel: "fallback", values: { theme: "light" } });
    expect(result.failure).toBeNull(); // "off" is not a failure
  });

  test("no fallback rule and a definite off yields no override at all", async () => {
    responder = async () => jsonOk({ ok: true, state: "off" });
    const r = haRule();
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.override).toBeNull();
    expect(result.failure).toBeNull();
  });

  test("no stored token reports a failure and falls through, never claiming a setting was applied", async () => {
    responder = async () => jsonOk({ ok: false, reason: "no-token", error: "no token is stored for this rule" });
    const r = haRule();
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.override).toBeNull();
    expect(result.failure).toEqual({ ruleId: r.id, ruleLabel: r.label, sourceKind: "homeAssistant", reason: "no-token", error: "no token is stored for this rule" });
  });

  test("a network failure after a prior on-confirmation is sticky (keeps applying) and reports the failure", async () => {
    const r = haRule();
    const { cache, lastFetchedAt } = freshCaches();
    responder = async () => jsonOk({ ok: true, state: "on" });
    await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    lastFetchedAt.set(r.id, 0);
    responder = async () => jsonOk({ ok: false, reason: "network", error: "host unreachable" });
    const second = await resolveScheduleTick({ rules: [r], now: new Date(NOW.getTime() + 60_000), apiBase: API_BASE, cache, lastFetchedAt });
    expect(second.override).toEqual({ ruleId: r.id, ruleLabel: r.label, values: { theme: "dark" } });
    expect(second.failure?.reason).toBe("network");
  });

  test('after a confirmed "off", the cache for that rule is cleared — a later transient failure does not resurrect a stale "on"', async () => {
    const r = haRule();
    const { cache, lastFetchedAt } = freshCaches();
    responder = async () => jsonOk({ ok: true, state: "on" });
    await resolveScheduleTick({ rules: [r], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(cache.get(r.id)).toBeDefined();
    lastFetchedAt.set(r.id, 0);
    responder = async () => jsonOk({ ok: true, state: "off" });
    await resolveScheduleTick({ rules: [r], now: new Date(NOW.getTime() + 60_000), apiBase: API_BASE, cache, lastFetchedAt });
    expect(cache.get(r.id)).toBeUndefined();
  });
});

describe("cascade across mixed rule kinds", () => {
  test("a higher-priority rule with no usable value at all falls through to a lower one", async () => {
    responder = async (url) => (url.includes("resolve-api")
      ? jsonOk({ ok: false, reason: "malformed", error: "bad json" })
      : jsonOk({ ok: false, reason: "network", error: "n/a" }));
    const top = rule({ priority: 10, label: "top", source: { kind: "api", url: "https://example.com/a.json", refreshMinutes: 15 } });
    const bottom = rule({ priority: 1, label: "bottom", source: { kind: "local", values: { theme: "light" } } });
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [top, bottom], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.activeRule?.label).toBe("top");
    expect(result.override?.ruleLabel).toBe("bottom");
    expect(result.failure?.ruleLabel).toBe("top");
  });

  test("with nothing matching at all, override and activeRule are both null and there is no failure", async () => {
    const { cache, lastFetchedAt } = freshCaches();
    const result = await resolveScheduleTick({ rules: [], now: NOW, apiBase: API_BASE, cache, lastFetchedAt });
    expect(result.activeRule).toBeNull();
    expect(result.override).toBeNull();
    expect(result.failure).toBeNull();
    expect(calls).toEqual([]);
  });
});
