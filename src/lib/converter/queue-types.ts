/**
 * Shared types for the converter's resumable batch queue.
 *
 * Same shape as `src/lib/model-runtime/pull-queue-types.ts` on purpose: this
 * is the "unlimited-length queue... paged discovery... persistent resumable
 * record... bounded-concurrency chunks with constant-memory backpressure...
 * pause, resume, and cancel... per-file progress and outcomes" contract the
 * universal-converter section asks for, and the model-pull queue already
 * proved that exact shape for a different kind of job. A `ConvertQueueItem`
 * is one file-in/file-out conversion job. Three families are wired today —
 * structured-data (JSON/CSV/TSV/XML), ZIP extraction, and a PDF "rotate
 * every page" job — see `queue-engine.ts`'s header for exactly what each
 * kind does and does not cover.
 */

import type { StructuredFormat } from "./structured-service";

/**
 * `structured`  — a JSON/CSV/TSV/XML conversion through `convertStructuredDataAtPath`.
 * `zip-extract` — an archive extraction through `extractZipAtPath`.
 * `pdf-rotate`  — every page of a PDF rotated by the same amount, through
 *                 `inspectPdfAtPath` + `rotatePagesAtPath`.
 *
 * Kept as a discriminant so each kind can carry only the fields it actually
 * needs (`sourceFormat`/`destFormat` for `structured`, `rotateDegrees` for
 * `pdf-rotate`, neither for `zip-extract`) without reshaping every item.
 */
export type ConvertJobKind = "structured" | "zip-extract" | "pdf-rotate";

/**
 * `queued`     — accepted into the batch, not yet started.
 * `converting` — this item's synchronous conversion is running right now.
 * `converted`  — the conversion succeeded and the output was written and
 *                verified on disk.
 * `skipped`    — never attempted because the destination already existed at
 *                enqueue time and the caller did not ask to overwrite — the
 *                honest "nothing to do" outcome, not a failure.
 * `cancelled`  — the user cancelled this item (or the whole batch) before it
 *                reached a terminal state.
 * `failed`     — the conversion was attempted and refused or errored. A
 *                failed item never becomes `converted`, and a failed item
 *                never deletes or truncates an existing destination file —
 *                see `structured-service.ts`'s atomic-write-then-reopen
 *                discipline, which this queue relies on rather than
 *                duplicates.
 */
export type ConvertQueueItemStatus = "queued" | "converting" | "converted" | "skipped" | "cancelled" | "failed";

export interface ConvertQueueItem {
  id: string;
  kind: ConvertJobKind;
  sourcePath: string;
  /** Only meaningful for `kind === "structured"` — the structured source/target pair. `null` for `zip-extract` and `pdf-rotate`, which have no format concept. */
  sourceFormat: StructuredFormat | null;
  destPath: string;
  destFormat: StructuredFormat | null;
  /**
   * Supplied at enqueue time; carried through so a resumed/retried item does
   * not silently re-ask. Overloaded per kind, same as the rest of this item:
   * for `structured` it is the lossy-target acknowledgement
   * `convertStructuredDataAtPath` enforces; for `pdf-rotate` it is the
   * signed-source acknowledgement `rotatePagesAtPath` enforces
   * (`acknowledgeSigned`, same "disclose before it runs" shape, reusing this
   * field rather than adding a second one that would mean the same thing for
   * a different kind). Meaningless for `zip-extract`, which has no such risk.
   */
  acknowledgeLossy: boolean;
  /** Only meaningful for `kind === "pdf-rotate"` — degrees every page of the source is rotated by. `undefined` for every other kind. */
  rotateDegrees?: 0 | 90 | 180 | 270;
  status: ConvertQueueItemStatus;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** The source file's size in bytes at enqueue time — the one number known up front, used for the storage preflight. `null` when the source could not be stat'd at enqueue time (reported honestly, not guessed). */
  sourceBytes: number | null;
  bytesWritten: number | null;
  lossy: boolean | null;
  notes: string[] | null;
  boundary: string | null;
  error: string | null;
}

export interface ConvertQueueState {
  version: 1;
  /** While `true`, `processQueue` claims no new `queued` item. An item already `converting` when the pause was requested still runs to completion — conversions are bounded and synchronous, so there is nothing useful to abort mid-write, and finishing it keeps every write atomic. */
  paused: boolean;
  items: ConvertQueueItem[];
}

export type ConvertQueueOutcome = "empty" | "in-progress" | "paused" | "complete-success" | "complete-partial";

export interface ConvertQueueSummary {
  total: number;
  queued: number;
  converting: number;
  converted: number;
  skipped: number;
  cancelled: number;
  failed: number;
  /**
   * `complete-success` only when every item reached `converted` or
   * `skipped` — never when any item is `failed`. A failed item can never
   * turn this green; see the module header of `queue-engine.ts`.
   */
  outcome: ConvertQueueOutcome;
}

export function summarizeConvertQueue(items: ConvertQueueItem[], paused: boolean): ConvertQueueSummary {
  const summary: ConvertQueueSummary = {
    total: items.length,
    queued: 0,
    converting: 0,
    converted: 0,
    skipped: 0,
    cancelled: 0,
    failed: 0,
    outcome: "empty",
  };
  for (const item of items) {
    if (item.status === "queued") summary.queued += 1;
    else if (item.status === "converting") summary.converting += 1;
    else if (item.status === "converted") summary.converted += 1;
    else if (item.status === "skipped") summary.skipped += 1;
    else if (item.status === "cancelled") summary.cancelled += 1;
    else if (item.status === "failed") summary.failed += 1;
  }
  if (summary.total === 0) {
    summary.outcome = "empty";
  } else if (summary.converting > 0) {
    summary.outcome = "in-progress";
  } else if (summary.queued > 0) {
    // Nothing running right now but work remains: distinguish "the engine
    // will pick this up" from "the user asked it to stop" so a paused batch
    // never reads as silently stalled.
    summary.outcome = paused ? "paused" : "in-progress";
  } else if (summary.failed > 0 || summary.cancelled > 0) {
    summary.outcome = "complete-partial";
  } else {
    summary.outcome = "complete-success";
  }
  return summary;
}
