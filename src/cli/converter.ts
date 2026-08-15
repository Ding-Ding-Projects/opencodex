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
  "",
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
        body: JSON.stringify({ path, sourceFormat: from, destination, destFormat: to }),
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

export async function handleConvertCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "", ...rest] = argv;
    if (sub === "catalog") await catalog(rest, deps);
    else if (sub === "detect") await detect(rest, deps);
    else if (sub === "extract-zip") await extractZip(rest, deps);
    else if (sub === "structured") await structured(rest, deps);
    else throw new CliUsageError(`unknown convert command "${sub}"`, USAGE);
  });
}

export const CONVERT_USAGE = USAGE;
