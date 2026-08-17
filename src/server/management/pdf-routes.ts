/**
 * `/api/pdf/*` — inspect, split, merge, extract, reorder, rotate and metadata
 * for local PDF files.
 *
 * Every route takes and returns absolute local filesystem paths, never
 * uploaded bytes: this is a desktop admin surface for files already on the
 * machine, exactly like `/api/export/open`'s VS Code handoff, and it is
 * gated the same way — `requireLoopbackListener` refuses every route the
 * instant the proxy is exposed on the LAN, because reading and writing
 * arbitrary local files is not something a remote administrator credential
 * should be able to trigger.
 *
 * All the actual PDF logic — bounded reads, the sandboxed worker, atomic
 * writes, post-write reopen validation — lives in `src/lib/pdf-tools/`. This
 * file only parses and validates the HTTP request shape and calls into that
 * module's fs-facing `service.ts`, which is the same file `src/cli/pdf.ts`
 * calls, so the GUI and the CLI can never disagree about what an operation
 * did.
 *
 * Endpoints:
 * - POST /api/pdf/inspect         { path } -> PdfInspectResult
 * - GET  /api/pdf/metadata?path=  -> PdfMetadataFields
 * - POST /api/pdf/metadata        { path, destination, fields, acknowledgeSigned? } -> WriteResult
 * - POST /api/pdf/split           { path, ranges, destinations, acknowledgeSigned? } -> WriteResult[]
 * - POST /api/pdf/merge           { paths, destination, acknowledgeSigned? } -> WriteResult
 * - POST /api/pdf/extract         { path, pages, destination, acknowledgeSigned? } -> WriteResult
 * - POST /api/pdf/reorder         { path, order, destination, acknowledgeSigned? } -> WriteResult
 * - POST /api/pdf/rotate          { path, rotations, destination, acknowledgeSigned? } -> WriteResult
 */
import { isAbsolute } from "node:path";
import {
  extractPagesAtPath,
  inspectPdfAtPath,
  mergePdfsAtPaths,
  readMetadataAtPath,
  reorderPagesAtPath,
  rotatePagesAtPath,
  splitPdfAtPath,
  writeMetadataAtPath,
} from "../../lib/pdf-tools/service";
import type { PageRange, PageRotation, PdfMetadataFields } from "../../lib/pdf-tools/types";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { requireLoopbackListener } from "./local-machine-gate";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAbsolutePathField(value: unknown): value is string {
  return isNonEmptyString(value) && isAbsolute(value);
}

function badRequest(ctx: ManagementContext, message: string): Response {
  return jsonResponse({ error: message }, 400, ctx.req, ctx.config);
}

/**
 * 422 for every failure that reaches this point: the JSON body already passed
 * this route's own shape validation (a `badRequest` 400 below), so anything
 * that still fails is the *source* that cannot satisfy the request — missing,
 * unreadable, encrypted, malformed, over a bound, or signed without
 * acknowledgement. `boundary` is carried through when the failure is a named
 * PDF-content boundary; its absence (a missing file, a required
 * acknowledgement) does not make the failure a client request-shape error.
 */
const UNPROCESSABLE = 422;

function isPageRange(value: unknown): value is PageRange {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.start === "number" && typeof o.end === "number";
}

function isPageRotation(value: unknown): value is PageRotation {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.page === "number" && typeof o.degrees === "number"
    && (o.relative === undefined || typeof o.relative === "boolean");
}

function isMetadataFields(value: unknown): value is PdfMetadataFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const stringFields = ["title", "author", "subject", "creator", "producer", "creationDate", "modificationDate"];
  for (const field of stringFields) {
    if (o[field] !== undefined && typeof o[field] !== "string") return false;
  }
  if (o.keywords !== undefined && (!Array.isArray(o.keywords) || o.keywords.some(k => typeof k !== "string"))) {
    return false;
  }
  return true;
}

export async function handlePdfRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/pdf/")) return null;

  const localOnly = requireLoopbackListener(ctx, "PDF file operations");
  if (localOnly) return localOnly;

  if (url.pathname === "/api/pdf/inspect" && req.method === "POST") {
    let body: { path?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    const result = await inspectPdfAtPath(body.path);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: result.boundary }, UNPROCESSABLE, req, config);
    return jsonResponse(result.result, 200, req, config);
  }

  if (url.pathname === "/api/pdf/metadata" && req.method === "GET") {
    const path = url.searchParams.get("path");
    if (!isAbsolutePathField(path)) return badRequest(ctx, "path must be an absolute path");
    const result = await readMetadataAtPath(path);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: result.boundary }, UNPROCESSABLE, req, config);
    return jsonResponse(result.fields, 200, req, config);
  }

  if (url.pathname === "/api/pdf/metadata" && req.method === "POST") {
    let body: { path?: unknown; destination?: unknown; fields?: unknown; acknowledgeSigned?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    if (!isMetadataFields(body.fields)) return badRequest(ctx, "fields is not a valid metadata object");
    if (body.acknowledgeSigned !== undefined && typeof body.acknowledgeSigned !== "boolean") {
      return badRequest(ctx, "acknowledgeSigned must be a boolean");
    }
    const result = await writeMetadataAtPath(body.path, body.destination, body.fields, body.acknowledgeSigned as boolean | undefined);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: "boundary" in result ? result.boundary : undefined }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  if (url.pathname === "/api/pdf/split" && req.method === "POST") {
    let body: { path?: unknown; ranges?: unknown; destinations?: unknown; acknowledgeSigned?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!Array.isArray(body.ranges) || !body.ranges.every(isPageRange)) return badRequest(ctx, "ranges must be an array of {start,end}");
    if (!Array.isArray(body.destinations) || !body.destinations.every(isAbsolutePathField)) {
      return badRequest(ctx, "destinations must be an array of absolute paths");
    }
    if (body.acknowledgeSigned !== undefined && typeof body.acknowledgeSigned !== "boolean") {
      return badRequest(ctx, "acknowledgeSigned must be a boolean");
    }
    const result = await splitPdfAtPath(body.path, body.ranges, body.destinations, body.acknowledgeSigned as boolean | undefined);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: result.boundary }, UNPROCESSABLE, req, config);
    return jsonResponse({ results: result.results }, 200, req, config);
  }

  if (url.pathname === "/api/pdf/merge" && req.method === "POST") {
    let body: { paths?: unknown; destination?: unknown; acknowledgeSigned?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!Array.isArray(body.paths) || !body.paths.length || !body.paths.every(isAbsolutePathField)) {
      return badRequest(ctx, "paths must be a non-empty array of absolute paths");
    }
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    if (body.acknowledgeSigned !== undefined && typeof body.acknowledgeSigned !== "boolean") {
      return badRequest(ctx, "acknowledgeSigned must be a boolean");
    }
    const result = await mergePdfsAtPaths(body.paths, body.destination, body.acknowledgeSigned as boolean | undefined);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: "boundary" in result ? result.boundary : undefined }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  if (url.pathname === "/api/pdf/extract" && req.method === "POST") {
    let body: { path?: unknown; pages?: unknown; destination?: unknown; acknowledgeSigned?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!Array.isArray(body.pages) || !body.pages.every(p => typeof p === "number")) return badRequest(ctx, "pages must be an array of numbers");
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    if (body.acknowledgeSigned !== undefined && typeof body.acknowledgeSigned !== "boolean") {
      return badRequest(ctx, "acknowledgeSigned must be a boolean");
    }
    const result = await extractPagesAtPath(body.path, body.destination, body.pages, body.acknowledgeSigned as boolean | undefined);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: "boundary" in result ? result.boundary : undefined }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  if (url.pathname === "/api/pdf/reorder" && req.method === "POST") {
    let body: { path?: unknown; order?: unknown; destination?: unknown; acknowledgeSigned?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!Array.isArray(body.order) || !body.order.every(p => typeof p === "number")) return badRequest(ctx, "order must be an array of numbers");
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    if (body.acknowledgeSigned !== undefined && typeof body.acknowledgeSigned !== "boolean") {
      return badRequest(ctx, "acknowledgeSigned must be a boolean");
    }
    const result = await reorderPagesAtPath(body.path, body.destination, body.order, body.acknowledgeSigned as boolean | undefined);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: "boundary" in result ? result.boundary : undefined }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  if (url.pathname === "/api/pdf/rotate" && req.method === "POST") {
    let body: { path?: unknown; rotations?: unknown; destination?: unknown; acknowledgeSigned?: unknown };
    try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
    if (!isAbsolutePathField(body.path)) return badRequest(ctx, "path must be an absolute path");
    if (!Array.isArray(body.rotations) || !body.rotations.every(isPageRotation)) {
      return badRequest(ctx, "rotations must be an array of {page,degrees,relative?}");
    }
    if (!isAbsolutePathField(body.destination)) return badRequest(ctx, "destination must be an absolute path");
    if (body.acknowledgeSigned !== undefined && typeof body.acknowledgeSigned !== "boolean") {
      return badRequest(ctx, "acknowledgeSigned must be a boolean");
    }
    const result = await rotatePagesAtPath(body.path, body.destination, body.rotations, body.acknowledgeSigned as boolean | undefined);
    if (!result.ok) return jsonResponse({ error: result.error, boundary: "boundary" in result ? result.boundary : undefined }, UNPROCESSABLE, req, config);
    return jsonResponse(result, 200, req, config);
  }

  return null;
}
