/**
 * The filesystem-facing layer.
 *
 * Reads real files from disk (bounded before the bytes are touched), hands
 * them to the sandboxed operation, writes the result atomically, and proves
 * the write by reopening the file that actually landed — never the in-memory
 * bytes this process already produced. This is the one place both the HTTP
 * route (`src/server/management/pdf-routes.ts`) and the CLI (`src/cli/pdf.ts`)
 * call into, so a bug in the atomic-write or reopen-validation step cannot
 * exist on one surface and not the other — that identity is what makes the
 * headless parity real rather than a documented claim.
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameAtomicFile } from "../../config";
import { MAX_SOURCE_BYTES } from "./bounds";
import { validateAgainstExpectation } from "./operations";
import { runPdfOperationSandboxed } from "./sandbox";
import type {
  OperationOutput,
  PageRange,
  PageRotation,
  PdfBoundary,
  PdfInspectResult,
  PdfMetadataFields,
  PdfOperationRequest,
  PdfOperationResult,
} from "./types";

export type OperationRunner = (request: PdfOperationRequest) => Promise<PdfOperationResult>;

export interface PdfServiceOptions {
  /** Injectable so tests can run in-process instead of spinning up a worker per case. */
  run?: OperationRunner;
}

function runner(options: PdfServiceOptions): OperationRunner {
  return options.run ?? (request => runPdfOperationSandboxed(request));
}

// --------------------------------------------------------------------- reading

export interface ReadSourceResult {
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

/** Bounded read: stat first, refuse before the content is ever touched if it is too large. */
export function readSourceFile(path: string): ReadSourceResult {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, error: "the source file could not be found" };
  }
  if (!stat.isFile()) return { ok: false, error: "the source path is not a regular file" };
  if (stat.size > MAX_SOURCE_BYTES) {
    return { ok: false, error: `the source is ${stat.size} bytes, over the ${MAX_SOURCE_BYTES} byte limit` };
  }
  try {
    return { ok: true, bytes: new Uint8Array(readFileSync(path)) };
  } catch {
    return { ok: false, error: "the source file could not be read" };
  }
}

function readSources(paths: string[]): { ok: true; sources: Uint8Array[] } | { ok: false; error: string } {
  const sources: Uint8Array[] = [];
  for (const path of paths) {
    const read = readSourceFile(path);
    if (!read.ok || !read.bytes) return { ok: false, error: read.error ?? "a source could not be read" };
    sources.push(read.bytes);
  }
  return { ok: true, sources };
}

// --------------------------------------------------------------------- writing

export interface WriteResult {
  ok: boolean;
  path?: string;
  pageCount?: number;
  bytesWritten?: number;
  error?: string;
}

/**
 * Write one operation's output atomically (temp file, same directory, then
 * rename) and prove it by rereading the file that landed on disk. On any
 * mismatch — a truncated write, a bug in the operation, disk corruption — the
 * file is removed and the mismatch reported without the destination path or
 * document content in the message.
 */
export async function writeOperationOutputAtomically(destPath: string, output: OperationOutput): Promise<WriteResult> {
  const dir = dirname(destPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, error: "the destination directory could not be created" };
  }
  if (existsSync(destPath) && statSync(destPath).isDirectory()) {
    return { ok: false, error: "the destination is an existing directory" };
  }
  const tmp = join(dir, `.pdf-tools.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, output.bytes);
  } catch {
    return { ok: false, error: "the output could not be written" };
  }
  try {
    renameAtomicFile(tmp, destPath);
  } catch {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    return { ok: false, error: "the output could not be moved into place" };
  }

  // Load-bearing: reread from disk, never the buffer this process already held.
  let diskBytes: Uint8Array;
  try {
    diskBytes = new Uint8Array(readFileSync(destPath));
  } catch {
    return { ok: false, error: "the written file could not be reopened for validation" };
  }
  const validation = await validateAgainstExpectation(diskBytes, output.expected);
  if (!validation.ok) {
    try { unlinkSync(destPath); } catch { /* the mismatch is reported regardless of cleanup success */ }
    return { ok: false, error: validation.error ?? "the written file did not match the request" };
  }
  return { ok: true, path: destPath, pageCount: output.expected.pageCount, bytesWritten: diskBytes.byteLength };
}

// --------------------------------------------------------------------- operations

export interface PdfServiceError {
  ok: false;
  error: string;
  boundary?: PdfBoundary;
}

export async function inspectPdfAtPath(
  sourcePath: string,
  options: PdfServiceOptions = {},
): Promise<{ ok: true; result: PdfInspectResult } | PdfServiceError> {
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "inspect", source: source.bytes });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "inspect") return { ok: false, error: "unexpected operation result" };
  return { ok: true, result: result.result };
}

export async function readMetadataAtPath(
  sourcePath: string,
  options: PdfServiceOptions = {},
): Promise<{ ok: true; fields: PdfMetadataFields } | PdfServiceError> {
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "metadata-read", source: source.bytes });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "metadata-read") return { ok: false, error: "unexpected operation result" };
  return { ok: true, fields: result.result };
}

export async function writeMetadataAtPath(
  sourcePath: string,
  destPath: string,
  fields: PdfMetadataFields,
  acknowledgeSigned: boolean | undefined,
  options: PdfServiceOptions = {},
): Promise<WriteResult | PdfServiceError> {
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "metadata-write", source: source.bytes, fields, acknowledgeSigned });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "metadata-write") return { ok: false, error: "unexpected operation result" };
  return writeOperationOutputAtomically(destPath, result.result);
}

export async function rotatePagesAtPath(
  sourcePath: string,
  destPath: string,
  rotations: PageRotation[],
  acknowledgeSigned: boolean | undefined,
  options: PdfServiceOptions = {},
): Promise<WriteResult | PdfServiceError> {
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "rotate", source: source.bytes, rotations, acknowledgeSigned });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "rotate") return { ok: false, error: "unexpected operation result" };
  return writeOperationOutputAtomically(destPath, result.result);
}

export async function reorderPagesAtPath(
  sourcePath: string,
  destPath: string,
  order: number[],
  acknowledgeSigned: boolean | undefined,
  options: PdfServiceOptions = {},
): Promise<WriteResult | PdfServiceError> {
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "reorder", source: source.bytes, order, acknowledgeSigned });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "reorder") return { ok: false, error: "unexpected operation result" };
  return writeOperationOutputAtomically(destPath, result.result);
}

export async function extractPagesAtPath(
  sourcePath: string,
  destPath: string,
  pages: number[],
  acknowledgeSigned: boolean | undefined,
  options: PdfServiceOptions = {},
): Promise<WriteResult | PdfServiceError> {
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "extract", source: source.bytes, pages, acknowledgeSigned });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "extract") return { ok: false, error: "unexpected operation result" };
  return writeOperationOutputAtomically(destPath, result.result);
}

export async function mergePdfsAtPaths(
  sourcePaths: string[],
  destPath: string,
  acknowledgeSigned: boolean | undefined,
  options: PdfServiceOptions = {},
): Promise<WriteResult | PdfServiceError> {
  const sources = readSources(sourcePaths);
  if (!sources.ok) return { ok: false, error: sources.error };
  const result = await runner(options)({ op: "merge", sources: sources.sources, acknowledgeSigned });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "merge") return { ok: false, error: "unexpected operation result" };
  return writeOperationOutputAtomically(destPath, result.result);
}

/**
 * `destPaths` must have exactly one entry per range — explicit rather than an
 * invented naming convention, so there is nothing about output filenames for
 * this function to get subtly wrong.
 */
export async function splitPdfAtPath(
  sourcePath: string,
  ranges: PageRange[],
  destPaths: string[],
  acknowledgeSigned: boolean | undefined,
  options: PdfServiceOptions = {},
): Promise<{ ok: true; results: WriteResult[] } | PdfServiceError> {
  if (ranges.length !== destPaths.length) {
    return { ok: false, error: `${ranges.length} ranges but ${destPaths.length} destination paths were given` };
  }
  const source = readSourceFile(sourcePath);
  if (!source.ok || !source.bytes) return { ok: false, error: source.error ?? "the source could not be read" };
  const result = await runner(options)({ op: "split", source: source.bytes, ranges, acknowledgeSigned });
  if (!result.ok) return { ok: false, error: result.error, boundary: result.boundary };
  if (result.op !== "split") return { ok: false, error: "unexpected operation result" };

  const results: WriteResult[] = [];
  for (let i = 0; i < result.results.length; i++) {
    results.push(await writeOperationOutputAtomically(destPaths[i], result.results[i]));
  }
  return { ok: true, results };
}
