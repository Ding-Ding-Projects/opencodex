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
 * - The route sits behind the standard management-auth gate like every `/api/*`.
 *
 * **No console window is ever created.** Every spawn here passes
 * `windowsHide: true`, and a CLI target is handed to Windows Terminal — a real
 * windowed app the user asked for by clicking — rather than to `cmd.exe`, whose
 * console is exactly the popup that must never appear. When no terminal app is
 * installed, a CLI target reports that honestly instead of falling back to a
 * legacy console.
 *
 * The install-location candidates are best-effort and version-dependent, so
 * detection is the authority: if a real install lives somewhere not listed here,
 * add the path rather than inferring it from a product name.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

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
}

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

/** macOS bundles are directories; everything else must be a real file. */
function isLaunchable(path: string): boolean {
  if (path.endsWith(".app")) return existsSync(path);
  return isFile(path);
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
      if (isFile(candidate)) return candidate;
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

/** Every target with whether it is actually installed — drives the buttons' enabled state. */
export function listLaunchTargets(): LaunchTargetStatus[] {
  return CATALOG.map(spec => ({
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    available: resolveLaunchTarget(spec.id) !== null,
    installUrl: spec.installUrl,
  }));
}

function detach(command: string, args: string[]): { ok: boolean; error?: string } {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      // Never a console window — not for a desktop app, and not for a CLI either.
      windowsHide: true,
    });
    // ENOENT arrives asynchronously; without a listener it would take the proxy down.
    child.on("error", () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Terminal apps that own a real window, in preference order. Never `cmd.exe`. */
const TERMINALS: Partial<Record<"win32" | "darwin" | "linux", string[]>> = {
  win32: ["wt.exe"],
  linux: ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"],
};

/**
 * Open a CLI inside a terminal application.
 *
 * `cmd.exe` is deliberately not a fallback: its console is precisely the window
 * that must never pop up. Windows Terminal is a windowed app, so `wt.exe -- <cli>`
 * gives the user the session they clicked for without a console appearing
 * anywhere. With no terminal app installed there is nothing legitimate to draw
 * into, and that is reported rather than papered over.
 */
function launchCli(path: string): { ok: boolean; error?: string } {
  if (process.platform === "darwin") return detach("open", ["-a", "Terminal", path]);
  const terminal = findOnPath(TERMINALS[platformKey()] ?? []);
  if (!terminal) {
    return {
      ok: false,
      error: process.platform === "win32"
        ? "Windows Terminal (wt.exe) is not installed, and opencodex will not open a legacy console window. Install Windows Terminal to launch CLIs from here."
        : "no terminal application found to run the CLI in",
    };
  }
  // `--` ends wt's own option parsing, so the CLI path is never read as a flag.
  return detach(terminal, process.platform === "win32" ? ["--", path] : ["-e", path]);
}

function launchDesktop(path: string): { ok: boolean; error?: string } {
  // A macOS bundle is a directory: hand it to `open` rather than exec'ing it.
  if (path.endsWith(".app")) return detach("open", [path]);
  return detach(path, []);
}

export interface LaunchOutcome {
  ok: boolean;
  id?: string;
  label?: string;
  error?: string;
}

/**
 * Launch a catalog target by id. The id is the only thing a caller controls, and
 * it is matched against the catalog before anything is spawned.
 */
export function launchTarget(id: string): LaunchOutcome {
  const resolved = resolveLaunchTarget(id);
  if (!resolved) {
    const known = CATALOG.some(entry => entry.id === id);
    return { ok: false, error: known ? "not installed on this machine" : "unknown launch target" };
  }
  const { spec, path } = resolved;
  const result = spec.kind === "cli" ? launchCli(path) : launchDesktop(path);
  return result.ok
    ? { ok: true, id: spec.id, label: spec.label }
    : { ok: false, id: spec.id, label: spec.label, error: result.error };
}
