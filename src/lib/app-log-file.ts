/**
 * The app's own log, on disk, in plain text.
 *
 * Everything the proxy diagnosed used to live in a 2 000-line in-memory ring
 * (`debug-log-buffer.ts`) and the dashboard's Debug tab. That is fine while the
 * process is up and useless the moment it is not: the crash that needs
 * explaining takes its own explanation with it, and "open the log file" — the
 * first thing anyone asks — had no answer. This writes the same lines to
 *
 *     <config dir>/logs/opencodex.log
 *
 * so they survive a restart and can be read with Notepad, `tail`, or anything
 * else, without the dashboard running at all.
 *
 * **Where.** Inside the app's own data directory (`~/.opencodex`, or
 * `OPENCODEX_HOME`). Never inside a user's project folder — a proxy that
 * scatters log files through the directories it is asked about is a proxy
 * nobody trusts with a repository.
 *
 * **Retention is a hard cap, not a hope.** The current file rotates at
 * {@link MAX_LOG_BYTES} and {@link MAX_ROTATED_FILES} generations are kept, so
 * the whole log directory cannot exceed {@link MAX_TOTAL_BYTES} no matter how
 * long the proxy runs or how loud the provider is. The oldest generation is
 * deleted by rotation; nothing else prunes, so the bound is arithmetic rather
 * than a background job that might not run.
 *
 * **Never fatal.** Every write is best-effort and every failure is swallowed. A
 * full disk, a locked file, a read-only directory — a request must not fail
 * because its diagnostics could not be recorded. The lines still reach the
 * in-memory ring and the console either way.
 */

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, openSync, closeSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "./config-ownership";

/** Directory name under the config dir. Relative, because git tracks it by that name. */
export const APP_LOG_DIR_NAME = "logs";
/** The live file. Rotated generations are this name plus `.1`, `.2`, … */
export const APP_LOG_FILE_NAME = "opencodex.log";

/** Rotate once the live file passes this. 2 MiB is ~10 000 typical lines. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** How many rotated generations survive. The oldest is deleted, not archived. */
export const MAX_ROTATED_FILES = 3;
/** The arithmetic ceiling for the whole log directory. Documented; also asserted in tests. */
export const MAX_TOTAL_BYTES = MAX_LOG_BYTES * (MAX_ROTATED_FILES + 1);

export function appLogDir(configDir: string = getConfigDir()): string {
  return join(configDir, APP_LOG_DIR_NAME);
}

export function appLogPath(configDir: string = getConfigDir()): string {
  return join(appLogDir(configDir), APP_LOG_FILE_NAME);
}

/**
 * Every log file that exists right now, newest generation first.
 *
 * Read from the directory rather than generated from a counter: a generation
 * left behind by an older build, or removed by hand, must not make the list
 * lie about what is on disk — the delete path uses this to decide what it is
 * about to destroy.
 */
export function listAppLogFiles(configDir: string = getConfigDir()): string[] {
  const dir = appLogDir(configDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(name => name === APP_LOG_FILE_NAME || name.startsWith(`${APP_LOG_FILE_NAME}.`))
      .sort((a, b) => generationOf(a) - generationOf(b))
      .map(name => join(dir, name));
  } catch {
    return [];
  }
}

/** `opencodex.log` is generation 0, `opencodex.log.2` is generation 2. */
function generationOf(name: string): number {
  const suffix = name.slice(APP_LOG_FILE_NAME.length + 1);
  const n = Number.parseInt(suffix, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Config dirs whose log directory has already been created and claimed.
 *
 * Without this, every logged line pays a `recordOwnedConfigPath` + `mkdir` +
 * `chmod`. Debug logging is per-frame on a streaming adapter, so that is three
 * syscalls on a hot path to re-establish something that was already true.
 * Cleared whenever a write actually fails, so a directory deleted underneath a
 * running proxy is recreated rather than assumed forever.
 */
const preparedDirs = new Set<string>();

function ensureLogDir(configDir: string): string {
  const dir = appLogDir(configDir);
  if (preparedDirs.has(dir)) return dir;
  // The uninstaller only removes paths this proxy claims. An unclaimed log
  // directory is litter left on the machine after `ocx uninstall`.
  recordOwnedConfigPath(configDir, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* platforms that ignore chmod */ }
  preparedDirs.add(dir);
  return dir;
}

/**
 * Shift `opencodex.log` → `.1` → `.2` → … and drop whatever falls off the end.
 *
 * Renames run oldest-first so no generation is ever overwritten by the one
 * behind it. A rename that fails leaves the live file where it is: continuing
 * to append past the cap is a far smaller problem than losing a generation.
 */
function rotate(dir: string): void {
  const live = join(dir, APP_LOG_FILE_NAME);
  try {
    const oldest = join(dir, `${APP_LOG_FILE_NAME}.${MAX_ROTATED_FILES}`);
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let generation = MAX_ROTATED_FILES - 1; generation >= 1; generation--) {
      const from = join(dir, `${APP_LOG_FILE_NAME}.${generation}`);
      if (existsSync(from)) renameSync(from, join(dir, `${APP_LOG_FILE_NAME}.${generation + 1}`));
    }
    if (existsSync(live)) renameSync(live, join(dir, `${APP_LOG_FILE_NAME}.1`));
  } catch {
    /* a failed rotation must not stop the line being written */
  }
}

/**
 * Append one line, timestamped, rotating first if the live file is already at
 * the cap. The caller passes the line exactly as the in-memory ring holds it,
 * so the file and the Debug tab never disagree about what was logged.
 */
export function appendAppLogLine(line: string, configDir: string = getConfigDir()): void {
  let dir = "";
  try {
    dir = ensureLogDir(configDir);
    const path = join(dir, APP_LOG_FILE_NAME);
    // Checked before the write, not after: a single line cannot push the file
    // arbitrarily past the cap, because the next write rotates it.
    if (existsSync(path) && statSync(path).size >= MAX_LOG_BYTES) rotate(dir);
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* platforms that ignore chmod */ }
  } catch {
    // Logging must never fail the thing being logged about — but a write that
    // failed is also the one signal that the memoized directory may be gone, so
    // the next line re-creates it instead of failing forever in the same way.
    if (dir) preparedDirs.delete(dir);
    else preparedDirs.delete(appLogDir(configDir));
  }
}

/** One stored line, as it is read back for the dashboard's Debug tab. */
export interface AppLogLine {
  at: number;
  line: string;
}

const TIMESTAMPED = /^(\S+)\s([\s\S]*)$/;

function parseLine(raw: string): AppLogLine | null {
  if (!raw.trim()) return null;
  const match = TIMESTAMPED.exec(raw);
  const at = match ? Date.parse(match[1]) : Number.NaN;
  // A line written by something else, or truncated mid-rotation, is still worth
  // showing — it just has no trustworthy time, and 0 sorts it to the top of the
  // tail rather than poisoning a comparator with NaN.
  if (!match || !Number.isFinite(at)) return { at: 0, line: raw };
  return { at, line: match[2] };
}

/**
 * The newest `limit` lines across generations, oldest first.
 *
 * Walks generations NEWEST first and stops as soon as it has enough, so a proxy
 * with a full 8 MiB log directory does not read and parse all of it at startup
 * to show the last two thousand lines. The result is reversed back into
 * chronological order at the end, because that is the order a log is read in.
 */
export function readAppLogTail(limit: number, configDir: string = getConfigDir()): AppLogLine[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const newestFirst: AppLogLine[] = [];
  for (const path of listAppLogFiles(configDir)) {
    if (newestFirst.length >= limit) break;
    try {
      const parsed = readFileSync(path, "utf-8").split(/\r?\n/)
        .map(parseLine)
        .filter((entry): entry is AppLogLine => entry !== null);
      // This generation's own lines are oldest-first; reverse so the whole
      // accumulator stays newest-first and the early exit above is correct.
      for (let i = parsed.length - 1; i >= 0 && newestFirst.length < limit; i--) {
        newestFirst.push(parsed[i]);
      }
    } catch {
      /* an unreadable generation must not hide the readable ones */
    }
  }
  return newestFirst.reverse();
}

/** What a clear is about to destroy, so the confirmation can name it exactly. */
export interface AppLogFootprint {
  files: number;
  lines: number;
  bytes: number;
}

export function measureAppLogFiles(configDir: string = getConfigDir()): AppLogFootprint {
  let files = 0;
  let lines = 0;
  let bytes = 0;
  for (const path of listAppLogFiles(configDir)) {
    try {
      const text = readFileSync(path, "utf-8");
      files += 1;
      bytes += Buffer.byteLength(text, "utf-8");
      lines += text.split(/\r?\n/).filter(line => line.trim()).length;
    } catch {
      /* counted only when actually read — an over-count would lie to the dialog */
    }
  }
  return { files, lines, bytes };
}

/**
 * Delete every log generation.
 *
 * Callers must have snapshotted first — see `recordLogSnapshotBeforeDelete` in
 * `state-history.ts`. This function deliberately knows nothing about that: it is
 * the destructive half, and keeping it dumb means the ordering is visible at the
 * one call site that matters rather than hidden in here.
 */
export function clearAppLogFiles(configDir: string = getConfigDir()): AppLogFootprint {
  const footprint = measureAppLogFiles(configDir);
  for (const path of listAppLogFiles(configDir)) {
    try { rmSync(path, { force: true }); } catch { /* a locked file stays; the rest still go */ }
  }
  return footprint;
}

/**
 * Create the log file if it does not exist yet, so `logs/opencodex.log` is a
 * real path a user can open before the proxy has had anything to say. Returns
 * the path either way.
 */
export function ensureAppLogFile(configDir: string = getConfigDir()): string {
  const path = appLogPath(configDir);
  try {
    ensureLogDir(configDir);
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  } catch {
    /* best-effort: the first appendAppLogLine will try again */
  }
  return path;
}
