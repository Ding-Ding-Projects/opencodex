/**
 * Top app bar: page title, live proxy status, notification centre, a shortcut to
 * Appearance, and the signed-in account chip.
 */

import { useEffect, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { IconBell, IconMenu, IconPalette } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "./notifications-context";
import CostMeter from "./CostMeter";
import AccountSwitcher from "./AccountSwitcher";
import WindowControls from "./WindowControls";
import { usePrefs } from "../theme/prefs-context";
import type { Page } from "../app-routing";

interface AppBarProps {
  apiBase: string;
  title: string;
  statusLine: string;
  /** The whole build identity, for hover — the line itself is abbreviated. */
  statusTitle?: string;
  onOpenDrawer: () => void;
  drawerOpen: boolean;
  onOpen: (page: Page, newTab: boolean) => void;
}

export default function AppBar({ apiBase, title, statusLine, statusTitle, onOpenDrawer, drawerOpen, onOpen }: AppBarProps) {
  const t = useT();
  const { windowClass } = usePrefs();
  const { history, unreadCount, markAllRead } = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!notifOpen) return;
    markAllRead();
    const onDown = (e: MouseEvent) => {
      if (!notifRef.current?.contains(e.target as Node)) setNotifOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNotifOpen(false); };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [notifOpen, markAllRead]);

  return (
    <header className="m3-appbar">
      {windowClass === "compact" && (
        <button type="button" className="m3-icon-btn" onClick={onOpenDrawer}
          aria-label={t("nav.openMenu")} aria-expanded={drawerOpen} aria-controls="app-sidebar">
          <IconMenu aria-hidden />
        </button>
      )}

      <div className="m3-appbar-title">
        <h1>{title}</h1>
        <span className="m3-appbar-status" title={statusTitle}>{statusLine}</span>
      </div>

      <CostMeter apiBase={apiBase} />

      <div ref={notifRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button type="button" className="m3-icon-btn" onClick={() => setNotifOpen(o => !o)}
          aria-haspopup="dialog" aria-expanded={notifOpen} aria-label={t("notif.centre")} title={t("notif.centre")}>
          <IconBell aria-hidden />
          {unreadCount > 0 && <span className="m3-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
        {notifOpen && (
          <div className="m3-menu" role="dialog" aria-label={t("notif.centre")} style={{ top: "100%", right: 0, minWidth: 320 }}>
            <div className="m3-menu-heading">{t("notif.centre")}</div>
            {history.length === 0 && (
              <div style={{ padding: "12px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
                {t("notif.empty")}
              </div>
            )}
            {history.slice(0, 8).map(n => (
              <div key={n.id} className="m3-menu-item" style={{ display: "block", cursor: "default", minHeight: 0, padding: "8px 12px" }}>
                <div style={{ fontWeight: 500 }}>{n.title}</div>
                {n.body && <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{n.body}</div>}
              </div>
            ))}
            <button type="button" className="m3-menu-item" onClick={() => { setNotifOpen(false); onOpen("notifications", false); }}>
              <span>{t("notif.viewAll")}</span>
            </button>
          </div>
        )}
      </div>

      <button type="button" className="m3-icon-btn" onClick={() => onOpen("appearance", false)}
        aria-label={t("nav.appearance")} title={t("nav.appearance")}>
        <IconPalette aria-hidden />
      </button>

      <AccountSwitcher apiBase={apiBase} />

      {/* Frameless desktop only: the native min/max/close are gone, so the app bar
          supplies them, plus the graceful Exit. Renders nothing in a browser. */}
      <WindowControls apiBase={apiBase} />
    </header>
  );
}
