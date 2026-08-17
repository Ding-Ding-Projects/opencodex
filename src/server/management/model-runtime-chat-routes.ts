/**
 * `/api/model-runtime/chat/*` — the local model-runtime streaming chat
 * surface, the lane `docs/FEATURE-INVENTORY.md`'s Ollama row names as
 * `absent` alongside the allowlisted harness launch (a separate, still-absent
 * lane — see that row for exactly what is and is not built here).
 *
 * A thin caller of `src/lib/model-runtime/chat-engine.ts`, which talks only
 * to Ollama's documented local `/api/chat` route on the loopback interface —
 * see that module's header and `chat-client.ts`'s for the full boundary.
 *
 * ## No loopback gate here, and why that is deliberate
 *
 * `requireLoopbackListener` exists for "actions that start host processes or
 * mutate installed software" (its own header). Every route below does
 * neither: a chat turn calls an already-running daemon's inference route
 * (no new process spawned, nothing installed or removed), and session
 * CRUD is this app's own local JSON state, the same class of action
 * `pull-queue-engine.ts`'s `clearFinishedItems` already treats as ungated
 * "pure housekeeping". Model *deletion* and *pulling* remain gated in
 * `model-runtime-routes.ts` because those genuinely install/remove bytes on
 * the host — chat inference and chat history do not.
 *
 * Endpoints:
 * - GET    /api/model-runtime/chat/sessions                    -> { ok:true, sessions: ChatSessionSummary[] }
 * - POST   /api/model-runtime/chat/sessions   { model, title?, systemPrompt?, parameters? } -> { ok:true, session } | { ok:false, error }
 * - GET    /api/model-runtime/chat/sessions/:id                -> { ok:true, session } | 404
 * - PATCH  /api/model-runtime/chat/sessions/:id  { title?, model?, systemPrompt?, parameters? } -> { ok:true, session } | error
 * - DELETE /api/model-runtime/chat/sessions/:id                -> { ok:true } | 404
 * - POST   /api/model-runtime/chat/sessions/:id/messages  { content, attachments? } -> a streamed `application/x-ndjson` body (real, token-by-token) with the new message ids on `X-Chat-User-Message-Id`/`X-Chat-Assistant-Message-Id`, or a JSON error before any streaming begins
 * - POST   /api/model-runtime/chat/sessions/:id/regenerate      -> same streamed shape, replacing the last finished reply
 * - POST   /api/model-runtime/chat/sessions/:id/stop            -> { ok:true } | 404 — aborts the in-flight turn; see `chat-engine.ts`'s header for why closing the connection is the real cancel action
 * - GET    /api/model-runtime/chat/export?sessionId=<id>&format=json|md -> a redacted export (all sessions when `sessionId` is omitted)
 */

import { checkOllamaHealth } from "../../lib/model-runtime/client";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  regenerateLastTurn,
  startChatTurn,
  stopChatTurn,
  updateChatSession,
  type RawAttachmentInput,
} from "../../lib/model-runtime/chat-engine";
import { buildChatExport, chatExportToMarkdown } from "../../lib/model-runtime/chat-export";
import { getChatState } from "../../lib/model-runtime/chat-store";
import type { ChatParameters } from "../../lib/model-runtime/chat-types";
import { corsHeaders, jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return null;
  }
}

function readParametersInput(body: Record<string, unknown>): Partial<ChatParameters> | undefined {
  const raw = body.parameters;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<ChatParameters> = {};
  if (typeof r.temperature === "number") out.temperature = r.temperature;
  if (typeof r.topP === "number") out.topP = r.topP;
  if (typeof r.topK === "number") out.topK = r.topK;
  if (typeof r.numCtx === "number") out.numCtx = r.numCtx;
  if (typeof r.repeatPenalty === "number") out.repeatPenalty = r.repeatPenalty;
  if (typeof r.seed === "number" || r.seed === null) out.seed = r.seed as number | null;
  return out;
}

function readAttachmentsInput(body: Record<string, unknown>): RawAttachmentInput[] | undefined {
  const raw = body.attachments;
  if (!Array.isArray(raw)) return undefined;
  return raw.map(item => {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return { name: r.name, mimeType: r.mimeType, dataBase64: r.dataBase64 } satisfies RawAttachmentInput;
  });
}

function streamResponse(stream: ReadableStream<Uint8Array>, req: Request, config: ManagementContext["config"], extraHeaders: Record<string, string>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
      ...corsHeaders(req, config),
    },
  });
}

async function handleListSessions(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  return jsonResponse({ ok: true, sessions: listChatSessions() }, 200, req, config);
}

async function handleCreateSession(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const body = await readJsonBody(req);
  if (body === null) return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config);
  if (!isNonEmptyString(body.model)) return jsonResponse({ ok: false, error: "model is required" }, 400, req, config);

  const result = createChatSession({
    model: body.model.trim(),
    title: typeof body.title === "string" ? body.title : undefined,
    systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
    parameters: readParametersInput(body),
  });
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 400, req, config);
  return jsonResponse({ ok: true, session: result.session }, 201, req, config);
}

async function handleGetSession(ctx: ManagementContext, id: string): Promise<Response> {
  const { req, config } = ctx;
  const session = getChatSession(id);
  if (!session) return jsonResponse({ ok: false, error: `no chat session with id "${id}"` }, 404, req, config);
  return jsonResponse({ ok: true, session }, 200, req, config);
}

async function handleUpdateSession(ctx: ManagementContext, id: string): Promise<Response> {
  const { req, config } = ctx;
  const body = await readJsonBody(req);
  if (body === null) return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config);

  const result = updateChatSession(id, {
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
    parameters: readParametersInput(body),
  });
  if (!result.ok) {
    const status = result.error === "no such chat session" ? 404 : 400;
    return jsonResponse({ ok: false, error: result.error }, status, req, config);
  }
  return jsonResponse({ ok: true, session: result.session }, 200, req, config);
}

async function handleDeleteSession(ctx: ManagementContext, id: string): Promise<Response> {
  const { req, config } = ctx;
  const result = deleteChatSession(id);
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 404, req, config);
  return jsonResponse({ ok: true }, 200, req, config);
}

async function handleSendMessage(ctx: ManagementContext, id: string): Promise<Response> {
  const { req, config } = ctx;
  const body = await readJsonBody(req);
  if (body === null) return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config);

  const health = await checkOllamaHealth();
  if (health.state !== "healthy") {
    return jsonResponse({ ok: false, error: `the runtime is not healthy (${health.state}); start it before sending a message` }, 409, req, config);
  }

  const result = await startChatTurn(health.baseUrl, id, {
    content: typeof body.content === "string" ? body.content : "",
    attachments: readAttachmentsInput(body),
  });
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status, req, config);

  return streamResponse(result.stream, req, config, {
    "X-Chat-User-Message-Id": result.userMessage.id,
    "X-Chat-Assistant-Message-Id": result.assistantMessageId,
  });
}

async function handleRegenerate(ctx: ManagementContext, id: string): Promise<Response> {
  const { req, config } = ctx;
  const health = await checkOllamaHealth();
  if (health.state !== "healthy") {
    return jsonResponse({ ok: false, error: `the runtime is not healthy (${health.state}); start it before regenerating a reply` }, 409, req, config);
  }
  const result = regenerateLastTurn(health.baseUrl, id);
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status, req, config);
  return streamResponse(result.stream, req, config, { "X-Chat-Assistant-Message-Id": result.assistantMessageId });
}

async function handleStop(ctx: ManagementContext, id: string): Promise<Response> {
  const { req, config } = ctx;
  const result = stopChatTurn(id);
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 404, req, config);
  return jsonResponse({ ok: true }, 200, req, config);
}

async function handleExport(ctx: ManagementContext): Promise<Response> {
  const { req, config, url } = ctx;
  const sessionId = url.searchParams.get("sessionId");
  const format = url.searchParams.get("format") === "md" ? "md" : "json";

  const allSessions = getChatState().sessions;
  const sessions = sessionId ? allSessions.filter(s => s.id === sessionId) : allSessions;
  if (sessionId && sessions.length === 0) return jsonResponse({ ok: false, error: `no chat session with id "${sessionId}"` }, 404, req, config);

  const exportData = buildChatExport(sessions);
  const stamp = new Date(exportData.exportedAt).toISOString().replace(/[:.]/g, "-");
  if (format === "md") {
    const markdown = chatExportToMarkdown(exportData);
    return new Response(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="ocx-chat-export-${stamp}.md"`,
        ...corsHeaders(req, config),
      },
    });
  }
  return new Response(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="ocx-chat-export-${stamp}.json"`,
      ...corsHeaders(req, config),
    },
  });
}

export async function handleModelRuntimeChatRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/model-runtime/chat/")) return null;

  if (url.pathname === "/api/model-runtime/chat/sessions" && req.method === "GET") return handleListSessions(ctx);
  if (url.pathname === "/api/model-runtime/chat/sessions" && req.method === "POST") return handleCreateSession(ctx);
  if (url.pathname === "/api/model-runtime/chat/export" && req.method === "GET") return handleExport(ctx);

  const sessionMatch = url.pathname.match(/^\/api\/model-runtime\/chat\/sessions\/([^/]+)(?:\/(messages|regenerate|stop))?$/);
  if (!sessionMatch) return null;
  const [, id, action] = sessionMatch;

  if (!action && req.method === "GET") return handleGetSession(ctx, id);
  if (!action && req.method === "PATCH") return handleUpdateSession(ctx, id);
  if (!action && req.method === "DELETE") return handleDeleteSession(ctx, id);
  if (action === "messages" && req.method === "POST") return handleSendMessage(ctx, id);
  if (action === "regenerate" && req.method === "POST") return handleRegenerate(ctx, id);
  if (action === "stop" && req.method === "POST") return handleStop(ctx, id);

  return null;
}
