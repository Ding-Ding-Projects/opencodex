/**
 * `/api/converter/*` — the universal file converter's catalogue and
 * byte-level detection for local files.
 *
 * Same shape as `src/server/management/pdf-routes.ts` on purpose: both read
 * arbitrary local files, so both are gated the instant the proxy is exposed
 * on the LAN (`requireLoopbackListener`), and both are thin request-shape
 * validators over an fs-facing module in `src/lib/` that the CLI calls too —
 * `src/lib/converter/service.ts` here, so `ocx convert` and the dashboard can
 * never disagree about what a detection pass found.
 *
 * Endpoints:
 * - GET  /api/converter/catalog        -> ConverterCatalog
 * - POST /api/converter/detect  { path } -> DetectedSource
 */
import { isAbsolute } from "node:path";
import { buildConverterCatalog } from "../../lib/converter/registry";
import { detectSourceAtPath } from "../../lib/converter/service";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { requireLoopbackListener } from "./local-machine-gate";

function isAbsolutePathField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function badRequest(ctx: ManagementContext, message: string): Response {
  return jsonResponse({ error: message }, 400, ctx.req, ctx.config);
}

export async function handleConverterRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/converter/")) return null;

  const localOnly = requireLoopbackListener(ctx, "File converter operations");
  if (localOnly) return localOnly;

  if (url.pathname === "/api/converter/catalog" && req.method === "GET") {
    const catalog = await buildConverterCatalog();
    return jsonResponse(catalog, 200, req, config);
  }

  if (url.pathname === "/api/converter/detect" && req.method === "POST") {
    let body: { path?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    const result = await detectSourceAtPath(body.path);
    return jsonResponse(result, 200, req, config);
  }

  return null;
}
