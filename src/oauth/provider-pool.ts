/**
 * Opt-in OAuth account pool for ANY multi-account provider — the generalization
 * of the Anthropic pool (#294) the way the Codex pool works: sticky session
 * affinity, 429 cooldown + failover, and quota / round-robin / fill-first
 * strategies for new sessions.
 *
 * Default OFF for every provider. Anthropic keeps its existing config home
 * (`config.anthropicAccountPool`); every other provider opts in through
 * `config.providers[<name>].accountPool` with the identical shape. The engine
 * is one code path, so Anthropic's production mileage is what every other
 * provider inherits.
 *
 * Deliberately narrower than the Codex pool: no mid-session quota rotation,
 * soft-avoid ladders, or probe leases. Subscription OAuth is ToS-sensitive.
 *
 * One strategy does NOT generalize as-is: `quota` needs a per-account usage number,
 * and only providers covered by `supportsPerAccountQuota()` ever have one. See
 * {@link effectiveOAuthPoolStrategy} for what the default strategy does elsewhere.
 *
 * Affinity and cooldowns are process-local (lost on restart), per provider.
 * 401/403 credential failures set needsReauth on the store (existing OAuth
 * path), which excludes the account from eligibility here.
 */

import { createHash } from "node:crypto";
import { setActiveAccount, getAccountSet, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota, supportsPerAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_ANTHROPIC,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
// Type-only: erased at compile time, so it does not create an import cycle with ./index
// (the runtime pulls that module through `await import` below, as it already did).
import type { OAuthAccessSnapshot } from "./index";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
const TOKEN_SKEW_MS = 60_000;

// Re-exported from a leaf module, not declared here: the Anthropic facade aliases
// this at module scope, and reading it out of a cyclic partner mid-initialization
// is a TDZ ReferenceError. See pool-constants.ts.
export { OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST } from "./pool-constants";

export interface OAuthAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota. */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
}

export type OAuthAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface OAuthAccountSelection {
  accountId: string | null;
  reason: OAuthAccountSelectionReason;
}

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "default";
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

// Per-provider process-local state. Lazily created so an unused provider costs nothing.
const healthByProvider = new Map<string, Map<string, AccountHealth>>();
const affinityByProvider = new Map<string, Map<string, AffinityEntry>>();

function healthMap(provider: string): Map<string, AccountHealth> {
  let map = healthByProvider.get(provider);
  if (!map) { map = new Map(); healthByProvider.set(provider, map); }
  return map;
}

function affinityMap(provider: string): Map<string, AffinityEntry> {
  let map = affinityByProvider.get(provider);
  if (!map) { map = new Map(); affinityByProvider.set(provider, map); }
  return map;
}

/** Anthropic keeps its historical rotation key so persisted RR state survives this refactor. */
function rotationKey(provider: string): string {
  return provider === "anthropic" ? POOL_KEY_ANTHROPIC : `oauth:${provider}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function oauthPoolConfig(config: OcxConfig, provider: string): OAuthAccountPoolConfig {
  // Anthropic predates the generic surface and keeps its original config home.
  const raw = provider === "anthropic"
    ? config.anthropicAccountPool
    : config.providers?.[provider]?.accountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

/**
 * Persist pool settings for a provider into whichever config home it uses (caller saves).
 * Mirrors {@link oauthPoolConfig} so read and write can never disagree about where a
 * provider's pool lives.
 */
export function setOAuthPoolConfig(config: OcxConfig, provider: string, pool: OAuthAccountPoolConfig): void {
  if (provider === "anthropic") {
    config.anthropicAccountPool = pool;
    return;
  }
  const existing = config.providers?.[provider];
  if (!existing) throw new Error(`provider '${provider}' is not configured`);
  config.providers = { ...config.providers, [provider]: { ...existing, accountPool: pool } };
}

export function isOAuthPoolEnabled(config: OcxConfig, provider: string): boolean {
  return oauthPoolConfig(config, provider).enabled === true;
}

export function oauthPoolAutoSwitchThreshold(config: OcxConfig, provider: string): number {
  const value = oauthPoolConfig(config, provider).autoSwitchThreshold;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function stickyLimitForPool(config: OcxConfig, provider: string): number {
  return normalizeAccountPoolStickyLimit(oauthPoolConfig(config, provider).stickyLimit);
}

function poolStrategy(config: OcxConfig, provider: string): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(oauthPoolConfig(config, provider).strategy);
}

/**
 * The strategy routing actually runs, which is not always the configured one.
 *
 * `quota` ranks accounts by cached per-account usage, and that cache is only ever
 * populated for providers `supportsPerAccountQuota()` covers (anthropic today). For
 * every other provider every candidate scored UNKNOWN_USAGE_SCORE, so no account ever
 * looked better than the active one and the pool pinned to it forever: enabling the
 * pool for e.g. xai with the DEFAULT strategy silently never rotated at all. Round-robin
 * is the honest degradation — with no usage signal, "spread new sessions evenly" is the
 * most useful defined behaviour left, and it still only ever picks eligible (uncooled,
 * usable, non-reauth) accounts.
 *
 * Two things are deliberately NOT degraded:
 * - Providers with a real usage signal keep the quota path untouched, since Anthropic's
 *   production behaviour is what the generalized engine inherits.
 * - `autoSwitchThreshold: 0` is the documented "affinity + active only" opt-out. An
 *   operator who asked for no automatic new-session switching must not get round-robin
 *   rotation instead.
 *
 * Exported so callers that report pool settings can show what will really happen rather
 * than echoing a configured strategy the provider cannot honour.
 */
export function effectiveOAuthPoolStrategy(config: OcxConfig, provider: string): OcxAccountPoolRotationStrategy {
  const configured = poolStrategy(config, provider);
  if (configured !== "quota") return configured;
  if (supportsPerAccountQuota(provider)) return configured;
  if (oauthPoolAutoSwitchThreshold(config, provider) <= 0) return configured;
  return "round-robin";
}

// ---------------------------------------------------------------------------
// Health / eligibility
// ---------------------------------------------------------------------------

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function getOAuthAccountHealthSnapshot(
  provider: string,
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
  const map = healthMap(provider);
  const entry = map.get(accountId);
  if (!entry) return null;
  if (entry.cooldownUntil <= now) {
    map.delete(accountId);
    return null;
  }
  return { cooldownUntil: entry.cooldownUntil, cooldownSource: entry.cooldownSource };
}

export function clearOAuthAccountCooldown(provider: string, accountId: string): boolean {
  return healthMap(provider).delete(accountId);
}

/** Record a provider-local failure without selecting or promoting another account. */
export function recordOAuthAccountCooldown(
  provider: string,
  accountId: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  durationOverrideMs?: number,
): void {
  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  const cooldownMs = typeof durationOverrideMs === "number" && Number.isFinite(durationOverrideMs) && durationOverrideMs > 0
    ? durationOverrideMs
    : parsedRetry ?? DEFAULT_COOLDOWN_MS;
  const map = healthMap(provider);
  const current = map.get(accountId);
  const until = now + cooldownMs;
  if (!current || current.cooldownUntil < until) {
    map.set(accountId, { cooldownUntil: until, cooldownSource: parsedRetry ? "retry-after" : "default" });
  }
  clearOAuthSessionAffinityForAccount(provider, accountId);
}

/** Test / logout helper. */
export function clearOAuthPoolState(provider?: string): void {
  if (provider) {
    healthByProvider.get(provider)?.clear();
    affinityByProvider.get(provider)?.clear();
    return;
  }
  healthByProvider.clear();
  affinityByProvider.clear();
}

function isCooled(provider: string, accountId: string, now: number): boolean {
  return getOAuthAccountHealthSnapshot(provider, accountId, now) !== null;
}

function accountQuotaDestination(config: OcxConfig, provider: string): string | undefined {
  return provider === "google-antigravity" ? config.providers?.[provider]?.baseUrl : undefined;
}

function hasKnownUsage(config: OcxConfig, provider: string, accountId: string): boolean {
  const quota = getCachedProviderAccountQuota(provider, accountId, accountQuotaDestination(config, provider));
  return typeof quota?.fiveHourPercent === "number" && Number.isFinite(quota.fiveHourPercent);
}

function usageScore(config: OcxConfig, provider: string, accountId: string): number {
  const quota = getCachedProviderAccountQuota(provider, accountId, accountQuotaDestination(config, provider));
  if (!quota || typeof quota.fiveHourPercent !== "number" || !Number.isFinite(quota.fiveHourPercent)) {
    return UNKNOWN_USAGE_SCORE;
  }
  return Math.max(0, Math.min(100, quota.fiveHourPercent));
}

/** Background `local-cli` slots with expired access are not pool-eligible (identity adoption risk). */
function isPoolCredentialUsable(provider: string, accountId: string, now: number): boolean {
  const cred = getAccountCredential(provider, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  if (canRefreshOAuthPoolAccount(provider, accountId)) return true;
  return cred.expires > now + TOKEN_SKEW_MS;
}

export function getEligibleOAuthAccounts(provider: string, now = Date.now()): string[] {
  const set = getAccountSet(provider);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && !isCooled(provider, account.id, now)
      && isPoolCredentialUsable(provider, account.id, now))
    .map(account => account.id);
}

/** Earliest remaining cooldown among cooled accounts, for the client Retry-After. */
export function getOAuthPoolRetryAfterSeconds(provider: string, now = Date.now()): number | null {
  const set = getAccountSet(provider);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snap = getOAuthAccountHealthSnapshot(provider, account.id, now);
    if (!snap?.cooldownUntil) continue;
    if (earliest === null || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1000));
}

// ---------------------------------------------------------------------------
// Strategy picks
// ---------------------------------------------------------------------------

function pickLowestUsage(config: OcxConfig, provider: string, excludeId: string | undefined, now: number): string | null {
  const eligible = getEligibleOAuthAccounts(provider, now).filter(id => id !== excludeId);
  if (eligible.length === 0) return null;
  let best = eligible[0]!;
  let bestScore = usageScore(config, provider, best);
  for (let i = 1; i < eligible.length; i++) {
    const id = eligible[i]!;
    const score = usageScore(config, provider, id);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function isActiveUnderFillFirstThreshold(config: OcxConfig, provider: string, accountId: string): boolean {
  const threshold = oauthPoolAutoSwitchThreshold(config, provider);
  if (threshold <= 0) return true;
  // Unknown usage must not force fill-first to abandon the active account. For a provider
  // with no usage signal at all that makes fill-first "hold the active account until it
  // 429s, then advance" — deliberately NOT degraded to round-robin like quota is: draining
  // one account before moving on is exactly what fill-first was asked to do, and a 429 is
  // the only drain evidence such a provider ever gives us (see rotateOAuthAccountOn429).
  if (!hasKnownUsage(config, provider, accountId)) return true;
  return usageScore(config, provider, accountId) < threshold;
}

/** Next eligible account in stable order after `afterId` (wrapping). */
function pickNextFillFirstAccount(
  config: OcxConfig,
  provider: string,
  afterId: string,
  eligible: string[],
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  const set = getAccountSet(provider);
  const stableAll = set
    ? [...set.accounts.map(a => a.id)].sort((a, b) => a.localeCompare(b))
    : ordered;
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, provider, id)) return id;
    }
    return ordered[0] ?? null;
  }
  // Skip successors that are also at/above threshold (known drained usage).
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (isActiveUnderFillFirstThreshold(config, provider, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

/**
 * Fill-first: keep eligible active under threshold; otherwise advance to the next
 * eligible id in stable sorted order after the current active (wrapping).
 */
function pickFillFirstAccount(config: OcxConfig, provider: string, now: number): string | null {
  const eligible = getEligibleOAuthAccounts(provider, now);
  if (eligible.length === 0) return null;

  const set = getAccountSet(provider);
  const active = set?.activeAccountId;
  if (active && eligible.includes(active) && isActiveUnderFillFirstThreshold(config, provider, active)) {
    return active;
  }

  if (!active || !set) {
    const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, provider, id)) return id;
    }
    return ordered[0] ?? null;
  }

  return pickNextFillFirstAccount(config, provider, active, eligible);
}

function pickAlternateAccount(
  config: OcxConfig,
  provider: string,
  excludeId: string,
  now: number,
): string | null {
  const strategy = effectiveOAuthPoolStrategy(config, provider);
  const eligible = getEligibleOAuthAccounts(provider, now).filter(id => id !== excludeId);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(rotationKey(provider), eligible, stickyLimitForPool(config, provider));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAccount(config, provider, excludeId, eligible);
  }
  return pickLowestUsage(config, provider, excludeId, now);
}

/**
 * Unbound new-session pick for round-robin / fill-first. Returns null to fall through
 * to the legacy quota path (or when the effective strategy is quota).
 */
function pickUnboundStrategyAccount(
  config: OcxConfig,
  provider: string,
  now: number,
): { accountId: string; reason: "round-robin" | "fill-first" } | null {
  const strategy = effectiveOAuthPoolStrategy(config, provider);
  if (strategy === "quota") return null;

  if (strategy === "round-robin") {
    const eligible = getEligibleOAuthAccounts(provider, now);
    const limit = stickyLimitForPool(config, provider);
    const picked = pickRoundRobinAccount(rotationKey(provider), eligible, limit);
    if (!picked) return null;
    notePoolRotationSuccess(rotationKey(provider), picked, limit);
    return { accountId: picked, reason: "round-robin" };
  }

  if (strategy === "fill-first") {
    const picked = pickFillFirstAccount(config, provider, now);
    if (!picked) return null;
    return { accountId: picked, reason: "fill-first" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Affinity
// ---------------------------------------------------------------------------

function pruneExpiredAffinity(provider: string, now: number): void {
  const map = affinityMap(provider);
  for (const [key, entry] of map) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) map.delete(key);
  }
  if (map.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const drop = map.size - MAX_AFFINITY_ENTRIES;
  for (let i = 0; i < drop; i++) map.delete(sorted[i]![0]);
}

export function bindOAuthSessionAffinity(
  provider: string,
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = sessionKey?.trim();
  if (!key) return;
  affinityMap(provider).set(key, { accountId, lastUsedAt: now });
  pruneExpiredAffinity(provider, now);
}

export function clearOAuthSessionAffinityForAccount(provider: string, accountId: string): void {
  const map = affinityMap(provider);
  for (const [key, entry] of map) {
    if (entry.accountId === accountId) map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Resolve which OAuth account should serve this session.
 * When the pool is disabled, always returns the store's active account.
 */
export function resolveOAuthAccountForSession(
  provider: string,
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): OAuthAccountSelection {
  pruneExpiredAffinity(provider, now);
  const set = getAccountSet(provider);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isOAuthPoolEnabled(config, provider)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const affinity = affinityMap(provider);
  const key = sessionKey?.trim() || "";
  if (key) {
    const affined = affinity.get(key);
    if (affined && now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (stillThere && !isCooled(provider, affined.accountId, now) && isPoolCredentialUsable(provider, affined.accountId, now)) {
        affined.lastUsedAt = now;
        return { accountId: affined.accountId, reason: "affinity" };
      }
      affinity.delete(key);
    }
  }

  const strategy = effectiveOAuthPoolStrategy(config, provider);
  // No session identity (Desktop turns without a sticky key): hold the current
  // active under RR/fill-first instead of treating every turn as a new session.
  if (!key && (strategy === "round-robin" || strategy === "fill-first")) {
    const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
      && !isCooled(provider, set.activeAccountId, now)
      && isPoolCredentialUsable(provider, set.activeAccountId, now);
    if (activeOk) {
      return { accountId: set.activeAccountId, reason: "active" };
    }
  }

  const strategyPick = pickUnboundStrategyAccount(config, provider, now);
  if (strategyPick) {
    // Do not promote active here — token validation may still fail. Callers
    // promote after getOAuthPoolAccessToken succeeds.
    if (key) {
      affinity.set(key, { accountId: strategyPick.accountId, lastUsedAt: now });
      pruneExpiredAffinity(provider, now);
    }
    return { accountId: strategyPick.accountId, reason: strategyPick.reason };
  }

  const threshold = oauthPoolAutoSwitchThreshold(config, provider);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && !isCooled(provider, set.activeAccountId, now)
    && isPoolCredentialUsable(provider, set.activeAccountId, now);

  let accountId: string | null = null;
  let reason: OAuthAccountSelectionReason = "none";

  if (threshold > 0) {
    // Unknown usage must NOT force a switch away from the healthy active account.
    if (activeOk && (!hasKnownUsage(config, provider, set.activeAccountId) || usageScore(config, provider, set.activeAccountId) < threshold)) {
      accountId = set.activeAccountId;
      reason = "active";
    } else {
      const picked = pickLowestUsage(config, provider, undefined, now);
      if (picked) {
        accountId = picked;
        reason = activeOk && picked === set.activeAccountId ? "active" : "lowest-usage";
      } else if (activeOk) {
        accountId = set.activeAccountId;
        reason = "active";
      }
    }
  } else if (activeOk) {
    accountId = set.activeAccountId;
    reason = "active";
  } else {
    const picked = pickLowestUsage(config, provider, set.activeAccountId, now);
    if (picked) {
      accountId = picked;
      reason = "only-eligible";
    }
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(a => isCooled(provider, a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }

  if (key) {
    affinity.set(key, { accountId, lastUsedAt: now });
    pruneExpiredAffinity(provider, now);
  }
  return { accountId, reason };
}

// ---------------------------------------------------------------------------
// Failover / promotion
// ---------------------------------------------------------------------------

/**
 * Record a 429 for `failedAccountId`, cool it, clear its affinity, and pick a failover
 * account. Does NOT promote the store active account — caller should promote only after a
 * successful retry (or token resolve).
 */
export function rotateOAuthAccountOn429(
  config: OcxConfig,
  provider: string,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isOAuthPoolEnabled(config, provider)) return null;

  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  const cooldownMs = parsedRetry ?? DEFAULT_COOLDOWN_MS;
  healthMap(provider).set(failedAccountId, {
    cooldownUntil: now + cooldownMs,
    cooldownSource: parsedRetry ? "retry-after" : "default",
  });
  clearOAuthSessionAffinityForAccount(provider, failedAccountId);
  notePoolRotationFailure(rotationKey(provider), failedAccountId);

  const next = pickAlternateAccount(config, provider, failedAccountId, now);
  if (!next) {
    console.warn(`[oauth-pool] all eligible ${provider} OAuth accounts are in cooldown; returning 429`);
    return null;
  }

  if (sessionKey?.trim()) {
    affinityMap(provider).set(sessionKey.trim(), { accountId: next, lastUsedAt: now });
    pruneExpiredAffinity(provider, now);
  }
  console.warn(
    `[oauth-pool] 429 on ${provider} ${formatOAuthAccountOrdinal(failedAccountId)}; failing over to ${formatOAuthAccountOrdinal(next)}`,
  );
  return next;
}

/** Promote dashboard active account after a validated failover target is usable. */
export function promoteOAuthActiveAccount(provider: string, accountId: string): void {
  void setActiveAccount(provider, accountId).catch(() => { /* best-effort */ });
}

/**
 * Manual selection resets session affinity and seeds the RR ring so the next
 * unbound new session honors the operator-chosen account (Codex parity).
 */
export function resetOAuthRoutingForManualSelection(provider: string, accountId: string): void {
  affinityMap(provider).clear();
  seedPoolRotationAccount(rotationKey(provider), accountId);
}

// ---------------------------------------------------------------------------
// Tokens / labels
// ---------------------------------------------------------------------------

/**
 * Whether the pool may refresh this account's token. Background `local-cli` slots must not
 * adopt the global CLI credential (same fail-closed rule as quota probes).
 */
export function canRefreshOAuthPoolAccount(provider: string, accountId: string): boolean {
  const set = getAccountSet(provider);
  const cred = getAccountCredential(provider, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  return set?.activeAccountId === accountId;
}

/**
 * Resolve a pool account's full access snapshot without adopting a newer global CLI
 * credential into a background multiauth `local-cli` slot.
 *
 * Returns the SNAPSHOT rather than a bare token because the caller needs the routing
 * metadata attached to this specific account (Kiro profileArn/region, Antigravity
 * project id, the generation used for 401 replay). A pooled request that carries
 * account B's bearer alongside account A's metadata authenticates as B and routes as A.
 */
export async function getOAuthPoolAccessSnapshot(provider: string, accountId: string, destination?: string): Promise<OAuthAccessSnapshot> {
  const stored = getAccountCredential(provider, accountId);
  if (!stored) {
    const { OAuthLoginRequiredError } = await import("./index");
    throw new OAuthLoginRequiredError(provider);
  }
  const { storedAccessSnapshot, getAccessSnapshotForAccount } = await import("./index");
  if (stored.expires > Date.now() + TOKEN_SKEW_MS) {
    const snapshot = storedAccessSnapshot(provider, accountId, destination);
    if (snapshot) return snapshot;
  }
  if (!canRefreshOAuthPoolAccount(provider, accountId)) {
    throw new Error("background local-cli token expired; refuse CLI-adopting refresh for pool");
  }
  return getAccessSnapshotForAccount(provider, accountId, destination);
}

/** Bearer-only convenience wrapper over {@link getOAuthPoolAccessSnapshot}. */
export async function getOAuthPoolAccessToken(provider: string, accountId: string): Promise<string> {
  return (await getOAuthPoolAccessSnapshot(provider, accountId)).accessToken;
}

export function formatOAuthAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatOAuthProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatOAuthAccountOrdinal(accountId)}`;
}

/**
 * Build a sticky session key from client headers.
 * Prefer true session/thread ids; do not use a shared cache-cohort prompt_cache_key
 * alone (those collide across conversations).
 */
export function oauthSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  /** When true, prompt_cache_key is a shared Desktop cohort — ignore it for affinity. */
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  const preferred = (
    input.clientThreadId
    ?? input.sessionIdHeader
    ?? input.threadIdHeader
    ?? ""
  ).trim();
  if (preferred) {
    return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  }
  if (input.promptCacheKeyIsSharedCohort) return null;
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  if (!cacheKey) return null;
  return cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}
