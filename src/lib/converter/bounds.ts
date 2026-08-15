/**
 * Resource bounds for the converter's own detection pass.
 *
 * Kept separate from `src/lib/pdf-tools/bounds.ts`: this module bounds a
 * bytes-only sniff, never a full parse or a write, so its numbers are much
 * smaller. Once a detected source is actually handed to an adapter (today,
 * only the PDF family), that adapter's own bounds — `MAX_SOURCE_BYTES` etc. —
 * apply on top of these, unchanged.
 */

/** A source larger than this is refused before detection reads a single byte of content. */
export const MAX_DETECT_SOURCE_BYTES = 500 * 1024 * 1024; // 500 MiB — generous, this is just a stat() check

/** Only the leading slice of a file is ever read for magic-byte detection. */
export const MAGIC_SCAN_BYTES = 4100;

/** Bound on how much of a text-like prefix is inspected for the JSON/XML/text heuristics. */
export const TEXT_HEURISTIC_SCAN_BYTES = 4096;
