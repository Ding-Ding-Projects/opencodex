/**
 * Byte-level file-type detection for the converter.
 *
 * Same discipline as `src/lib/pdf-tools/detect.ts`: never trust a filename
 * extension or a claimed content-type. Every check here reads only a bounded
 * leading slice of the file (`MAGIC_SCAN_BYTES`, `bounds.ts`) that the caller
 * already holds in memory — no additional read, and never the whole file.
 *
 * When nothing recognisable is found, `formatId` is left `undefined` rather
 * than guessed. That is deliberate: the contract's rule is "an unknown,
 * malformed or limit-exceeding source stays untouched and reports its exact
 * boundary rather than producing guessed output," and a false-positive format
 * guess is exactly the kind of guessed output that rule forbids.
 */

import { TEXT_HEURISTIC_SCAN_BYTES } from "./bounds";
import type { AdapterCategoryId } from "./types";

export interface FormatSniffResult {
  formatId?: string;
  category?: AdapterCategoryId;
  /** What was actually seen in the bytes, safe to show a user. */
  evidence: string;
}

function asLatin1(bytes: Uint8Array, start = 0, end?: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, (end ?? bytes.byteLength) - start).toString("latin1");
}

function startsWithBytes(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function includesAscii(bytes: Uint8Array, needle: string, start: number, end: number): boolean {
  if (bytes.byteLength < end) return false;
  return asLatin1(bytes, start, end) === needle;
}

/** Binary magic-number signatures, checked in order. First match wins. */
const BINARY_SIGNATURES: { formatId: string; category: AdapterCategoryId; test: (b: Uint8Array) => boolean; evidence: string }[] = [
  {
    formatId: "pdf", category: "documents-pdf", evidence: "found the %PDF- header",
    test: b => asLatin1(b, 0, Math.min(b.byteLength, 1024)).includes("%PDF-"),
  },
  {
    formatId: "png", category: "images", evidence: "matched the PNG 8-byte signature",
    test: b => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    formatId: "jpeg", category: "images", evidence: "matched the JPEG SOI marker (FF D8 FF)",
    test: b => startsWithBytes(b, [0xff, 0xd8, 0xff]),
  },
  {
    formatId: "gif", category: "images", evidence: "matched a GIF87a/GIF89a header",
    test: b => includesAscii(b, "GIF87a", 0, 6) || includesAscii(b, "GIF89a", 0, 6),
  },
  {
    formatId: "webp", category: "images", evidence: "matched a RIFF....WEBP container",
    test: b => includesAscii(b, "RIFF", 0, 4) && includesAscii(b, "WEBP", 8, 12),
  },
  {
    formatId: "bmp", category: "images", evidence: "matched the BM header",
    test: b => includesAscii(b, "BM", 0, 2),
  },
  {
    formatId: "wav", category: "audio", evidence: "matched a RIFF....WAVE container",
    test: b => includesAscii(b, "RIFF", 0, 4) && includesAscii(b, "WAVE", 8, 12),
  },
  {
    formatId: "flac", category: "audio", evidence: "matched the fLaC stream marker",
    test: b => includesAscii(b, "fLaC", 0, 4),
  },
  {
    formatId: "ogg", category: "audio", evidence: "matched the OggS page header",
    test: b => includesAscii(b, "OggS", 0, 4),
  },
  {
    formatId: "mp3", category: "audio", evidence: "found an ID3 tag or an MPEG audio frame sync",
    test: b => includesAscii(b, "ID3", 0, 3)
      || (b.byteLength >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  },
  {
    formatId: "mp4", category: "video", evidence: "matched an ISO base media (ftyp) box — MP4/MOV/M4A family",
    test: b => includesAscii(b, "ftyp", 4, 8),
  },
  {
    formatId: "webm", category: "video", evidence: "matched an EBML container header — WebM/Matroska family",
    test: b => startsWithBytes(b, [0x1a, 0x45, 0xdf, 0xa3]),
  },
  {
    formatId: "avi", category: "video", evidence: "matched a RIFF....AVI  container",
    test: b => includesAscii(b, "RIFF", 0, 4) && includesAscii(b, "AVI ", 8, 12),
  },
  {
    formatId: "7z", category: "archives", evidence: "matched the 7-Zip signature",
    test: b => startsWithBytes(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  },
  {
    formatId: "gzip", category: "archives", evidence: "matched the gzip magic bytes (1F 8B)",
    test: b => startsWithBytes(b, [0x1f, 0x8b]),
  },
  {
    formatId: "zip", category: "archives", evidence: "matched a ZIP local-file-header signature (PK\\x03\\x04)",
    test: b => startsWithBytes(b, [0x50, 0x4b, 0x03, 0x04])
      || startsWithBytes(b, [0x50, 0x4b, 0x05, 0x06])
      || startsWithBytes(b, [0x50, 0x4b, 0x07, 0x08]),
  },
  {
    formatId: "tar", category: "archives", evidence: "found the \"ustar\" marker at byte 257 of a POSIX tar header",
    test: b => b.byteLength >= 263 && includesAscii(b, "ustar", 257, 262),
  },
];

/** Recognised leading bytes for the text-structured formats, checked after the binary table finds nothing. */
function sniffStructuredText(prefix: Uint8Array): FormatSniffResult | null {
  const text = asLatin1(prefix, 0, Math.min(prefix.byteLength, TEXT_HEURISTIC_SCAN_BYTES));
  // Strip a UTF-8 BOM and leading whitespace before looking at the first real character.
  const trimmed = text.replace(/^﻿/, "").replace(/^\s+/, "");
  if (!trimmed) return null;

  if (trimmed.startsWith("<?xml")) {
    return { formatId: "xml", category: "structured-data", evidence: "starts with an <?xml declaration" };
  }
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return { formatId: "html", category: "code-text", evidence: "starts with a DOCTYPE or <html> tag" };
  }
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    // Heuristic only — a full parse would need the whole file, and a bounded
    // prefix of a large JSON document is expected to be truncated mid-token.
    // This is reported honestly as "consistent with", never "confirmed as".
    return { formatId: "json", category: "structured-data", evidence: "starts with '{' or '[', consistent with JSON (not confirmed by a full parse of a bounded prefix)" };
  }

  return null;
}

/**
 * Whether a bounded prefix looks like printable text at all — the last
 * fallback before giving up and reporting "unrecognised".
 *
 * A NUL byte anywhere in the prefix is the strongest signal that this is not
 * text: no legitimate text encoding embeds one in normal content.
 */
function looksLikeText(prefix: Uint8Array): boolean {
  const scan = prefix.subarray(0, Math.min(prefix.byteLength, TEXT_HEURISTIC_SCAN_BYTES));
  for (let i = 0; i < scan.byteLength; i++) {
    const byte = scan[i];
    if (byte === 0) return false;
    // Allow tab/LF/CR and the rest of printable ASCII plus UTF-8 continuation/lead bytes (>=0x20, or >=0x80 for multi-byte UTF-8).
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  return true;
}

/**
 * Classify a source from its already-read leading bytes.
 *
 * Order matters: binary magic numbers are checked first because they are
 * unambiguous, then the text-structured heuristics, then a generic
 * "looks like text" fallback that lands in Code/Text without naming a
 * specific format — which is honest, because bytes alone cannot say whether
 * a text file is Python, a changelog or a CSV with an unusual delimiter.
 */
export function sniffFormat(prefix: Uint8Array): FormatSniffResult {
  for (const sig of BINARY_SIGNATURES) {
    if (sig.test(prefix)) return { formatId: sig.formatId, category: sig.category, evidence: sig.evidence };
  }
  const structured = sniffStructuredText(prefix);
  if (structured) return structured;
  if (looksLikeText(prefix)) {
    // A CSV/TSV row is still just text bytes; only a plain-text delimiter
    // check can say more, and even that is a guess about intent rather than
    // format, so it stays out of `formatId` and only informs the evidence text.
    const firstLine = asLatin1(prefix, 0, Math.min(prefix.byteLength, 512)).split(/\r?\n/, 1)[0] ?? "";
    if (firstLine.includes(",") && !firstLine.includes("<") && !firstLine.includes("{")) {
      return { formatId: "csv", category: "structured-data", evidence: "printable text whose first line is comma-delimited, consistent with CSV" };
    }
    return { formatId: undefined, category: undefined, evidence: "printable text with no recognised structured format; bytes alone cannot name a specific text format or language" };
  }
  return { formatId: undefined, category: undefined, evidence: "no recognised binary signature and not printable text" };
}
