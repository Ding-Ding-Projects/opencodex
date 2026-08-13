/**
 * Quick restore: hand one agent tool's native configuration back to it, without
 * making that depend on the proxy shutting down cleanly.
 *
 * OpenCodex earns its keep by *rewriting* the files `codex` and `claude` read —
 * `$CODEX_HOME/config.toml`, the routed model catalog, `~/.claude/agents/ocx-*.md`
 * and, on macOS, the launchctl environment those tools inherit. Undoing that is
 * already possible today: `ocx restore`, `ocx stop` and the dashboard's Stop
 * button all do it on the way out.
 *
 * What none of those cover is the case somebody actually reaches for a button in:
 * something is wedged. `POST /api/stop` drains in-flight turns before it touches
 * anything, `ocx stop` refuses outright when an installed service belongs to a
 * different OPENCODEX_HOME, and a service manager that will not answer takes the
 * whole teardown down with it. In every one of those the native config stays
 * rewritten — which is the one thing the user needed back, and the one thing a
 * teardown-shaped undo cannot deliver when the teardown is the part that broke.
 *
 * So this module is deliberately the *small* half of a stop. It touches only the
 * tool's own files, takes no locks, waits on nothing and never consults the
 * proxy's lifecycle. A caller that also wants the proxy stopped does that as a
 * separate, later step, whose failure therefore cannot reach back and undo this
 * one. That ordering is the whole design: independence by construction rather
 * than by a timeout that can still lose the race.
 *
 * Shared between `/api/host/quick-restore` and any CLI surface, for the same
 * reason `host-control.ts` is shared — two implementations of "what does restore
 * mean" is two answers, and the one on screen would be the wrong one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The tools whose native configuration OpenCodex rewrites and can hand back. */
export const QUICK_RESTORE_TOOLS = ["codex", "claude"] as const;

export type QuickRestoreTool = (typeof QUICK_RESTORE_TOOLS)[number];

export function isQuickRestoreTool(value: unknown): value is QuickRestoreTool {
  return typeof value === "string" && (QUICK_RESTORE_TOOLS as readonly string[]).includes(value);
}

/**
 * Why a tool cannot be restored right now.
 *
 * Machine-readable so the dashboard can say the specific thing rather than
 * greying a control out and leaving the reader to guess whether it is broken.
 * `null` means the action is available.
 */
export type QuickRestoreBlocker = "tool-not-found";

export interface QuickRestoreReadiness {
  tool: QuickRestoreTool;
  /** True when there is something on this machine for the restore to act on. */
  available: boolean;
  reason: QuickRestoreBlocker | null;
  /**
   * Absolute paths this restore may rewrite or delete, so the confirmation can
   * name them. A user agreeing to have files rewritten is owed the file names.
   */
  paths: string[];
  /**
   * True when OpenCodex routing is currently detectable in those paths.
   *
   * Not a gate — the restore is idempotent and also repairs the model catalog
   * and resume history, so it stays offered when this is false. It exists so the
   * dashboard can say "nothing of ours is in there right now" instead of
   * implying a change that will not happen.
   */
  injected: boolean;
}

export interface QuickRestoreOutcome {
  ok: boolean;
  /** What actually happened, in the restoring code's own words. Never a prediction. */
  message: string;
  /**
   * One line per thing that genuinely changed. Empty means the tool was already
   * native, which is a success and is reported as one.
   */
  changed: string[];
}

/* ------------------------------------------------------------------ codex -- */

async function codexReadiness(): Promise<QuickRestoreReadiness> {
  const { getCodexConfigPath, stripOpencodexConfig } = await import("../codex/inject");
  const configPath = getCodexConfigPath();
  // The HOME, not the file: a Codex install that has never been launched has the
  // directory and no config.toml, and restoring there still has the catalog and
  // the resume history to put right.
  const codexHome = dirname(configPath);
  let injected = false;
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf8").replace(/\r\n/g, "\n");
      injected = stripOpencodexConfig(content) !== content;
    } catch {
      // Unreadable is not "not injected" — say nothing rather than say something false.
      injected = false;
    }
  }
  const available = existsSync(codexHome);
  return {
    tool: "codex",
    available,
    reason: available ? null : "tool-not-found",
    paths: [configPath],
    injected,
  };
}

async function restoreCodex(): Promise<QuickRestoreOutcome> {
  const { restoreNativeCodex } = await import("../codex/inject");
  // `restoreNativeCodex` is synchronous and touches the filesystem and a SQLite
  // history DB, so it can throw. This is the panic button: a throw here must
  // become a reported failure, never a 500 that tells the user nothing.
  try {
    const result = restoreNativeCodex();
    return {
      ok: result.success,
      message: result.message,
      changed: result.success ? [result.message] : [],
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      changed: [],
    };
  }
}

/* ----------------------------------------------------------------- claude -- */

const CLAUDE_AGENT_FILE = /^ocx-.*\.md$/;

/**
 * How many agent definitions in that directory are OURS.
 *
 * The name prefix is not the ownership test — a user is free to author their own
 * `ocx-something.md`, and the injector deliberately refuses to delete one. So
 * this asks the injector's own predicate rather than counting by filename, or a
 * prune that correctly left a user's file alone would be reported here as a
 * removal that failed.
 */
async function ownedAgentFileCount(agentsDir: string): Promise<number> {
  const { isOwnedFile } = await import("../claude/agents-inject");
  try {
    return readdirSync(agentsDir)
      .filter(name => CLAUDE_AGENT_FILE.test(name) && isOwnedFile(join(agentsDir, name)))
      .length;
  } catch {
    return 0;
  }
}

async function claudeReadiness(): Promise<QuickRestoreReadiness> {
  const { claudeConfigDir } = await import("../claude/gateway-cache");
  const { getShellEnvFilePath, getSystemEnvTrackingPath } = await import("../server/system-env");
  const configDir = claudeConfigDir();
  const agentsDir = join(configDir, "agents");
  const trackingPath = getSystemEnvTrackingPath();
  const paths = [agentsDir];
  // The macOS-only half. Listing it on Windows or Linux would name a file that
  // is never written there, which reads as a threat to delete something that
  // does not exist.
  if (process.platform === "darwin") paths.push(getShellEnvFilePath());
  const envInjected = existsSync(trackingPath);
  const available = existsSync(configDir) || envInjected;
  return {
    tool: "claude",
    available,
    reason: available ? null : "tool-not-found",
    paths,
    injected: (await ownedAgentFileCount(agentsDir)) > 0 || envInjected,
  };
}

async function restoreClaude(): Promise<QuickRestoreOutcome> {
  const { syncClaudeAgentDefs } = await import("../claude/agents-inject");
  const { claudeConfigDir } = await import("../claude/gateway-cache");
  const { revertSystemEnv, uninstallShellHook } = await import("../server/system-env");

  const agentsDir = join(claudeConfigDir(), "agents");
  const before = await ownedAgentFileCount(agentsDir);

  const changed: string[] = [];
  let ok = true;

  // Syncing an EMPTY definition list is the documented prune: it removes every
  // `ocx-*.md` that still carries our generated marker and leaves anything else —
  // including a user-authored file that merely happens to start with `ocx-` —
  // untouched. Reusing it keeps the ownership contract in one place rather than
  // reimplementing "which of these files are ours" here, where it would drift.
  let prunedOk = true;
  try {
    prunedOk = syncClaudeAgentDefs([], claudeConfigDir()) !== null;
  } catch {
    prunedOk = false;
  }
  const after = await ownedAgentFileCount(agentsDir);
  const removed = Math.max(0, before - after);
  if (!prunedOk || after > 0) {
    ok = false;
    changed.push(
      `Could not remove ${after} OpenCodex agent definition(s) from ${agentsDir}. `
      + "Delete the ocx-*.md files there by hand before starting a Claude Code session.",
    );
  } else if (removed > 0) {
    changed.push(`Removed ${removed} OpenCodex agent definition(s) from ${agentsDir}.`);
  }

  // The launchctl environment and the shell hook are macOS-only, and both report
  // their platform as a *reason* rather than as a failure. Treating "not macOS"
  // or "no tracking file" as an error would make every clean Windows restore
  // report a problem it does not have.
  try {
    const env = revertSystemEnv();
    if (env.reverted) changed.push("Reverted the Claude environment variables OpenCodex injected.");
    else if (env.reason && env.reason !== "not macOS" && env.reason !== "no tracking file") {
      ok = false;
      changed.push(`Could not revert the injected Claude environment variables: ${env.reason}.`);
    }
  } catch (err) {
    ok = false;
    changed.push(`Could not revert the injected Claude environment variables: ${err instanceof Error ? err.message : String(err)}.`);
  }

  try {
    const hook = uninstallShellHook();
    if (hook.removed) changed.push("Removed the OpenCodex shell hook from ~/.zshrc.");
    else if (hook.reason && hook.reason !== "not macOS" && hook.reason !== "not installed") {
      ok = false;
      changed.push(`Could not remove the OpenCodex shell hook: ${hook.reason}.`);
    }
  } catch (err) {
    ok = false;
    changed.push(`Could not remove the OpenCodex shell hook: ${err instanceof Error ? err.message : String(err)}.`);
  }

  const message = ok
    ? changed.length > 0
      ? changed.join(" ")
      : "Claude was already using its own configuration; nothing needed changing."
    : changed.join(" ");
  return { ok, message, changed };
}

/* ------------------------------------------------------------------- api -- */

/** What a quick restore of `tool` would touch, and whether it can run at all. */
export function describeQuickRestore(tool: QuickRestoreTool): Promise<QuickRestoreReadiness> {
  return tool === "codex" ? codexReadiness() : claudeReadiness();
}

/** Readiness for every tool, in a stable order the dashboard can render directly. */
export async function describeQuickRestoreAll(): Promise<QuickRestoreReadiness[]> {
  return Promise.all(QUICK_RESTORE_TOOLS.map(tool => describeQuickRestore(tool)));
}

/**
 * Put one tool's native configuration back. Idempotent, and never throws: every
 * failure comes back as `ok: false` with the reason, because a caller that has
 * already told the user "restoring…" needs an answer rather than an exception.
 */
export function restoreToolConfig(tool: QuickRestoreTool): Promise<QuickRestoreOutcome> {
  return tool === "codex" ? restoreCodex() : restoreClaude();
}

/**
 * Bound a best-effort side task so it cannot hold up the answer.
 *
 * Used for the history snapshot below. The snapshot is worth taking and worth
 * reporting, but it shells out to git — and a git that is hung on a lock is
 * exactly the kind of thing this whole feature exists to route around. Resolves
 * `false` on the deadline rather than rejecting; the caller reports that the
 * snapshot did not land, which is true and is all it can honestly say.
 */
export async function withDeadline(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How long the pre-restore history snapshot may take before it is abandoned. */
export const QUICK_RESTORE_SNAPSHOT_DEADLINE_MS = 5_000;
