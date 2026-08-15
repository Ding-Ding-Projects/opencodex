/**
 * App-bar preview-size control: pin the shell to an emulated viewport width.
 *
 * The adaptive shell has three layouts — compact swaps the rail for a modal
 * drawer and adds a bottom bar, medium narrows the rail to icons, expanded gives
 * it labels — and until now the only way to see two of them was to drag the
 * window narrow and back. On a maximised desktop, and inside the frameless
 * Electron shell in particular, that is a slow and fiddly thing to ask of anyone
 * checking whether a change holds up at 412px. This is the control the design
 * prototype has had all along in this exact slot.
 *
 * It is genuinely live rather than a preview picture: the chosen width replaces
 * the measured one in `useViewportPreview`, so `windowClass` flips for real and
 * every consumer of it — the rail, the drawer button, the bottom bar, the tab
 * strip, the anchored editors — reacts exactly as it would to a real window that
 * size.
 *
 * ## What it does not emulate, and why the menu says so
 *
 * The shell's own breakpoints are measured in JavaScript, which is what makes
 * this possible at all. Two things are not, and both stay at the real window's
 * size:
 *
 *  - The stylesheet's `@media` rules, which the browser evaluates against the
 *    real window and no amount of application state can move — the app-bar code
 *    name that hides below 1000px, a couple of narrow-width paddings.
 *  - Full-window overlays: the compact drawer's scrim, the snackbar host, the
 *    anchored menus. All are `position: fixed` against the viewport, and the one
 *    way to make them respect the frame instead would be to turn the framed
 *    shell into their containing block — which would drag the anchored menus
 *    down with them, and those are placed by viewport coordinates that would
 *    then be wrong everywhere.
 *
 * That is a caveat worth one line of copy in the menu rather than a silent
 * difference somebody later reports as "the compact layout is broken".
 *
 * ## Not a setting
 *
 * It is transient view state and deliberately does not persist: see the note in
 * `theme/viewport-preview.ts`. That is also why it stays out of the settings
 * draft/Apply path — nothing here is a durable preference, so there is nothing
 * to stage — which matches the app bar's other view control, the cost meter's
 * range, in being owned by the surface rather than by the settings registry.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { IconMonitor } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import {
  applyViewportPreview,
  setViewportPreviewWidth,
  useViewportPreview,
} from "../theme/viewport-preview";
import { fixedPanelStyle, useAnchoredPlacement } from "./use-anchored-placement";
import { MenuItem } from "./MenuItem";

interface PreviewOption {
  id: string;
  /** `null` is "fit window": no override, the shell measures the real thing. */
  width: number | null;
  tkey: TKey;
}

/**
 * The same four the prototype offers, and the numbers are the reason it is four.
 *
 * 412 is a mainstream Android phone's CSS width and sits well inside compact;
 * 834 is an iPad's portrait width and sits in the middle of medium; 1280 is the
 * first width that reaches expanded. Between them every branch of `windowClass`
 * gets exercised, which is what the control is for — a longer list of devices
 * would add rows that all resolve to a layout already on the list.
 */
const OPTIONS: PreviewOption[] = [
  { id: "auto", width: null, tkey: "viewport.auto" },
  { id: "phone", width: 412, tkey: "viewport.phone" },
  { id: "tablet", width: 834, tkey: "viewport.tablet" },
  { id: "desktop", width: 1280, tkey: "viewport.desktop" },
];

/**
 * Border plus outer gap of the drawn frame, in step with the frame rule in
 * `m3-shell.css` (an 8px border each side and an 8px gap each side).
 *
 * It is used for one thing: deciding whether a pinned width can actually be
 * drawn at that width in this window. Being a pixel or two out here moves the
 * "wider than this window" note by a pixel or two, and cannot produce a wrong
 * layout — the layout comes from the pinned number either way.
 */
const FRAME_CHROME_PX = 32;

export default function ViewportPreview() {
  const t = useT();
  const preview = useViewportPreview();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPlacement = useAnchoredPlacement(wrapRef, menuRef, menuOpen, 280);

  // The real window, tracked only while a preview is pinned. It is not the width
  // the shell lays out against — that is the pinned one — but it is the width the
  // frame can physically be drawn at, and the two differ whenever somebody asks
  // for a 1280px preview in a 1100px window. The banner says so rather than
  // showing a frame that is quietly narrower than the number beside it.
  const [windowWidth, setWindowWidth] = useState(
    () => (typeof window === "undefined" ? 0 : window.innerWidth),
  );

  useEffect(() => {
    if (preview === null) return;
    setWindowWidth(window.innerWidth);
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [preview]);

  // The document root is where the frame rule in `m3-shell.css` reads the
  // preview from. Cleared on unmount as well as on exit: leaving the attribute
  // behind would frame a shell with no control left to unframe it.
  //
  // Layout, not passive: the banner below renders in the same commit that turns
  // the preview on, so applying the attribute after paint would show one frame
  // of a banner sitting over an unframed, full-width shell.
  useLayoutEffect(() => {
    const root = document.documentElement;
    applyViewportPreview(root, preview);
    return () => applyViewportPreview(root, null);
  }, [preview]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    const stopOutsidePress = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsidePress();
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // "Phone · 412 px" for a pinned size, "Fit window" for none. The separator is
  // punctuation rather than copy, which is why it is not its own key — the same
  // dot the app bar already puts between the version and the code name.
  //
  // A pinned width that matches none of the four falls back to the bare number
  // rather than to the first option's label. The store is reachable from outside
  // this menu, and "Fit window" printed over a shell that is emphatically not
  // fitting the window would be the one reading a user cannot recover from.
  const named = OPTIONS.find(option => option.width === preview);
  const activeLabel = preview === null
    ? t("viewport.auto")
    : named
      ? `${t(named.tkey)} · ${t("viewport.px", { width: preview })}`
      : t("viewport.px", { width: preview });

  const clamped = preview !== null && windowWidth > 0 && preview + FRAME_CHROME_PX > windowWidth;

  const choose = (width: number | null) => {
    setViewportPreviewWidth(width);
    setMenuOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <div ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button
          ref={triggerRef}
          type="button"
          className="m3-icon-btn"
          // Tonal while a preview is pinned, so the app bar itself says the
          // shell is measuring against something other than this window even
          // when the banner is scrolled past on a small screen. An attribute
          // rather than a modifier class for a cascade reason the stylesheet
          // spells out beside the rule.
          data-preview-on={preview === null ? undefined : "true"}
          onClick={() => setMenuOpen(open => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          // The accessible name carries the current emulation, not just the
          // control's own name: a screen-reader user has no frame border to tell
          // them the shell is laying itself out against a width the window does
          // not have, so the name is where that has to be said.
          aria-label={t("viewport.trigger", { size: activeLabel })}
          title={t("viewport.trigger", { size: activeLabel })}
        >
          <IconMonitor aria-hidden />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            className="m3-menu"
            style={{ ...fixedPanelStyle(menuPlacement), zIndex: 70, minWidth: "min(280px, calc(100vw - 16px))" }}
          >
            <div className="m3-menu-heading" id="viewport-menu-heading">{t("viewport.menuTitle")}</div>
            <div role="menu" aria-labelledby="viewport-menu-heading">
              {/* Each row picks an emulated width. No keyboard binding reaches
                  one, so none prints a shortcut — and the pixel figure beside
                  the label is data about the choice, not a key to press, which
                  is why it keeps its own class rather than the shortcut column's. */}
              {OPTIONS.map(option => (
                <MenuItem
                  key={option.id}
                  role="menuitemradio"
                  aria-checked={option.width === preview}
                  onClick={() => choose(option.width)}
                >
                  <span style={{ flex: "1 1 auto", fontWeight: option.width === preview ? 600 : 400 }}>
                    {t(option.tkey)}
                  </span>
                  {option.width !== null && (
                    <span className="m3-preview-px">{t("viewport.px", { width: option.width })}</span>
                  )}
                </MenuItem>
              ))}
            </div>
            <p className="m3-preview-note">{t("viewport.note")}</p>
          </div>
        )}
      </div>

      {/*
        The banner is `position: fixed`, so where it sits in the tree does not
        decide where it paints — the same arrangement the snackbar host already
        relies on from inside `.m3-app`. It lives here rather than above the
        shell in `App.tsx` because it belongs to this control, and because a
        banner *inside* the framed shell would eat the emulated height and make
        the preview it is announcing inaccurate.
      */}
      {preview !== null && (
        <div className="m3-preview-banner" role="status" aria-live="polite">
          <span className="m3-preview-banner__label">{t("viewport.banner", { size: activeLabel })}</span>
          {clamped && (
            <span className="m3-preview-banner__warn">
              {t("viewport.clamped", { size: activeLabel, actual: Math.max(0, windowWidth - FRAME_CHROME_PX) })}
            </span>
          )}
          <button type="button" className="m3-preview-banner__exit" onClick={() => setViewportPreviewWidth(null)}>
            {t("viewport.exit")}
          </button>
        </div>
      )}
    </>
  );
}
