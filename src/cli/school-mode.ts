/**
 * `ocx school-mode` — the headless counterpart to the School Mode control.
 *
 * ## Why this exists at all
 *
 * `tests/cli-headless-parity.test.ts` pairs every `/api/*` prefix the
 * dashboard reaches with a real CLI resource, because the contract this
 * project works to is that everything the dashboard can do, the CLI can do
 * without one. `/api/school-mode` gained five endpoints when School Mode
 * landed, so it owes a command — and a coverage row with nothing behind it
 * would defeat that guard rather than satisfy it.
 *
 * ## What is genuinely headless here, unlike the neighbouring commands
 *
 * `ocx narrator` and `ocx schedule` both have to say "not readable from
 * here", because narrator preferences and scheduled rules live in the
 * dashboard's own browser profile. **School Mode does not.** Its whole point
 * is a record shared across every conforming app rather than owned by one, so
 * it lives on disk in a platform-appropriate shared application-data
 * directory (`src/school-mode/paths.ts`) and is read and written by the
 * server (`src/school-mode/store.ts`). That makes every one of these
 * subcommands a real answer rather than a signpost.
 *
 * ## The credential, and what this command will not do with it
 *
 * Turning the mode off requires the unlock credential, and verification
 * happens server-side against a scrypt hash — the plaintext is never stored
 * and is never compared here. `disable` and `credential` therefore accept a
 * secret only on **standard input**, never as an argument: an argument lands
 * in the process list, in a shell history file, and in any log that records
 * the command line. Nothing here ever prints a secret back, and `status`
 * reports whether a credential exists, never anything about its value,
 * length or composition.
 *
 * The same honesty the GUI owes applies to the copy: this is a
 * user-experience lock, not a security boundary. Deleting the shared record
 * resets it, `status` says so, and it names the real directory rather than
 * gesturing at "app data".
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

const USAGE = `Usage:
  ocx school-mode status [--json]
  ocx school-mode enable [--json]
  ocx school-mode disable [--json]          reads the unlock secret from stdin
  ocx school-mode credential [--json]       reads new (then current) secret from stdin
  ocx school-mode rename <name> [--json]
  ocx school-mode rename --clear [--json]

The unlock secret is read from standard input, never from an argument: an
argument reaches the process list, the shell history and any log that records
a command line. Nothing here ever prints a secret back.

School Mode is a user-experience lock, not a security boundary. Deleting the
shared record resets it; "status" names the exact directory.`;

interface SchoolModeStatus {
  enabled: boolean;
  /** The chosen display name, or null when the shipped name is in use. */
  name: string | null;
  /** Whether an unlock credential has been set. Never its value. */
  hasCredential: boolean;
  /** Whether the shared record could be read at all this call. */
  readable: boolean;
  /** The directory holding the shared record — the reset-by-deletion path. */
  recordDir: string;
}

/**
 * Read one secret from standard input.
 *
 * Trailing newlines are stripped because a shell heredoc and a piped `echo`
 * both add one, and a credential that silently differs by an invisible
 * character fails verification with nothing to read. Interior whitespace is
 * kept: a passphrase may legitimately contain spaces.
 */
async function readSecretFromStdin(prompt: string): Promise<string> {
  process.stderr.write(`${prompt}\n`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!text) throw new CliUsageError("no secret was supplied on standard input", USAGE);
  return text;
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const json = takeFlag(argv, "--json");
  rejectArgs(argv, USAGE);
  const result = await runtimeRequest<SchoolModeStatus>("/api/school-mode", { method: "GET" }, deps);
  printData(result, json, [
    `Mode:            ${result.enabled ? "on" : "off"}`,
    `Name in use:     ${result.name ?? "School mode (shipped name)"}`,
    `Unlock set:      ${result.hasCredential ? "yes" : "no — the mode cannot be turned on until one exists"}`,
    `Shared record:   ${result.readable ? "readable" : "NOT readable — the last known state is being served"}`,
    `Record folder:   ${result.recordDir}`,
    "",
    "This is a user-experience lock, not a security boundary. Deleting the",
    "folder above resets it, including the unlock credential.",
  ]);
}

async function enable(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const json = takeFlag(argv, "--json");
  rejectArgs(argv, USAGE);
  const result = await runtimeRequest<SchoolModeStatus>(
    "/api/school-mode/enable",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    deps,
  );
  printData(result, json, ["School Mode is on. Every app sharing the record picks this up without a restart."]);
}

async function disable(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const json = takeFlag(argv, "--json");
  rejectArgs(argv, USAGE);
  const secret = await readSecretFromStdin("Unlock secret (read from stdin, not echoed):");
  const result = await runtimeRequest<SchoolModeStatus>(
    "/api/school-mode/disable",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret }) },
    deps,
  );
  printData(result, json, ["School Mode is off. The choices it was hiding are back as they were."]);
}

/**
 * Set or change the unlock credential.
 *
 * The new secret comes first and the current one second, because changing an
 * existing credential requires proving you hold it — the server enforces
 * that, and this only supplies what it asks for.
 */
async function credential(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const json = takeFlag(argv, "--json");
  rejectArgs(argv, USAGE);
  const newSecret = await readSecretFromStdin("New unlock secret (read from stdin, not echoed):");
  const currentSecret = await readSecretFromStdin(
    "Current unlock secret, or an empty line if none is set yet:",
  ).catch(() => "");
  const result = await runtimeRequest<SchoolModeStatus>(
    "/api/school-mode/credential",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(currentSecret ? { newSecret, currentSecret } : { newSecret }) },
    deps,
  );
  printData(result, json, ["Unlock credential set."]);
}

async function rename(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const json = takeFlag(argv, "--json");
  const clear = takeFlag(argv, "--clear");
  const explicit = takeOption(argv, "--name");
  const positional = argv.shift();
  rejectArgs(argv, USAGE);

  const chosen = explicit ?? positional;
  if (!clear && !chosen) throw new CliUsageError("a name is required, or --clear to restore the shipped one", USAGE);
  if (clear && chosen) throw new CliUsageError("--clear cannot be combined with a name", USAGE);

  const result = await runtimeRequest<SchoolModeStatus>(
    "/api/school-mode/rename",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clear ? null : chosen }) },
    deps,
  );
  printData(result, json, [clear ? "The shipped name is in use again." : `Every surface now calls it "${chosen}".`]);
}

/* ---------------------------------------------------------------- entry -- */

export async function handleSchoolModeCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "enable") await enable(rest, deps);
    else if (sub === "disable") await disable(rest, deps);
    else if (sub === "credential") await credential(rest, deps);
    else if (sub === "rename") await rename(rest, deps);
    else throw new CliUsageError(`unknown school-mode command "${sub}"`, USAGE);
  });
}

export const SCHOOL_MODE_USAGE = USAGE;
