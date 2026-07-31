/**
 * One search bar's state: its text, its mode, its flags, and the predicate they
 * compile to.
 *
 * Every search surface on this site holds one of these, and holds its *own* —
 * the strip search, each group's search, the group search, the master search,
 * the settings search and the site search all call this hook separately. That is
 * the rule ("never share hidden state with another field") expressed as a data
 * structure rather than as a discipline: two fields cannot drift into each
 * other's query because there is no object for them to share.
 *
 * The predicate is `tabMatcher` from `shared/m3/tabs.ts`, which is named for the
 * surface it was written for but is the generic one: trim, lowercase-include for
 * plain text, `new RegExp(pattern.slice(0, 400), flags)` for regex, `lastIndex`
 * reset per call, and an empty query refused rather than treated as match-all.
 * Using it everywhere is what makes "the pattern the builder previewed" and "the
 * pattern the field runs" the same sentence — and what makes the two bulk closes
 * exact inverses, since the negating one negates *this* `test` rather than
 * compiling a second matcher from the same inputs.
 *
 * Plain text is the default and regex is an explicit opt-in, so a reader who
 * types `c++` into a search box gets the results they meant rather than a syntax
 * error. Applying a pattern from the builder switches the mode as part of the
 * same commit — a pattern dropped into a field still in plain-text mode is
 * matched literally, which silently finds nothing and looks like the search is
 * broken.
 *
 * What this hook deliberately does NOT do: run a search, debounce, or touch
 * storage. It compiles a query; the surface decides what to run it against.
 */

import { useCallback, useMemo, useState } from "react";
import { TAB_MATCH_FLAGS, tabMatcher, type TabMatcher } from "../../../shared/m3/tabs";

export interface SearchQueryState {
  query: string;
  setQuery: (next: string) => void;
  regex: boolean;
  setRegex: (next: boolean) => void;
  flags: string;
  setFlags: (next: string) => void;
  /** `{ok:true,test}` or the reason it is not runnable — empty, or invalid with the engine's message. */
  matcher: TabMatcher;
  /** The compiler's message when the pattern will not compile, else null. */
  error: string | null;
  /** True when there is something runnable: a non-empty query that compiles. */
  ready: boolean;
  /** What the regex builder calls on Apply: pattern, flags and mode in one commit. */
  apply: (pattern: string, flags: string) => void;
  clear: () => void;
}

export function useSearchQuery(initialQuery = "", initialFlags: string = TAB_MATCH_FLAGS): SearchQueryState {
  const [query, setQuery] = useState(initialQuery);
  const [regex, setRegex] = useState(false);
  const [flags, setFlags] = useState(initialFlags);

  const matcher = useMemo(() => tabMatcher(query, regex, flags), [query, regex, flags]);

  const apply = useCallback((pattern: string, appliedFlags: string) => {
    setQuery(pattern);
    setFlags(appliedFlags);
    setRegex(true);
  }, []);

  const clear = useCallback(() => setQuery(""), []);

  return {
    query,
    setQuery,
    regex,
    setRegex,
    flags,
    setFlags,
    matcher,
    error: matcher.ok === false && matcher.reason === "invalid" ? matcher.error : null,
    ready: matcher.ok,
    apply,
    clear,
  };
}
