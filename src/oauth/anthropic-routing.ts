/**
 * Anthropic OAuth account pool (#294) — now a thin facade over the generic
 * per-provider engine in `provider-pool.ts`.
 *
 * The engine was extracted verbatim when the pool was generalized to all OAuth
 * providers ("auto account switcher like Codex"), so Anthropic's behaviour is
 * unchanged and its production mileage is what other providers inherit. Every
 * historical export keeps its name and signature: this file is the
 * compatibility surface for responses/core, claude-messages, the management
 * routes, and the tests that pinned the original semantics.
 *
 * Anthropic-specific facts that stay here:
 * - config home is `config.anthropicAccountPool` (predates the generic
 *   `providers[<name>].accountPool` surface);
 * - the rotation-state key keeps its historical value so persisted round-robin
 *   state survives the refactor.
 * Both are encoded inside the engine's config/rotation lookups.
 */

import type { OcxConfig } from "../types";
// From the leaf module, NOT from ./provider-pool: this alias is evaluated at module
// scope, and provider-pool is a cyclic partner whose consts are still in their
// temporal dead zone when the graph is entered through it. See pool-constants.ts.
import { OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST } from "./pool-constants";
import {
  bindOAuthSessionAffinity,
  canRefreshOAuthPoolAccount,
  clearOAuthAccountCooldown,
  clearOAuthPoolState,
  clearOAuthSessionAffinityForAccount,
  formatOAuthAccountOrdinal,
  getEligibleOAuthAccounts,
  getOAuthAccountHealthSnapshot,
  getOAuthPoolAccessToken,
  getOAuthPoolRetryAfterSeconds,
  isOAuthPoolEnabled,
  oauthPoolAutoSwitchThreshold,
  oauthPoolConfig,
  oauthSessionKeyFromParts,
  promoteOAuthActiveAccount,
  resetOAuthRoutingForManualSelection,
  resolveOAuthAccountForSession,
  rotateOAuthAccountOn429,
  type OAuthAccountPoolConfig,
  type OAuthAccountSelection,
  type OAuthAccountSelectionReason,
} from "./provider-pool";

const PROVIDER = "anthropic";

export const ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST = OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST;

export type AnthropicAccountPoolConfig = OAuthAccountPoolConfig;
export type AnthropicAccountSelectionReason = OAuthAccountSelectionReason;
export type AnthropicAccountSelection = OAuthAccountSelection;

export function anthropicAccountPoolConfig(config: OcxConfig): AnthropicAccountPoolConfig {
  return oauthPoolConfig(config, PROVIDER);
}

export function isAnthropicAccountPoolEnabled(config: OcxConfig): boolean {
  return isOAuthPoolEnabled(config, PROVIDER);
}

export function anthropicAutoSwitchThreshold(config: OcxConfig): number {
  return oauthPoolAutoSwitchThreshold(config, PROVIDER);
}

export function getAnthropicAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): ReturnType<typeof getOAuthAccountHealthSnapshot> {
  return getOAuthAccountHealthSnapshot(PROVIDER, accountId, now);
}

export function clearAnthropicAccountCooldown(accountId: string): boolean {
  return clearOAuthAccountCooldown(PROVIDER, accountId);
}

/** Test / logout helper. */
export function clearAnthropicAccountPoolState(): void {
  clearOAuthPoolState(PROVIDER);
}

export function getEligibleAnthropicAccounts(now = Date.now()): string[] {
  return getEligibleOAuthAccounts(PROVIDER, now);
}

/** Earliest remaining cooldown among cooled Anthropic accounts, for client Retry-After. */
export function getAnthropicPoolRetryAfterSeconds(now = Date.now()): number | null {
  return getOAuthPoolRetryAfterSeconds(PROVIDER, now);
}

export function resolveAnthropicAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): AnthropicAccountSelection {
  return resolveOAuthAccountForSession(PROVIDER, sessionKey, config, now);
}

export function bindAnthropicSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  bindOAuthSessionAffinity(PROVIDER, sessionKey, accountId, now);
}

export function clearAnthropicSessionAffinityForAccount(accountId: string): void {
  clearOAuthSessionAffinityForAccount(PROVIDER, accountId);
}

export function rotateAnthropicAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  return rotateOAuthAccountOn429(config, PROVIDER, failedAccountId, retryAfterHeader, sessionKey, now);
}

/** Promote dashboard active account after a validated failover target is usable. */
export function promoteAnthropicActiveAccount(accountId: string): void {
  promoteOAuthActiveAccount(PROVIDER, accountId);
}

export function resetAnthropicRoutingForManualSelection(accountId: string): void {
  resetOAuthRoutingForManualSelection(PROVIDER, accountId);
}

export function canRefreshAnthropicPoolAccount(accountId: string): boolean {
  return canRefreshOAuthPoolAccount(PROVIDER, accountId);
}

export async function getAnthropicPoolAccessToken(accountId: string): Promise<string> {
  return getOAuthPoolAccessToken(PROVIDER, accountId);
}

export function formatAnthropicAccountOrdinal(accountId: string): string {
  return formatOAuthAccountOrdinal(accountId);
}

export function formatAnthropicProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  _config?: OcxConfig,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatAnthropicAccountOrdinal(accountId)}`;
}

export const anthropicSessionKeyFromParts = oauthSessionKeyFromParts;
