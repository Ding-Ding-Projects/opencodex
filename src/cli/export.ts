import { closeSync, existsSync, fchmodSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir, getConfigPath, readConfigDiagnostics } from "../config";
import { listStateHistory } from "../lib/state-history";
import { hardenSecretPath } from "../lib/windows-secret-acl";

const USAGE = "Usage: ocx export <path> --yes | ocx export --history [--json] | ocx export data <dataset> [--format <format>] [--out <path>] [--list]";
const WARNING = [
  "THIS EXPORT CONTAINS PLAINTEXT SECRETS.",
  "Provider and data-plane API keys, MCP credentials, and OAuth access/refresh tokens are included.",
  "Store it encrypted; never commit or upload it; delete it when no longer needed.",
].join(" ");

type SideFileRead = { ok: true; value: unknown } | { ok: false };

function readJsonIfPresent(path: string): SideFileRead {
  if (!existsSync(path)) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false };
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function missingFlagValue(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  return index !== -1 && (!args[index + 1] || args[index + 1].startsWith("--"));
}

function writePrivateBackup(path: string, content: string): string | null {
  let fd: number | null = null;
  let created = false;
  try {
    // Exclusive creation avoids following a pre-planted symlink or silently replacing
    // an older secret backup. The caller chooses a new path for every export.
    fd = openSync(path, "wx", 0o600);
    created = true;
    fchmodSync(fd, 0o600);
    // On Windows, POSIX mode bits do not remove inherited broad ACL entries.
    // Harden the still-empty exclusive file before the first secret byte is written,
    // so an ACL failure can only leave (and immediately remove) an empty file.
    const hardened = hardenSecretPath(path, { required: true });
    if (!hardened.ok) throw new Error("Windows ACL hardening did not complete");
    writeFileSync(fd, content, { encoding: "utf8" });
    closeSync(fd);
    fd = null;
    return null;
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    if (created) try { unlinkSync(path); } catch { /* already removed */ }
    return error instanceof Error ? error.message : String(error);
  }
}

async function exportDataset(args: string[], json: boolean): Promise<number> {
  const { datasetRows, listDatasets } = await import("../lib/export-datasets");
  const { EXPORT_FORMATS, describeFidelity, serialize } = await import("../lib/export-formats");
  if (args.includes("--list") || args.length === 1) {
    const datasets = listDatasets();
    if (json) console.log(JSON.stringify({ datasets, formats: EXPORT_FORMATS }, null, 2));
    else {
      console.log("Exportable datasets:\n");
      for (const dataset of datasets) console.log(`  ${dataset.id.padEnd(12)} ${dataset.label}`);
      console.log(`\nFormats: ${EXPORT_FORMATS.join(", ")}`);
    }
    return 0;
  }

  const id = args[1];
  const rows = datasetRows(id);
  if (!rows) {
    console.error(`Unknown dataset "${id}". Known: ${listDatasets().map(dataset => dataset.id).join(", ")}`);
    return 2;
  }
  const formatValue = flagValue(args, "--format");
  if (missingFlagValue(args, "--format")) {
    console.error("--format requires a value.");
    return 2;
  }
  const requested = formatValue ?? "json";
  if (!(EXPORT_FORMATS as readonly string[]).includes(requested)) {
    console.error(`Unknown format "${requested}". Known: ${EXPORT_FORMATS.join(", ")}`);
    return 2;
  }
  const format = requested as (typeof EXPORT_FORMATS)[number];
  const input = { name: id, rows };
  for (const loss of describeFidelity(input, format).losses) console.error(`note: ${loss}`);
  const body = serialize(input, format);
  const out = flagValue(args, "--out");
  if (missingFlagValue(args, "--out")) {
    console.error("--out requires a destination path.");
    return 2;
  }
  if (!out) {
    process.stdout.write(body);
    return 0;
  }
  const target = resolve(out);
  writeFileSync(target, body, { encoding: "utf8", mode: 0o600 });
  console.log(`Wrote ${rows.length} record(s) to ${target}`);
  return 0;
}

export async function handleExportCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`${USAGE}\n\nExport dashboard data, or create a full state backup.\n\n${WARNING}`);
    return 0;
  }

  const json = args.includes("--json");
  if (args[0] === "data") return exportDataset(args, json);
  if (args.includes("--history")) {
    const snapshots = listStateHistory(20);
    if (json) console.log(JSON.stringify({ snapshots }, null, 2));
    else if (snapshots.length === 0) console.log("No account-change snapshots have been recorded yet.");
    else {
      console.log(`State snapshots in ${getConfigDir()} (newest first):\n`);
      for (const snapshot of snapshots) console.log(`  ${snapshot}`);
    }
    return 0;
  }

  const unsupported = args.find(arg => arg.startsWith("--") && arg !== "--yes");
  if (unsupported) {
    console.error(`ocx export: unsupported option "${unsupported}".\n${USAGE}`);
    return 2;
  }
  const destinations = args.filter(arg => !arg.startsWith("--"));
  const destination = destinations[0];
  if (!destination || destinations.length !== 1) {
    console.error(`ocx export: destination path is required.\n${USAGE}`);
    return 2;
  }
  if (destination === "-") {
    console.error(
      "ocx export: full-state backups cannot be written to stdout because they contain plaintext secrets.\n"
      + "Choose a private destination file; redacted dataset exports may still be piped with 'ocx export data'.",
    );
    return 2;
  }
  if (!args.includes("--yes")) {
    console.error(`ocx export: refusing without --yes. ${WARNING}`);
    return 2;
  }

  const diagnostics = readConfigDiagnostics();
  if (diagnostics.error) {
    console.error(
      `ocx export: ${getConfigPath()} could not be read (${diagnostics.error}).\n`
      + "Refusing to label factory defaults as a valid backup; inspect it with 'ocx config validate'.",
    );
    return 2;
  }

  const dir = getConfigDir();
  const codexAccounts = readJsonIfPresent(join(dir, "codex-accounts.json"));
  const auth = readJsonIfPresent(join(dir, "auth.json"));
  if (!codexAccounts.ok || !auth.ok) {
    console.error(
      "ocx export: a credential state file is unreadable or invalid JSON. Refusing to write an incomplete backup.",
    );
    return 2;
  }
  const content = `${JSON.stringify({
    kind: "opencodex-export",
    exportedAt: new Date().toISOString(),
    warning: WARNING,
    config: diagnostics.config,
    codexAccounts: codexAccounts.value,
    auth: auth.value,
  }, null, 2)}\n`;
  console.error(`WARNING: ${WARNING}`);
  const target = resolve(destination);
  const writeError = writePrivateBackup(target, content);
  if (writeError) {
    console.error(`ocx export: could not create a new private backup file (${writeError}).`);
    return 1;
  }
  console.log(`Exported config, accounts, and auth to ${target}.`);
  return 0;
}
