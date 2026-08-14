/**
 * React bindings over the module-level School Mode store.
 *
 * Split from `client.ts` for the same reason `LanguageVoice.tsx`'s
 * `useVocabulary()` lives outside `personal-vocabulary.ts`: that module has
 * to stay free of React so `resolve.ts` — a plain function `t()` calls on
 * every render — can import it with no renderer anywhere in its dependency
 * graph.
 */

import { useSyncExternalStore } from "react";
import { getSchoolModeSnapshot, isSchoolModeActive, subscribeSchoolMode, type SchoolModeState } from "./client";

/**
 * Whether School Mode is currently forcing English presentation.
 *
 * Used by `LanguageProvider` as an extra dependency on its `t` callback: the
 * callback's own arguments (`locale`, `funny`) do not change when School Mode
 * flips, so without this every component reading `useT()` would keep
 * rendering stale text until something unrelated happened to re-render the
 * tree. Subscribing here gives `t` a new identity the instant the mode
 * changes, which is what actually makes every surface update live.
 */
export function useSchoolModeActive(): boolean {
  return useSyncExternalStore(subscribeSchoolMode, isSchoolModeActive, isSchoolModeActive);
}

/** The full state, for the School Mode card and any other UI that needs more than the boolean. */
export function useSchoolModeSnapshot(): SchoolModeState {
  return useSyncExternalStore(subscribeSchoolMode, getSchoolModeSnapshot, getSchoolModeSnapshot);
}
