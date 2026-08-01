/**
 * Click, shift-click range and select-all, over an ordered list of ids.
 *
 * The twin of `src/lib/bulk-actions.ts`'s selection model. It is a twin rather
 * than an import because the dashboard is built by Vite from `gui/src` alone and
 * reaching across into the server's tree would drag a server module into the
 * browser bundle for the sake of four set operations. `src/lib` stays the
 * authority for what a bulk action *means* — scope, skips, honest summaries —
 * and this is only the pointer arithmetic.
 *
 * Plain functions over a `Set` rather than a hook, so the list component keeps
 * the set in its own state and stays the single source of truth. Every one
 * returns a new set: mutating in place is how a React list stops re-rendering
 * and starts looking broken.
 */

/** Add `id` if absent, remove it if present. */
export function toggle(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Shift-click: select the run between `anchor` and `id`, inclusive.
 *
 * Adds rather than replaces, so extending with a second range keeps the first —
 * which is what every file manager does, and therefore what people expect
 * without being told. An id missing from `order` (a row filtered away between
 * the two clicks) falls back to a plain toggle rather than selecting a range
 * computed from -1, which would silently sweep in the whole list.
 */
export function selectRange(
  selected: ReadonlySet<string>,
  order: readonly string[],
  anchor: string,
  id: string,
): Set<string> {
  const from = order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from === -1 || to === -1) return toggle(selected, id);
  const [start, end] = from <= to ? [from, to] : [to, from];
  const next = new Set(selected);
  for (const candidate of order.slice(start, end + 1)) next.add(candidate);
  return next;
}

/**
 * Everything currently listed.
 *
 * What "all" means is the caller's `order`, which is why the bar names the
 * scope out loud: on a filtered list, passing the filtered ids and calling it
 * "select all" is the difference between a truthful count and a lie.
 */
export function selectAll(order: readonly string[]): Set<string> {
  return new Set(order);
}

/** Flip the selection within the listed set, leaving anything unlisted alone. */
export function invert(selected: ReadonlySet<string>, order: readonly string[]): Set<string> {
  const next = new Set<string>();
  for (const id of order) if (!selected.has(id)) next.add(id);
  return next;
}
