/**
 * Selection and bulk execution for every list in the app.
 *
 * Selecting one row and repeating an action forty times is the app failing to do
 * its job, so every collection gets this. The interesting part is not the
 * selecting — it is the three places a bulk action lies to people, each of which
 * this refuses to do:
 *
 *  1. **"Select all" that means something other than what it says.** On a filtered
 *     list it can mean the page, or the filter, or the collection. `SelectAllScope`
 *     makes the caller name it and `describe` prints it, so the count on the
 *     button and the rows that change are the same set.
 *
 *  2. **Silently skipping items.** A bulk delete over forty rows where six are
 *     protected must not report forty. `plan` separates `affected` from
 *     `skipped` with a reason on each, before anything runs.
 *
 *  3. **Claiming a whole batch succeeded.** A long run that fails at item thirty
 *     has done twenty-nine things, and saying "done" is false in the direction
 *     that costs the most to discover later. `execute` reports per item and the
 *     summary counts what actually happened.
 *
 * Pure and transport-free: no fetch, no DOM, no store. It decides *what* would
 * happen; the caller does it.
 */

/** What "select all" was asked to mean. Named, because the three differ. */
export type SelectAllScope =
  /** Only the rows currently rendered. */
  | "page"
  /** Every row the active query matches, including those not rendered. */
  | "matching"
  /** Everything in the collection, ignoring the query. */
  | "all";

export interface BulkItem<T> {
  id: string;
  /** Shown in the preview. The label the user recognises the row by. */
  label: string;
  value: T;
}

/** Why an item cannot take part, in words a user can act on. */
export interface Skip {
  id: string;
  label: string;
  reason: string;
}

export interface BulkPlan<T> {
  action: string;
  affected: BulkItem<T>[];
  skipped: Skip[];
  scope: SelectAllScope;
  /** True when the action cannot be undone from version history. */
  destructive: boolean;
  /** True when the caller must block on a confirmation before running. */
  requiresConfirmation: boolean;
}

export interface BulkActionDef<T> {
  id: string;
  label: string;
  /** Destructive actions get a blocking confirmation; the rest get a preview. */
  destructive?: boolean;
  /**
   * Why this item cannot take part, or null when it can.
   *
   * Returning a reason rather than a boolean is the whole point: "6 skipped" is
   * not actionable and "6 skipped: pinned" is.
   */
  skip?: (item: BulkItem<T>) => string | null;
}

/**
 * Work out what a bulk action would do, without doing any of it.
 *
 * Nothing selected is not an error and not a no-op to be run anyway — it is an
 * empty plan, and `describe` says so rather than the caller discovering it by
 * running a batch over zero rows.
 */
export function plan<T>(
  action: BulkActionDef<T>,
  selected: BulkItem<T>[],
  scope: SelectAllScope = "page",
): BulkPlan<T> {
  const affected: BulkItem<T>[] = [];
  const skipped: Skip[] = [];
  for (const item of selected) {
    const reason = action.skip?.(item) ?? null;
    if (reason) skipped.push({ id: item.id, label: item.label, reason });
    else affected.push(item);
  }
  return {
    action: action.label,
    affected,
    skipped,
    scope,
    destructive: !!action.destructive,
    // Only when something would actually happen. A confirmation over an empty
    // plan trains people to click through confirmations.
    requiresConfirmation: !!action.destructive && affected.length > 0,
  };
}

const SCOPE_WORDS: Record<SelectAllScope, string> = {
  page: "on this page",
  matching: "matching the current search",
  all: "in the whole collection",
};

/**
 * The sentence shown above the confirm button.
 *
 * Says the count, the scope and the skips together, because each is misleading
 * without the others: "Delete 40" over a filtered list reads as the collection,
 * and "40 selected" reads as forty changes when six are protected.
 */
export function describe<T>(bulkPlan: BulkPlan<T>): string {
  const { action, affected, skipped, scope } = bulkPlan;
  if (!affected.length) {
    return skipped.length
      ? `${action}: nothing to do — all ${skipped.length} selected item(s) are excluded.`
      : `${action}: nothing selected.`;
  }
  const head = `${action}: ${affected.length} item(s) ${SCOPE_WORDS[scope]}`;
  if (!skipped.length) return `${head}.`;
  const reasons = [...new Set(skipped.map(skip => skip.reason))].join("; ");
  return `${head}. ${skipped.length} excluded (${reasons}).`;
}

export interface ItemOutcome {
  id: string;
  label: string;
  ok: boolean;
  /** The failure, verbatim, so a partial run can be understood afterwards. */
  error?: string;
}

export interface BulkResult {
  action: string;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  outcomes: ItemOutcome[];
  /** The honest one-liner. Never "done" when it was not. */
  summary: string;
}

export interface ExecuteOptions {
  /** Polled between items. Long runs stay cancellable. */
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  /**
   * Stop at the first failure rather than continuing.
   *
   * Off by default: for most bulk actions the user would rather have
   * thirty-nine of forty done and be told about the one, than have the run
   * abandoned at item two.
   */
  stopOnError?: boolean;
}

/**
 * Run the plan, item by item, and report what actually happened.
 *
 * One item's failure never becomes the batch's silence: every outcome is
 * recorded, and the summary counts successes and failures separately rather
 * than collapsing to a boolean.
 */
export async function execute<T>(
  bulkPlan: BulkPlan<T>,
  run: (item: BulkItem<T>) => Promise<void>,
  options: ExecuteOptions = {},
): Promise<BulkResult> {
  const outcomes: ItemOutcome[] = [];
  let cancelled = false;

  for (const [index, item] of bulkPlan.affected.entries()) {
    if (options.isCancelled?.()) { cancelled = true; break; }
    try {
      await run(item);
      outcomes.push({ id: item.id, label: item.label, ok: true });
    } catch (error) {
      outcomes.push({
        id: item.id,
        label: item.label,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.stopOnError) break;
    }
    options.onProgress?.(index + 1, bulkPlan.affected.length);
  }

  const succeeded = outcomes.filter(outcome => outcome.ok).length;
  const failed = outcomes.filter(outcome => !outcome.ok).length;
  const notReached = bulkPlan.affected.length - outcomes.length;

  const parts: string[] = [`${bulkPlan.action}: ${succeeded} succeeded`];
  if (failed) parts.push(`${failed} failed`);
  if (bulkPlan.skipped.length) parts.push(`${bulkPlan.skipped.length} skipped`);
  if (cancelled && notReached > 0) parts.push(`${notReached} not attempted (cancelled)`);
  else if (notReached > 0) parts.push(`${notReached} not attempted (stopped after a failure)`);

  return {
    action: bulkPlan.action,
    succeeded,
    failed,
    skipped: bulkPlan.skipped.length,
    cancelled,
    outcomes,
    summary: parts.join(", ") + ".",
  };
}

// ------------------------------------------------------------- selection model

/**
 * Click, shift-click range, and select-all, over an ordered list of ids.
 *
 * Kept as plain functions over a `Set` rather than a class so a component can
 * hold the set in its own state and stay the single source of truth.
 */
export function toggle(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Shift-click: select the run between the anchor and `id`, inclusive.
 *
 * Adds rather than replaces, so extending a selection with a second range keeps
 * the first — which is what every file manager does and therefore what people
 * expect without being told.
 */
export function selectRange(selected: Set<string>, order: string[], anchor: string, id: string): Set<string> {
  const from = order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from === -1 || to === -1) return toggle(selected, id);
  const [start, end] = from <= to ? [from, to] : [to, from];
  const next = new Set(selected);
  for (const candidate of order.slice(start, end + 1)) next.add(candidate);
  return next;
}

/** Everything currently listed. What "all" means is the caller's `order`. */
export function selectAll(order: string[]): Set<string> {
  return new Set(order);
}

/** Flip the selection within the listed set, leaving anything unlisted alone. */
export function invert(selected: Set<string>, order: string[]): Set<string> {
  const next = new Set<string>();
  for (const id of order) if (!selected.has(id)) next.add(id);
  return next;
}
