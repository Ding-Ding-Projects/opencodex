/**
 * Browser-style tab strip with a real overflow menu.
 *
 * Accessibility contract from the prototype: roving `tabIndex` (exactly one tab
 * is tabbable), Arrow/Home/End to move, Delete to close, and every icon
 * `aria-hidden` beside a text label.
 *
 * Tabs that do not fit are not clipped — they move into an anchored menu that
 * renders each one through the *same* markup the strip uses (`TabIdentity`), so
 * a tab's icon, pin, badge, colour and typography survive the trip. Rendering
 * overflowed tabs as plain menu text would discard exactly the per-tab
 * customization the appearance editor exists to set.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconChevron, IconPin, IconPlus, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { PAGE_META, PAGE_META_BY_ID } from "./page-meta";
import { splitTabs, tabStyleProps, type Tab, type TabsApi } from "./use-tabs";
import type { Page } from "../app-routing";

/** Which control in an overflow row holds focus; arrows move between them. */
type MenuColumn = "item" | "close";

/**
 * The badge has no class of its own in `m3-shell.css`, so it is styled from the
 * role tokens directly — same tokens `.m3-chip.selected` uses, at label size.
 */
const BADGE_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  padding: "0 6px",
  borderRadius: "var(--r-pill)",
  background: "var(--m3-secondary-container)",
  color: "var(--m3-on-secondary-container)",
  fontSize: "var(--t-label-s)",
  lineHeight: "18px",
  fontWeight: 500,
};

/**
 * One tab's identity: icon, pin marker, label and badge.
 *
 * Shared by the strip and the overflow menu on purpose — one renderer means the
 * two surfaces cannot drift, which is the whole point of the overflow menu
 * preserving customizations.
 */
function TabIdentity({ tab, label }: { tab: Tab; label: string }) {
  const meta = PAGE_META_BY_ID[tab.page];
  return (
    <>
      <meta.Icon aria-hidden />
      {tab.pinned && <IconPin className="m3-tab-pin" aria-hidden />}
      <span className="m3-tab-label">{label}</span>
      {tab.style?.badge && <span style={BADGE_STYLE}>{tab.style.badge}</span>}
    </>
  );
}

export default function TabStrip({ tabs }: { tabs: TabsApi }) {
  const t = useT();
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusColumn, setFocusColumn] = useState<MenuColumn>("item");
  const [listWidth, setListWidth] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const newMenuWrapRef = useRef<HTMLDivElement>(null);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Set by the handlers that move the active tab and want focus to follow it. */
  const focusActiveOnCommit = useRef(false);

  const { visible, overflow } = splitTabs(tabs.tabs, tabs.activeTab, listWidth);
  // The strip never empties, so the last tab has no close control anywhere.
  const closable = tabs.tabs.length > 1;
  // Derived, not stored: closing the last overflowed tab has to shut the menu,
  // and a stored flag would need an effect to correct itself afterwards.
  const menuOpen = overflowOpen && overflow.length > 0;
  const menuIndex = Math.min(focusIndex, Math.max(0, overflow.length - 1));
  // Named for what the menu actually holds. It lists the tabs that did not fit and
  // its badge counts only those, so "All tabs" told the user the visible ones were
  // missing from a list that never claimed them.
  const hiddenLabel = t("tabs.hidden", { count: String(overflow.length) });

  /**
   * The single close path for the strip, the Delete key and the overflow menu.
   * Whatever unsaved-work protection the strip's close gains lands in all three,
   * because there is only one of it.
   */
  const requestClose = (id: string) => {
    if (!closable) return;
    tabs.closeTab(id);
  };

  /* ------------------------------------------------------------ measuring -- */

  // The list is `flex: 1 1 auto`, so its measured width is the space actually
  // available to tabs — including the shrink caused by the overflow trigger
  // appearing. Width 0 (no layout engine, or first paint) shows every tab.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setListWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Opening or closing a tab can change the space the list gets (the trigger
  // appears or leaves), and the fallback path has no ResizeObserver to notice.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) setListWidth(el.getBoundingClientRect().width);
  }, [tabs.tabs.length]);

  /* -------------------------------------------------------------- menus --- */

  useEffect(() => {
    if (!newMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!newMenuWrapRef.current?.contains(e.target as Node)) setNewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNewMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [newMenuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!overflowWrapRef.current?.contains(e.target as Node)) setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape returns focus to the trigger; a menu that closes and drops focus
      // to the document leaves a keyboard user at the top of the page.
      if (e.key === "Escape") { setOverflowOpen(false); overflowTriggerRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Opening a menu moves focus into it — that is the keyboard contract of
  // role="menu", and without it the rows below are unreachable without a mouse.
  // `overflow.length` is a dependency because closing a row from inside the menu
  // unmounts the button that had focus.
  useEffect(() => {
    if (!menuOpen) return;
    const refs = focusColumn === "close" ? closeRefs : itemRefs;
    refs.current[menuIndex]?.focus();
  }, [menuOpen, menuIndex, focusColumn, overflow.length]);

  /* ----------------------------------------------------------- strip keys -- */

  // Focus by id rather than by index: activating a tab can evict a different one
  // from the strip, so the DOM order under the cursor is not stable across the
  // render that the key press triggers. A ref rather than state, because the
  // flag exists only to survive one commit.
  useLayoutEffect(() => {
    if (!focusActiveOnCommit.current) return;
    focusActiveOnCommit.current = false;
    tabButtons.current.get(tabs.activeTab)?.focus();
  }, [tabs.activeTab, tabs.tabs]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!visible.length) return;
    const index = visible.findIndex(tab => tab.id === tabs.activeTab);
    const move = (next: number) => {
      e.preventDefault();
      const target = visible[(next + visible.length) % visible.length];
      focusActiveOnCommit.current = true;
      tabs.selectTab(target.id);
    };
    if (e.key === "ArrowRight") move(index + 1);
    else if (e.key === "ArrowLeft") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(visible.length - 1);
    else if (e.key === "Delete") { e.preventDefault(); requestClose(tabs.activeTab); }
  };

  /* ---------------------------------------------------------- menu keys --- */

  const openOverflow = () => {
    setFocusIndex(0);
    setFocusColumn("item");
    setOverflowOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      // preventDefault also stops the browser synthesising a click from
      // Enter/Space, which would immediately toggle the menu back shut.
      e.preventDefault();
      if (menuOpen) { setOverflowOpen(false); overflowTriggerRef.current?.focus(); }
      else openOverflow();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex(Math.max(0, overflow.length - 1));
      setFocusColumn("item");
      setOverflowOpen(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const count = overflow.length;
    if (!count) return;
    const moveRow = (next: number) => {
      e.preventDefault();
      setFocusIndex((next + count) % count);
      setFocusColumn("item");
    };
    if (e.key === "ArrowDown") moveRow(menuIndex + 1);
    else if (e.key === "ArrowUp") moveRow(menuIndex - 1);
    else if (e.key === "Home") moveRow(0);
    else if (e.key === "End") moveRow(count - 1);
    else if (e.key === "ArrowRight" && closable) { e.preventDefault(); setFocusColumn("close"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setFocusColumn("item"); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      closeFromMenu(overflow[menuIndex].id);
    }
  };

  /**
   * Closing from inside the menu. Emptying the overflow list closes the menu
   * (it has nothing left to show) and unmounts the trigger with it, so focus is
   * handed to the active tab — which is never overflowed, and therefore never
   * the row being closed.
   */
  const closeFromMenu = (id: string) => {
    const wasLast = overflow.length <= 1;
    requestClose(id);
    if (wasLast) tabButtons.current.get(tabs.activeTab)?.focus();
  };

  const activateFromMenu = (id: string) => {
    // The activated tab is never overflowed, so it is in the strip on the next
    // render — that is where focus belongs, not on a trigger the user has left.
    focusActiveOnCommit.current = true;
    tabs.selectTab(id);
    setOverflowOpen(false);
  };

  const openInNewTab = (page: Page) => { tabs.openPage(page, true); setNewMenuOpen(false); };

  /* -------------------------------------------------------------- render -- */

  return (
    <div className="m3-tabstrip">
      <div
        className="m3-tablist"
        role="tablist"
        aria-label={t("tabs.listAria")}
        onKeyDown={onKeyDown}
        ref={listRef}
      >
        {visible.map(tab => {
          const label = t(PAGE_META_BY_ID[tab.page].tkey);
          const selected = tab.id === tabs.activeTab;
          const style = tabStyleProps(tab.style);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`m3-tab${selected ? " selected" : ""}${dragId === tab.id ? " dragging" : ""}${dropId === tab.id && dragId !== tab.id ? " drop-target" : ""}`}
              style={style.surface}
              draggable
              onDragStart={() => setDragId(tab.id)}
              onDragOver={e => { e.preventDefault(); setDropId(tab.id); }}
              onDrop={e => { e.preventDefault(); if (dragId) tabs.moveTab(dragId, tab.id); setDragId(null); setDropId(null); }}
              onDragEnd={() => { setDragId(null); setDropId(null); }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="m3-tab-btn"
                style={style.label}
                title={label}
                ref={el => {
                  if (el) tabButtons.current.set(tab.id, el);
                  else tabButtons.current.delete(tab.id);
                }}
                onClick={() => tabs.selectTab(tab.id)}
                onDoubleClick={() => tabs.togglePin(tab.id)}
                onAuxClick={e => { if (e.button === 1) { e.preventDefault(); requestClose(tab.id); } }}
              >
                <TabIdentity tab={tab} label={label} />
              </button>
              <button
                type="button"
                className="m3-tab-close"
                hidden={!closable}
                onClick={() => requestClose(tab.id)}
                aria-label={t("tabs.close", { name: label })}
                title={t("tabs.close", { name: label })}
              >
                <IconX aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      {overflow.length > 0 && (
        <div ref={overflowWrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <button
            type="button"
            ref={overflowTriggerRef}
            className="m3-tabstrip-btn"
            onClick={() => {
              if (menuOpen) setOverflowOpen(false);
              else openOverflow();
            }}
            onKeyDown={onTriggerKeyDown}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={hiddenLabel}
            title={hiddenLabel}
          >
            <IconChevron aria-hidden style={{ transform: "rotate(90deg)" }} />
            <span>{overflow.length}</span>
          </button>
          {menuOpen && (
            <div
              className="m3-menu"
              role="menu"
              aria-label={hiddenLabel}
              style={{ top: "100%", right: 0, minWidth: 260 }}
              onKeyDown={onMenuKeyDown}
            >
              <div className="m3-menu-heading">{hiddenLabel}</div>
              {overflow.map((tab, index) => {
                const label = t(PAGE_META_BY_ID[tab.page].tkey);
                const style = tabStyleProps(tab.style);
                return (
                  <div
                    key={tab.id}
                    role="none"
                    data-overflow-tab-id={tab.id}
                    className="m3-tab"
                    style={{ ...style.surface, maxWidth: "none", width: "100%", borderRadius: "var(--r-s)" }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="m3-tab-btn"
                      style={{ ...style.label, borderRadius: "var(--r-s)" }}
                      title={label}
                      // Roving tabindex: the menu takes one Tab stop, arrows move within it.
                      tabIndex={index === menuIndex && focusColumn === "item" ? 0 : -1}
                      ref={el => { itemRefs.current[index] = el; }}
                      onFocus={() => { setFocusIndex(index); setFocusColumn("item"); }}
                      onClick={() => activateFromMenu(tab.id)}
                    >
                      <TabIdentity tab={tab} label={label} />
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="m3-tab-close"
                      hidden={!closable}
                      tabIndex={index === menuIndex && focusColumn === "close" ? 0 : -1}
                      ref={el => { closeRefs.current[index] = el; }}
                      onFocus={() => { setFocusIndex(index); setFocusColumn("close"); }}
                      onClick={() => closeFromMenu(tab.id)}
                      aria-label={t("tabs.close", { name: label })}
                      title={t("tabs.close", { name: label })}
                    >
                      <IconX aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div ref={newMenuWrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button
          type="button"
          className="m3-tabstrip-btn"
          onClick={() => setNewMenuOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={newMenuOpen}
          aria-label={t("tabs.newTab")}
          title={t("tabs.newTab")}
        >
          <IconPlus aria-hidden />
        </button>
        {newMenuOpen && (
          <div className="m3-menu" role="menu" aria-label={t("tabs.newTab")} style={{ top: "100%", right: 0 }}>
            <div className="m3-menu-heading">{t("tabs.newTab")}</div>
            {PAGE_META.map(meta => (
              <button key={meta.id} type="button" role="menuitem" className="m3-menu-item" onClick={() => openInNewTab(meta.id)}>
                <meta.Icon aria-hidden />
                <span>{t(meta.tkey)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
