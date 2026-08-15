/**
 * Byte-level PDF detection.
 *
 * Never trust a filename extension or a claimed content-type: the contract
 * requires bounded byte inspection instead. `sniffPdf` only reads a small
 * leading and trailing slice — never the whole buffer — so rejecting a large
 * non-PDF file is cheap and does not require parsing it first.
 */

const MAGIC_SCAN_BYTES = 2048;
const TRAILER_SCAN_BYTES = 4096;
const SIGNATURE_SCAN_MARKERS = ["/ByteRange", "/Type/Sig", "/Type /Sig"];

export interface PdfSniffResult {
  isPdf: boolean;
  reason?: string;
}

/**
 * `%PDF-` must appear within the first 2 KiB (the PDF spec tolerates leading
 * junk up to that point for embedding scenarios) and `%%EOF` within the final
 * 4 KiB. Both are cheap, bounded scans of a slice already in memory — no
 * additional read and no full-buffer decode.
 */
export function sniffPdf(bytes: Uint8Array): PdfSniffResult {
  if (bytes.byteLength < 8) {
    return { isPdf: false, reason: "the file is too small to contain a PDF header" };
  }
  const head = bytes.subarray(0, Math.min(bytes.byteLength, MAGIC_SCAN_BYTES));
  if (!bufferIncludes(head, "%PDF-")) {
    return { isPdf: false, reason: "no %PDF- header found in the first 2 KiB" };
  }
  const tailStart = Math.max(0, bytes.byteLength - TRAILER_SCAN_BYTES);
  const tail = bytes.subarray(tailStart);
  if (!bufferIncludes(tail, "%%EOF")) {
    return { isPdf: false, reason: "no %%EOF trailer found in the final 4 KiB" };
  }
  return { isPdf: true };
}

/**
 * Whether the raw bytes carry a digital-signature marker.
 *
 * Heuristic, on purpose: pdf-lib has no signature API, so this is a plain
 * substring scan for the markers every PDF signature dictionary carries
 * (`/ByteRange` alongside a `/Type /Sig` entry). It can neither verify a
 * signature nor prove one is absent from a deliberately obfuscated file; it
 * exists only to trigger the "this edit will invalidate the signature"
 * disclosure before a write, which is the contract's actual requirement.
 */
export function hasSignatureMarkers(bytes: Uint8Array): boolean {
  const hasByteRange = bufferIncludes(bytes, "/ByteRange");
  if (!hasByteRange) return false;
  return SIGNATURE_SCAN_MARKERS.slice(1).some(marker => bufferIncludes(bytes, marker));
}

/** `Buffer.includes` scans bytes directly — no full-buffer string allocation. */
function bufferIncludes(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle, 0, "latin1");
}
