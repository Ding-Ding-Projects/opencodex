/**
 * `ocx downloads` — the headless counterpart to the dashboard's
 * browser-extension download-capture surface.
 *
 * Same shape as `ocx convert`/`ocx pdf`: every subcommand is a thin client over
 * `/api/downloads/*` (`src/server/management/download-routes.ts`), itself a
 * thin caller of `src/lib/downloads/manager.ts` — so `ocx downloads list` and
 * the dashboard's Downloading page can never disagree about a transfer's
 * state, because there is only one state to disagree about.
 *
 * `capture` exists for parity and for testing the pipeline without the browser
 * extension installed; the extension is the intended caller of `POST
 * /api/downloads/capture` in normal use.
 *
 * Local-machine-gated like PDF/converter: refused the instant the proxy is
 * reachable from the LAN, because every subcommand here ends up reading or
 * writing local files.
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
import type { DownloadRecord } from "../lib/downloads/types";

const USAGE = [
  "Usage: ocx downloads <command> [options]",
  "",
  "Commands:",
  "  capture <url> [--name <file>] [--page <url>]   queue a capture, as the browser extension would",
  "  list                                            every download, newest first",
  "  show <id>                                       one download's full record",
  "  confirm <id> [--dir <path>] [--name <file>]      begin the transfer for a queued capture",
  "  cancel <id>                                      cancel a queued or in-flight download",
  "  pause <id>                                       pause an in-flight download",
  "  resume <id>                                      resume a paused download",
  "  remove <id>                                       drop a finished download from history",
  "",
  "Add --json for machine-readable output.",
].join("\n");

function summaryLine(record: DownloadRecord): string {
  const pct = record.bytesTotal ? `${Math.round((record.bytesReceived / record.bytesTotal) * 100)}%` : `${record.bytesReceived}B`;
  return `${record.id}  ${record.state.padEnd(11)} ${pct.padStart(5)}  ${record.suggestedFilename}`;
}

async function capture(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const suggestedFilename = takeOption(args, "--name");
  const pageUrl = takeOption(args, "--page");
  const url = args.shift();
  rejectArgs(args, USAGE);
  if (!url) throw new CliUsageError("ocx downloads capture requires a url", USAGE);
  const record = await runtimeRequest<DownloadRecord>(
    "/api/downloads/capture",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, suggestedFilename, pageUrl }) },
    deps,
  );
  printData(record, wantsJson, [`Queued: ${summaryLine(record)}`]);
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ records: DownloadRecord[] }>("/api/downloads", {}, deps);
  printData(result, wantsJson, result.records.length === 0
    ? ["No downloads yet."]
    : result.records.map(summaryLine));
}

async function show(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("ocx downloads show requires an id", USAGE);
  const record = await runtimeRequest<DownloadRecord>(`/api/downloads/${encodeURIComponent(id)}`, {}, deps);
  printData(record, wantsJson, [summaryLine(record)]);
}

async function confirm(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const destinationDir = takeOption(args, "--dir");
  const filename = takeOption(args, "--name");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("ocx downloads confirm requires an id", USAGE);
  const record = await runtimeRequest<DownloadRecord>(
    `/api/downloads/${encodeURIComponent(id)}/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationDir, filename }) },
    deps,
  );
  printData(record, wantsJson, [`Started: ${summaryLine(record)}`, record.destinationPath ? `-> ${record.destinationPath}` : ""].filter(Boolean));
}

function simpleAction(action: "cancel" | "pause" | "resume" | "remove") {
  return async (argv: string[], deps: RuntimeApiDeps): Promise<void> => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const id = args.shift();
    rejectArgs(args, USAGE);
    if (!id) throw new CliUsageError(`ocx downloads ${action} requires an id`, USAGE);
    if (action === "remove") {
      await runtimeRequest<{ ok: true }>(`/api/downloads/${encodeURIComponent(id)}`, { method: "DELETE" }, deps);
      printData({ ok: true, id }, wantsJson, [`Removed ${id} from history.`]);
      return;
    }
    const record = await runtimeRequest<DownloadRecord>(`/api/downloads/${encodeURIComponent(id)}/${action}`, { method: "POST" }, deps);
    printData(record, wantsJson, [summaryLine(record)]);
  };
}

export async function handleDownloadsCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "", ...rest] = argv;
    if (sub === "capture") await capture(rest, deps);
    else if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "confirm") await confirm(rest, deps);
    else if (sub === "cancel") await simpleAction("cancel")(rest, deps);
    else if (sub === "pause") await simpleAction("pause")(rest, deps);
    else if (sub === "resume") await simpleAction("resume")(rest, deps);
    else if (sub === "remove") await simpleAction("remove")(rest, deps);
    else throw new CliUsageError(`unknown downloads command "${sub}"`, USAGE);
  });
}

export const DOWNLOADS_USAGE = USAGE;
