/**
 * `ocx launch` — open an agent CLI or its desktop app.
 *
 * The headless counterpart of the dashboard's Launch card, and it exists for that
 * reason: this project's parity rule is that anything the GUI can do, the CLI can
 * do, so a launch button with no command behind it would be a hole in it.
 *
 * Shares `src/lib/app-launcher.ts` with the route, so both resolve the same fixed
 * catalog against the same install locations and cannot drift about what "Claude
 * Code" means or where it lives.
 *
 * No console window is created for anything (see the launcher module): a CLI target
 * goes to a real terminal application, never to a legacy console popup, and a
 * machine with no terminal app is told so rather than getting one anyway.
 */

import { launchTarget, listLaunchTargets } from "../lib/app-launcher";
import { printSubcommandUsage } from "./help";

function printTargets(json: boolean): void {
  const targets = listLaunchTargets();
  if (json) {
    console.log(JSON.stringify({ targets }, null, 2));
    return;
  }
  const width = Math.max(...targets.map(target => target.id.length));
  for (const target of targets) {
    const state = target.available ? "installed" : "not installed";
    console.log(`${target.id.padEnd(width)}  ${target.kind.padEnd(7)}  ${state.padEnd(13)}  ${target.label}`);
  }
  const missing = targets.filter(target => !target.available);
  if (missing.length > 0) {
    console.log("");
    for (const target of missing) console.log(`${target.label}: ${target.installUrl}`);
  }
}

export async function handleLaunchCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter(arg => !arg.startsWith("--"));
  const sub = positional[0];

  if (args.includes("--help") || args.includes("-h")) {
    printSubcommandUsage("launch");
    return 0;
  }

  // No target named, or an explicit list: report what is installed. Listing is the
  // safe default — a bare `ocx launch` must not start something the user did not name.
  if (!sub || sub === "list") {
    printTargets(json);
    return 0;
  }

  const outcome = launchTarget(sub);
  if (!outcome.ok) {
    if (json) console.log(JSON.stringify(outcome, null, 2));
    else console.error(`Could not launch '${sub}': ${outcome.error}`);
    return 1;
  }
  if (json) console.log(JSON.stringify(outcome, null, 2));
  else console.log(`Launched ${outcome.label}.`);
  return 0;
}
