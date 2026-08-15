/**
 * `/api/model-runtime/*` — the local model-runtime (Ollama) suite manager.
 *
 * Every route here is a thin caller of `src/lib/model-runtime/*`, which talks
 * only to Ollama's documented local HTTP API (health/version/tags/ps/show/
 * delete) on the loopback interface. The renderer never reaches the Ollama
 * daemon directly — the same reasoning `schedule-routes.ts` and
 * `pdf-routes.ts` give for their own outbound/fs work: this is a privileged-
 * process boundary, not a proxy the browser gets to drive itself.
 *
 * Endpoints:
 * - GET    /api/model-runtime/health   -> OllamaHealthResult
 * - GET    /api/model-runtime/catalog  -> { health, catalog: CatalogResult | null }
 * - DELETE /api/model-runtime/models   { name } -> { ok:true } | refused
 *
 * Batch pulls, streaming chat and allowlisted harness launch are explicitly
 * out of scope for this surface — see `docs/FEATURE-INVENTORY.md`'s Ollama
 * row for why they are separate lanes rather than a half-built stub here.
 */

import { checkOllamaHealth, deleteOllamaModel, resolveOllamaBaseUrl } from "../../lib/model-runtime/client";
import { buildOllamaCatalog } from "../../lib/model-runtime/catalog";
import { jsonResponse } from "../auth-cors";
import { requireLoopbackListener } from "./local-machine-gate";
import type { ManagementContext } from "./context";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

export async function handleModelRuntimeRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/model-runtime/")) return null;

  if (url.pathname === "/api/model-runtime/health" && req.method === "GET") return handleHealth(ctx);
  if (url.pathname === "/api/model-runtime/catalog" && req.method === "GET") return handleCatalog(ctx);
  if (url.pathname === "/api/model-runtime/models" && req.method === "DELETE") return handleDeleteModel(ctx);

  return null;
}
