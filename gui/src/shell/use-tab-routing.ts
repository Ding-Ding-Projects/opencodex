/**
 * Wiring the tab strip to the hash router.
 *
 * ## Why this is a module and not two lines in `App`
 *
 * These two surfaces both want to own "which page is showing", and the obvious
 * wiring — an effect each way — is a cycle with no fixed point. That is not a
 * hypothetical: it shipped, and it rendered as the app flipping between two
 * tabs forever with a blank page behind it.
 *
 * The version that failed was:
 *
 * ```ts
 * const tabs = useTabs(page, navigateToPage);
 * useEffect(() => { tabs.setActivePage(page); }, [page, tabs]);
 * useEffect(() => { setPageState(tabs.activePage); }, [tabs.activePage, setPageState]);
 * ```
 *
 * `useTabs` returns a fresh object literal on every render, so `[page, tabs]`
 * changed on every render and the first effect re-ran constantly — applying a
 * `page` that the second effect had not yet caught up to. Selecting tab B while
 * the route still said A made effect 1 pull the strip back to A, effect 2 push
 * "B" into the route, and the next render do the same thing with the two values
 * swapped. Neither side was ever wrong for more than one render, and the pair
 * never agreed.
 *
 * ## The rule this file enforces
 *
 * **The tab strip owns the active page. The hash is an input, never a mirror.**
 *
 * - Tabs → hash is the only writer, and it lives inside `useTabs` where it is
 *   already guarded against re-pushing a page the hash carries.
 * - Hash → tabs runs *only* when the hash actually changes, which needs a
 *   dependency that is stable across renders — hence `setActivePage`, which is
 *   a `useCallback`, rather than the `tabs` object that wraps it.
 * - There is no write-back effect. The round trip already happens: `useTabs`
 *   calls `onPageChange`, which is `navigateToPage`, which sets the route state
 *   itself. The deleted effect was not keeping anything in step that was not
 *   already in step — it was only closing the loop.
 */

import { useEffect } from "react";

import { useAppRouteState } from "../use-app-route-state";
import { useTabs, type TabsApi } from "./use-tabs";

export function useTabRouting(): TabsApi {
  const { page, navigateToPage } = useAppRouteState();
  const tabs = useTabs(page, navigateToPage);
  // Destructured so the dependency below is the stable callback rather than the
  // object identity that made the original effect fire on every render.
  const { setActivePage } = tabs;

  // Hash changes from outside the strip — Back/Forward, a pasted link, a deep
  // link from another screen — retarget the active tab. Nothing here writes the
  // hash: that direction belongs to `useTabs` alone.
  useEffect(() => { setActivePage(page); }, [page, setActivePage]);

  return tabs;
}
