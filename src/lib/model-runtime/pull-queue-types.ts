/**
 * Shared types for the batch-pull queue — the "cart" the contract in
 * `docs/FEATURE-INVENTORY.md`'s Ollama row describes as still absent.
 *
 * It means batch pull only and never money: there is no price, checkout,
 * account, or entitlement concept anywhere in this module. A `PullQueueItem`
 * is a download job, nothing else.
 */

/**
 * `queued`    — accepted into the batch, not yet started.
 * `pulling`   — an active `/api/pull` stream is in flight for this item.
 * `pulled`    — the runtime reported `"status":"success"` (or, after a
 *               restart, the tag was found already installed on reconcile).
 * `skipped`   — never downloaded because the tag was already installed when
 *               the batch was started and the caller did not ask to force a
 *               re-pull — the honest "nothing to do" outcome, not a failure.
 * `cancelled` — the user cancelled this item (or the whole batch) before it
 *               reached a terminal state.
 * `failed`    — the pull ended in an error. A failed item never becomes
 *               `pulled`, and a failed item is never turned into a deletion
 *               of any existing installed model — see `pull-queue-engine.ts`.
 */
export type PullItemStatus = "queued" | "pulling" | "pulled" | "skipped" | "cancelled" | "failed";

export interface PullQueueItem {
  id: string;
  tag: string;
  status: PullItemStatus;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * Bytes received so far, aggregated across every digest (layer) the
   * runtime has reported progress for. Never a synthesised percentage —
   * only real numbers the runtime sent.
   */
  receivedBytes: number;
  /**
   * Bytes known-so-far across every digest the runtime has *started*
   * reporting on. This is a lower bound until the pull finishes: Ollama
   * discloses each layer's total only once it starts that layer, so early
   * in a multi-layer pull this number still grows. `totalKnown` says
   * whether any real total has been reported at all.
   */
  totalBytes: number;
  /** False until the first sized status line arrives — the honest "indeterminate" flag. */
  totalKnown: boolean;
  /** The runtime's own last status string ("pulling manifest", "verifying sha256 digest", …), shown verbatim. */
  lastStatusMessage: string | null;
  /**
   * Best-effort pre-pull size estimate, reused from an existing installed
   * catalog entry with the same tag. Ollama's documented local API has no
   * "how big is this before I pull it" route for a tag that is not already
   * installed, so this is `null` for a genuinely new pull — never guessed.
   */
  estimatedSizeBytes: number | null;
  error: string | null;
}

export interface PullQueueState {
  version: 1;
  items: PullQueueItem[];
}

export type PullQueueOutcome = "empty" | "in-progress" | "complete-success" | "complete-partial";

export interface PullQueueSummary {
  total: number;
  queued: number;
  pulling: number;
  pulled: number;
  skipped: number;
  cancelled: number;
  failed: number;
  /**
   * `complete-success` only when every item reached `pulled` or `skipped` —
   * never when any item is `failed`. A failed item can never turn this
   * green; see the module header of `pull-queue-engine.ts`.
   */
  outcome: PullQueueOutcome;
}

export function summarizePullQueue(items: PullQueueItem[]): PullQueueSummary {
  const summary: PullQueueSummary = {
    total: items.length,
    queued: 0,
    pulling: 0,
    pulled: 0,
    skipped: 0,
    cancelled: 0,
    failed: 0,
    outcome: "empty",
  };
  for (const item of items) {
    if (item.status === "queued") summary.queued += 1;
    else if (item.status === "pulling") summary.pulling += 1;
    else if (item.status === "pulled") summary.pulled += 1;
    else if (item.status === "skipped") summary.skipped += 1;
    else if (item.status === "cancelled") summary.cancelled += 1;
    else if (item.status === "failed") summary.failed += 1;
  }
  if (summary.total === 0) {
    summary.outcome = "empty";
  } else if (summary.queued > 0 || summary.pulling > 0) {
    summary.outcome = "in-progress";
  } else if (summary.failed > 0 || summary.cancelled > 0) {
    // A failed item never turns the batch green — and neither does a
    // cancelled one: the user (or the process) stopped something short of
    // finishing, which is not the same claim as "everything succeeded".
    summary.outcome = "complete-partial";
  } else {
    // Every item is `pulled` or `skipped` — the honest all-clear.
    summary.outcome = "complete-success";
  }
  return summary;
}
