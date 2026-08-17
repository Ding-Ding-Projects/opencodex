/**
 * Shared types for the PDF tools module.
 *
 * `operations.ts` is the only file that imports `pdf-lib` directly. Everything
 * else — the worker, the sandbox, the fs-facing service, the HTTP routes and the
 * CLI — talks in these plain types, so the pdf-lib dependency stays contained to
 * one file and the rest of the module is trivially unit-testable.
 */

export type PdfOperationKind =
  | "inspect"
  | "split"
  | "merge"
  | "extract"
  | "reorder"
  | "rotate"
  | "metadata";

/** Why a source cannot be operated on at all — refused before any write. */
export type PdfBoundary =
  | "not-a-pdf"
  | "malformed"
  | "encrypted"
  | "bounds-exceeded";

export interface PdfMetadataFields {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  /** ISO 8601. `undefined` means "not set in the source document". */
  creationDate?: string;
  modificationDate?: string;
}

export interface PdfPageInfo {
  /** 1-based, matching every page-number field the rest of this module takes. */
  page: number;
  widthPt: number;
  heightPt: number;
  /** Reduced to one of 0 / 90 / 180 / 270. */
  rotationDegrees: 0 | 90 | 180 | 270;
}

/**
 * What a source PDF can and cannot do, decided before any mutation is
 * attempted — the "opaque-capability limits... stated before execution" the
 * contract asks for.
 */
export interface PdfCapabilities {
  /** `false` means every other field here is meaningless — the boundary explains why. */
  ok: boolean;
  boundary?: PdfBoundary;
  /** Human-readable, safe to show a user: never a path, secret or document content. */
  reason?: string;
  /**
   * A digital signature was detected (`/ByteRange` + a `/Type /Sig` marker in
   * the raw bytes). Not a hard refusal — inspecting a signed PDF is safe — but
   * any *write* operation must be explicitly acknowledged, because pdf-lib has
   * no signature-preservation support and rewriting the file invalidates it.
   */
  signed: boolean;
  pageCount?: number;
}

export interface PdfInspectResult {
  capabilities: PdfCapabilities;
  pages?: PdfPageInfo[];
  metadata?: PdfMetadataFields;
}

export interface PageRange {
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

export interface PageRotation {
  /** 1-based page number. */
  page: number;
  /** Degrees to rotate by. Must be a multiple of 90. */
  degrees: number;
  /** `true` adds to the page's existing rotation; `false` (default) sets it absolutely. */
  relative?: boolean;
}

/** One page position in a produced document, for post-write structural verification. */
export interface PageFingerprint {
  widthPt: number;
  heightPt: number;
  rotationDegrees: 0 | 90 | 180 | 270;
}

/** What reopening the written file must find, or the write is rolled back. */
export interface OperationExpectation {
  pageCount: number;
  pages: PageFingerprint[];
  /** Only the fields the request actually asked to set are checked. */
  metadata?: PdfMetadataFields;
}

export interface OperationOutput {
  bytes: Uint8Array;
  expected: OperationExpectation;
}

/**
 * Every mutating request carries `acknowledgeSigned`. A source detected as
 * digitally signed refuses the operation unless it is `true` — the caller must
 * have been shown the "this will invalidate the signature" disclosure and
 * deliberately proceeded. Reading (`inspect`, `metadata-read`) never mutates,
 * so neither variant needs it.
 */
export type PdfOperationRequest =
  | { op: "inspect"; source: Uint8Array }
  | { op: "split"; source: Uint8Array; ranges: PageRange[]; acknowledgeSigned?: boolean }
  | { op: "merge"; sources: Uint8Array[]; acknowledgeSigned?: boolean }
  | { op: "extract"; source: Uint8Array; pages: number[]; acknowledgeSigned?: boolean }
  | { op: "reorder"; source: Uint8Array; order: number[]; acknowledgeSigned?: boolean }
  | { op: "rotate"; source: Uint8Array; rotations: PageRotation[]; acknowledgeSigned?: boolean }
  | { op: "metadata-read"; source: Uint8Array }
  | { op: "metadata-write"; source: Uint8Array; fields: PdfMetadataFields; acknowledgeSigned?: boolean };

export type PdfOperationOk =
  | { ok: true; op: "inspect"; result: PdfInspectResult }
  | { ok: true; op: "split"; results: OperationOutput[] }
  | { ok: true; op: "merge"; result: OperationOutput }
  | { ok: true; op: "extract"; result: OperationOutput }
  | { ok: true; op: "reorder"; result: OperationOutput }
  | { ok: true; op: "rotate"; result: OperationOutput }
  | { ok: true; op: "metadata-read"; result: PdfMetadataFields }
  | { ok: true; op: "metadata-write"; result: OperationOutput };

export interface PdfOperationErr {
  ok: false;
  boundary?: PdfBoundary;
  error: string;
}

export type PdfOperationResult = PdfOperationOk | PdfOperationErr;
