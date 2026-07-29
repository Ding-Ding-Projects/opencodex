/**
 * Browser-style tab strip.
 *
 * Accessibility contract from the prototype: roving `tabIndex` (exactly one tab
 * is tabbable), Arrow/Home/End to move, Delete to close, and every icon
 * `aria-hidden` beside a text label.
 */

import { useEffect, useRef, useState } from "react";
import { IconChevron, IconPin, IconPlus, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { PAGE_META, PAGE_META_BY_ID } from "./page-meta";
import type { TabsApi } from "./use-tabs";
import type { Page } from "../app-routing";

export default function TabStrip({ tabs }: { tabs: TabsApi }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const focusTab = (index: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!buttons?.length) return;
    const clamped = (index + buttons.length) % buttons.length;
    buttons[clamped].focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = tabs.tabs.findIndex(tab => tab.id === tabs.activeTab);
    if (e.key === "ArrowRight") { e.preventDefault(); tabs.selectTab(tabs.tabs[(index + 1) % tabs.tabs.length].id); focusTab(index + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); tabs.selectTab(tabs.tabs[(index - 1 + tabs.tabs.length) % tabs.tabs.length].id); focusTab(index - 1); }
    else if (e.key === "Home") { e.preventDefault(); tabs.selectTab(tabs.tabs[0].id); focusTab(0); }
    else if (e.key === "End") { e.preventDefault(); tabs.selectTab(tabs.tabs[tabs.tabs.length - 1].id); focusTab(tabs.tabs.length - 1); }
    else if (e.key === "Delete") { e.preventDefault(); tabs.closeTab(tabs.activeTab); }
  };

  const openInNewTab = (page: Page) => { tabs.openPage(page, true); setMenuOpen(false); };

  return (
    <div className="m3-tabstrip">
      <div
        className="m3-tablist"
        role="tablist"
        aria-label={t("tabs.listAria")}
        onKeyDown={onKeyDown}
        ref={listRef}
      >
        {tabs.tabs.map(tab => {
          const meta = PAGE_META_BY_ID[tab.page];
          const label = t(meta.tkey);
          const selected = tab.id === tabs.activeTab;
          const closable = tabs.tabs.length > 1;
          return (
            <div
              key={tab.id}
              className={`m3-tab${selected ? " selected" : ""}${dragId === tab.id ? " dragging" : ""}${dropId === tab.id && dragId !== tab.id ? " drop-target" : ""}`}
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
                title={label}
                onClick={() => tabs.selectTab(tab.id)}
                onDoubleClick={() => tabs.togglePin(tab.id)}
                onAuxClick={e => { if (e.button === 1 && closable) { e.preventDefault(); tabs.closeTab(tab.id); } }}
              >
                <meta.Icon aria-hidden />
                {tab.pinned && <IconPin className="m3-tab-pin" aria-hidden />}
                <span className="m3-tab-label">{label}</span>
              </button>
              <button
                type="button"
                className="m3-tab-close"
                hidden={!closable}
                onClick={() => tabs.closeTab(tab.id)}
                aria-label={t("tabs.close", { name: label })}
                title={t("tabs.close", { name: label })}
              >
                <IconX aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      <div ref={menuWrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button
          type="button"
          className="m3-tabstrip-btn"
          onClick={() => setMenuOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("tabs.overflow")}
        >
          <IconChevron aria-hidden style={{ transform: "rotate(90deg)" }} />
          <span>{tabs.tabs.length}</span>
        </button>
        <button
          type="button"
          className="m3-tabstrip-btn"
          onClick={() => setMenuOpen(o => !o)}
          aria-label={t("tabs.newTab")}
          title={t("tabs.newTab")}
        >
          <IconPlus aria-hidden />
        </button>
        {menuOpen && (
          <div className="m3-menu" role="menu" style={{ top: "100%", right: 0 }}>
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
