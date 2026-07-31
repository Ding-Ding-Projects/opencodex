/**
 * The React face of the language store.
 *
 * Split from `index.ts` so that a plain `<script>`, an `.astro` component and a
 * test can read the same store without importing React — which matters here more
 * than it usually does, because the whole point of `retranslate` is that the
 * server-rendered chrome works before any React exists on the page.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: every island is its
 * own React root, and the store is shared between them. An effect-based
 * subscription would let one island render one frame with a stale mode after
 * another island changed it — visible as the tab strip and the settings page
 * briefly disagreeing about what language the site is in.
 *
 * The server snapshot is not decoration. Two of the chrome islands are hydrated
 * rather than client-only — the site search and the settings search — so their
 * first client render has to reproduce markup a server produced without ever
 * seeing `localStorage`. `useChromeT` takes the page's content locale for
 * exactly that, and `useUi` does not need one because every surface that calls
 * it is `client:only` and therefore never hydrates.
 */

import { useMemo, useSyncExternalStore } from "react";
import {
  getUiState,
  installUiRuntime,
  setFunny,
  setMode,
  subscribeUi,
  serverSnapshotFor,
  t,
  tParts,
  translatorFor,
  type FunnyLevels,
  type UiKey,
  type UiMode,
  type UiState,
} from "./index";
import type { Vars } from "../../../../shared/m3/i18n";
import type { TFn } from "../strings";
import type { DocsLocale } from "../routes";

export interface UiApi extends UiState {
  setMode: (mode: UiMode) => void;
  setFunny: (patch: Partial<FunnyLevels>) => void;
  t: (key: UiKey, vars?: Vars) => string;
  tParts: (key: UiKey, vars?: Vars) => { primary: string; secondary: string };
}

/**
 * Installing the runtime here rather than in a top-level effect is deliberate:
 * the first island to render wires the document listeners, and the guard inside
 * `installUiRuntime` makes every subsequent call free. A `useEffect` would
 * install it one frame later, which is one frame in which an `astro:page-load`
 * could be missed on the very first navigation.
 */
export function useUi(): UiApi {
  installUiRuntime();
  const state = useSyncExternalStore(subscribeUi, getUiState, getUiState);
  return { ...state, setMode, setFunny, t, tParts };
}

/** For a component that only renders copy. */
export function useT(): (key: UiKey, vars?: Vars) => string {
  return useUi().t;
}

/**
 * A `TFn` over the reader's chosen interface language, for the components that
 * were written against `strings.ts`'s `translator(locale)`.
 *
 * Those components — the tab strip, the site search, the settings search, the
 * regex builder — take their translator as a value rather than resolving a
 * locale for themselves, which is what makes this a drop-in: hand them
 * `translator(contentLocale)` and they speak the page's language; hand them this
 * and they speak the reader's, funny level included. Same components, same keys,
 * no fork, and the swap is one line at each call site.
 *
 * ## `contentLocale` is not optional in spirit
 *
 * It is what the **server** rendered, and two of the call sites are hydrated
 * rather than client-only. Without it the first client render would ask the live
 * store — which on `/ja/` says Japanese while the server's markup says English —
 * and React 19 answers a text mismatch by discarding the tree. That is not a
 * warning in a console nobody reads: it is an empty search box on every
 * non-English locale, from a build that reported success. Measured, not
 * theorised: a headless run at 430x932 threw React #418 on `/ja/guides/docker/`
 * and on nothing else, which is exactly the set of pages where the two axes
 * disagree at hydration time.
 *
 * `useSyncExternalStore` re-renders with the reader's real answer on the commit
 * straight after hydration, so the correction is not something anyone can see.
 */
export function useChromeT(contentLocale: DocsLocale = "root"): TFn {
  installUiRuntime();
  // Identity-stable: React calls `getServerSnapshot` during hydration and will
  // loop if it is handed a fresh object each render.
  const server = useMemo(() => serverSnapshotFor(contentLocale), [contentLocale]);
  const state = useSyncExternalStore(subscribeUi, getUiState, () => server);
  return useMemo(
    () => translatorFor(state.resolved, state.funny),
    [state.resolved, state.funny.en, state.funny.yue],
  );
}
