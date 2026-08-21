/**
 * Multi-key pool for key-auth providers (the API-key twin of OAuth multiauth).
 *
 * `provider.apiKey` stays the single source of truth for routing — it always mirrors the
 * ACTIVE pool entry, so the router/adapters never learn about the pool. The pool itself
 * lives in `provider.apiKeyPool` in config.json (same file that already holds apiKey).
 * A provider with a legacy bare `apiKey` is seeded into a one-entry pool on first touch.
 */
import { createHash } from "node:crypto";
import { saveConfigPreservingClaudeCode } from "../config";
import { createProviderVaultReference, deleteProviderVaultReference, isProviderVaultReference } from "../lib/provider-credentials";
import type { OcxConfig, OcxProviderConfig } from "../types";

export interface ProviderApiKeyInfo {
  id: string;
  label?: string;
  /** First/last 4 chars only; env references (`${VAR}`) are shown verbatim (not secrets). */
  masked: string;
  active: boolean;
  addedAt?: number;
}

function isEnvReference(value: string): boolean {
  return /^\$\{?\w+\}?$/.test(value);
}

export function maskApiKey(value: string): string {
  if (isProviderVaultReference(value)) return "vault reference (secret not in config)";
  if (isEnvReference(value)) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** Content-derived id: re-adding the same key upserts instead of duplicating. */
export function apiKeyPoolEntryId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** True for providers whose upstream auth is a configured API key (not oauth/forward). */
export function isKeyAuthProvider(provider: OcxProviderConfig): boolean {
  return provider.authMode !== "oauth" && provider.authMode !== "forward";
}

/** Trim and reject blank / CRLF-bearing secrets. Shared by pool writes and OAuth upsert. */
export function sanitizeApiKeyValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
}

/** Seed the pool from a legacy bare `apiKey`, and keep `apiKey` mirrored to the active entry. */
function ensurePool(provider: OcxProviderConfig): NonNullable<OcxProviderConfig["apiKeyPool"]> {
  if (!provider.apiKeyPool) provider.apiKeyPool = [];
  if (provider.apiKeyPool.length === 0 && provider.apiKey) {
    provider.apiKeyPool.push({ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey });
  }
  return provider.apiKeyPool;
}

function activeEntryId(provider: OcxProviderConfig): string | null {
  const pool = provider.apiKeyPool ?? [];
  if (pool.length === 0) return null;
  return (pool.find(e => e.key === provider.apiKey) ?? pool[0]!).id;
}

export function listProviderApiKeys(config: OcxConfig, name: string): { activeId: string | null; keys: ProviderApiKeyInfo[] } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { activeId: null, keys: [] };
  const pool = ensurePool(provider);
  const activeId = activeEntryId(provider);
  return {
    activeId,
    keys: pool.map(entry => ({
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      masked: maskApiKey(entry.key),
      active: entry.id === activeId,
      ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
    })),
  };
}

/** Add (or upsert) a key and make it ACTIVE. Persists config. */
export function addProviderApiKey(config: OcxConfig, name: string, key: string, label?: string): { id: string } | { error: string } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  if (typeof key !== "string" || !key.trim()) return { error: "key is required" };
  const trimmed = sanitizeApiKeyValue(key);
  if (!trimmed) return { error: "key must not include line breaks" };
  const pool = ensurePool(provider);
  let stored = trimmed;
  if (config.providerApiKeyVault === "windows") {
    try { stored = createProviderVaultReference(trimmed); }
    catch (error) { return { error: error instanceof Error ? `OS credential vault unavailable: ${error.message}` : "OS credential vault unavailable" }; }
  }
  const id = apiKeyPoolEntryId(stored);
  const existing = pool.find(e => e.id === id);
  if (existing) {
    if (label?.trim()) existing.label = label.trim();
  } else {
    pool.push({ id, key: stored, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
  }
  provider.apiKey = stored;
  saveConfigPreservingClaudeCode(config);
  return { id };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config. */
export function setActiveProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return false;
  provider.apiKey = entry.key;
  saveConfigPreservingClaudeCode(config);
  return true;
}

/** Rename a key slot without changing its id, secret, or active routing state. */
export function setProviderApiKeyLabel(config: OcxConfig, name: string, id: string, label: string | undefined): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return false;
  if (label) entry.label = label;
  else delete entry.label;
  saveConfigPreservingClaudeCode(config);
  return true;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config. */
export function removeProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const pool = ensurePool(provider);
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  if (isProviderVaultReference(entry.key)) deleteProviderVaultReference(entry.key);
  provider.apiKeyPool = pool.filter(e => e.id !== id);
  if (provider.apiKey === entry.key) {
    const next = provider.apiKeyPool[0];
    if (next) provider.apiKey = next.key;
    else delete provider.apiKey;
  }
  if (provider.apiKeyPool.length === 0) delete provider.apiKeyPool;
  saveConfigPreservingClaudeCode(config);
  return true;
}

/**
 * One-way, opt-in migration for legacy plaintext provider keys. Nothing is rewritten until
 * every secret has been accepted by the OS vault; a missing vault therefore leaves the original
 * config untouched and routing fails closed on the next request rather than guessing.
 */
export function migrateProviderApiKeysToVault(config: OcxConfig): { migrated: number; unavailable: boolean } {
  if (config.providerApiKeyVault !== "windows") return { migrated: 0, unavailable: false };
  const replacements: Array<{ provider: OcxProviderConfig; field: "apiKey" | "pool"; index?: number; ref: string }> = [];
  try {
    for (const provider of Object.values(config.providers)) {
      if (provider.apiKey && !isProviderVaultReference(provider.apiKey)) {
        replacements.push({ provider, field: "apiKey", ref: createProviderVaultReference(provider.apiKey) });
      }
      for (const [index, entry] of (provider.apiKeyPool ?? []).entries()) {
        if (!isProviderVaultReference(entry.key)) {
          replacements.push({ provider, field: "pool", index, ref: createProviderVaultReference(entry.key) });
        }
      }
    }
  } catch {
    for (const replacement of replacements) deleteProviderVaultReference(replacement.ref);
    return { migrated: 0, unavailable: true };
  }
  for (const replacement of replacements) {
    if (replacement.field === "apiKey") replacement.provider.apiKey = replacement.ref;
    else replacement.provider.apiKeyPool![replacement.index!]!.key = replacement.ref;
  }
  if (replacements.length > 0) saveConfigPreservingClaudeCode(config);
  return { migrated: replacements.length, unavailable: false };
}
