import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { resolveGlobalMemoryRepository, type RepositoryResolutionOptions } from "./repository";
import type {
  GlobalMemoryItemState,
  GlobalMemoryRequest,
  GlobalMemoryRepository,
  GlobalMemoryResult,
  GlobalMemoryTarget,
} from "./types";

export const MAX_SYNCHRONIZER_OUTPUT_BYTES = 64 * 1024;

export interface ProcessRunOptions {
  cwd: string;
  shell: false;
  windowsHide: boolean;
  maxOutputBytes: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

function appendBounded(current: string, chunk: unknown, maxBytes: number): string {
  const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
}

export const defaultProcessRunner: ProcessRunner = async (command, args, options) => {
  const windowsPowerShell = process.platform === "win32" && command === "pwsh"
    ? (() => {
      const result = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true, shell: false });
      const candidate = result.status === 0 ? result.stdout.split(/\r?\n/u).map(value => value.trim()).find(Boolean) : undefined;
      return (candidate ?? (process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe`
        : "pwsh.exe")).replaceAll("\\", "/");
    })()
    : undefined;
  const executable = windowsPowerShell || command;
  const child = nodeSpawn(executable, [...args], {
    cwd: options.cwd,
    shell: false,
    windowsHide: options.windowsHide,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout = appendBounded(stdout, chunk, options.maxOutputBytes); });
  child.stderr?.on("data", chunk => { stderr = appendBounded(stderr, chunk, options.maxOutputBytes); });
  const errorPromise = once(child, "error").then(([error]) => { throw error; });
  const closePromise = once(child, "close").then(([exitCode, signal]) => ({
    exitCode: typeof exitCode === "number" ? exitCode : null,
    signal: (signal as NodeJS.Signals | null) ?? null,
    stdout,
    stderr,
  }));
  return await Promise.race([closePromise, errorPromise]) as ProcessRunResult;
};

function normalizeTargets(targets: GlobalMemoryTarget[] | undefined): GlobalMemoryTarget[] {
  const selected: GlobalMemoryTarget[] = targets?.length ? targets : ["all"];
  const result: GlobalMemoryTarget[] = [];
  for (const target of selected) {
    if (!result.includes(target)) result.push(target);
  }
  return result;
}

function targetArgument(targets: GlobalMemoryTarget[] | undefined): string {
  return normalizeTargets(targets).join(",");
}

export interface SynchronizerCommand {
  command: string;
  args: string[];
}

export function buildSynchronizerCommand(
  repository: GlobalMemoryRepository,
  request: GlobalMemoryRequest,
): SynchronizerCommand {
  const targets = targetArgument(request.targets);
  const home = request.homeDirectory ? resolve(request.homeDirectory) : undefined;
  if (repository.platform === "win32") {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", repository.synchronizerPath, request.action, "-Target", targets];
    if (home) args.push("-HomeDirectory", home);
    if (request.yes) args.push("-Yes");
    if (request.dryRun) args.push("-DryRun");
    return { command: "pwsh", args };
  }
  const args = [repository.synchronizerPath, request.action, "--target", targets];
  if (home) args.push("--home", home);
  if (request.yes) args.push("--yes");
  if (request.dryRun) args.push("--dry-run");
  return { command: "bash", args };
}

function parseState(raw: string): GlobalMemoryItemState {
  if (raw === "current" || raw === "missing" || raw === "drift" || raw === "conflict" || raw === "retained") return raw;
  if (raw === "installed" || raw === "unchanged") return "current";
  if (raw === "uninstalled") return "retained";
  return "unknown";
}

export function parseSynchronizerItems(output: string): GlobalMemoryResult["items"] {
  const items: GlobalMemoryResult["items"] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(?<name>[^:\r\n]+): (?<state>current|missing|drift|conflict|retained|installed|uninstalled|unchanged|unknown) - (?<rest>.*)$/u.exec(line);
    if (!match?.groups) continue;
    const rest = match.groups.rest;
    const reasonMatch = /^(?<path>.*) \((?<reason>[^()]*)\)$/u.exec(rest);
    items.push({
      name: match.groups.name.trim(),
      state: parseState(match.groups.state),
      ...(reasonMatch?.groups?.path ? { path: reasonMatch.groups.path, reason: reasonMatch.groups.reason } : { path: rest }),
    });
  }
  return items;
}

function validateMutationRequest(request: GlobalMemoryRequest): void {
  if (request.action !== "status" && !request.yes && !request.dryRun) {
    throw new Error(`${request.action} requires --yes unless --dry-run is used`);
  }
}

export interface RunGlobalMemorySyncOptions extends RepositoryResolutionOptions {
  processRunner?: ProcessRunner;
}

export async function runGlobalMemorySync(
  request: GlobalMemoryRequest,
  options: RunGlobalMemorySyncOptions = {},
): Promise<GlobalMemoryResult> {
  validateMutationRequest(request);
  const repository = await resolveGlobalMemoryRepository({ ...options, explicitPath: request.repositoryPath ?? options.explicitPath });
  const { command, args } = buildSynchronizerCommand(repository, request);
  let processResult: ProcessRunResult;
  try {
    processResult = await (options.processRunner ?? defaultProcessRunner)(command, args, {
      cwd: repository.repositoryPath,
      shell: false,
      windowsHide: true,
      maxOutputBytes: MAX_SYNCHRONIZER_OUTPUT_BYTES,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      action: request.action,
      repositoryPath: repository.repositoryPath,
      origin: repository.origin,
      exitCode: 2,
      stdout: "",
      stderr: `Could not start canonical synchronizer: ${detail}`,
      items: [],
    };
  }
  const exitCode = processResult.exitCode ?? 2;
  return {
    action: request.action,
    repositoryPath: repository.repositoryPath,
    origin: repository.origin,
    exitCode,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    items: parseSynchronizerItems(processResult.stdout),
  };
}
