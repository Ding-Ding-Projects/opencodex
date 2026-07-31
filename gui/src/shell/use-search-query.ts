/**
 * One search bar's state: its text, its mode, its flags, and the predicate they
 * compile to.
 *
 * Every tab search in the shell holds one of these, and holds its *own* — the
 * strip search, each group's search, the group search and the master search all
 * call this hook separately. That is the rule ("never share hidden state with
 * another field") expressed as a data structure rather than as a discipline: two
 * fields cannot drift into each other's query because there is no object for
 * them to share, and no amount of later editing can accidentally introduce one
 * without deleting a hook call.
 *
 * The predicate is `tabMatcher` from the shared tab engine — the same one the
 * two bulk closes compile. Using it everywhere is what makes "the pattern the
 * builder previewed" and "the pattern the field runs" the same sentence.
 *
 * Plain text is the default and regex is an explicit opt-in, so a user who types
 * `c++` gets the results they meant rather than a syntax error. Applying a
 * pattern from the anchored builder switches the mode as part of the same
 * commit: a pattern dropped into a field still in plain-text mode is matched
 * literally, which silently finds nothing and reads as a broken search.
 *
 * What this hook deliberately does NOT do: run a search, debounce, or touch
 * storage. It compiles a query; the surface decides what to run it against.
 */

import { useCallback, useMemo, useState } from "react";
import { TAB_MATCH_FLAGS, tabMatcher, type TabMatcher } from "./use-tabs";

export interface SearchQueryState {
  query: string;
  setQuery: (next: string) => void;
  regex: boolean;
  setRegex: (next: boolean) => void;
  flags: string;
  /** `{ok:true,test}` or why it is not runnable — empty, or invalid with the engine's message. */
  matcher: TabMatcher;
  /** The compiler's message when the pattern will not compile, else null. */
  error: string | null;
  /** What the anchored regex builder calls on Apply: pattern, flags and mode in one commit. */
  apply: (pattern: string, flags: string) => void;
}

export function useSearchQuery(initialFlags: string = TAB_MATCH_FLAGS): SearchQueryState {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [flags, setFlags] = useState(initialFlags);

  const matcher = useMemo(() => tabMatcher(query, regex, flags), [query, regex, flags]);

  const apply = useCallback((pattern: string, appliedFlags: string) => {
    setQuery(pattern);
    setFlags(appliedFlags);
    setRegex(true);
  }, []);

  return {
    query,
    setQuery,
    regex,
    setRegex,
    flags,
    matcher,
    error: matcher.ok === false && matcher.reason === "invalid" ? matcher.error : null,
    apply,
  };
}
