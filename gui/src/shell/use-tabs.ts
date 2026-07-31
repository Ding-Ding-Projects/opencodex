/**
 * Browser-style tab state for the M3 shell.
 *
 * The active tab owns page navigation, so it still writes `#page` through the
 * existing hash router — back/forward and deep links keep working.
 *
 * Persisted under `ocx-m3:tabs` rather than inside `ocx-m3:v1`: appearance prefs
 * and tab state change at very different rates, and sharing one key would mean
 * two independent writers racing to clobber each other's last value.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { VALID_PAGES, type Page } from "../app-routing";

const TABS_KEY = "ocx-m3:tabs";

/**
 * Per-tab appearance override, written by the "Edit tab appearance…" editor and
 * read by every surface that renders a tab.
 *
 * It lives on the tab record rather than in `prefs.elementStyles` because those
 * are per-*surface* (`--el-tabStrip-*` styles the whole strip); this one has to
 * survive being rendered somewhere other than the strip — the overflow menu —
 * which is exactly the customization a plain text menu would throw away.
 */
export interface TabStyle {
  /** Label and icon colour; any CSS colour the infinite picker can produce. */
  color?: string;
  /** Tab background. */
  bg?: string;
  /** Font family stack. */
  font?: string;
  /** Label size in px. */
  size?: number;
  /** Label weight, 300–700. */
  weight?: number;
  /** Short user-authored badge shown after the label. */
  badge?: string;
}

export interface Tab {
  id: string;
  page: Page;
  pinned: boolean;
  style?: TabStyle;
}

/** Drop anything that is not a value this style can actually render. */
function readTabStyle(raw: unknown): TabStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const style: TabStyle = {};
  for (const key of ["color", "bg", "font"] as const) {
    if (typeof input[key] === "string" && input[key]) style[key] = input[key] as string;
  }
  if (typeof input.size === "number" && Number.isFinite(input.size)) {
    style.size = Math.min(24, Math.max(9, input.size));
  }
  if (typeof input.weight === "number" && Number.isFinite(input.weight)) {
    style.weight = Math.min(700, Math.max(300, input.weight));
  }
  if (typeof input.badge === "string" && input.badge.trim()) style.badge = input.badge.trim().slice(0, 12);
  return Object.keys(style).length ? style : undefined;
}

/**
 * One tab's appearance, split into the two elements that carry it.
 *
 * Both the strip and the overflow menu render through this, so a customized tab
 * cannot look like one thing in the strip and grey text in the dropdown.
 * `.m3-tab-btn` sets its own `color`, which would win over an inherited one —
 * hence the label half is applied to the button rather than the wrapper.
 */
export function tabStyleProps(style?: TabStyle): { surface: CSSProperties; label: CSSProperties } {
  if (!style) return { surface: {}, label: {} };
  return {
    surface: style.bg ? { background: style.bg } : {},
    label: {
      ...(style.color ? { color: style.color } : {}),
      ...(style.font ? { fontFamily: style.font } : {}),
      ...(style.size != null ? { fontSize: `${style.size}px` } : {}),
      ...(style.weight != null ? { fontWeight: style.weight } : {}),
    },
  };
}

interface StoredTabs {
  tabs: Tab[];
  activeTab: string;
}

function newTabId(): string {
  // Unique per call even within the same millisecond, which `Date.now()` alone is not.
  return "t" + Math.random().toString(36).slice(2, 9);
}

function readTabs(initialPage: Page): StoredTabs {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
    const tabs: Tab[] = Array.isArray(raw?.tabs)
      ? raw.tabs
          .filter((t: unknown): t is Tab =>
            !!t && typeof t === "object"
            && typeof (t as Tab).id === "string"
            && VALID_PAGES.has((t as Tab).page))
          .map((t: Tab) => ({ id: t.id, page: t.page, pinned: !!t.pinned, style: readTabStyle(t.style) }))
      : [];
    if (tabs.length) {
      const activeTab = tabs.some(t => t.id === raw.activeTab) ? raw.activeTab : tabs[0].id;
      return { tabs, activeTab };
    }
  } catch { /* corrupt or unavailable storage falls through to a fresh strip */ }
  const id = newTabId();
  return { tabs: [{ id, page: initialPage, pinned: false }], activeTab: id };
}

/** Pinned tabs sort ahead of unpinned ones; order is otherwise stable. */
function orderTabs(tabs: Tab[]): Tab[] {
  return tabs.slice().sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
}

/**
 * Narrowest a tab may become before the strip stops squeezing and starts
 * overflowing. `.m3-tab` shrinks to nothing otherwise, so without a floor the
 * strip degrades into a row of unreadable slivers instead of an overflow menu.
 */
export const MIN_TAB_WIDTH = 132;
/** `.m3-tablist { gap: 4px }`. */
const TAB_GAP = 4;

export interface TabSplit {
  /** Tabs the strip renders, in strip order. */
  visible: Tab[];
  /** Tabs that do not fit, in strip order. Never contains a pinned tab. */
  overflow: Tab[];
}

/**
 * Which tabs fit in `listWidth` pixels.
 *
 * Pinned tabs are never overflowed — staying visible is what pinning means — and
 * neither is the active tab, so activating an overflowed tab always pulls it
 * back into the strip. A width of 0 means "not measured yet" (first paint, or a
 * DOM with no layout) and shows everything rather than guessing.
 */
export function splitTabs(tabs: Tab[], activeTab: string, listWidth: number): TabSplit {
  if (!(listWidth > 0) || tabs.length <= 1) return { visible: tabs, overflow: [] };
  const capacity = Math.max(1, Math.floor((listWidth + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP)));
  if (tabs.length <= capacity) return { visible: tabs, overflow: [] };

  const keep = new Set(tabs.filter(tab => tab.pinned).map(tab => tab.id));
  if (tabs.some(tab => tab.id === activeTab)) keep.add(activeTab);
  let slots = capacity - keep.size;
  for (const tab of tabs) {
    if (slots <= 0) break;
    if (!keep.has(tab.id)) { keep.add(tab.id); slots -= 1; }
  }
  return {
    visible: tabs.filter(tab => keep.has(tab.id)),
    overflow: tabs.filter(tab => !keep.has(tab.id)),
  };
}

export interface TabsApi {
  tabs: Tab[];
  activeTab: string;
  activePage: Page;
  /** Focus the tab already showing `page`, or open a new one. */
  openPage: (page: Page, newTab?: boolean) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  togglePin: (id: string) => void;
  moveTab: (fromId: string, toId: string) => void;
  /**
   * Merge a per-tab appearance override. The caller records the revision,
   * because only it can name the change in the user's language.
   */
  setTabStyle: (id: string, patch: TabStyle) => void;
  /** Point the active tab at a different page without opening one (hash sync). */
  setActivePage: (page: Page) => void;
}

export function useTabs(initialPage: Page, onPageChange: (page: Page) => void): TabsApi {
  const [state, setState] = useState<StoredTabs>(() => readTabs(initialPage));

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

  const openPage = useCallback((page: Page, newTab = false) => {
    setState(prev => {
      const existing = prev.tabs.find(t => t.page === page);
      if (existing && !newTab) return { ...prev, activeTab: existing.id };
      const id = newTabId();
      return { tabs: prev.tabs.concat([{ id, page, pinned: false }]), activeTab: id };
    });
  }, []);

  const selectTab = useCallback((id: string) => {
    setState(prev => (prev.tabs.some(t => t.id === id) ? { ...prev, activeTab: id } : prev));
  }, []);

  const closeTab = useCallback((id: string) => {
    setState(prev => {
      // The strip never empties — a zero-tab shell has nothing to render.
      if (prev.tabs.length <= 1) return prev;
      const idx = prev.tabs.findIndex(t => t.id === id);
      if (idx < 0) return prev;
      const tabs = prev.tabs.filter(t => t.id !== id);
      const activeTab = prev.activeTab === id ? tabs[Math.max(0, idx - 1)].id : prev.activeTab;
      return { tabs, activeTab };
    });
  }, []);

  const togglePin = useCallback((id: string) => {
    setState(prev => ({
      ...prev,
      tabs: orderTabs(prev.tabs.map(t => (t.id === id ? { ...t, pinned: !t.pinned } : t))),
    }));
  }, []);

  const moveTab = useCallback((fromId: string, toId: string) => {
    if (!fromId || fromId === toId) return;
    setState(prev => {
      const tabs = prev.tabs.slice();
      const from = tabs.findIndex(t => t.id === fromId);
      const to = tabs.findIndex(t => t.id === toId);
      if (from < 0 || to < 0) return prev;
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { ...prev, tabs: orderTabs(tabs) };
    });
  }, []);

  const setTabStyle = useCallback((id: string, patch: TabStyle) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t => (t.id === id ? { ...t, style: readTabStyle({ ...t.style, ...patch }) } : t)),
    }));
  }, []);

  const setActivePage = useCallback((page: Page) => {
    // The hash already carries this page — that is where the call came from.
    // Recording it as pushed stops the effect above writing it straight back,
    // which would add a history entry for a Back the user just pressed and make
    // Back look like it does nothing.
    lastPushed.current = page;
    setState(prev => {
      const current = prev.tabs.find(t => t.id === prev.activeTab);
      if (!current || current.page === page) return prev;
      // A tab already on that page wins over retargeting the active one, so
      // back/forward lands on the tab the user opened rather than duplicating it.
      const existing = prev.tabs.find(t => t.page === page);
      if (existing) return { ...prev, activeTab: existing.id };
      return {
        ...prev,
        tabs: prev.tabs.map(t => (t.id === prev.activeTab ? { ...t, page } : t)),
      };
    });
  }, []);

  return {
    tabs: state.tabs,
    activeTab: state.activeTab,
    activePage,
    openPage,
    selectTab,
    closeTab,
    togglePin,
    moveTab,
    setTabStyle,
    setActivePage,
  };
}
