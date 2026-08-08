/**
 * Browser-style tab state for the M3 shell.
 *
 * The active tab owns page navigation, so it still writes `#page` through the
 * existing hash router — back/forward and deep links keep working.
 *
 * Persisted under `ocx-m3:tabs` rather than inside `ocx-m3:v1`: appearance prefs
 * and tab state change at very different rates, and sharing one key would mean
 * two independent writers racing to clobber each other's last value.
 *
 * ## Why this file has no rules in it
 *
 * It used to. `openPage`, `closeTab`, `togglePin`, `moveTab` and the rest were
 * written out here as `useCallback`s over `setState`, beside a byte-identical
 * second copy of the same decisions in `shared/m3/tabs.ts` that the docs site
 * used. Two copies of a rule is two rules the moment either is edited, and this
 * pair had already drifted in a way that mattered: the shared module grew tab
 * *groups* — create, name, colour, reorder, collapse, persist — and this one
 * never did, so the dashboard was the only M3 surface in the repository whose
 * tabs could not be grouped.
 *
 * So the rules moved out and this became what the docs site's hook already was:
 * `useState`, persistence under a key this surface owns, and telling the router
 * when the front tab has changed page. Everything else — what a pin protects,
 * where a group's run sits, which tabs a bulk close removes, that collapsing a
 * group moves the selection out of it — is `shared/m3/tabs.ts`, imported rather
 * than restated. The one thing that stayed is the signature, so the strip, the
 * router glue and their tests did not have to move at the same time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as engine from "../../../shared/m3/tabs";
import { VALID_PAGES, type Page } from "../app-routing";

const TABS_KEY = "ocx-m3:tabs";

/**
 * The shared model, pinned to this surface's page identity.
 *
 * The engine is generic over the page type because the docs site's tabs are URL
 * paths while these are route ids out of a fixed table. Fixing the parameter
 * here means nothing downstream — the strip, the searches, the tests — has to
 * know the engine is generic at all.
 */
export type Tab = engine.Tab<Page>;
export type TabsState = engine.TabsState<Page>;
export type { TabGroup, TabStyle } from "../../../shared/m3/tabs";

/** Rejects a page id read back out of storage that is no longer a real route. */
function isValidPage(value: unknown): value is Page {
  return typeof value === "string" && VALID_PAGES.has(value as Page);
}

/* ------------------------------------------------ the shared pure layer -- */

/**
 * The pure decisions, re-exported so callers import them from one place.
 *
 * `bulkCloseTargets` above all: it is the single answer to "what would this
 * close", read by both the confirmation preview and the close itself. A preview
 * computed by one copy and a close performed by another is a dialog that shows
 * the user four tabs and shuts five.
 */
export {
  MIN_TAB_WIDTH,
  TAB_MATCH_FLAGS,
  newTabId,
  orderTabs,
  splitTabs,
  visibleTabs,
  closeOthersTargets,
  closeToRightTargets,
  bulkCloseTargets,
  clampToViewport,
  tabMatcher,
  tabStyleProps,
} from "../../../shared/m3/tabs";
export type { TabMatcher, TabRow, BulkCloseOptions, TabSplit } from "../../../shared/m3/tabs";

export interface TabsApi {
  tabs: Tab[];
  groups: engine.TabGroup[];
  activeTab: string;
  activePage: Page;
  /** Strip order minus the members of collapsed groups. */
  visible: Tab[];
  /** Focus the tab already showing `page`, or open a new one. */
  openPage: (page: Page, newTab?: boolean) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  /** Close a computed set in one commit — see `bulkCloseTargets`. */
  closeTabs: (ids: string[]) => void;
  /** Everything but `keepId` and the pinned tabs. */
  closeOthers: (keepId: string) => void;
  /** Everything after `fromId` in strip order, pinned tabs excepted. */
  closeToRight: (fromId: string) => void;
  /** A second tab on the same page, carrying the original's appearance. */
  duplicateTab: (id: string) => void;
  togglePin: (id: string) => void;
  moveTab: (fromId: string, toId: string) => void;
  /**
   * Merge a per-tab appearance override. The caller records the revision,
   * because only it can name the change in the user's language.
   */
  setTabStyle: (id: string, patch: engine.TabStyle) => void;
  /** Point the active tab at a different page without opening one (hash sync). */
  setActivePage: (page: Page) => void;
  /** Returns the new group's id, which the caller usually wants immediately. */
  createGroup: (name: string, memberIds?: string[]) => string;
  renameGroup: (id: string, name: string) => void;
  setGroupColor: (id: string, color?: string) => void;
  setGroupStyle: (id: string, patch: engine.TabStyle) => void;
  toggleGroupCollapsed: (id: string) => void;
  removeGroup: (id: string) => void;
  moveGroup: (fromId: string, toId: string) => void;
  assignGroup: (tabId: string, groupId?: string) => void;
}

export function useTabs(initialPage: Page, onPageChange: (page: Page) => void): TabsApi {
  const [state, setState] = useState<TabsState>(() => {
    let raw: unknown = null;
    try {
      if (typeof localStorage !== "undefined") raw = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
    } catch { /* corrupt or unavailable storage falls through to a fresh strip */ }
    // No `adoptPage` here, unlike the docs site. That surface restores into a
    // document the browser has already loaded, so the URL has to win; this one
    // restores a strip and *then* hears the hash through `setActivePage` below,
    // which is the same correction arriving by the route the router owns.
    return engine.reviveTabs(raw, isValidPage, initialPage);
  });

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }, [state]);

  const activePage = state.tabs.find(t => t.id === state.activeTab)?.page ?? "dashboard";

  // Keep the hash in step with whichever tab is in front, without re-firing on our own writes.
  const lastPushed = useRef<Page | null>(null);
  useEffect(() => {
    if (lastPushed.current === activePage) return;
    lastPushed.current = activePage;
    onPageChange(activePage);
  }, [activePage, onPageChange]);

  const visible = useMemo(() => engine.visibleTabs(state), [state]);

  /**
   * Every command, bound to `setState`.
   *
   * Built once with `useMemo` rather than as twenty `useCallback`s: they have no
   * dependencies beyond `setState`, which React guarantees is stable, so this is
   * one object identity for the life of the component and effects that depend on
   * a command do not re-subscribe on every render.
   */
  const api = useMemo(() => ({
    openPage: (page: Page, newTab = false) => setState(s => engine.openPage(s, page, { newTab })),
    selectTab: (id: string) => setState(s => engine.selectTab(s, id)),
    closeTab: (id: string) => setState(s => engine.closeTab(s, id)),
    closeTabs: (ids: string[]) => setState(s => engine.closeTabs(s, ids)),
    closeOthers: (keepId: string) => setState(s => engine.closeOthers(s, keepId)),
    closeToRight: (fromId: string) => setState(s => engine.closeToRight(s, fromId)),
    duplicateTab: (id: string) => setState(s => engine.duplicateTab(s, id)),
    togglePin: (id: string) => setState(s => engine.togglePin(s, id)),
    moveTab: (fromId: string, toId: string) => setState(s => engine.moveTab(s, fromId, toId)),
    setTabStyle: (id: string, patch: engine.TabStyle) => setState(s => engine.setTabStyle(s, id, patch)),
    renameGroup: (id: string, name: string) => setState(s => engine.renameGroup(s, id, name)),
    setGroupColor: (id: string, color?: string) => setState(s => engine.setGroupColor(s, id, color)),
    setGroupStyle: (id: string, patch: engine.TabStyle) => setState(s => engine.setGroupStyle(s, id, patch)),
    toggleGroupCollapsed: (id: string) => setState(s => engine.toggleGroupCollapsed(s, id)),
    removeGroup: (id: string) => setState(s => engine.removeGroup(s, id)),
    moveGroup: (fromId: string, toId: string) => setState(s => engine.moveGroup(s, fromId, toId)),
    assignGroup: (tabId: string, groupId?: string) => setState(s => engine.assignGroup(s, tabId, groupId)),
  }), []);

  /**
   * Adopting a navigation the router performed.
   *
   * Separate from the memo above because it also has to record the page as
   * already pushed. Without that, telling the strip "we are now on #x" would
   * make the effect above turn round and ask the router to navigate to #x —
   * adding a history entry for a Back the user just pressed, and making Back
   * look like it does nothing.
   */
  const setActivePage = useCallback((page: Page) => {
    lastPushed.current = page;
    setState(s => engine.setActivePage(s, page));
  }, []);

  const createGroup = useCallback((name: string, memberIds: string[] = []) => {
    const id = engine.newTabId("g");
    setState(s => engine.createGroup(s, id, name, memberIds));
    return id;
  }, []);

  return {
    tabs: state.tabs,
    groups: state.groups,
    activeTab: state.activeTab,
    activePage,
    visible,
    setActivePage,
    createGroup,
    ...api,
  };
}
