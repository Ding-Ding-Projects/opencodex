/**
 * `ocx pdf` — the headless counterpart to the dashboard's PDF tools surface.
 *
 * Every subcommand is a thin client over `/api/pdf/*`
 * (`src/server/management/pdf-routes.ts`), which is itself a thin caller of
 * `src/lib/pdf-tools/service.ts`. That is deliberate: the CLI and the GUI hit
 * the exact same validation, the same sandboxed operation, the same atomic
 * write and the same post-write reopen check, so "does the CLI actually
 * behave like the GUI" is a fact about one code path rather than a claim
 * about two that were kept in sync by hand.
 *
 * Every route this file calls is local-machine-gated
 * (`requireLoopbackListener`) because it reads and writes files on the
 * machine the proxy is running on; a proxy deliberately exposed on the LAN
 * refuses every one of these commands with the same message the dashboard
 * would get.
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
import type {
  PageRange,
  PageRotation,
  PdfInspectResult,
  PdfMetadataFields,
} from "../lib/pdf-tools/types";

const USAGE = [
  "Usage: ocx pdf <command> [options]",
  "",
  "Commands:",
  "  inspect <path>                                    inspect pages, metadata and capabilities",
  "  metadata read <path>                               print metadata fields",
  "  metadata write <path> --destination <path> [fields]  write metadata fields",
  "  split <path> --ranges <r,r,...> --destinations <p,p,...>  split into page ranges",
  "  merge --sources <p,p,...> --destination <path>     concatenate PDFs in order",
  "  extract <path> --pages <n,n,...> --destination <path>  pull specific pages into one PDF",
  "  reorder <path> --order <n,n,...> --destination <path>  reorder every page",
  "  rotate <path> --rotations <n:deg,n:deg,...> --destination <path> [--relative]  set page rotation",
  "",
  "Metadata fields: --title --author --subject --creator --producer --keywords a,b,c",
  "                 --creation-date <ISO8601> --modification-date <ISO8601>",
  "Every mutating command accepts --acknowledge-signed, required when the source is digitally signed.",
  "Add --json for machine-readable output.",
].join("\n");

interface RouteError {
  error?: string;
  boundary?: string;
}

function parseOrderedNumbers(raw: string, label: string): number[] {
  const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new CliUsageError(`${label} must list at least one page number`, USAGE);
  return parts.map(part => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) throw new CliUsageError(`${label} has an invalid page number: "${part}"`, USAGE);
    return n;
  });
}

function parseRanges(raw: string): PageRange[] {
  const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new CliUsageError("--ranges must list at least one range", USAGE);
  return parts.map(part => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new CliUsageError(`--ranges has an invalid entry: "${part}" (expected N or N-M)`, USAGE);
    const start = Number(match[1]);
    const end = match[2] !== undefined ? Number(match[2]) : start;
    return { start, end };
  });
}

function parseRotations(raw: string, relative: boolean): PageRotation[] {
  const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new CliUsageError("--rotations must list at least one entry", USAGE);
  return parts.map(part => {
    const match = /^(\d+):(-?\d+)$/.exec(part);
    if (!match) throw new CliUsageError(`--rotations has an invalid entry: "${part}" (expected page:degrees)`, USAGE);
    return { page: Number(match[1]), degrees: Number(match[2]), relative };
  });
}

function parsePaths(raw: string, label: string): string[] {
  const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new CliUsageError(`${label} must list at least one path`, USAGE);
  return parts;
}

function metadataFieldsFromArgs(args: string[]): PdfMetadataFields {
  const fields: PdfMetadataFields = {};
  const title = takeOption(args, "--title");
  const author = takeOption(args, "--author");
  const subject = takeOption(args, "--subject");
  const creator = takeOption(args, "--creator");
  const producer = takeOption(args, "--producer");
  const keywords = takeOption(args, "--keywords");
  const creationDate = takeOption(args, "--creation-date");
  const modificationDate = takeOption(args, "--modification-date");
  if (title !== undefined) fields.title = title;
  if (author !== undefined) fields.author = author;
  if (subject !== undefined) fields.subject = subject;
  if (creator !== undefined) fields.creator = creator;
  if (producer !== undefined) fields.producer = producer;
  if (keywords !== undefined) fields.keywords = keywords.split(",").map(k => k.trim()).filter(Boolean);
  if (creationDate !== undefined) fields.creationDate = creationDate;
  if (modificationDate !== undefined) fields.modificationDate = modificationDate;
  return fields;
}

function reportRouteFailure(error: unknown, wantsJson: boolean): never {
  // `RuntimeApiError.body` carries the route's { error, boundary } shape.
  const body = (error as { body?: RouteError } | undefined)?.body;
  if (body?.boundary) {
    printData(body, wantsJson, [`Refused (${body.boundary}): ${body.error ?? "the source cannot be operated on"}`]);
    throw new CliUsageError(body.error ?? "the operation was refused");
  }
  throw error as Error;
}

async function inspect(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx pdf inspect requires a path", USAGE);
  try {
    const result = await runtimeRequest<PdfInspectResult>(
      "/api/pdf/inspect",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) },
      deps,
    );
    printData(result, wantsJson, [
      result.capabilities.ok
        ? `${result.capabilities.pageCount} page(s)${result.capabilities.signed ? " — digitally signed" : ""}`
        : `Refused (${result.capabilities.boundary}): ${result.capabilities.reason ?? ""}`,
      ...(result.metadata?.title ? [`title: ${result.metadata.title}`] : []),
    ]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function metadata(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const [sub, ...rest] = argv;
  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");

  if (sub === "read") {
    const path = args.shift();
    rejectArgs(args, USAGE);
    if (!path) throw new CliUsageError("ocx pdf metadata read requires a path", USAGE);
    try {
      const result = await runtimeRequest<PdfMetadataFields>(
        `/api/pdf/metadata?path=${encodeURIComponent(path)}`,
        {},
        deps,
      );
      printData(result, wantsJson, Object.entries(result).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`));
    } catch (error) {
      reportRouteFailure(error, wantsJson);
    }
    return;
  }

  if (sub === "write") {
    const path = args.shift();
    const destination = takeOption(args, "--destination");
    const acknowledgeSigned = takeFlag(args, "--acknowledge-signed");
    const fields = metadataFieldsFromArgs(args);
    rejectArgs(args, USAGE);
    if (!path) throw new CliUsageError("ocx pdf metadata write requires a path", USAGE);
    if (!destination) throw new CliUsageError("ocx pdf metadata write requires --destination", USAGE);
    try {
      const result = await runtimeRequest(
        "/api/pdf/metadata",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, destination, fields, acknowledgeSigned }),
        },
        deps,
      );
      printData(result, wantsJson, [`Wrote metadata to ${destination}`]);
    } catch (error) {
      reportRouteFailure(error, wantsJson);
    }
    return;
  }

  throw new CliUsageError(`unknown pdf metadata command "${sub ?? ""}"`, USAGE);
}

async function split(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  const rangesRaw = takeOption(args, "--ranges");
  const destinationsRaw = takeOption(args, "--destinations");
  const acknowledgeSigned = takeFlag(args, "--acknowledge-signed");
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx pdf split requires a path", USAGE);
  if (!rangesRaw) throw new CliUsageError("ocx pdf split requires --ranges", USAGE);
  if (!destinationsRaw) throw new CliUsageError("ocx pdf split requires --destinations", USAGE);
  const ranges = parseRanges(rangesRaw);
  const destinations = parsePaths(destinationsRaw, "--destinations");
  try {
    const result = await runtimeRequest(
      "/api/pdf/split",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ranges, destinations, acknowledgeSigned }),
      },
      deps,
    );
    printData(result, wantsJson, [`Split into ${destinations.length} file(s).`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function merge(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const sourcesRaw = takeOption(args, "--sources");
  const destination = takeOption(args, "--destination");
  const acknowledgeSigned = takeFlag(args, "--acknowledge-signed");
  rejectArgs(args, USAGE);
  if (!sourcesRaw) throw new CliUsageError("ocx pdf merge requires --sources", USAGE);
  if (!destination) throw new CliUsageError("ocx pdf merge requires --destination", USAGE);
  const paths = parsePaths(sourcesRaw, "--sources");
  try {
    const result = await runtimeRequest(
      "/api/pdf/merge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, destination, acknowledgeSigned }),
      },
      deps,
    );
    printData(result, wantsJson, [`Merged ${paths.length} file(s) into ${destination}`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function extract(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  const pagesRaw = takeOption(args, "--pages");
  const destination = takeOption(args, "--destination");
  const acknowledgeSigned = takeFlag(args, "--acknowledge-signed");
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx pdf extract requires a path", USAGE);
  if (!pagesRaw) throw new CliUsageError("ocx pdf extract requires --pages", USAGE);
  if (!destination) throw new CliUsageError("ocx pdf extract requires --destination", USAGE);
  const pages = parseOrderedNumbers(pagesRaw, "--pages");
  try {
    const result = await runtimeRequest(
      "/api/pdf/extract",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, pages, destination, acknowledgeSigned }),
      },
      deps,
    );
    printData(result, wantsJson, [`Extracted ${pages.length} page(s) to ${destination}`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function reorder(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  const orderRaw = takeOption(args, "--order");
  const destination = takeOption(args, "--destination");
  const acknowledgeSigned = takeFlag(args, "--acknowledge-signed");
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx pdf reorder requires a path", USAGE);
  if (!orderRaw) throw new CliUsageError("ocx pdf reorder requires --order", USAGE);
  if (!destination) throw new CliUsageError("ocx pdf reorder requires --destination", USAGE);
  const order = parseOrderedNumbers(orderRaw, "--order");
  try {
    const result = await runtimeRequest(
      "/api/pdf/reorder",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, order, destination, acknowledgeSigned }),
      },
      deps,
    );
    printData(result, wantsJson, [`Reordered ${order.length} page(s) into ${destination}`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

async function rotate(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const path = args.shift();
  const rotationsRaw = takeOption(args, "--rotations");
  const destination = takeOption(args, "--destination");
  const relative = takeFlag(args, "--relative");
  const acknowledgeSigned = takeFlag(args, "--acknowledge-signed");
  rejectArgs(args, USAGE);
  if (!path) throw new CliUsageError("ocx pdf rotate requires a path", USAGE);
  if (!rotationsRaw) throw new CliUsageError("ocx pdf rotate requires --rotations", USAGE);
  if (!destination) throw new CliUsageError("ocx pdf rotate requires --destination", USAGE);
  const rotations = parseRotations(rotationsRaw, relative);
  try {
    const result = await runtimeRequest(
      "/api/pdf/rotate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, rotations, destination, acknowledgeSigned }),
      },
      deps,
    );
    printData(result, wantsJson, [`Rotated ${rotations.length} page(s), wrote ${destination}`]);
  } catch (error) {
    reportRouteFailure(error, wantsJson);
  }
}

export async function handlePdfCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "", ...rest] = argv;
    if (sub === "inspect") await inspect(rest, deps);
    else if (sub === "metadata") await metadata(rest, deps);
    else if (sub === "split") await split(rest, deps);
    else if (sub === "merge") await merge(rest, deps);
    else if (sub === "extract") await extract(rest, deps);
    else if (sub === "reorder") await reorder(rest, deps);
    else if (sub === "rotate") await rotate(rest, deps);
    else throw new CliUsageError(`unknown pdf command "${sub}"`, USAGE);
  });
}

export const PDF_USAGE = USAGE;
