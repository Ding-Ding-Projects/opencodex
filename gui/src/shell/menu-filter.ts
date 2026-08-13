/**
 * The one filter predicate every dropdown, combobox and context menu in this
 * app shares — the logic half of "every dropdown carries a search bar wired to
 * the full regex builder". `MenuFilterField.tsx` is the presentational half.
 *
 * Reuses `tabMatcher` from `shared/m3/tabs.ts` rather than inventing a second
 * predicate: it is already the one the tab strip, `TabSearchPanel` and
 * `FontPicker` all compile a menu's visible rows through, and a second copy
 * here would be a second place for plain-text-vs-regex, casing or an empty
 * query to mean something slightly different. An empty query is not a filter —
 * every row stays visible — and only a pattern that fails to compile hides
 * everything, which `matcher.reason` distinguishes from "nothing matched" so a
 * caller can report the right one.
 *
 * What this module deliberately does NOT do: render anything, look up a
 * translation, or own focus. It takes a labeled row set and a filter state and
 * returns which rows survive; `MenuFilterField` and each menu's own keyboard
 * handling are what turn that into a usable control.
 */

import { isValidElement, useMemo, useState, type ReactNode } from "react";
import { tabMatcher, TAB_MATCH_FLAGS, type TabMatcher } from "../../../shared/m3/tabs";

/** The flags every menu filter compiles, restated so a caller need not reach
 * into `shared/m3/tabs.ts` just to pass its own flags back to itself. */
export const MENU_FILTER_FLAGS = TAB_MATCH_FLAGS;

export interface MenuFilterState {
  query: string;
  regex: boolean;
}

export const EMPTY_MENU_FILTER: MenuFilterState = { query: "", regex: false };

/**
 * Filter any labeled row set with the shared predicate.
 *
 * `matcher` is returned alongside `visible` so a caller can tell "nothing
 * matched" apart from "the pattern does not compile" and report the right
 * message — a menu that goes silently blank on a bad pattern is
 * indistinguishable from one that just broke.
 */
export function filterMenuRows<T>(
  rows: readonly T[],
  labelOf: (row: T) => string,
  state: MenuFilterState,
): { visible: T[]; matcher: TabMatcher } {
  const matcher = tabMatcher(state.query, state.regex);
  if (matcher.ok) return { visible: rows.filter(row => matcher.test(labelOf(row))), matcher };
  // An empty query compiles to nothing, deliberately: `tabMatcher` treats a
  // blank field as "no filter" rather than "match nothing", so the unfiltered
  // list is what "empty" means here too.
  if (matcher.reason === "empty") return { visible: [...rows], matcher };
  return { visible: [], matcher };
}

export interface UseMenuFilterResult<T> {
  query: string;
  setQuery: (query: string) => void;
  regex: boolean;
  setRegex: (regex: boolean) => void;
  /** The rows that survive the current query, in their original order. */
  visible: T[];
  matcher: TabMatcher;
  /** Every row's label, joined for the builder — a pattern is tried against
   * the real corpus rather than sample text the user has to invent. */
  sample: string;
}

/**
 * One menu's filter state, plus the rows it currently shows.
 *
 * `rows` and `labelOf` are read fresh every render rather than snapshotted, so
 * a menu whose entries change while it is open (an account added to the pool,
 * a tab overflowing) keeps filtering the live list.
 */
export function useMenuFilter<T>(rows: readonly T[], labelOf: (row: T) => string): UseMenuFilterResult<T> {
  const [state, setState] = useState<MenuFilterState>(EMPTY_MENU_FILTER);
  const { visible, matcher } = useMemo(() => filterMenuRows(rows, labelOf, state), [rows, labelOf, state]);
  return {
    query: state.query,
    setQuery: query => setState(current => ({ ...current, query })),
    regex: state.regex,
    setRegex: regex => setState(current => ({ ...current, regex })),
    visible,
    matcher,
    sample: rows.map(labelOf).join("\n"),
  };
}

/**
 * The plain text inside a `ReactNode` label, for a picker whose options render
 * something richer than a string — `RichSelect`'s model rows carry an icon
 * beside the model id specifically so the icon is not lost to a native
 * `<option>`'s plain-text rendering, which leaves the label itself a small
 * element tree rather than a string a filter can match directly.
 *
 * Walks strings, numbers, arrays and one level of element children — enough
 * for "an icon plus a text run", which is every label this app actually
 * builds. An icon component renders no string children of its own, so it
 * contributes nothing to the extracted text and the filter matches only the
 * words a user actually reads.
 */
export function reactNodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return reactNodeText(props.children);
  }
  return "";
}

/**
 * Focus an element by id, tolerating one that is not there.
 *
 * Every converted menu moves focus into its filter field on open and back out
 * of it on ArrowDown; both are one-liners that would otherwise be repeated at
 * every call site with a slightly different null check.
 */
export function focusMenuFilterField(id: string): void {
  const field = document.getElementById(id) as { focus?: () => void } | null;
  field?.focus?.();
}
