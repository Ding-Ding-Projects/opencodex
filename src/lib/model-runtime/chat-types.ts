/**
 * Shared types for the local model-runtime chat surface — the streaming
 * session lane `docs/FEATURE-INVENTORY.md`'s Ollama row still names as
 * `absent`.
 *
 * Every shape here is derived only from Ollama's documented local
 * `POST /api/chat` route
 * (https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion),
 * on the same loopback-only boundary `client.ts`'s header establishes for the
 * rest of this module. Nothing here reaches a cloud chat provider — this is
 * the local runtime's own chat endpoint, the same one `ollama run` calls.
 *
 * ## Everything here is bounded
 *
 * A chat session is user-authored, restart-persisted, on-disk state, so every
 * shape below carries an explicit ceiling: how many sessions, how many
 * messages per session, how big a system prompt or a single message can be,
 * how many attachments a message can carry and how large each one may be.
 * `chat-engine.ts` enforces every one of these at the point a session or
 * message is created — this file is where the numbers live so the engine,
 * the routes, and the GUI's own client-side validation all read the same
 * ceiling rather than three copies that can drift.
 */

export type ChatRole = "system" | "user" | "assistant";

/**
 * One image attached to a user message. Ollama's `images` field on a chat
 * message takes raw base64 with no `data:` URI prefix — `dataBase64` here is
 * kept in exactly that encoding so it can be forwarded to `/api/chat`
 * unmodified. Never included in an ordinary export — see `chat-export.ts`.
 */
export interface ChatAttachment {
  id: string;
  /** Original filename, for display only — never a filesystem path. */
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

/**
 * `done`     — the turn finished normally (Ollama reported a `done:true`
 *              line with no error).
 * `stopped`  — the user cancelled the turn, or it was cut off after hitting
 *              this file's own content-size ceiling. The partial content
 *              already streamed is kept, never discarded.
 * `failed`   — the runtime reported an error, or the request/stream itself
 *              failed (refused, timed out, malformed).
 * `streaming`— an assistant turn currently in flight. Never persisted as
 *              `streaming` across a restart — `chat-store.ts` reconciles any
 *              message found in this state on load to `stopped`.
 */
export type ChatTurnState = "streaming" | "done" | "stopped" | "failed";

/** Real usage figures Ollama reports on its final `done:true` line, converted from the API's nanoseconds to milliseconds. Absent (never guessed) when the turn never reached that line. */
export interface ChatMessageStats {
  totalDurationMs: number | null;
  loadDurationMs: number | null;
  promptEvalCount: number | null;
  promptEvalDurationMs: number | null;
  evalCount: number | null;
  evalDurationMs: number | null;
  /** Ollama's own `done_reason` ("stop", "length", "load", …), shown verbatim. */
  doneReason: string | null;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Only ever set on a `user` message. */
  attachments: ChatAttachment[] | null;
  createdAt: number;
  /** A `user` message is always `done` the instant it is recorded — only an `assistant` message passes through `streaming`. */
  state: ChatTurnState;
  /** Set only once `state` is `failed` (or `stopped` by a real runtime error rather than a user cancel). */
  error: string | null;
  stats: ChatMessageStats | null;
}

/**
 * Documented, bounded model parameters — Ollama's `options` object on
 * `/api/chat` (https://github.com/ollama/ollama/blob/main/docs/api.md#valid-parameters-and-values).
 * Defaults mirror Ollama's own documented defaults; bounds are a conservative
 * UI-sane range around them, not a hard protocol limit, so a value outside
 * the bound is clamped rather than rejected outright.
 */
export interface ChatParameters {
  /** Higher = more random. Ollama default 0.8. */
  temperature: number;
  /** Nucleus sampling cutoff. Ollama default 0.9. */
  topP: number;
  /** Top-k sampling cutoff; 0 disables top-k filtering. Ollama default 40. */
  topK: number;
  /** Context window, in tokens. Ollama default 4096 on current releases. */
  numCtx: number;
  /** Penalises repeated tokens; 1.0 = no penalty. Ollama default 1.1. */
  repeatPenalty: number;
  /** `null` = let the runtime pick (non-reproducible); a set integer reproduces the same generation for the same input. */
  seed: number | null;
}

export const DEFAULT_CHAT_PARAMETERS: ChatParameters = {
  temperature: 0.8,
  topP: 0.9,
  topK: 40,
  numCtx: 4096,
  repeatPenalty: 1.1,
  seed: null,
};

export interface ChatParameterBound {
  min: number;
  max: number;
}

export const CHAT_PARAMETER_BOUNDS: Record<Exclude<keyof ChatParameters, "seed">, ChatParameterBound> = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  topK: { min: 0, max: 200 },
  numCtx: { min: 256, max: 131072 },
  repeatPenalty: { min: 0.5, max: 2 },
};

/** Ollama seeds are a signed 32-bit int in practice; this bound keeps entry sane without pretending to a documented protocol limit. */
export const CHAT_SEED_BOUND: ChatParameterBound = { min: -2147483648, max: 2147483647 };

function clampNumber(value: number, bound: ChatParameterBound, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(bound.max, Math.max(bound.min, value));
}

export interface ChatParameterValidation {
  parameters: ChatParameters;
  /** Plain-language notes for every field that was out of bounds and got clamped — the honest "validation" this contract asks for, never a silent repair. */
  adjustments: string[];
}

/** Repairs a possibly-partial, possibly-out-of-range parameter set into one that is safe to send to Ollama, reporting every clamp it made. */
export function validateChatParameters(raw: Partial<ChatParameters> | null | undefined): ChatParameterValidation {
  const adjustments: string[] = [];
  const source = raw ?? {};

  function field(key: Exclude<keyof ChatParameters, "seed">): number {
    const bound = CHAT_PARAMETER_BOUNDS[key];
    const fallbackValue = DEFAULT_CHAT_PARAMETERS[key];
    const rawValue = source[key];
    const numericValue = typeof rawValue === "number" ? rawValue : fallbackValue;
    const clamped = clampNumber(numericValue, bound, fallbackValue);
    if (clamped !== numericValue) adjustments.push(`${key} was out of range (${bound.min}–${bound.max}) and was clamped to ${clamped}`);
    return clamped;
  }

  let seed: number | null = null;
  if (typeof source.seed === "number" && Number.isFinite(source.seed)) {
    seed = Math.round(clampNumber(source.seed, CHAT_SEED_BOUND, source.seed));
    if (seed !== Math.round(source.seed)) adjustments.push(`seed was out of range and was clamped to ${seed}`);
  } else if (source.seed !== null && source.seed !== undefined) {
    adjustments.push("seed was not a number and was reset to unset (random)");
  }

  return {
    parameters: {
      temperature: field("temperature"),
      topP: field("topP"),
      topK: field("topK"),
      numCtx: field("numCtx"),
      repeatPenalty: field("repeatPenalty"),
      seed,
    },
    adjustments,
  };
}

/* --------------------------------------------------------------- bounds */

export const MAX_SESSIONS = 200;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SYSTEM_PROMPT_BYTES = 16 * 1024;
/** A user's own typed message. */
export const MAX_USER_MESSAGE_BYTES = 64 * 1024;
/** A model's generated reply — bounded generously (this is real content, not a protocol frame) so a legitimately long answer is never truncated in practice, while a runaway generation still has a ceiling. */
export const MAX_ASSISTANT_MESSAGE_BYTES = 1024 * 1024;
export const MAX_MESSAGES_PER_SESSION = 500;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES_PER_MESSAGE = 24 * 1024 * 1024;
/** How many sessions may have a turn actively streaming at once. Local generation is compute/GPU-heavy, so this is deliberately small rather than following the pull queue's wider download concurrency. */
export const MAX_CONCURRENT_CHAT_TURNS = 2;

export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/* -------------------------------------------------------------- session */

export interface ChatSession {
  id: string;
  title: string;
  /** The Ollama tag this session talks to, e.g. `"llama3.2:3b"`. */
  model: string;
  systemPrompt: string;
  parameters: ChatParameters;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /**
   * The id of the `assistant` message currently streaming, or `null`.
   * Never trusted as `streaming` across a process restart — see
   * `chat-store.ts`'s sanitizer, which reconciles a resumed session's
   * dangling `streaming` message to `stopped` before this is ever read.
   */
  streamingMessageId: string | null;
}

export interface ChatSessionState {
  version: 1;
  sessions: ChatSession[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  /** The session's own last message's plain-text preview, for a history list — never includes attachment bytes. */
  lastMessagePreview: string | null;
}

export function summarizeChatSession(session: ChatSession): ChatSessionSummary {
  const last = session.messages[session.messages.length - 1] ?? null;
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    streaming: session.streamingMessageId !== null,
    lastMessagePreview: last ? last.content.slice(0, 240) : null,
  };
}
