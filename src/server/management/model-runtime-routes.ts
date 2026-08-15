/**
 * `/api/model-runtime/*` — the local model-runtime (Ollama) suite manager.
 *
 * Every route here is a thin caller of `src/lib/model-runtime/*`, which talks
 * only to Ollama's documented local HTTP API (health/version/tags/ps/show/
 * delete/pull) on the loopback interface. The renderer never reaches the
 * Ollama daemon directly — the same reasoning `schedule-routes.ts` and
 * `pdf-routes.ts` give for their own outbound/fs work: this is a privileged-
 * process boundary, not a proxy the browser gets to drive itself.
 *
 * Endpoints:
 * - GET    /api/model-runtime/health   -> OllamaHealthResult
 * - GET    /api/model-runtime/catalog  -> { health, catalog: CatalogResult | null }
 * - DELETE /api/model-runtime/models   { name } -> { ok:true } | refused
 * - POST   /api/model-runtime/pull-queue/preflight { tags } -> PullPreflight — read-only, no gate
 * - GET    /api/model-runtime/pull-queue           -> { state, summary } — read-only, no gate, never resumes/kicks processing
 * - POST   /api/model-runtime/pull-queue/resume    -> reconciles the persisted queue against real current state and continues any still-queued item — loopback-gated
 * - POST   /api/model-runtime/pull-queue/start     { tags, concurrency?, force? } -> loopback-gated
 * - POST   /api/model-runtime/pull-queue/cancel    { id? } -> cancel one item, or every non-terminal item when `id` is omitted — loopback-gated
 * - POST   /api/model-runtime/pull-queue/retry     { id } -> loopback-gated
 * - POST   /api/model-runtime/pull-queue/clear     -> drops finished items only — loopback-gated
 *
 * The pull-queue routes are gated the same way model deletion is: pulling a
 * model downloads and installs real bytes onto this machine, exactly the
 * "starts a host process or mutates installed software" class of action
 * `local-machine-gate.ts` exists for. The plain state GET is intentionally
 * NOT gated — it never triggers a network call or resumes anything, it only
 * reports whatever is already in memory, the same as health/catalog.
 *
 * Streaming chat now lives at `/api/model-runtime/chat/*`
 * (`model-runtime-chat-routes.ts`) rather than being folded into this file.
 * The allowlisted harness launch remains explicitly out of scope for this
 * surface — see `docs/FEATURE-INVENTORY.md`'s Ollama row for
 * why they are separate lanes rather than a half-built stub here.
 */

import { checkOllamaHealth, deleteOllamaModel, resolveOllamaBaseUrl } from "../../lib/model-runtime/client";
import { buildOllamaCatalog } from "../../lib/model-runtime/catalog";
import { buildPullPreflight } from "../../lib/model-runtime/pull-preflight";
import {
  cancelAllPending,
  cancelItem,
  clearFinishedItems,
  ensureResumed,
  getConcurrencyLimit,
  getQueueSnapshot,
  retryItem,
  startBatchPull,
} from "../../lib/model-runtime/pull-queue-engine";
import { jsonResponse } from "../auth-cors";
import { requireLoopbackListener } from "./local-machine-gate";
import type { ManagementContext } from "./context";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string");
}

async function handleHealth(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const result = await checkOllamaHealth();
  return jsonResponse(result, 200, req, config);
}

async function handleCatalog(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const health = await checkOllamaHealth();
  if (health.state !== "healthy") {
    return jsonResponse({ health, catalog: null }, 200, req, config);
  }
  const catalog = await buildOllamaCatalog(health.baseUrl, health.version);
  return jsonResponse({ health, catalog }, 200, req, config);
}

async function handleDeleteModel(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Removing a local model");
  if (localOnly) return localOnly;

  let body: { name?: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config); }
  if (!isNonEmptyString(body.name)) return jsonResponse({ ok: false, error: "name is required" }, 400, req, config);

  const { baseUrl } = resolveOllamaBaseUrl();
  const result = await deleteOllamaModel(baseUrl, body.name.trim());
  if (!result.ok) {
    const detail = result.failure.kind === "http" ? `HTTP ${result.failure.status}`
      : result.failure.kind === "refused" ? "the runtime refused the connection"
      : result.failure.kind === "timeout" ? "the request timed out"
      : result.failure.kind === "too-large" ? "the response exceeded the size limit"
      : result.failure.kind === "malformed" ? result.failure.error
      : result.failure.error;
    return jsonResponse({ ok: false, error: detail }, 502, req, config);
  }
  return jsonResponse({ ok: true }, 200, req, config);
}

/* ---------------------------------------------------------- pull queue */

function parseTagsBody(body: { tags?: unknown }): string[] | null {
  if (!isStringArray(body.tags)) return null;
  return body.tags;
}

async function handlePreflight(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: { tags?: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config); }
  const tags = parseTagsBody(body);
  if (!tags || tags.length === 0) return jsonResponse({ ok: false, error: "tags must be a non-empty array of strings" }, 400, req, config);

  const health = await checkOllamaHealth();
  if (health.state !== "healthy") {
    return jsonResponse({ ok: true, preflight: buildPullPreflight(tags, null, null) }, 200, req, config);
  }
  const catalog = await buildOllamaCatalog(health.baseUrl, health.version);
  return jsonResponse({ ok: true, preflight: buildPullPreflight(tags, catalog.entries, catalog.hardware) }, 200, req, config);
}

function handleQueueState(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const { state, summary } = getQueueSnapshot();
  return jsonResponse({ ok: true, state, summary, concurrency: getConcurrencyLimit() }, 200, req, config);
}

async function handleResume(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Resuming the batch-pull queue");
  if (localOnly) return localOnly;
  const { baseUrl } = resolveOllamaBaseUrl();
  const state = await ensureResumed(baseUrl);
  return jsonResponse({ ok: true, state, concurrency: getConcurrencyLimit() }, 200, req, config);
}

async function handleStart(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Starting a model pull");
  if (localOnly) return localOnly;

  let body: { tags?: unknown; concurrency?: unknown; force?: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config); }
  const tags = parseTagsBody(body);
  if (!tags) return jsonResponse({ ok: false, error: "tags must be an array of strings" }, 400, req, config);

  const health = await checkOllamaHealth();
  if (health.state !== "healthy") {
    return jsonResponse({ ok: false, error: `the runtime is not healthy (${health.state}); start it before pulling` }, 409, req, config);
  }

  const result = await startBatchPull(health.baseUrl, tags, {
    concurrency: typeof body.concurrency === "number" ? body.concurrency : undefined,
    force: body.force === true,
  });
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 400, req, config);
  return jsonResponse({ ok: true, state: result.state, concurrency: getConcurrencyLimit() }, 200, req, config);
}

async function handleCancel(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Cancelling a model pull");
  if (localOnly) return localOnly;

  let body: { id?: unknown } = {};
  try { body = await req.json(); } catch { /* an empty/absent body means "cancel everything", handled below */ }

  if (body.id === undefined) {
    const summary = cancelAllPending();
    return jsonResponse({ ok: true, summary }, 200, req, config);
  }
  if (!isNonEmptyString(body.id)) return jsonResponse({ ok: false, error: "id must be a non-empty string" }, 400, req, config);
  const result = cancelItem(body.id.trim());
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 404, req, config);
  return jsonResponse({ ok: true, state: result.state }, 200, req, config);
}

async function handleRetry(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Retrying a model pull");
  if (localOnly) return localOnly;

  let body: { id?: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config); }
  if (!isNonEmptyString(body.id)) return jsonResponse({ ok: false, error: "id is required" }, 400, req, config);

  const { baseUrl } = resolveOllamaBaseUrl();
  const result = retryItem(baseUrl, body.id.trim());
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 400, req, config);
  return jsonResponse({ ok: true, state: result.state }, 200, req, config);
}

function handleClear(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Clearing finished pull-queue items");
  if (localOnly) return localOnly;
  const summary = clearFinishedItems();
  return jsonResponse({ ok: true, summary }, 200, req, config);
}

export async function handleModelRuntimeRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/model-runtime/")) return null;

  if (url.pathname === "/api/model-runtime/health" && req.method === "GET") return handleHealth(ctx);
  if (url.pathname === "/api/model-runtime/catalog" && req.method === "GET") return handleCatalog(ctx);
  if (url.pathname === "/api/model-runtime/models" && req.method === "DELETE") return handleDeleteModel(ctx);

  if (url.pathname === "/api/model-runtime/pull-queue/preflight" && req.method === "POST") return handlePreflight(ctx);
  if (url.pathname === "/api/model-runtime/pull-queue" && req.method === "GET") return handleQueueState(ctx);
  if (url.pathname === "/api/model-runtime/pull-queue/resume" && req.method === "POST") return handleResume(ctx);
  if (url.pathname === "/api/model-runtime/pull-queue/start" && req.method === "POST") return handleStart(ctx);
  if (url.pathname === "/api/model-runtime/pull-queue/cancel" && req.method === "POST") return handleCancel(ctx);
  if (url.pathname === "/api/model-runtime/pull-queue/retry" && req.method === "POST") return handleRetry(ctx);
  if (url.pathname === "/api/model-runtime/pull-queue/clear" && req.method === "POST") return handleClear(ctx);

  return null;
}
