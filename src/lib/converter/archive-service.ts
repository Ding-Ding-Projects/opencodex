/**
 * The filesystem-facing layer for ZIP extraction.
 *
 * Same shape `pdf-tools/service.ts` and `converter/service.ts` already
 * established: stat and bound before content is touched, hand the bytes to
 * the pure `extractZip`, then write the result atomically. A ZIP extracts to
 * *many* files rather than one, so "atomic" here means: every entry is
 * written into a staging directory that is a sibling of the real destination
 * (same parent, same filesystem), and only once every entry has landed there
 * does a single `renameAtomicFile` swap it into place. A failure at any point
 * before that rename — a write error, a disk-full condition — leaves the
 * destination exactly as it was, with only an orphaned, clearly-named
 * staging directory left to clean up, never a half-populated destination.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { renameAtomicFile } from "../../config";
import { MAX_ZIP_INPUT_BYTES } from "./bounds";
import { extractZip, type ExtractedZipEntry, type ZipExtractBoundary } from "./zip-extract";

export interface ReadZipSourceResult {
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

/** Bounded read: stat first, refuse before the content is ever touched if it is too large. */
export function readZipSourceFile(path: string): ReadZipSourceResult {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, error: "the source file could not be found" };
  }
  if (!stat.isFile()) return { ok: false, error: "the source path is not a regular file" };
  if (stat.size > MAX_ZIP_INPUT_BYTES) {
    return { ok: false, error: `the source is ${stat.size} bytes, over the ${MAX_ZIP_INPUT_BYTES} byte limit` };
  }
  try {
    return { ok: true, bytes: new Uint8Array(readFileSync(path)) };
  } catch {
    return { ok: false, error: "the source file could not be read" };
  }
}

/**
 * Write already-validated entries into a fresh staging directory.
 *
 * `extractZip` has already proven every `entry.path` safe via
 * `assertSafePath` (no `..`, no absolute path, no backslash, no drive
 * letter), so this function trusts that. The `resolve`/`relative` check here
 * is deliberate defense in depth against a bug in that proof, or in this
 * function's own path joining, rather than a second independent safety
 * boundary — and it is lexical only: the staging directory is created fresh
 * by this same call, so there is no pre-existing symlink at that path for a
 * naive `realpath` to have silently followed out from under the check (see
 * this codebase's own recorded pitfall about resolving destination symlinks
 * before inspecting them). No entry this module writes is ever itself a
 * symlink — an archive's external file attributes are never interpreted —
 * so there is nothing inside the staging directory to redirect a later entry
 * out of it either.
 */
function writeEntriesToStagingDir(stagingDir: string, entries: ExtractedZipEntry[]): void {
  mkdirSync(stagingDir, { recursive: true });
  const stagingRoot = resolve(stagingDir);
  for (const entry of entries) {
    const target = resolve(stagingDir, entry.path);
    const rel = relative(stagingRoot, target);
    if (rel === "" && entry.isDirectory) continue; // the root itself, already created
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new Error(`entry "${entry.path}" resolved outside the staging directory`);
    }
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }
  }
}

export interface ExtractZipAtPathResult {
  ok: boolean;
  destination?: string;
  entryCount?: number;
  bytesWritten?: number;
  boundary?: ZipExtractBoundary;
  error?: string;
}

/**
 * Read a ZIP source file, extract it, and write the result atomically into
 * `destDir`. Refuses to overwrite an existing path: extraction to an already-
 * occupied destination is refused outright rather than silently merging with
 * or clobbering whatever is already there.
 */
export function extractZipAtPath(sourcePath: string, destDir: string): ExtractZipAtPathResult {
  const source = readZipSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };

  const result = extractZip(source.bytes);
  if (!result.ok) return { ok: false, boundary: result.boundary, error: result.reason };

  if (existsSync(destDir)) {
    return { ok: false, error: "the destination already exists — extraction refuses to overwrite an existing file or directory" };
  }

  const parent = dirname(destDir);
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    return { ok: false, error: "the destination's parent directory could not be created" };
  }

  const staging = join(parent, `.convert-zip.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeEntriesToStagingDir(staging, result.entries);
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, error: (error as Error).message || "the archive could not be extracted to disk" };
  }

  try {
    renameAtomicFile(staging, destDir);
  } catch {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, error: "the extracted files could not be moved into place" };
  }

  const bytesWritten = result.entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  return { ok: true, destination: destDir, entryCount: result.entries.length, bytesWritten };
}
