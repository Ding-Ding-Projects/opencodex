import { PRESETS, createSession, killSession, readSession, writeSession } from "../lib/terminal-session";
import { printSubcommandUsage } from "./help";

const DEFAULT_WAIT_MS = 4000;
const VALUE_FLAGS = new Set(["--command", "--wait"]);

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
  const positional = args.filter((arg, index) =>
    !arg.startsWith("--") && !VALUE_FLAGS.has(args[index - 1] ?? ""));
  const subcommand = positional[0];

  if (args.includes("--help") || args.includes("-h")) {
    printSubcommandUsage("terminal");
    return 0;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        console.error(`ocx terminal: ${arg} requires a value.`);
        return 2;
      }
      index += 1;
      continue;
    }
    if (arg === "--json" || !arg.startsWith("--")) continue;
    console.error(`ocx terminal: unsupported option '${arg}'. Try 'ocx terminal --help'.`);
    return 2;
  }
  if (!subcommand || subcommand === "list") {
    printPresets(json);
    return 0;
  }
  if (subcommand !== "run") {
    console.error(`Unknown subcommand '${subcommand}'. Try 'ocx terminal list' or 'ocx terminal run <preset> --command "..."'.`);
    return 1;
  }

  const preset = positional[1];
  if (!preset) {
    console.error("A preset is required: ocx terminal run <preset> --command \"...\"");
    return 1;
  }
  const command = flagValue(args, "--command");
  const waitValue = flagValue(args, "--wait");
  if (waitValue !== undefined && (!/^\d+$/.test(waitValue) || Number(waitValue) < 1 || Number(waitValue) > 120_000)) {
    console.error("ocx terminal: --wait must be an integer from 1 through 120000 milliseconds.");
    return 2;
  }
  const wait = waitValue === undefined ? DEFAULT_WAIT_MS : Number(waitValue);
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
    if (json) console.log(JSON.stringify({ ok: true, session: read?.session, chunks }, null, 2));
    else {
      for (const chunk of chunks) {
        const text = chunk.text.replace(/\r?\n$/, "");
        if (!text) continue;
        (chunk.stream === "err" ? console.error : console.log)(text);
      }
    }
    return 0;
  } finally {
    killSession(id);
  }
}
