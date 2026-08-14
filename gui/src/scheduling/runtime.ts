/**
 * The scheduled-settings engine: figures out which rule (if any) is active
 * right now, resolves that rule's values — locally, from an API, or gated on
 * a Home Assistant entity — and hands the result back as a *temporary*
 * override for `SettingsDraftProvider` to lay on top of the user's own
 * settings when rendering tokens, locale and funny level.
 *
 * `resolveScheduleTick` is the pure(ish) resolution step: given the rule list,
 * an instant, and a place to cache last-good remote values, it returns what
 * should be showing right now. It touches the network only through the
 * injected fetchers, so `gui/tests/scheduling-runtime.test.ts` can drive it
 * with fakes and assert on cascade/cache/failure behaviour without a real
 * server or real timers.
 *
 * `useScheduleRuntime` is the thin React wrapper: it owns the rule list (in
 * `localStorage`, via `schema.ts`), ticks on an interval, and — this is the
 * part worth reading twice — discards a resolution that a newer tick has
 * already superseded. Two tabs, a slow network response, and a rule edited
 * mid-flight can all produce more than one `resolveScheduleTick` in flight at
 * once; without a guard, whichever one happens to resolve *last* wins even
 * when it started first and is now stale. `genRef` is that guard: every tick
 * bumps it, captures its own value, and a result is only committed to state
 * when the generation it started with is still the current one.
 *
 * This module never calls `setPrefs`, never touches `PREFS_KEY`, and never
 * calls `localStorage.setItem` for anything but the rule list itself. The
 * override lives only in `useScheduleRuntime`'s React state — so when a rule
 * stops matching, the next tick simply reports `null` again, and the base
 * settings are exactly what they always were. There is nothing to "recover":
 * nothing was ever overwritten.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHaState, resolveApiValues } from "./api-client";
import { matchingRulesByPrecedence } from "./match";
import { readScheduleState, writeScheduleState } from "./schema";
import { SCHEDULE_SCHEMA_VERSION } from "./types";
import type { ScheduleRule, ScheduleValues } from "./types";

/**
 * How often the engine re-checks *time* matching (which rule's day/date/time
 * window contains `now`). Cheap and local — no network — so a short interval
 * costs nothing and keeps a 22:00 boundary from being missed by more than a
 * few seconds. Network refresh for a remote rule is separately bounded by
 * that rule's own `refreshMinutes` — see `dueForFetch` below.
 */
export const TICK_MS = 15_000;

export interface ScheduleOverride {
  ruleId: string;
  ruleLabel: string;
  values: ScheduleValues;
}

export type ScheduleFailureReason =
  | "network" | "refused" | "too-large" | "timeout" | "malformed"
  | "invalid-url" | "invalid-entity" | "invalid-token-ref" | "no-token" | "auth-or-refused" | "http";

export interface ScheduleFailureNotice {
  ruleId: string;
  ruleLabel: string;
  /** "api" or "homeAssistant" — never "local", which cannot fail. */
  sourceKind: "api" | "homeAssistant";
  reason: ScheduleFailureReason;
  error: string;
}

function dueForFetch(ruleId: string, refreshMinutes: number, lastFetchedAt: Map<string, number>, now: number): boolean {
  const last = lastFetchedAt.get(ruleId);
  return last === undefined || now - last >= refreshMinutes * 60_000;
}

interface FailureDetail {
  reason: ScheduleFailureReason;
  error: string;
}

interface CandidateOutcome {
  kind: "use" | "skip" | "fail";
  values?: ScheduleValues;
  /**
   * Set on a `"use"` outcome that is actually a *sticky cache fallback*: the
   * refresh attempt this tick failed, but a prior confirmed value for this
   * same rule is still being served. The caller reports the failure (so the
   * user still learns the refresh is not working) without discarding the
   * override it is standing in for.
   */
  staleFailure?: FailureDetail;
  reason?: ScheduleFailureReason;
  error?: string;
}

async function resolveCandidate(
  rule: ScheduleRule,
  apiBase: string,
  cache: Map<string, ScheduleValues>,
  lastFetchedAt: Map<string, number>,
  signal: AbortSignal | undefined,
  now: number,
): Promise<CandidateOutcome> {
  if (rule.source.kind === "local") return { kind: "use", values: rule.source.values };

  const refreshMinutes = rule.source.refreshMinutes;
  if (!dueForFetch(rule.id, refreshMinutes, lastFetchedAt, now)) {
    // Not due for a refresh yet. Serve the last confirmed value rather than
    // re-fetching every 15-second tick — "refresh on activation and on a
    // bounded background interval", not on every tick that merely re-checks
    // time matching. A rule with no confirmed value yet (first tick, or every
    // prior attempt failed) has nothing to serve, so it falls through and
    // attempts a fetch anyway — there is no stale-but-valid state to retain.
    const cached = cache.get(rule.id);
    if (cached) return { kind: "use", values: cached };
  }

  lastFetchedAt.set(rule.id, now);

  if (rule.source.kind === "api") {
    const result = await resolveApiValues(apiBase, rule.source.url, signal);
    if (result.ok) {
      cache.set(rule.id, result.value);
      return { kind: "use", values: result.value };
    }
    // The refresh failed. Fail safe: retain the *rule's own* last confirmed
    // value rather than blanking to nothing, and still report the failure so
    // it reaches the user — never claim the value came from this refresh.
    const cached = cache.get(rule.id);
    if (cached) return { kind: "use", values: cached, staleFailure: { reason: result.reason, error: result.error } };
    return { kind: "fail", reason: result.reason, error: result.error };
  }

  // Home Assistant: the fetch resolves a state string, not the settings
  // themselves. "on" applies this rule's own locally-typed `values`; any
  // other definite state (off, unavailable, unknown-but-answered) is not a
  // failure — the entity has told us plainly that this rule does not apply
  // right now, so the caller should try the next candidate rather than
  // holding onto a stale "on" from a previous check.
  const result = await fetchHaState(apiBase, {
    baseUrl: rule.source.baseUrl,
    entityId: rule.source.entityId,
    tokenRef: rule.source.tokenRef,
  }, signal);
  if (result.ok) {
    if (result.value === "on") {
      cache.set(rule.id, rule.source.values);
      return { kind: "use", values: rule.source.values };
    }
    cache.delete(rule.id);
    return { kind: "skip" };
  }
  const cached = cache.get(rule.id);
  if (cached) return { kind: "use", values: cached, staleFailure: { reason: result.reason, error: result.error } };
  return { kind: "fail", reason: result.reason, error: result.error };
}

export interface ResolveTickInput {
  rules: readonly ScheduleRule[];
  now: Date;
  apiBase: string;
  /** Last confirmed values per rule id. Mutated in place — owned by the caller across ticks. */
  cache: Map<string, ScheduleValues>;
  /** Last fetch-attempt epoch ms per rule id. Mutated in place. */
  lastFetchedAt: Map<string, number>;
  signal?: AbortSignal;
}

export interface ResolveTickResult {
  activeRule: ScheduleRule | null;
  override: ScheduleOverride | null;
  failure: ScheduleFailureNotice | null;
}

/**
 * One resolution pass: which rule is active by time/priority, and — walking
 * down the precedence order — the first candidate that actually yields a
 * usable value.
 *
 * A rule whose remote source fails is reported (`failure`) exactly once per
 * tick (the first failure encountered), whether or not the tick goes on to
 * serve that same rule's cached last-good value or falls through to a
 * lower-priority rule. Network failure, malformed data, an offline device, an
 * auth failure, and rate limiting all surface through the same `fail`
 * outcome — this function never claims a remote setting was applied when the
 * fetch that would have supplied it did not succeed.
 */
export async function resolveScheduleTick(input: ResolveTickInput): Promise<ResolveTickResult> {
  const candidates = matchingRulesByPrecedence(input.rules, input.now);
  const activeRule = candidates[0] ?? null;
  let failure: ScheduleFailureNotice | null = null;
  const now = input.now.getTime();

  for (const rule of candidates) {
    const outcome = await resolveCandidate(rule, input.apiBase, input.cache, input.lastFetchedAt, input.signal, now);
    if (outcome.kind === "use") {
      if (outcome.staleFailure && !failure) {
        failure = {
          ruleId: rule.id,
          ruleLabel: rule.label,
          sourceKind: rule.source.kind as "api" | "homeAssistant",
          reason: outcome.staleFailure.reason,
          error: outcome.staleFailure.error,
        };
      }
      return { activeRule, override: { ruleId: rule.id, ruleLabel: rule.label, values: outcome.values! }, failure };
    }
    if (outcome.kind === "skip") continue;
    if (!failure) {
      failure = {
        ruleId: rule.id,
        ruleLabel: rule.label,
        sourceKind: rule.source.kind as "api" | "homeAssistant",
        reason: outcome.reason!,
        error: outcome.error!,
      };
    }
    // A failed rule with no cached value falls through to the next candidate;
    // resolveCandidate has already served the cache when one existed, so
    // reaching here means there is nothing valid to retain for this rule.
  }
  return { activeRule, override: null, failure };
}

export interface ScheduleRuntime {
  rules: ScheduleRule[];
  setRules: (next: ScheduleRule[]) => void;
  activeRuleId: string | null;
  override: ScheduleOverride | null;
  /** The most recent failure, plus a sequence number so a listener can tell a repeat from a new one. */
  failure: ScheduleFailureNotice | null;
  failureSeq: number;
  /** Re-run resolution immediately — the "Retry now" action. */
  retry: () => void;
}

export function useScheduleRuntime(apiBase: string): ScheduleRuntime {
  const [rules, setRulesState] = useState<ScheduleRule[]>(() => readScheduleState().rules);
  const [activeRuleId, setActiveRuleId] = useState<string | null>(null);
  const [override, setOverride] = useState<ScheduleOverride | null>(null);
  const [failure, setFailure] = useState<ScheduleFailureNotice | null>(null);
  const [failureSeq, setFailureSeq] = useState(0);

  const cacheRef = useRef(new Map<string, ScheduleValues>());
  const lastFetchedRef = useRef(new Map<string, number>());
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const setRules = useCallback((next: ScheduleRule[]) => {
    setRulesState(next);
    try {
      writeScheduleState({ version: SCHEDULE_SCHEMA_VERSION, rules: next });
    } catch {
      // Same tolerance `recordRevision` and the rest of this app's browser-owned
      // writes apply: the in-memory rule list (and therefore the editor and the
      // engine) still reflects the edit, it simply cannot outlive a reload. A
      // schedule rule is not part of the Save/Discard draft flow, so there is no
      // "outcome" object for a caller to inspect the way `apply()` provides one.
    }
  }, []);

  const runTick = useCallback(() => {
    genRef.current += 1;
    const myGeneration = genRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void resolveScheduleTick({
      rules: rulesRef.current,
      now: new Date(),
      apiBase,
      cache: cacheRef.current,
      lastFetchedAt: lastFetchedRef.current,
      signal: controller.signal,
    }).then(result => {
      // The generation guard: a slower, now-superseded tick must never
      // overwrite what a later tick already decided.
      if (myGeneration !== genRef.current) return;
      setActiveRuleId(result.activeRule?.id ?? null);
      setOverride(result.override);
      if (result.failure) {
        setFailure(result.failure);
        setFailureSeq(seq => seq + 1);
      }
    }).catch(() => {
      // A superseded fetch rejects with AbortError; a tick that is no longer
      // current is expected to fail this way and is silently dropped by the
      // same generation check a successful-but-stale result would hit.
    });
  }, [apiBase]);

  useEffect(() => {
    runTick();
    const timer = setInterval(runTick, TICK_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
    // Re-arms on every rule-list edit so a newly active rule (or a rule that
    // just stopped matching) is reflected without waiting up to TICK_MS.
  }, [rules, runTick]);

  return { rules, setRules, activeRuleId, override, failure, failureSeq, retry: runTick };
}
