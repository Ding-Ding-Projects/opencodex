/**
 * The anchored per-element appearance editor, and the host that owns it.
 *
 * ## Anchored, until anchoring stops being honest
 *
 * The panel sits beside the element it edits, placed by the shared
 * `computePlacement` — the same maths the regex popover and the tab-search panel
 * use, so an edge case fixed for one is fixed for all three. It is `position:
 * fixed` and not `absolute`: the chrome it anchors to lives inside `.m3-page`
 * and `.m3-main-col`, both of which are scroll or clip containers, and an
 * absolutely positioned panel inside either is cut off at the container's edge
 * rather than at the viewport's.
 *
 * Below `NARROW_PX` it stops pretending. A 340px panel anchored to a 44px button
 * on a 320px screen is not "beside" anything — it covers the element it is
 * editing, which is the one thing the non-modal design exists to keep visible.
 * So at that width it becomes a bottom sheet: full width, docked to the bottom
 * edge, out of the way of the thing above it. That is the modal fallback the
 * rules allow at genuinely constrained widths, and it keeps the part of the
 * dialog contract that matters — Escape closes, an outside press closes, and
 * focus goes back to the element that opened it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { INITIAL_PLACEMENT, computePlacement, fixedPanelStyle } from "../../../shared/m3/anchor";
import { Button, Field, SelectField, Slider, TextInput } from "./m3-ui";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { onOutsidePress } from "./outside-press";
import { ElementAppearanceContext, type ElementAppearanceApi } from "./element-appearance-context";
import { ELEMENT_TARGETS, usePrefs } from "../theme/prefs-context";
import { FONT_CHOICES } from "../theme/m3";
import type { TKey } from "../i18n/shared";

/**
 * Below this the panel docks to the bottom edge instead of anchoring.
 *
 * 560 rather than the shell's own 600px compact breakpoint: this is a question
 * about whether a 340px panel plus its margins fit *beside* something, not about
 * which navigation the shell is showing, and the two answers are not the same.
 */
const NARROW_PX = 560;
const PANEL_WIDTH = 340;

const RADIUS_MAX = 32;
const PAD_MAX = 32;
const SIZE_MIN = 10;
const SIZE_MAX = 24;

interface OpenState { id: string; anchor: HTMLElement | null }

export default function ElementAppearanceHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenState | null>(null);

  const api = useMemo<ElementAppearanceApi>(() => ({
    open: (id, anchor) => {
      if (!ELEMENT_TARGETS.some(target => target.id === id)) return;
      setOpen({ id, anchor });
    },
    openId: open?.id ?? null,
  }), [open]);

  return (
    <ElementAppearanceContext.Provider value={api}>
      {children}
      {open && (
        <ElementAppearanceEditor
          id={open.id}
          anchor={open.anchor}
          onClose={() => { const anchor = open.anchor; setOpen(null); anchor?.focus?.(); }}
        />
      )}
    </ElementAppearanceContext.Provider>
  );
}

function ElementAppearanceEditor({ id, anchor, onClose }: { id: string; anchor: HTMLElement | null; onClose: () => void }) {
  const t = useT();
  const { prefs, setElementStyle, resetElementStyle } = usePrefs();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(INITIAL_PLACEMENT);
  const [narrow, setNarrow] = useState(false);

  const style = prefs.elementStyles[id] ?? {};
  const meta = ELEMENT_TARGETS.find(target => target.id === id);
  const label = t((meta?.tkey ?? ELEMENT_TARGETS[0].tkey) as TKey);

  // Measured before paint, so the panel's first frame is already placed rather
  // than appearing at one position and jumping to another. `place` is defined
  // inside the effect rather than hoisted into a `useCallback`: it is only ever
  // called from here and from the two listeners this effect owns, and a hoisted
  // version would be a function that writes state and is reachable from render.
  useLayoutEffect(() => {
    const place = () => {
      const isNarrow = window.innerWidth < NARROW_PX;
      setNarrow(isNarrow);
      // A docked sheet has nothing to compute: it spans the viewport, so there
      // is no anchor geometry that could move it.
      if (isNarrow) return;
      const rect = anchor?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      setPlacement(computePlacement(
        { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        { width: panel.width || PANEL_WIDTH, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
        { align: "start" },
      ));
    };
    place();
    window.addEventListener("resize", place);
    // Capturing: the scroll that moves this panel is usually a scrolling
    // ancestor rather than the window, and those do not bubble.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const stop = onOutsidePress(event => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { stop(); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const panelStyle: React.CSSProperties = narrow
    ? {
      // The bottom sheet. `inset-inline` rather than a width, so it cannot be
      // wider than the screen however the content grows, and the bottom inset
      // respects the home indicator.
      position: "fixed",
      zIndex: 80,
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: "min(70vh, 560px)",
      borderRadius: "var(--r-l) var(--r-l) 0 0",
    }
    : { ...fixedPanelStyle(placement), zIndex: 80, width: PANEL_WIDTH, borderRadius: "var(--r-l)" };

  return (
    <div
      ref={panelRef}
      role="dialog"
      // No `aria-modal` even as a sheet: nothing behind it is inert, and saying
      // otherwise tells a screen reader the rest of the page is unavailable.
      aria-label={t("appearance.editElement", { name: label })}
      data-element-style-editor={id}
      data-narrow={narrow ? "true" : undefined}
      style={{
        ...panelStyle,
        overflowY: "auto",
        // Longhand throughout rather than `padding` plus a `paddingBottom`
        // override: React warns that mixing a shorthand with one of its own
        // longhands leaves the result depending on which one it happens to
        // apply last, and the one being overridden here is the inset that keeps
        // the sheet's buttons off the home indicator.
        paddingTop: 16,
        paddingInline: 16,
        paddingBottom: narrow ? "max(env(safe-area-inset-bottom), 16px)" : 16,
        background: "var(--m3-surface-container-high)",
        color: "var(--m3-on-surface)",
        boxShadow: "var(--e3)",
      }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>
          {t("appearance.editElement", { name: label })}
        </h2>
        <button type="button" className="m3-icon-btn" title={t("tabs.styleClose")} aria-label={t("tabs.styleClose")} onClick={onClose}>
          <IconX width={18} height={18} aria-hidden="true" />
        </button>
      </header>

      <Field label={t("tabs.styleFont")}>
        <SelectField
          label={t("tabs.styleFont")}
          value={style.font ?? ""}
          onChange={next => setElementStyle(id, { font: next || undefined })}
          options={[
            { value: "", label: t("tabs.styleFontInherit") },
            ...FONT_CHOICES.map(font => ({ value: font.stack, label: font.label })),
          ]}
        />
      </Field>

      <Field label={t("tabs.styleColor")}>
        <TextInput
          value={style.color ?? ""}
          spellCheck={false}
          placeholder={t("tabs.styleInherits")}
          aria-label={t("tabs.styleColor")}
          onChange={event => setElementStyle(id, { color: event.target.value || undefined })}
          style={{ width: "100%", fontFamily: "var(--mono)" }}
        />
      </Field>

      <Field label={t("tabs.styleBg")}>
        <TextInput
          value={style.bg ?? ""}
          spellCheck={false}
          placeholder={t("tabs.styleInherits")}
          aria-label={t("tabs.styleBg")}
          onChange={event => setElementStyle(id, { bg: event.target.value || undefined })}
          style={{ width: "100%", fontFamily: "var(--mono)" }}
        />
      </Field>

      <Slider
        label={t("appearance.elRadius")}
        min={0}
        max={RADIUS_MAX}
        value={style.radius ?? 0}
        valueLabel={style.radius == null ? t("tabs.styleInherits") : `${style.radius}px`}
        onChange={radius => setElementStyle(id, { radius })}
      />
      <Slider
        label={t("appearance.elPad")}
        min={0}
        max={PAD_MAX}
        value={style.pad ?? 0}
        valueLabel={style.pad == null ? t("tabs.styleInherits") : `${style.pad}px`}
        onChange={pad => setElementStyle(id, { pad })}
      />
      <Slider
        label={t("tabs.styleSize")}
        min={SIZE_MIN}
        max={SIZE_MAX}
        value={style.size ?? 14}
        valueLabel={style.size == null ? t("tabs.styleInherits") : `${style.size}px`}
        onChange={size => setElementStyle(id, { size })}
      />

      <div className="m3-row" style={{ justifyContent: "end", marginTop: 8 }}>
        <Button variant="outlined" onClick={() => resetElementStyle(id)}>{t("tabs.styleResetAll")}</Button>
      </div>
    </div>
  );
}
