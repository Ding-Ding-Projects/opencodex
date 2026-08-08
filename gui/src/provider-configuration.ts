/**
 * Public configuration-level provider state returned by the management API.
 *
 * This is deliberately not a live health result. A configured OAuth, forward,
 * local, or loopback provider is ready at the configuration layer even when an
 * upstream service is offline or a separate login-health check needs attention.
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
  configurationStatus: ProviderConfigurationStatus;
  configurationReason: ProviderConfigurationReason;
}

export function isProviderConfigurationState(value: unknown): value is ProviderConfigurationState {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ProviderConfigurationState>;
  const validStatus = row.configurationStatus === "ready"
    || row.configurationStatus === "needs_setup"
    || row.configurationStatus === "disabled";
  const validReason = row.configurationReason === "disabled"
    || row.configurationReason === "key_optional"
    || row.configurationReason === "forward"
    || row.configurationReason === "oauth"
    || row.configurationReason === "local"
    || row.configurationReason === "loopback"
    || row.configurationReason === "vertex_auth"
    || row.configurationReason === "api_key"
    || row.configurationReason === "missing_api_key";
  return validStatus && validReason;
}
