/**
 * Adaptive navigation: bottom bar under 600px, icon rail to 1239px, permanent
 * drawer at 1240px and up. Breakpoints come from the measured window width in
 * `usePrefs()` rather than media queries, so a preview frame behaves like a
 * real viewport.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { IconMoon, IconPower, IconSun, IconMonitor, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import { useAppearanceTarget } from "./use-appearance-target";
import { Toggle } from "./m3-ui";
import { BOTTOM_NAV_PAGES, PAGE_META, PAGE_META_BY_ID, type PageMeta } from "./page-meta";
import type { Page } from "../app-routing";

interface NavItemProps {
  meta: PageMeta;
  active: boolean;
  showLabel: boolean;
  onOpen: (page: Page, newTab: boolean) => void;
  /** Rendered after the label — the Claude row uses it for the connection switch. */
  trailing?: ReactNode;
}

function NavItem({ meta, active, showLabel, onOpen, trailing }: NavItemProps) {
  const t = useT();
  const label = t(meta.tkey);
  const button = (
    <button
      type="button"
      className={`m3-nav-item${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      title={label}
      data-page={meta.id}
      // Middle-click and ctrl/cmd-click open in a new tab, like a browser.
      onClick={e => onOpen(meta.id, e.ctrlKey || e.metaKey)}
      onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onOpen(meta.id, true); } }}
    >
      <span className="m3-nav-pill" aria-hidden="true"><meta.Icon /></span>
      {showLabel && <span className="m3-nav-label">{label}</span>}
    </button>
  );
  if (!trailing) return button;
  // The switch is a sibling, never nested — a control inside a button is not operable.
  return <div className="m3-nav-entry">{button}{trailing}</div>;
}

interface AdaptiveNavProps {
  activePage: Page;
  onOpen: (page: Page, newTab: boolean) => void;
  version: string;
  port: string | null;
  onStop: () => void;
  stopping: boolean;
  /** Compact only: the modal drawer is open. */
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  /** null until /api/claude-code answers; the switch is withheld until then. */
  claudeEnabled: boolean | null;
  claudeTogglePending: boolean;
  onToggleClaude: () => void;
}

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;

export default function AdaptiveNav(props: AdaptiveNavProps) {
  const {
    activePage, onOpen, version, port, onStop, stopping, drawerOpen, onCloseDrawer,
    claudeEnabled, claudeTogglePending, onToggleClaude,
  } = props;
  const { windowClass, prefs, setPrefs } = usePrefs();
  const t = useT();
  const drawerRef = useRef<HTMLElement>(null);
  // Right-click, press-and-hold or Shift+F10 anywhere on the rail restyles it.
  const navAppearance = useAppearanceTarget("navRail");

  const compact = windowClass === "compact";
  const expanded = windowClass === "expanded" || (compact && drawerOpen);
  const showLabels = expanded;

  // Move focus into the modal drawer on open so keyboard users are not left behind it.
  useEffect(() => {
    if (compact && drawerOpen) {
      const timer = setTimeout(() => drawerRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
  }, [compact, drawerOpen]);

  useEffect(() => {
    if (!(compact && drawerOpen)) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [compact, drawerOpen]);

  const cycleTheme = () => {
    setPrefs({ theme: prefs.theme === "light" ? "dark" : prefs.theme === "dark" ? "system" : "light" });
  };
  const ThemeIcon = THEME_ICON[prefs.theme];
  const themeLabel = t(prefs.theme === "light" ? "theme.light" : prefs.theme === "dark" ? "theme.dark" : "theme.system");

  const product = PAGE_META.filter(m => m.group === "product");
  const system = PAGE_META.filter(m => m.group === "system");

  const railClass = `m3-nav${!expanded ? " m3-nav--rail" : ""}${compact && drawerOpen ? " m3-nav--drawer" : ""}`;

  const panel = (
    <aside
      id="app-sidebar"
      className={railClass}
      ref={drawerRef}
      tabIndex={compact && drawerOpen ? -1 : undefined}
      aria-label={t("nav.primaryAria")}
      {...navAppearance}
    >
      <div className="m3-nav-brand">
        <img src="/logo.png" alt="" aria-hidden="true" />
        {showLabels && (
          <div className="m3-nav-brand-text">
            <div className="m3-nav-brand-name">opencodex</div>
            <div className="m3-nav-brand-meta">v{version}{port ? ` · :${port}` : ""}</div>
          </div>
        )}
        {compact && drawerOpen && (
          <button type="button" className="m3-icon-btn" style={{ marginLeft: "auto" }}
            onClick={onCloseDrawer} aria-label={t("nav.closeMenu")} title={t("nav.closeMenu")}>
            <IconX aria-hidden />
          </button>
        )}
      </div>

      {product.map(meta => (
        <NavItem
          key={meta.id}
          meta={meta}
          active={meta.id === activePage}
          showLabel={showLabels}
          onOpen={onOpen}
          trailing={meta.id === "claude" && claudeEnabled !== null ? (
            // The next state is discarded on purpose: the parent owns the value and
            // flips it, so passing it back would let this row and the server disagree
            // about which direction the toggle went.
            <Toggle
              on={claudeEnabled}
              onChange={onToggleClaude}
              disabled={claudeTogglePending}
              label={t("claude.toggleAria")}
            />
          ) : undefined}
        />
      ))}

      <hr className="m3-nav-divider" />

      {system.map(meta => (
        <NavItem key={meta.id} meta={meta} active={meta.id === activePage} showLabel={showLabels} onOpen={onOpen} />
      ))}

      <div className="m3-nav-foot">
        <button type="button" className="m3-nav-item" onClick={cycleTheme}
          aria-label={`${t("theme.label")}: ${themeLabel}`} title={`${t("theme.label")}: ${themeLabel}`}>
          <span className="m3-nav-pill" aria-hidden="true"><ThemeIcon /></span>
          {showLabels && <span className="m3-nav-label">{themeLabel}</span>}
        </button>
        <button type="button" className="m3-nav-item danger" onClick={onStop} disabled={stopping}
          aria-label={t("dash.stop")} title={t("dash.stop")}>
          <span className="m3-nav-pill" aria-hidden="true"><IconPower /></span>
          {showLabels && <span className="m3-nav-label">{stopping ? t("dash.stopping") : t("dash.stop")}</span>}
        </button>
      </div>
    </aside>
  );

  if (!compact) return panel;

  return (
    <>
      {drawerOpen && <div className="m3-drawer-scrim" onClick={onCloseDrawer} aria-hidden="true" />}
      {drawerOpen && panel}
    </>
  );
}

/** Compact-only bottom navigation bar. Rendered by the shell below the page area. */
export function BottomNav({ activePage, onOpen }: { activePage: Page; onOpen: (page: Page, newTab: boolean) => void }) {
  const t = useT();
  return (
    <nav className="m3-bottom-nav" aria-label={t("nav.primaryAria")}>
      {BOTTOM_NAV_PAGES.map(id => (
        <NavItem key={id} meta={PAGE_META_BY_ID[id]} active={id === activePage} showLabel onOpen={onOpen} />
      ))}
    </nav>
  );
}
