/**
 * provider-workspace/types.ts — shared view-model types for the Providers
 * workspace shell/rail/detail (WP080a). Data shapes only; no React.
 */
import type { ProviderSortMode, WorkspaceItem } from "../../provider-workspace/catalog";
import type { AccountQuota } from "../../codex-quota-utils";

export type { ProviderSortMode, WorkspaceItem };

/**
 * Rail status facets (all on by default). `needsAttention` is the live-auth split of
 * the catalog's `needsSetup` bin — a configured provider whose active account needs
 * re-authentication, which is a different problem from one that was never set up.
 */
export type StatusFilter = { ready: boolean; needsSetup: boolean; needsAttention: boolean; disabled: boolean };

/** Rail pricing facets. */
export type PricingFilter = { free: boolean; paid: boolean };

/**
 * Rail type facets. `login` covers oauth/forward providers — deliberately NOT
 * named "account" to avoid colliding with the accounts TIER (canonical openai only).
 */
export type TypeFilter = { cloud: boolean; local: boolean; selfHosted: boolean; login: boolean };

/** Per-provider usage totals for the workspace overview (30d window). */
export interface ProviderUsageTotals {
  requests?: number;
  totalTokens?: number;
  /**
   * Server-computed per-provider lane subtotals (`src/usage/summary.ts`
   * buildProviders), carried so a panel's headline cost reads the server's own
   * subtotal instead of re-summing whatever model rows happen to be visible.
   * Absent on a pre-split remote proxy.
   */
  estimatedCostUsd?: number;
  /** Non-billing API-equivalent total; never summed with the direct figure. */
  apiEquivalentCostUsd?: number;
}

/** Per-model usage row from /api/usage, filtered by provider. */
export interface ProviderModelUsageRow {
  model: string;
  resolvedModel?: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
  /** Direct API-key spend. Absent for subscription/OAuth rows, which use the field below. */
  estimatedCostUsd?: number;
  /** Non-billing API-equivalent total for subscription/OAuth rows; never summed with the above. */
  apiEquivalentCostUsd?: number;
}

// Auth types consumed by ProviderAuthPanel (WP091).
export type OAuthAccountHealthStatus = "healthy" | "cooldown" | "reauth_required" | "warning";

export type OAuthAccountRow = {
  id: string;
  alias?: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
  health?: { status: OAuthAccountHealthStatus; reason?: string; until?: string };
  healthLabel?: string;
  healthSummary?: string;
  healthAction?: string;
  /** Per-account rate limits, for providers that report usage per credential (anthropic). */
  quota?: AccountQuota | null;
  quotaUnavailable?: boolean;
};

export type ApiKeyRow = {
  id: string;
  label?: string;
  masked: string;
  active: boolean;
};

export type LoginHint = {
  provider: string;
  url?: string;
  instructions?: string;
  deviceCode?: string;
};

export type AccountLoadState = "idle" | "loading" | "ready" | "error";

export interface ProviderAuthHandlers {
  onLogin: (provider: string, addAccount?: boolean) => void | Promise<void>;
  onCancelLogin?: (provider: string) => void;
  onLogout: (provider: string) => void | Promise<void>;
  onReauth: (provider: string, accountId?: string) => void | Promise<void>;
  onSwitchAccount: (provider: string, account: OAuthAccountRow) => void | Promise<void>;
  onRemoveAccount: (provider: string, account: OAuthAccountRow) => void | Promise<void>;
  onRetryAccounts?: (provider: string) => void | Promise<void>;
  onAddApiKey: (provider: string, key: string) => Promise<boolean>;
  onSwitchApiKey: (provider: string, entry: ApiKeyRow) => void | Promise<void>;
  onRemoveApiKey: (provider: string, entry: ApiKeyRow) => void | Promise<void>;
  onEditAlias: (provider: string, type: "oauth" | "api-key", id: string, current?: string) => void | Promise<void>;
}

export type ProviderUpdatePatch = {
  adapter?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
  apiKeyTransport?: "x-api-key" | "bearer" | "";
  authMode?: string;
  note?: string;
  disabled?: boolean;
  allowPrivateNetwork?: boolean;
  liveModels?: boolean;
};
