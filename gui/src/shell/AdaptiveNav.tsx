/**
 * Adaptive navigation: bottom bar under 600px, icon rail to 1239px, permanent
 * drawer at 1240px and up. Breakpoints come from the measured window width in
 * `usePrefs()` rather than media queries, so a preview frame behaves like a
 * real viewport.
 */

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { IconMoon, IconPower, IconSun, IconMonitor, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import { useAppLogoSrc } from "../theme/use-app-logo";
import { useAppDisplayName } from "../theme/use-app-name";
import { useAppearanceTarget } from "./use-appearance-target";
import { Toggle } from "./m3-ui";
import { BOTTOM_NAV_PAGES, PAGE_META, PAGE_META_BY_ID, type PageMeta } from "./page-meta";
import type { Page } from "../app-routing";

interface NavItemProps {
  meta: PageMeta;
  active: boolean;
  /**
   * Whether the label is drawn. It is always *present* either way — see the
   * label span below. This only decides whether it is painted or clipped.
   */
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
      {/*
        The label is in the DOM at every width, and is *clipped* rather than
        dropped when the rail collapses. Rendering it conditionally left the
        button as an aria-hidden icon with nothing but `title` to name it, so
        between 600px and 1240px — an ordinary half-screen window — all of these
        destinations named themselves through the weakest route the accessible
        name calculation has: last-resort, unreliable across screen readers, and
        entirely absent to touch, which never produces a tooltip. Keeping real
        text here makes the content itself the name at every width, exactly as
        the design prototype does.
      */}
      <span className={`m3-nav-label${showLabel ? "" : " m3-visually-hidden"}`}>{label}</span>
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

/**
 * Everything inside the compact drawer that can take a Tab stop, in document
 * order. Used by the focus trap below.
 *
 * Selector-only, with no "is it actually visible" filter, and that is
 * deliberate: `offsetParent` and `getBoundingClientRect` both report every
 * element as invisible under a DOM implementation that performs no layout, so
 * such a filter would find zero stops and quietly turn the trap into a Tab key
 * that goes nowhere at all. There is nothing for it to remove in any case —
 * each control here exists only when it is on screen, the close button being
 * rendered only while the drawer is open and the Claude switch only once the
 * server has answered.
 *
 * `[tabindex="-1"]` is excluded, which is what keeps the drawer panel out of
 * its own stop list. It is focusable so the opening jump has somewhere to land,
 * but it is not a place Tab should stop.
 */
const DRAWER_TAB_STOPS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export default function AdaptiveNav(props: AdaptiveNavProps) {
  const {
    activePage, onOpen, version, port, onStop, stopping, drawerOpen, onCloseDrawer,
    claudeEnabled, claudeTogglePending, onToggleClaude,
  } = props;
  const { windowClass, prefs, setPrefs } = usePrefs();
  const t = useT();
  const logoSrc = useAppLogoSrc();
  // The name the user chose, or the shipped one. Live from the module store
  // (`theme/app-name.ts`), so a rename repaints the plate without a reload —
  // and deliberately *only* a name: nothing here can ask it where anything is
  // stored, because it does not know.
  const appName = useAppDisplayName();
  const drawerRef = useRef<HTMLElement>(null);
  // Right-click, press-and-hold or Shift+F10 anywhere on the rail restyles it.
  const navAppearance = useAppearanceTarget("navRail");

  const compact = windowClass === "compact";
  /**
   * The one state in which this panel is a modal surface: laid over the page,
   * behind a scrim, with the page underneath out of play until it closes.
   *
   * Every part of the modal contract below is gated on this rather than on
   * `compact` alone, because the same JSX also renders the icon rail and the
   * permanent expanded drawer — neither of which covers anything, and neither
   * of which may claim to.
   */
  const modalDrawer = compact && drawerOpen;
  const expanded = windowClass === "expanded" || modalDrawer;
  const showLabels = expanded;

  // Move focus into the modal drawer on open so keyboard users are not left behind it.
  useEffect(() => {
    if (modalDrawer) {
      const timer = setTimeout(() => drawerRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
  }, [modalDrawer]);

  /**
   * While the drawer is open the shell behind it is genuinely inoperable — and
   * that is what earns the `aria-modal="true"` on the panel below.
   *
   * The scrim already swallows pointer presses and Escape already closes, so
   * what was left was scrolling and the accessibility tree. `inert` on the main
   * column takes out the app bar, the tab strip, the page and the bottom bar in
   * a single attribute: they stop being focusable and they stop being
   * announced. Without it `aria-modal` would be a claim the page does not
   * honour — the very reason the anchored panels elsewhere in this shell
   * deliberately withhold it — and a screen-reader user would be told the rest
   * of the page was unavailable while their virtual cursor still walked
   * straight through it.
   *
   * `aria-modal` alone would not have been enough. Several screen reader and
   * browser pairings have historically ignored it and let a virtual cursor
   * browse the page behind a dialog regardless, which is the failure this is
   * really guarding against; `inert` is honoured by the engine itself and does
   * not depend on the reader agreeing.
   *
   * The main column only, not every sibling of the drawer. The snackbar host
   * sits *above* the scrim on a higher layer, so a notification stays visible
   * and pressable while the drawer is open; inerting it would leave a control
   * the user can plainly see and read but cannot operate. The dialogs beside it
   * open in the top layer and must never be inerted by an ancestor.
   *
   * One consequence worth knowing rather than rediscovering: making an ancestor
   * inert blurs anything focused inside it, so the app bar's menu button — the
   * control that opened this — loses focus the moment the drawer mounts. The
   * effect above then lands focus on the panel, so the resting state is correct
   * either way; what falls between the two is a brief moment at the document
   * body.
   *
   * Both the attribute and the overflow are put back to whatever they were
   * rather than to a fixed value, so nothing here overwrites state some other
   * surface set for its own reasons.
   */
  useEffect(() => {
    if (!modalDrawer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Reached through the drawer's own parent rather than the whole document,
    // so a second shell rendered inside a preview frame cannot inert the real
    // one out from under the user.
    const shell = drawerRef.current?.parentElement?.querySelector<HTMLElement>(".m3-main-col") ?? null;
    const alreadyInert = shell?.hasAttribute("inert") ?? false;
    if (shell && !alreadyInert) shell.setAttribute("inert", "");
    return () => {
      document.body.style.overflow = previousOverflow;
      if (shell && !alreadyInert) shell.removeAttribute("inert");
    };
  }, [modalDrawer]);

  /**
   * Tab and Shift+Tab stay inside the open drawer.
   *
   * Tabbing out of it put a keyboard or switch user onto controls behind the
   * scrim, which they could neither see nor click, while the page still showed
   * the drawer open over the top. The `inert` above stops that on any engine
   * that implements it; this wrap makes the behaviour true regardless, and
   * gives the more useful result either way — the focus ring returns to the top
   * of the menu rather than stopping dead at its last item.
   *
   * The appearance handler runs first and is allowed to win. Shift+F10 opens
   * this rail's style editor, and swallowing that here would remove the only
   * keyboard route to it. The two cannot actually collide today, one reading
   * Tab and the other ContextMenu, but ordering it this way means a key added
   * to either later cannot silently shadow the other.
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    navAppearance.onKeyDown(event);
    if (!modalDrawer || event.defaultPrevented || event.key !== "Tab") return;
    const panel = drawerRef.current;
    if (!panel) return;
    // `Array.from` rather than a spread: this project's `lib` list carries DOM
    // but not DOM.Iterable, so a `NodeList` is not typed as iterable here.
    const stops = Array.from(panel.querySelectorAll<HTMLElement>(DRAWER_TAB_STOPS));
    // A drawer with nothing focusable in it would otherwise hand the very first
    // Tab straight to the page behind the scrim.
    if (stops.length === 0) { event.preventDefault(); return; }
    const active = document.activeElement;
    // The panel itself holds focus for the first keystroke after opening.
    // Forward from there already lands on the first control; only backward from
    // it has to wrap.
    const leavingBackwards = event.shiftKey && (active === panel || active === stops[0]);
    const leavingForwards = !event.shiftKey && active === stops[stops.length - 1];
    if (!leavingBackwards && !leavingForwards) return;
    event.preventDefault();
    (leavingBackwards ? stops[stops.length - 1] : stops[0]).focus();
  };

  const cycleTheme = () => {
    setPrefs({ theme: prefs.theme === "light" ? "dark" : prefs.theme === "dark" ? "system" : "light" });
  };
  const ThemeIcon = THEME_ICON[prefs.theme];
  const themeLabel = t(prefs.theme === "light" ? "theme.light" : prefs.theme === "dark" ? "theme.dark" : "theme.system");

  const product = PAGE_META.filter(m => m.group === "product");
  const system = PAGE_META.filter(m => m.group === "system");

  const railClass = `m3-nav${!expanded ? " m3-nav--rail" : ""}${modalDrawer ? " m3-nav--drawer" : ""}`;

  const panel = (
    <aside
      id="app-sidebar"
      className={railClass}
      ref={drawerRef}
      // Open over the page, the drawer is announced as what it is: a dialog
      // laid on top, not a landmark sitting beside the content. The prototype
      // declares both, and the pair is what a screen reader needs — the role to
      // say a surface has opened, `aria-modal` to say the rest of the page is
      // no longer part of what the user is in. The effect above is what makes
      // that second claim true rather than merely asserted.
      //
      // Neither is set on the rail or on the permanent expanded drawer, which
      // stay the `complementary` landmark this element already implies.
      role={modalDrawer ? "dialog" : undefined}
      aria-modal={modalDrawer ? "true" : undefined}
      tabIndex={modalDrawer ? -1 : undefined}
      aria-label={t("nav.primaryAria")}
      {...navAppearance}
      // Below the spread on purpose. The appearance hook supplies an
      // `onKeyDown` of its own, so a handler written above this line would be
      // silently replaced by it and the focus trap would never run.
      // `handleKeyDown` calls that one itself, which is why overriding it here
      // costs nothing.
      onKeyDown={handleKeyDown}
    >
      <div className="m3-nav-brand">
        {/*
          Reads the live app-logo store (`theme/use-app-logo.ts`) rather than
          the shipped `/logo.png` directly, so a chosen preset or converted
          custom upload appears here the moment it is applied — no reload, no
          "Apply" click. When the label text beside it is hidden (the
          collapsed rail), this image is the *only* thing on the rail naming
          the app, so it carries the real accessible name instead of being
          hidden from assistive technology; the expanded drawer keeps it
          decorative because the visible name beside it already speaks for it.

          The accessible name takes the *chosen* display name rather than the
          shipped one, so a rename reaches a screen-reader user at the same
          moment it reaches everybody else — the collapsed rail is precisely
          where this label is the only name of the app on screen.
        */}
        <img
          src={logoSrc}
          alt=""
          aria-hidden={showLabels ? "true" : undefined}
          aria-label={showLabels ? undefined : t("app.logoAria", { name: appName })}
        />
        {showLabels && (
          <div className="m3-nav-brand-text">
            {/* Was the string `opencodex`, hard-coded. It is a label, and every
                other label in this app is the user's to change. */}
            <div className="m3-nav-brand-name">{appName}</div>
            <div className="m3-nav-brand-meta">v{version}{port ? ` · :${port}` : ""}</div>
          </div>
        )}
        {modalDrawer && (
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
