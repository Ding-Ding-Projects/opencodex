/**
 * provider-catalog/provider-presets.ts
 *
 * Pure data owner for the add-provider catalog: the /api/provider-presets DTO
 * shape, tier classification (delegating to the provider-workspace catalog
 * predicates), search filtering, and deterministic sorting. No React, no fetch.
 */

import { providerTier, type ProviderTier, type WorkspaceProvider } from "../../provider-workspace/catalog";
import type { ProviderPayload } from "../../provider-payload";

/** Row shape returned by GET /api/provider-presets (mirrors DerivedProviderPreset). */
export interface CatalogPreset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  /** "oauth": account login · "forward": ChatGPT passthrough · "key": API key · "local": local scaffold. */
  auth: "oauth" | "forward" | "key" | "local";
  /** OAuth registry id (for auth === "oauth"). */
  oauthProvider?: string;
  /** Where to create/copy the API key (for auth === "key" catalog providers). */
  dashboardUrl?: string;
  note?: string;
  /** API key is optional — provider works without one (keyless free). */
  keyOptional?: boolean;
  /** Free pricing — may still require an API key (e.g. NVIDIA NIM). */
  freeTier?: boolean;
  /**
   * Endpoint picker (e.g. Qwen Cloud). Choice without `baseUrl` = Custom (show text field).
   */
  baseUrlChoices?: Array<{ id: string; label: string; baseUrl?: string }>;
  codexAccountMode?: "direct" | "pool";
  provider?: ProviderPayload;
}

/**
 * Adapt a preset row to the WorkspaceProvider shape the tier predicates expect
 * (preset `auth` ↔ config `authMode`; booleans normalized).
 */
export function presetTierInput(preset: CatalogPreset): WorkspaceProvider {
  return {
    adapter: preset.adapter,
    baseUrl: preset.baseUrl,
    authMode: preset.auth,
    freeTier: !!preset.freeTier,
    keyOptional: !!preset.keyOptional,
  };
}

/** Three-way tier for a catalog preset row (accounts wins over free; else paid). */
export function presetTier(preset: CatalogPreset): ProviderTier {
  return providerTier(preset.id, presetTierInput(preset));
}

/** Tab buckets for the catalog: accounts / free / paid, preserving input order per bucket. */
export function bucketPresets(presets: CatalogPreset[]): Record<ProviderTier, CatalogPreset[]> {
  const buckets: Record<ProviderTier, CatalogPreset[]> = { accounts: [], free: [], paid: [] };
  for (const preset of presets) buckets[presetTier(preset)].push(preset);
  return buckets;
}

/** Case-insensitive search across label and id only (never adapter/baseUrl). */
export function filterPresets(
  presets: CatalogPreset[],
  query: string,
  /**
   * How to test a preset against the query, when the caller offers more than
   * plain text. Optional so the plain-text behaviour stays the default for any
   * caller that has no regex opt-in to synchronize with.
   */
  matcher?: { test: (text: string) => boolean },
): CatalogPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return presets;
  // Label and id are tested as one string, so a pattern spanning both — or an
  // anchor — behaves the same way it does in every other search bar in the app.
  if (matcher) return presets.filter(p => matcher.test(`${p.label} ${p.id}`));
  return presets.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
}

