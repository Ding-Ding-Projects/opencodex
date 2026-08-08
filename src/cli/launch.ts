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
  const subcommand = positional[0];

  if (args.includes("--help") || args.includes("-h")) {
    printSubcommandUsage("launch");
    return 0;
  }
  const unknownOption = args.find(arg => arg.startsWith("--") && arg !== "--json");
  if (unknownOption) {
    console.error(`ocx launch: unsupported option '${unknownOption}'. Try 'ocx launch --help'.`);
    return 2;
  }
  if (positional.length > 1) {
    console.error("ocx launch: expected one fixed catalog target id.");
    return 2;
  }
  if (!subcommand || subcommand === "list") {
    printTargets(json);
    return 0;
  }

  const outcome = launchTarget(subcommand);
  if (!outcome.ok) {
    if (json) console.log(JSON.stringify(outcome, null, 2));
    else console.error(`Could not launch '${subcommand}': ${outcome.error}`);
    return 1;
  }
  if (json) console.log(JSON.stringify(outcome, null, 2));
  else console.log(`Launched ${outcome.label}.`);
  return 0;
}
