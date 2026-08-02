/**
 * Multi-key 429 failover for non-OpenAI providers.
 *
 * When a provider's upstream returns 429, this module picks the next available key
 * from `apiKeyPool`, puts the exhausted key into cooldown (respecting Retry-After),
 * and returns a fresh provider config with the swapped key. If all keys are in
 * cooldown, returns null so the caller surfaces the 429 to the client.
 *
 * Modelled after src/codex/routing.ts cooldown logic but scoped to plain API-key pools.
 */
import { resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { resolveProviderTransport, type OcxProviderTransport } from "./xai-transport";

// ---- cooldown state (in-memory, same as codex/routing.ts) ----

interface KeyCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000; // cap at 10 min for api-key rotation

/** Map<`${providerName}\0${keyId}`, KeyCooldown> */
const keyCooldowns = new Map<string, KeyCooldown>();

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
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

/**
 * Whether two key values name the same credential.
 *
 * A pool entry holds the config file's text and the documented form for a secret
 * is `"${XAI_API_KEY}"`; everything downstream sees the expanded value. Both
 * spellings therefore have to compare equal, or the pool can never recognise the
 * key that just failed. Compared raw as well so a literal key — the other
 * documented form — still matches without an env lookup.
 */
function sameKey(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return resolveEnvValue(a) === resolveEnvValue(b);
}

function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

// ---- public API ----

/**
 * Check whether a provider has multiple keys available for failover.
 * Returns true only for key-auth providers with 2+ pool entries.
 */
export function hasKeyPoolFailover(provider: OcxProviderConfig): boolean {
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  return (provider.apiKeyPool?.length ?? 0) >= 2;
}

/**
 * Record a 429 for the current key and attempt to switch to the next available one.
 *
 * @returns A new OcxProviderConfig with the swapped key (and mutated config on disk),
 *          or `null` when no alternative key is available (all in cooldown or pool < 2).
 *
 * The returned object is a snapshot of the PERSISTED config — it carries none of the
 * registry backfills `routedProviderConfig` merges in at request time. Request paths must
 * not assign it to an active route wholesale; use `rotateProviderTransportOn429`, which
 * takes only the swapped key and keeps the routed provider intact.
 */
export function rotateKeyOn429(
  config: OcxConfig,
  providerName: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
): OcxProviderConfig | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return null;

  const pool = provider.apiKeyPool;
  if (!pool || pool.length < 2) return null;

  // Cool the key that ACTUALLY failed. Under concurrent 429s another request may already have
  // rotated provider.apiKey — cooling the live key would punish an innocent replacement and can
  // exhaust a 2-key pool from a single bad key. CAS semantics: callers pass the key they used.
  const failedKey = attemptedKey ?? provider.apiKey;
  // Compare RESOLVED values on both sides.
  //
  // A pool entry stores whatever the config file says, and the documented form
  // for a secret is `"${XAI_API_KEY}"`. The router expands it before use
  // (`route.provider.apiKey = resolveEnvValue(provider.apiKey)`), so callers hand
  // back the *expanded* secret as `attemptedKey`, and a raw `e.key === failedKey`
  // never matched. Nothing was ever cooled, the "lost the race" branch below then
  // returned the same un-rotated key, and every retry went out as
  // `Authorization: Bearer ${XAI_API_KEY}` — the twelve literal characters.
  // Upstream answered 401 for two perfectly valid keys, and the second key was
  // never reached at all.
  const currentEntry = pool.find(e => sameKey(e.key, failedKey));
  if (currentEntry) {
    const cooldownMs = parseRetryAfterMs(retryAfterHeader, now) ?? DEFAULT_COOLDOWN_MS;
    keyCooldowns.set(cooldownKey(providerName, currentEntry.id), {
      cooldownUntil: now + cooldownMs,
    });
  }

  // Lost the race: someone already rotated away from the failed key. If the live key is healthy,
  // retry with it as-is instead of rotating a second time.
  if (attemptedKey !== undefined && provider.apiKey !== attemptedKey) {
    const liveEntry = pool.find(e => sameKey(e.key, provider.apiKey));
    if (liveEntry && !isKeyInCooldown(providerName, liveEntry.id, now)) {
      return { ...provider };
    }
  }

  // Pick the next key that is NOT in cooldown
  // When the failed key is not in the pool at all, start from the beginning and
  // consider EVERY entry. The old `-1` start combined with `i = 1..length-1`
  // walked indices 0..length-2, so the last key in the pool was never offered.
  const currentIndex = currentEntry ? pool.indexOf(currentEntry) : -1;
  const first = currentEntry ? 1 : 0;
  for (let i = first; i < first + pool.length; i++) {
    const candidate = pool[(currentIndex + i + pool.length) % pool.length]!;
    if (!isKeyInCooldown(providerName, candidate.id, now)) {
      // Swap active key
      provider.apiKey = candidate.key;
      saveConfigPreservingClaudeCode(config);
      console.warn(
        // Log ids only — labels are user-supplied free text and could carry secret material.
        `[key-failover] ${providerName}: 429 on key ${currentEntry?.id ?? "?"}; rotating to key ${candidate.id}`,
      );
      return { ...provider };
    }
  }

  // All keys in cooldown
  console.warn(`[key-failover] ${providerName}: all ${pool.length} keys in cooldown; returning 429 to client`);
  return null;
}

interface RotateProviderTransportOptions {
  retryAfter?: string | null;
  now?: number;
  attemptedKey?: string;
  promptCacheKey?: string;
}

/**
 * Rotate a failed key and re-apply provider-specific transport metadata to the replacement.
 *
 * `routedProvider` is the request's active provider (the `routedProviderConfig` output the
 * route was built with). The result inherits it and swaps ONLY the API key: the persisted
 * config that `rotateKeyOn429` snapshots predates registry backfill, so building the retry
 * provider from that snapshot would silently drop every field the registry merged in at
 * routing time (scalar flags like `promptCacheKey`/`parallelToolCalls`, merged model
 * metadata such as `noTemperatureModels`, a pinned baseUrl). Mirrors the OAuth-401 replay
 * path in src/server/responses/core.ts, which spreads `route.provider` for the same reason.
 */
export function rotateProviderTransportOn429(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: RotateProviderTransportOptions = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn429(
    config,
    providerName,
    options.retryAfter,
    options.now,
    options.attemptedKey,
  );
  return rotated
    ? resolveProviderTransport(
        providerName,
        // Resolved, because this value goes straight into
        // `Authorization: Bearer …`. The pool stores what the config file says,
        // and `resolveProviderTransport` does not expand env references — so a
        // `${XAI_API_KEY}` pool entry used to be sent upstream as those twelve
        // literal characters, turning a recoverable 429 into a 401.
        { ...routedProvider, apiKey: resolveEnvValue(rotated.apiKey) },
        options.promptCacheKey,
      )
    : null;
}

/** Clear cooldown state for a provider (e.g. after manual key management). */
export function clearKeyCooldowns(providerName?: string): void {
  if (!providerName) {
    keyCooldowns.clear();
    return;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
}

/** Visible-for-testing: get the cooldown-until timestamp for a key. */
export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}
