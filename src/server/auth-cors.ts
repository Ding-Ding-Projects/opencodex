import { timingSafeEqual } from "node:crypto";
import { formatErrorResponse } from "../bridge";
// Request admission follows the socket that is actually listening. During a
// restart the persisted bind and live bind can briefly disagree; the live one
// is the security boundary for an incoming packet.
import { getServerListenHostname } from "./lifecycle";
import {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  codexAutoStartEnabled,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
} from "../config";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../providers/registry";
import { providerConfigSeed } from "../providers/derive";
import type { DataPlaneApiKeyPurpose, OcxConfig, OcxProviderConfig } from "../types";
import { providerConfigurationState, providerHasConfiguredApiKey } from "../providers/setup-status";
import { openRouterRoutingConfigError } from "../providers/openrouter-routing";
import { modelAutoCompactTokenLimitsConfigError } from "../providers/auto-compact-budget";

let _corsOrigin = "http://localhost:10100";
export function setCorsOrigin(port: number): void { _corsOrigin = `http://localhost:${port}`; }
/** The proxy's own listening port. No admission check uses it: both loopback predicates key on hostname alone. */
export function configuredPort(): string {
  try { return new URL(_corsOrigin).port; } catch { return "10100"; }
}

export function parseHttpHost(value: string | null): { hostname: string; port: string } | null {
  if (!value) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return null;
  }
}

export function isLoopbackRequestHost(value: string | null): boolean {
  const parsed = parseHttpHost(value);
  if (!parsed) return true;
  // Loopback is a trust boundary by hostname, not by port. `ssh -L 20100:localhost:10100`
  // legitimately arrives as `Host: localhost:20100`, and refusing it took the whole /v1/*
  // data plane down with it, not just CORS. The sibling isLoopbackOriginValue() dropped its
  // own port check for the same reason in e4e06125b ("same-trust-boundary"). Port equality
  // was never the rebinding defense: a rebinding browser connects to the real port and sends
  // it verbatim, so the hostname check below is what rejected it then and now.
  //
  // Scope of that guarantee: it holds for Hosts `parseHttpHost` can parse. An unparseable
  // Host still returns true above — pre-existing behavior, not browser-reachable (a browser
  // composes Host from its own connection), and pinned by a characterization test in
  // tests/server-loopback-host-gate.test.ts. Tightening it is separate work.
  return isLoopbackHostname(parsed.hostname);
}

export function isLoopbackOriginValue(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isSameOriginAsRequest(req: Request, origin: string): boolean {
  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

export function isAllowedRequestOrigin(req: Request, config: OcxConfig): boolean {
  function isExtraAllowedOrigin(origin: string, cfg: OcxConfig): boolean {
    if (!cfg.corsAllowOrigins?.length) return false;
    return cfg.corsAllowOrigins.some(allowed => {
      try {
        return new URL(allowed).origin === new URL(origin).origin;
      } catch {
        return allowed === origin;
      }
    });
  }
  const origin = req.headers.get("Origin");
  if (!isApiAuthRequired(config)) {
    if (!isLoopbackRequestHost(req.headers.get("Host"))) return false;
    return !origin || isLoopbackOriginValue(origin) || isExtraAllowedOrigin(origin, config);
  }
  return !origin || isLoopbackOriginValue(origin) || isSameOriginAsRequest(req, origin) || isExtraAllowedOrigin(origin, config);
}

export function managementRequestOrigin(req: Request, config: OcxConfig): string | null {
  const host = req.headers.get("Host");
  const parsedHost = parseHttpHost(host);
  if (!host || !parsedHost) return null;
  if (!isApiAuthRequired(config) && !isLoopbackHostname(parsedHost.hostname)) return null;
  try {
    const protocol = new URL(req.url).protocol;
    if (protocol !== "http:" && protocol !== "https:") return null;
    return new URL(`${protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

export function isAllowedManagementOrigin(req: Request, config: OcxConfig): boolean {
  const requestOrigin = managementRequestOrigin(req, config);
  if (!requestOrigin) return false;
  const origin = req.headers.get("Origin");
  return !origin || origin === requestOrigin;
}

/**
 * Matches a `chrome-extension://`, `moz-extension://` or `edge-extension://`
 * origin — the only kind of Origin header a browser attaches to a fetch made
 * from an extension's own background/service-worker context, distinct from
 * every ordinary web page's `https://`/`http://` origin.
 */
const EXTENSION_ORIGIN_PATTERN = /^(?:chrome|moz|edge)-extension:\/\/[a-z0-9-]+$/i;

export function isExtensionOrigin(value: string | null): boolean {
  return !!value && EXTENSION_ORIGIN_PATTERN.test(value);
}

/**
 * The one widening of the management-origin gate: the opencodex browser
 * extension, and only the browser extension, may reach `/api/downloads/*`
 * even though its Origin is not the dashboard's own.
 *
 * This is safe to widen — rather than a hole in the CORS story the rest of the
 * management plane relies on — for two reasons that both have to hold:
 *
 * 1. An ordinary web page can never forge this. `chrome-extension://<id>` is a
 *    browser-assigned origin no page-context `fetch()` can set; only code
 *    actually running as that installed extension's own background/service
 *    worker sends it. A hostile page's `fetch()` to this same URL still
 *    carries the page's real `https://` origin and is rejected exactly as
 *    before by `isAllowedManagementOrigin`.
 * 2. It only ever widens who may be ANSWERED, never who may reach the
 *    process at all: the request still has to land on a loopback-bound
 *    listener (`isLoopbackRequestHost`), which is the same boundary
 *    `requireLoopbackListener` re-checks inside the handler for every route
 *    that writes to the local filesystem.
 */
export function isAllowedDownloadCaptureOrigin(req: Request, config: OcxConfig): boolean {
  if (!isExtensionOrigin(req.headers.get("Origin"))) return false;
  if (isApiAuthRequired(config)) return false; // Non-loopback bind: no extension-origin exception.
  return isLoopbackRequestHost(req.headers.get("Host"));
}

export function browserSecurityHeaders(scriptNonce?: string): Record<string, string> {
  const scriptSources = ["'self'", ...(scriptNonce ? [`'nonce-${scriptNonce}'`] : [])].join(" ");
  return {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      `script-src ${scriptSources}`,
      // The React surface uses style props extensively; scripts still receive no
      // unsafe-inline escape hatch and every production script is same-origin.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  };
}

export function corsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const origin = req?.headers.get("Origin");
  const allowOrigin = origin && req && config && isAllowedRequestOrigin(req, config) ? origin : _corsOrigin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    // ChatGPT-Account-Id is required for browser/Electron ChatGPT & Codex App voice preflights
    // (direct forward auth matches the bearer to this account id). The OpenAI-Alpha .. X-OAI-Attestation
    // block covers GPT-Live voice protocol headers relayed by the /v1/live call-create path.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenCodex-API-Key, X-Api-Key, Anthropic-Version, Anthropic-Beta, ChatGPT-Account-Id, OpenAI-Alpha, X-Session-Id, Session-Id, Thread-Id, Originator, X-OAI-Attestation",
    "Vary": "Origin",
    ...browserSecurityHeaders(),
  };
}

export function managementCorsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const headers = corsHeaders();
  const origin = req?.headers.get("Origin");
  if (origin && req && config && isAllowedManagementOrigin(req, config)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function withCors(response: Response, req: Request, config: OcxConfig): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(req, config))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function withManagementCors(response: Response, req: Request, config: OcxConfig): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(managementCorsHeaders(req, config))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(data: unknown, status = 200, req?: Request, config?: OcxConfig): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req, config) },
  });
}

export function configuredApiAuthToken(_config: OcxConfig): string | undefined {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  return token || undefined;
}

export function configuredAdminAuthToken(): string | undefined {
  const token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
  return token || undefined;
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  // A fully-qualified "localhost." is the same host as "localhost": curl and some clients
  // send the trailing dot verbatim, and refusing it 403s a legitimate loopback caller.
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase().replace(/\.$/, "");
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isApiAuthRequired(config: OcxConfig): boolean {
  if (isApiAuthRequiredByConfig(config)) return true;
  const live = getServerListenHostname();
  return live !== undefined && !isLoopbackHostname(live);
}

/** Configuration intent used immediately before opening a new socket. */
export function isApiAuthRequiredByConfig(config: OcxConfig): boolean {
  return !isLoopbackHostname(config.hostname);
}

export function assertServerAuthConfig(config: OcxConfig): void {
  const hasConfiguredDataCredential = !!configuredApiAuthToken(config)
    || (config.apiKeys ?? []).some(entry => entry.purpose === undefined && !!entry.key.trim());
  if (isApiAuthRequiredByConfig(config) && !hasConfiguredDataCredential) {
    throw new Error(
      "A data-plane credential (OPENCODEX_API_AUTH_TOKEN or config.apiKeys) is required when binding opencodex to a non-loopback hostname",
    );
  }
}

function secretEquals(actual: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const enc = new TextEncoder();
  const actualBytes = enc.encode(actual);
  const expectedBytes = enc.encode(expected);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export type DataPlaneCredentialChannel = "x-opencodex-api-key" | "authorization" | "x-api-key";

export interface ClassifiedDataPlaneCredential {
  channel: DataPlaneCredentialChannel;
  source: "environment" | "configured";
  keyId?: string;
  purpose?: DataPlaneApiKeyPurpose;
}

function requestCredentials(req: Request): Array<{ channel: DataPlaneCredentialChannel; value: string }> {
  const candidates: Array<{ channel: DataPlaneCredentialChannel; value: string }> = [];
  const dedicated = req.headers.get("x-opencodex-api-key")?.trim();
  if (dedicated) candidates.push({ channel: "x-opencodex-api-key", value: dedicated });
  const authorization = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (authorization) candidates.push({ channel: "authorization", value: authorization });
  const apiKey = req.headers.get("x-api-key")?.trim();
  if (apiKey) candidates.push({ channel: "x-api-key", value: apiKey });
  return candidates;
}

/** Classify a recognized data-plane credential without returning or retaining its secret. */
export function classifyDataPlaneCredential(req: Request, config: OcxConfig): ClassifiedDataPlaneCredential | null {
  const candidates = requestCredentials(req);
  if (candidates.length === 0) return null;

  // A purpose credential in ANY accepted channel activates the stricter profile. This prevents a
  // second generic admission header from masking a purpose bearer and letting Direct mode treat it
  // as upstream ChatGPT identity. Compare every candidate to every scoped key before generic
  // precedence; only the exact approved purpose literal is recognized.
  let scopedMatch: { channel: DataPlaneCredentialChannel; keyId: string } | null = null;
  for (const candidate of candidates) {
    for (const entry of config.apiKeys ?? []) {
      const matches = secretEquals(candidate.value, entry.key);
      if (matches && entry.purpose === "github-copilot-desktop" && scopedMatch === null) {
        scopedMatch = { channel: candidate.channel, keyId: entry.id };
      }
    }
  }
  if (scopedMatch) {
    return {
      channel: scopedMatch.channel,
      source: "configured",
      keyId: scopedMatch.keyId,
      purpose: "github-copilot-desktop",
    };
  }

  // Preserve the established dedicated-header → bearer → x-api-key precedence for generic keys.
  for (const candidate of candidates) {
    if (secretEquals(candidate.value, configuredApiAuthToken(config))) {
      return { channel: candidate.channel, source: "environment" };
    }
    for (const entry of config.apiKeys ?? []) {
      if (secretEquals(candidate.value, entry.key)) {
        return { channel: candidate.channel, source: "configured", keyId: entry.id };
      }
    }
  }
  return null;
}

/** Whether `token` is a data-plane admission secret valid for the current bind. */
export function isDataPlaneAdmissionSecret(token: string, config: OcxConfig): boolean {
  const actual = token.trim();
  if (!actual) return false;
  if (secretEquals(actual, configuredApiAuthToken(config))) return true;
  for (const entry of config.apiKeys ?? []) {
    if (entry.purpose !== undefined && isApiAuthRequired(config)) continue;
    if (secretEquals(actual, entry.key)) return true;
  }
  return false;
}

/** Whether `token` is the environment-provided management secret. */
export function isManagementAdmissionSecret(token: string): boolean {
  const actual = token.trim();
  return !!actual && secretEquals(actual, configuredAdminAuthToken());
}

/** Whether `token` is one of the proxy's own admission secrets and must never reach an upstream. */
export function isProxyAdmissionSecret(token: string, config: OcxConfig): boolean {
  const actual = token.trim();
  if (!actual) return false;
  if (/^ocx_(?:data|admin|session)_/.test(actual) || /^ocx_[0-9a-f]{40}$/.test(actual)) return true;
  return isDataPlaneAdmissionSecret(actual, config) || isManagementAdmissionSecret(actual);
}

export class ForwardAdmissionCredentialError extends Error {
  constructor() {
    super("OpenCodex admission credentials cannot be forwarded upstream");
    this.name = "ForwardAdmissionCredentialError";
  }
}

export function validateForwardAdmissionCredential(headers: Headers, config: OcxConfig): void {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer && isProxyAdmissionSecret(bearer, config)) throw new ForwardAdmissionCredentialError();
}

export function hasValidApiAuth(req: Request, config: OcxConfig): boolean {
  if (!isApiAuthRequired(config)) return true;
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    // Anthropic-SDK clients (Claude Code with ANTHROPIC_API_KEY) authenticate via x-api-key.
    || req.headers.get("x-api-key")?.trim();
  if (!actual) return false;
  return isDataPlaneAdmissionSecret(actual, config);
}

export function requireApiAuth(req: Request, config: OcxConfig, _kind: "data-plane"): Response | null {
  if (hasValidApiAuth(req, config)) return null;
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

/**
 * Admission for OpenAI Responses transports whose Authorization header belongs to
 * Codex Direct. Remote binds must use the dedicated proxy header so the two bearer
 * domains can never be confused.
 */
export function requireResponsesApiAuth(req: Request, config: OcxConfig): Response | null {
  if (!isApiAuthRequired(config)) return null;
  const actual = req.headers.get("x-opencodex-api-key")?.trim();
  if (actual && isDataPlaneAdmissionSecret(actual, config)) return null;
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

const FORBIDDEN_PROVIDER_RUNTIME_FIELDS = [
  "virtualModels", "codexAuthContext", "selectedForwardHeaders",
  "sidecarOutcomeRecorder", "_codexAccountOverride", "_codexAccountRequired",
] as const;

function sameCanonicalProviderSeed(actual: Record<string, unknown>, expected: OcxProviderConfig): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) return false;
  return actualKeys.every(key => JSON.stringify(actual[key]) === JSON.stringify((expected as unknown as Record<string, unknown>)[key]));
}

export function providerManagementConfigError(name: unknown, provider: unknown): string | null {
  if (typeof name !== "string" || !provider || typeof provider !== "object" || Array.isArray(provider)) {
    return "provider must be a plain object";
  }
  const raw = provider as Record<string, unknown>;
  for (const field of FORBIDDEN_PROVIDER_RUNTIME_FIELDS) {
    if (Object.hasOwn(raw, field)) return `provider ${name} must not include runtime field "${field}"`;
  }
  if (name === "chatgpt") return "provider chatgpt is reserved for internal credential compatibility";
  if (name === "openai-multi") return "provider openai-multi is reserved for legacy config migration";
  if (name === "openai") {
    const entry = getProviderRegistryEntry(name);
    const seed = entry ? providerConfigSeed(entry) : undefined;
    if (!Object.hasOwn(raw, "codexAccountMode") || (raw.codexAccountMode !== "pool" && raw.codexAccountMode !== "direct")) {
      return "provider openai codexAccountMode must be pool or direct";
    }
    if (seed) seed.codexAccountMode = raw.codexAccountMode;
    // The per-model soft budget is a user-owned lowering overlay, not part of the
    // canonical transport seed for the built-in OpenAI provider.
    const canonicalRaw = { ...raw };
    delete canonicalRaw.modelAutoCompactTokenLimits;
    const canonical = seed && sameCanonicalProviderSeed(canonicalRaw, seed);
    if (!canonical) {
      return `provider ${name} must equal the canonical built-in provider seed`;
    }
  } else if (Object.hasOwn(raw, "codexAccountMode")) {
    return `provider ${name} must not include codexAccountMode`;
  }
  const typed = provider as unknown as OcxProviderConfig;
  const baseUrlError = providerBaseUrlConfigError(typed.baseUrl);
  if (baseUrlError) return `provider ${name} ${baseUrlError}`;
  const destinationError = providerDestinationConfigError(name, typed);
  if (destinationError) return `provider ${name} ${destinationError}`;
  const headersError = providerHeadersConfigError(typed.headers);
  if (headersError) return `provider ${name} ${headersError}`;
  const apiKeyTransportError = apiKeyTransportConfigError(typed);
  if (apiKeyTransportError) return `provider ${name} ${apiKeyTransportError}`;
  const maxInputError = positiveIntegerRecordConfigError(raw.modelMaxInputTokens, "modelMaxInputTokens");
  if (maxInputError) return `provider ${name} ${maxInputError}`;
  const autoCompactError = modelAutoCompactTokenLimitsConfigError(raw.modelAutoCompactTokenLimits, { requireNativeIds: name === "openai" });
  if (autoCompactError) return `provider ${name} ${autoCompactError}`;
  const reasoningSummariesError = booleanRecordConfigError(raw.modelSupportsReasoningSummaries, "modelSupportsReasoningSummaries");
  if (reasoningSummariesError) return `provider ${name} ${reasoningSummariesError}`;
  const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
    raw.modelReasoningSummaryDelivery,
    raw.modelSupportsReasoningSummaries,
  );
  if (reasoningSummaryDeliveryError) return `provider ${name} ${reasoningSummaryDeliveryError}`;
  const modelAdaptersError = modelAdapterRecordConfigError(raw.modelAdapters, "modelAdapters", name, typed);
  if (modelAdaptersError) return `provider ${name} ${modelAdaptersError}`;
  const defaultMaxOutputError = positiveIntegerConfigError(raw.defaultMaxOutputTokens, "defaultMaxOutputTokens");
  if (defaultMaxOutputError) return `provider ${name} ${defaultMaxOutputError}`;
  const maxOutputError = positiveIntegerRecordConfigError(raw.modelMaxOutputTokens, "modelMaxOutputTokens");
  if (maxOutputError) return `provider ${name} ${maxOutputError}`;
  const openRouterError = openRouterRoutingConfigError(typed);
  if (openRouterError) return `provider ${name} ${openRouterError}`;
  if (typed.authMode === "local") {
    // "local" bypasses key-requirement enforcement (api-keys/key-failover treat non-oauth/
    // forward as key auth; openai-chat skips credential checks for local). Only providers
    // whose registry entry is genuinely local (Ollama/vLLM/LM Studio) may claim it.
    const entry = getProviderRegistryEntry(name);
    if (entry && entry.authKind !== "local") {
      return `provider ${name} cannot use authMode "local" — its registry entry requires ${entry.authKind} auth`;
    }
  }
  if (typed.authMode === "forward") {
    const normalizedName = name.trim().toLowerCase();
    const base = typed.baseUrl.replace(/\/+$/, "");
    const isBuiltInChatGptForward = normalizedName === "openai"
      && typed.adapter === "openai-responses"
      && base === "https://chatgpt.com/backend-api/codex";
    if (isBuiltInChatGptForward) return null;
    return `provider ${name} uses reserved authMode "forward"; configure ChatGPT passthrough via the built-in provider`;
  }
  return null;
}

export function publicProviderBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "(invalid URL)";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "");
  } catch {
    return "(invalid URL)";
  }
}

export function copyIfDefined<K extends keyof OcxProviderConfig>(
  out: Record<string, unknown>,
  provider: OcxProviderConfig,
  key: K,
): void {
  const value = provider[key];
  if (value !== undefined) out[key as string] = value as unknown;
}

export function safeConfigDTO(config: OcxConfig): unknown {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    const configuration = providerConfigurationState(provider, name);
    const dto: Record<string, unknown> = {
      adapter: provider.adapter,
      baseUrl: publicProviderBaseUrl(provider.baseUrl),
      hasApiKey: providerHasConfiguredApiKey(provider),
      hasHeaders: !!provider.headers && Object.keys(provider.headers).length > 0,
      configurationStatus: configuration.status,
      configurationReason: configuration.reason,
    };
    for (const key of [
      "defaultModel",
      "disabled",
      "allowPrivateNetwork",
      "authMode",
      "apiKeyTransport",
      "keyOptional",
      "freeTier",
      "liveModels",
      "models",
      "contextWindow",
      "modelContextWindows",
      "modelAutoCompactTokenLimits",
      "defaultMaxOutputTokens",
      "modelMaxOutputTokens",
      "openRouterRouting",
      "modelOpenRouterRouting",
      "reasoningEfforts",
      "modelReasoningEfforts",
      "noVisionModels",
      "noReasoningModels",
      "noTemperatureModels",
      "noTopPModels",
      "noPenaltyModels",
      "autoToolChoiceOnlyModels",
      "preserveReasoningContentModels",
      "escapeBuiltinToolNames",
    ] as const) {
      copyIfDefined(dto, provider, key);
    }
    const registryNote = getProviderRegistryEntry(name)?.note;
    if (typeof registryNote === "string" && registryNote.trim()) dto.note = registryNote;
    const codexAccountMode = providerCodexAccountMode(name, provider);
    if (codexAccountMode) dto.codexAccountMode = codexAccountMode;
    providers[name] = dto;
  }
  return {
    port: config.port,
    hostname: config.hostname ?? "127.0.0.1",
    defaultProvider: config.defaultProvider,
    codexAutoStart: codexAutoStartEnabled(config),
    websockets: config.websockets,
    providers,
  };
}
