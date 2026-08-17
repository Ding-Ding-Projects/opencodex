/**
 * Bounded HTTP client for Ollama's documented local runtime API.
 *
 * Every route this file calls is one Ollama documents at
 * https://github.com/ollama/ollama/blob/main/docs/api.md: `GET /` (liveness),
 * `GET /api/version`, `GET /api/tags`, `GET /api/ps`, `POST /api/show`,
 * `DELETE /api/delete`. Nothing here reaches an unofficial proxy or an
 * embedded cloud service, and every request stays on this machine — see
 * `resolveOllamaBaseUrl` below for the loopback boundary.
 *
 * Every call is timeout-bounded, size-bounded, and never follows a redirect —
 * the same shape `src/server/management/schedule-routes.ts` already uses for
 * its own outbound calls, so this file does not invent a new trust model.
 */

import { detectOllamaExecutable } from "./executable-detect";
import { assessUrlDestination } from "../destination-policy";
import type { OllamaHealthResult, OllamaModelDetails, OllamaRunningEntry, OllamaShowInfo, OllamaTagEntry } from "./types";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const HEALTH_TIMEOUT_MS = 1_500;
const READ_TIMEOUT_MS = 4_000;
const SHOW_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // a tags/show payload is small JSON; 4 MiB is generous headroom, not a promise this is unbounded

/**
 * Resolves the base URL to talk to, honouring Ollama's own `OLLAMA_HOST`
 * client convention (`host:port`, no scheme) when it names a loopback
 * address, and falling back to the documented default otherwise. A
 * non-loopback `OLLAMA_HOST` is deliberately never trusted here — this
 * manager only ever reaches the *local* runtime — and the caller is told why
 * via `hostWarning` so the fallback is never silent.
 */
export function resolveOllamaBaseUrl(): { baseUrl: string; hostWarning: string | null } {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return { baseUrl: DEFAULT_OLLAMA_BASE_URL, hostWarning: null };
  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const assessment = assessUrlDestination(candidate);
  if (!assessment) {
    return { baseUrl: DEFAULT_OLLAMA_BASE_URL, hostWarning: `OLLAMA_HOST (${raw}) is not a valid URL and was ignored` };
  }
  if (assessment.kind === "loopback" || assessment.kind === "localhost") {
    return { baseUrl: candidate.replace(/\/$/, ""), hostWarning: null };
  }
  return {
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    hostWarning: `OLLAMA_HOST (${raw}) does not point at a local address and was ignored; the local runtime manager only ever talks to the loopback interface`,
  };
}

async function readBounded(response: Response, limit: number): Promise<string | null> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) { void reader.cancel(); return null; }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

export type OllamaFetchFailure =
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "network"; error: string }
  | { kind: "http"; status: number }
  | { kind: "too-large" }
  | { kind: "malformed"; error: string };

export type OllamaFetchOutcome<T> = { ok: true; data: T } | { ok: false; failure: OllamaFetchFailure };

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return chain;
}

/** True when any error in the chain looks like "nobody is listening on that port". */
export function isConnectionRefused(error: unknown): boolean {
  return errorChain(error).some(item => {
    const code = (item as Error & { code?: unknown }).code;
    if (code === "ECONNREFUSED") return true;
    return item.message.toLowerCase().includes("connection refused") || item.message.toLowerCase().includes("econnrefused");
  });
}

function isTimeoutError(error: unknown): boolean {
  return errorChain(error).some(item => item.name === "AbortError" || item.name === "TimeoutError");
}

async function ollamaFetch(baseUrl: string, path: string, init: RequestInit, timeoutMs: number): Promise<OllamaFetchOutcome<string>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) return { ok: false, failure: { kind: "timeout" } };
    if (isConnectionRefused(error)) return { ok: false, failure: { kind: "refused" } };
    return { ok: false, failure: { kind: "network", error: error instanceof Error ? error.message : "network request failed" } };
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { ok: false, failure: { kind: "http", status: response.status } };
  }
  if (!response.ok) return { ok: false, failure: { kind: "http", status: response.status } };
  const text = await readBounded(response, MAX_RESPONSE_BYTES);
  if (text === null) return { ok: false, failure: { kind: "too-large" } };
  return { ok: true, data: text };
}

async function ollamaFetchJson<T>(baseUrl: string, path: string, init: RequestInit, timeoutMs: number): Promise<OllamaFetchOutcome<T>> {
  const result = await ollamaFetch(baseUrl, path, init, timeoutMs);
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.data) as T };
  } catch {
    return { ok: false, failure: { kind: "malformed", error: "response was not valid JSON" } };
  }
}

/**
 * `GET /` then `GET /api/version` — the two-step liveness probe.
 *
 * `missing` vs `stopped` is decided by a real executable check
 * (`detectOllamaExecutable`), never guessed: a connection refusal alone only
 * proves the daemon is not answering, not that it was never installed.
 */
export async function checkOllamaHealth(baseUrlOverride?: string): Promise<OllamaHealthResult> {
  const checkedAt = Date.now();
  const resolved = resolveOllamaBaseUrl();
  const baseUrl = baseUrlOverride ?? resolved.baseUrl;

  const root = await ollamaFetch(baseUrl, "/", { method: "GET" }, HEALTH_TIMEOUT_MS);
  if (!root.ok) {
    if (root.failure.kind === "refused") {
      // A positive "not-found" is the only signal strong enough to claim "missing" —
      // "unknown" (the check itself failed) still reports "stopped", the more
      // conservative of the two, rather than asserting an absence we could not verify.
      const executable = await detectOllamaExecutable();
      if (executable === "not-found") {
        return {
          state: "missing", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt,
          detail: "no ollama executable was found on this machine, and the runtime is not answering",
        };
      }
      return {
        state: "stopped", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt,
        detail: "the runtime refused the connection — it is installed but not currently running",
      };
    }
    if (root.failure.kind === "timeout") {
      return { state: "unhealthy", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt, detail: "the runtime did not respond in time" };
    }
    if (root.failure.kind === "http") {
      return { state: "unhealthy", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt, detail: `the runtime answered with HTTP ${root.failure.status}` };
    }
    if (root.failure.kind === "too-large") {
      return { state: "unhealthy", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt, detail: "the runtime's response exceeded the size limit" };
    }
    return { state: "offline", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt, detail: root.failure.kind === "network" ? root.failure.error : "the runtime could not be reached" };
  }

  const version = await ollamaFetchJson<{ version?: unknown }>(baseUrl, "/api/version", { method: "GET" }, HEALTH_TIMEOUT_MS);
  if (!version.ok || typeof version.data.version !== "string" || !version.data.version) {
    return { state: "unhealthy", baseUrl, version: null, hostWarning: resolved.hostWarning, checkedAt, detail: "the runtime is reachable but /api/version did not answer correctly" };
  }
  return { state: "healthy", baseUrl, version: version.data.version, hostWarning: resolved.hostWarning, checkedAt, detail: "the runtime is running and answering normally" };
}

interface RawTagDetails {
  format?: unknown; family?: unknown; families?: unknown; parameter_size?: unknown; quantization_level?: unknown;
}
interface RawTagEntry {
  name?: unknown; model?: unknown; modified_at?: unknown; size?: unknown; digest?: unknown; details?: RawTagDetails;
}

function readDetails(raw: RawTagDetails | undefined): OllamaModelDetails {
  return {
    format: typeof raw?.format === "string" ? raw.format : null,
    family: typeof raw?.family === "string" ? raw.family : null,
    families: Array.isArray(raw?.families) ? raw.families.filter((f): f is string => typeof f === "string") : null,
    parameterSize: typeof raw?.parameter_size === "string" ? raw.parameter_size : null,
    quantizationLevel: typeof raw?.quantization_level === "string" ? raw.quantization_level : null,
  };
}

/** `GET /api/tags` — every model tag installed on this machine, exhaustively (no client-side filtering). */
export async function fetchOllamaTags(baseUrl: string): Promise<OllamaFetchOutcome<OllamaTagEntry[]>> {
  const result = await ollamaFetchJson<{ models?: RawTagEntry[] }>(baseUrl, "/api/tags", { method: "GET" }, READ_TIMEOUT_MS);
  if (!result.ok) return result;
  const models = Array.isArray(result.data.models) ? result.data.models : [];
  const entries: OllamaTagEntry[] = models
    .filter((m): m is RawTagEntry & { name: string } => typeof m?.name === "string" && m.name.length > 0)
    .map(m => ({
      name: m.name,
      model: typeof m.model === "string" ? m.model : m.name,
      modifiedAt: typeof m.modified_at === "string" ? m.modified_at : null,
      sizeBytes: typeof m.size === "number" && Number.isFinite(m.size) ? m.size : null,
      digest: typeof m.digest === "string" ? m.digest : null,
      details: readDetails(m.details),
    }));
  return { ok: true, data: entries };
}

interface RawRunningEntry {
  name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown; expires_at?: unknown;
}

/** `GET /api/ps` — models currently loaded into memory, so the catalogue can mark them running. */
export async function fetchOllamaRunning(baseUrl: string): Promise<OllamaFetchOutcome<OllamaRunningEntry[]>> {
  const result = await ollamaFetchJson<{ models?: RawRunningEntry[] }>(baseUrl, "/api/ps", { method: "GET" }, READ_TIMEOUT_MS);
  if (!result.ok) return result;
  const models = Array.isArray(result.data.models) ? result.data.models : [];
  const entries: OllamaRunningEntry[] = models
    .filter((m): m is RawRunningEntry & { name: string } => typeof m?.name === "string" && m.name.length > 0)
    .map(m => ({
      name: m.name,
      model: typeof m.model === "string" ? m.model : m.name,
      sizeBytes: typeof m.size === "number" && Number.isFinite(m.size) ? m.size : null,
      sizeVramBytes: typeof m.size_vram === "number" && Number.isFinite(m.size_vram) ? m.size_vram : null,
      expiresAt: typeof m.expires_at === "string" ? m.expires_at : null,
    }));
  return { ok: true, data: entries };
}

interface RawShowResponse {
  capabilities?: unknown;
  model_info?: Record<string, unknown>;
  details?: RawTagDetails;
  license?: unknown;
}

/**
 * `POST /api/show { model }` — capability metadata for one installed tag.
 *
 * `model_info` is a flat map keyed like `"<family>.context_length"`; the exact
 * family prefix varies per model family, so this scans for the first key
 * ending in `.context_length` rather than guessing the family name — the
 * same reason `parameter_count` is read from `general.parameter_count`
 * (documented as stable across families) rather than `details.parameter_size`,
 * which is a free-text string ("8.0B") meant for humans, not arithmetic.
 */
export async function fetchOllamaShow(baseUrl: string, model: string): Promise<OllamaShowInfo> {
  const result = await ollamaFetchJson<RawShowResponse>(baseUrl, "/api/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  }, SHOW_TIMEOUT_MS);
  if (!result.ok) {
    const detail = result.failure.kind === "http" ? `HTTP ${result.failure.status}`
      : result.failure.kind === "timeout" ? "the show request timed out"
      : result.failure.kind === "too-large" ? "the show response exceeded the size limit"
      : result.failure.kind === "malformed" ? result.failure.error
      : result.failure.kind === "refused" ? "the runtime refused the connection"
      : result.failure.error;
    return { ok: false, error: detail, capabilities: null, parameterCount: null, contextLength: null, quantizationLevel: null, family: null, families: null, license: null };
  }
  const info = result.data.model_info ?? {};
  let contextLength: number | null = null;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) { contextLength = value; break; }
  }
  const parameterCountRaw = info["general.parameter_count"];
  const parameterCount = typeof parameterCountRaw === "number" && Number.isFinite(parameterCountRaw) ? parameterCountRaw : null;
  const capabilities = Array.isArray(result.data.capabilities)
    ? result.data.capabilities.filter((c): c is string => typeof c === "string")
    : null;
  const details = readDetails(result.data.details);
  return {
    ok: true,
    error: null,
    capabilities,
    parameterCount,
    contextLength,
    quantizationLevel: details.quantizationLevel,
    family: details.family,
    families: details.families,
    license: typeof result.data.license === "string" ? result.data.license : null,
  };
}

/** `DELETE /api/delete { model }` — uninstalls one local tag. Never a batch/queue operation; that is a separate, later lane. */
export async function deleteOllamaModel(baseUrl: string, model: string): Promise<OllamaFetchOutcome<true>> {
  const result = await ollamaFetch(baseUrl, "/api/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  }, READ_TIMEOUT_MS);
  if (!result.ok) return result;
  return { ok: true, data: true };
}
