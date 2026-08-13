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
 *
 * The cross-page index is the one thing that *is* shared, and it is shared as
 * data rather than as state for exactly that reason: every bar reads the same
 * registry, and none of them can write to another bar's query by doing so.
 */

import { useMemo, useState } from "react";
import { useT } from "../i18n/shared";
import { DEFAULT_SEARCH_FLAGS, runSettingsSearch } from "./settings-search";
import { settingsElsewhere } from "./settings-registry";
// Imported for its side effect, and imported *here* rather than at the app root.
// The index describes screens that are not open, so it has to be populated before
// any search runs; hanging that off the one module every settings search already
// goes through is what makes it unconditional. A registration line in `App.tsx`
// would be one line nobody notices is missing until a search quietly stops
// finding half the app.
import "./settings-registry-entries";
import type { SettingsPageId } from "./settings-registry";
import type { ElsewhereOption, SettingsOption, SettingsSearchResult } from "./settings-search";

/**
 * What this surface is, for the cross-page report.
 *
 * A page id means "I am that screen": everything the registry holds for every
 * *other* screen becomes elsewhere. `"all"` means "I am not a screen at all" —
 * a popover, an anchored editor, a dialog — where nothing on show is "here" and
 * so the whole index is elsewhere. Omitting it altogether opts out of the report.
 */
export type SettingsSearchScope = SettingsPageId | "all";

export interface UseSettingsSearchInput {
  options: readonly SettingsOption[];
  /**
   * The page this surface is, in the router's own names, so a query typed here
   * can report matches on other screens by the name the navigation gives them.
   *
   * Omitted, the surface does not participate in the cross-page report at all,
   * which is right for a search over something that is not settings — and is
   * what every existing caller got before the registry existed.
   */
  scope?: SettingsSearchScope;
  /**
   * Settings on other surfaces, stated explicitly.
   *
   * Overrides the registry when given, for a surface whose neighbour is not a
   * page — the Claude tab's sibling Desktop tab, for instance. Prefer `scope`: a
   * hand-passed list is a list somebody has to remember to update, which is the
   * failure the registry exists to end.
   */
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
export function useSettingsSearch({ options, scope, elsewhere, activeTab }: UseSettingsSearchInput): SettingsSearch {
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const t = useT();

  // `t` is stable per locale and per funny level, so the index resolves once
  // rather than on every keystroke — and re-resolves, correctly, the moment the
  // user changes language. A cross-page hit has to name the neighbouring screen
  // in the words the navigation is currently showing, not the words it was
  // showing when this component first mounted.
  const fromRegistry = useMemo(
    () => (scope === undefined ? undefined : settingsElsewhere(scope === "all" ? undefined : scope, t)),
    [scope, t],
  );

  const resolvedElsewhere = elsewhere ?? fromRegistry;

  const result = useMemo(
    () => runSettingsSearch({ options, elsewhere: resolvedElsewhere, activeTab, query, useRegex, flags }),
    [options, resolvedElsewhere, activeTab, query, useRegex, flags],
  );

  return { ...result, query, setQuery, useRegex, setUseRegex, flags, setFlags };
}
