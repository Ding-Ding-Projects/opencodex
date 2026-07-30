/**
 * Local git history for the account/config state in `~/.opencodex`.
 *
 * Every account add, removal or replacement commits a snapshot of the state
 * files into a git repository that lives inside the config directory. That
 * gives "I deleted the wrong account" a real answer (`git -C ~/.opencodex log`
 * / `git show`) instead of a shrug.
 *
 * Scope and safety, deliberately:
 * - **Local only.** The repo is created with no remote, and nothing here ever
 *   pushes. It records secrets — OAuth refresh tokens, provider API keys — with
 *   the user's explicit consent to local-only storage. The generated
 *   README-HISTORY.md and `ocx export` both spell this out; the hard line is
 *   that the history must never leave the machine.
 * - **Fully asynchronous and never blocking.** The first version of this module
 *   used spawnSync and destabilised the OAuth login flow's timing (caught by
 *   tests/codex-auth-api.test.ts). Everything now runs through an internal
 *   sequential queue of async spawns: account operations return immediately,
 *   snapshots land in order, and two rapid changes cannot race the git index.
 * - **Best-effort.** No git, a locked index, a read-only dir — every failure is
 *   swallowed. Account operations must never fail because history could not be
 *   written. On Windows, a missing git is auto-installed once via winget
 *   (silent, license pre-accepted); on other platforms installation needs
 *   elevation, so it is logged and skipped.
 * - **Only deliberate state changes are committed.** Token refreshes rewrite
 *   codex-accounts.json every hour; committing those would bury the add/delete
 *   history in noise. Refresh paths simply do not call this.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

/** Durable state worth versioning. Everything else in the dir is runtime noise. */
const TRACKED = ["config.json", "codex-accounts.json", "auth.json"];

const GITIGNORE = `# opencodex state history — only durable state is tracked.
*
!.gitignore
!README-HISTORY.md
${TRACKED.map(name => `!${name}`).join("\n")}
`;

const README = `# opencodex state history

This is a LOCAL-ONLY git repository, written automatically when accounts are
added, removed or replaced. It exists so a mistaken account deletion can be
inspected and recovered:

    git -C . log --oneline
    git -C . show <commit>:codex-accounts.json

Its history contains SECRETS — OAuth refresh tokens and provider API keys —
stored here with your consent, on this machine only. Never add a remote, never
push it, never copy it somewhere synced or shared.
`;

/** Marker so a failed winget attempt is not repeated on every account change. */
const GIT_INSTALL_MARKER = "git-install-attempted";

interface GitResult {
  ok: boolean;
  stdout: string;
}

function runGit(dir: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn("git", ["-C", dir, ...args], {
        windowsHide: true,
        // Whatever identity/hooks the user configured globally must not run here,
        // and nothing may ever prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, stdout: "" }); });
    child.on("exit", code => { clearTimeout(timer); resolve({ ok: code === 0, stdout: stdout.trim() }); });
  });
}

async function gitAvailable(): Promise<boolean> {
  return (await runGit(".", ["--version"])).ok;
}

/**
 * Windows only: install git via winget, silently, at most once per install.
 * Elsewhere installation needs elevation (apt/dnf) or a GUI prompt
 * (xcode-select), so the honest move is to log the gap and let account
 * operations proceed without history rather than hang or half-install.
 */
async function autoInstallGit(configDir: string): Promise<boolean> {
  const marker = join(configDir, GIT_INSTALL_MARKER);
  if (existsSync(marker)) return false;
  try { writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8"); } catch { return false; }

  if (process.platform !== "win32") {
    console.warn("opencodex: git is not installed, so account-change history is disabled. Install git to enable it.");
    return false;
  }

  console.log("opencodex: git not found — installing via winget to enable account-change history...");
  const installed = await new Promise<boolean>(resolve => {
    let child;
    try {
      child = spawn("winget", [
        "install", "--id", "Git.Git", "-e",
        "--silent", "--accept-package-agreements", "--accept-source-agreements",
        "--disable-interactivity",
      ], { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(false); }, 600_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("exit", code => { clearTimeout(timer); resolve(code === 0); });
  });

  if (installed) console.log("opencodex: git installed. Account-change history is active from the next change.");
  else console.warn("opencodex: automatic git install did not complete; account-change history stays disabled. Install git manually to enable it.");
  // Even on success, this process's PATH may not see the new binary until
  // restart — callers re-probe rather than assuming.
  return installed;
}

async function ensureRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  if (!(await gitAvailable())) {
    await autoInstallGit(dir);
    if (!(await gitAvailable())) return false;
  }
  if (existsSync(join(dir, ".git"))) return true;
  if (!(await runGit(dir, ["init", "--quiet"])).ok) return false;
  try {
    writeFileSync(join(dir, ".gitignore"), GITIGNORE, "utf8");
    writeFileSync(join(dir, "README-HISTORY.md"), README, "utf8");
  } catch {
    return false;
  }
  // A repo-local identity so commits work regardless of the user's git setup,
  // and without touching their global config.
  await runGit(dir, ["config", "user.name", "opencodex state history"]);
  await runGit(dir, ["config", "user.email", "state-history@localhost"]);
  return true;
}

async function commitSnapshot(reason: string, configDir: string): Promise<boolean> {
  if (!(await ensureRepo(configDir))) return false;
  const present = TRACKED.filter(name => existsSync(join(configDir, name)));
  if (present.length === 0) return false;
  if (!(await runGit(configDir, ["add", "--", ".gitignore", "README-HISTORY.md", ...present])).ok) return false;
  // Sanitized single-line message: reasons are internal strings, but a defensive
  // strip keeps a future caller from smuggling flags or newlines into argv.
  const message = reason.replace(/[\r\n]+/g, " ").slice(0, 200) || "state change";
  // Hooks and signing are disabled on purpose: this is a machine-written repo,
  // and a user's global hooksPath or gpg prompt must never run inside an
  // account operation.
  return (await runGit(configDir, ["commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", message])).ok;
}

/**
 * Snapshots are serialized through this chain so concurrent account operations
 * cannot race each other's `git add`/`commit` on the shared index.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Record a snapshot. Resolves with whether a commit was created ("nothing
 * changed" is false — git refuses empty commits, which is correct here).
 * Runtime callers fire-and-forget with `void recordStateSnapshot(...)`; only
 * tests and the CLI await it.
 */
export function recordStateSnapshot(reason: string, configDir: string = getConfigDir()): Promise<boolean> {
  const next = queue.then(() => commitSnapshot(reason, configDir)).catch(() => false);
  queue = next;
  return next;
}

/** Short history listing for `ocx export --history`. Synchronous: CLI-only path. */
export function listStateHistory(limit = 20, configDir: string = getConfigDir()): string[] {
  if (!existsSync(join(configDir, ".git"))) return [];
  try {
    const result = spawnSync("git", ["-C", configDir, "log", "--oneline", `-${Math.max(1, Math.min(100, limit))}`], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim().split("\n") : [];
  } catch {
    return [];
  }
}
