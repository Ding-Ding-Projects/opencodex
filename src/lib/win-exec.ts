/**
 * Cross-platform command launching (devlog 260715_cross_platform_audit/020).
 *
 * Windows npm installs expose CLIs as `.cmd` shims, and Node/Bun refuse shell-less
 * `.cmd` spawns (CVE-2024-27980 hardening). Bare names like `spawn("claude")` also
 * skip PATHEXT resolution entirely, so they ENOENT even when `claude.cmd` is on PATH.
 * This module mirrors the battle-tested cross-spawn approach: resolve the real target
 * via PATH×PATHEXT, launch `.exe` targets directly (argument boundaries preserved by
 * the normal shell-less spawn), and route `.cmd`/`.bat` targets through
 * `cmd.exe /d /s /c "<escaped line>"` with `windowsVerbatimArguments: true`.
 *
 * A fourth case joined those three: Windows **app execution aliases**. See
 * `appExecutionAliasExists` — they are the reason `winget` was never actually
 * reachable from the Bun proxy.
 */
import { existsSync, readdirSync } from "node:fs";
import { win32 } from "node:path";

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** cross-spawn parse.js: only npm local-bin shims get double escaping. */
const IS_CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

/** cross-spawn escape.js argument(): quote + escape one argument for cmd.exe /d /s /c. */
export function escapeCmdArg(arg: string, doubleEscape = false): string {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  return doubleEscape ? out.replace(CMD_META, "^$1") : out;
}

/** cross-spawn escape.js command(): escape the command token itself (no quoting). */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

export interface ResolveDeps {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  /** Overrides the app-execution-alias probe; see `appExecutionAliasExists`. */
  aliasExists?: (path: string) => boolean;
}

/**
 * The single directory Windows puts app execution aliases in. Scoping the probe
 * to it is what keeps this cheap: the fallback below reads a directory, and
 * doing that for every PATH miss would mean enumerating System32 (thousands of
 * entries) on every unresolved command.
 */
const ALIAS_DIR_NAME = "windowsapps";

/**
 * Does `path` name a Windows app execution alias?
 *
 * MSIX packages (winget, Windows Terminal, the Store Python, WSL…) expose their
 * executables as zero-byte `AppExecLink` reparse points under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`. They are on PATH and CreateProcess
 * follows them, but they are **not** files in any sense `stat` recognises:
 * measured on Windows 11 with Bun 1.3.14, `existsSync` returns false and
 * `statSync` throws EACCES or ENOENT for `…\WindowsApps\winget.exe` while
 * `readdirSync` lists the very same name.
 *
 * That silent blindness is worth spelling out because of what it cost: every
 * "is winget installed" probe in this repo answered *no* on a machine where
 * `winget --version` works from any shell, so the winget install routes were
 * unreachable rather than broken — no error, just a button that quietly offered
 * a download page instead.
 *
 * A directory listing is the only probe that sees them, so that is what this
 * does. Name comparison is case-insensitive because the filesystem is.
 */
export function appExecutionAliasExists(
  path: string,
  readdir: (dir: string) => string[] = readdirSync,
): boolean {
  const dir = win32.dirname(path);
  if (win32.basename(dir).toLowerCase() !== ALIAS_DIR_NAME) return false;
  const name = win32.basename(path).toLowerCase();
  try {
    return readdir(dir).some(entry => entry.toLowerCase() === name);
  } catch {
    // An unreadable or absent directory is simply not an alias directory.
    return false;
  }
}

function aliasProbe(deps: ResolveDeps): (path: string) => boolean {
  return deps.aliasExists ?? (path => appExecutionAliasExists(path));
}

/**
 * Resolve a bare command name to its first PATH×PATHEXT hit (win32 semantics).
 * Commands that already carry an extension, a separator, or an absolute prefix are
 * returned unchanged; unresolvable names fall back unchanged (spawn will surface it).
 */
export function resolveWindowsCommand(command: string, deps: ResolveDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const isAlias = aliasProbe(deps);
  if (win32.extname(command) || command.includes("\\") || command.includes("/") || win32.isAbsolute(command)) {
    return command;
  }
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(win32.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = win32.join(dir, command + ext.toLowerCase());
      // `exists` first: it is a single stat, and it answers for every ordinary
      // program. The listing probe only runs for the one directory that can
      // hold an alias, and only after the cheap answer came back no.
      if (exists(candidate) || isAlias(candidate)) return candidate;
    }
  }
  return command;
}

export interface SpawnInvocation {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean; cwd?: string };
}

/**
 * Platform-safe invocation preserving argument boundaries (cross-spawn parse.js).
 * POSIX: passthrough. win32 `.exe`: resolved direct spawn. win32 `.cmd`/`.bat`:
 * `ComSpec /d /s /c "<escaped command line>"` with verbatim args; npm local-bin
 * shims get cross-spawn's double escaping, all other batch targets single.
 * win32 app execution alias: spawned as `./name.exe` from its own directory —
 * see below, and note that this stays a shell-less spawn like every other case.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  deps: ResolveDeps = {},
): SpawnInvocation {
  if (platform !== "win32") return { file: command, args: [...args], options: {} };
  const resolved = resolveWindowsCommand(command, deps);
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    const exists = deps.exists ?? existsSync;
    // An alias is stat-invisible (see appExecutionAliasExists), and Bun refuses
    // to spawn what it cannot stat: `spawn("C:\…\WindowsApps\winget.exe")`
    // fails ENOENT under Bun even though CreateProcess would have followed the
    // link, and so does the bare name. A path with no separators is handed
    // straight to CreateProcess without that pre-check, so the same file
    // launches fine as `./winget.exe` with cwd set to its directory — verified
    // on Bun 1.3.14 and Node 26 alike.
    //
    // `cwd` is a resolution device only. The directory comes from PATH and the
    // filename from a constant, so nothing here widens what can be spawned.
    if (!exists(resolved) && aliasProbe(deps)(resolved)) {
      return {
        file: `./${win32.basename(resolved)}`,
        args: [...args],
        options: { cwd: win32.dirname(resolved) },
      };
    }
    return { file: resolved, args: [...args], options: {} };
  }
  const env = deps.env ?? process.env;
  const doubleEscape = IS_CMD_SHIM.test(resolved);
  const line = [escapeCmdCommand(resolved), ...args.map(a => escapeCmdArg(a, doubleEscape))].join(" ");
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * `sh -c <command>` analog per platform. The configured command string is passed
 * VERBATIM in content; on win32 it gets the outer quotes `/s` requires, so
 * `"C:\Program Files\x.exe" --json` runs as `cmd.exe /d /s /c ""C:\Program Files\x.exe" --json"`.
 * Contract: the command is platform-native shell syntax (sh on POSIX, CMD on Windows).
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): SpawnInvocation {
  if (platform !== "win32") return { file: "sh", args: ["-c", command], options: {} };
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    options: { windowsVerbatimArguments: true },
  };
}
