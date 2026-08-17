/**
 * Streaming chat surface for the local model-runtime (Ollama) suite manager.
 *
 * A thin client over `/api/model-runtime/chat/*`
 * (`src/server/management/model-runtime-chat-routes.ts`), which is itself a
 * thin caller of `src/lib/model-runtime/chat-engine.ts` — see that module's
 * header for exactly how streaming, stop/cancel, regenerate, bounds and
 * capability gating work. Everything below is a client of that contract, not
 * a second copy of it.
 *
 * ## Real, token-by-token streaming
 *
 * Sending a message or regenerating a reply opens a real `fetch` to this
 * app's own local server, whose body is read with `response.body.getReader()`
 * as newline-delimited JSON arrives — the same live decode loop
 * `chat-client.ts` uses one hop further down, against Ollama itself. Every
 * content delta is appended to the in-flight assistant message the instant it
 * is decoded; there is no polling anywhere on this page. Stop aborts that
 * same `fetch` (closing the connection, which is the documented cancel
 * action all the way down to Ollama) and, as a defense-in-depth belt, also
 * calls the explicit `stop` route.
 *
 * ## Attachments are capability-gated, never hidden
 *
 * The attach control stays visible and reachable at all times. It disables
 * itself, with the exact reason named beside it, only when the session's
 * selected model's real fetched capabilities do not include `"vision"` — and
 * a "show vision-capable models only" action sits right there to fix it, per
 * the contract's explicit call-out. The server (`chat-engine.ts`'s
 * `modelSupportsVision`) enforces the same rule again on every send, failing
 * closed when a model's capabilities could not even be verified — this page
 * is the convenience, not the only gate.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Badge, Banner, Button, Card, Dialog, Empty, Field, SelectField, Slider, TextArea, TextInput, Toggle } from "../shell/m3-ui";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import {
  IconArrowUp, IconCheckCircle, IconDownload, IconError, IconHistory, IconImage, IconPlus,
  IconPower, IconRestartAlt, IconSliders, IconTag, IconTrash, IconX,
} from "../icons";
import { useI18n } from "../i18n/shared";
import type { TFn } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm, usePrompt } from "../shell/confirm-context";
import { hashRouteFor } from "../app-routing";
import { formatBytes } from "../format-bytes";

/* -------------------------------------------------------------- wire types */
/* Mirrors `src/lib/model-runtime/chat-types.ts` field-for-field — this GUI
   project cannot import the backend's TS sources directly (separate
   tsconfig, same as every other page in this directory), so the shape is
   re-declared here exactly, the same convention `Ollama.tsx` already uses
   for `OllamaHealthResult`/`CatalogEntry`/etc. */

type ChatRole = "system" | "user" | "assistant";
type ChatTurnState = "streaming" | "done" | "stopped" | "failed";

interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

interface ChatMessageStats {
  totalDurationMs: number | null;
  loadDurationMs: number | null;
  promptEvalCount: number | null;
  promptEvalDurationMs: number | null;
  evalCount: number | null;
  evalDurationMs: number | null;
  doneReason: string | null;
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  attachments: ChatAttachment[] | null;
  createdAt: number;
  state: ChatTurnState;
  error: string | null;
  stats: ChatMessageStats | null;
}

interface ChatParameters {
  temperature: number;
  topP: number;
  topK: number;
  numCtx: number;
  repeatPenalty: number;
  seed: number | null;
}

interface ChatSession {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  parameters: ChatParameters;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  streamingMessageId: string | null;
}

interface ChatSessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  lastMessagePreview: string | null;
}

interface CatalogEntry {
  name: string;
  family: string | null;
  capabilities: string[] | null;
  showOk: boolean;
}

interface CatalogResponse {
  health: { state: string; detail: string };
  catalog: { entries: CatalogEntry[] } | null;
}

/* ------------------------------------------------------------------ bounds */
/* Mirrors `chat-types.ts`'s bounds — client-side is a courtesy (fast, honest
   feedback before a round trip); the server re-validates every one of these
   regardless. See that file for why each number is what it is. */

const DEFAULT_CHAT_PARAMETERS: ChatParameters = { temperature: 0.8, topP: 0.9, topK: 40, numCtx: 4096, repeatPenalty: 1.1, seed: null };
const MAX_TITLE_LENGTH = 200;
const MAX_SYSTEM_PROMPT_BYTES = 16 * 1024;
const MAX_USER_MESSAGE_BYTES = 64 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PARAM_BOUNDS = {
  temperature: { min: 0, max: 2, step: 0.05 },
  topP: { min: 0, max: 1, step: 0.05 },
  topK: { min: 0, max: 200, step: 1 },
  numCtx: { min: 256, max: 131072, step: 256 },
  repeatPenalty: { min: 0.5, max: 2, step: 0.05 },
} as const;

/* ---------------------------------------------------------------- helpers */

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed", status: 0 };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: body?.error ?? String(res.status), status: res.status };
  return { ok: true, data: body as T };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read the file"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

interface StreamLine {
  content?: string;
  done?: boolean;
  state?: ChatTurnState;
  error?: string | null;
  stats?: ChatMessageStats | null;
}

const LAYOUT: CSSProperties = { display: "flex", gap: "var(--sp-3)", alignItems: "flex-start", flexWrap: "wrap" };
const SIDEBAR: CSSProperties = { flex: "1 1 300px", minWidth: 260, maxWidth: 380 };
const MAIN: CSSProperties = { flex: "3 1 480px", minWidth: 320, display: "flex", flexDirection: "column", gap: "var(--sp-3)" };
const TRANSCRIPT: CSSProperties = { maxHeight: "52vh", minHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-2)", padding: "var(--sp-2) 0" };
const BUBBLE: CSSProperties = { borderRadius: "var(--r-l)", padding: "10px 14px", whiteSpace: "pre-wrap", wordBreak: "break-word" };
const USER_BUBBLE: CSSProperties = { ...BUBBLE, background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)", alignSelf: "flex-end", maxWidth: "80%" };
const ASSISTANT_BUBBLE: CSSProperties = { ...BUBBLE, background: "var(--m3-surface-container-high)", color: "var(--m3-on-surface)", alignSelf: "flex-start", maxWidth: "80%" };
const SYSTEM_BUBBLE: CSSProperties = { ...BUBBLE, background: "transparent", border: "1px dashed var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)", alignSelf: "center", maxWidth: "90%", fontStyle: "italic" };

function stateTone(state: ChatTurnState): "neutral" | "accent" | "ok" | "warn" | "error" {
  if (state === "streaming") return "accent";
  if (state === "failed") return "error";
  if (state === "stopped") return "warn";
  return "neutral";
}

function tokensPerSecond(stats: ChatMessageStats | null): number | null {
  if (!stats || stats.evalCount == null || stats.evalDurationMs == null || stats.evalDurationMs <= 0) return null;
  return Math.round((stats.evalCount / stats.evalDurationMs) * 1000);
}

interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

function MessageBubble({ message, t, locale }: { message: ChatMessage; t: TFn; locale: Parameters<typeof formatBytes>[1] }) {
  const style = message.role === "user" ? USER_BUBBLE : message.role === "assistant" ? ASSISTANT_BUBBLE : SYSTEM_BUBBLE;
  const roleLabel = message.role === "user" ? t("ollamaChat.role.user") : message.role === "assistant" ? t("ollamaChat.role.assistant") : t("ollamaChat.role.system");
  const tps = tokensPerSecond(message.stats);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: message.role === "user" ? "flex-end" : message.role === "assistant" ? "flex-start" : "center" }}>
      <div className="m3-field-hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>{roleLabel}</span>
        {message.state !== "done" && <Badge tone={stateTone(message.state)}>{t(`ollamaChat.turnState.${message.state}`)}</Badge>}
      </div>
      <div style={style}>
        {message.content || (message.state === "streaming" ? t("ollamaChat.thinking") : "")}
        {message.attachments && message.attachments.length > 0 && (
          <div className="m3-row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {message.attachments.map(a => (
              <img
                key={a.id}
                src={`data:${a.mimeType};base64,${a.dataBase64}`}
                alt={a.name}
                title={`${a.name} (${formatBytes(a.sizeBytes, locale)})`}
                style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--r-s)" }}
              />
            ))}
          </div>
        )}
      </div>
      {message.error && <p className="m3-field-hint" role="alert">{message.error}</p>}
      {message.state === "done" && tps !== null && <p className="m3-field-hint">{t("ollamaChat.tokensPerSecond", { rate: tps })}</p>}
    </div>
  );
}

export default function OllamaChat({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();
  const confirm = useConfirm();
  const prompt = usePrompt();

  const [health, setHealth] = useState<{ state: string; detail: string } | null>(null);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  const [view, setView] = useState<"chat" | "settings">("chat");
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);

  const [modelDraft, setModelDraft] = useState("");
  const [systemPromptDraft, setSystemPromptDraft] = useState("");
  const [parametersDraft, setParametersDraft] = useState<ChatParameters>(DEFAULT_CHAT_PARAMETERS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [visionOnly, setVisionOnly] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createModel, setCreateModel] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const loadCatalogAndHealth = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchJson<CatalogResponse>(apiBase, "/api/model-runtime/catalog", { signal });
    if (signal?.aborted || !result.ok) return;
    setHealth(result.data.health);
    setCatalogEntries(result.data.catalog?.entries ?? []);
  }, [apiBase]);

  const loadSessions = useCallback(async (signal?: AbortSignal) => {
    setLoadingSessions(true);
    const result = await fetchJson<{ ok: true; sessions: ChatSessionSummary[] }>(apiBase, "/api/model-runtime/chat/sessions", { signal });
    if (signal?.aborted) return;
    setLoadingSessions(false);
    if (!result.ok) { setError(result.error); return; }
    setSessions(result.data.sessions);
  }, [apiBase]);

  const loadSession = useCallback(async (id: string, signal?: AbortSignal) => {
    setLoadingSession(true);
    const result = await fetchJson<{ ok: true; session: ChatSession }>(apiBase, `/api/model-runtime/chat/sessions/${id}`, { signal });
    if (signal?.aborted) return;
    setLoadingSession(false);
    if (!result.ok) { notify({ tone: "error", title: t("ollamaChat.loadFailedTitle"), body: result.error }); return; }
    setActiveSession(result.data.session);
    setModelDraft(result.data.session.model);
    setSystemPromptDraft(result.data.session.systemPrompt);
    setParametersDraft(result.data.session.parameters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadCatalogAndHealth(controller.signal);
      void loadSessions(controller.signal);
    }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [loadCatalogAndHealth, loadSessions]);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred, like the initial load above: avoids a synchronous setState inside the effect body.
    const timeout = window.setTimeout(() => {
      if (!activeSessionId) setActiveSession(null);
      else void loadSession(activeSessionId, controller.signal);
    }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [activeSessionId, loadSession]);

  const lastMessageContent = activeSession?.messages[activeSession.messages.length - 1]?.content;
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSession?.messages.length, lastMessageContent]);

  const matcher = useMemo(() => settingsMatcher(query, useRegex, flags), [query, useRegex, flags]);
  const sampleText = useMemo(() => sessions.slice(0, 40).map(s => s.title).join("\n"), [sessions]);
  const filteredSessions = useMemo(
    () => sessions.filter(s => matcher.test(`${s.title} ${s.model} ${s.lastMessagePreview ?? ""}`)),
    [sessions, matcher],
  );

  const activeCatalogEntry = useMemo(() => catalogEntries.find(e => e.name === activeSession?.model) ?? null, [catalogEntries, activeSession]);
  const visionCapable = activeCatalogEntry?.capabilities?.includes("vision") ?? false;
  const modelOptions = useMemo(
    () => catalogEntries.filter(e => !visionOnly || (e.capabilities?.includes("vision") ?? false)).map(e => ({ value: e.name, label: e.name })),
    [catalogEntries, visionOnly],
  );

  const draftBytes = useMemo(() => new TextEncoder().encode(draft).length, [draft]);
  const canSend = !sending && !!activeSession && activeSession.streamingMessageId === null && draft.trim().length > 0 && draftBytes <= MAX_USER_MESSAGE_BYTES;
  const lastMessage = activeSession?.messages[activeSession.messages.length - 1] ?? null;
  const canRegenerate = !sending && !!activeSession && activeSession.streamingMessageId === null && lastMessage?.role === "assistant" && lastMessage.state !== "streaming";

  /* ------------------------------------------------------------ streaming */

  function applyStreamLine(assistantId: string, line: StreamLine) {
    setActiveSession(prev => {
      if (!prev) return prev;
      const messages = prev.messages.map(m => {
        if (m.id !== assistantId) return m;
        if (line.done) return { ...m, state: line.state ?? "done", error: line.error ?? null, stats: line.stats ?? null };
        return { ...m, content: m.content + (line.content ?? "") };
      });
      return { ...prev, messages, streamingMessageId: line.done ? null : prev.streamingMessageId };
    });
  }

  async function runStream(url: string, init: RequestInit, seed: (assistantId: string, userId: string | null) => void, sessionId: string) {
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      setSending(false);
      abortRef.current = null;
      if ((err as Error)?.name !== "AbortError") notify({ tone: "error", title: t("ollamaChat.sendFailedTitle"), body: err instanceof Error ? err.message : "the request failed" });
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      notify({ tone: "error", title: t("ollamaChat.sendFailedTitle"), body: body?.error ?? String(res.status) });
      setSending(false);
      abortRef.current = null;
      return;
    }
    const assistantId = res.headers.get("X-Chat-Assistant-Message-Id");
    const userId = res.headers.get("X-Chat-User-Message-Id");
    if (!assistantId) {
      setSending(false);
      abortRef.current = null;
      return;
    }
    seed(assistantId, userId);

    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (!raw.trim()) continue;
            try { applyStreamLine(assistantId, JSON.parse(raw) as StreamLine); } catch { /* one malformed line does not abandon the stream */ }
          }
        }
      } catch {
        // Connection dropped (Stop, navigation, network) — the reconciling refresh below shows the true persisted state.
      }
    }
    setSending(false);
    abortRef.current = null;
    void loadSession(sessionId);
  }

  async function handleSend() {
    if (!canSend || !activeSession) return;
    const content = draft.trim();
    const attachmentsPayload = pendingAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64 }));
    const localAttachments: ChatAttachment[] | null = pendingAttachments.length > 0
      ? pendingAttachments.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, dataBase64: a.dataBase64 }))
      : null;
    const sessionId = activeSession.id;
    setDraft("");
    setPendingAttachments([]);
    await runStream(
      `${apiBase}/api/model-runtime/chat/sessions/${sessionId}/messages`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, attachments: attachmentsPayload.length > 0 ? attachmentsPayload : undefined }) },
      (assistantId, userId) => {
        setActiveSession(prev => {
          if (!prev) return prev;
          const now = Date.now();
          const userMessage: ChatMessage = { id: userId ?? crypto.randomUUID(), role: "user", content, attachments: localAttachments, createdAt: now, state: "done", error: null, stats: null };
          const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", attachments: null, createdAt: now, state: "streaming", error: null, stats: null };
          return { ...prev, messages: [...prev.messages, userMessage, assistantMessage], streamingMessageId: assistantId, updatedAt: now };
        });
      },
      sessionId,
    );
    void loadSessions();
  }

  async function handleRegenerate() {
    if (!canRegenerate || !activeSession) return;
    const sessionId = activeSession.id;
    await runStream(
      `${apiBase}/api/model-runtime/chat/sessions/${sessionId}/regenerate`,
      { method: "POST" },
      assistantId => {
        setActiveSession(prev => {
          if (!prev) return prev;
          const now = Date.now();
          const messages = prev.messages.slice(0, -1);
          messages.push({ id: assistantId, role: "assistant", content: "", attachments: null, createdAt: now, state: "streaming", error: null, stats: null });
          return { ...prev, messages, streamingMessageId: assistantId, updatedAt: now };
        });
      },
      sessionId,
    );
    void loadSessions();
  }

  async function handleStop() {
    if (!activeSession) return;
    abortRef.current?.abort();
    await fetchJson(apiBase, `/api/model-runtime/chat/sessions/${activeSession.id}/stop`, { method: "POST" });
  }

  /* --------------------------------------------------------- attachments */

  async function handleAttachFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length;
    const files = Array.from(fileList).slice(0, Math.max(0, room));
    for (const file of files) {
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(file.type)) {
        notify({ tone: "error", title: t("ollamaChat.attachRejectedTitle"), body: t("ollamaChat.attachRejectedType", { name: file.name }) });
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        notify({ tone: "error", title: t("ollamaChat.attachRejectedTitle"), body: t("ollamaChat.attachRejectedSize", { name: file.name, limit: formatBytes(MAX_ATTACHMENT_BYTES, locale) }) });
        continue;
      }
      const dataBase64 = await fileToBase64(file);
      setPendingAttachments(prev => prev.length >= MAX_ATTACHMENTS_PER_MESSAGE ? prev : [...prev, { id: crypto.randomUUID(), name: file.name, mimeType: file.type, sizeBytes: file.size, dataBase64 }]);
    }
  }

  /* ----------------------------------------------------------- sessions */

  async function handleCreate() {
    if (!createModel) return;
    setCreating(true);
    const result = await fetchJson<{ ok: true; session: ChatSession }>(apiBase, "/api/model-runtime/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: createModel, title: createTitle.trim() || undefined }),
    });
    setCreating(false);
    if (!result.ok) { notify({ tone: "error", title: t("ollamaChat.createFailedTitle"), body: result.error }); return; }
    setCreateOpen(false);
    setCreateTitle("");
    setActiveSessionId(result.data.session.id);
    setActiveSession(result.data.session);
    void loadSessions();
  }

  async function handleRename(session: ChatSessionSummary) {
    const next = await prompt({
      title: t("ollamaChat.renameTitle"),
      label: t("ollamaChat.renameLabel"),
      initialValue: session.title,
      confirmLabel: t("ollamaChat.renameConfirm"),
    });
    if (next === null || !next.trim()) return;
    const result = await fetchJson<{ ok: true; session: ChatSession }>(apiBase, `/api/model-runtime/chat/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next.trim().slice(0, MAX_TITLE_LENGTH) }),
    });
    if (!result.ok) { notify({ tone: "error", title: t("ollamaChat.renameFailedTitle"), body: result.error }); return; }
    if (activeSessionId === session.id) setActiveSession(result.data.session);
    void loadSessions();
  }

  async function handleDeleteSession(session: ChatSessionSummary) {
    const confirmed = await confirm({
      title: t("ollamaChat.deleteConfirmTitle", { title: session.title }),
      body: t("ollamaChat.deleteConfirmBody"),
      confirmLabel: t("ollamaChat.deleteConfirmLabel"),
      tone: "danger",
    });
    if (!confirmed) return;
    const result = await fetchJson(apiBase, `/api/model-runtime/chat/sessions/${session.id}`, { method: "DELETE" });
    if (!result.ok) { notify({ tone: "error", title: t("ollamaChat.deleteFailedTitle"), body: result.error }); return; }
    notify({ tone: "success", title: t("ollamaChat.deleteOkTitle"), body: session.title });
    if (activeSessionId === session.id) { setActiveSessionId(null); setActiveSession(null); }
    void loadSessions();
  }

  async function handleSaveSettings() {
    if (!activeSession) return;
    setSavingSettings(true);
    const requested = { model: modelDraft, systemPrompt: systemPromptDraft, parameters: parametersDraft };
    const result = await fetchJson<{ ok: true; session: ChatSession }>(apiBase, `/api/model-runtime/chat/sessions/${activeSession.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requested),
    });
    setSavingSettings(false);
    if (!result.ok) { notify({ tone: "error", title: t("ollamaChat.settingsFailedTitle"), body: result.error }); return; }
    const adjustments: string[] = [];
    (Object.keys(DEFAULT_CHAT_PARAMETERS) as (keyof ChatParameters)[]).forEach(key => {
      if (result.data.session.parameters[key] !== requested.parameters[key]) {
        adjustments.push(t("ollamaChat.settingsAdjusted", { field: key, value: String(result.data.session.parameters[key] ?? t("ollamaChat.seedPlaceholder")) }));
      }
    });
    setActiveSession(result.data.session);
    setModelDraft(result.data.session.model);
    setSystemPromptDraft(result.data.session.systemPrompt);
    setParametersDraft(result.data.session.parameters);
    notify({ tone: adjustments.length > 0 ? "warn" : "success", title: t("ollamaChat.settingsSavedTitle"), body: adjustments.length > 0 ? adjustments.join(" ") : undefined });
    void loadSessions();
  }

  async function downloadExport(sessionId: string | null, format: "json" | "md") {
    const qs = new URLSearchParams();
    if (sessionId) qs.set("sessionId", sessionId);
    qs.set("format", format);
    let res: Response;
    try {
      res = await fetch(`${apiBase}/api/model-runtime/chat/export?${qs.toString()}`);
    } catch (err) {
      notify({ tone: "error", title: t("ollamaChat.exportFailedTitle"), body: err instanceof Error ? err.message : "the request failed" });
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      notify({ tone: "error", title: t("ollamaChat.exportFailedTitle"), body: body?.error ?? String(res.status) });
      return;
    }
    const text = await res.text();
    const url = URL.createObjectURL(new Blob([text], { type: format === "md" ? "text/markdown" : "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ocx-chat-export-${Date.now()}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
    notify({ tone: "success", title: t("ollamaChat.exportOkTitle") });
  }

  /* -------------------------------------------------------------- render */

  return (
    <div className="m3-stack">
      <Card title={t("ollamaChat.title")} subtitle={t("ollamaChat.subtitle")}>
        {error && <Banner tone="error">{error}</Banner>}
        {health && health.state !== "healthy" && (
          <Banner
            tone="warn"
            title={<span className="m3-row" style={{ gap: 8 }}><IconError width={18} height={18} /> {t("ollamaChat.notHealthy")}</span>}
            action={<a className="m3-btn m3-btn--text" href={hashRouteFor("ollama")}><IconPower width={16} height={16} /> {t("ollamaChat.openManager")}</a>}
          >
            <p>{health.detail}</p>
          </Banner>
        )}
      </Card>

      <div style={LAYOUT}>
        <div style={SIDEBAR}>
          <Card
            title={t("ollamaChat.sessionsTitle")}
            actions={<Button variant="filled" onClick={() => { setCreateModel(catalogEntries[0]?.name ?? ""); setCreateOpen(true); }} disabled={catalogEntries.length === 0}>
              <IconPlus width={16} height={16} /> {t("ollamaChat.newSession")}
            </Button>}
          >
            <SearchField
              id="ollama-chat-search"
              value={query}
              onChange={setQuery}
              searchLabel={t("ollamaChat.searchLabel")}
              placeholder={t("ollamaChat.searchLabel")}
              regex={useRegex}
              onRegexChange={setUseRegex}
              flags={flags}
              onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
              sample={sampleText}
            />
            {matcher.error && <p className="m3-field-hint" role="alert">{matcher.error}</p>}

            {loadingSessions ? (
              <p className="m3-field-hint">{t("ollamaChat.loadingSessions")}</p>
            ) : filteredSessions.length === 0 ? (
              <Empty title={t("ollamaChat.noSessions")} icon={IconHistory} />
            ) : (
              <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                {filteredSessions.map(s => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setActiveSessionId(s.id)}
                      className="m3-btn m3-btn--text"
                      aria-current={s.id === activeSessionId}
                      style={{ width: "100%", justifyContent: "flex-start", textAlign: "left", flexDirection: "column", alignItems: "flex-start", gap: 2, background: s.id === activeSessionId ? "var(--m3-secondary-container)" : undefined, padding: "8px 10px" }}
                    >
                      <span className="m3-row" style={{ gap: 6, width: "100%" }}>
                        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.title}</strong>
                        {s.streaming && <Badge tone="accent">{t("ollamaChat.streamingBadge")}</Badge>}
                      </span>
                      <span className="m3-field-hint">{s.model} · {t("ollamaChat.messageCount", { count: s.messageCount })}</span>
                    </button>
                    <div className="m3-row" style={{ gap: 4, marginTop: 2 }}>
                      <Button variant="text" onClick={() => void handleRename(s)} aria-label={t("ollamaChat.renameAction")}>
                        <IconTag width={14} height={14} /> {t("ollamaChat.renameAction")}
                      </Button>
                      <Button variant="text" onClick={() => void handleDeleteSession(s)} aria-label={t("ollamaChat.deleteAction")}>
                        <IconTrash width={14} height={14} /> {t("ollamaChat.deleteAction")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {sessions.length > 0 && (
              <div className="m3-row" style={{ gap: 8, marginTop: 12 }}>
                <Button variant="text" onClick={() => void downloadExport(null, "json")}><IconDownload width={16} height={16} /> {t("ollamaChat.exportAllJson")}</Button>
                <Button variant="text" onClick={() => void downloadExport(null, "md")}><IconDownload width={16} height={16} /> {t("ollamaChat.exportAllMd")}</Button>
              </div>
            )}
          </Card>
        </div>

        <div style={MAIN}>
          {!activeSession ? (
            <Card>
              <Empty title={t("ollamaChat.pickOrCreate")} icon={IconHistory}>
                <p>{t("ollamaChat.pickOrCreateBody")}</p>
              </Empty>
            </Card>
          ) : (
            <>
              <Card
                title={activeSession.title}
                subtitle={activeSession.model}
                actions={
                  <div className="m3-row" style={{ gap: 8 }}>
                    <div className="m3-segmented" role="tablist" aria-label={t("ollamaChat.viewSwitcherLabel")}>
                      <button type="button" role="tab" aria-selected={view === "chat"} className={`m3-segment${view === "chat" ? " selected" : ""}`} onClick={() => setView("chat")}>{t("ollamaChat.viewChat")}</button>
                      <button type="button" role="tab" aria-selected={view === "settings"} className={`m3-segment${view === "settings" ? " selected" : ""}`} onClick={() => setView("settings")}><IconSliders width={16} height={16} /> {t("ollamaChat.viewSettings")}</button>
                    </div>
                    <Button variant="text" onClick={() => void downloadExport(activeSession.id, "json")}><IconDownload width={16} height={16} /> {t("ollamaChat.exportSession")}</Button>
                  </div>
                }
              >
                {loadingSession && <p className="m3-field-hint">{t("ollamaChat.loadingSession")}</p>}

                {view === "chat" && (
                  <div role="tabpanel">
                    <div ref={transcriptRef} style={TRANSCRIPT}>
                      {activeSession.messages.length === 0 ? (
                        <Empty title={t("ollamaChat.emptyTranscript")} />
                      ) : (
                        activeSession.messages.map(m => <MessageBubble key={m.id} message={m} t={t} locale={locale} />)
                      )}
                    </div>

                    {canRegenerate && (
                      <div className="m3-row" style={{ justifyContent: "center", margin: "8px 0" }}>
                        <Button variant="outlined" onClick={() => void handleRegenerate()}>
                          <IconRestartAlt width={16} height={16} /> {t("ollamaChat.regenerate")}
                        </Button>
                      </div>
                    )}

                    {pendingAttachments.length > 0 && (
                      <div className="m3-row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        {pendingAttachments.map(a => (
                          <span key={a.id} className="m3-chip">
                            <img src={`data:${a.mimeType};base64,${a.dataBase64}`} alt={a.name} style={{ width: 20, height: 20, objectFit: "cover", borderRadius: 4, marginRight: 6 }} />
                            {a.name}
                            <button type="button" onClick={() => setPendingAttachments(prev => prev.filter(x => x.id !== a.id))} aria-label={t("ollamaChat.removeAttachment", { name: a.name })} style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer" }}>
                              <IconX width={14} height={14} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    <Field label={t("ollamaChat.composerLabel")} id="ollama-chat-composer" hint={draftBytes > MAX_USER_MESSAGE_BYTES ? t("ollamaChat.messageTooLong", { limit: formatBytes(MAX_USER_MESSAGE_BYTES, locale) }) : undefined}>
                      <TextArea
                        id="ollama-chat-composer"
                        rows={3}
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
                        placeholder={t("ollamaChat.composerPlaceholder")}
                        disabled={activeSession.streamingMessageId !== null}
                      />
                    </Field>

                    <div className="m3-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={Array.from(ALLOWED_ATTACHMENT_MIME_TYPES).join(",")}
                        multiple
                        hidden
                        onChange={e => { void handleAttachFiles(e.target.files); e.target.value = ""; }}
                      />
                      <Button
                        variant="outlined"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!visionCapable || pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE || activeSession.streamingMessageId !== null}
                        title={!visionCapable ? t("ollamaChat.attachDisabledReason", { model: activeSession.model }) : undefined}
                      >
                        <IconImage width={16} height={16} /> {t("ollamaChat.attachAction")}
                      </Button>
                      {!visionCapable && (
                        <span className="m3-field-hint">
                          {t("ollamaChat.attachDisabledReason", { model: activeSession.model })}{" "}
                          <button type="button" className="m3-btn m3-btn--text" style={{ display: "inline-flex" }} onClick={() => { setVisionOnly(true); setView("settings"); }}>
                            {t("ollamaChat.showVisionModels")}
                          </button>
                        </span>
                      )}
                      <div style={{ flex: 1 }} />
                      {activeSession.streamingMessageId !== null ? (
                        <Button variant="danger" onClick={() => void handleStop()}>
                          <IconX width={16} height={16} /> {t("ollamaChat.stop")}
                        </Button>
                      ) : (
                        <Button variant="filled" onClick={() => void handleSend()} disabled={!canSend}>
                          <IconArrowUp width={16} height={16} /> {sending ? t("ollamaChat.sending") : t("ollamaChat.send")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {view === "settings" && (
                  <div role="tabpanel" className="m3-stack">
                    <Field label={t("ollamaChat.modelLabel")} id="ollama-chat-model" hint={t("ollamaChat.modelHint")}>
                      <div className="m3-row" style={{ gap: 8, alignItems: "center" }}>
                        <SelectField id="ollama-chat-model" value={modelDraft} onChange={setModelDraft} options={modelOptions.length > 0 ? modelOptions : [{ value: activeSession.model, label: activeSession.model }]} />
                        <Toggle on={visionOnly} onChange={setVisionOnly} label={t("ollamaChat.visionOnlyToggle")} />
                      </div>
                    </Field>

                    <Field label={t("ollamaChat.systemPromptLabel")} id="ollama-chat-system-prompt" hint={t("ollamaChat.systemPromptHint")}>
                      <TextArea
                        id="ollama-chat-system-prompt"
                        rows={4}
                        value={systemPromptDraft}
                        onChange={e => setSystemPromptDraft(e.target.value.slice(0, MAX_SYSTEM_PROMPT_BYTES))}
                        placeholder={t("ollamaChat.systemPromptPlaceholder")}
                      />
                    </Field>

                    <h3 className="m3-card-title" style={{ fontSize: "var(--t-title-s)", marginTop: 8 }}>{t("ollamaChat.parametersTitle")}</h3>
                    <p className="m3-field-hint">{t("ollamaChat.parametersHint")}</p>

                    <Slider id="ollama-chat-temperature" label={t("ollamaChat.param.temperature")} min={PARAM_BOUNDS.temperature.min} max={PARAM_BOUNDS.temperature.max} step={PARAM_BOUNDS.temperature.step} value={parametersDraft.temperature} valueLabel={parametersDraft.temperature.toFixed(2)} onChange={v => setParametersDraft(p => ({ ...p, temperature: v }))} />
                    <Slider id="ollama-chat-topp" label={t("ollamaChat.param.topP")} min={PARAM_BOUNDS.topP.min} max={PARAM_BOUNDS.topP.max} step={PARAM_BOUNDS.topP.step} value={parametersDraft.topP} valueLabel={parametersDraft.topP.toFixed(2)} onChange={v => setParametersDraft(p => ({ ...p, topP: v }))} />
                    <Slider id="ollama-chat-topk" label={t("ollamaChat.param.topK")} min={PARAM_BOUNDS.topK.min} max={PARAM_BOUNDS.topK.max} step={PARAM_BOUNDS.topK.step} value={parametersDraft.topK} valueLabel={String(parametersDraft.topK)} onChange={v => setParametersDraft(p => ({ ...p, topK: v }))} />
                    <Slider id="ollama-chat-numctx" label={t("ollamaChat.param.numCtx")} min={PARAM_BOUNDS.numCtx.min} max={PARAM_BOUNDS.numCtx.max} step={PARAM_BOUNDS.numCtx.step} value={parametersDraft.numCtx} valueLabel={String(parametersDraft.numCtx)} onChange={v => setParametersDraft(p => ({ ...p, numCtx: v }))} />
                    <Slider id="ollama-chat-repeat" label={t("ollamaChat.param.repeatPenalty")} min={PARAM_BOUNDS.repeatPenalty.min} max={PARAM_BOUNDS.repeatPenalty.max} step={PARAM_BOUNDS.repeatPenalty.step} value={parametersDraft.repeatPenalty} valueLabel={parametersDraft.repeatPenalty.toFixed(2)} onChange={v => setParametersDraft(p => ({ ...p, repeatPenalty: v }))} />

                    <Field label={t("ollamaChat.param.seed")} id="ollama-chat-seed" hint={t("ollamaChat.seedHint")}>
                      <TextInput
                        id="ollama-chat-seed"
                        type="number"
                        value={parametersDraft.seed ?? ""}
                        onChange={e => setParametersDraft(p => ({ ...p, seed: e.target.value === "" ? null : Number(e.target.value) }))}
                        placeholder={t("ollamaChat.seedPlaceholder")}
                      />
                    </Field>

                    <div className="m3-row" style={{ gap: 8 }}>
                      <Button variant="outlined" onClick={() => setParametersDraft(DEFAULT_CHAT_PARAMETERS)}>
                        <IconRestartAlt width={16} height={16} /> {t("ollamaChat.resetDefaults")}
                      </Button>
                      <Button variant="filled" onClick={() => void handleSaveSettings()} disabled={savingSettings || activeSession.streamingMessageId !== null}>
                        <IconCheckCircle width={16} height={16} /> {savingSettings ? t("ollamaChat.saving") : t("ollamaChat.save")}
                      </Button>
                    </div>
                    {activeSession.streamingMessageId !== null && <p className="m3-field-hint">{t("ollamaChat.settingsLockedWhileStreaming")}</p>}
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>

      {createOpen && (
        <Dialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          title={t("ollamaChat.newSessionTitle")}
          actions={
            <>
              <Button variant="text" onClick={() => setCreateOpen(false)}>{t("ollamaChat.cancel")}</Button>
              <Button variant="filled" onClick={() => void handleCreate()} disabled={!createModel || creating}>{creating ? t("ollamaChat.creating") : t("ollamaChat.create")}</Button>
            </>
          }
        >
          <Field label={t("ollamaChat.modelLabel")} id="ollama-chat-create-model">
            <SelectField id="ollama-chat-create-model" value={createModel} onChange={setCreateModel} options={catalogEntries.map(e => ({ value: e.name, label: e.name }))} />
          </Field>
          <Field label={t("ollamaChat.titleLabel")} id="ollama-chat-create-title" hint={t("ollamaChat.titleHint")}>
            <TextInput id="ollama-chat-create-title" value={createTitle} onChange={e => setCreateTitle(e.target.value.slice(0, MAX_TITLE_LENGTH))} placeholder={t("ollamaChat.titlePlaceholder")} />
          </Field>
        </Dialog>
      )}
    </div>
  );
}
