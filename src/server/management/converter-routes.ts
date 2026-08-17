/**
 * `/api/converter/*` — the universal file converter's catalogue, byte-level
 * detection, and the two bundled families' actual conversions for local
 * files.
 *
 * Same shape as `src/server/management/pdf-routes.ts` on purpose: both read
 * arbitrary local files, so both are gated the instant the proxy is exposed
 * on the LAN (`requireLoopbackListener`), and both are thin request-shape
 * validators over an fs-facing module in `src/lib/` that the CLI calls too —
 * `src/lib/converter/{service,archive-service,structured-service}.ts` here,
 * so `ocx convert` and the dashboard can never disagree about what detection
 * found or what a conversion actually did. Every bounded read, atomic write,
 * path-traversal refusal and lossy-conversion disclosure already lives in
 * those services; this file only parses and validates the request shape and
 * forwards to them, exactly like `pdf-routes.ts` does for `pdf-tools/service.ts`.
 *
 * Endpoints:
 * - GET  /api/converter/catalog             -> ConverterCatalog
 * - POST /api/converter/detect              { path } -> DetectedSource
 * - POST /api/converter/extract-zip         { path, destination } -> ExtractZipAtPathResult
 * - POST /api/converter/convert-structured  { path, sourceFormat, destination, destFormat, acknowledgeLossy? } -> StructuredConversionOutcome
 */
import { isAbsolute } from "node:path";
import { extractZipAtPath } from "../../lib/converter/archive-service";
import { buildConverterCatalog } from "../../lib/converter/registry";
import { detectSourceAtPath } from "../../lib/converter/service";
import { convertStructuredDataAtPath, type StructuredFormat } from "../../lib/converter/structured-service";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { requireLoopbackListener } from "./local-machine-gate";

function isAbsolutePathField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

const STRUCTURED_FORMATS: readonly StructuredFormat[] = ["json", "csv", "tsv", "xml"];

function isStructuredFormat(value: unknown): value is StructuredFormat {
  return typeof value === "string" && (STRUCTURED_FORMATS as readonly string[]).includes(value);
}

function badRequest(ctx: ManagementContext, message: string): Response {
  return jsonResponse({ error: message }, 400, ctx.req, ctx.config);
}

/**
 * 422 for every failure that reaches this point, mirroring `pdf-routes.ts`'s
 * own `UNPROCESSABLE`: the JSON body already passed this route's own shape
 * validation (a `badRequest` 400 above), so anything that still fails is the
 * *source* or the *conversion* that cannot satisfy the request — missing,
 * unreadable, malformed, over a bound, or an already-occupied destination —
 * never a client request-shape error.
 */
const UNPROCESSABLE = 422;

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

  if (url.pathname === "/api/converter/extract-zip" && req.method === "POST") {
    let body: { path?: unknown; destination?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    const result = extractZipAtPath(body.path, body.destination);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: result.boundary }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  if (url.pathname === "/api/converter/convert-structured" && req.method === "POST") {
    let body: { path?: unknown; sourceFormat?: unknown; destination?: unknown; destFormat?: unknown; acknowledgeLossy?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!isStructuredFormat(body.sourceFormat)) return badRequest(ctx, "sourceFormat must be one of json, csv, tsv, xml");
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    if (!isStructuredFormat(body.destFormat)) return badRequest(ctx, "destFormat must be one of json, csv, tsv, xml");
    if (body.acknowledgeLossy !== undefined && typeof body.acknowledgeLossy !== "boolean") {
      return badRequest(ctx, "acknowledgeLossy must be a boolean");
    }
    const result = convertStructuredDataAtPath(
      body.path, body.sourceFormat, body.destination, body.destFormat, body.acknowledgeLossy as boolean | undefined,
    );
    if (!result.ok) return jsonResponse({ error: result.error, boundary: result.boundary, lossy: result.lossy, notes: result.notes }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  return null;
}
