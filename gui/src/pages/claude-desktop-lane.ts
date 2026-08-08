/**
 * Lane density helpers for the Claude Desktop page.
 *
 * These are deliberately pure and rendered-list-only. The page's `modelsByFamily` and
 * `effectiveDefaults` must keep seeing every model: `effectiveDefaults` picks the first
 * AVAILABLE member as a family's fallback, so filtering the source arrays would let a search
 * box silently change which model Claude Desktop resolves. Narrow the rendered slice, never
 * the data.
 */

import { makeMatcher } from "./models-shared";

/** Cards rendered per lane before the pager appears. */
export const LANE_PAGE = 6;
/** Lanes shorter than this need no filter — showing one would be pure noise. */
export const LANE_SEARCH_MIN = 4;

export interface LaneModel {
  route: string;
  label: string;
  available: boolean;
}

export interface LaneView<T extends LaneModel> {
  /** True total for this family, unaffected by search — what the lane header must report. */
  total: number;
  /** Whether the filter input is worth showing at all. */
  showSearch: boolean;
  /** Cards to render now. */
  shown: T[];
  /** How many matches remain behind the pager. */
  hidden: number;
  /** The lane has models, but none match the current query. */
  noMatch: boolean;
  /** Regex compile failure verbatim from the engine; `null` while the pattern is usable. */
  regexError: string | null;
}

/**
 * Plain text is the default and `useRegex` is the caller's explicit opt-in, evaluated
 * locally through the same capped ECMAScript matcher every other search bar uses. An
 * invalid pattern matches nothing and reports itself rather than silently reverting to
 * plain text, so the message and the visible rows always agree.
 */
export function laneView<T extends LaneModel>(
  models: T[],
  search: string,
  limit: number,
  useRegex = false,
): LaneView<T> {
  const matcher = makeMatcher(search, useRegex);
  const matched = search.trim()
    ? models.filter(model => matcher.test(model.label) || matcher.test(model.route))
    : models;
  // Stable partition: available first, server order preserved inside each half.
  const ordered = matched.toSorted((a, b) => Number(!a.available) - Number(!b.available));
  const shown = ordered.slice(0, limit);
  return {
    total: models.length,
    showSearch: models.length > LANE_SEARCH_MIN,
    shown,
    hidden: ordered.length - shown.length,
    // A broken pattern is its own state: reporting it as "no matches" would blame the
    // catalogue for a typo in the box.
    noMatch: matcher.error === null && models.length > 0 && ordered.length === 0,
    regexError: matcher.error,
  };
}

/**
 * Which families start folded when the user has expressed no preference yet.
 *
 * Data-driven rather than a fixed list: every model can be assigned to any family, so
 * hard-coding "only Opus is open" would be wrong the moment someone fills Sonnet. On a
 * fresh install this still yields "Opus open, three empty families folded", which is the
 * shape the vertical stack was designed around.
 */
export function defaultCollapsedFamilies(counts: Readonly<Record<string, number>>): Set<string> {
  return new Set(Object.keys(counts).filter(family => counts[family] === 0));
}

/**
 * Whether a model row starts expanded.
 *
 * A row is collapsed by default EXCEPT the family's resolved default: that is the row a
 * user opens the page to change, so putting it behind a second click would fail the
 * discoverability test progressive disclosure exists to pass.
 */
export function rowStartsOpen(route: string, familyDefault: string | null): boolean {
  return familyDefault !== null && route === familyDefault;
}
