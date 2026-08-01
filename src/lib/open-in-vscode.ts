/**
 * Handing an export to Visual Studio Code.
 *
 * An export that lands somewhere on disk and says nothing more has done half the
 * job: the user still has to find it, and "it's in your Downloads folder" is the
 * point at which a feature stops being useful. One action opens it where they
 * were going to open it anyway.
 *
 * Three things this is careful about, each of which is a way the obvious version
 * gets it wrong:
 *
 *  - **A folder opens as a workspace root**, not as a file. `code <dir>` already
 *    does this; the mistake is passing the first file inside it, which opens one
 *    file with no tree and looks like the folder failed to open.
 *  - **Never silently substitute another editor.** If VS Code is not installed,
 *    say so and offer the download. Opening whatever else is on the machine is a
 *    surprise, and on Windows the default handler for `.json` is as likely to be
 *    Notepad as anything.
 *  - **Never guess a path onto the command line.** The target is passed as an
 *    argv element with `shell: false`, so a folder called `a; rm -rf b` is a
 *    folder name and not two commands.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** The builds worth finding, best first. Insiders counts; so does a portable copy. */
export interface VsCodeCandidate {
  /** What to execute. Bare names resolve on PATH. */
  command: string;
  label: string;
}

function windowsCandidates(): VsCodeCandidate[] {
  const local = process.env.LOCALAPPDATA ?? "";
  const files = process.env.ProgramFiles ?? "C:\\Program Files";
  const files86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    { command: join(local, "Programs", "Microsoft VS Code", "bin", "code.cmd"), label: "Visual Studio Code" },
    { command: join(files, "Microsoft VS Code", "bin", "code.cmd"), label: "Visual Studio Code" },
    { command: join(files86, "Microsoft VS Code", "bin", "code.cmd"), label: "Visual Studio Code" },
    { command: join(local, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"), label: "Visual Studio Code Insiders" },
    { command: join(files, "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"), label: "Visual Studio Code Insiders" },
  ];
}

function unixCandidates(): VsCodeCandidate[] {
  return [
    { command: "/usr/local/bin/code", label: "Visual Studio Code" },
    { command: "/usr/bin/code", label: "Visual Studio Code" },
    { command: "/snap/bin/code", label: "Visual Studio Code" },
    { command: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", label: "Visual Studio Code" },
    { command: "/usr/local/bin/code-insiders", label: "Visual Studio Code Insiders" },
    { command: "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders", label: "Visual Studio Code Insiders" },
  ];
}

/**
 * Every place worth looking, in order.
 *
 * `code` on PATH comes first because it is what the user themselves installed and
 * chose to expose, and a portable or otherwise unusual install is reachable only
 * that way.
 */
export function vsCodeCandidates(platform: string = process.platform): VsCodeCandidate[] {
  const onPath: VsCodeCandidate[] = [
    { command: "code", label: "Visual Studio Code" },
    { command: "code-insiders", label: "Visual Studio Code Insiders" },
  ];
  return [...onPath, ...(platform === "win32" ? windowsCandidates() : unixCandidates())];
}

export interface VsCodeLookup {
  found: boolean;
  command?: string;
  label?: string;
  /** Shown when nothing was found — includes where to get it. */
  message?: string;
  downloadUrl?: string;
}

export const VSCODE_DOWNLOAD = "https://code.visualstudio.com/Download";

/**
 * Find VS Code.
 *
 * `pathProbe` decides whether a bare command resolves; it is injected so a test
 * can describe a machine without one rather than depending on the machine it
 * happens to run on.
 */
export function findVsCode(
  candidates: VsCodeCandidate[] = vsCodeCandidates(),
  pathProbe: (command: string) => boolean = () => false,
): VsCodeLookup {
  for (const candidate of candidates) {
    const absolute = candidate.command.includes("/") || candidate.command.includes("\\");
    const present = absolute ? existsSync(candidate.command) : pathProbe(candidate.command);
    if (present) return { found: true, command: candidate.command, label: candidate.label };
  }
  return {
    found: false,
    message: "Visual Studio Code was not found on this machine.",
    downloadUrl: VSCODE_DOWNLOAD,
  };
}

export interface OpenResult {
  ok: boolean;
  message: string;
  /** Present when the failure is "not installed", so the caller can offer it. */
  downloadUrl?: string;
}

/**
 * Open a file or folder in VS Code.
 *
 * A directory is opened as a workspace root; a file is opened as a file, in a
 * new window only when asked. Both go through argv with no shell, so nothing in
 * the path is ever interpreted.
 */
export function openInVsCode(
  target: string,
  options: { newWindow?: boolean; lookup?: VsCodeLookup } = {},
): Promise<OpenResult> {
  if (!existsSync(target)) {
    return Promise.resolve({ ok: false, message: `Nothing to open at ${target}.` });
  }
  const found = options.lookup ?? findVsCode();
  if (!found.found || !found.command) {
    return Promise.resolve({
      ok: false,
      message: found.message ?? "Visual Studio Code was not found on this machine.",
      downloadUrl: found.downloadUrl ?? VSCODE_DOWNLOAD,
    });
  }

  const args: string[] = [];
  if (options.newWindow) args.push("--new-window");
  // `--folder-uri` is not used: plain path arguments already open a directory as
  // a workspace root, and the URI form needs escaping this does not otherwise need.
  args.push(target);

  return new Promise(resolve => {
    const child = spawn(found.command!, args, { shell: false, windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", error => resolve({ ok: false, message: `Could not start ${found.label}: ${error.message}` }));
    child.on("spawn", () => {
      // Let it outlive us: VS Code keeps running after the export flow is done,
      // and an un-unref'd child would hold this process open behind it.
      child.unref();
      const kind = statSync(target).isDirectory() ? "folder" : "file";
      resolve({ ok: true, message: `Opened the ${kind} in ${found.label}.` });
    });
  });
}
