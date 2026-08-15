/**
 * The filesystem-facing layer for structured-data conversions (JSON, CSV,
 * TSV, XML).
 *
 * Same shape as `pdf-tools/service.ts` and `archive-service.ts`: bound before
 * content is touched, parse the source into a plain JSON value, serialize it
 * into the target format, then write atomically and reopen to prove the
 * write actually landed — never trust the in-memory bytes this process just
 * produced.
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameAtomicFile } from "../../config";
import {
  MAX_STRUCTURED_DEPTH,
  MAX_STRUCTURED_INPUT_BYTES,
  MAX_STRUCTURED_OUTPUT_BYTES,
} from "./bounds";
import { delimitedToJson, jsonToDelimited, type DelimitedKind } from "./delimited";
import { jsonToXml, xmlToJson } from "./xml-convert";

export type StructuredFormat = "json" | "csv" | "tsv" | "xml";

export interface StructuredConversionOutcome {
  ok: boolean;
  path?: string;
  bytesWritten?: number;
  lossy?: boolean;
  notes?: string[];
  boundary?: string;
  error?: string;
}

// --------------------------------------------------------------------- reading

interface ReadTextResult {
  ok: boolean;
  text?: string;
  error?: string;
}

function readSourceText(path: string): ReadTextResult {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, error: "the source file could not be found" };
  }
  if (!stat.isFile()) return { ok: false, error: "the source path is not a regular file" };
  if (stat.size > MAX_STRUCTURED_INPUT_BYTES) {
    return { ok: false, error: `the source is ${stat.size} bytes, over the ${MAX_STRUCTURED_INPUT_BYTES} byte limit` };
  }
  try {
    return { ok: true, text: readFileSync(path, "utf-8") };
  } catch {
    return { ok: false, error: "the source file could not be read" };
  }
}

// --------------------------------------------------------------------- JSON parsing

function checkDepth(value: unknown, depth: number): { ok: true } | { ok: false; reason: string } {
  if (depth > MAX_STRUCTURED_DEPTH) return { ok: false, reason: `the JSON value nests more than ${MAX_STRUCTURED_DEPTH} levels deep` };
  if (value === null || typeof value !== "object") return { ok: true };
  if (Array.isArray(value)) {
    for (const item of value) {
      const inner = checkDepth(item, depth + 1);
      if (!inner.ok) return inner;
    }
    return { ok: true };
  }
  for (const key of Object.keys(value as object)) {
    const inner = checkDepth((value as Record<string, unknown>)[key], depth + 1);
    if (!inner.ok) return inner;
  }
  return { ok: true };
}

/**
 * A JSON.parse that is bounded on input size and on the resulting value's
 * depth. `RangeError` (a call-stack overflow, either inside `JSON.parse`
 * itself on pathologically deep input, or inside this function's own depth
 * walk) is caught explicitly and reported as a clean, bounded refusal rather
 * than an uncontrolled crash — the depth check above is the real defense and
 * fires at 64 levels, long before any real stack limit; this catch is
 * insurance against a bug in that check, not the primary bound.
 */
function parseBoundedJson(text: string): { ok: true; value: unknown } | { ok: false; boundary: "too-large" | "malformed"; reason: string } {
  if (text.length > MAX_STRUCTURED_INPUT_BYTES) {
    return { ok: false, boundary: "too-large", reason: `the input is ${text.length} characters, over the ${MAX_STRUCTURED_INPUT_BYTES} character limit` };
  }
  try {
    const value: unknown = JSON.parse(text);
    const depth = checkDepth(value, 0);
    if (!depth.ok) return { ok: false, boundary: "malformed", reason: depth.reason };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof RangeError) {
      return { ok: false, boundary: "malformed", reason: "the JSON value is nested too deeply to parse safely" };
    }
    return { ok: false, boundary: "malformed", reason: `the input is not valid JSON: ${(error as Error).message}` };
  }
}

// --------------------------------------------------------------------- parse (source -> JSON value)

function delimitedKindOf(format: StructuredFormat): DelimitedKind | null {
  return format === "csv" ? "csv" : format === "tsv" ? "tsv" : null;
}

function parseToJsonValue(text: string, format: StructuredFormat): { ok: true; value: unknown } | { ok: false; boundary: string; reason: string } {
  const delimitedKind = delimitedKindOf(format);
  if (delimitedKind) {
    const parsed = delimitedToJson(text, delimitedKind);
    if (!parsed.ok) return { ok: false, boundary: parsed.boundary, reason: parsed.reason };
    return { ok: true, value: parsed.value };
  }
  if (format === "xml") {
    const parsed = xmlToJson(text);
    if (!parsed.ok) return { ok: false, boundary: parsed.boundary, reason: parsed.reason };
    return { ok: true, value: parsed.value };
  }
  return parseBoundedJson(text);
}

// --------------------------------------------------------------------- serialize (JSON value -> target text)

interface SerializedText {
  ok: boolean;
  text?: string;
  lossy?: boolean;
  notes?: string[];
  error?: string;
}

function serializeFromJsonValue(value: unknown, format: StructuredFormat): SerializedText {
  const delimitedKind = delimitedKindOf(format);
  if (delimitedKind) {
    const result = jsonToDelimited(value, delimitedKind);
    if (!result.ok) return { ok: false, error: result.reason };
    return { ok: true, text: result.text, lossy: result.lossy, notes: result.notes };
  }
  if (format === "xml") {
    const result = jsonToXml(value);
    if (!result.ok) return { ok: false, error: result.reason };
    return { ok: true, text: result.text, lossy: result.lossy, notes: result.notes };
  }
  try {
    return { ok: true, text: JSON.stringify(value, null, 2), lossy: false };
  } catch (error) {
    return { ok: false, error: `the value could not be serialized to JSON: ${(error as Error).message}` };
  }
}

// --------------------------------------------------------------------- write

function writeTextAtomically(destPath: string, text: string): { ok: true; bytesWritten: number } | { ok: false; error: string } {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.byteLength > MAX_STRUCTURED_OUTPUT_BYTES) {
    return { ok: false, error: `the output would be ${bytes.byteLength} bytes, over the ${MAX_STRUCTURED_OUTPUT_BYTES} byte limit — refused rather than written` };
  }
  const dir = dirname(destPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, error: "the destination directory could not be created" };
  }
  if (existsSync(destPath) && statSync(destPath).isDirectory()) {
    return { ok: false, error: "the destination is an existing directory" };
  }
  const tmp = join(dir, `.convert-structured.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, bytes);
  } catch {
    return { ok: false, error: "the output could not be written" };
  }
  try {
    renameAtomicFile(tmp, destPath);
  } catch {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    return { ok: false, error: "the output could not be moved into place" };
  }

  // Load-bearing: reread from disk, never the buffer this process already held.
  let diskBytes: Buffer;
  try {
    diskBytes = readFileSync(destPath);
  } catch {
    return { ok: false, error: "the written file could not be reopened for validation" };
  }
  if (!diskBytes.equals(bytes)) {
    try { unlinkSync(destPath); } catch { /* the mismatch is reported regardless of cleanup success */ }
    return { ok: false, error: "the written file did not match the produced output and was removed" };
  }
  return { ok: true, bytesWritten: diskBytes.byteLength };
}

// --------------------------------------------------------------------- the public entry point

/**
 * Read `sourcePath` as `sourceFormat`, convert to `destFormat`, and write the
 * result to `destPath` atomically. Every lossy or metadata-changing step is
 * disclosed in the returned `notes` — the caller is expected to have shown
 * that disclosure and gotten the user's go-ahead before this runs, exactly
 * as the PDF family requires `acknowledgeSigned` before a mutating write.
 */
export function convertStructuredDataAtPath(
  sourcePath: string,
  sourceFormat: StructuredFormat,
  destPath: string,
  destFormat: StructuredFormat,
): StructuredConversionOutcome {
  const source = readSourceText(sourcePath);
  if (!source.ok || source.text === undefined) return { ok: false, error: source.error ?? "the source could not be read" };

  const parsed = parseToJsonValue(source.text, sourceFormat);
  if (!parsed.ok) return { ok: false, boundary: parsed.boundary, error: parsed.reason };

  const serialized = serializeFromJsonValue(parsed.value, destFormat);
  if (!serialized.ok || serialized.text === undefined) return { ok: false, error: serialized.error ?? "the value could not be serialized" };

  const written = writeTextAtomically(destPath, serialized.text);
  if (!written.ok) return { ok: false, error: written.error };

  return {
    ok: true,
    path: destPath,
    bytesWritten: written.bytesWritten,
    lossy: serialized.lossy,
    notes: serialized.notes,
  };
}
