/**
 * The state half of the shared settings search.
 *
 * Separate from `SettingsSearch.tsx` because that file may only export
 * components — the fast-refresh rule the whole GUI is linted under — and because
 * a hook with no markup is the thing a test wants to drive directly.
 *
 * Why a hook and not a context: **each search bar owns its own query.** The rule
 * is explicit that a screen with several search bars gives each its own builder
 * bound to its own field, never one shared builder that applies to whichever
 * field was touched last. A context would have made that mistake the default;
 * calling `useSettingsSearch` twice on one screen gives two independent searches
 * that cannot see each other, which is the behaviour a user assumes.
 */

import { useMemo, useState } from "react";
import { DEFAULT_SEARCH_FLAGS, runSettingsSearch } from "./settings-search";
import type { ElsewhereOption, SettingsOption, SettingsSearchResult } from "./settings-search";

export interface UseSettingsSearchInput {
  options: readonly SettingsOption[];
  /** Settings on other surfaces, so a miss here can still point somewhere. */
  elsewhere?: readonly ElsewhereOption[];
  /** The tab currently showing, when the surface has tabs. */
  activeTab?: string;
}

export interface SettingsSearch extends SettingsSearchResult {
  query: string;
  setQuery: (next: string) => void;
  useRegex: boolean;
  setUseRegex: (next: boolean) => void;
  flags: string;
  setFlags: (next: string) => void;
}

/**
 * One surface's settings search state and result.
 *
 * Flags are state rather than a constant because the contract asks for query,
 * pattern, flags, validation and mode to stay in step with the builder in both
 * directions. A host that pinned flags to `i` would show the user a builder in
 * which turning on `m` or `u` changed the preview and then changed nothing about
 * what the field actually found.
 */
export function useSettingsSearch({ options, elsewhere, activeTab }: UseSettingsSearchInput): SettingsSearch {
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  const result = useMemo(
    () => runSettingsSearch({ options, elsewhere, activeTab, query, useRegex, flags }),
    [options, elsewhere, activeTab, query, useRegex, flags],
  );

  return { ...result, query, setQuery, useRegex, setUseRegex, flags, setFlags };
}
