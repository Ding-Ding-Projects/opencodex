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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { APP_LOG_DIR_NAME } from "./app-log-file";
import { USAGE_LOG_FILE_NAME } from "../usage/log";

/** Durable state worth versioning. Everything else in the dir is runtime noise. */
const TRACKED = ["config.json", "codex-accounts.json", "auth.json"];

/**
 * The logs, versioned in the SAME repository but as their own path set.
 *
 * One repository, two independent path sets, on purpose. A shared history keeps
 * "what happened to this machine" on one timeline, which is the thing anyone
 * chasing a fault actually reads. Keeping the sets separate keeps the two undos
 * independent: restoring a credential snapshot from last Tuesday must not also
 * throw away the logs that explain why you are restoring it, and restoring the
 * logs must not silently roll an account back.
 *
 * `git add -- <paths>` only stages what it is handed, and the index it stages
 * into already carries the previous commit's tree — so a log-only commit leaves
 * the state files at whatever they were, and vice versa.
 */
const TRACKED_LOGS = [USAGE_LOG_FILE_NAME, APP_LOG_DIR_NAME];

/**
 * `*` ignores everything, including directories, and a negation cannot reach
 * inside a directory that is itself ignored — so `logs/` has to be un-ignored,
 * its contents re-ignored, and the log files whitelisted by name. Getting this
 * wrong is silent: `git add` refuses an ignored path outright, so the snapshot
 * would simply never happen and the delete would proceed with nothing behind it.
 */
const GITIGNORE = `# opencodex state history — only durable state and logs are tracked.
*
!.gitignore
!.gitattributes
!README-HISTORY.md
${TRACKED.map(name => `!${name}`).join("\n")}
!${USAGE_LOG_FILE_NAME}
!${APP_LOG_DIR_NAME}/
${APP_LOG_DIR_NAME}/*
!${APP_LOG_DIR_NAME}/*.log
!${APP_LOG_DIR_NAME}/*.log.*
`;

/**
 * Byte-for-byte, in both directions.
 *
 * Git's default on Windows (`core.autocrlf=true`) converts LF to CRLF on
 * checkout, so a file committed here and restored later came back with
 * different bytes than it went in with. For a JSONL log that is merely wrong;
 * for anything encrypted it is fatal, because a ciphertext whose bytes moved
 * will not decrypt and fails in a way indistinguishable from corruption — and
 * the snapshot is supposed to be the thing that makes the data recoverable.
 *
 * `* -text` disables every content filter regardless of the user's git config,
 * which is why the rule lives in a file rather than in `git config`: config is
 * one `git config --global` away from being overridden, an attributes file in
 * the working tree is not.
 */
const GITATTRIBUTES = `# opencodex state history — never transform stored bytes.
* -text
`;

const README = `# opencodex state history

This is a LOCAL-ONLY git repository, written automatically when accounts are
added, removed or replaced. It exists so a mistaken account deletion can be
inspected and recovered:

    git -C . log --oneline
    git -C . show <commit>:codex-accounts.json

The request log (usage.jsonl) and the app log (logs/opencodex.log) are tracked
too, and are committed here before the dashboard clears them, so "I deleted the
logs" is undoable as well.

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

/**
 * Bring an existing repo's rule files up to the current ones.
 *
 * Two upgrade hazards, both silent. A repository created before the logs were
 * tracked carries an ignore file that excludes them, and `git add` REFUSES an
 * ignored path rather than warning — so a log snapshot would simply never
 * happen and the delete it was protecting would go ahead with nothing behind
 * it. A repository created before `.gitattributes` existed still has git's
 * Windows line-ending filter armed, so a restore hands back different bytes
 * than were committed.
 *
 * Rewritten only when the bytes differ, so this is not a spurious change on
 * every snapshot.
 */
function refreshRepoRules(dir: string): void {
  for (const [name, content] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]] as const) {
    const path = join(dir, name);
    try {
      if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
      writeFileSync(path, content, "utf8");
    } catch {
      /* a read-only dir leaves the old rules in place; snapshots still try */
    }
  }
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
  if (existsSync(join(dir, ".git"))) {
    refreshRepoRules(dir);
    return true;
  }
  if (!(await runGit(dir, ["init", "--quiet"])).ok) return false;
  try {
    writeFileSync(join(dir, ".gitignore"), GITIGNORE, "utf8");
    writeFileSync(join(dir, ".gitattributes"), GITATTRIBUTES, "utf8");
    writeFileSync(join(dir, "README-HISTORY.md"), README, "utf8");
  } catch {
    return false;
  }
  // A repo-local identity so commits work regardless of the user's git setup,
  // and without touching their global config.
  await runGit(dir, ["config", "user.name", "opencodex state history"]);
  await runGit(dir, ["config", "user.email", "state-history@localhost"]);
  // Belt to `.gitattributes`' braces. The attributes file is authoritative, but
  // a repo whose config also says so cannot be surprised by a future git that
  // reads them in a different order.
  await runGit(dir, ["config", "core.autocrlf", "false"]);
  return true;
}

async function commitSnapshot(
  reason: string,
  configDir: string,
  allowInstall = true,
  paths: readonly string[] = TRACKED,
): Promise<boolean> {
  if (!(await ensureRepo(configDir, allowInstall))) return false;
  const present = paths.filter(name => existsSync(join(configDir, name)));
  if (present.length === 0) return false;
  if (!(await runGit(configDir, ["add", "--", ".gitignore", ".gitattributes", "README-HISTORY.md", ...present])).ok) return false;
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
  paths: readonly string[] = TRACKED,
): Promise<boolean> {
  const committed = queue.then(() => commitSnapshot(reason, configDir, false, paths)).catch(() => false);
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

/**
 * Which path set a commit actually touched. Derived from the commit's changed
 * files, never from its message: the dashboard picks a restore endpoint from
 * this, and a restore aimed by parsing a display string is exactly the mistake
 * `listStateHistoryEntries` was written to avoid in the first place.
 */
export type StateHistoryScope = "state" | "logs" | "mixed";

export interface StateHistoryEntry {
  /** Full commit hash — what a restore is addressed by. */
  hash: string;
  /** Short hash, for display. */
  short: string;
  /** The reason string the snapshot was recorded with. */
  subject: string;
  /** Commit time, ISO-8601. */
  at: string;
  /** What this commit changed, so the caller can offer the matching restore. */
  scope: StateHistoryScope;
}

function isLogPath(name: string): boolean {
  return name === USAGE_LOG_FILE_NAME || name.startsWith(`${APP_LOG_DIR_NAME}/`);
}

function scopeOf(files: readonly string[]): StateHistoryScope {
  const logs = files.some(isLogPath);
  const state = files.some(name => TRACKED.includes(name));
  // A commit that touched neither (the very first one, which only carries the
  // ignore file and the README) reads as "state": it is the machine's own
  // bookkeeping, and offering to restore logs from it would find none.
  if (logs && state) return "mixed";
  return logs ? "logs" : "state";
}

/**
 * Structured history, for the dashboard's restore list. `listStateHistory`'s
 * oneline strings are fine to read but useless to act on — a one-click restore
 * needs the hash as its own field, not something scraped off a display string.
 *
 * `--name-only` rides the same `git log` rather than costing one `git show` per
 * commit, so the scope is real evidence at the price of a slightly fussier parse.
 */
export function listStateHistoryEntries(limit = 50, configDir: string = getConfigDir()): StateHistoryEntry[] {
  if (!existsSync(join(configDir, ".git"))) return [];
  const SEP = "\x1f";
  // Record separator: `--name-only` prints a blank line between the header and
  // the file list, so a blank line cannot delimit commits as well.
  const REC = "\x1e";
  try {
    const result = spawnSync("git", [
      "-C", configDir, "log",
      `-${Math.max(1, Math.min(200, limit))}`,
      "--name-only",
      `--format=${REC}%H${SEP}%s${SEP}%cI`,
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    return result.stdout.split(REC).flatMap(record => {
      if (!record.trim()) return [];
      const [header, ...rest] = record.split("\n");
      const [hash, subject, at] = header.split(SEP);
      if (!hash || !at) return [];
      const files = rest.map(line => line.trim()).filter(Boolean);
      return [{ hash, short: hash.slice(0, 7), subject: subject ?? "", at, scope: scopeOf(files) }];
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

/** Every tracked file that exists on disk right now under `paths`, relative to the repo. */
function presentUnder(configDir: string, paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of paths) {
    const absolute = join(configDir, name);
    if (!existsSync(absolute)) continue;
    try {
      // A tracked entry is either a file (config.json, usage.jsonl) or the log
      // directory. `git ls-tree -r` returns the directory's members, so the
      // "kept" comparison has to enumerate its members too or every restore
      // would report the whole directory as kept.
      const entries = readdirSync(absolute, { withFileTypes: true });
      for (const entry of entries) if (entry.isFile()) found.push(`${name}/${entry.name}`);
    } catch {
      found.push(name);
    }
  }
  return found;
}

async function performRestore(
  commit: string,
  configDir: string,
  paths: readonly string[],
  what: string,
): Promise<StateRestoreResult> {
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
  const snapshotBefore = await commitSnapshot(`before restore: ${commit.slice(0, 7)}`, configDir, false, paths);

  // `-r` so the log directory yields its members rather than one tree entry.
  const listed = await runGit(configDir, ["ls-tree", "-r", "--name-only", commit, "--", ...paths]);
  if (!listed.ok) return fail("could not read that revision");
  const inCommit = listed.stdout.split("\n").map(line => line.trim())
    // Defence in depth: only ever write back inside the path set this restore
    // was scoped to, whatever `ls-tree` happens to return.
    .filter(name => name !== "" && paths.some(root => name === root || name.startsWith(`${root}/`)));
  if (inCommit.length === 0) return fail(`that revision holds none of the ${what}`);

  if (!(await runGit(configDir, ["checkout", commit, "--", ...inCommit])).ok) {
    // A failed checkout can still have written some of the paths, so the caller is
    // told disk moved and must restart rather than resume on a stale config.
    return fail("could not write the restored files", true);
  }

  // A NEW commit on top, never a rewind: the log stays append-only, so this
  // restore can be undone in turn by restoring the commit made just above.
  await commitSnapshot(`restored from ${commit.slice(0, 7)}`, configDir, false, paths);

  return {
    ok: true,
    restored: inCommit,
    kept: presentUnder(configDir, paths).filter(name => !inCommit.includes(name)),
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
    .then(() => performRestore(commit, configDir, TRACKED, "state files"))
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

/**
 * Commit the logs as they stand RIGHT NOW, before the caller deletes them.
 *
 * Same contract and the same reasoning as
 * {@link recordStateSnapshotBeforeDelete}, aimed at the log path set instead:
 * awaited so the bytes are safely in git before they are destroyed, bounded so
 * a clear cannot hang on it, and never fatal — if the snapshot cannot be made,
 * the user's clear still happens. Losing the undo is bad; refusing to do what
 * the user asked because the bookkeeping repo was busy is worse.
 *
 * Returns the commit that now holds the logs, or `null` when nothing was
 * committed. `null` also covers "nothing had changed since the last snapshot",
 * in which case an earlier commit already holds them.
 */
export async function recordLogSnapshotBeforeDelete(
  reason: string,
  configDir: string = getConfigDir(),
  timeoutMs = PRE_DELETE_SNAPSHOT_TIMEOUT_MS,
): Promise<string | null> {
  const committed = await recordStateSnapshotBeforeDelete(reason, configDir, timeoutMs, TRACKED_LOGS);
  if (!committed) return null;
  // Read the hash back rather than threading it out of the commit plumbing: this
  // runs once per explicit user action, and the echoed hash is what the dashboard
  // offers as the one-click undo.
  return listStateHistoryEntries(1, configDir)[0]?.hash ?? null;
}

/**
 * Roll the log files back to a commit from the same local history.
 *
 * Append-only exactly as the state restore is: the logs as they are now are
 * committed first, the restore is committed second, and nothing is rewritten —
 * so restoring a log snapshot can itself be undone by restoring the commit made
 * just above it, and that undo undone in turn.
 *
 * Unlike the state restore this needs no drain and no restart. Logs are not
 * credentials: nothing in flight is reading them, and the in-memory rings are
 * re-seeded from the restored files by the caller.
 */
export function restoreLogsFromHistory(commit: string, configDir: string = getConfigDir()): Promise<StateRestoreResult> {
  const next = queue
    .then(() => performRestore(commit, configDir, TRACKED_LOGS, "log files"))
    .catch(err => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
      restored: [],
      kept: [],
      snapshotBefore: false,
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
