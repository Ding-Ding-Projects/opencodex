/**
 * Top app bar: page title, live proxy status, quick restore, notification
 * centre, a shortcut to Appearance, and the signed-in account chip.
 */

import { useEffect, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { IconBell, IconDevices, IconMenu, IconPalette } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "./notifications-context";
import CostMeter from "./CostMeter";
import QuickRestore from "./QuickRestore";
import AccountSwitcher from "./AccountSwitcher";
import WindowControls from "./WindowControls";
import { usePrefs } from "../theme/prefs-context";
import { useSettingsDrafts } from "../settings-drafts-context";
import { useSettingsSave } from "./use-settings-save";
import { Button } from "./m3-ui";
import { useAppearanceTarget } from "./use-appearance-target";
import { fixedPanelStyle, useAnchoredPlacement } from "./use-anchored-placement";
import type { Page } from "../app-routing";

interface AppBarProps {
  apiBase: string;
  title: string;
  statusLine: string;
  /** The whole build identity, for hover — the line itself is abbreviated. */
  statusTitle?: string;
  /**
   * This build's dim sum code name, or null for a local build that names no
   * release. Kept as a pair so the English half can be dropped at narrow widths
   * without cutting a name in half.
   */
  codename?: { zh: string; name: string } | null;
  onOpenDrawer: () => void;
  drawerOpen: boolean;
  onOpen: (page: Page, newTab: boolean) => void;
  onConnectRemote: () => void;
}

export default function AppBar({ apiBase, title, statusLine, statusTitle, codename, onOpenDrawer, drawerOpen, onOpen, onConnectRemote }: AppBarProps) {
  const t = useT();
  const { windowClass } = usePrefs();
  const { dirty, dirtyCount, discard } = useSettingsDrafts();
  // Not `apply` from the draft context: the app bar sits inside the language and
  // notification providers that the coordinator sits outside of, so this is the
  // layer that can actually report what the save did.
  const { save, applying } = useSettingsSave();
  const { history, unreadCount, markAllRead } = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const notifTriggerRef = useRef<HTMLButtonElement>(null);
  const notifPanelRef = useRef<HTMLDivElement>(null);
  const notifPlacement = useAnchoredPlacement(notifRef, notifPanelRef, notifOpen, 320);
  // Right-click, press-and-hold or Shift+F10 on the bar restyles it in place.
  const barAppearance = useAppearanceTarget("appBar");

  useEffect(() => {
    if (!notifOpen) return;
    markAllRead();
    const onDown = (e: MouseEvent) => {
      if (!notifRef.current?.contains(e.target as Node)) setNotifOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNotifOpen(false);
        notifTriggerRef.current?.focus();
      }
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [notifOpen, markAllRead]);

  return (
    <header className="m3-appbar" {...barAppearance}>
      {windowClass === "compact" && (
        <button type="button" className="m3-icon-btn" onClick={onOpenDrawer}
          aria-label={t("nav.openMenu")} aria-expanded={drawerOpen} aria-controls="app-sidebar">
          <IconMenu aria-hidden />
        </button>
      )}

      <div className="m3-appbar-title">
        <h1>{title}</h1>
        {/*
          The code name, as its own element rather than two characters buried in
          the middle-dot run of the build line. It is how a release is referred
          to in conversation and in the release notes, so it has to be *readable*
          as a name — and the English half is what makes it sayable by anyone who
          does not read the Chinese. That half hides below the breakpoint instead
          of being allowed to push the row into a clip.
        */}
        {codename && (
          <span className="m3-appbar-codename" title={`${codename.zh} ${codename.name}`}>
            <span aria-hidden="true">·</span>
            <span lang="zh-Hant">{codename.zh}</span>
            <span className="m3-appbar-codename-en">{codename.name}</span>
          </span>
        )}
        <span className="m3-appbar-status" title={statusTitle}>{statusLine}</span>
      </div>

      <CostMeter apiBase={apiBase} />

      {dirty && (
        <div className="m3-draft-bar" role="status" aria-live="polite">
          <span className="m3-draft-bar__count">{t("settings.draftChanged", { count: dirtyCount })}</span>
          <Button variant="text" disabled={applying} onClick={discard}>{t("settings.discardDraft")}</Button>
          <Button variant="tonal" disabled={applying} onClick={() => void save()}>
            {t(applying ? "settings.draftApplying" : "settings.saveApply")}
          </Button>
        </div>
      )}

      {/* Ahead of the notification bell on purpose: this is the control somebody
          reaches for when something is wedged, and the far end of the row is
          where the window controls live. */}
      <QuickRestore apiBase={apiBase} />

      <div ref={notifRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button ref={notifTriggerRef} type="button" className="m3-icon-btn" onClick={() => setNotifOpen(o => !o)}
          aria-haspopup="dialog" aria-expanded={notifOpen} aria-label={t("notif.centre")} title={t("notif.centre")}>
          <IconBell aria-hidden />
          {unreadCount > 0 && <span className="m3-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
        {notifOpen && (
          <div
            ref={notifPanelRef}
            className="m3-menu"
            role="dialog"
            aria-label={t("notif.centre")}
            style={{ ...fixedPanelStyle(notifPlacement), zIndex: 70, minWidth: "min(320px, calc(100vw - 16px))" }}
          >
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

      <button type="button" className="m3-icon-btn" onClick={onConnectRemote}
        aria-label={t("remote.connectTitle")} title={t("remote.connectTitle")}>
        <IconDevices aria-hidden />
      </button>

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
