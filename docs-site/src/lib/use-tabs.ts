/**
 * React glue for the shared tab engine.
 *
 * Every decision this hook appears to make is actually made in
 * `shared/m3/tabs.ts` — which tabs a bulk close removes, what a pin protects,
 * where a group's run sits, whether opening a page retargets the front tab.
 * This file contributes three things and no rules: `useState`, persistence
 * under a key this surface owns, and telling the host when the front tab has
 * moved to a different page.
 *
 * That split is deliberate. The dashboard and this site must not disagree about
 * tab semantics, and the reliable way to guarantee that is for the semantics to
 * exist once, as pure functions, in a module neither surface can quietly edit
 * "just for itself". It also keeps the shared module free of a `react` import,
 * which a module outside every package cannot resolve to the consumer's copy —
 * the "Invalid hook call" trap, and a test-runner failure besides.
 *
 * Persistence lives under its own key rather than inside the appearance
 * preferences: the two change at very different rates, and sharing one key
 * means two independent writers racing to clobber each other's last value.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as tabs from "../../../shared/m3/tabs";
import type { Tab, TabGroup, TabStyle, TabsState } from "../../../shared/m3/tabs";

export interface UseTabsOptions<P extends string> {
  /** The page the strip should be showing: the document that is actually loaded. */
  initialPage: P;
  /** Its label, for a strip with nothing persisted yet. */
  initialLabel?: string;
  /** Rejects anything read back out of storage that is no longer a real route. */
  isValidPage: (value: unknown) => value is P;
  storageKey: string;
  /** Called when the front tab moves to a different page, so the host can navigate. */
  onPageChange?: (page: P) => void;
}

export interface TabsApi<P extends string> {
  tabs: Tab<P>[];
  groups: TabGroup[];
  activeTab: string;
  activePage: P;
  /** Strip order minus the members of collapsed groups. */
  visible: Tab<P>[];
  openPage: (page: P, options?: { newTab?: boolean; label?: string }) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeTabs: (ids: string[]) => void;
  closeOthers: (keepId: string) => void;
  closeToRight: (fromId: string) => void;
  duplicateTab: (id: string) => void;
  togglePin: (id: string) => void;
  moveTab: (fromId: string, toId: string) => void;
  setTabStyle: (id: string, patch: TabStyle) => void;
  setTabLabel: (id: string, label: string) => void;
  setActivePage: (page: P, label?: string) => void;
  createGroup: (name: string, memberIds?: string[]) => string;
  renameGroup: (id: string, name: string) => void;
  setGroupColor: (id: string, color?: string) => void;
  setGroupStyle: (id: string, patch: TabStyle) => void;
  toggleGroupCollapsed: (id: string) => void;
  removeGroup: (id: string) => void;
  moveGroup: (fromId: string, toId: string) => void;
  assignGroup: (tabId: string, groupId?: string) => void;
}

export function useTabs<P extends string>(options: UseTabsOptions<P>): TabsApi<P> {
  const { initialPage, initialLabel, isValidPage, storageKey, onPageChange } = options;

  // Read through a ref so a caller passing an inline arrow does not re-run the
  // storage-reading initializer on every render.
  const validate = useRef(isValidPage);
  validate.current = isValidPage;

  const [state, setState] = useState<TabsState<P>>(() => {
    let raw: unknown = null;
    try {
      if (typeof localStorage !== "undefined") raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch { /* corrupt or blocked storage falls through to a fresh strip */ }
    // The loaded document wins over the persisted active tab: the reader typed
    // an address or followed a link, and restoring some other tab would
    // navigate them away from the page they asked for one frame after it
    // appeared. See `adoptPage`.
    return tabs.adoptPage(tabs.reviveTabs(raw, validate.current, initialPage, initialLabel), initialPage, initialLabel);
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* quota or private mode */ }
  }, [state, storageKey]);

  const activePage = (state.tabs.find(t => t.id === state.activeTab)?.page ?? initialPage) as P;

  /* Tell the host which page is in front, without re-firing on its own answer.
     `lastPushed` starts at the page the strip mounted showing, so the first
     effect pass never navigates: the document is already there. */
  const lastPushed = useRef<P | null>(initialPage);
  useEffect(() => {
    if (lastPushed.current === activePage) return;
    lastPushed.current = activePage;
    onPageChange?.(activePage);
  }, [activePage, onPageChange]);

  const visible = useMemo(() => tabs.visibleTabs(state), [state]);

  /**
   * Every command, bound to `setState`.
   *
   * Built once with `useMemo` rather than as twenty `useCallback`s: they have no
   * dependencies beyond `setState`, which React guarantees is stable, so this is
   * one object identity for the life of the component and effects that depend on
   * a command do not re-subscribe on every render.
   */
  const api = useMemo(() => ({
    openPage: (page: P, opts?: { newTab?: boolean; label?: string }) =>
      setState(s => tabs.openPage(s, page, opts)),
    selectTab: (id: string) => setState(s => tabs.selectTab(s, id)),
    closeTab: (id: string) => setState(s => tabs.closeTab(s, id)),
    closeTabs: (ids: string[]) => setState(s => tabs.closeTabs(s, ids)),
    closeOthers: (keepId: string) => setState(s => tabs.closeOthers(s, keepId)),
    closeToRight: (fromId: string) => setState(s => tabs.closeToRight(s, fromId)),
    duplicateTab: (id: string) => setState(s => tabs.duplicateTab(s, id)),
    togglePin: (id: string) => setState(s => tabs.togglePin(s, id)),
    moveTab: (fromId: string, toId: string) => setState(s => tabs.moveTab(s, fromId, toId)),
    setTabStyle: (id: string, patch: TabStyle) => setState(s => tabs.setTabStyle(s, id, patch)),
    setTabLabel: (id: string, label: string) => setState(s => tabs.setTabLabel(s, id, label)),
    renameGroup: (id: string, name: string) => setState(s => tabs.renameGroup(s, id, name)),
    setGroupColor: (id: string, color?: string) => setState(s => tabs.setGroupColor(s, id, color)),
    setGroupStyle: (id: string, patch: TabStyle) => setState(s => tabs.setGroupStyle(s, id, patch)),
    toggleGroupCollapsed: (id: string) => setState(s => tabs.toggleGroupCollapsed(s, id)),
    removeGroup: (id: string) => setState(s => tabs.removeGroup(s, id)),
    moveGroup: (fromId: string, toId: string) => setState(s => tabs.moveGroup(s, fromId, toId)),
    assignGroup: (tabId: string, groupId?: string) => setState(s => tabs.assignGroup(s, tabId, groupId)),
  }), []);

  /**
   * Adopting a navigation the host performed.
   *
   * Separate from the memo above because it also has to record the page as
   * already pushed. Without that, telling the strip "we are now on /x/" would
   * make the effect above turn round and ask the host to navigate to /x/ —
   * adding a history entry for a Back the reader just pressed, and making Back
   * look like it does nothing.
   */
  const setActivePage = useCallback((page: P, label?: string) => {
    lastPushed.current = page;
    setState(s => tabs.setActivePage(s, page, label));
  }, []);

  /** Returns the new group's id, which the caller usually wants immediately. */
  const createGroup = useCallback((name: string, memberIds: string[] = []) => {
    const id = tabs.newTabId("g");
    setState(s => tabs.createGroup(s, id, name, memberIds));
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
