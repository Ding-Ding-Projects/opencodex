export type ApiKeyPurpose = "github-copilot-desktop";

export interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  purpose?: ApiKeyPurpose;
}

export type CopilotCapabilityState = "supported" | "unsupported";

export interface CopilotModelProfile {
  id: string;
  provider: string;
  model: string;
  adapter: string;
  ready: boolean;
  reason: string;
  capabilities: {
    chat: CopilotCapabilityState;
    tools: CopilotCapabilityState;
    images: CopilotCapabilityState;
    reasoning: CopilotCapabilityState;
    structuredOutput: CopilotCapabilityState;
  };
  sidecars: string[];
  directModeExcluded: boolean;
  cursorNativeExecution: "unavailable";
}

export interface CopilotDesktopProfile {
  purpose: ApiKeyPurpose;
  loopbackOnly: true;
  baseUrl: string;
  modelsEndpoint: string;
  chatCompletionsEndpoint: string;
  wireApi: "completions";
  directModeExcluded: true;
  sidecarDisclosure: string[];
  lastRequest: {
    at: string;
    endpoint: "models" | "chat-completions";
    status: number;
    model?: string;
    provider?: string;
  } | null;
  providers: Array<{ provider: string; configured: boolean; ready: boolean; reason: string }>;
  models: CopilotModelProfile[];
}

export interface ApiEndpointInfo {
  baseUrl: string;
  responses: string;
  chatCompletions: string;
  messages: string;
  models: string;
}

export type ModelTestState = "idle" | "testing" | "ok" | "error";

export const DEFAULT_ENDPOINTS: ApiEndpointInfo = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

export function deriveApiEndpoints(endpoint: string): ApiEndpointInfo {
  const responses = endpoint || DEFAULT_ENDPOINTS.responses;
  const match = responses.match(/^(.*)\/v1\/responses\/?$/);
  const baseUrl = match ? `${match[1]}/v1` : responses.replace(/\/responses\/?$/, "");
  return {
    baseUrl,
    responses,
    chatCompletions: `${baseUrl}/chat/completions`,
    messages: `${baseUrl}/messages`,
    models: `${baseUrl}/models`,
  };
}

export function formatCreatedDate(iso: string, localeTag?: string): string {
  return new Date(iso).toLocaleDateString(localeTag);
}
