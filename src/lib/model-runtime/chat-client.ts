/**
 * Streaming `POST /api/chat` caller — real, token-by-token generation from
 * Ollama's documented local chat route
 * (https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion).
 *
 * Shaped exactly like `pull-client.ts`'s `pullOllamaModel`: the runtime
 * streams newline-delimited JSON objects, one per generated chunk, ending in
 * a `"done":true` line carrying real usage stats, or a `{"error":"..."}`
 * line. There is no documented "cancel this generation" route, so — same
 * reasoning as the pull stream — closing the connection (an aborted
 * `AbortSignal` on this `fetch`) is the way every Ollama client stops a
 * generation in progress; the runtime notices the client is gone and stops
 * producing tokens for it.
 */

import { isConnectionRefused } from "./client";
import type { ChatMessageStats, ChatParameters, ChatRole } from "./chat-types";

/** One message in the request payload sent to `/api/chat` — role/content plus optional raw-base64 images (only ever populated on a `user` message, and only when the target model's verified capabilities include `"vision"`). */
export interface ChatApiMessage {
  role: ChatRole;
  content: string;
  images?: string[];
}

export interface OllamaChatOptionsPayload {
  temperature: number;
  top_p: number;
  top_k: number;
  num_ctx: number;
  repeat_penalty: number;
  seed?: number;
}

export function chatParametersToApiOptions(parameters: ChatParameters): OllamaChatOptionsPayload {
  const options: OllamaChatOptionsPayload = {
    temperature: parameters.temperature,
    top_p: parameters.topP,
    top_k: parameters.topK,
    num_ctx: parameters.numCtx,
    repeat_penalty: parameters.repeatPenalty,
  };
  if (parameters.seed !== null) options.seed = parameters.seed;
  return options;
}

/** One parsed line from the chat stream: a content delta, or the final `done` line carrying stats. */
export interface OllamaChatLine {
  content: string;
  done: boolean;
  stats: ChatMessageStats | null;
}

export type OllamaChatFailure =
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "network"; error: string }
  | { kind: "http"; status: number }
  | { kind: "reported-error"; error: string }
  | { kind: "stream-error"; error: string };

export type OllamaChatOutcome =
  | { ok: true; stats: ChatMessageStats | null }
  | { ok: false; failure: OllamaChatFailure };

export interface StreamOllamaChatOptions {
  /** Called once per parsed line, in order, before this function looks at it again — same contract as `pull-client.ts`'s `onLine`. */
  onToken?: (line: OllamaChatLine) => void;
  /** Closing this aborts the generation — see the module header for why that is the correct cancel action. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Generation on modest local hardware can legitimately run for several
// minutes; this bounds a truly stuck request (no bytes at all for the whole
// window), never a slow-but-progressing one — the caller sees continuous
// token lines instead.
const DEFAULT_CHAT_TIMEOUT_MS = 15 * 60 * 1000;
// One status line is one small token chunk plus small fixed metadata; this
// bounds a malformed/adversarial stream, never a real one.
const MAX_LINE_BYTES = 256 * 1024;
const NANOS_PER_MS = 1_000_000;

function numMs(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw / NANOS_PER_MS) : null;
}

function numCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

interface ParsedChatLine {
  content: string;
  done: boolean;
  error: string | null;
  stats: ChatMessageStats | null;
}

function parseLine(text: string): ParsedChatLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const error = typeof r.error === "string" ? r.error : null;
  if (error !== null) return { content: "", done: true, error, stats: null };

  const message = r.message && typeof r.message === "object" ? r.message as Record<string, unknown> : null;
  const content = typeof message?.content === "string" ? message.content : "";
  const done = r.done === true;
  if (!done && message === null) return null; // not a recognizable chat line — skip, don't abandon the stream

  const stats: ChatMessageStats | null = done ? {
    totalDurationMs: numMs(r.total_duration),
    loadDurationMs: numMs(r.load_duration),
    promptEvalCount: numCount(r.prompt_eval_count),
    promptEvalDurationMs: numMs(r.prompt_eval_duration),
    evalCount: numCount(r.eval_count),
    evalDurationMs: numMs(r.eval_duration),
    doneReason: typeof r.done_reason === "string" ? r.done_reason : null,
  } : null;

  return { content, done, error: null, stats };
}

function isAbortLike(error: unknown, externalSignal: AbortSignal | undefined): boolean {
  if (externalSignal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Streams one chat turn to completion, calling `onToken` for every content
 * delta and for the final `done` line. Resolves `{ ok: true }` only on an
 * explicit `"done":true` line with no `error` — a stream that simply ends
 * (connection closed with no `done` line) is a failure, never assumed
 * successful, exactly like `pullOllamaModel`.
 */
export async function streamOllamaChat(
  baseUrl: string,
  model: string,
  messages: ChatApiMessage[],
  options: OllamaChatOptionsPayload,
  opts: StreamOllamaChatOptions = {},
): Promise<OllamaChatOutcome> {
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, options }),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (isAbortLike(error, opts.signal)) return { ok: false, failure: { kind: "aborted" } };
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

  function consumeLine(rawLine: string): OllamaChatOutcome | null {
    const trimmed = rawLine.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_LINE_BYTES) return { ok: false, failure: { kind: "stream-error", error: "a line from the runtime exceeded the size limit" } };
    const parsed = parseLine(trimmed);
    if (!parsed) return null; // one malformed line does not abandon an otherwise-good stream
    if (parsed.error) return { ok: false, failure: { kind: "reported-error", error: parsed.error } };
    opts.onToken?.({ content: parsed.content, done: parsed.done, stats: parsed.stats });
    if (parsed.done) return { ok: true, stats: parsed.stats };
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
    if (isAbortLike(error, opts.signal)) return { ok: false, failure: { kind: "aborted" } };
    if (isTimeoutLike(error)) return { ok: false, failure: { kind: "timeout" } };
    return { ok: false, failure: { kind: "stream-error", error: error instanceof Error ? error.message : "the chat stream failed" } };
  }

  // The stream ended cleanly but never reported a `done:true` line — never assume success from silence.
  return { ok: false, failure: { kind: "stream-error", error: "the chat stream ended before reporting completion" } };
}
