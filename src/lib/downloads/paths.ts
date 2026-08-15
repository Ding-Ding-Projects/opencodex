/**
 * Filename and destination-path handling for captured downloads.
 *
 * A suggested filename comes from two untrusted sources — the page the user
 * downloaded from, and the browser's own `onDeterminingFilename` guess — so it
 * is sanitized before it ever touches the filesystem: no path separators, no
 * `..` segments, no reserved Windows device names, and a bounded length.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { MAX_FILENAME_LENGTH } from "./bounds";

/** Windows reserved device names — a file literally named `CON` or `NUL.txt` cannot be created at all. */
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Reduce an arbitrary suggested name to one safe path segment.
 *
 * `basename` first strips any directory component a hostile or merely sloppy
 * page URL tried to smuggle in (`../../etc/passwd`, `C:\Windows\system.ini`),
 * then every character Windows or a shell could read specially is replaced
 * with `_`. A name that sanitizes to nothing (all-separators, empty, purely a
 * reserved device name) falls back to `download`.
 */
export function sanitizeFilename(raw: string): string {
  const base = basename(raw.trim().replace(/[/\\]+$/, "")) || "download";
  let cleaned = base
    // Control characters, and every character Windows forbids in a filename.
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // Windows does not allow a trailing dot or space.
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") cleaned = "download";
  const stem = cleaned.replace(/\.[^.]*$/, "");
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) cleaned = `_${cleaned}`;
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    const ext = extname(cleaned).slice(0, 20);
    cleaned = `${cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length)}${ext}`;
  }
  return cleaned;
}

/** The platform's ordinary Downloads folder, created if this is the first download opencodex has ever written there. */
export function defaultDownloadsDir(): string {
  const dir = join(homedir(), "Downloads");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // Fall through with the path anyway; the caller's write will surface the
    // real error (permissions, a missing drive) with better context than this
    // best-effort mkdir could.
  }
  return dir;
}

/**
 * `name.ext`, `name (1).ext`, `name (2).ext`, … — the same convention every
 * desktop download manager uses, so a second capture of the same filename
 * never silently overwrites the first.
 */
export function uniqueDestinationPath(dir: string, filename: string, exists: (path: string) => boolean = existsSync): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let candidate = join(dir, filename);
  let n = 1;
  while (exists(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}
