import { existsSync } from "node:fs";
import { CliUsageError, rejectArgs, takeFlag, takeOption } from "./runtime-api";
import { listProjectProfiles, showProjectProfile } from "../global-memory/profiles";
import { GlobalMemoryRepositoryError } from "../global-memory/repository";
import { runGlobalMemorySync } from "../global-memory/sync-runner";
import type { GlobalMemoryAction, GlobalMemoryRequest, GlobalMemoryTarget } from "../global-memory/types";

const USAGE = `Usage:
  ocx memory-sync <status|install|uninstall> [--repo PATH] [--target all|claude,codex,opencode] [--home PATH] [--dry-run] [--yes]
  ocx memory-sync profile list [--repo PATH] [--json]
  ocx memory-sync profile show <slug> [--repo PATH] [--json]

Global memory is synchronized only from the canonical agent-global-memory repository.
Profiles are read-only project-scoped reference material; they are never injected into agent instructions.`;

const TARGETS = new Set<GlobalMemoryTarget>(["all", "claude", "codex", "opencode"]);

function parseTargets(values: string[]): GlobalMemoryTarget[] | undefined {
  if (values.length === 0) return undefined;
  const result: GlobalMemoryTarget[] = [];
  for (const value of values.flatMap(item => item.split(","))) {
    const target = value.trim().toLowerCase() as GlobalMemoryTarget;
    if (!TARGETS.has(target)) throw new CliUsageError(`--target must contain only all, claude, codex, or opencode`, USAGE);
    if (!result.includes(target)) result.push(target);
  }
  return result;
}

function takeRepeatedOption(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (;;) {
    const index = args.indexOf(flag);
    if (index === -1) break;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value`, USAGE);
    values.push(value);
    args.splice(index, 2);
  }
  return values;
}

function outputResult(value: unknown, wantsJson: boolean): void {
  if (wantsJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if ("profiles" in (value as Record<string, unknown>)) {
    const profiles = (value as { profiles: Array<{ slug: string; path: string }> }).profiles;
    console.log(`Project profiles (read-only; not automatically applied): ${profiles.length}`);
    for (const profile of profiles) console.log(`  ${profile.slug} - ${profile.path}`);
    return;
  }
  if ("profile" in (value as Record<string, unknown>)) {
    const result = value as { profile: { slug: string; path: string; content: string } };
    console.log(`Project profile ${result.profile.slug} (${result.profile.path})`);
    console.log("Read-only project-scoped reference material; not automatically applied.");
    console.log(result.profile.content);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseRepositoryOptions(args: string[]): { repositoryPath?: string; homeDirectory?: string; wantsJson: boolean } {
  const wantsJson = takeFlag(args, "--json");
  const repositoryPath = takeOption(args, "--repo");
  const homeDirectory = takeOption(args, "--home");
  return { repositoryPath, homeDirectory, wantsJson };
}

function validateHome(homeDirectory: string | undefined): void {
  if (homeDirectory && !existsSync(homeDirectory)) {
    // The canonical synchronizer can create target directories, but rejecting a missing
    // home here would make disposable acceptance homes impossible. This function is
    // intentionally a no-op placeholder for future syntax-only checks.
  }
}

export async function handleGlobalMemoryCommand(argv: string[]): Promise<number> {
  try {
    const args = [...argv];
    const subcommand = args.shift();
    if (!subcommand) throw new CliUsageError(USAGE, USAGE);

    if (subcommand === "profile") {
      const profileAction = args.shift();
      if (profileAction === "list") {
        const options = parseRepositoryOptions(args);
        rejectArgs(args, USAGE);
        const result = await listProjectProfiles({ explicitPath: options.repositoryPath });
        outputResult(result, options.wantsJson);
        return 0;
      }
      if (profileAction === "show") {
        const slug = args.shift();
        if (!slug) throw new CliUsageError("profile show requires a slug", USAGE);
        const options = parseRepositoryOptions(args);
        rejectArgs(args, USAGE);
        const result = await showProjectProfile(slug, { explicitPath: options.repositoryPath });
        outputResult(result, options.wantsJson);
        return 0;
      }
      throw new CliUsageError("memory-sync profile requires list or show", USAGE);
    }

    if (subcommand !== "status" && subcommand !== "install" && subcommand !== "uninstall") {
      throw new CliUsageError(`unknown memory-sync command '${subcommand}'`, USAGE);
    }
    const action = subcommand as GlobalMemoryAction;
    const targetValues = takeRepeatedOption(args, "--target");
    const options = parseRepositoryOptions(args);
    const yes = takeFlag(args, "--yes");
    const dryRun = takeFlag(args, "--dry-run");
    rejectArgs(args, USAGE);
    validateHome(options.homeDirectory);
    const request: GlobalMemoryRequest = {
      action,
      repositoryPath: options.repositoryPath,
      targets: parseTargets(targetValues),
      homeDirectory: options.homeDirectory,
      yes,
      dryRun,
    };
    const result = await runGlobalMemorySync(request);
    if (options.wantsJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Canonical repository: ${result.repositoryPath}`);
      console.log(`Origin: ${result.origin}`);
      if (result.stdout.trim()) process.stdout.write(result.stdout);
      if (result.stderr.trim()) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof GlobalMemoryRepositoryError) {
      console.error(`Error: ${error.message}`);
      if (error instanceof CliUsageError) console.error(error.usage ?? USAGE);
      return 2;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export const GLOBAL_MEMORY_USAGE = USAGE;
