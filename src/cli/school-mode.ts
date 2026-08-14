/**
 * `ocx school-mode` — the headless half of the universal School Mode toggle.
 *
 * Reaches the exact same `/api/school-mode*` management routes the GUI's
 * card does (`src/server/management/school-mode-routes.ts`), so the two
 * surfaces can never drift about what enabling, disabling, changing the
 * credential, or renaming actually does — this is the `cli-headless-parity`
 * contract every other management capability in this CLI already follows.
 *
 * The PIN/password is a credential, so every subcommand that needs one reads
 * it from stdin rather than accepting it as an argument — `ocx account code`
 * and `ocx account login --code -` set the precedent this mirrors.
 */

import {
  CliUsageError,
  printData,
  readSecretLine,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  type CliStdin,
  type RuntimeApiDeps,
} from "./runtime-api";

/**
 * Read exactly `labels.length` secret lines from stdin in one continuous
 * listen session, in order.
 *
 * `readSecretLine` (runtime-api.ts) is built for exactly one read per
 * command: it resolves on the first newline and discards whatever arrived
 * after it in the same chunk. That is wrong for "set-credential", which
 * needs the current PIN and the new one in sequence — a pipe commonly
 * delivers `old\nnew\n` as a single chunk (this is true even for the small
 * in-memory streams the test suite constructs, not only real OS pipes), so a
 * second `readSecretLine` call attached after the first would see nothing
 * and report the new secret as empty. This keeps one listener attached
 * across every line instead, carrying the unconsumed remainder of the
 * buffer from one line to the next rather than discarding it — otherwise
 * the same shape `readSecretLine` already uses (resolve on newline, resolve
 * remaining buffer on end, reject on error or timeout).
 */
async function readSecretLines(deps: RuntimeApiDeps, labels: string[]): Promise<string[]> {
  const input: CliStdin = deps.stdinImpl ?? process.stdin;
  const timeoutMs = deps.stdinTimeoutMs ?? 120_000;
  if (input.readableEnded === true) throw new CliUsageError(`${labels[0]} input was empty`);
  return await new Promise<string[]>((resolve, reject) => {
    let buffer = "";
    const results: string[] = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const drain = () => {
      while (results.length < labels.length) {
        const newline = buffer.search(/[\r\n]/);
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        let rest = buffer.slice(newline + 1);
        if (buffer[newline] === "\r" && rest[0] === "\n") rest = rest.slice(1);
        buffer = rest;
        if (!line) {
          finish(() => reject(new CliUsageError(`${labels[results.length]} input was empty`)));
          return;
        }
        results.push(line);
      }
      finish(() => resolve(results));
    };
    const onData = (chunk: unknown) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      drain();
    };
    const onEnd = () => {
      if (results.length < labels.length && buffer.trim()) {
        results.push(buffer.trim());
        buffer = "";
      }
      if (results.length < labels.length) {
        finish(() => reject(new CliUsageError(`${labels[results.length]} input was empty`)));
      } else {
        finish(() => resolve(results));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(
      () => finish(() => reject(new CliUsageError(`timed out waiting for ${labels[results.length] ?? "input"} on stdin`))),
      timeoutMs,
    );
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

const USAGE = `Usage:
  ocx school-mode status [--json]
  ocx school-mode enable [--json]
  ocx school-mode disable [--json]              (reads the PIN/password from stdin)
  ocx school-mode set-credential [--json]       (reads the new PIN/password from stdin;
                                                  reads the current one first too, if one is already set)
  ocx school-mode rename <name> [--json]
  ocx school-mode rename --clear [--json]        (back to the shipped name)

School Mode is the universal, cross-app toggle that forces English
presentation and makes Cantonese, bilingual mode, both funny-level sliders,
personal vocabulary and the dim sum surprise behave as if they are not
installed — everywhere the shared switch is read, including this CLI's own
output. It is a for-fun toggle, not a security boundary: "status" prints the
shared file's location, and deleting it resets a forgotten PIN.

The PIN/password is a short-lived credential. Pipe it in rather than passing
it as an argument, where it lands in shell history and is visible to anyone
who can run ps:
  printf '%s\\n' "$PIN" | ocx school-mode disable`;

function statusLines(result: Record<string, unknown>): string[] {
  const name = typeof result.customName === "string" && result.customName ? result.customName : "School Mode";
  const lines = [
    `${name}: ${result.enabled ? "on" : "off"}`,
    `unlock credential: ${result.hasCredential ? "set" : "not set"}`,
  ];
  if (result.recordReadable === false) {
    lines.push(`warning: the shared file could not be read just now (${String(result.readError ?? "unknown error")}); showing the last known state`);
  }
  if (result.recordWatchable === false) {
    lines.push(`warning: the shared file could not be watched for changes made elsewhere (${String(result.watchError ?? "unknown error")}); it is still re-read on every "status"`);
  }
  if (typeof result.recordDir === "string" && result.recordDir) {
    lines.push(`reset — including a forgotten PIN — by deleting: ${result.recordDir}`);
  }
  return lines;
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/school-mode", {}, deps);
  printData(result, wantsJson, statusLines(result));
}

async function enable(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/school-mode/enable", { method: "POST" }, deps);
  printData(result, wantsJson, statusLines(result));
}

async function disable(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const input = deps.stdinImpl ?? process.stdin;
  if (input.isTTY) console.error("Paste the PIN or password, then press Enter:");
  const secret = await readSecretLine(deps, "PIN or password");
  const result = await runtimeRequest<Record<string, unknown>>("/api/school-mode/disable", {
    method: "POST",
    body: JSON.stringify({ secret }),
  }, deps);
  printData(result, wantsJson, statusLines(result));
}

async function setCredential(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  // Whether a current credential must be read first depends on server state,
  // not on a flag the caller has to remember to pass.
  const current = await runtimeRequest<Record<string, unknown>>("/api/school-mode", {}, deps);
  const needsCurrent = current.hasCredential === true;
  const input: CliStdin = deps.stdinImpl ?? process.stdin;
  if (input.isTTY) {
    if (needsCurrent) console.error("Paste the current PIN or password, then press Enter:");
    console.error("Paste the new PIN or password, then press Enter:");
  }
  // Both lines are read from one continuous stdin session — see
  // `readSecretLines`'s own doc comment for why two separate
  // `readSecretLine` calls would silently lose the second line.
  const labels = needsCurrent ? ["current PIN or password", "new PIN or password"] : ["new PIN or password"];
  const lines = await readSecretLines(deps, labels);
  const currentSecret = needsCurrent ? lines[0] : undefined;
  const newSecret = (needsCurrent ? lines[1] : lines[0])!;
  const result = await runtimeRequest<Record<string, unknown>>("/api/school-mode/credential", {
    method: "POST",
    body: JSON.stringify({ newSecret, currentSecret }),
  }, deps);
  printData(result, wantsJson, [`unlock credential ${needsCurrent ? "changed" : "set"}.`]);
}

async function rename(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const clear = takeFlag(args, "--clear");
  const name = clear ? null : args.shift();
  if (!clear && !name) throw new CliUsageError("name is required (or pass --clear to use the shipped name)", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/school-mode/rename", {
    method: "POST",
    body: JSON.stringify({ name }),
  }, deps);
  printData(result, wantsJson, [
    result.hasCustomName ? `renamed to "${String(result.customName)}".` : "back to the shipped name, School Mode.",
  ]);
}

export async function handleSchoolModeCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "enable" || sub === "on") await enable(rest, deps);
    else if (sub === "disable" || sub === "off") await disable(rest, deps);
    else if (sub === "set-credential" || sub === "credential") await setCredential(rest, deps);
    else if (sub === "rename") await rename(rest, deps);
    else throw new CliUsageError(`unknown school-mode command ${sub}`, USAGE);
  });
}

export const SCHOOL_MODE_USAGE = USAGE;
