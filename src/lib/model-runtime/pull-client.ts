/**
 * Streaming `POST /api/pull` caller — the one network call the batch-pull
 * queue actually makes.
 *
 * Documented at https://github.com/ollama/ollama/blob/main/docs/api.md#pull-a-model:
 * the runtime streams newline-delimited JSON status objects while it fetches
 * a model's manifest and layers, one object per line, ending in either
 * `{"status":"success"}` or `{"error":"..."}`.
 *
 * There is no documented "cancel this pull" route. Every Ollama client —
 * including the daemon's own behaviour — treats closing the HTTP connection
 * as the cancellation signal: the daemon stops writing to a client that has
 * gone away and abandons that pull. An `AbortSignal` on this `fetch` is
 * exactly that "close the connection" action, done through the standard
 * platform mechanism rather than anything daemon-specific — still nothing
 * but this documented local route.
 */

import { isConnectionRefused } from "./client";

export interface OllamaPullProgressLine {
  status: string;
  digest: string | null;
  total: number | null;
  completed: number | null;
}

export type OllamaPullFailure =
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "network"; error: string }
  | { kind: "http"; status: number }
  | { kind: "reported-error"; error: string }
  | { kind: "stream-error"; error: string };

export type OllamaPullOutcome = { ok: true } | { ok: false; failure: OllamaPullFailure };

export interface PullOllamaModelOptions {
  /** Called once per parsed status line, in order, before this function looks at it again. */
  onLine?: (line: OllamaPullProgressLine) => void;
  /** Closing this aborts the pull — see the module header for why that is the correct cancel action. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

// A model pull can legitimately run for a long time on a slow connection; this
// bounds a truly stuck request (no bytes at all for the whole window), never a
// slow-but-progressing one — the caller sees continuous progress lines instead.
const DEFAULT_PULL_TIMEOUT_MS = 60 * 60 * 1000;
// One status line is a small, fixed-shape JSON object; this bounds a
// malformed/adversarial stream, never a real one.
const MAX_LINE_BYTES = 64 * 1024;

function parseLine(text: string): (OllamaPullProgressLine & { error: string | null }) | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const error = typeof r.error === "string" ? r.error : null;
  if (typeof r.status !== "string" && error === null) return null;
  return {
    status: typeof r.status === "string" ? r.status : "",
    digest: typeof r.digest === "string" ? r.digest : null,
    total: typeof r.total === "number" && Number.isFinite(r.total) ? r.total : null,
    completed: typeof r.completed === "number" && Number.isFinite(r.completed) ? r.completed : null,
    error,
  };
}

function isAbortLike(error: unknown, externalSignal: AbortSignal | undefined): boolean {
  if (externalSignal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Streams one model's pull to completion, calling `onLine` for every status
 * line the runtime reports. Resolves `{ ok: true }` only on an explicit
 * `"status":"success"` line — a stream that simply ends (connection closed by
 * the server with no success and no error) is treated as a failure, never
 * assumed successful.
 */
export async function pullOllamaModel(baseUrl: string, model: string, options: PullOllamaModelOptions = {}): Promise<OllamaPullOutcome> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (isAbortLike(error, options.signal)) return { ok: false, failure: { kind: "aborted" } };
    if (isTimeoutLike(error)) return { ok: false, failure: { kind: "timeout" } };
    if (isConnectionRefused(error)) return { ok: false, failure: { kind: "refused" } };
    return { ok: false, failure: { kind: "network", error: error instanceof Error ? error.message : "network request failed" } };
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { ok: false, failure: { kind: "http", status: response.status } };
  }
  if (!response.ok) return { ok: false, failure: { kind: "http", status: response.status } };
  if (!response.body) return { ok: false, failure: { kind: "stream-error", error: "the runtime returned no response body" } };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function consumeLine(rawLine: string): OllamaPullOutcome | null {
    const trimmed = rawLine.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_LINE_BYTES) return { ok: false, failure: { kind: "stream-error", error: "a status line from the runtime exceeded the size limit" } };
    const parsed = parseLine(trimmed);
    if (!parsed) return null; // one malformed line does not abandon an otherwise-good stream
    if (parsed.error) return { ok: false, failure: { kind: "reported-error", error: parsed.error } };
    options.onLine?.({ status: parsed.status, digest: parsed.digest, total: parsed.total, completed: parsed.completed });
    if (parsed.status === "success") return { ok: true };
    return null;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const outcome = consumeLine(rawLine);
        if (outcome) {
          void reader.cancel().catch(() => {});
          return outcome;
        }
      }
    }
    if (buffer.trim()) {
      const outcome = consumeLine(buffer);
      if (outcome) return outcome;
    }
  } catch (error) {
    if (isAbortLike(error, options.signal)) return { ok: false, failure: { kind: "aborted" } };
    if (isTimeoutLike(error)) return { ok: false, failure: { kind: "timeout" } };
    return { ok: false, failure: { kind: "stream-error", error: error instanceof Error ? error.message : "the pull stream failed" } };
  }

  // The stream ended cleanly but never reported success or an error — never
  // assume success from silence.
  return { ok: false, failure: { kind: "stream-error", error: "the pull stream ended before reporting success" } };
}
