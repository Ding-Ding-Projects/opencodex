/**
 * `ocx convert` — the headless counterpart to the dashboard's file converter
 * surface.
 *
 * Same shape as `ocx pdf` (`src/cli/pdf.ts`): every subcommand is a thin
 * client over `/api/converter/*` (`src/server/management/converter-routes.ts`),
 * which is itself a thin caller of `src/lib/converter/{registry,service}.ts`.
 * That is the same headless-parity discipline the PDF family already proved —
 * the CLI and the GUI hit the exact same catalogue and the exact same
 * bounded-byte detection, so "does the CLI agree with the dashboard" is a
 * fact about one code path rather than a claim about two kept in sync by hand.
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
  type RuntimeApiDeps,
} from "./runtime-api";
import type { ConverterCatalog, DetectedSource } from "../lib/converter/types";

const USAGE = [
  "Usage: ocx convert <command> [options]",
  "",
  "Commands:",
  "  catalog                    list every known format, category, and whether it is bundled and enabled",
  "  detect <path>               byte-level detection of a local file — never trusts its extension",
  "",
  "Add --json for machine-readable output.",
].join("\n");

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

export async function handleConvertCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "", ...rest] = argv;
    if (sub === "catalog") await catalog(rest, deps);
    else if (sub === "detect") await detect(rest, deps);
    else throw new CliUsageError(`unknown convert command "${sub}"`, USAGE);
  });
}

export const CONVERT_USAGE = USAGE;
