import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GlobalMemoryRepository } from "./types";

export const CANONICAL_ORIGIN = "https://github.com/Ding-Ding-Projects/agent-global-memory";
export const GLOBAL_MEMORY_REPOSITORY_ENV = "OPENCODEX_GLOBAL_MEMORY_REPO";
const execFile = promisify(nodeExecFile);

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface GitRunner {
  (args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
}

export interface RepositoryResolutionOptions {
  explicitPath?: string;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  gitRunner?: GitRunner;
  platform?: NodeJS.Platform;
}

export class GlobalMemoryRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalMemoryRepositoryError";
  }
}

function boundedOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_COMMAND_OUTPUT_BYTES) return value;
  return `${Buffer.from(value, "utf8").subarray(-MAX_COMMAND_OUTPUT_BYTES).toString("utf8")}\n[output truncated]`;
}

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const result = await execFile("git", [...args], {
      cwd,
      windowsHide: true,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      encoding: "utf8",
    });
    return { stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr) };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const message = [detail.message, detail.stdout, detail.stderr].filter(Boolean).join("\n");
    throw new GlobalMemoryRepositoryError(`Git validation failed: ${message || "unknown error"}`);
  }
};

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new GlobalMemoryRepositoryError(`${label} must be an absolute path: ${value}`);
  if (value.split(/[\\/]/u).some(component => component === "..")) {
    throw new GlobalMemoryRepositoryError(`${label} must not contain a '..' path component: ${value}`);
  }
  return resolve(value);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function ensureRegularDirectory(path: string, label: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new GlobalMemoryRepositoryError(`${label} does not exist: ${path}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new GlobalMemoryRepositoryError(`${label} must be a regular directory, not a symlink or reparse point: ${path}`);
  }
  const resolved = await realpath(path);
  if (resolved !== path) {
    throw new GlobalMemoryRepositoryError(`${label} resolves through a symlink or reparse point: ${path}`);
  }
  return resolved;
}

async function ensureRegularFile(root: string, path: string, label: string): Promise<string> {
  const candidate = resolve(path);
  if (!isInside(root, candidate)) throw new GlobalMemoryRepositoryError(`${label} escapes the verified repository root: ${path}`);
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    throw new GlobalMemoryRepositoryError(`${label} is missing: ${candidate}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new GlobalMemoryRepositoryError(`${label} must be a regular file, not a symlink or reparse point: ${candidate}`);
  }
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) throw new GlobalMemoryRepositoryError(`${label} resolves outside the verified repository root: ${candidate}`);
  return resolved;
}

function canonicalOrigin(value: string): boolean {
  return value.trim().replace(/\.git$/u, "") === CANONICAL_ORIGIN;
}

export function resolveRepositoryCandidate(options: RepositoryResolutionOptions = {}): string {
  const environment = options.environment ?? process.env;
  if (options.explicitPath) return requireAbsolutePath(options.explicitPath, "--repo");
  const configured = environment[GLOBAL_MEMORY_REPOSITORY_ENV]?.trim();
  if (configured) return requireAbsolutePath(configured, GLOBAL_MEMORY_REPOSITORY_ENV);
  const sibling = resolve(options.cwd ?? process.cwd(), "..", "agent-global-memory");
  return sibling;
}

export async function resolveGlobalMemoryRepository(
  options: RepositoryResolutionOptions = {},
): Promise<GlobalMemoryRepository> {
  const candidate = resolveRepositoryCandidate(options);
  const repositoryPath = await ensureRegularDirectory(candidate, "global-memory repository");
  const git = options.gitRunner ?? defaultGitRunner;
  let origin: string;
  try {
    const gitRoot = (await git(["rev-parse", "--show-toplevel"], repositoryPath)).stdout.trim();
    if (!gitRoot || resolve(gitRoot) !== repositoryPath) {
      throw new GlobalMemoryRepositoryError(`Git root does not match the verified repository directory: ${gitRoot || "<missing>"}`);
    }
    origin = (await git(["remote", "get-url", "origin"], repositoryPath)).stdout.trim();
  } catch (error) {
    if (error instanceof GlobalMemoryRepositoryError) throw error;
    throw new GlobalMemoryRepositoryError(`Could not read the global-memory repository origin: ${String(error)}`);
  }
  if (!canonicalOrigin(origin)) {
    throw new GlobalMemoryRepositoryError(
      `Refusing non-canonical global-memory repository origin '${origin || "<missing>"}'. Expected ${CANONICAL_ORIGIN} with an optional .git suffix.`,
    );
  }

  const payloadPath = await ensureRegularFile(repositoryPath, join(repositoryPath, "memory", "SHARED_INSTRUCTIONS.md"), "canonical payload");
  const skillPath = await ensureRegularDirectory(join(repositoryPath, "skills", "agent-global-memory"), "canonical skill");
  await ensureRegularFile(repositoryPath, join(skillPath, "SKILL.md"), "canonical skill manifest");
  const synchronizerPath = await ensureRegularFile(
    repositoryPath,
    join(repositoryPath, "scripts", (options.platform ?? process.platform) === "win32" ? "sync-agent-memory.ps1" : "sync-agent-memory.sh"),
    "canonical synchronizer",
  );
  return {
    repositoryPath,
    origin,
    payloadPath,
    skillPath,
    synchronizerPath,
    platform: (options.platform ?? process.platform) === "win32" ? "win32" : "posix",
  };
}

export function isPathInsideRepository(repositoryPath: string, candidatePath: string): boolean {
  return isInside(resolve(repositoryPath), resolve(candidatePath));
}
