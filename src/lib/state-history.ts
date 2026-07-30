/**
 * Local git history for the account/config state in `~/.opencodex`.
 *
 * Every account add, removal or replacement commits a snapshot of the state
 * files into a git repository that lives inside the config directory. That
 * gives "I deleted the wrong account" a real answer (`git -C ~/.opencodex log`
 * / `git show`) instead of a shrug.
 *
 * Deletions are recorded TWICE — once before and once after. A single
 * post-change commit would record only the state without the account, leaving
 * recovery to whatever an earlier commit happened to contain; see
 * {@link recordStateSnapshotBeforeDelete}. Every path that can destroy an
 * account or credential — Codex accounts, OAuth accounts, provider logout,
 * provider API keys, data-access keys — takes the before/after pair, so any
 * deletion is undoable regardless of how the account was created.
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

async function ensureRepo(dir: string, allowInstall = true): Promise<boolean> {
  if (!existsSync(dir)) return false;
  if (!(await gitAvailable())) {
    // The pre-delete path passes allowInstall=false: a caller is waiting on it, and
    // a winget install can take minutes. Installation stays on the fire-and-forget
    // post-change path, where a slow install delays nothing the user is watching.
    if (!allowInstall) return false;
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

async function commitSnapshot(reason: string, configDir: string, allowInstall = true): Promise<boolean> {
  if (!(await ensureRepo(configDir, allowInstall))) return false;
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

/** How long a deletion will wait for its own "before" commit before giving up. */
const PRE_DELETE_SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * Commit the state as it stands RIGHT NOW, before the caller deletes something,
 * and wait for that commit to land.
 *
 * Post-change snapshots alone cannot make a deletion undoable. They record the
 * state *after* the account is gone, so recovery depends on some earlier commit
 * happening to contain it — which is not true for an account that predates this
 * history, nor for the very first change ever recorded. Committing the "before"
 * state first means the deleted account is always one `git show` away:
 *
 *     git -C ~/.opencodex log --oneline
 *     git -C ~/.opencodex show <commit-before-the-removal>:auth.json
 *
 * Awaited on purpose — the point is that the bytes are safely committed before
 * they are destroyed — but bounded, and it never triggers a git install, so a
 * deletion cannot hang on it. If it cannot commit in time the deletion still
 * proceeds: blocking a user's delete on a bookkeeping repo would be worse than
 * a gap in the history. Returns whether a "before" commit was actually created
 * (false also means "nothing had changed since the last snapshot" — the state
 * was already recorded, which is equally fine).
 */
export async function recordStateSnapshotBeforeDelete(
  reason: string,
  configDir: string = getConfigDir(),
  timeoutMs = PRE_DELETE_SNAPSHOT_TIMEOUT_MS,
): Promise<boolean> {
  const committed = queue.then(() => commitSnapshot(reason, configDir, false)).catch(() => false);
  // Keep the chain intact even if we stop waiting, so a later snapshot still
  // serializes behind this one instead of racing it on the shared git index.
  queue = committed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      committed,
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StateHistoryEntry {
  /** Full commit hash — what a restore is addressed by. */
  hash: string;
  /** Short hash, for display. */
  short: string;
  /** The reason string the snapshot was recorded with. */
  subject: string;
  /** Commit time, ISO-8601. */
  at: string;
}

/**
 * Structured history, for the dashboard's restore list. `listStateHistory`'s
 * oneline strings are fine to read but useless to act on — a one-click restore
 * needs the hash as its own field, not something scraped off a display string.
 */
export function listStateHistoryEntries(limit = 50, configDir: string = getConfigDir()): StateHistoryEntry[] {
  if (!existsSync(join(configDir, ".git"))) return [];
  const SEP = "\x1f";
  try {
    const result = spawnSync("git", [
      "-C", configDir, "log",
      `-${Math.max(1, Math.min(200, limit))}`,
      `--format=%H${SEP}%s${SEP}%cI`,
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    return result.stdout.trim().split("\n").flatMap(line => {
      const [hash, subject, at] = line.split(SEP);
      if (!hash || !at) return [];
      return [{ hash, short: hash.slice(0, 7), subject: subject ?? "", at }];
    });
  } catch {
    return [];
  }
}

/** Restore addresses commits by hash only — never a ref expression a caller could aim elsewhere. */
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

export interface StateRestoreResult {
  ok: boolean;
  error?: string;
  /** Files actually rewritten from the chosen commit. */
  restored: string[];
  /**
   * Tracked files that exist now but were absent from the chosen commit. Left in
   * place deliberately — see {@link restoreStateFromHistory}.
   */
  kept: string[];
  /** Whether the pre-restore state got its own commit (what makes the restore undoable). */
  snapshotBefore: boolean;
  /**
   * Whether the state files may already have been written. A caller that quiesced
   * the server needs this to decide between resuming (nothing was touched, so the
   * live config still matches disk) and restarting (disk may have moved, and the
   * in-memory config would otherwise save straight over it).
   */
  touchedDisk: boolean;
}

async function performRestore(commit: string, configDir: string): Promise<StateRestoreResult> {
  const fail = (error: string, touchedDisk = false): StateRestoreResult =>
    ({ ok: false, error, restored: [], kept: [], snapshotBefore: false, touchedDisk });

  if (!COMMIT_HASH_RE.test(commit)) return fail("commit must be a hex commit hash");
  if (!existsSync(join(configDir, ".git"))) return fail("no state history exists yet");
  // `<hash>^{commit}` refuses a hash that resolves to a blob or tree, and a hash
  // that is not in this repository at all.
  if (!(await runGit(configDir, ["cat-file", "-e", `${commit}^{commit}`])).ok) {
    return fail("that revision is not in the state history");
  }

  // The state as it is right now, before being overwritten. This is what makes a
  // restore itself undoable, so the user can always get back to where they were.
  const snapshotBefore = await commitSnapshot(`before restore: ${commit.slice(0, 7)}`, configDir, false);

  const listed = await runGit(configDir, ["ls-tree", "--name-only", commit, "--", ...TRACKED]);
  if (!listed.ok) return fail("could not read that revision");
  const inCommit = listed.stdout.split("\n").map(line => line.trim()).filter(name => TRACKED.includes(name));
  if (inCommit.length === 0) return fail("that revision holds none of the state files");

  if (!(await runGit(configDir, ["checkout", commit, "--", ...inCommit])).ok) {
    // A failed checkout can still have written some of the paths, so the caller is
    // told disk moved and must restart rather than resume on a stale config.
    return fail("could not write the restored files", true);
  }

  // A NEW commit on top, never a rewind: the log stays append-only, so this
  // restore can be undone in turn by restoring the commit made just above.
  await commitSnapshot(`restored from ${commit.slice(0, 7)}`, configDir, false);

  return {
    ok: true,
    restored: inCommit,
    kept: TRACKED.filter(name => !inCommit.includes(name) && existsSync(join(configDir, name))),
    snapshotBefore,
    touchedDisk: true,
  };
}

/**
 * Roll the durable state files back to a commit from the local history.
 *
 * Append-only by construction: the current state is committed first, the restore
 * is committed second, and nothing is ever rewritten or dropped from the log. An
 * undo can therefore be undone, and that undo undone in turn — which is the
 * whole reason the history is safe to use.
 *
 * A tracked file that exists today but is absent from the chosen commit is
 * **kept, not deleted**, and reported in `kept`. Deleting it would be the more
 * literal reading of "restore", but it would also silently destroy accounts
 * added since — and a recovery feature that can lose data is not one. The
 * caller is told, and can delete deliberately.
 *
 * The caller must have quiesced the server first: this rewrites credential files
 * that in-flight requests read, and the live in-memory config will overwrite
 * them again on its next save, so a restart has to follow.
 *
 * Serialized through the same queue as snapshots — a restore and a snapshot
 * racing on one git index would corrupt both.
 */
export function restoreStateFromHistory(commit: string, configDir: string = getConfigDir()): Promise<StateRestoreResult> {
  const next = queue
    .then(() => performRestore(commit, configDir))
    .catch(err => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
      restored: [],
      kept: [],
      snapshotBefore: false,
      // An unexpected throw gives no proof the tree is untouched; assume it moved.
      touchedDisk: true,
    }));
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
