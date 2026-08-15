/**
 * Best-effort local check for whether an `ollama` executable exists on this
 * machine — used only to tell a real "missing" (never installed) apart from
 * a real "stopped" (installed, daemon not running) health state. Never used
 * to launch anything; that is out of scope for this lane (allowlisted
 * harness launch is a separate, later contract).
 *
 * Uses `Bun.spawn` rather than Node's `child_process.execFileSync` — see
 * `src/lib/windows-secret-acl.ts`'s `defaultIcaclsRunner` comment: the Node
 * sync form has hung under this app's GUI/proxy process on Windows even with
 * `windowsHide`, and this file follows the same async-with-manual-timeout
 * shape the rest of the codebase settled on for exactly that reason.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const PROBE_TIMEOUT_MS = 2_500;

export type ExecutableCheck = "found" | "not-found" | "unknown";

/** `null` means the probe command itself could not run at all — proves nothing about the target. */
async function runProbe(cmd: string[]): Promise<boolean | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already exited */ } }, PROBE_TIMEOUT_MS);
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch {
    exitCode = null;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return null;
  return exitCode === 0;
}

/** Common install locations this app can check directly, without spawning anything. */
function commonWindowsPaths(): string[] {
  const paths: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) paths.push(join(localAppData, "Programs", "Ollama", "ollama.exe"));
  const programFiles = process.env.ProgramFiles;
  if (programFiles) paths.push(join(programFiles, "Ollama", "ollama.exe"));
  return paths;
}

type ProbeRunner = (cmd: string[]) => Promise<boolean | null>;
type ExistsChecker = (path: string) => boolean;

let probeRunner: ProbeRunner = runProbe;
let existsChecker: ExistsChecker = existsSync;

/** Test seam: replace the subprocess probe. Pass null to restore the real `Bun.spawn`-backed default. */
export function setProbeRunnerForTests(runner: ProbeRunner | null): void {
  probeRunner = runner ?? runProbe;
}

/** Test seam: replace the filesystem existence check. Pass null to restore `node:fs`'s real `existsSync`. */
export function setExistsCheckerForTests(checker: ExistsChecker | null): void {
  existsChecker = checker ?? existsSync;
}

/**
 * Positive detection only: returns `"not-found"` only when every check
 * genuinely failed to find the executable, `"found"` as soon as one check
 * succeeds, and `"unknown"` when a check errored in a way that proves
 * nothing either way (so callers never report "missing" off an inconclusive
 * probe — see `client.ts`'s health-state selection).
 */
export async function detectOllamaExecutable(): Promise<ExecutableCheck> {
  for (const path of commonWindowsPaths()) {
    try {
      if (existsChecker(path)) return "found";
    } catch {
      // A filesystem error here proves nothing; keep checking the other paths/commands.
    }
  }
  const isWindows = process.platform === "win32";
  const probeOk = await probeRunner(isWindows ? ["where", "ollama"] : ["which", "ollama"]).catch(() => null);
  if (probeOk === true) return "found";
  if (probeOk === null) return "unknown"; // the lookup tool itself could not run — proves nothing
  return "not-found"; // a clean non-zero exit from where/which: the executable genuinely was not found
}
