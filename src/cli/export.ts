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
import { getConfigDir, readConfigDiagnostics } from "../config";
import { listStateHistory } from "../lib/state-history";

const USAGE = "Usage: ocx export <path|-> --yes  |  ocx export --history [--json]";

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

  const dir = getConfigDir();
  const bundle = {
    kind: "opencodex-export",
    exportedAt: new Date().toISOString(),
    warning: "CONTAINS PLAINTEXT SECRETS: provider API keys and Codex OAuth access/refresh tokens.",
    config: readConfigDiagnostics().config,
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
