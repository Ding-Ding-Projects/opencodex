import { filterCatalogVisibleModels, uniqueCatalogModelsForRawPublicList, visibleNativeSlugs, type CatalogModel } from "../codex/catalog";
import { nativeInputModalities, nativeReasoningEfforts } from "../codex/catalog/metadata";
import { isCodexAccountUsable } from "../codex/account-usability";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { getLoginStatus, isOAuthProvider } from "../oauth";
import { modelInList, type OcxConfig, type OcxProviderConfig } from "../types";
import { providerCodexAccountMode } from "../providers/registry";
import { routeModel } from "../router";
import { resolveWireProtocolOverride } from "../server/adapter-resolve";
import { buildApiAccessEndpoints, type BuildApiAccessEndpointsOptions } from "../server/management/api-access";
import { fetchAllModels } from "../server/management/shared";

export const GITHUB_COPILOT_DESKTOP_PURPOSE = "github-copilot-desktop" as const;
export const GITHUB_COPILOT_DESKTOP_SURFACE = "github-copilot-desktop" as const;

export type CopilotCapabilityState = "supported" | "unsupported";
export type CopilotReadinessReason =
  | "ready"
  | "provider-disabled"
  | "missing-credential"
  | "needs-reauthentication"
  | "direct-mode-unsupported"
  | "cursor-native-execution-unavailable"
  | "unresolved-route"
  | "unsupported-adapter";

export interface CopilotModelCapabilities {
  chat: CopilotCapabilityState;
  tools: CopilotCapabilityState;
  images: CopilotCapabilityState;
  reasoning: CopilotCapabilityState;
  structuredOutput: CopilotCapabilityState;
}

export interface CopilotModelProfile {
  id: string;
  provider: string;
  model: string;
  adapter: string;
  ready: boolean;
  reason: CopilotReadinessReason;
  capabilities: CopilotModelCapabilities;
  sidecars: string[];
  directModeExcluded: boolean;
  cursorNativeExecution: "unavailable";
}

export interface CopilotObservedRequestState {
  at: string;
  endpoint: "models" | "chat-completions";
  status: number;
  model?: string;
  provider?: string;
}

export interface CopilotProviderProfile {
  provider: string;
  configured: boolean;
  ready: boolean;
  reason: CopilotReadinessReason;
}

export interface CopilotDesktopProfileDto {
  purpose: typeof GITHUB_COPILOT_DESKTOP_PURPOSE;
  loopbackOnly: true;
  baseUrl: string;
  modelsEndpoint: string;
  chatCompletionsEndpoint: string;
  wireApi: "completions";
  directModeExcluded: true;
  sidecarDisclosure: string[];
  lastRequest: CopilotObservedRequestState | null;
  providers: CopilotProviderProfile[];
  models: CopilotModelProfile[];
}

let lastObservedRequest: CopilotObservedRequestState | null = null;

export function recordCopilotObservedRequest(state: Omit<CopilotObservedRequestState, "at">): void {
  lastObservedRequest = { at: new Date().toISOString(), ...state };
}

export function getCopilotObservedRequest(): CopilotObservedRequestState | null {
  return lastObservedRequest ? { ...lastObservedRequest } : null;
}

export function clearCopilotObservedRequestForTests(): void {
  lastObservedRequest = null;
}

export function copilotRouteReadiness(
  config: OcxConfig,
  providerName: string,
  provider: OcxProviderConfig,
): CopilotReadinessReason {
  if (provider.disabled === true) return "provider-disabled";
  if (providerName === "openai" && providerCodexAccountMode(providerName, provider) === "direct") {
    return "direct-mode-unsupported";
  }
  if (providerName === "openai") {
    const accountIds = [MAIN_CODEX_ACCOUNT_ID, ...(config.codexAccounts ?? []).map(account => account.id)];
    if (!accountIds.some(accountId => isCodexAccountUsable(config, accountId))) return "missing-credential";
  }
  // Cursor's native transport can receive server-driven local execution frames even while its
  // config says "off". A third-party Copilot client has no Cursor-native approval/sandbox channel,
  // so the adapter itself remains unavailable to this profile, not merely the opt-in execution mode.
  if (provider.adapter === "cursor") return "cursor-native-execution-unavailable";
  if (!["anthropic", "azure", "azure-openai", "google", "kiro", "mimo-free", "openai-chat", "openai-responses"].includes(provider.adapter)) {
    return "unsupported-adapter";
  }
  if (provider.authMode === "oauth" || isOAuthProvider(providerName)) {
    const status = getLoginStatus(providerName);
    if (status.accounts?.some(account => account.active && account.needsReauth)) return "needs-reauthentication";
    if (!status.loggedIn) return "missing-credential";
  } else if (provider.authMode !== "local" && provider.authMode !== "forward" && provider.keyOptional !== true) {
    if (typeof provider.apiKey !== "string" || provider.apiKey.trim().length === 0) return "missing-credential";
  }
  return "ready";
}

export function conservativeCopilotCapabilities(model: CatalogModel, provider: OcxProviderConfig): CopilotModelCapabilities {
  const adapterSupportsStructuredOutput = provider.adapter !== "openai-chat";
  return {
    chat: "supported",
    tools: provider.adapter === "mimo-free" ? "unsupported" : "supported",
    images: model.inputModalities?.includes("image") && !modelInList(provider.noVisionModels, model.id)
      ? "supported"
      : "unsupported",
    reasoning: Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
      && !modelInList(provider.noReasoningModels, model.id)
      ? "supported"
      : "unsupported",
    structuredOutput: adapterSupportsStructuredOutput ? "supported" : "unsupported",
  };
}

function sidecarsFor(model: CatalogModel, config: OcxConfig): string[] {
  const sidecars: string[] = [];
  const provider = config.providers[model.provider];
  if (provider && modelInList(provider.noVisionModels, model.id)) sidecars.push("vision");
  if (config.webSearchSidecar?.enabled !== false) sidecars.push("web-search-when-requested");
  return sidecars;
}

export function copilotModelProfile(
  config: OcxConfig,
  model: CatalogModel,
  publicId: string = model.alias ?? `${model.provider}/${model.id}`,
): CopilotModelProfile {
  try {
    const route = routeModel(config, publicId);
    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
    const effectiveReason = copilotRouteReadiness(config, route.providerName, route.provider);
    return {
      id: publicId,
      provider: route.providerName,
      model: route.modelId,
      adapter: route.provider.adapter,
      ready: effectiveReason === "ready",
      reason: effectiveReason,
      capabilities: conservativeCopilotCapabilities(model, route.provider),
      sidecars: sidecarsFor(model, config),
      directModeExcluded: route.codexAccountMode === "direct",
      cursorNativeExecution: "unavailable",
    };
  } catch {
    return {
      id: publicId,
      provider: model.provider,
      model: model.id,
      adapter: config.providers[model.provider]?.adapter ?? "unknown",
      ready: false,
      reason: "unresolved-route",
      capabilities: {
        chat: "unsupported",
        tools: "unsupported",
        images: "unsupported",
        reasoning: "unsupported",
        structuredOutput: "unsupported",
      },
      sidecars: sidecarsFor(model, config),
      directModeExcluded: false,
      cursorNativeExecution: "unavailable",
    };
  }
}

export async function buildCopilotDesktopProfile(
  config: OcxConfig,
  endpointOptions: BuildApiAccessEndpointsOptions = {},
): Promise<CopilotDesktopProfileDto> {
  const routed = uniqueCatalogModelsForRawPublicList(
    filterCatalogVisibleModels(await fetchAllModels(config), config),
  );
  const native: CatalogModel[] = [...visibleNativeSlugs(config)].map(id => ({
    id,
    provider: "openai",
    owned_by: "openai",
    inputModalities: nativeInputModalities(id),
    reasoningEfforts: nativeReasoningEfforts(id),
  }));
  const models = [...native, ...routed]
    .map(model => copilotModelProfile(config, model, model.provider === "openai" && !model.alias ? model.id : model.alias ?? `${model.provider}/${model.id}`))
    .sort((a, b) => a.id.localeCompare(b.id));
  const endpoints = buildApiAccessEndpoints({ ...config, hostname: "127.0.0.1" }, endpointOptions);
  return {
    purpose: GITHUB_COPILOT_DESKTOP_PURPOSE,
    loopbackOnly: true,
    baseUrl: endpoints.baseUrl,
    modelsEndpoint: endpoints.modelsEndpoint,
    chatCompletionsEndpoint: endpoints.chatCompletionsEndpoint,
    wireApi: "completions",
    directModeExcluded: true,
    sidecarDisclosure: ["Vision and web-search sidecars may run when configured and requested."],
    lastRequest: getCopilotObservedRequest(),
    providers: Object.entries(config.providers)
      .map(([providerName, provider]) => {
        const reason = copilotRouteReadiness(config, providerName, provider);
        return {
          provider: providerName,
          configured: true,
          ready: reason === "ready",
          reason,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider)),
    models,
  };
}

export function callableCopilotModels(models: CopilotModelProfile[]): Set<string> {
  return new Set(models.filter(model => model.ready && model.capabilities.chat === "supported").map(model => model.id));
}
