/**
 * `ocx export` — one file containing everything needed to move or back up an
 * opencodex install: config (providers, API keys, combos, settings), the Codex
 * account pool with its OAuth credentials, and the main auth record.
 *
 * This is a credential dump by definition, so it is treated like one:
 * - the warning is unmissable and printed to stderr (so `-` piping stays clean);
 * - writing requires `--yes`;
 * - the file lands with mode 0600;
 * - nothing is ever masked, because a masked backup cannot be restored — the
 *   masking lives in the management API, not here.
 *
 * `ocx export --history` lists the local git snapshots recorded on account
 * add/remove (see src/lib/state-history.ts).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir, getConfigPath, readConfigDiagnostics } from "../config";
import { listStateHistory } from "../lib/state-history";

const USAGE = "Usage: ocx export <path|-> --yes  |  ocx export --history [--json]  |  ocx export data <dataset> [--format <f>] [--out <path>] [--list]";

const WARNING = `
⚠️  THIS EXPORT CONTAINS SECRETS.
   Provider API keys, dashboard access keys, and the OAuth access/refresh
   tokens for every Codex account are included IN PLAINTEXT — anyone holding
   this file can use every account in it.
   Store it encrypted, never commit it, never upload it, and delete it when
   the migration or backup that needed it is done.
`;

function readJsonIfPresent(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A corrupt side file must not sink the whole export; record that instead.
    return { unreadable: true };
  }
}

export async function handleExportCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(
      `${USAGE}\n\n`
      + "Export the complete opencodex state — config, Codex accounts (with OAuth\n"
      + "credentials), and the main auth record — as one JSON document.\n"
      + WARNING
      + "\n  <path|->     Where to write. \"-\" prints to stdout (warning goes to stderr).\n"
      + "  --yes        Required: acknowledges that secrets are included.\n"
      + "  --history    Instead of exporting, list the local snapshots recorded on\n"
      + "               account add/remove (git history inside the config directory).\n",
    );
    return 0;
  }

  const json = args.includes("--json");

  /*
   * `ocx export data` — the headless twin of `/api/export`.
   *
   * The GUI must never be able to do something the CLI cannot; the repo's own
   * parity test enforces that, and it is what caught this route family shipping
   * with no command behind it. Same registry, same serialisers, same redaction —
   * this is a second front door onto one implementation, not a second
   * implementation.
   */
  if (args[0] === "data") {
    const { datasetRows, listDatasets } = await import("../lib/export-datasets");
    const { EXPORT_FORMATS, describeFidelity, filenameFor, serialize } = await import("../lib/export-formats");

    if (args.includes("--list") || args.length === 1) {
      const available = listDatasets();
      if (json) { console.log(JSON.stringify({ datasets: available, formats: EXPORT_FORMATS }, null, 2)); return 0; }
      console.log("Exportable lists:\n");
      for (const dataset of available) console.log(`  ${dataset.id.padEnd(12)} ${dataset.label}`);
      console.log(`\nFormats: ${EXPORT_FORMATS.join(", ")}`);
      console.log("\nExample:  ocx export data requests --format csv --out requests.csv");
      return 0;
    }

    const id = args[1];
    const rows = datasetRows(id);
    if (!rows) {
      console.error(`Unknown list "${id}". Known: ${listDatasets().map(d => d.id).join(", ")}`);
      return 2;
    }

    const formatIndex = args.indexOf("--format");
    const requested = formatIndex === -1 ? "json" : args[formatIndex + 1];
    if (!(EXPORT_FORMATS as readonly string[]).includes(String(requested))) {
      console.error(`Unknown format "${requested}". Known: ${EXPORT_FORMATS.join(", ")}`);
      return 2;
    }
    const format = requested as (typeof EXPORT_FORMATS)[number];

    const input = { name: id, rows };
    // Said before the write, on stderr so it cannot corrupt a piped document.
    const fidelity = describeFidelity(input, format);
    for (const loss of fidelity.losses) console.error(`note: ${loss}`);

    const body = serialize(input, format);
    const outIndex = args.indexOf("--out");
    if (outIndex === -1) { process.stdout.write(body); return 0; }

    const target = args[outIndex + 1] ?? filenameFor(id, format);
    writeFileSync(resolve(target), body, "utf-8");
    console.log(`Wrote ${rows.length} record(s) to ${resolve(target)}`);
    return 0;
  }

  if (args.includes("--history")) {
    const entries = listStateHistory(20);
    if (json) {
      console.log(JSON.stringify({ snapshots: entries }, null, 2));
    } else if (entries.length === 0) {
      console.log("No snapshots recorded yet. They are written automatically when accounts are added or removed.");
    } else {
      console.log(`State snapshots in ${getConfigDir()} (newest first):\n`);
      for (const entry of entries) console.log(`  ${entry}`);
      console.log(`\nInspect one:  git -C "${getConfigDir()}" show <hash>:codex-accounts.json`);
    }
    return 0;
  }

  const path = args.find(a => !a.startsWith("--"));
  if (!path) {
    console.error(`ocx export: destination path is required.\n${USAGE}`);
    return 2;
  }
  if (!args.includes("--yes")) {
    console.error(
      `ocx export: refusing without --yes.${WARNING}`
      + "  Re-run with --yes to acknowledge:  ocx export "
      + (path === "-" ? "- --yes" : `"${path}" --yes`),
    );
    return 2;
  }

  // A backup of defaults is worse than no backup, because it looks like one.
  //
  // `readConfigDiagnostics` always returns a usable object, and on an unreadable
  // file that object is `getDefaultConfig()`. Writing it into a bundle labelled
  // "opencodex-export" and printing "Exported config + accounts + auth" told the
  // user their configuration was safely backed up while the file it came from
  // was unreadable and the bundle held factory defaults. Restoring from it later
  // would then complete the loss.
  //
  // The accounts and auth halves are read separately and are unaffected, so this
  // refuses rather than silently exporting two thirds of a backup.
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.error) {
    console.error(
      `ocx export: ${getConfigPath()} could not be read (${diagnostics.error}).\n`
      + "  Exporting now would write a bundle containing default configuration and call it a backup.\n"
      + "  Inspect it with:  ocx config validate",
    );
    return 2;
  }

  const dir = getConfigDir();
  const bundle = {
    kind: "opencodex-export",
    exportedAt: new Date().toISOString(),
    warning: "CONTAINS PLAINTEXT SECRETS: provider API keys and Codex OAuth access/refresh tokens.",
    config: diagnostics.config,
    codexAccounts: readJsonIfPresent(join(dir, "codex-accounts.json")),
    auth: readJsonIfPresent(join(dir, "auth.json")),
  };
  const content = `${JSON.stringify(bundle, null, 2)}\n`;

  // stderr in both cases, so `ocx export - --yes > backup.json` still warns.
  console.error(WARNING);

  if (path === "-") {
    process.stdout.write(content);
    return 0;
  }

  const target = resolve(path);
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
  console.log(`Exported config + accounts + auth to ${target} (mode 600).`);
  console.log("To restore on another machine: stop the proxy there, copy the bundle's");
  console.log("`.codexAccounts` and `.auth` members over codex-accounts.json / auth.json in");
  console.log("~/.opencodex, then import the config half:");
  console.log(`  node -e "console.log(JSON.stringify(require('${target.replace(/\\/g, "/")}').config, null, 2))" | ocx config import - --yes`);
  return 0;
}
