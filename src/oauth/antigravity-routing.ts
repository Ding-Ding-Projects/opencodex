/** Process-local Antigravity account cooldowns; credentials and raw provider data never enter it. */
export type AntigravityCooldownReason = "rate_limited" | "quota_exhausted" | "geo_blocked";

const RATE_LIMIT_DEFAULT_MS = 5_000;
const RATE_LIMIT_MAX_MS = 60_000;
const QUOTA_DEFAULT_MS = 24 * 60 * 60_000;
const QUOTA_MAX_MS = 7 * 24 * 60 * 60_000;
const GEO_BLOCKED_MS = 24 * 60 * 60_000;

type Health = { cooldownUntil: number; reason: AntigravityCooldownReason };
const health = new Map<string, Health>();

function duration(reason: AntigravityCooldownReason, retryAfterMs?: number): number {
  if (reason === "geo_blocked") return GEO_BLOCKED_MS;
  const fallback = reason === "quota_exhausted" ? QUOTA_DEFAULT_MS : RATE_LIMIT_DEFAULT_MS;
  const max = reason === "quota_exhausted" ? QUOTA_MAX_MS : RATE_LIMIT_MAX_MS;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, max)
    : fallback;
}

export function recordAntigravityCooldown(accountId: string, reason: AntigravityCooldownReason, retryAfterMs?: number, now = Date.now()): void {
  if (!accountId) return;
  const until = now + duration(reason, retryAfterMs);
  const current = health.get(accountId);
  if (!current || current.cooldownUntil < until) health.set(accountId, { cooldownUntil: until, reason });
}

export function getAntigravityAccountCooldown(accountId: string, now = Date.now()): Health | undefined {
  const current = health.get(accountId);
  if (!current) return undefined;
  if (current.cooldownUntil <= now) { health.delete(accountId); return undefined; }
  return { ...current };
}

export function clearAntigravityAccountCooldown(accountId: string): void { health.delete(accountId); }
export function sweepExpiredAntigravityRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [id, current] of health) {
    if (current.cooldownUntil > now) continue;
    health.delete(id);
    removed += 1;
  }
  return removed;
}
