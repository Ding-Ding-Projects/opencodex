/**
 * `ocx terminal` — the headless counterpart of the dashboard's Terminal screen.
 *
 * Parity is the reason this exists: anything the GUI can do, the CLI can do, and
 * a terminal screen with no command behind it would be a hole in that rule.
 *
 * It is not trying to be a terminal — you are already in one. What it offers is
 * the *scriptable* half of the screen: list the presets, run one command through
 * a session and print what came back, and clean the session up afterwards. That
 * is the part a script or a remote operator cannot get from their own shell,
 * because the session runs where opencodex runs.
 *
 * Shares `src/lib/terminal-session.ts` with the route, so both drive the same
 * fixed preset catalog and cannot drift about what "Codex CLI" starts.
 */

import { PRESETS, createSession, killSession, readSession, writeSession } from "../lib/terminal-session";
import { printSubcommandUsage } from "./help";

/** How long `run` waits for output before printing what it has. */
const DEFAULT_WAIT_MS = 4000;

function printPresets(json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ presets: PRESETS }, null, 2));
    return;
  }
  const width = Math.max(...PRESETS.map(preset => preset.id.length));
  for (const preset of PRESETS) {
    const note = preset.fullScreen ? "  (full-screen TUI will not render — pipes only)" : "";
    console.log(`${preset.id.padEnd(width)}  ${preset.label}${note}`);
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function handleTerminalCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const sub = positional[0];

  if (args.includes("--help") || args.includes("-h")) {
    printSubcommandUsage("terminal");
    return 0;
  }

  // Listing is the safe default: a bare `ocx terminal` must not spawn anything.
  if (!sub || sub === "list") {
    printPresets(json);
    return 0;
  }

  if (sub !== "run") {
    console.error(`Unknown subcommand '${sub}'. Try 'ocx terminal list' or 'ocx terminal run <preset> --command "..."'.`);
    return 1;
  }

  const preset = positional[1];
  if (!preset) {
    console.error("A preset is required: ocx terminal run <preset> --command \"...\"");
    return 1;
  }
  const command = flagValue(args, "--command");
  const waitRaw = Number(flagValue(args, "--wait") ?? DEFAULT_WAIT_MS);
  const wait = Number.isFinite(waitRaw) && waitRaw > 0 ? Math.min(waitRaw, 120_000) : DEFAULT_WAIT_MS;

  const created = createSession(preset);
  if (!created.ok) {
    if (json) console.log(JSON.stringify(created, null, 2));
    else console.error(`Could not start '${preset}': ${created.error}`);
    return 1;
  }

  const id = created.session.id;
  try {
    if (command) {
      const wrote = writeSession(id, `${command}\n`);
      if (!wrote.ok) {
        if (json) console.log(JSON.stringify(wrote, null, 2));
        else console.error(`Could not send the command: ${wrote.error}`);
        return 1;
      }
    }

    await Bun.sleep(wait);

    const read = readSession(id, 0);
    const chunks = read?.chunks ?? [];
    if (json) {
      console.log(JSON.stringify({ ok: true, session: read?.session, chunks }, null, 2));
    } else {
      for (const chunk of chunks) {
        const text = chunk.text.replace(/\r?\n$/, "");
        if (!text) continue;
        (chunk.stream === "err" ? console.error : console.log)(text);
      }
    }
    return 0;
  } finally {
    // A CLI invocation owns its session for exactly one command; leaving it
    // running would strand a shell in the proxy after the process returns.
    killSession(id);
  }
}
