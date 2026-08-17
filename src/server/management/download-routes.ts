/**
 * `/api/downloads/*` — the browser-extension download-capture endpoint family.
 *
 * Same loopback discipline as `pdf-routes.ts`/`converter-routes.ts`: every
 * route here can end up writing a file to the local disk, so the whole prefix
 * is refused the instant the proxy is reachable from the LAN
 * (`requireLoopbackListener`). What is different from those two is *who* is
 * allowed to call it: the opencodex browser extension (`extension/`) runs in
 * its own `*-extension://` origin, not the dashboard's, so the top-level
 * origin gate in `management-api.ts` widens specifically for this prefix — see
 * `isAllowedDownloadCaptureOrigin` in `../auth-cors.ts` for exactly how narrow
 * that widening is (loopback-only, this prefix only, extension origins only).
 *
 * Endpoints:
 * - POST   /api/downloads/capture        { url, suggestedFilename?, pageUrl?, mimeType? } -> DownloadRecord   (the extension's call)
 * - GET    /api/downloads                                                                 -> { records }
 * - GET    /api/downloads/:id                                                             -> DownloadRecord
 * - POST   /api/downloads/:id/confirm    { destinationDir?, filename? }                   -> DownloadRecord   (Start dialog: Confirm)
 * - POST   /api/downloads/:id/cancel                                                       -> DownloadRecord   (Start dialog: Cancel; also active-transfer cancel)
 * - POST   /api/downloads/:id/pause                                                        -> DownloadRecord
 * - POST   /api/downloads/:id/resume                                                       -> DownloadRecord
 * - DELETE /api/downloads/:id                                                              -> { ok: true }     (remove a finished record from history)
 */
import {
  cancelDownload,
  captureDownload,
  confirmDownload,
  getDownload,
  listDownloads,
  pauseDownload,
  removeDownload,
  resumeDownload,
} from "../../lib/downloads/manager";
import { CaptureRejectedError, DownloadNotFoundError, DownloadStateError } from "../../lib/downloads/types";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { requireLoopbackListener } from "./local-machine-gate";

function badRequest(ctx: ManagementContext, message: string): Response {
  return jsonResponse({ error: message }, 400, ctx.req, ctx.config);
}

function notFound(ctx: ManagementContext, message: string): Response {
  return jsonResponse({ error: message }, 404, ctx.req, ctx.config);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return null;
  }
}

export async function handleDownloadRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/downloads")) return null;

  const localOnly = requireLoopbackListener(ctx, "Download capture");
  if (localOnly) return localOnly;

  if (url.pathname === "/api/downloads/capture" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body === null) return badRequest(ctx, "invalid JSON body");
    if (typeof body.url !== "string") return badRequest(ctx, "url is required");
    try {
      const record = await captureDownload({
        url: body.url,
        suggestedFilename: typeof body.suggestedFilename === "string" ? body.suggestedFilename : undefined,
        pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : undefined,
        mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
        source: "extension",
      });
      return jsonResponse(record, 201, req, config);
    } catch (err) {
      if (err instanceof CaptureRejectedError) {
        return jsonResponse({ error: err.message, reason: err.reason }, 400, req, config);
      }
      throw err;
    }
  }

  if (url.pathname === "/api/downloads" && req.method === "GET") {
    return jsonResponse({ records: listDownloads() }, 200, req, config);
  }

  const idMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)(?:\/(confirm|cancel|pause|resume))?$/);
  if (!idMatch) return notFound(ctx, `Unknown endpoint: ${req.method} ${url.pathname}`);
  const [, id, action] = idMatch;

  if (!action && req.method === "GET") {
    const record = getDownload(id);
    if (!record) return notFound(ctx, `No download with id "${id}"`);
    return jsonResponse(record, 200, req, config);
  }

  if (!action && req.method === "DELETE") {
    try {
      await removeDownload(id);
      return jsonResponse({ ok: true }, 200, req, config);
    } catch (err) {
      return errorResponse(ctx, err);
    }
  }

  if (action === "confirm" && req.method === "POST") {
    const body = await readJsonBody(req) ?? {};
    try {
      const record = await confirmDownload(id, {
        destinationDir: typeof body.destinationDir === "string" ? body.destinationDir : undefined,
        filename: typeof body.filename === "string" ? body.filename : undefined,
      });
      return jsonResponse(record, 200, req, config);
    } catch (err) {
      return errorResponse(ctx, err);
    }
  }

  if (action === "cancel" && req.method === "POST") {
    try {
      return jsonResponse(await cancelDownload(id), 200, req, config);
    } catch (err) {
      return errorResponse(ctx, err);
    }
  }

  if (action === "pause" && req.method === "POST") {
    try {
      return jsonResponse(await pauseDownload(id), 200, req, config);
    } catch (err) {
      return errorResponse(ctx, err);
    }
  }

  if (action === "resume" && req.method === "POST") {
    try {
      return jsonResponse(await resumeDownload(id), 200, req, config);
    } catch (err) {
      return errorResponse(ctx, err);
    }
  }

  return notFound(ctx, `Unknown endpoint: ${req.method} ${url.pathname}`);
}

function errorResponse(ctx: ManagementContext, err: unknown): Response {
  if (err instanceof DownloadNotFoundError) return notFound(ctx, err.message);
  if (err instanceof DownloadStateError) return badRequest(ctx, err.message);
  throw err;
}
