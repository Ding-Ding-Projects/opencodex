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
} from "../../../shared/m3/tabs";
export type { TabMatcher, TabRow, BulkCloseOptions } from "../../../shared/m3/tabs";

// Imported as well as re-exported: `export … from` forwards a name without
// binding it locally, and the hook below calls these two itself. Re-exporting
// alone compiles as a module and fails as a program.
import { closeOthersTargets, closeToRightTargets } from "../../../shared/m3/tabs";

export interface TabsApi {
  tabs: Tab[];
  activeTab: string;
  activePage: Page;
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

  /**
   * Open a page, in this tab unless a new one was asked for.
   *
   * A plain click used to append a tab whenever the page was not already open,
   * so working through the nav left a strip of a dozen tabs nobody opened. That
   * is not how a browser behaves and it is not what clicking a nav item means:
   * navigating is the default, and a new tab is something the user asks for —
   * with the middle button, ctrl/cmd-click, or the "+" menu.
   */
  const openPage = useCallback((page: Page, newTab = false) => {
    setState(prev => {
      const existing = prev.tabs.find(t => t.page === page);
      if (existing && !newTab) return { ...prev, activeTab: existing.id };
      if (!newTab) {
        const current = prev.tabs.find(t => t.id === prev.activeTab);
        // A pinned tab is one the user asked to keep where it is; retargeting it
        // would quietly move the thing they pinned. Browsers open a new tab in
        // that case, and so does this — otherwise pinning means nothing the
        // moment the user clicks anything in the nav.
        if (current && !current.pinned) {
          return {
            ...prev,
            tabs: prev.tabs.map(t => (t.id === prev.activeTab ? { ...t, page } : t)),
          };
        }
      }
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

  /**
   * One commit for a whole set, rather than a `closeTab` loop.
   *
   * Closing four tabs one at a time would run `closeTab`'s "never empty" guard
   * four times and re-derive the active tab at each step, so the tab left in
   * front would depend on the order the ids happened to arrive in. The caller
   * has already decided which tabs survive; this only applies that decision.
   */
  const closeTabs = useCallback((ids: string[]) => {
    setState(prev => {
      const doomed = new Set(ids);
      const tabs = prev.tabs.filter(t => !doomed.has(t.id));
      // Nothing matched, or the set would empty the strip: leave state alone so
      // React does not re-render for a no-op.
      if (!tabs.length || tabs.length === prev.tabs.length) return prev;
      const activeTab = tabs.some(t => t.id === prev.activeTab) ? prev.activeTab : tabs[0].id;
      return { tabs, activeTab };
    });
  }, []);

  const closeOthers = useCallback((keepId: string) => {
    setState(prev => {
      const doomed = new Set(closeOthersTargets(prev.tabs, keepId));
      if (!doomed.size) return prev;
      return { tabs: prev.tabs.filter(t => !doomed.has(t.id)), activeTab: keepId };
    });
  }, []);

  const closeToRight = useCallback((fromId: string) => {
    setState(prev => {
      const doomed = new Set(closeToRightTargets(prev.tabs, fromId));
      if (!doomed.size) return prev;
      const tabs = prev.tabs.filter(t => !doomed.has(t.id));
      const activeTab = tabs.some(t => t.id === prev.activeTab) ? prev.activeTab : fromId;
      return { tabs, activeTab };
    });
  }, []);

  const duplicateTab = useCallback((id: string) => {
    setState(prev => {
      const index = prev.tabs.findIndex(t => t.id === id);
      if (index < 0) return prev;
      const source = prev.tabs[index];
      // The copy inherits the pin. An unpinned duplicate of a pinned tab would
      // be sorted to the far end of the strip by `orderTabs`, so the tab the
      // user just asked for would appear nowhere near the one they copied.
      const copy: Tab = { id: newTabId(), page: source.page, pinned: source.pinned, style: source.style };
      const tabs = prev.tabs.slice();
      tabs.splice(index + 1, 0, copy);
      return { tabs: orderTabs(tabs), activeTab: copy.id };
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
    closeTabs,
    closeOthers,
    closeToRight,
    duplicateTab,
    togglePin,
    moveTab,
    setTabStyle,
    setActivePage,
  };
}
