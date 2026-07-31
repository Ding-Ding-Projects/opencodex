/**
 * Automatic installation for the launch-card targets.
 *
 * "Get it" used to be a hyperlink: it opened a download page and left the user
 * to find the installer, run it, and come back. This module makes it actually
 * install the thing.
 *
 * Two rules shape everything below.
 *
 * **Only official packages.** Every package id here was verified against the
 * live catalogue and its publisher checked — `Anthropic.Claude` is published by
 * "Anthropic, PBC", `xAI.GrokBuild` by "xAI Corp.". Where no official package
 * exists the target is left as a manual link rather than pointed at a
 * community repackage: winget lists three unrelated publishers shipping
 * something called "ChatGPT", and silently installing one of those because the
 * name matched would be a supply-chain hole with a friendly button on it.
 *
 * **The package id is never user input.** A request supplies a catalog target
 * id, which is looked up here; the command line is assembled from constants. No
 * string from the network reaches a shell argument.
 *
 * Installs run detached from any console — `windowsHide` everywhere, same as
 * the launcher — because a package manager flashing up a terminal window is the
 * exact thing the desktop shell exists to avoid.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { launchTargetIds, resolveLaunchTarget, WINDOWS_TERMINAL_ID, type LaunchKind } from "./app-launcher.js";
import { appExecutionAliasExists, commandInvocation, type SpawnInvocation } from "./win-exec.js";

export type InstallMethod = "winget" | "npm";

type PlatformKey = "win32" | "darwin" | "linux";

export interface InstallRecipe {
  method: InstallMethod;
  /** winget package id, or npm package name. Constant — never from a request. */
  pkg: string;
  /** Platforms this recipe is valid on. */
  platforms: PlatformKey[];
}

/**
 * Ordered install routes per target; the first whose platform matches and whose
 * tool is present is used.
 *
 * winget leads on Windows because it is present by default on Windows 10+ and
 * needs no Node.js — opencodex ships its own Bun and cannot assume npm exists.
 * npm follows as the cross-platform route, and is the only route on macOS and
 * Linux.
 */
const RECIPES: Record<string, InstallRecipe[]> = {
  "codex-cli": [
    { method: "winget", pkg: "OpenAI.Codex", platforms: ["win32"] },
    { method: "npm", pkg: "@openai/codex", platforms: ["win32", "darwin", "linux"] },
  ],
  "claude-cli": [
    { method: "winget", pkg: "Anthropic.ClaudeCode", platforms: ["win32"] },
    { method: "npm", pkg: "@anthropic-ai/claude-code", platforms: ["win32", "darwin", "linux"] },
  ],
  "grok-cli": [
    { method: "npm", pkg: "@vibe-kit/grok-cli", platforms: ["win32", "darwin", "linux"] },
  ],
  "claude-desktop": [
    { method: "winget", pkg: "Anthropic.Claude", platforms: ["win32"] },
  ],
  // Not an agent app: the terminal a CLI target is opened in. Without it the
  // launcher refuses to open a CLI at all (it will not fall back to a legacy
  // console), so "install the thing" has to cover the window as well as the
  // program that draws in it.
  //
  // Verified against the live catalogue like every other id here —
  // `winget show Microsoft.WindowsTerminal` reports "Windows Terminal",
  // publisher "Microsoft Corporation", installer type msix, served from
  // github.com/microsoft/terminal/releases. winget-only on purpose: there is no
  // npm route to an MSIX package, and it is a Windows-only need anyway.
  [WINDOWS_TERMINAL_ID]: [
    { method: "winget", pkg: "Microsoft.WindowsTerminal", platforms: ["win32"] },
  ],
  // chatgpt-desktop and grok-desktop deliberately have no recipe: no official
  // package is published for either. They stay manual links.
};

export interface InstallJob {
  id: string;
  targetId: string;
  label: string;
  kind: LaunchKind;
  method: InstallMethod;
  pkg: string;
  state: "running" | "done" | "failed";
  /** Bounded transcript of the package manager's own output. */
  log: string[];
  error?: string;
  /** True once the installed program can actually be found afterwards. */
  verified?: boolean;
  /**
   * Set when the install succeeded but the program is not yet visible to this
   * process. Installers extend the machine PATH, and an already-running process
   * keeps the environment it started with — so this is "restart me", not
   * "it failed".
   */
  note?: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * After this long a running job is presumed wedged and can be superseded.
 *
 * Generous on purpose: a cold winget install of a large desktop app genuinely
 * takes minutes, and killing a working install to satisfy a timer would be
 * worse than the stall it guards against.
 */
const STALE_JOB_MS = 15 * 60_000;

/** Bounded so a chatty installer cannot grow the process heap without limit. */
const MAX_LOG_LINES = 400;
const MAX_JOBS = 40;

const jobs = new Map<string, InstallJob>();
let seq = 0;

function platformKey(): PlatformKey {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

/**
 * Find a package manager on PATH.
 *
 * `existsSync` is not enough on Windows. winget ships as an MSIX app execution
 * alias, and those are invisible to stat (see `appExecutionAliasExists`) — so
 * this answered "winget is not installed" on every ordinary Windows machine, and
 * every winget recipe in this file was unreachable as a result. The symptom was
 * not an error: "Get it" quietly downgraded to opening a download page.
 */
function onPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (existsSync(full) || appExecutionAliasExists(full)) return full;
    }
  }
  return null;
}

/** The package managers this host actually has. */
export function availableMethods(): InstallMethod[] {
  const found: InstallMethod[] = [];
  if (process.platform === "win32" && onPath(["winget.exe"])) found.push("winget");
  if (onPath(process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"])) found.push("npm");
  return found;
}

/** The recipe that will be used for a target on this machine, or null. */
export function chooseRecipe(targetId: string): InstallRecipe | null {
  const recipes = RECIPES[targetId];
  if (!recipes) return null;
  const platform = platformKey();
  const methods = availableMethods();
  return recipes.find(r => r.platforms.includes(platform) && methods.includes(r.method)) ?? null;
}

/**
 * Every recipe declared for a target, regardless of what this host has.
 *
 * `chooseRecipe` answers "what will run here", which is null on a machine
 * without the package manager — so it cannot be used to pin down *which package*
 * a target names. That distinction is the point: the package id is the security
 * claim in this file, and it has to be assertable on any machine the tests run
 * on, not only one with winget.
 */
export function installRecipesFor(targetId: string): readonly InstallRecipe[] {
  return RECIPES[targetId] ?? [];
}

/** Whether a target could be installed automatically right now. */
export function canInstall(targetId: string): boolean {
  return chooseRecipe(targetId) !== null;
}

/**
 * True when a target has an install route defined at all, regardless of whether
 * this machine has the tool for it. Distinguishes "no automatic route exists"
 * from "you are missing winget", which are different messages to the user.
 */
export function hasInstallRoute(targetId: string): boolean {
  const recipes = RECIPES[targetId];
  return !!recipes && recipes.some(r => r.platforms.includes(platformKey()));
}

/**
 * The invocation for a recipe, routed through the repo's cross-platform launcher.
 *
 * `commandInvocation` is not optional decoration here. npm on Windows is a
 * `.cmd` shim, and Node/Bun refuse a shell-less `.cmd` spawn outright since the
 * CVE-2024-27980 hardening — `spawn("npm.cmd", …)` fails with EINVAL every
 * time. Spawning the bare name is no better: it skips PATHEXT resolution and
 * ENOENTs even when `npm.cmd` is on PATH. So the npm route was dead on the one
 * platform this app ships an installer for, and dead in a way that surfaced as
 * a plausible-looking failed install rather than as an obvious bug.
 *
 * `win-exec` resolves the target through PATH×PATHEXT and wraps `.cmd`/`.bat`
 * in `cmd.exe /d /s /c` with verbatim arguments, which is the same approach
 * cross-spawn uses and what every other spawn site in this repo already does.
 * It also carries the app-execution-alias case, which is the only reason a
 * winget recipe runs at all: winget itself is an alias.
 */
export function installInvocation(recipe: InstallRecipe): SpawnInvocation {
  if (recipe.method === "winget") {
    return commandInvocation("winget", [
      "install", "--id", recipe.pkg, "--source", "winget", "--exact",
      // Unattended: a package manager that stops on a licence prompt behind a
      // hidden window would hang forever with nothing on screen to click.
      "--silent", "--accept-package-agreements", "--accept-source-agreements",
      "--disable-interactivity",
    ]);
  }
  return commandInvocation("npm", ["install", "--global", recipe.pkg]);
}

/**
 * Can the freshly installed program be found?
 *
 * Only the launcher's own resolution counts. An earlier version fell back to
 * "does the global npm bin directory exist", which answers a different question
 * entirely: that directory is present on any machine that ever ran `npm i -g`
 * anything, and it knows nothing about the package just installed. It reported
 * `verified` for winget targets npm never touched, and — because npm's Windows
 * prefix already *is* the bin directory — reported a genuinely successful npm
 * install as unverified by probing `…\npm\npm`. Wrong in both directions, and
 * a false `verified` suppresses the one piece of advice that actually helps:
 * restart, because installers extend the machine PATH and this process kept the
 * environment it started with.
 *
 * Unverified is not failure. It means "installed, but not visible from here".
 */
function verify(targetId: string): boolean {
  return resolveLaunchTarget(targetId) !== null;
}

function push(job: InstallJob, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const text = line.trimEnd();
    if (!text) continue;
    job.log.push(text);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()]
    .filter(j => j.state !== "running")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  for (const job of done) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(job.id);
  }
}

export type StartInstallResult =
  | { ok: true; job: InstallJob }
  /**
   * `manual` means there is no automatic route; `installed` means there is
   * nothing left to do. Both are refusals, and a caller that could only read the
   * sentence had to match on English prose to tell them apart — so a dashboard
   * retrying after an install would have treated "already installed" as a
   * failure and stopped.
   */
  | { ok: false; error: string; manual?: boolean; installed?: boolean };

/**
 * Begin installing a catalog target. Returns as soon as the process is spawned;
 * the caller polls the job for progress.
 */
export function startInstall(targetId: string): StartInstallResult {
  const known = launchTargetIds().find(t => t.id === targetId);
  if (!known) return { ok: false, error: "unknown launch target" };
  if (resolveLaunchTarget(targetId) !== null) {
    return { ok: false, installed: true, error: `${known.label} is already installed` };
  }

  // A job still running is reported back rather than started twice — but only
  // while it is plausibly alive. A package manager that wedges (a lock, a
  // network stall, a prompt behind a hidden window) would otherwise pin the
  // target as "installing" for the life of the process, with no timeout, no
  // cancel route and no way for the user to try again.
  const running = [...jobs.values()].find(j => j.targetId === targetId && j.state === "running");
  if (running) {
    if (Date.now() - running.startedAt < STALE_JOB_MS) return { ok: true, job: running };
    running.state = "failed";
    running.error = `no output for ${Math.round(STALE_JOB_MS / 60000)} minutes — treating as stalled`;
    running.endedAt = Date.now();
  }

  if (!hasInstallRoute(targetId)) {
    return {
      ok: false,
      manual: true,
      error: `No official package is published for ${known.label} on this platform, so opencodex will not install it automatically. Opening the download page instead.`,
    };
  }

  const recipe = chooseRecipe(targetId);
  if (!recipe) {
    const wanted = (RECIPES[targetId] ?? [])
      .filter(r => r.platforms.includes(platformKey()))
      .map(r => r.method);
    return {
      ok: false,
      manual: true,
      error: `Installing ${known.label} here needs ${wanted.join(" or ")}, which is not on this machine.`,
    };
  }

  const job: InstallJob = {
    id: `install-${++seq}-${targetId}`,
    targetId,
    label: known.label,
    kind: known.kind,
    method: recipe.method,
    pkg: recipe.pkg,
    state: "running",
    log: [],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  prune();

  const { file, args, options } = installInvocation(recipe);
  // The transcript names the package manager and package, not the cmd.exe
  // wrapper win-exec may have produced — the wrapper is an implementation
  // detail and printing it would make a normal install look alarming.
  push(job, `$ ${recipe.method} ${recipe.pkg}`);

  try {
    const child = spawn(file, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => push(job, d.toString()));
    child.stderr?.on("data", (d: Buffer) => push(job, d.toString()));
    child.on("error", err => {
      job.state = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.endedAt = Date.now();
    });
    child.on("close", code => {
      if (job.state !== "running") return;
      job.endedAt = Date.now();
      if (code === 0) {
        job.state = "done";
        job.verified = verify(targetId);
        if (!job.verified) {
          job.note = `${job.label} installed. Restart opencodex so it picks up the updated PATH.`;
        }
      } else {
        job.state = "failed";
          job.error = `${recipe.method} exited with code ${code}`;
      }
    });
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.endedAt = Date.now();
  }

  return { ok: true, job };
}

export function getInstallJob(id: string): InstallJob | null {
  return jobs.get(id) ?? null;
}

export function listInstallJobs(): InstallJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Test seam: forget every recorded job. */
export function resetInstallJobs(): void {
  jobs.clear();
  seq = 0;
}
