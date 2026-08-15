/**
 * `/api/converter/queue/*` — the converter's resumable batch queue.
 *
 * Same shape as `/api/model-runtime/pull-queue/*`
 * (`src/server/management/model-runtime-routes.ts`) on purpose: both are thin
 * request-shape validators over a durable, resumable engine in `src/lib/`
 * that the GUI and `ocx convert queue` (`src/cli/converter.ts`) call
 * identically — `src/lib/converter/queue-engine.ts` here. Every job this
 * queue runs still goes through `convertStructuredDataAtPath`, so the
 * lossy-disclosure enforcement in `structured-service.ts` applies to a
 * queued job exactly as it does to a single ad-hoc conversion; the queue
 * adds no separate code path around it.
 *
 * Endpoints:
 * - POST /api/converter/queue/preflight  { jobs: [{ destPath, sourcePath? }] } -> ConvertQueuePreflight — read-only, no gate
 * - GET  /api/converter/queue            -> { state, summary, concurrency } — read-only, no gate, never resumes/kicks processing
 * - POST /api/converter/queue/resume     -> reconciles the persisted queue after a restart and continues any still-queued item — loopback-gated
 * - POST /api/converter/queue/enqueue    { jobs: ConvertJobInput[] } -> loopback-gated
 * - POST /api/converter/queue/pause      -> loopback-gated
 * - POST /api/converter/queue/resume-run -> resumes a paused queue and continues processing — loopback-gated
 * - POST /api/converter/queue/cancel     { id? } -> cancel one item, or every non-terminal item when `id` is omitted — loopback-gated
 * - POST /api/converter/queue/retry      { id } -> loopback-gated
 * - POST /api/converter/queue/clear      -> drops finished items only — loopback-gated
 *
 * Gated the same way a single conversion already is
 * (`converter-routes.ts`'s `requireLoopbackListener` call): every mutating
 * route here reads and writes real local files, so it is refused the instant
 * the proxy is reachable from the LAN. The plain state GET and the
 * preflight are intentionally NOT gated — the GET only reports whatever is
 * already in memory and the preflight only stats files and probes free disk
 * space, neither of which starts or continues any work.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  cancelAllPending,
  cancelItem,
  clearFinishedItems,
  ensureQueueResumed,
  enqueueConvertJobs,
  getConcurrencyLimit,
  getQueueSnapshot,
  pauseQueue,
  resumeQueue,
  retryItem,
  setConcurrencyLimit,
  type ConvertJobInput,
} from "../../lib/converter/queue-engine";
import { buildConvertQueuePreflight } from "../../lib/converter/queue-preflight";
import type { StructuredFormat } from "../../lib/converter/structured-service";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { requireLoopbackListener } from "./local-machine-gate";

const STRUCTURED_FORMATS: readonly StructuredFormat[] = ["json", "csv", "tsv", "xml"];

function isStructuredFormat(value: unknown): value is StructuredFormat {
  return typeof value === "string" && (STRUCTURED_FORMATS as readonly string[]).includes(value);
}

function isAbsolutePathField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function badRequest(ctx: ManagementContext, message: string): Response {
  return jsonResponse({ error: message }, 400, ctx.req, ctx.config);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

interface JobBody {
  sourcePath?: unknown;
  sourceFormat?: unknown;
  destPath?: unknown;
  destFormat?: unknown;
  acknowledgeLossy?: unknown;
  overwrite?: unknown;
}

function parseJobsBody(body: { jobs?: unknown }): ConvertJobInput[] | { error: string } {
  if (!Array.isArray(body.jobs) || body.jobs.length === 0) return { error: "jobs must be a non-empty array" };
  const jobs: ConvertJobInput[] = [];
  for (const raw of body.jobs as JobBody[]) {
    if (!raw || typeof raw !== "object") return { error: "each job must be an object" };
    if (!isAbsolutePathField(raw.sourcePath)) return { error: "each job's sourcePath must be an absolute path" };
    if (!isStructuredFormat(raw.sourceFormat)) return { error: "each job's sourceFormat must be one of json, csv, tsv, xml" };
    if (!isAbsolutePathField(raw.destPath)) return { error: "each job's destPath must be an absolute path" };
    if (!isStructuredFormat(raw.destFormat)) return { error: "each job's destFormat must be one of json, csv, tsv, xml" };
    if (raw.acknowledgeLossy !== undefined && typeof raw.acknowledgeLossy !== "boolean") return { error: "each job's acknowledgeLossy must be a boolean" };
    if (raw.overwrite !== undefined && typeof raw.overwrite !== "boolean") return { error: "each job's overwrite must be a boolean" };
    jobs.push({
      sourcePath: raw.sourcePath,
      sourceFormat: raw.sourceFormat,
      destPath: raw.destPath,
      destFormat: raw.destFormat,
      acknowledgeLossy: raw.acknowledgeLossy === true,
      overwrite: raw.overwrite === true,
    });
  }
  return jobs;
}

async function handlePreflight(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: { jobs?: unknown };
  try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
  const parsed = parseJobsBody(body);
  if (!Array.isArray(parsed)) return badRequest(ctx, parsed.error);

  const withSizes = parsed.map(job => {
    let sourceBytes: number | null = null;
    try {
      const stat = statSync(job.sourcePath);
      sourceBytes = stat.isFile() ? stat.size : null;
    } catch { /* honestly unknown — reported as null, never guessed */ }
    return { destPath: job.destPath, sourceBytes };
  });
  const preflight = await buildConvertQueuePreflight(withSizes);
  return jsonResponse({ ok: true, preflight }, 200, req, config);
}

function handleQueueState(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const { state, summary } = getQueueSnapshot();
  return jsonResponse({ ok: true, state, summary, concurrency: getConcurrencyLimit() }, 200, req, config);
}

function handleResume(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Resuming the converter batch queue");
  if (localOnly) return localOnly;
  const state = ensureQueueResumed();
  return jsonResponse({ ok: true, state, concurrency: getConcurrencyLimit() }, 200, req, config);
}

async function handleEnqueue(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Enqueuing a converter batch job");
  if (localOnly) return localOnly;

  let body: { jobs?: unknown; concurrency?: unknown };
  try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
  const parsed = parseJobsBody(body);
  if (!Array.isArray(parsed)) return badRequest(ctx, parsed.error);
  if (typeof body.concurrency === "number") setConcurrencyLimit(body.concurrency);

  const result = await enqueueConvertJobs(parsed);
  if (!result.ok) return jsonResponse({ ok: false, error: result.error, preflight: result.preflight }, 422, req, config);
  return jsonResponse({ ok: true, state: result.state, added: result.added, preflight: result.preflight, concurrency: getConcurrencyLimit() }, 200, req, config);
}

function handlePause(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Pausing the converter batch queue");
  if (localOnly) return localOnly;
  const summary = pauseQueue();
  return jsonResponse({ ok: true, summary }, 200, req, config);
}

function handleResumeRun(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Resuming the converter batch queue");
  if (localOnly) return localOnly;
  const summary = resumeQueue();
  return jsonResponse({ ok: true, summary }, 200, req, config);
}

async function handleCancel(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Cancelling a converter batch job");
  if (localOnly) return localOnly;

  let body: { id?: unknown } = {};
  try { body = await req.json(); } catch { /* an empty/absent body means "cancel everything pending" */ }

  if (body.id === undefined) {
    const summary = cancelAllPending();
    return jsonResponse({ ok: true, summary }, 200, req, config);
  }
  if (!isNonEmptyString(body.id)) return badRequest(ctx, "id must be a non-empty string");
  const result = cancelItem(body.id.trim());
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 404, req, config);
  return jsonResponse({ ok: true, state: result.state }, 200, req, config);
}

async function handleRetry(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Retrying a converter batch job");
  if (localOnly) return localOnly;

  let body: { id?: unknown };
  try { body = await req.json(); } catch { return badRequest(ctx, "invalid JSON body"); }
  if (!isNonEmptyString(body.id)) return badRequest(ctx, "id is required");

  const result = retryItem(body.id.trim());
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 400, req, config);
  return jsonResponse({ ok: true, state: result.state }, 200, req, config);
}

function handleClear(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const localOnly = requireLoopbackListener(ctx, "Clearing finished converter batch jobs");
  if (localOnly) return localOnly;
  const summary = clearFinishedItems();
  return jsonResponse({ ok: true, summary }, 200, req, config);
}

export async function handleConverterQueueRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/converter/queue")) return null;

  if (url.pathname === "/api/converter/queue/preflight" && req.method === "POST") return handlePreflight(ctx);
  if (url.pathname === "/api/converter/queue" && req.method === "GET") return handleQueueState(ctx);
  if (url.pathname === "/api/converter/queue/resume" && req.method === "POST") return handleResume(ctx);
  if (url.pathname === "/api/converter/queue/enqueue" && req.method === "POST") return handleEnqueue(ctx);
  if (url.pathname === "/api/converter/queue/pause" && req.method === "POST") return handlePause(ctx);
  if (url.pathname === "/api/converter/queue/resume-run" && req.method === "POST") return handleResumeRun(ctx);
  if (url.pathname === "/api/converter/queue/cancel" && req.method === "POST") return handleCancel(ctx);
  if (url.pathname === "/api/converter/queue/retry" && req.method === "POST") return handleRetry(ctx);
  if (url.pathname === "/api/converter/queue/clear" && req.method === "POST") return handleClear(ctx);

  return null;
}
