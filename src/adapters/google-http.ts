import type { AdapterFetchContext, AdapterRequest } from "./base";
import { isAntigravityGeoBlockedBody, isQuotaExhaustedBody, retryableGoogleStatus, safeGoogleHttpErrorMessage } from "./google-errors";
import { repairGoogleInvalidRequestBody } from "./google-wire-compiler";
import { normalizeUpstreamHttpErrorResponse, readDisplaySafeErrorPayloadText } from "./upstream-http-error";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  retryBackoffDelayMs,
  sleepWithAbort,
} from "../lib/upstream-retry";
import { recordAntigravityCooldown } from "../oauth/antigravity-routing";
import { antigravityHostCandidates } from "./google-antigravity-hosts";
import { resolveAntigravityBearerDestination } from "../providers/antigravity-trust";
import { recordOAuthAccountCooldown } from "../oauth/provider-pool";

const GOOGLE_RETRY_ATTEMPTS = 3;
const GOOGLE_RETRY_BASE_MS = 250;
const GOOGLE_RETRY_MAX_MS = 2_000;

function isAntigravitySseRequest(request: AdapterRequest): boolean {
  try {
    const url = new URL(request.url);
    return url.pathname.endsWith("/v1internal:streamGenerateContent") && url.searchParams.get("alt") === "sse";
  } catch {
    return false;
  }
}

function requestForHost(request: AdapterRequest, host: string): AdapterRequest {
  const current = new URL(request.url);
  const replacement = new URL(host);
  current.protocol = replacement.protocol;
  current.host = replacement.host;
  return { ...request, url: current.toString() };
}

function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp - now : undefined;
}

async function recordAntigravityHttpCooldown(response: Response, accountId: string | undefined): Promise<boolean> {
  if (!accountId || (response.status !== 429 && response.status !== 403)) return false;
  const payload = await readDisplaySafeErrorPayloadText(response.clone());
  if (response.status === 429) {
    const exhausted = isQuotaExhaustedBody(payload);
    const retry = retryAfterMs(response.headers.get("retry-after"));
    recordAntigravityCooldown(accountId, exhausted ? "quota_exhausted" : "rate_limited", retry);
    recordOAuthAccountCooldown("google-antigravity", accountId, response.headers.get("retry-after"), Date.now(), exhausted ? 24 * 60 * 60_000 : retry);
    return true;
  }
  if (isAntigravityGeoBlockedBody(payload)) {
    recordAntigravityCooldown(accountId, "geo_blocked");
    recordOAuthAccountCooldown("google-antigravity", accountId, null, Date.now(), 24 * 60 * 60_000);
    return true;
  }
  return false;
}

async function normalizeFinalGoogleError(label: string, res: Response, signal?: AbortSignal): Promise<Response> {
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText),
  });
}

/**
 * Fetch a Google-family upstream (Vertex / Antigravity) with Kiro-style hardening: per-attempt
 * timeout (`AbortSignal.any([parent, timeout])`), bounded retry on transient status / network
 * errors, `Retry-After` honoring, jittered exponential backoff, and a classified + redacted final
 * error body. `label` is the provider-facing prefix used in error messages.
 */
export async function fetchGoogleWithRetry(label: string, request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  let lastError: unknown;
  let activeRequest = request;
  const peers = label === "Antigravity" && isAntigravitySseRequest(request)
    ? antigravityHostCandidates(new URL(request.url).origin)
    : [];
  let peerAttempted = false;
  let compatibilityReplayUsed = false;
  for (let attempt = 0; attempt < GOOGLE_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      if (label === "Antigravity") await resolveAntigravityBearerDestination(activeRequest.url);
      const res = await fetchWithAttemptDeadline(activeRequest.url, {
        method: activeRequest.method,
        headers: activeRequest.headers,
        body: activeRequest.body,
      }, timeoutMs, ctx.abortSignal, ctx.stream);
      if (peers.length > 1 && !peerAttempted && (res.status === 404 || res.status === 503)) {
        peerAttempted = true;
        cancelResponseBodyBestEffort(res);
        activeRequest = requestForHost(request, peers[1]!);
        attempt--;
        continue;
      }
      if (label === "Antigravity" && await recordAntigravityHttpCooldown(res, ctx.accountId)) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      if (res.status === 400 && !compatibilityReplayUsed) {
        let payloadText = "";
        try {
          payloadText = await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal);
        } catch (error) {
          if (ctx.abortSignal?.aborted) throw error;
        }
        const repairedBody = repairGoogleInvalidRequestBody(activeRequest.body, payloadText);
        if (repairedBody !== undefined) {
          compatibilityReplayUsed = true;
          activeRequest = { ...activeRequest, body: repairedBody };
          cancelResponseBodyBestEffort(res);
          attempt--; // The changed-request replay is separate from transient retry accounting.
          continue;
        }
      }
      if (!retryableGoogleStatus(res.status) || attempt === GOOGLE_RETRY_ATTEMPTS - 1) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      // A 429 may be a transient rate limit (retry) or hard quota exhaustion (do NOT retry —
      // it won't recover for hours and burns retries). Peek the body to tell them apart.
      if (res.status === 429 && !ctx.returnRawErrors) {
        const peek = await readDisplaySafeErrorPayloadText(res, ctx.abortSignal);
        if (isQuotaExhaustedBody(peek)) {
          return normalizeUpstreamHttpErrorResponse(res, {
            signal: ctx.abortSignal,
            formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText || peek),
          });
        }
      }
      cancelResponseBodyBestEffort(res);
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
        headers: res.headers,
      }), ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      lastError = err;
      if (peers.length > 1 && !peerAttempted) {
        peerAttempted = true;
        activeRequest = requestForHost(request, peers[1]!);
        attempt--;
        continue;
      }
      if (attempt === GOOGLE_RETRY_ATTEMPTS - 1) throw err;
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
      }), ctx.abortSignal);
    }
  }
  throw lastError ?? new Error(`${label} fetch failed`);
}

/** Vertex AI retry wrapper. */
export function fetchVertexWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Vertex AI", request, ctx);
}

/** Antigravity (Cloud Code Assist) retry wrapper. */
export function fetchAntigravityWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Antigravity", request, ctx);
}
