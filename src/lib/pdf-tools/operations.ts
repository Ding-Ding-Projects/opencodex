/**
 * The actual PDF operations, on pdf-lib.
 *
 * This is the only file in the module that imports `pdf-lib`. Every function
 * here is pure — `Uint8Array` (and plain option objects) in, a result or a
 * thrown `PdfToolsError` out, no filesystem and no worker-specific code — so
 * the whole operation surface is directly unit-testable without spinning up a
 * worker thread, and `worker.ts` is a thin dispatcher around
 * {@link runPdfOperation} rather than a second copy of this logic. Running the
 * same function in-process (tests) and inside the sandboxed worker
 * (production) is what makes the two paths genuinely identical rather than
 * "believed to behave the same".
 *
 * ## Why "order" verification is dimension + rotation, not a content hash
 *
 * The contract asks reopen-validation to check "actual page order, page count,
 * rotation and metadata against what was requested". Every mutating operation
 * here builds its `expected` fingerprint sequence from the *source* document
 * and the *request*, before touching the output — so a bug in the page-copy
 * loop that swaps, drops or duplicates a page almost always changes a page's
 * width, height or rotation relative to its declared position, and the
 * post-write reopen (in `service.ts`) will disagree with `expected` and roll
 * the write back. It is not a byte-for-byte content hash — two source pages of
 * identical size and rotation are indistinguishable to this check — and that
 * limit is recorded here rather than left for a reader to discover.
 */

import { PDFDocument, degrees, reduceRotation } from "pdf-lib";
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_METADATA_FIELD_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_PAGE_COUNT,
  MAX_PAGE_SELECTION,
  MAX_SOURCES,
  MAX_SPLIT_RANGES,
  MAX_TOTAL_SOURCE_BYTES,
  PAGE_SIZE_TOLERANCE_PT,
} from "./bounds";
import { hasSignatureMarkers, sniffPdf } from "./detect";
import type {
  OperationExpectation,
  OperationOutput,
  PageFingerprint,
  PageRange,
  PageRotation,
  PdfBoundary,
  PdfCapabilities,
  PdfInspectResult,
  PdfMetadataFields,
  PdfOperationRequest,
  PdfOperationResult,
  PdfPageInfo,
} from "./types";

/** Thrown by every validation and capability check in this file. */
export class PdfToolsError extends Error {
  boundary?: PdfBoundary;
  constructor(message: string, boundary?: PdfBoundary) {
    super(message);
    this.name = "PdfToolsError";
    this.boundary = boundary;
  }
}

function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  return reduceRotation(angle);
}

/** Exported for `service.ts`'s post-write reopen validation — the same fingerprint on both ends. */
export function fingerprintOf(page: { getWidth(): number; getHeight(): number; getRotation(): { angle: number } }): PageFingerprint {
  return {
    widthPt: page.getWidth(),
    heightPt: page.getHeight(),
    rotationDegrees: normalizeRotation(page.getRotation().angle),
  };
}

function dateToIso(date: Date | undefined): string | undefined {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

/** Exported for `service.ts`'s post-write reopen validation. */
export function readMetadataFields(doc: PDFDocument): PdfMetadataFields {
  const fields: PdfMetadataFields = {};
  const title = doc.getTitle();
  const author = doc.getAuthor();
  const subject = doc.getSubject();
  const keywordsRaw = doc.getKeywords();
  const creator = doc.getCreator();
  const producer = doc.getProducer();
  const creationDate = dateToIso(doc.getCreationDate());
  const modificationDate = dateToIso(doc.getModificationDate());
  if (title !== undefined) fields.title = title;
  if (author !== undefined) fields.author = author;
  if (subject !== undefined) fields.subject = subject;
  // pdf-lib's own `setKeywords` joins an array with a single space (see below) —
  // not a comma, and not anything reversible for a keyword that itself
  // contains a space. Splitting on whitespace here matches what pdf-lib
  // actually wrote, which is the only round-trip this library's Keywords API
  // can honestly promise; a keyword such as "machine learning" is stored and
  // read back as two keywords, and that limit is inherent to `/Keywords`
  // being a single PDF string rather than a real array.
  if (keywordsRaw !== undefined) fields.keywords = keywordsRaw.split(/\s+/).filter(Boolean);
  if (creator !== undefined) fields.creator = creator;
  if (producer !== undefined) fields.producer = producer;
  if (creationDate !== undefined) fields.creationDate = creationDate;
  if (modificationDate !== undefined) fields.modificationDate = modificationDate;
  return fields;
}

/**
 * Assess a source's capabilities without ever throwing — a boundary is data,
 * not an exception, so every caller (inspect included) gets the same shape
 * whether the source is perfectly healthy or garbage.
 */
export async function assessCapabilities(bytes: Uint8Array): Promise<PdfCapabilities> {
  const sniff = sniffPdf(bytes);
  if (!sniff.isPdf) {
    return { ok: false, boundary: "not-a-pdf", reason: sniff.reason, signed: false };
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch (err) {
    // Not `instanceof EncryptedPDFError`: pdf-lib's classes extend the native
    // `Error` through an ES5-target `__extends` helper, which is a documented
    // TypeScript pitfall — the prototype chain built-ins expect is not the one
    // downleveled subclassing produces, so `instanceof` silently returns false
    // for every error this library throws. Matched on `err.message` instead,
    // which is pdf-lib's own wording and is what its README tells callers to
    // rely on for exactly this reason.
    if (err instanceof Error && /is encrypted/i.test(err.message)) {
      return {
        ok: false,
        boundary: "encrypted",
        reason: "the source is password-protected and opencodex has no password-input channel yet; provide a decrypted copy",
        signed: hasSignatureMarkers(bytes),
      };
    }
    return {
      ok: false,
      boundary: "malformed",
      reason: "the source could not be parsed as a valid PDF",
      signed: false,
    };
  }
  const pageCount = doc.getPageCount();
  if (pageCount > MAX_PAGE_COUNT) {
    return {
      ok: false,
      boundary: "bounds-exceeded",
      reason: `the source has ${pageCount} pages, over the ${MAX_PAGE_COUNT} page limit`,
      signed: hasSignatureMarkers(bytes),
      pageCount,
    };
  }
  return { ok: true, signed: hasSignatureMarkers(bytes), pageCount };
}

/** Refuse to write unless the source is writable and any signature was acknowledged. */
function assertWritable(caps: PdfCapabilities, acknowledgeSigned: boolean | undefined): void {
  if (!caps.ok) {
    throw new PdfToolsError(caps.reason ?? "the source cannot be operated on", caps.boundary);
  }
  if (caps.signed && !acknowledgeSigned) {
    throw new PdfToolsError(
      "the source carries a digital signature; this edit will invalidate it — retry with acknowledgeSigned: true once you have shown the user that disclosure",
      undefined,
    );
  }
}

async function loadOrThrow(bytes: Uint8Array, caps: PdfCapabilities): Promise<PDFDocument> {
  void caps; // capability check already ran; this just re-parses the already-validated bytes
  return PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
}

function assertPageNumber(page: unknown, pageCount: number, label: string): asserts page is number {
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new PdfToolsError(`${label} ${String(page)} is out of range (this document has ${pageCount} pages)`);
  }
}

// --------------------------------------------------------------------- inspect

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspectResult> {
  const capabilities = await assessCapabilities(bytes);
  if (!capabilities.ok) return { capabilities };
  const doc = await loadOrThrow(bytes, capabilities);
  const pages: PdfPageInfo[] = doc.getPages().map((page, index) => {
    const fp = fingerprintOf(page);
    return { page: index + 1, widthPt: fp.widthPt, heightPt: fp.heightPt, rotationDegrees: fp.rotationDegrees };
  });
  return { capabilities, pages, metadata: readMetadataFields(doc) };
}

// --------------------------------------------------------------------- split

export async function splitPdf(
  bytes: Uint8Array,
  ranges: PageRange[],
  acknowledgeSigned?: boolean,
): Promise<OperationOutput[]> {
  const capabilities = await assessCapabilities(bytes);
  assertWritable(capabilities, acknowledgeSigned);
  const pageCount = capabilities.pageCount ?? 0;
  if (!ranges.length) throw new PdfToolsError("at least one page range is required");
  if (ranges.length > MAX_SPLIT_RANGES) throw new PdfToolsError(`too many ranges (max ${MAX_SPLIT_RANGES})`);
  for (const range of ranges) {
    assertPageNumber(range.start, pageCount, "range start");
    assertPageNumber(range.end, pageCount, "range end");
    if (range.end < range.start) throw new PdfToolsError(`range end ${range.end} is before start ${range.start}`);
  }

  const source = await loadOrThrow(bytes, capabilities);
  const sourceFingerprints = source.getPages().map(fingerprintOf);

  const outputs: OperationOutput[] = [];
  for (const range of ranges) {
    const indices: number[] = [];
    for (let p = range.start; p <= range.end; p++) indices.push(p - 1);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(source, indices);
    for (const page of copied) out.addPage(page);
    const outBytes = await out.save();
    outputs.push({
      bytes: outBytes,
      expected: { pageCount: indices.length, pages: indices.map(i => sourceFingerprints[i]) },
    });
  }
  return outputs;
}

// --------------------------------------------------------------------- merge

export async function mergePdfs(sources: Uint8Array[], acknowledgeSigned?: boolean): Promise<OperationOutput> {
  if (!sources.length) throw new PdfToolsError("at least one source is required");
  if (sources.length > MAX_SOURCES) throw new PdfToolsError(`too many sources (max ${MAX_SOURCES})`);
  const totalBytes = sources.reduce((sum, s) => sum + s.byteLength, 0);
  if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    throw new PdfToolsError(`combined source size exceeds the ${MAX_TOTAL_SOURCE_BYTES} byte limit`, "bounds-exceeded");
  }

  const loaded: PDFDocument[] = [];
  const expectedPages: PageFingerprint[] = [];
  let signedAny = false;
  for (const bytes of sources) {
    const caps = await assessCapabilities(bytes);
    if (!caps.ok) throw new PdfToolsError(caps.reason ?? "a source cannot be operated on", caps.boundary);
    if (caps.signed) signedAny = true;
    const doc = await loadOrThrow(bytes, caps);
    loaded.push(doc);
    for (const page of doc.getPages()) expectedPages.push(fingerprintOf(page));
  }
  if (signedAny && !acknowledgeSigned) {
    throw new PdfToolsError(
      "at least one source carries a digital signature; merging will invalidate it — retry with acknowledgeSigned: true once you have shown the user that disclosure",
    );
  }

  const merged = await PDFDocument.create();
  for (const doc of loaded) {
    const copied = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of copied) merged.addPage(page);
  }
  const outBytes = await merged.save();
  return { bytes: outBytes, expected: { pageCount: expectedPages.length, pages: expectedPages } };
}

// --------------------------------------------------------------------- extract

export async function extractPages(
  bytes: Uint8Array,
  pages: number[],
  acknowledgeSigned?: boolean,
): Promise<OperationOutput> {
  const capabilities = await assessCapabilities(bytes);
  assertWritable(capabilities, acknowledgeSigned);
  const pageCount = capabilities.pageCount ?? 0;
  if (!pages.length) throw new PdfToolsError("at least one page is required");
  if (pages.length > MAX_PAGE_SELECTION) throw new PdfToolsError(`too many pages requested (max ${MAX_PAGE_SELECTION})`);
  for (const page of pages) assertPageNumber(page, pageCount, "page");

  const source = await loadOrThrow(bytes, capabilities);
  const sourceFingerprints = source.getPages().map(fingerprintOf);
  const indices = pages.map(p => p - 1);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, indices);
  for (const page of copied) out.addPage(page);
  const outBytes = await out.save();
  return {
    bytes: outBytes,
    expected: { pageCount: indices.length, pages: indices.map(i => sourceFingerprints[i]) },
  };
}

// --------------------------------------------------------------------- reorder

export async function reorderPages(
  bytes: Uint8Array,
  order: number[],
  acknowledgeSigned?: boolean,
): Promise<OperationOutput> {
  const capabilities = await assessCapabilities(bytes);
  assertWritable(capabilities, acknowledgeSigned);
  const pageCount = capabilities.pageCount ?? 0;
  if (order.length !== pageCount) {
    throw new PdfToolsError(`order must list every page exactly once (got ${order.length}, expected ${pageCount})`);
  }
  const seen = new Set<number>();
  for (const page of order) {
    assertPageNumber(page, pageCount, "page");
    if (seen.has(page)) throw new PdfToolsError(`page ${page} appears more than once in order`);
    seen.add(page);
  }

  const source = await loadOrThrow(bytes, capabilities);
  const sourceFingerprints = source.getPages().map(fingerprintOf);
  const indices = order.map(p => p - 1);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, indices);
  for (const page of copied) out.addPage(page);
  const outBytes = await out.save();
  return {
    bytes: outBytes,
    expected: { pageCount: indices.length, pages: indices.map(i => sourceFingerprints[i]) },
  };
}

// --------------------------------------------------------------------- rotate

export async function rotatePages(
  bytes: Uint8Array,
  rotations: PageRotation[],
  acknowledgeSigned?: boolean,
): Promise<OperationOutput> {
  const capabilities = await assessCapabilities(bytes);
  assertWritable(capabilities, acknowledgeSigned);
  const pageCount = capabilities.pageCount ?? 0;
  if (!rotations.length) throw new PdfToolsError("at least one rotation is required");
  const byPage = new Map<number, PageRotation>();
  for (const rotation of rotations) {
    assertPageNumber(rotation.page, pageCount, "page");
    if (!Number.isInteger(rotation.degrees) || rotation.degrees % 90 !== 0) {
      throw new PdfToolsError(`rotation for page ${rotation.page} must be a multiple of 90 degrees`);
    }
    if (byPage.has(rotation.page)) throw new PdfToolsError(`page ${rotation.page} has more than one rotation in this request`);
    byPage.set(rotation.page, rotation);
  }

  const doc = await loadOrThrow(bytes, capabilities);
  const docPages = doc.getPages();
  const expectedPages: PageFingerprint[] = [];
  for (let i = 0; i < docPages.length; i++) {
    const pageNumber = i + 1;
    const page = docPages[i];
    const request = byPage.get(pageNumber);
    if (request) {
      const current = normalizeRotation(page.getRotation().angle);
      const next = request.relative ? current + request.degrees : request.degrees;
      page.setRotation(degrees(next));
    }
    expectedPages.push(fingerprintOf(page));
  }
  const outBytes = await doc.save();
  return { bytes: outBytes, expected: { pageCount: docPages.length, pages: expectedPages } };
}

// --------------------------------------------------------------------- metadata

function assertMetadataFields(fields: PdfMetadataFields): void {
  const textFields: Array<[keyof PdfMetadataFields, string | undefined]> = [
    ["title", fields.title], ["author", fields.author], ["subject", fields.subject],
    ["creator", fields.creator], ["producer", fields.producer],
  ];
  for (const [name, value] of textFields) {
    if (value !== undefined && value.length > MAX_METADATA_FIELD_LENGTH) {
      throw new PdfToolsError(`${String(name)} exceeds ${MAX_METADATA_FIELD_LENGTH} characters`);
    }
  }
  if (fields.keywords !== undefined) {
    if (fields.keywords.length > MAX_KEYWORDS) throw new PdfToolsError(`too many keywords (max ${MAX_KEYWORDS})`);
    for (const keyword of fields.keywords) {
      if (keyword.length > MAX_KEYWORD_LENGTH) throw new PdfToolsError(`a keyword exceeds ${MAX_KEYWORD_LENGTH} characters`);
    }
  }
  for (const [name, value] of [["creationDate", fields.creationDate], ["modificationDate", fields.modificationDate]] as const) {
    if (value !== undefined && Number.isNaN(new Date(value).getTime())) {
      throw new PdfToolsError(`${name} is not a valid ISO 8601 date`);
    }
  }
}

export async function readMetadata(bytes: Uint8Array): Promise<PdfMetadataFields> {
  const capabilities = await assessCapabilities(bytes);
  if (!capabilities.ok) throw new PdfToolsError(capabilities.reason ?? "the source cannot be read", capabilities.boundary);
  const doc = await loadOrThrow(bytes, capabilities);
  return readMetadataFields(doc);
}

export async function writeMetadata(
  bytes: Uint8Array,
  fields: PdfMetadataFields,
  acknowledgeSigned?: boolean,
): Promise<OperationOutput> {
  assertMetadataFields(fields);
  const capabilities = await assessCapabilities(bytes);
  assertWritable(capabilities, acknowledgeSigned);
  const doc = await loadOrThrow(bytes, capabilities);
  const pageFingerprints = doc.getPages().map(fingerprintOf);

  if (fields.title !== undefined) doc.setTitle(fields.title);
  if (fields.author !== undefined) doc.setAuthor(fields.author);
  if (fields.subject !== undefined) doc.setSubject(fields.subject);
  if (fields.keywords !== undefined) doc.setKeywords(fields.keywords);
  if (fields.creator !== undefined) doc.setCreator(fields.creator);
  if (fields.producer !== undefined) doc.setProducer(fields.producer);
  if (fields.creationDate !== undefined) doc.setCreationDate(new Date(fields.creationDate));
  if (fields.modificationDate !== undefined) doc.setModificationDate(new Date(fields.modificationDate));

  const outBytes = await doc.save();
  const expected: OperationExpectation = {
    pageCount: pageFingerprints.length,
    pages: pageFingerprints,
    metadata: fields,
  };
  return { bytes: outBytes, expected };
}

// --------------------------------------------------------------------- post-write validation

/** Two ISO timestamps agree if they round to the same second — PDF's date type has no sub-second precision. */
function sameSecond(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.floor(ta / 1000) === Math.floor(tb / 1000);
}

function sameKeywords(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((word, i) => word === right[i]);
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * The load-bearing check: reopen bytes that were just written to disk and
 * confirm they actually contain the page order, count, rotation and metadata
 * the request asked for — never the bytes this process already had in memory,
 * which would only prove the operation *computed* the right thing, not that
 * it *landed* correctly. `service.ts` calls this against a fresh read of the
 * file it just wrote.
 */
export async function validateAgainstExpectation(
  diskBytes: Uint8Array,
  expected: OperationExpectation,
): Promise<ValidationResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(diskBytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch {
    return { ok: false, error: "the written file could not be reopened as a valid PDF" };
  }
  const pages = doc.getPages();
  if (pages.length !== expected.pageCount) {
    return { ok: false, error: `page count mismatch: found ${pages.length}, expected ${expected.pageCount}` };
  }
  for (let i = 0; i < pages.length; i++) {
    const found = fingerprintOf(pages[i]);
    const want = expected.pages[i];
    if (
      Math.abs(found.widthPt - want.widthPt) > PAGE_SIZE_TOLERANCE_PT
      || Math.abs(found.heightPt - want.heightPt) > PAGE_SIZE_TOLERANCE_PT
    ) {
      return { ok: false, error: `page ${i + 1} size mismatch: found ${found.widthPt}x${found.heightPt}pt, expected ${want.widthPt}x${want.heightPt}pt` };
    }
    if (found.rotationDegrees !== want.rotationDegrees) {
      return { ok: false, error: `page ${i + 1} rotation mismatch: found ${found.rotationDegrees}°, expected ${want.rotationDegrees}°` };
    }
  }
  if (expected.metadata) {
    const found = readMetadataFields(doc);
    for (const key of Object.keys(expected.metadata) as Array<keyof PdfMetadataFields>) {
      if (key === "keywords") {
        if (!sameKeywords(expected.metadata.keywords, found.keywords)) {
          return { ok: false, error: "metadata.keywords mismatch after reopening the written file" };
        }
      } else if (key === "creationDate" || key === "modificationDate") {
        if (!sameSecond(expected.metadata[key], found[key])) {
          return { ok: false, error: `metadata.${key} mismatch after reopening the written file` };
        }
      } else if (expected.metadata[key] !== found[key]) {
        return { ok: false, error: `metadata.${key} mismatch after reopening the written file` };
      }
    }
  }
  return { ok: true };
}

// --------------------------------------------------------------------- dispatch

/** Every produced output, wherever it lives in the result shape, bounded before it ships. */
function oversizedOutput(result: Extract<PdfOperationResult, { ok: true }>): string | null {
  const outputs: OperationOutput[] =
    result.op === "split" ? result.results
    : result.op === "inspect" || result.op === "metadata-read" ? []
    : [result.result];
  for (const output of outputs) {
    if (output.bytes.byteLength > MAX_OUTPUT_BYTES) {
      return `the result (${output.bytes.byteLength} bytes) exceeds the ${MAX_OUTPUT_BYTES} byte output limit`;
    }
  }
  return null;
}

/**
 * The single entry point both the sandboxed worker and the in-process test
 * path call, so "runs in the sandbox" and "runs in a unit test" are provably
 * the same code rather than two implementations that are hoped to agree.
 */
export async function runPdfOperation(request: PdfOperationRequest): Promise<PdfOperationResult> {
  try {
    const result: PdfOperationResult = await (async () => {
      switch (request.op) {
        case "inspect":
          return { ok: true, op: "inspect", result: await inspectPdf(request.source) } as const;
        case "split":
          return { ok: true, op: "split", results: await splitPdf(request.source, request.ranges, request.acknowledgeSigned) } as const;
        case "merge":
          return { ok: true, op: "merge", result: await mergePdfs(request.sources, request.acknowledgeSigned) } as const;
        case "extract":
          return { ok: true, op: "extract", result: await extractPages(request.source, request.pages, request.acknowledgeSigned) } as const;
        case "reorder":
          return { ok: true, op: "reorder", result: await reorderPages(request.source, request.order, request.acknowledgeSigned) } as const;
        case "rotate":
          return { ok: true, op: "rotate", result: await rotatePages(request.source, request.rotations, request.acknowledgeSigned) } as const;
        case "metadata-read":
          return { ok: true, op: "metadata-read", result: await readMetadata(request.source) } as const;
        case "metadata-write":
          return {
            ok: true,
            op: "metadata-write",
            result: await writeMetadata(request.source, request.fields, request.acknowledgeSigned),
          } as const;
        default: {
          const exhaustive: never = request;
          throw new PdfToolsError(`unknown operation: ${JSON.stringify(exhaustive)}`);
        }
      }
    })();
    if (result.ok) {
      const tooBig = oversizedOutput(result);
      if (tooBig) return { ok: false, boundary: "bounds-exceeded", error: tooBig };
    }
    return result;
  } catch (err) {
    if (err instanceof PdfToolsError) return { ok: false, boundary: err.boundary, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : "the operation failed" };
  }
}
