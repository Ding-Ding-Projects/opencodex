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
 * ## What lives here and what does not
 *
 * None of the *rules* are in this file. Which tabs a bulk close removes, what a
 * pin protects, where a group's run sits, whether opening a page retargets the
 * front tab — all of it is `shared/m3/tabs.ts`, so the dashboard and the docs
 * site cannot drift into two different answers. This file contributes React
 * glue, persistence under a key this surface owns, and the hash handshake.
 *
 * What it *does* own is the pure search layer below the hook: the four
 * tab-discovery searches turn strip state into rows, and those projections are
 * plain functions on plain data so they can be exercised without mounting
 * anything. A search that can only be tested by rendering a panel is a search
 * nobody tests at the boundaries that matter — a collapsed group, a pinned tab,
 * a peer window that stopped answering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as engine from "../../../shared/m3/tabs";
import { VALID_PAGES, type Page } from "../app-routing";

const TABS_KEY = "ocx-m3:tabs";

/* ------------------------------------------------ the shared pure layer -- */

/**
 * The tab rules live in `shared/m3/tabs.ts`, and this file re-exports them.
 *
 * They were duplicated: byte-identical copies of `splitTabs`,
 * `closeOthersTargets`, `closeToRightTargets`, `bulkCloseTargets` and
 * `clampToViewport` existed here and there, differing only by a generic
 * parameter. Two copies of a rule is two rules the moment either is edited, and
 * for one of these that is not a cosmetic problem: `bulkCloseTargets` is the
 * single answer to "what would this close", read by both the confirmation
 * preview and the close itself. A preview computed by one copy and a close
 * performed by another is a dialog that shows the user four tabs and shuts five.
 *
 * The shared module is the generic one (`Tab<P>` over a page-identity type),
 * because the docs site's tabs are URLs while these are dashboard routes. This
 * file pins the parameter to `Page` so nothing downstream has to know.
 */
export {
  MIN_TAB_WIDTH,
  TAB_MATCH_FLAGS,
  splitTabs,
  closeOthersTargets,
  closeToRightTargets,
  bulkCloseTargets,
  clampToViewport,
  tabMatcher,
  tabStyleProps,
  groupDecorProps,
  groupPinState,
  visibleTabs,
  readGroupDecor,
} from "../../../shared/m3/tabs";
export type {
  TabMatcher, TabRow, BulkCloseOptions, TabStyle, TabGroup, GroupDecor,
} from "../../../shared/m3/tabs";

import type {
  GroupDecor, Tab as EngineTab, TabGroup, TabMatcher, TabStyle, TabsState,
} from "../../../shared/m3/tabs";

/** A dashboard tab: the shared record with its page identity pinned to a route. */
export type Tab = EngineTab<Page>;

/**
 * The id of the panel a given tab controls.
 *
 * Shared by the strip (which writes `aria-controls`) and `App` (which renders
 * the panel), because the two halves of that relationship are in different
 * files and a relationship built from two separately-spelled strings dangles the
 * first time one of them is edited. Every tab keeps its own live panel — the
 * shell keeps them all mounted and hides the inactive ones — so this is a
 * function of the tab id rather than one constant shared by the whole strip.
 */
export const tabPanelId = (tabId: string): string => `ocx-tabpanel-${tabId}`;

/* --------------------------------------------------------- search rows -- */

/**
 * Where a tab is, as any of the four searches has to report it.
 *
 * The rule asks results to identify "the window/workspace, strip, group, pinned
 * state and visible tab label", so that is exactly the row shape rather than a
 * label and an id the caller is expected to re-look-up. A result the reader
 * cannot place is a result they have to click to understand, which defeats
 * searching.
 */
export interface TabResult {
  id: string;
  label: string;
  pinned: boolean;
  /** Undefined for a loose tab; the caller renders its own "ungrouped" wording. */
  groupId?: string;
  groupName?: string;
  /** True when the tab's group is collapsed, so the row can say so. */
  groupCollapsed: boolean;
  /** True for the tab currently in front of *its own* strip. */
  active: boolean;
  /** Which window owns it. Empty until the registry has issued this window an id. */
  windowId: string;
  /** Stable display number for that window, from `numberWindows`. */
  windowNumber: number;
  /** False for a tab in another window, which is acted on by message rather than directly. */
  local: boolean;
  /** The strip it lives in. One strip per window today; named so results stay readable if that changes. */
  strip: string;
}

/** A group as the group-name search reports it. */
export interface GroupResult {
  id: string;
  name: string;
  color?: string;
  collapsed: boolean;
  /** Members in this window's strip, so an emptied group is visibly empty. */
  count: number;
  pinned: "none" | "some" | "all";
}

/** One window's strip, flattened for the master search. */
export interface StripSnapshot {
  windowId: string;
  windowNumber: number;
  local: boolean;
  strip: string;
  tabs: TabResult[];
}

/**
 * Project this window's strip into search rows.
 *
 * `labelOf` is passed rather than read from a route table because the label a
 * tab renders is a *translated* string, and translating is the caller's job —
 * this module has no locale and should not grow one just to answer a search.
 */
export function stripResults(
  state: TabsState<Page>,
  labelOf: (tab: Tab) => string,
  window: { windowId: string; windowNumber: number; strip: string } = { windowId: "", windowNumber: 1, strip: "main" },
): TabResult[] {
  const byId = new Map(state.groups.map(group => [group.id, group]));
  return state.tabs.map(tab => {
    const group = tab.groupId ? byId.get(tab.groupId) : undefined;
    return {
      id: tab.id,
      label: labelOf(tab),
      pinned: tab.pinned,
      groupId: group?.id,
      groupName: group?.name,
      groupCollapsed: !!group?.collapsed,
      active: tab.id === state.activeTab,
      windowId: window.windowId,
      windowNumber: window.windowNumber,
      local: true,
      strip: window.strip,
    };
  });
}

/** Project the groups themselves, for the search that looks for groups by name. */
export function groupResults(state: TabsState<Page>): GroupResult[] {
  return state.groups.map(group => ({
    id: group.id,
    name: group.name,
    color: group.color,
    collapsed: group.collapsed,
    count: state.tabs.filter(tab => tab.groupId === group.id).length,
    pinned: engine.groupPinState(state.tabs, group.id),
  }));
}

/**
 * Run one compiled matcher over a set of rows.
 *
 * A matcher that is not runnable returns everything rather than nothing. An
 * empty query is not a filter — it is the unfiltered list — and answering it
 * with zero rows would make every search look broken before the user has typed.
 * An *invalid* pattern is the one case that hides rows, and the caller says so
 * on screen instead of leaving a blank list to be misread as "no matches".
 */
export function matchRows<T>(rows: T[], matcher: TabMatcher, textOf: (row: T) => string): T[] {
  if (!matcher.ok) return matcher.reason === "empty" ? rows : [];
  return rows.filter(row => matcher.test(textOf(row)));
}

/**
 * Every open tab this app can see, in one addressable list.
 *
 * The master search is required to cover "every open tab across all windows,
 * workspaces, strips, and groups the app owns". This window's own strip is one
 * snapshot; the rest arrive from `tab-registry.ts`, because a peer's live strip
 * is not in storage — storage only ever holds the last writer's copy, which is
 * a window that may have been idle for ten minutes.
 *
 * The local snapshot is listed first so the reader's own tabs are at the top of
 * a list they are most likely searching for their own tabs in.
 */
export function masterResults(local: StripSnapshot, peers: StripSnapshot[]): TabResult[] {
  return [local, ...peers].flatMap(snapshot => snapshot.tabs.map(tab => ({
    ...tab,
    windowId: snapshot.windowId,
    windowNumber: snapshot.windowNumber,
    local: snapshot.local,
    strip: snapshot.strip,
  })));
}

/**
 * Whether selecting `id` would reveal it without disturbing any group's
 * collapsed state.
 *
 * This is the mechanism behind "reveal a result inside a collapsed group WITHOUT
 * destroying that collapsed preference", stated as a predicate so a test can
 * hold it rather than trusting a comment. It is true because `visibleTabs`
 * exempts the active tab: selecting a member of a collapsed group brings that
 * one tab back onto the strip and leaves the group collapsed, so the reader's
 * preference survives being searched. Expanding the group instead would undo a
 * choice they made, to show them something one selection already shows.
 */
export function revealsWithoutExpanding(state: TabsState<Page>, id: string): boolean {
  if (!state.tabs.some(tab => tab.id === id)) return false;
  return engine.visibleTabs({ ...state, activeTab: id }).some(tab => tab.id === id);
}

/* ------------------------------------------------------------ the hook -- */

const isValidPage = (value: unknown): value is Page => typeof value === "string" && VALID_PAGES.has(value as Page);

function readTabs(initialPage: Page): TabsState<Page> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
  } catch { /* corrupt or unavailable storage falls through to a fresh strip */ }
  return engine.reviveTabs(raw, isValidPage, initialPage);
}

export interface TabsApi {
  tabs: Tab[];
  groups: TabGroup[];
  activeTab: string;
  activePage: Page;
  /** Strip order minus the members of collapsed groups. Never hides the active or a pinned tab. */
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
  setTabStyle: (id: string, patch: TabStyle) => void;
  /** Point the active tab at a different page without opening one (hash sync). */
  setActivePage: (page: Page) => void;
  /** Returns the new group's id, which the caller almost always needs at once. */
  createGroup: (name: string, memberIds?: string[]) => string;
  renameGroup: (id: string, name: string) => void;
  setGroupColor: (id: string, color?: string) => void;
  setGroupStyle: (id: string, patch: TabStyle) => void;
  setGroupDecor: (id: string, patch: Partial<GroupDecor>) => void;
  toggleGroupCollapsed: (id: string) => void;
  removeGroup: (id: string) => void;
  moveGroup: (fromId: string, toId: string) => void;
  assignGroup: (tabId: string, groupId?: string) => void;
  setGroupPinned: (id: string, pinned: boolean) => void;
}

export function useTabs(initialPage: Page, onPageChange: (page: Page) => void): TabsApi {
  const [state, setState] = useState<TabsState<Page>>(() => readTabs(initialPage));

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
   * Every command, bound to `setState` once.
   *
   * One `useMemo` rather than twenty `useCallback`s: none of them depends on
   * anything but `setState`, which React guarantees is stable, so this is a
   * single object identity for the life of the component. Effects elsewhere that
   * depend on a command therefore do not re-subscribe on every keystroke — the
   * exact failure `use-tab-routing.ts` documents at length.
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
    setTabStyle: (id: string, patch: TabStyle) => setState(s => engine.setTabStyle(s, id, patch)),
    renameGroup: (id: string, name: string) => setState(s => engine.renameGroup(s, id, name)),
    setGroupColor: (id: string, color?: string) => setState(s => engine.setGroupColor(s, id, color)),
    setGroupStyle: (id: string, patch: TabStyle) => setState(s => engine.setGroupStyle(s, id, patch)),
    setGroupDecor: (id: string, patch: Partial<GroupDecor>) => setState(s => engine.setGroupDecor(s, id, patch)),
    toggleGroupCollapsed: (id: string) => setState(s => engine.toggleGroupCollapsed(s, id)),
    removeGroup: (id: string) => setState(s => engine.removeGroup(s, id)),
    moveGroup: (fromId: string, toId: string) => setState(s => engine.moveGroup(s, fromId, toId)),
    assignGroup: (tabId: string, groupId?: string) => setState(s => engine.assignGroup(s, tabId, groupId)),
    setGroupPinned: (id: string, pinned: boolean) => setState(s => engine.setGroupPinned(s, id, pinned)),
  }), []);

  const setActivePage = useCallback((page: Page) => {
    // The hash already carries this page — that is where the call came from.
    // Recording it as pushed stops the effect above writing it straight back,
    // which would add a history entry for a Back the user just pressed and make
    // Back look like it does nothing.
    lastPushed.current = page;
    setState(s => engine.setActivePage(s, page));
  }, []);

  /**
   * Create a group and hand back its id.
   *
   * The id is minted here rather than inside the reducer so the caller has it
   * synchronously — every real use ("group these two tabs, then open the
   * rename field on the group") needs to name the group it just made, and
   * digging it back out of the next render's group list is a guess about which
   * one is new.
   */
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
