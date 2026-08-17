/**
 * The streaming chat surface's orchestration: session CRUD, starting and
 * stopping a turn, and regenerating the last reply.
 *
 * ## Real streaming, both ways
 *
 * `startChatTurn`/`regenerateLastTurn` return a `ReadableStream<Uint8Array>`
 * of newline-delimited JSON — the same shape Ollama's own `/api/chat` stream
 * uses — that the HTTP route forwards to the browser byte-for-byte, live, as
 * `chat-client.ts`'s `onToken` callback fires. The exact same callback also
 * appends each token to the persisted session on a throttled cadence (see
 * `PROGRESS_FLUSH_MIN_INTERVAL_MS`), so a page reload mid-turn shows the
 * partial reply rather than nothing. This is one write path serving both the
 * live browser and the durable record — never two representations that could
 * drift apart.
 *
 * ## Stop actually aborts the request
 *
 * `stopChatTurn` aborts the `AbortController` this module created for that
 * session's in-flight turn, which — per `chat-client.ts`'s header — closes
 * the connection to Ollama and stops it generating. The browser's own fetch
 * closing (navigating away, clicking Stop, losing network) reaches the same
 * place through the stream's `cancel()` callback. Either way the partial
 * content already streamed is kept, marked `stopped`, never discarded.
 *
 * ## Streaming never survives a restart
 *
 * There is deliberately no "resume a dangling turn" logic here, unlike
 * `pull-queue-engine.ts`'s `ensureResumed`: a chat turn is in-memory
 * generation with no server-side equivalent of "the download is still
 * happening somewhere" to reconcile against. `chat-store.ts`'s own sanitizer
 * already turns any `streaming` message it finds on disk into `stopped` the
 * moment the file is first read, which is the correct and complete resume
 * story for this module.
 *
 * ## What is bounded, and where
 *
 * Every ceiling named in `chat-types.ts` (session count, message count,
 * prompt/message/attachment sizes, attachment count, concurrent streaming
 * turns) is enforced here, at the one place a session or message is created —
 * never left to the route layer or the GUI alone.
 */

import { fetchOllamaShow } from "./client";
import {
  chatParametersToApiOptions,
  streamOllamaChat,
  type ChatApiMessage,
  type OllamaChatFailure,
} from "./chat-client";
import {
  flushChatState,
  getChatState,
  resetChatStoreForTests,
  updateAndFlushChatState,
  updateChatStateInMemory,
} from "./chat-store";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ASSISTANT_MESSAGE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_CONCURRENT_CHAT_TURNS,
  MAX_MESSAGES_PER_SESSION,
  MAX_SESSIONS,
  MAX_SYSTEM_PROMPT_BYTES,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_USER_MESSAGE_BYTES,
  summarizeChatSession,
  validateChatParameters,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageStats,
  type ChatParameters,
  type ChatSession,
  type ChatSessionSummary,
  type ChatTurnState,
} from "./chat-types";

/* ------------------------------------------------------------- test seams */

type ChatExecutor = typeof streamOllamaChat;
let chatExecutor: ChatExecutor = streamOllamaChat;
/** Test seam: replace the network call `beginStreaming` makes per turn. Pass null to restore the real streaming client. */
export function setChatExecutorForTests(executor: ChatExecutor | null): void {
  chatExecutor = executor ?? streamOllamaChat;
}

type ShowFetcher = typeof fetchOllamaShow;
let showFetcher: ShowFetcher = fetchOllamaShow;
/** Test seam: replace the `/api/show` capability lookup attachment validation makes. Pass null to restore the real client. */
export function setChatShowFetcherForTests(fetcher: ShowFetcher | null): void {
  showFetcher = fetcher ?? fetchOllamaShow;
}

/** Test-only: resets every module-level runtime flag (never the persisted file) so a test can simulate a fresh process. */
export function resetChatEngineForTests(): void {
  abortControllers.clear();
  chatExecutor = streamOllamaChat;
  showFetcher = fetchOllamaShow;
  resetChatStoreForTests();
}

/* --------------------------------------------------------------- reading */

export function listChatSessions(): ChatSessionSummary[] {
  return getChatState().sessions.map(summarizeChatSession).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getChatSession(id: string): ChatSession | null {
  return getChatState().sessions.find(s => s.id === id) ?? null;
}

/* ---------------------------------------------------------------- create */

export interface CreateChatSessionInput {
  model: string;
  title?: string;
  systemPrompt?: string;
  parameters?: Partial<ChatParameters>;
}

export type ChatSessionResult = { ok: true; session: ChatSession } | { ok: false; error: string };

export function createChatSession(input: CreateChatSessionInput): ChatSessionResult {
  const model = input.model?.trim();
  if (!model) return { ok: false, error: "a model is required" };

  const state = getChatState();
  if (state.sessions.length >= MAX_SESSIONS) {
    return { ok: false, error: `at most ${MAX_SESSIONS} chat sessions may exist at once — delete one before starting another` };
  }

  const { parameters } = validateChatParameters(input.parameters);
  const now = Date.now();
  const session: ChatSession = {
    id: crypto.randomUUID(),
    title: (input.title?.trim() || `Chat — ${new Date(now).toLocaleString()}`).slice(0, MAX_TITLE_LENGTH),
    model,
    systemPrompt: (input.systemPrompt ?? "").slice(0, MAX_SYSTEM_PROMPT_BYTES),
    parameters,
    messages: [],
    createdAt: now,
    updatedAt: now,
    streamingMessageId: null,
  };
  updateAndFlushChatState(s => { s.sessions.unshift(session); });
  return { ok: true, session };
}

/* ---------------------------------------------------------------- update */

export interface UpdateChatSessionInput {
  title?: string;
  model?: string;
  systemPrompt?: string;
  parameters?: Partial<ChatParameters>;
}

export function updateChatSession(id: string, input: UpdateChatSessionInput): ChatSessionResult {
  const state = getChatState();
  const session = state.sessions.find(s => s.id === id);
  if (!session) return { ok: false, error: "no such chat session" };
  if (session.streamingMessageId !== null) return { ok: false, error: "cannot change settings while a reply is streaming — stop it first" };

  if (input.title !== undefined) {
    const trimmed = input.title.trim();
    if (!trimmed) return { ok: false, error: "title cannot be empty" };
    session.title = trimmed.slice(0, MAX_TITLE_LENGTH);
  }
  if (input.model !== undefined) {
    const trimmed = input.model.trim();
    if (!trimmed) return { ok: false, error: "model cannot be empty" };
    session.model = trimmed;
  }
  if (input.systemPrompt !== undefined) session.systemPrompt = input.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_BYTES);
  if (input.parameters !== undefined) {
    const { parameters } = validateChatParameters({ ...session.parameters, ...input.parameters });
    session.parameters = parameters;
  }
  session.updatedAt = Date.now();
  flushChatState();
  return { ok: true, session };
}

/* ---------------------------------------------------------------- delete */

export function deleteChatSession(id: string): { ok: true } | { ok: false; error: string } {
  const state = getChatState();
  const idx = state.sessions.findIndex(s => s.id === id);
  if (idx === -1) return { ok: false, error: "no such chat session" };
  abortControllers.get(id)?.abort();
  abortControllers.delete(id);
  state.sessions.splice(idx, 1);
  flushChatState();
  return { ok: true };
}

/* ------------------------------------------------------------ attachments */

export interface RawAttachmentInput {
  name?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
}

interface AttachmentValidation {
  ok: true;
  attachments: ChatAttachment[];
}
interface AttachmentValidationFailure {
  ok: false;
  error: string;
}

function validateAttachments(raw: RawAttachmentInput[] | undefined): AttachmentValidation | AttachmentValidationFailure {
  if (!raw || raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message` };
  }
  let totalBytes = 0;
  const attachments: ChatAttachment[] = [];
  for (const a of raw) {
    const mimeType = typeof a.mimeType === "string" ? a.mimeType : "";
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      return { ok: false, error: `unsupported attachment type "${mimeType || "unknown"}" — only ${Array.from(ALLOWED_ATTACHMENT_MIME_TYPES).join(", ")} are accepted` };
    }
    const dataBase64 = typeof a.dataBase64 === "string" ? a.dataBase64 : "";
    if (!dataBase64) return { ok: false, error: "an attachment was missing its data" };
    // Real decoded byte count (base64 expands input ~4/3), not the encoded string length.
    const sizeBytes = Math.floor((dataBase64.length * 3) / 4);
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `an attachment exceeded the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB size limit` };
    }
    totalBytes += sizeBytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES_PER_MESSAGE) {
      return { ok: false, error: `this message's attachments together exceeded the ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024))} MiB limit` };
    }
    attachments.push({
      id: crypto.randomUUID(),
      name: typeof a.name === "string" ? a.name.slice(0, 200) : "attachment",
      mimeType,
      sizeBytes,
      dataBase64,
    });
  }
  return { ok: true, attachments };
}

/**
 * Fails closed: a model whose capabilities could not be verified is treated
 * as NOT vision-capable, exactly the same "never send an image to a model
 * that cannot be confirmed to accept one" reasoning as the GUI's own
 * attachment gate — this is the server-side half of that same gate, never a
 * separate, looser rule.
 */
async function modelSupportsVision(baseUrl: string, model: string): Promise<boolean> {
  const show = await showFetcher(baseUrl, model);
  if (!show.ok || !show.capabilities) return false;
  return show.capabilities.includes("vision");
}

/* ------------------------------------------------------------ start turn */

export interface StartTurnInput {
  content: string;
  attachments?: RawAttachmentInput[];
}

export type StartTurnResult =
  | { ok: true; userMessage: ChatMessage; assistantMessageId: string; stream: ReadableStream<Uint8Array> }
  | { ok: false; error: string; status: number };

const abortControllers = new Map<string, AbortController>();

function activeStreamCount(): number {
  return abortControllers.size;
}

export async function startChatTurn(baseUrl: string, sessionId: string, input: StartTurnInput): Promise<StartTurnResult> {
  const session = getChatSession(sessionId);
  if (!session) return { ok: false, error: "no such chat session", status: 404 };
  if (session.streamingMessageId !== null) {
    return { ok: false, error: "a reply is already streaming for this session — stop it before sending another message", status: 409 };
  }
  if (activeStreamCount() >= MAX_CONCURRENT_CHAT_TURNS) {
    return { ok: false, error: `at most ${MAX_CONCURRENT_CHAT_TURNS} replies may stream at once across every session — wait for one to finish`, status: 429 };
  }

  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) return { ok: false, error: "message content is required", status: 400 };
  if (Buffer.byteLength(content, "utf8") > MAX_USER_MESSAGE_BYTES) {
    return { ok: false, error: `message exceeds the ${Math.round(MAX_USER_MESSAGE_BYTES / 1024)} KiB limit`, status: 400 };
  }
  if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
    return { ok: false, error: `this session has reached its ${MAX_MESSAGES_PER_SESSION}-message limit — start a new session`, status: 400 };
  }

  const attachmentResult = validateAttachments(input.attachments);
  if (!attachmentResult.ok) return { ok: false, error: attachmentResult.error, status: 400 };
  if (attachmentResult.attachments.length > 0) {
    const canVision = await modelSupportsVision(baseUrl, session.model);
    if (!canVision) return { ok: false, error: `"${session.model}" does not support image attachments — choose a vision-capable model`, status: 400 };
  }

  const now = Date.now();
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content,
    attachments: attachmentResult.attachments.length > 0 ? attachmentResult.attachments : null,
    createdAt: now,
    state: "done",
    error: null,
    stats: null,
  };
  const assistantMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    attachments: null,
    createdAt: now,
    state: "streaming",
    error: null,
    stats: null,
  };

  updateAndFlushChatState(state => {
    const s = state.sessions.find(x => x.id === sessionId);
    if (!s) return;
    s.messages.push(userMessage, assistantMessage);
    s.streamingMessageId = assistantMessage.id;
    s.updatedAt = now;
  });

  return { ok: true, userMessage, assistantMessageId: assistantMessage.id, stream: beginStreaming(baseUrl, sessionId, assistantMessage.id) };
}

/* ------------------------------------------------------------ regenerate */

export type RegenerateResult =
  | { ok: true; assistantMessageId: string; stream: ReadableStream<Uint8Array> }
  | { ok: false; error: string; status: number };

/** Drops the last message (which must be a finished `assistant` reply) and re-streams a fresh reply to the same preceding history — a replacement, never a second reply appended beside the first. */
export function regenerateLastTurn(baseUrl: string, sessionId: string): RegenerateResult {
  const session = getChatSession(sessionId);
  if (!session) return { ok: false, error: "no such chat session", status: 404 };
  if (session.streamingMessageId !== null) return { ok: false, error: "a reply is already streaming for this session", status: 409 };
  if (activeStreamCount() >= MAX_CONCURRENT_CHAT_TURNS) {
    return { ok: false, error: `at most ${MAX_CONCURRENT_CHAT_TURNS} replies may stream at once across every session — wait for one to finish`, status: 429 };
  }
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== "assistant" || last.state === "streaming") {
    return { ok: false, error: "the last message is not a finished reply — there is nothing to regenerate", status: 400 };
  }

  const now = Date.now();
  const assistantMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    attachments: null,
    createdAt: now,
    state: "streaming",
    error: null,
    stats: null,
  };
  updateAndFlushChatState(state => {
    const s = state.sessions.find(x => x.id === sessionId);
    if (!s) return;
    s.messages.pop();
    s.messages.push(assistantMessage);
    s.streamingMessageId = assistantMessage.id;
    s.updatedAt = now;
  });

  return { ok: true, assistantMessageId: assistantMessage.id, stream: beginStreaming(baseUrl, sessionId, assistantMessage.id) };
}

/* ----------------------------------------------------------------- stop */

/** Aborts the in-flight turn for `sessionId`, if any — the "close the connection" cancel action `chat-client.ts` documents. A session with nothing streaming is a no-op success, never an error: stopping something already stopped is not a failure. */
export function stopChatTurn(sessionId: string): { ok: true } | { ok: false; error: string } {
  const session = getChatSession(sessionId);
  if (!session) return { ok: false, error: "no such chat session" };
  abortControllers.get(sessionId)?.abort();
  return { ok: true };
}

/* --------------------------------------------------------------- payload */

/** Builds the `/api/chat` request payload from a session's real history — the just-appended user message included, the in-flight assistant placeholder excluded (it is what is being generated, not something to feed back in). */
function toApiMessages(session: ChatSession): ChatApiMessage[] {
  const out: ChatApiMessage[] = [];
  if (session.systemPrompt.trim()) out.push({ role: "system", content: session.systemPrompt });
  for (const m of session.messages) {
    if (m.state === "streaming") continue;
    if (m.role === "assistant" && m.content === "" && m.state !== "done") continue; // an empty failed/stopped turn contributes nothing to history
    const apiMsg: ChatApiMessage = { role: m.role, content: m.content };
    if (m.attachments && m.attachments.length > 0) apiMsg.images = m.attachments.map(a => a.dataBase64);
    out.push(apiMsg);
  }
  return out;
}

function describeChatFailure(failure: OllamaChatFailure): string {
  switch (failure.kind) {
    case "refused": return "the runtime refused the connection";
    case "timeout": return "the request timed out";
    case "aborted": return "cancelled";
    case "network": return failure.error;
    case "http": return `the runtime answered with HTTP ${failure.status}`;
    case "reported-error": return failure.error;
    case "stream-error": return failure.error;
    default: return "the request failed";
  }
}

const PROGRESS_FLUSH_MIN_INTERVAL_MS = 200;

interface FinalLine {
  content: "";
  done: true;
  state: ChatTurnState;
  error: string | null;
  stats: ChatMessageStats | null;
}

/**
 * Returns a `ReadableStream` of NDJSON lines the HTTP route forwards to the
 * browser verbatim. `start()` performs the real network call: every content
 * delta is both appended to the persisted session (throttled disk flush) and
 * enqueued to the stream in the same callback — one write path, not two that
 * could disagree. See the module header for the full shape.
 */
function beginStreaming(baseUrl: string, sessionId: string, assistantMessageId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const session = getChatSession(sessionId);
      if (!session) { controller.close(); return; }

      const abortController = new AbortController();
      abortControllers.set(sessionId, abortController);

      const apiMessages = toApiMessages(session);
      const apiOptions = chatParametersToApiOptions(session.parameters);

      let lastFlushAt = Date.now();
      let cappedAtByteLimit = false;

      const outcome = await chatExecutor(baseUrl, session.model, apiMessages, apiOptions, {
        signal: abortController.signal,
        onToken: line => {
          let accepted = line.content;
          if (accepted) {
            updateChatStateInMemory(state => {
              const m = state.sessions.find(x => x.id === sessionId)?.messages.find(x => x.id === assistantMessageId);
              if (!m) { accepted = ""; return; }
              if (Buffer.byteLength(m.content, "utf8") >= MAX_ASSISTANT_MESSAGE_BYTES) {
                cappedAtByteLimit = true;
                accepted = "";
                return;
              }
              m.content += accepted;
            });
          }
          if (accepted) {
            try { controller.enqueue(encoder.encode(`${JSON.stringify({ content: accepted, done: false })}\n`)); } catch { /* the browser reader already closed; the store write above still happened */ }
          }
          if (cappedAtByteLimit) abortController.abort();
          const now = Date.now();
          if (now - lastFlushAt >= PROGRESS_FLUSH_MIN_INTERVAL_MS) { flushChatState(); lastFlushAt = now; }
        },
      });

      abortControllers.delete(sessionId);

      let finalState: ChatTurnState;
      let finalError: string | null;
      let finalStats: ChatMessageStats | null = null;
      if (cappedAtByteLimit) {
        finalState = "stopped";
        finalError = `the reply was stopped after reaching the ${Math.round(MAX_ASSISTANT_MESSAGE_BYTES / 1024)} KiB size limit`;
      } else if (outcome.ok) {
        finalState = "done";
        finalError = null;
        finalStats = outcome.stats;
      } else if (outcome.failure.kind === "aborted") {
        finalState = "stopped";
        finalError = "stopped";
      } else {
        finalState = "failed";
        finalError = describeChatFailure(outcome.failure);
      }

      updateAndFlushChatState(state => {
        const s = state.sessions.find(x => x.id === sessionId);
        if (!s) return;
        s.streamingMessageId = null;
        s.updatedAt = Date.now();
        const m = s.messages.find(x => x.id === assistantMessageId);
        if (!m || m.state !== "streaming") return; // never clobber a status something else already resolved (e.g. the session was deleted mid-stream)
        m.state = finalState;
        m.error = finalError;
        m.stats = finalStats;
      });

      const finalLine: FinalLine = { content: "", done: true, state: finalState, error: finalError, stats: finalStats };
      try { controller.enqueue(encoder.encode(`${JSON.stringify(finalLine)}\n`)); } catch { /* browser reader already closed */ }
      controller.close();
    },
    cancel() {
      // The browser closed its own reader (navigated away, network drop, or its own abort) — the documented cancel action applies here too.
      abortControllers.get(sessionId)?.abort();
    },
  });
}
