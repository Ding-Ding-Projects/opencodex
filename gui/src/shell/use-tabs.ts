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
import { VALID_PAGES, type Page } from "../app-routing";

const TABS_KEY = "ocx-m3:tabs";

export interface Tab {
  id: string;
  page: Page;
  pinned: boolean;
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
          .map((t: Tab) => ({ id: t.id, page: t.page, pinned: !!t.pinned }))
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

  const setActivePage = useCallback((page: Page) => {
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
    setActivePage,
  };
}
