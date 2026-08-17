/**
 * Shared, account-keyed state for throttling passive WHAM usage fetches.
 *
 * A leaf module on purpose: both `auth-api.ts` (which does the actual
 * fetching) and `account-lifecycle.ts` (which already drops other
 * account-scoped caches — `main-account-cache.ts` — the moment an account's
 * identity changes or the account is removed) need to touch this state, and
 * `auth-api.ts` already imports FROM `account-lifecycle.ts`. Living here
 * instead of inside `auth-api.ts` keeps that a plain dependency rather than a
 * cycle.
 *
 * See `auth-api.ts`'s `fetchWhamUsage` for why this throttle exists at all
 * (devlog b3-proxyhang, 2026-08-15): a passive WHAM fetch made shortly after
 * another passive WHAM fetch for the SAME account, while the proxy is also
 * serving concurrent local request traffic, has been observed to permanently
 * freeze the whole `Bun.serve()` listener on Bun 1.3.14/Windows.
 */

export const WHAM_FETCH_RETRY_COOLDOWN_MS = 4_000;

const whamFetchQueues = new Map<string, Promise<unknown>>();
const whamFetchLastAttemptStartedAt = new Map<string, number>();

export function whamFetchQueueFor(key: string): Promise<unknown> {
  return whamFetchQueues.get(key) ?? Promise.resolve();
}

export function setWhamFetchQueueFor(key: string, next: Promise<unknown>): void {
  whamFetchQueues.set(key, next);
}

export function clearWhamFetchQueueIfCurrent(key: string, expected: Promise<unknown>): void {
  if (whamFetchQueues.get(key) === expected) whamFetchQueues.delete(key);
}

export function msSinceLastWhamFetchAttempt(key: string): number {
  return Date.now() - (whamFetchLastAttemptStartedAt.get(key) ?? 0);
}

export function markWhamFetchAttemptStarted(key: string): void {
  whamFetchLastAttemptStartedAt.set(key, Date.now());
}

/**
 * Drop the throttle for one account — the same event that already drops that
 * account's cached quota and (for the main account) its cached WHAM info via
 * `purgeCodexAccountRuntimeState`. A genuine identity change or account
 * removal must never leave the next passive poll waiting out a cooldown that
 * was measured against an account this no longer is. Clears both the
 * main-account and pool-account key shapes unconditionally; whichever one
 * does not apply to `accountId` is simply absent, so this is a no-op for it.
 */
export function clearWhamFetchThrottleForAccount(accountId: string): void {
  for (const key of [`main:${accountId}`, `pool:${accountId}`]) {
    whamFetchQueues.delete(key);
    whamFetchLastAttemptStartedAt.delete(key);
  }
}

/** Test-only full reset, mirrored by `auth-api.ts`'s `clearCodexQuotaPrimeState`. */
export function clearAllWhamFetchThrottleStateForTests(): void {
  whamFetchQueues.clear();
  whamFetchLastAttemptStartedAt.clear();
}
