/**
 * The per-tab appearance editor, anchored beside the tab it edits.
 *
 * `TabStyle` and `setTabStyle` have existed in `use-tabs.ts` since the strip
 * landed, and until now nothing wrote them: a tab could carry a colour, a font
 * and a badge that no surface in the app could ever set. This is the surface
 * that sets them.
 *
 * Non-modal on purpose. The user opened it to change how a tab in front of them
 * looks, so inerting that tab and trapping focus away from it would hide the one
 * thing being edited. What it keeps from the dialog contract is the part that is
 * not about blocking: focus moves in on open, Escape closes, an outside click
 * closes, and the tab that opened it gets focus back — `onClose` is where that
 * restoration happens, because only the strip knows which button to return to.
 *
 * Every edit applies immediately through `onChange`, so the live preview is the
 * real tab in the strip rather than a mock of one. The small preview row here
 * exists for the case the strip has scrolled the tab out of sight; it renders
 * from the same `tabStyleProps` the strip does, so the two cannot disagree.
 *
 * What it deliberately does NOT do: persist anything itself, record a revision,
 * or decide what "reset" means for the theme. Clearing a property writes
 * `undefined`, which `readTabStyle` drops, and the tab falls back to whatever
 * the theme says — the editor never stores a copy of the default, because a
 * stored copy stops following a theme the user later changes.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Field, SelectField, Slider, TextInput } from "./m3-ui";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { PAGE_META_BY_ID } from "./page-meta";
import { SettingsSearchRow } from "./SettingsSearch";
import { useSettingsSearch } from "./use-settings-search";
import type { SettingsOption } from "./settings-search";
import { clampToViewport, tabStyleProps, type Tab, type TabStyle } from "./use-tabs";
import { FONT_CHOICES } from "../theme/m3";

/** `<input type="color">` refuses a CSS variable, so a token-valued or unset
 * property needs a concrete hex for the swatch. The text field beside it holds
 * the real value, and the hint says the swatch is showing a fallback. */
const COLOR_FALLBACK = "#000000";
const BG_FALLBACK = "#ffffff";
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Matches `readTabStyle`'s clamps in use-tabs.ts. A slider that offered a range
 * the store then narrowed would silently discard the end of its own scale. */
const SIZE_MIN = 9;
const SIZE_MAX = 24;
const WEIGHT_MIN = 300;
const WEIGHT_MAX = 700;
const BADGE_MAX = 12;

/** Size the label renders at with no override, so the slider starts somewhere
 * honest instead of at its minimum. */
const SIZE_DEFAULT = 14;
const WEIGHT_DEFAULT = 400;

const SWATCH: React.CSSProperties = {
  width: 56,
  height: 44,
  padding: 2,
  border: "1px solid var(--m3-outline)",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-lowest)",
  cursor: "pointer",
  flex: "0 0 auto",
};

const PANEL: React.CSSProperties = {
  position: "fixed",
  zIndex: 80,
  width: 340,
  maxHeight: "min(70vh, 560px)",
  overflowY: "auto",
  padding: 16,
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-high)",
  color: "var(--m3-on-surface)",
  boxShadow: "var(--e3)",
};

/**
 * A per-property reset.
 *
 * Disabled rather than hidden when the property is already unset, so the rows do
 * not change height as properties are cleared and the control the user is
 * reaching for does not move out from under the pointer.
 *
 * Its own component at module scope, not a closure inside the editor: a
 * component declared during render is a new type on every render, so React
 * unmounts and remounts it each time — which would take the focus ring with it
 * mid-edit.
 */
function ResetButton({ on, name, clear }: { on: boolean; name: string; clear: () => void }) {
  const t = useT();
  return (
    <Button variant="text" disabled={!on} onClick={clear} aria-label={t("tabs.styleResetOne", { name })}>
      {t("tabs.styleReset")}
    </Button>
  );
}

export interface TabAppearanceEditorProps {
  tab: Tab;
  /** The tab's visible label — the editor's accessible name, and its preview text. */
  label: string;
  /** The tab button this panel sits beside; it is measured, never mutated. */
  anchor: HTMLElement | null;
  /** Merges a patch into the tab's style. `undefined` clears a property. */
  onChange: (patch: TabStyle) => void;
  onClose: () => void;
}

export default function TabAppearanceEditor({ tab, label, anchor, onChange, onClose }: TabAppearanceEditorProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const colorId = `${baseId}-color`;
  const titleId = `${baseId}-title`;
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  const style = tab.style ?? {};
  const preview = tabStyleProps(tab.style);
  const meta = PAGE_META_BY_ID[tab.page];

  /**
   * What this editor is searchable by.
   *
   * An appearance editor is a settings surface like any other, and six properties
   * in a 340px panel is exactly the size at which "obviously scannable" stops
   * being true — the badge field is below the fold on a short viewport. Each row
   * carries its current value as well as its name, so typing the colour you set
   * finds the control that set it, and the placeholder text ("Inherits from the
   * theme") is indexed too, because that is what the row visibly reads while a
   * property is unset.
   */
  const options: SettingsOption[] = useMemo(() => {
    const inherits = t("tabs.styleInherits");
    return [
      { id: "color", label: t("tabs.styleColor"), value: style.color ?? inherits, keywords: t("tabs.styleColorPicker") },
      { id: "bg", label: t("tabs.styleBg"), value: style.bg ?? inherits, keywords: t("tabs.styleBgPicker") },
      {
        id: "font",
        label: t("tabs.styleFont"),
        value: FONT_CHOICES.find(font => font.stack === style.font)?.label ?? t("tabs.styleFontInherit"),
        keywords: FONT_CHOICES.map(font => font.label).join(" "),
      },
      { id: "size", label: t("tabs.styleSize"), value: style.size == null ? inherits : `${style.size}px` },
      { id: "weight", label: t("tabs.styleWeight"), value: style.weight == null ? inherits : String(style.weight) },
      { id: "badge", label: t("tabs.styleBadge"), desc: t("tabs.styleBadgeHint", { max: String(BADGE_MAX) }), value: style.badge ?? "" },
      { id: "resetAll", label: t("tabs.styleResetAll"), keywords: t("tabs.styleReset") },
    ];
  }, [t, style.color, style.bg, style.font, style.size, style.weight, style.badge]);

  const search = useSettingsSearch({ options });
  const { matches } = search;

  // Measured after paint and re-measured when the page moves under it, so the
  // panel stays beside a tab that scrolled or a window that was resized. Off
  // screen until the first measurement, because a panel that paints at 0,0 and
  // then jumps is read as a flicker bug.
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      setPosition(clampToViewport(
        { x: rect.left, y: rect.bottom + 6 },
        { width: panel.width, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
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

  // Focus lands on the first control, not on the container: focusing the panel
  // would make a keyboard user's first move be tabbing past a heading to reach
  // the thing they opened this for.
  useEffect(() => {
    const field: { focus?: () => void } | null = document.getElementById(colorId);
    field?.focus?.();
  }, [colorId]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    // Escape is handled on the document rather than on the panel: this does not
    // trap focus, so the focused element may legitimately be outside it by the
    // time Escape is pressed, and a handler on the panel would never see it.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      // `dialog` without `aria-modal`: nothing behind this is inert, and saying
      // otherwise tells a screen reader the rest of the page is unavailable.
      role="dialog"
      aria-labelledby={titleId}
      data-tab-style-editor={tab.id}
      style={{ ...PANEL, left: position.left, top: position.top }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 id={titleId} className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>
          {t("tabs.styleFor", { name: label })}
        </h2>
        <button
          type="button"
          className="m3-icon-btn"
          title={t("tabs.styleClose")}
          aria-label={t("tabs.styleClose")}
          onClick={onClose}
        >
          <IconX width={18} height={18} aria-hidden="true" />
        </button>
      </header>

      {/* The preview stays put whatever the search hides: it is what is being
          edited, not one of the things being searched. */}
      <Field label={t("tabs.stylePreview")}>
        <div className="m3-tab selected" style={{ ...preview.surface, maxWidth: "none", borderRadius: "var(--r-s)" }}>
          <span className="m3-tab-btn" style={{ ...preview.label, cursor: "default" }}>
            <meta.Icon aria-hidden />
            <span className="m3-tab-label">{label}</span>
            {style.badge && (
              <span style={{
                padding: "0 6px",
                borderRadius: "var(--r-pill)",
                background: "var(--m3-secondary-container)",
                color: "var(--m3-on-secondary-container)",
                fontSize: "var(--t-label-s)",
              }}>{style.badge}</span>
            )}
          </span>
        </div>
      </Field>

      {/* `compact`: this panel is 340px wide, so the row's default field basis
          would push the builder trigger onto a line of its own. */}
      <SettingsSearchRow search={search} compact />

      {matches("color") && (
      <Field id={colorId} label={t("tabs.styleColor")} hint={style.color && !HEX.test(style.color) ? t("tabs.styleSwatchFallback") : undefined}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <input
            type="color"
            value={style.color && HEX.test(style.color) ? style.color : COLOR_FALLBACK}
            aria-label={t("tabs.styleColorPicker")}
            onChange={event => onChange({ color: event.target.value })}
            style={SWATCH}
          />
          <TextInput
            id={colorId}
            value={style.color ?? ""}
            spellCheck={false}
            placeholder={t("tabs.styleInherits")}
            aria-label={t("tabs.styleColor")}
            onChange={event => onChange({ color: event.target.value || undefined })}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto", fontFamily: "var(--mono)" }}
          />
          <ResetButton on={!!style.color} name={t("tabs.styleColor")} clear={() => onChange({ color: undefined })} />
        </div>
      </Field>
      )}

      {matches("bg") && (
      <Field label={t("tabs.styleBg")} hint={style.bg && !HEX.test(style.bg) ? t("tabs.styleSwatchFallback") : undefined}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <input
            type="color"
            value={style.bg && HEX.test(style.bg) ? style.bg : BG_FALLBACK}
            aria-label={t("tabs.styleBgPicker")}
            onChange={event => onChange({ bg: event.target.value })}
            style={SWATCH}
          />
          <TextInput
            value={style.bg ?? ""}
            spellCheck={false}
            placeholder={t("tabs.styleInherits")}
            aria-label={t("tabs.styleBg")}
            onChange={event => onChange({ bg: event.target.value || undefined })}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto", fontFamily: "var(--mono)" }}
          />
          <ResetButton on={!!style.bg} name={t("tabs.styleBg")} clear={() => onChange({ bg: undefined })} />
        </div>
      </Field>
      )}

      {matches("font") && (
      <Field label={t("tabs.styleFont")}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <SelectField
            label={t("tabs.styleFont")}
            value={style.font ?? ""}
            onChange={next => onChange({ font: next || undefined })}
            options={[
              { value: "", label: t("tabs.styleFontInherit") },
              ...FONT_CHOICES.map(font => ({ value: font.stack, label: font.label })),
            ]}
            style={{ flex: "1 1 auto", minWidth: 0 }}
          />
          <ResetButton on={!!style.font} name={t("tabs.styleFont")} clear={() => onChange({ font: undefined })} />
        </div>
      </Field>
      )}

      {matches("size") && (
      <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "end" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <Slider
            label={t("tabs.styleSize")}
            min={SIZE_MIN}
            max={SIZE_MAX}
            value={style.size ?? SIZE_DEFAULT}
            valueLabel={style.size == null ? t("tabs.styleInherits") : `${style.size}px`}
            onChange={size => onChange({ size })}
          />
        </div>
        <ResetButton on={style.size != null} name={t("tabs.styleSize")} clear={() => onChange({ size: undefined })} />
      </div>
      )}

      {matches("weight") && (
      <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "end" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <Slider
            label={t("tabs.styleWeight")}
            min={WEIGHT_MIN}
            max={WEIGHT_MAX}
            step={100}
            value={style.weight ?? WEIGHT_DEFAULT}
            valueLabel={style.weight == null ? t("tabs.styleInherits") : String(style.weight)}
            onChange={weight => onChange({ weight })}
          />
        </div>
        <ResetButton on={style.weight != null} name={t("tabs.styleWeight")} clear={() => onChange({ weight: undefined })} />
      </div>
      )}

      {matches("badge") && (
      <Field label={t("tabs.styleBadge")} hint={t("tabs.styleBadgeHint", { max: String(BADGE_MAX) })}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <TextInput
            value={style.badge ?? ""}
            maxLength={BADGE_MAX}
            aria-label={t("tabs.styleBadge")}
            onChange={event => onChange({ badge: event.target.value || undefined })}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
          />
          <ResetButton on={!!style.badge} name={t("tabs.styleBadge")} clear={() => onChange({ badge: undefined })} />
        </div>
      </Field>
      )}

      {matches("resetAll") && (
      <div className="m3-row" style={{ justifyContent: "end", marginTop: 8 }}>
        <Button
          variant="outlined"
          disabled={!tab.style}
          onClick={() => onChange({ color: undefined, bg: undefined, font: undefined, size: undefined, weight: undefined, badge: undefined })}
        >
          {t("tabs.styleResetAll")}
        </Button>
      </div>
      )}
    </div>
  );
}
