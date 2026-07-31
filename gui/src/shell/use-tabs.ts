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

/* --------------------------------------------------- context-menu targets -- */

/**
 * Which tabs "Close other tabs" removes.
 *
 * Pinned tabs are not in the result, and that exclusion is the whole meaning of
 * a pin: a tidy-up command that swept pinned tabs away would make pinning worth
 * nothing precisely at the moment a user reached for the command it exists to
 * survive.
 */
export function closeOthersTargets(tabs: Tab[], keepId: string): string[] {
  return tabs.filter(tab => tab.id !== keepId && !tab.pinned).map(tab => tab.id);
}

/**
 * Which tabs "Close tabs to the right" removes: strip order, everything after
 * `fromId`, pinned tabs excepted.
 *
 * An id that is not in the strip closes nothing. Without the guard, `findIndex`
 * returning -1 would make `slice(0)` the whole strip, so a stale id would close
 * every tab instead of none.
 */
export function closeToRightTargets(tabs: Tab[], fromId: string): string[] {
  const from = tabs.findIndex(tab => tab.id === fromId);
  if (from < 0) return [];
  return tabs.slice(from + 1).filter(tab => !tab.pinned).map(tab => tab.id);
}

/**
 * Flags the bulk closes compile. The same `i` every search bar in this app uses,
 * so a pattern built in the anchored regex builder — which seeds itself with the
 * host's flags — matches here exactly what it previewed there.
 */
export const TAB_MATCH_FLAGS = "i";

/** Same cap as `regex/engine.ts`, restated rather than imported so tab state does
 * not depend on the regex screen. A longer pattern is truncated, never run. */
const TAB_PATTERN_CAP = 400;

export type TabMatcher =
  | { ok: true; test: (label: string) => boolean }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "invalid"; error: string };

/**
 * The single predicate behind both bulk closes.
 *
 * "Close tabs not containing…" negates *this* `test` rather than building a
 * second matcher from the same inputs. Two matchers would each own their own
 * trimming, casing and flags, and the pair would drift apart the first time one
 * of them was adjusted — leaving two commands that are no longer inverses and
 * no test that could tell.
 *
 * An empty query is refused rather than treated as "matches everything": run as
 * a match-all it would close the entire strip for a user who has typed nothing.
 */
export function tabMatcher(query: string, regex = false, flags: string = TAB_MATCH_FLAGS): TabMatcher {
  const text = query.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (!regex) {
    const needle = text.toLowerCase();
    return { ok: true, test: label => label.toLowerCase().includes(needle) };
  }
  try {
    const compiled = new RegExp(text.slice(0, TAB_PATTERN_CAP), flags);
    return {
      ok: true,
      // `lastIndex` is reset per call because a caller may pass `g`, and a
      // sticky index would make the same label match on one row and not the next.
      test: label => { compiled.lastIndex = 0; return compiled.test(label); },
    };
  } catch (error) {
    return { ok: false, reason: "invalid", error: (error as Error).message ?? String(error) };
  }
}

/** A tab as the bulk close sees it: the label it matches against, and its pin. */
export interface TabRow {
  id: string;
  /** The tab's *visible* label. Bulk close never inspects page contents. */
  label: string;
  pinned: boolean;
}

export interface BulkCloseOptions {
  /** "not containing": negates `test` rather than using a second predicate. */
  invert?: boolean;
  /** Off by default — a pin means the tab survives a bulk close. */
  includePinned?: boolean;
  /** Preferred survivor when every tab matches; otherwise the first one lives. */
  keepId?: string;
}

/**
 * Exactly which tabs a bulk close would remove, in strip order.
 *
 * This is the *only* answer to that question: the preview the user reviews and
 * the close that follows both read it, so the count shown can never disagree
 * with what happens. Computing the preview separately is how a confirmation
 * surface starts lying.
 *
 * The strip never empties, so when the predicate matches everything one tab is
 * spared here rather than being rescued later by `closeTabs` — a rescue after
 * the preview was drawn would show a count one higher than the strip loses.
 */
export function bulkCloseTargets(rows: TabRow[], test: (label: string) => boolean, options: BulkCloseOptions = {}): string[] {
  const matched = rows.filter(row => {
    if (row.pinned && !options.includePinned) return false;
    return options.invert ? !test(row.label) : test(row.label);
  });
  if (matched.length < rows.length) return matched.map(row => row.id);
  const survivor = matched.find(row => row.id === options.keepId) ?? matched[0];
  return matched.filter(row => row !== survivor).map(row => row.id);
}

/**
 * Keeps a pointer-positioned surface fully on screen.
 *
 * Lives beside the other pure tab helpers so it can be exercised without a
 * layout engine — happy-dom has none, and a clamp that only ever runs in a real
 * browser is a clamp nobody checks. When the surface is wider or taller than the
 * viewport the lower bound wins, pinning it to the top-left corner instead of
 * pushing it off both edges.
 */
export function clampToViewport(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  pad = 8,
): { left: number; top: number } {
  return {
    left: Math.max(pad, Math.min(point.x, viewport.width - size.width - pad)),
    top: Math.max(pad, Math.min(point.y, viewport.height - size.height - pad)),
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
