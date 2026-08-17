/**
 * Resource bounds for every PDF operation.
 *
 * Kept in one file so a reviewer can see the whole safety envelope at a glance,
 * rather than hunting per-operation constants scattered across the module. Every
 * number here is enforced somewhere in `service.ts`, `worker.ts` or
 * `operations.ts` — grep the constant name to find the enforcement site.
 */

/** A single source file larger than this is refused before it is fully read. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024; // 200 MiB

/** Sum of every source in a multi-source operation (merge). */
export const MAX_TOTAL_SOURCE_BYTES = 500 * 1024 * 1024; // 500 MiB

/** Most source files one merge may combine. */
export const MAX_SOURCES = 200;

/** A parsed document with more pages than this is refused as bounds-exceeding. */
export const MAX_PAGE_COUNT = 10_000;

/** A produced result larger than this is refused rather than written. */
export const MAX_OUTPUT_BYTES = 300 * 1024 * 1024; // 300 MiB

/** Wall-clock budget for one worker run before it is terminated. */
export const WORKER_TIMEOUT_MS = 60_000;

/** Worker heap ceiling — `node:worker_threads` `resourceLimits`. */
export const WORKER_MAX_OLD_GENERATION_MB = 1024;
export const WORKER_MAX_YOUNG_GENERATION_MB = 256;
/** Bounds native stack recursion inside the worker's V8 instance. */
export const WORKER_STACK_SIZE_MB = 8;

/** Metadata string fields (title, author, subject, creator, producer). */
export const MAX_METADATA_FIELD_LENGTH = 4000;
/** Keywords is a list; both the count and each entry's length are bounded. */
export const MAX_KEYWORDS = 64;
export const MAX_KEYWORD_LENGTH = 200;

/** Most page-range entries one split request may declare. */
export const MAX_SPLIT_RANGES = 2_000;
/** Most page numbers one extract/reorder request may declare. */
export const MAX_PAGE_SELECTION = MAX_PAGE_COUNT;

/** Floating-point tolerance (PDF points) when comparing page dimensions on reopen. */
export const PAGE_SIZE_TOLERANCE_PT = 0.5;
