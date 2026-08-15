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

// --------------------------------------------------------------------------
// ZIP extraction (`zip-extract.ts`, `archive-service.ts`) — the archives
// family's one enabled format. Every number here is enforced somewhere in
// `zip-extract.ts`; grep the constant name to find the exact refusal site.
// --------------------------------------------------------------------------

/** A ZIP source larger than this is refused before a single byte is parsed. */
export const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024; // 200 MiB

/** Central-directory entries beyond this are refused before any are read. */
export const MAX_ZIP_ENTRIES = 20_000;

/** One entry's declared uncompressed size beyond this is refused as a suspected bomb. */
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MiB

/** Sum of every entry's declared uncompressed size beyond this is refused. */
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * A single-level Deflate stream cannot legitimately exceed roughly 1032:1 —
 * the format's own worst-case degenerate-literal-run encoding. A declared
 * ratio past this is refused before a single byte is inflated. This is an
 * early, honest refusal, never the only defense: the actual `inflateRawSync`
 * call is separately bounded with `maxOutputLength` regardless of what a
 * declared size claims.
 */
export const MAX_ZIP_ENTRY_COMPRESSION_RATIO = 1200;

// --------------------------------------------------------------------------
// Structured-data conversions (`delimited.ts`, `xml-convert.ts`,
// `structured-service.ts`) — the structured-data family's enabled formats.
// --------------------------------------------------------------------------

/** A structured-data source larger than this is refused before it is parsed. */
export const MAX_STRUCTURED_INPUT_BYTES = 50 * 1024 * 1024; // 50 MiB

/** A produced conversion output larger than this is refused rather than written. */
export const MAX_STRUCTURED_OUTPUT_BYTES = 150 * 1024 * 1024; // 150 MiB

/** Deepest allowed nesting of a parsed or serialized JSON/XML value. */
export const MAX_STRUCTURED_DEPTH = 64;

/** Most rows a CSV/TSV table may declare. */
export const MAX_DELIMITED_ROWS = 500_000;

/** Most columns a single CSV/TSV row may declare. */
export const MAX_DELIMITED_COLUMNS = 2_000;

/** Longest a single CSV/TSV cell may be. */
export const MAX_DELIMITED_CELL_LENGTH = 100_000;

/** Most elements one XML document may contain — bounds a flat or a deep bomb alike. */
export const MAX_XML_NODES = 200_000;
