import type { OcxProviderConfig } from "../types";
import { assessUrlDestination } from "../lib/destination-policy";
import { getProviderRegistryEntry } from "./registry";

/**
 * Configuration-level provider status exposed to every management client.
 *
 * This deliberately answers "is this provider configured?", not "did the
 * upstream answer a live probe?". OAuth health and local-runtime reachability
 * are separate runtime signals; neither should turn a no-key provider into an
 * API-key setup prompt.
 */
export type ProviderConfigurationStatus = "ready" | "needs_setup" | "disabled";
export type ProviderConfigurationReason =
  | "disabled"
  | "key_optional"
  | "forward"
  | "oauth"
  | "local"
  | "loopback"
  | "vertex_auth"
  | "api_key"
  | "missing_api_key";

export interface ProviderConfigurationState {
  status: ProviderConfigurationStatus;
  reason: ProviderConfigurationReason;
}

export function providerHasConfiguredApiKey(provider: OcxProviderConfig): boolean {
  // This public configuration signal must depend only on config, never on whether
  // a guessed process environment variable exists. Resolving ${ENV_VAR} here would
  // turn unauthenticated management DTOs into a chosen-variable existence oracle.
  // The router resolves the value only at request time and reports a missing value
  // as a live authentication failure. Key-pool activation mirrors its selected key
  // into provider.apiKey, so arbitrary inactive pool entries remain excluded.
  return (provider.apiKey?.trim().length ?? 0) > 0;
}

export function providerUsesLoopbackEndpoint(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  const assessment = assessUrlDestination(provider.baseUrl);
  return assessment?.kind === "localhost" || assessment?.kind === "loopback";
}

export function providerConfigurationState(
  provider: OcxProviderConfig,
  providerName?: string,
): ProviderConfigurationState {
  if (provider.disabled === true) return { status: "disabled", reason: "disabled" };
  if (provider.keyOptional === true) return { status: "ready", reason: "key_optional" };
  const registryEntry = providerName ? getProviderRegistryEntry(providerName) : undefined;
  // Vertex accepts an express API key from config/environment or Application
  // Default Credentials. Those external credentials are runtime health, like an
  // OAuth login, and must not be probed or leaked through this public DTO. Mark
  // the transport configuration ready and let the explicit connection test report
  // a missing key, project/location, or ADC source with the adapter's real error.
  if ((provider.googleMode ?? registryEntry?.googleMode) === "vertex") {
    return { status: "ready", reason: "vertex_auth" };
  }
  if (provider.authMode === "forward") return { status: "ready", reason: "forward" };
  if (provider.authMode === "oauth") return { status: "ready", reason: "oauth" };
  if (provider.authMode === "local") return { status: "ready", reason: "local" };
  // An explicit key contract outranks endpoint location. Loopback gateways may
  // still require a credential; only legacy configs with no authMode get the
  // historical loopback-as-local compatibility rule below.
  if (provider.authMode === "key") {
    return providerHasConfiguredApiKey(provider)
      ? { status: "ready", reason: "api_key" }
      : { status: "needs_setup", reason: "missing_api_key" };
  }
  // Registry-local providers deliberately persist no authMode so their endpoint
  // can move from loopback to another explicitly allowed private-network host
  // without turning a keyless Ollama/vLLM/LM Studio setup into a fake API-key
  // requirement. Keep this after the explicit-key branch: a user-selected key
  // contract still wins even for a registry-local provider.
  if (registryEntry?.authKind === "local") {
    return { status: "ready", reason: "local" };
  }
  if (providerUsesLoopbackEndpoint(provider)) return { status: "ready", reason: "loopback" };
  if (providerHasConfiguredApiKey(provider)) return { status: "ready", reason: "api_key" };
  return { status: "needs_setup", reason: "missing_api_key" };
}
