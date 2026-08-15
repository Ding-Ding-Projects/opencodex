/**
 * Every numeric and set-membership limit the download-capture feature enforces,
 * named in one place so a review of "what can an untrusted capture make this
 * process do" is a review of this file rather than a grep across four others.
 */

/** A capture is a URL, a filename and a page reference — never large. */
export const MAX_URL_LENGTH = 4000;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_PAGE_URL_LENGTH = 4000;
export const MAX_MIME_TYPE_LENGTH = 255;

/** Only these ever reach `fetch`. `file:`/`data:`/`blob:` would turn a "download" into a local-file read. */
export const ALLOWED_DOWNLOAD_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * The history list is bounded so a machine left running for months does not
 * grow an unbounded JSON file. Pruning drops the OLDEST terminal (finished)
 * records first — active transfers are never pruned out from under themselves.
 */
export const MAX_DOWNLOAD_RECORDS = 300;

/** How much history to keep once the cap is hit; leaves headroom before the next prune. */
export const PRUNE_TO_RECORDS = 250;

/** Progress ticks are throttled to this interval so a fast LAN transfer does not spend more time computing a rate than moving bytes. */
export const PROGRESS_SAMPLE_INTERVAL_MS = 500;

/** Chunk read size is whatever the platform's stream hands back; this bounds how long the manager waits on a single `read()` before treating the peer as stalled. */
export const STALL_TIMEOUT_MS = 30_000;
