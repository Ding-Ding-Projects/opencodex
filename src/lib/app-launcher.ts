/**
 * One-press launching of the agent CLIs and their desktop apps (Codex, Grok,
 * Claude) from the dashboard.
 *
 * Security shape, because this starts local programs from an HTTP route that a
 * remote dashboard can reach:
 * - **Fixed catalog.** A request names a catalog `id`, never a path, never
 *   arguments. Nothing a caller sends is ever passed to a process, so there is
 *   no argument- or shell-injection surface at all.
 * - **Discovered, not assumed.** Executables are found by scanning `PATH` for an
 *   exact filename, or by probing a fixed list of install locations. A target
 *   that is not found is reported as unavailable rather than guessed at, so the
 *   dashboard can say "not installed" instead of failing on click.
 * - The route is part of the authenticated `/api/*` management plane. A caller
 *   still chooses only a fixed catalog id; supplied paths never reach process creation.
 *
 * **No console window is ever created.** Only windowed applications are ever
 * spawned: a CLI target is handed to Windows Terminal — a real windowed app the
 * user asked for by clicking — rather than to `cmd.exe`, whose console is
 * exactly the popup that must never appear, and a batch file is refused outright
 * because running one needs a console. When no terminal app is installed, a CLI
 * target reports that honestly instead of falling back to a legacy console.
 *
 * That refusal stands, but it is no longer a dead end: a failure carries a
 * machine-readable `reason` beside the sentence, so a caller can *offer* the
 * missing piece — `needs-windows-terminal` is what the dashboard turns into an
 * "install it" action — instead of printing a string and stopping there.
 *
 * The install-location candidates are best-effort and version-dependent, so
 * detection is the authority: if a real install lives somewhere not listed here,
 * add the path rather than inferring it from a product name.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { appExecutionAliasExists, commandInvocation } from "./win-exec.js";

export type LaunchKind = "cli" | "desktop";

interface LaunchTargetSpec {
  id: string;
  /** Product name, shown as-is; the GUI supplies the surrounding copy. */
  label: string;
  kind: LaunchKind;
  /** Exact filenames to look for on PATH (CLI targets). Order is preference. */
  pathNames?: Partial<Record<"win32" | "darwin" | "linux", string[]>>;
  /** Absolute candidates, `$VAR`-prefixed against process.env (desktop targets). */
  candidates?: Partial<Record<"win32" | "darwin" | "linux", string[]>>;
  /** Where to get it, when nothing is installed. */
  installUrl: string;
  /**
   * Infrastructure the launcher needs, rather than a product the user came here
   * to open. Support targets are resolvable and installable by id — that is the
   * whole point, it is how "install Windows Terminal" reuses the installer —
   * but they stay out of the Launch card's list of agent apps.
   */
  support?: boolean;
}

/**
 * The terminal a Windows CLI target is opened in, and an installable target in
 * its own right. Named once so the catalog entry, the terminal lookup and the
 * install recipe cannot drift apart.
 */
export const WINDOWS_TERMINAL_ID = "windows-terminal";

/**
 * Windows first: the desktop app is Windows-only today. macOS/Linux entries are
 * present where they are known rather than invented.
 */
const CATALOG: LaunchTargetSpec[] = [
  {
    id: "codex-cli",
    label: "Codex CLI",
    kind: "cli",
    pathNames: {
      win32: ["codex.exe", "codex.cmd", "codex.bat"],
      darwin: ["codex"],
      linux: ["codex"],
    },
    // Where the Windows installer actually puts it (verified on a real install).
    // A fallback, not the primary route: PATH is checked first, and this only
    // matters when the installer's shim is missing from it.
    candidates: {
      win32: ["$LOCALAPPDATA/Programs/OpenAI/Codex/bin/codex.exe"],
    },
    installUrl: "https://developers.openai.com/codex/cli",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    kind: "cli",
    pathNames: {
      win32: ["claude.exe", "claude.cmd", "claude.bat"],
      darwin: ["claude"],
      linux: ["claude"],
    },
    installUrl: "https://claude.com/claude-code",
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    kind: "cli",
    pathNames: {
      win32: ["grok.exe", "grok.cmd", "grok.bat"],
      darwin: ["grok"],
      linux: ["grok"],
    },
    installUrl: "https://github.com/superagent-ai/grok-cli",
  },
  {
    id: "chatgpt-desktop",
    label: "ChatGPT",
    kind: "desktop",
    candidates: {
      win32: [
        "$LOCALAPPDATA/Programs/ChatGPT/ChatGPT.exe",
        "$PROGRAMFILES/ChatGPT/ChatGPT.exe",
      ],
      darwin: ["/Applications/ChatGPT.app"],
    },
    installUrl: "https://openai.com/chatgpt/download/",
  },
  {
    id: "claude-desktop",
    label: "Claude",
    kind: "desktop",
    candidates: {
      win32: [
        "$LOCALAPPDATA/AnthropicClaude/claude.exe",
        "$LOCALAPPDATA/Programs/Claude/Claude.exe",
        "$PROGRAMFILES/Claude/Claude.exe",
      ],
      darwin: ["/Applications/Claude.app"],
    },
    installUrl: "https://claude.com/download",
  },
  {
    id: "grok-desktop",
    label: "Grok",
    kind: "desktop",
    candidates: {
      win32: [
        "$LOCALAPPDATA/Programs/Grok/Grok.exe",
        "$LOCALAPPDATA/Grok/Grok.exe",
        "$PROGRAMFILES/Grok/Grok.exe",
      ],
      darwin: ["/Applications/Grok.app"],
    },
    installUrl: "https://grok.com/download",
  },
  {
    // Not an agent app — the window every CLI target is drawn into. It is in the
    // catalog so the existing installer can install it by id, and so the same
    // resolution that finds `grok.cmd` is what re-probes for `wt.exe` afterwards.
    //
    // Windows 11 ships it; Windows 10 and trimmed or LTSC images do not, which
    // is the machine where "Open Grok CLI" used to dead-end.
    id: WINDOWS_TERMINAL_ID,
    label: "Windows Terminal",
    kind: "desktop",
    support: true,
    pathNames: { win32: ["wt.exe"] },
    // The MSIX alias, for a PATH that does not carry WindowsApps. It resolves
    // only because probing is alias-aware; a plain stat cannot see it.
    candidates: { win32: ["$LOCALAPPDATA/Microsoft/WindowsApps/wt.exe"] },
    // The GitHub release the winget package itself installs from, so this is a
    // page a user can actually download the same build off.
    installUrl: "https://github.com/microsoft/terminal/releases",
  },
];

export interface LaunchTargetStatus {
  id: string;
  label: string;
  kind: LaunchKind;
  available: boolean;
  /** Where to get it, shown when nothing is installed. Never a local path. */
  installUrl: string;
}

function platformKey(): "win32" | "darwin" | "linux" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Is there a program at `path`?
 *
 * `statSync` alone answers no for a Windows app execution alias — the zero-byte
 * reparse point an MSIX package leaves in `…\WindowsApps` — which is exactly how
 * Windows Terminal ships. Probing with stat only, the launcher told users with a
 * working `wt.exe` that Windows Terminal was not installed, and then refused to
 * open a CLI because of it. See `appExecutionAliasExists` in win-exec.
 */
function isProgram(path: string): boolean {
  return isFile(path) || appExecutionAliasExists(path);
}

/** macOS bundles are directories; everything else must be a real program. */
function isLaunchable(path: string): boolean {
  if (path.endsWith(".app")) return existsSync(path);
  return isProgram(path);
}

/**
 * Resolve a `$VAR/rest/of/path` candidate against the environment.
 *
 * Joined rather than string-substituted: the values that matter here are
 * directories like Program Files whose names contain spaces, and a substitution
 * that treated a space as "unset" would silently skip every one of them.
 */
function expand(candidate: string): string | null {
  const match = /^\$([A-Z_]+)(.*)$/.exec(candidate);
  if (!match) return candidate;
  const root = process.env[match[1]!]?.trim();
  if (!root) return null; // not set on this machine
  const rest = match[2]!.replace(/^[\\/]+/, "");
  return rest ? join(root, rest) : root;
}

/**
 * Find an exact filename on PATH. Deliberately a filesystem scan rather than a
 * `where`/`which` subprocess: cheaper, and it cannot be steered by a shell.
 */
function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).map(dir => dir.trim()).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (isProgram(candidate)) return candidate;
    }
  }
  return null;
}

/** The resolved program for a target, or null when it is not installed. */
export function resolveLaunchTarget(id: string): { spec: LaunchTargetSpec; path: string } | null {
  const spec = CATALOG.find(entry => entry.id === id);
  if (!spec) return null;
  const platform = platformKey();

  const names = spec.pathNames?.[platform];
  if (names?.length) {
    const found = findOnPath(names);
    if (found) return { spec, path: found };
  }

  for (const candidate of spec.candidates?.[platform] ?? []) {
    const expanded = expand(candidate);
    if (expanded && isLaunchable(expanded)) return { spec, path: expanded };
  }
  return null;
}

/**
 * The catalog's identity only — id, label and kind, with no filesystem probing.
 *
 * The installer needs to name a target it is about to install, which by
 * definition is not on disk yet, so `listLaunchTargets` (which reports
 * availability) would answer the wrong question.
 */
export function launchTargetIds(): { id: string; label: string; kind: LaunchKind }[] {
  return CATALOG.map(spec => ({ id: spec.id, label: spec.label, kind: spec.kind }));
}

/** The download page for a target, or null when the id is not in the catalog. */
export function launchTargetInstallUrl(id: string): string | null {
  return CATALOG.find(spec => spec.id === id)?.installUrl ?? null;
}

/**
 * Every *product* target with whether it is actually installed — drives the
 * buttons' enabled state. Support targets are omitted: the Launch card lists the
 * agent CLIs and their desktop apps, and a Windows Terminal row among them would
 * be an odd answer to "what can I open".
 */
export function listLaunchTargets(): LaunchTargetStatus[] {
  return CATALOG.filter(spec => !spec.support).map(spec => ({
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    available: resolveLaunchTarget(spec.id) !== null,
    installUrl: spec.installUrl,
  }));
}

/**
 * Why a launch did not happen, as something a caller can branch on.
 *
 * The sentence beside it is for the user; this is for the dashboard. Handing
 * back only prose meant every failure looked alike to the GUI, so the one that
 * has a fix a button could apply — no Windows Terminal — was printed in red and
 * left there.
 */
export type LaunchFailureReason =
  | "unknown-target"
  | "not-installed"
  | "needs-windows-terminal"
  | "no-terminal"
  | "console-refused"
  | "spawn-failed";

interface LaunchResult {
  ok: boolean;
  error?: string;
  reason?: LaunchFailureReason;
}

function detach(command: string, args: string[]): LaunchResult {
  // `.cmd`/`.bat` would be routed through `cmd.exe` by commandInvocation, and a
  // console — hidden or not — is the one thing this module promises never to
  // create. Nothing in the catalog spawns a batch file today (a CLI is passed to
  // the terminal as an argument, never spawned here), so this is a guard against
  // a future catalog entry quietly acquiring a console, not a live branch.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      ok: false,
      reason: "console-refused",
      error: `${command} is a batch file, which can only run inside a console window. opencodex will not open one.`,
    };
  }
  try {
    // Same hardened resolution the installer uses: it is what makes a Windows
    // app execution alias (`wt.exe` from the Store or winget) spawnable at all.
    const inv = commandInvocation(command, args);
    const child = spawn(inv.file, inv.args, {
      detached: true,
      stdio: "ignore",
      // Deliberately NOT `windowsHide`. That flag suppresses a console window,
      // but it also carries SW_HIDE into the child's startup info and hides its
      // *GUI* window — and the GUI window is the entire thing the user clicked
      // for. Measured: with it set, `wt.exe` launched, ran, owned no window at
      // all, and the click looked like a no-op.
      //
      // The no-console promise is kept by *what* is spawned, not by hiding it
      // afterwards: every target here is a windowed application, batch files are
      // refused above, and a CLI is passed to the terminal as an argument rather
      // than spawned. Adding a console-subsystem program to the catalog is what
      // would break it, which is why the catalog is fixed and reviewed.
      ...inv.options,
    });
    // ENOENT arrives asynchronously; without a listener it would take the proxy down.
    child.on("error", () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "spawn-failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Linux terminal apps that own a real window, in preference order.
 *
 * The other two platforms are not here on purpose: macOS goes through `open -a
 * Terminal`, and the Windows terminal is a catalog entry, so the program that
 * opens a CLI and the program "Get it" installs are one and the same.
 */
const LINUX_TERMINALS = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];

/**
 * Open a CLI inside a terminal application.
 *
 * `cmd.exe` is deliberately not a fallback: its console is precisely the window
 * that must never pop up. Windows Terminal is a windowed app, so `wt.exe -- <cli>`
 * gives the user the session they clicked for without a console appearing
 * anywhere. With no terminal app installed there is nothing legitimate to draw
 * into — so this reports *which* terminal is missing, in a form the caller can
 * act on, rather than papering over it or stopping at a sentence.
 */
function launchCli(path: string): LaunchResult {
  if (process.platform === "darwin") return detach("open", ["-a", "Terminal", path]);
  if (process.platform === "win32") {
    const terminal = resolveLaunchTarget(WINDOWS_TERMINAL_ID);
    if (!terminal) {
      return {
        ok: false,
        reason: "needs-windows-terminal",
        error: "Windows Terminal (wt.exe) is not installed, and opencodex will not open a legacy console window. Install Windows Terminal to launch CLIs from here.",
      };
    }
    // `--` ends wt's own option parsing, so the CLI path is never read as a flag.
    return detach(terminal.path, ["--", path]);
  }
  // darwin and win32 already returned, so this is Linux.
  const terminal = findOnPath(LINUX_TERMINALS);
  if (!terminal) {
    return { ok: false, reason: "no-terminal", error: "no terminal application found to run the CLI in" };
  }
  return detach(terminal, ["-e", path]);
}

function launchDesktop(path: string): LaunchResult {
  // A macOS bundle is a directory: hand it to `open` rather than exec'ing it.
  if (path.endsWith(".app")) return detach("open", [path]);
  return detach(path, []);
}

export interface LaunchOutcome {
  ok: boolean;
  id?: string;
  label?: string;
  error?: string;
  /** Present on every failure; see LaunchFailureReason. */
  reason?: LaunchFailureReason;
}

/**
 * Launch a catalog target by id. The id is the only thing a caller controls, and
 * it is matched against the catalog before anything is spawned.
 */
export function launchTarget(id: string): LaunchOutcome {
  const resolved = resolveLaunchTarget(id);
  if (!resolved) {
    const known = CATALOG.some(entry => entry.id === id);
    return known
      ? { ok: false, id, reason: "not-installed", error: "not installed on this machine" }
      : { ok: false, reason: "unknown-target", error: "unknown launch target" };
  }
  const { spec, path } = resolved;
  const result = spec.kind === "cli" ? launchCli(path) : launchDesktop(path);
  return result.ok
    ? { ok: true, id: spec.id, label: spec.label }
    : { ok: false, id: spec.id, label: spec.label, error: result.error, reason: result.reason };
}
