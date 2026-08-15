/**
 * Durable, atomic, on-disk persistence for chat sessions.
 *
 * State lives at `<codexHome>/model-runtime/chat-sessions.json` — a sibling
 * of the batch-pull queue's own file, kept separate from the main
 * `config.toml`/`config.json` and from `pull-queue.json` for the same reason
 * `pull-queue-store.ts`'s header gives: a session with a turn actively
 * streaming is written on a throttled cadence (see `chat-engine.ts`), and
 * that must never contend with, or risk corrupting, unrelated state.
 *
 * Every write is temp-file-then-rename, the same atomic shape used
 * throughout this module and by `renameAtomicFile` in `src/config.ts`.
 *
 * Shaped exactly like `pull-queue-store.ts`: an always-current in-memory
 * cache (`getChatState`), an explicit flush (`flushChatState`), and a
 * defensive re-validating sanitizer so a hand-edited or truncated file
 * degrades to "drop the bad session/message", never a thrown exception.
 *
 * ## Streaming never survives a restart
 *
 * A session or message found on disk claiming `streaming` is not actually
 * being streamed by anything any more — the process that was writing to it
 * is gone. `sanitizeSession` reconciles this on load: `streamingMessageId` is
 * always cleared, and any message still in the `streaming` state is turned
 * into `stopped` with an honest explanation, exactly the way
 * `pull-queue-engine.ts`'s `ensureResumed` reconciles a dangling `pulling`
 * item.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCodexHomeDir } from "../../codex/home";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  DEFAULT_CHAT_PARAMETERS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGES_PER_SESSION,
  MAX_SESSIONS,
  MAX_SYSTEM_PROMPT_BYTES,
  MAX_TITLE_LENGTH,
  validateChatParameters,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageStats,
  type ChatRole,
  type ChatSession,
  type ChatSessionState,
  type ChatTurnState,
} from "./chat-types";

let storePathOverride: string | null = null;

function defaultStorePath(): string {
  return join(resolveCodexHomeDir(), "model-runtime", "chat-sessions.json");
}

function storePath(): string {
  return storePathOverride ?? defaultStorePath();
}

/** Test seam: redirect the persisted file to an isolated path (e.g. a temp dir). Pass null to restore the real default. */
export function setChatStorePathForTests(path: string | null): void {
  storePathOverride = path;
}

function emptyState(): ChatSessionState {
  return { version: 1, sessions: [] };
}

const VALID_ROLES: ChatRole[] = ["system", "user", "assistant"];
const VALID_TURN_STATES: ChatTurnState[] = ["streaming", "done", "stopped", "failed"];

function sanitizeStats(raw: unknown): ChatMessageStats | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    totalDurationMs: num(r.totalDurationMs),
    loadDurationMs: num(r.loadDurationMs),
    promptEvalCount: num(r.promptEvalCount),
    promptEvalDurationMs: num(r.promptEvalDurationMs),
    evalCount: num(r.evalCount),
    evalDurationMs: num(r.evalDurationMs),
    doneReason: typeof r.doneReason === "string" ? r.doneReason : null,
  };
}

function sanitizeAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.mimeType !== "string" || !ALLOWED_ATTACHMENT_MIME_TYPES.has(r.mimeType)) return null;
  if (typeof r.dataBase64 !== "string" || r.dataBase64.length === 0) return null;
  if (typeof r.sizeBytes !== "number" || r.sizeBytes < 0 || r.sizeBytes > MAX_ATTACHMENT_BYTES) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name.slice(0, 200) : "attachment",
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    dataBase64: r.dataBase64,
  };
}

function sanitizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.role !== "string" || !VALID_ROLES.includes(r.role as ChatRole)) return null;
  if (typeof r.content !== "string") return null;
  const rawAttachments = Array.isArray(r.attachments) ? r.attachments : null;
  const attachments = rawAttachments
    ? rawAttachments.map(sanitizeAttachment).filter((a): a is ChatAttachment => a !== null).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    : null;
  const rawState = typeof r.state === "string" && VALID_TURN_STATES.includes(r.state as ChatTurnState) ? r.state as ChatTurnState : "done";
  // Streaming never survives a restart — see the module header.
  const state: ChatTurnState = rawState === "streaming" ? "stopped" : rawState;
  const error = rawState === "streaming"
    ? "the application was closed or restarted while this reply was still generating"
    : (typeof r.error === "string" ? r.error : null);
  return {
    id: r.id,
    role: r.role as ChatRole,
    content: r.content,
    attachments: attachments && attachments.length > 0 ? attachments : null,
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    state,
    error,
    stats: sanitizeStats(r.stats),
  };
}

function sanitizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.model !== "string" || !r.model) return null;
  const rawMessages = Array.isArray(r.messages) ? r.messages : [];
  const messages = rawMessages
    .map(sanitizeMessage)
    .filter((m): m is ChatMessage => m !== null)
    .slice(0, MAX_MESSAGES_PER_SESSION);
  const { parameters } = validateChatParameters(r.parameters as Partial<ChatSession["parameters"]> | undefined ?? DEFAULT_CHAT_PARAMETERS);
  return {
    id: r.id,
    title: typeof r.title === "string" && r.title.trim() ? r.title.slice(0, MAX_TITLE_LENGTH) : "Untitled chat",
    model: r.model,
    systemPrompt: typeof r.systemPrompt === "string" ? r.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_BYTES) : "",
    parameters,
    messages,
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
    // Never trusted across a restart — see the module header.
    streamingMessageId: null,
  };
}

function readFromDisk(): ChatSessionState {
  const path = storePath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyState(); // no file yet — a fresh install/first use, not an error
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState(); // corrupt file fails closed to "no sessions", never throws
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return emptyState();
  const rawSessions = (parsed as { sessions?: unknown }).sessions;
  const sessions = Array.isArray(rawSessions)
    ? rawSessions.map(sanitizeSession).filter((s): s is ChatSession => s !== null).slice(0, MAX_SESSIONS)
    : [];
  return { version: 1, sessions };
}

let cache: ChatSessionState | null = null;

/** Always current — hydrates from disk once, then reflects every subsequent in-memory mutation immediately. */
export function getChatState(): ChatSessionState {
  if (cache === null) cache = readFromDisk();
  return cache;
}

/** Replaces the in-memory cache. Does not touch disk — call `flushChatState()` to persist. */
export function setChatState(next: ChatSessionState): ChatSessionState {
  cache = next;
  return cache;
}

let atomicSeq = 0;

/** Writes the current in-memory cache to disk, atomically (temp file + rename). */
export function flushChatState(): void {
  const state = getChatState();
  const path = storePath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // If the directory genuinely cannot be created, the write below will fail too and surface the same way.
  }
  const tmp = `${path}.ocx-chat-sessions.${process.pid}.${++atomicSeq}.tmp`;
  const content = JSON.stringify(state, null, 2);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup; the real error below is what matters */ }
    throw error;
  }
}

/** Convenience: mutate the cache in place, then immediately persist it. Used at every session/message state transition. */
export function updateAndFlushChatState(mutator: (state: ChatSessionState) => void): ChatSessionState {
  const state = getChatState();
  mutator(state);
  flushChatState();
  return state;
}

/** Convenience: mutate the cache in place without touching disk — for high-frequency streaming-token updates the engine throttles separately. */
export function updateChatStateInMemory(mutator: (state: ChatSessionState) => void): ChatSessionState {
  const state = getChatState();
  mutator(state);
  return state;
}

/**
 * Test-only: drops the in-memory cache so the next `getChatState()` call
 * re-reads the file from disk, exactly as a fresh process would — this is how
 * "a streaming message never survives a restart" is exercised without
 * spawning a real second process.
 */
export function resetChatStoreForTests(): void {
  cache = null;
}
