/**
 * `ocx convert` — the headless counterpart to the dashboard's file converter
 * surface.
 *
 * Same shape as `ocx pdf` (`src/cli/pdf.ts`): every subcommand is a thin
 * client over `/api/converter/*` (`src/server/management/converter-routes.ts`),
 * which is itself a thin caller of
 * `src/lib/converter/{registry,service,archive-service,structured-service}.ts`.
 * That is the same headless-parity discipline the PDF family already proved —
 * the CLI and the GUI hit the exact same catalogue, the exact same
 * bounded-byte detection, and the exact same bounded reads/atomic writes for
 * an actual conversion, so "does the CLI agree with the dashboard" is a fact
 * about one code path rather than a claim about two kept in sync by hand.
 *
 * Local-machine-gated like every PDF/export route: refused the instant the
 * proxy is reachable from the LAN, because both endpoints read local files.
 */
import { readFileSync } from "node:fs";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import type { ConverterCatalog, DetectedSource } from "../lib/converter/types";

const STRUCTURED_FORMATS = ["json", "csv", "tsv", "xml"] as const;
type StructuredFormatArg = (typeof STRUCTURED_FORMATS)[number];

function isStructuredFormatArg(value: string): value is StructuredFormatArg {
  return (STRUCTURED_FORMATS as readonly string[]).includes(value);
}

const USAGE = [
  "Usage: ocx convert <command> [options]",
  "",
  "Commands:",
  "  catalog                    list every known format, category, and whether it is bundled and enabled",
  "  detect <path>               byte-level detection of a local file — never trusts its extension",
  "  extract-zip <path> --destination <dir>",
  "                              extract a bundled ZIP archive into a directory that does not exist yet",
  "  structured <path> --from <json|csv|tsv|xml> --to <json|csv|tsv|xml> --destination <path>",
  "                              convert a JSON/CSV/TSV/XML file, disclosing any lossy target format",
  "  queue enqueue --jobs-file <path> [--concurrency <1-8>]",
  "                              page a JSON array of conversion jobs into the durable batch queue",
  "  queue status                 report the queue's current items and summary",
  "  queue preflight --jobs-file <path>",
  "                              report the storage-capacity estimate for a would-be batch without enqueuing it",
  "  queue pause                  stop claiming new queued items (an item already converting still finishes)",
  "  queue resume                 resume claiming queued items",
  "  queue cancel [--id <id>]     cancel one queued item, or every queued item when --id is omitted",
  "  queue retry --id <id>        requeue a failed or cancelled item",
  "  queue clear                  drop every finished item (converted/skipped/cancelled/failed), keeping queued/converting ones",
  "",
  "A --jobs-file is a JSON array of job objects, each carrying an optional kind (default \"structured\"):",
  "  kind \"structured\"  : {sourcePath, sourceFormat, destPath, destFormat, acknowledgeLossy?, overwrite?}",
  "  kind \"zip-extract\" : {kind, sourcePath, destPath, overwrite?} — destPath is the extraction directory",
  "  kind \"pdf-rotate\"  : {kind, sourcePath, destPath, rotateDegrees, acknowledgeLossy?, overwrite?} — rotates every page by rotateDegrees (0/90/180/270)",
  "structured refuses a lossy target format, and pdf-rotate refuses a signed source, unless acknowledgeLossy/--acknowledge-lossy is given (boundary lossy-not-acknowledged); a queued job carries the same acknowledgeLossy field either way.",
  "Add --json for machine-readable output.",
].join("\n");

interface RouteError {
  error?: string;
  boundary?: string;
}

function reportRouteFailure(error: unknown, wantsJson: boolean): never {
  // `RuntimeApiError.body` carries the route's { error, boundary } shape,
  // exactly like `src/cli/pdf.ts`'s own `reportRouteFailure`.
  const body = (error as { body?: RouteError } | undefined)?.body;
  if (body?.boundary) {
    printData(body, wantsJson, [`Refused (${body.boundary}): ${body.error ?? "the source cannot be operated on"}`]);
    throw new CliUsageError(body.error ?? "the operation was refused");
  }
  throw error as Error;
}

async function catalog(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<ConverterCatalog>("/api/converter/catalog", {}, deps);
  const lines = result.categories.flatMap(cat => [
    `${cat.label}:`,
    ...cat.formats.map(f => f.bundled
      ? `  ${f.label} — bundled, enabled${f.operations ? ` (${f.operations.join(", ")})` : ""}`
      : `  ${f.label} — disabled: ${f.reason ?? "no reason recorded"}`),
  ]);
  printData(result, wantsJson, [
    `${result.enabledFormats} of ${result.totalFormats} known format(s) are bundled and enabled.`,
    ...lines,
  ]);
}

async function detect(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx convert detect requires a path", USAGE);
  const result = await runtimeRequest<DetectedSource>(
    "/api/converter/detect",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) },
    deps,
  );
  const summary = !result.ok
    ? `Refused (${result.boundary}): ${result.reason ?? ""}`
    : result.formatId
      ? `Detected: ${result.formatId} (${result.category}) — ${result.evidence}`
      : `Unrecognised — ${result.evidence}`;
  printData(result, wantsJson, [summary, `${result.bytesInspected} byte(s) inspected.`]);
}

interface ExtractZipResult {
  destination?: string;
  entryCount?: number;
  bytesWritten?: number;
}

async function extractZip(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  const destination = takeOption(args, "--destination");
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx convert extract-zip requires a path", USAGE);
  if (!destination) throw new CliUsageError("ocx convert extract-zip requires --destination", USAGE);
  try {
    const result = await runtimeRequest<ExtractZipResult>(
      "/api/converter/extract-zip",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, destination }) },
      deps,
    );
    printData(result, wantsJson, [`Extracted ${result.entryCount ?? 0} item(s) to ${destination}`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

interface StructuredConvertResult {
  path?: string;
  bytesWritten?: number;
  lossy?: boolean;
  notes?: string[];
}

async function structured(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const acknowledgeLossy = takeFlag(args, "--acknowledge-lossy");
  const path = args.shift();
  const from = takeOption(args, "--from");
  const to = takeOption(args, "--to");
  const destination = takeOption(args, "--destination");
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx convert structured requires a path", USAGE);
  if (!from) throw new CliUsageError("ocx convert structured requires --from", USAGE);
  if (!to) throw new CliUsageError("ocx convert structured requires --to", USAGE);
  if (!destination) throw new CliUsageError("ocx convert structured requires --destination", USAGE);
  if (!isStructuredFormatArg(from)) throw new CliUsageError(`--from must be one of json, csv, tsv, xml (got "${from}")`, USAGE);
  if (!isStructuredFormatArg(to)) throw new CliUsageError(`--to must be one of json, csv, tsv, xml (got "${to}")`, USAGE);
  try {
    const result = await runtimeRequest<StructuredConvertResult>(
      "/api/converter/convert-structured",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, sourceFormat: from, destination, destFormat: to, acknowledgeLossy }),
      },
      deps,
    );
    const lines = [`Converted ${from} -> ${to}, wrote ${destination}`];
    if (result.notes?.length) lines.push(...result.notes.map(note => `Note: ${note}`));
    printData(result, wantsJson, lines);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

/* --------------------------------------------------------------- queue */

interface QueueJobFileEntry {
  kind?: unknown;
  sourcePath?: unknown;
  sourceFormat?: unknown;
  destPath?: unknown;
  destFormat?: unknown;
  acknowledgeLossy?: unknown;
  rotateDegrees?: unknown;
  overwrite?: unknown;
}

interface QueueSummary {
  total: number;
  queued: number;
  converting: number;
  converted: number;
  skipped: number;
  cancelled: number;
  failed: number;
  outcome: string;
}

interface QueueStateResult {
  state: { paused: boolean; items: unknown[] };
  summary: QueueSummary;
  concurrency: number;
}

interface QueueEnqueueResult {
  state: { items: unknown[] };
  added: number;
}

function readJobsFile(jobsFile: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(jobsFile, "utf-8");
  } catch {
    throw new CliUsageError(`--jobs-file ${jobsFile} could not be read`, USAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError(`--jobs-file ${jobsFile} is not valid JSON`, USAGE);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliUsageError(`--jobs-file ${jobsFile} must contain a non-empty JSON array of jobs`, USAGE);
  }
  return (parsed as QueueJobFileEntry[]).map(entry => ({
    kind: entry.kind,
    sourcePath: entry.sourcePath,
    sourceFormat: entry.sourceFormat,
    destPath: entry.destPath,
    destFormat: entry.destFormat,
    acknowledgeLossy: entry.acknowledgeLossy === true,
    rotateDegrees: entry.rotateDegrees,
    overwrite: entry.overwrite === true,
  }));
}

function summaryLine(summary: QueueSummary, paused: boolean): string {
  return `${summary.total} job(s): ${summary.queued} queued, ${summary.converting} converting, `
    + `${summary.converted} converted, ${summary.skipped} skipped, ${summary.cancelled} cancelled, ${summary.failed} failed`
    + ` — ${summary.outcome}${paused ? " (paused)" : ""}`;
}

async function queueEnqueue(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const jobsFile = takeOption(args, "--jobs-file");
  const concurrency = takeOption(args, "--concurrency");
  rejectArgs(args, USAGE);
  if (!jobsFile) throw new CliUsageError("ocx convert queue enqueue requires --jobs-file", USAGE);
  const jobs = readJobsFile(jobsFile);
  try {
    const result = await runtimeRequest<QueueEnqueueResult>(
      "/api/converter/queue/enqueue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs, concurrency: concurrency ? Number(concurrency) : undefined }),
      },
      deps,
    );
    printData(result, wantsJson, [`Enqueued ${result.added} job(s); the queue now has ${result.state.items.length} item(s) total.`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function queuePreflight(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const jobsFile = takeOption(args, "--jobs-file");
  rejectArgs(args, USAGE);
  if (!jobsFile) throw new CliUsageError("ocx convert queue preflight requires --jobs-file", USAGE);
  const jobs = readJobsFile(jobsFile);
  const result = await runtimeRequest<{ preflight: { aggregateEstimatedBytes: number; aggregateSizeFullyKnown: boolean; insufficientDiskSpace: boolean; disclosure: string } }>(
    "/api/converter/queue/preflight",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobs }) },
    deps,
  );
  const p = result.preflight;
  printData(result, wantsJson, [
    `Estimated ${p.aggregateEstimatedBytes} byte(s) needed${p.aggregateSizeFullyKnown ? "" : " (partial — not every source size is known)"}.`,
    p.insufficientDiskSpace ? "Insufficient free disk space for at least one destination." : "Free disk space looks sufficient (or could not be determined).",
    p.disclosure,
  ]);
}

async function queueStatus(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<QueueStateResult>("/api/converter/queue", {}, deps);
  printData(result, wantsJson, [summaryLine(result.summary, result.state.paused)]);
}

async function queuePause(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ summary: QueueSummary }>(
    "/api/converter/queue/pause", { method: "POST" }, deps,
  );
  printData(result, wantsJson, [summaryLine(result.summary, true)]);
}

async function queueResume(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ summary: QueueSummary }>(
    "/api/converter/queue/resume-run", { method: "POST" }, deps,
  );
  printData(result, wantsJson, [summaryLine(result.summary, false)]);
}

async function queueCancel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = takeOption(args, "--id");
  rejectArgs(args, USAGE);
  try {
    const result = await runtimeRequest<{ summary?: QueueSummary }>(
      "/api/converter/queue/cancel",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(id ? { id } : {}) },
      deps,
    );
    printData(result, wantsJson, [id ? `Cancelled ${id} (if it was still queued).` : "Cancelled every queued item."]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function queueRetry(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = takeOption(args, "--id");
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("ocx convert queue retry requires --id", USAGE);
  try {
    const result = await runtimeRequest("/api/converter/queue/retry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }, deps);
    printData(result, wantsJson, [`Requeued ${id}.`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function queueClear(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ summary: QueueSummary }>(
    "/api/converter/queue/clear", { method: "POST" }, deps,
  );
  printData(result, wantsJson, [summaryLine(result.summary, false)]);
}

async function queue(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const [sub = "", ...rest] = argv;
  if (sub === "enqueue") await queueEnqueue(rest, deps);
  else if (sub === "preflight") await queuePreflight(rest, deps);
  else if (sub === "status") await queueStatus(rest, deps);
  else if (sub === "pause") await queuePause(rest, deps);
  else if (sub === "resume") await queueResume(rest, deps);
  else if (sub === "cancel") await queueCancel(rest, deps);
  else if (sub === "retry") await queueRetry(rest, deps);
  else if (sub === "clear") await queueClear(rest, deps);
  else throw new CliUsageError(`unknown convert queue command "${sub}"`, USAGE);
}

export async function handleConvertCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "", ...rest] = argv;
    if (sub === "catalog") await catalog(rest, deps);
    else if (sub === "detect") await detect(rest, deps);
    else if (sub === "extract-zip") await extractZip(rest, deps);
    else if (sub === "structured") await structured(rest, deps);
    else if (sub === "queue") await queue(rest, deps);
    else throw new CliUsageError(`unknown convert command "${sub}"`, USAGE);
  });
}

export const CONVERT_USAGE = USAGE;
