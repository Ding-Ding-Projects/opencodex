/**
 * A continuous colour control with the colour translator built in.
 *
 * Not a swatch grid. A finite palette can only ever offer the colours somebody
 * thought of in advance, and the moment a user wants the one shade that matches
 * something else on their screen, a palette is a wall. So the input is
 * continuous in three independent ways — the platform's own spectrum picker, an
 * OKLCh triple of sliders, and free text that accepts any of the fourteen
 * notations `shared/m3/color.ts` can parse — and the swatches at the bottom are
 * a convenience layered on top of that rather than the way in.
 *
 * OKLCh for the sliders rather than HSL, because it is the space the app's own
 * theme is built in (`theme/m3.ts` derives every role from `srgbToOklch`) and
 * because its lightness axis actually tracks perceived lightness: dragging L in
 * HSL changes how colourful a colour looks as much as how light it is, which
 * makes "a slightly darker version of this" a hunt rather than a drag.
 *
 * The translator is not decoration either. A user pasting a brand colour has it
 * in one notation and the thing they are pasting into wants another, and the
 * alternative to translating here is a second tab and a website. Every row is
 * copyable, the active gamut is named, and a colour that sRGB cannot show says
 * so before it is silently clipped.
 *
 * The contrast readout is the one part that is a *check* rather than a control:
 * a group header whose label matches its own background is legible to nobody,
 * and the editor knows both values, so it says the ratio and the WCAG grade
 * rather than leaving the user to discover it later.
 *
 * What it deliberately does NOT do: store anything, decide what "reset" means,
 * or refuse a value. A colour that fails contrast is reported, not blocked —
 * the user may be styling something this component cannot see.
 */

import { useId, useMemo, useState } from "react";
import { Button, Field, Slider, TextInput } from "./m3-ui";
import { useT } from "../i18n/shared";
import {
  clipsSrgb, contrastGrade, contrastRatio, formatHex, gamutOf, over, parseColor, toCssValue, translate,
  type Color,
} from "../../../shared/m3/color";

/** `<input type="color">` cannot show a token or an out-of-gamut value; the text field holds the truth. */
const SWATCH_FALLBACK = "#808080";

const SWATCH: React.CSSProperties = {
  width: 52,
  height: 44,
  padding: 2,
  border: "1px solid var(--m3-outline)",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-lowest)",
  cursor: "pointer",
  flex: "0 0 auto",
};

export interface ColorFieldProps {
  label: string;
  /** The stored value: any CSS colour, a `var(--token)`, or undefined for "inherits". */
  value?: string;
  /** `undefined` clears the property so it falls back to the theme. */
  onChange: (next: string | undefined) => void;
  /**
   * What this colour will be read against, for the contrast line. Omitted where
   * there is nothing meaningful to compare with — a border, say — and the
   * readout is then left out rather than computed against a guess.
   */
  against?: string;
  /** Names the other side of the contrast comparison, e.g. "Header fill". */
  againstLabel?: string;
  /** Large-text grading thresholds, for a heading-sized label. */
  large?: boolean;
}

export default function ColorField({ label, value, onChange, against, againstLabel, large }: ColorFieldProps) {
  const t = useT();
  const baseId = useId();
  const textId = `${baseId}-text`;
  const [open, setOpen] = useState(false);

  /**
   * Every keystroke is stored, including the half-typed ones.
   *
   * The tempting alternative — hold a local draft and commit only what parses —
   * needs an effect to re-sync when the value changes underneath it, and buys
   * nothing: a colour is applied through a CSS custom property, and CSS ignores
   * a declaration it cannot parse. So `#ab` on the way to `#abcdef` renders as
   * "no override" for one keystroke rather than as a wrong colour, and the
   * field never swallows a character the user typed.
   */
  const parsed = useMemo(() => (value ? parseColor(value) : null), [value]);
  const backdrop = useMemo(() => (against ? parseColor(against) : null), [against]);

  const rows = useMemo(() => (parsed ? translate(parsed) : []), [parsed]);

  const contrast = useMemo(() => {
    if (!parsed || !backdrop) return null;
    // Composited first: contrast against a translucent colour is meaningless
    // without a backdrop, and reporting 20% white over black as white would
    // pass a label nobody can read.
    const ratio = contrastRatio(over(parsed, backdrop), backdrop);
    return { ratio, grade: contrastGrade(ratio, large) };
  }, [parsed, backdrop, large]);

  const commit = (next: Color) => onChange(toCssValue(next));
  const swatchValue = parsed && !clipsSrgb(parsed) ? formatHex(parsed) : SWATCH_FALLBACK;

  return (
    <Field
      id={textId}
      label={label}
      hint={value && !parsed ? t("tabs.colorUnparsed") : undefined}
    >
      <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
        <input
          type="color"
          value={swatchValue}
          aria-label={t("tabs.colorSpectrum", { name: label })}
          onChange={event => onChange(event.target.value)}
          style={SWATCH}
        />
        <TextInput
          id={textId}
          value={value ?? ""}
          spellCheck={false}
          placeholder={t("tabs.styleInherits")}
          aria-label={label}
          aria-invalid={!!value && !parsed}
          onChange={event => onChange(event.target.value || undefined)}
          style={{ flex: "1 1 auto", minWidth: 0, width: "auto", fontFamily: "var(--mono)" }}
        />
        <Button
          variant="text"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          {open ? t("tabs.colorLess") : t("tabs.colorMore")}
        </Button>
        <Button variant="text" disabled={!value} aria-label={t("tabs.styleResetOne", { name: label })} onClick={() => onChange(undefined)}>
          {t("tabs.styleReset")}
        </Button>
      </div>

      {contrast && (
        <p
          className="m3-field-hint"
          data-contrast-grade={contrast.grade}
          style={contrast.grade === "Fail" ? { color: "var(--m3-error)" } : undefined}
        >
          {t("tabs.colorContrast", {
            ratio: contrast.ratio.toFixed(2),
            grade: contrast.grade,
            against: againstLabel ?? "",
          })}
        </p>
      )}

      {open && (
        <div className="m3-color-more">
          {/* The continuous axes. Present whether or not the current value
              parses: with nothing set they start from a neutral mid-grey, which
              is a place to drag from rather than a value pretending to be the
              theme's. */}
          <Slider
            label={t("tabs.colorL")}
            min={0}
            max={100}
            value={Math.round((parsed?.l ?? 0.5) * 100)}
            valueLabel={`${Math.round((parsed?.l ?? 0.5) * 100)}%`}
            onChange={l => commit({ ...(parsed ?? { c: 0, h: 0, alpha: 1 }), l: l / 100 })}
          />
          <Slider
            label={t("tabs.colorC")}
            min={0}
            max={40}
            value={Math.round((parsed?.c ?? 0) * 100)}
            valueLabel={((parsed?.c ?? 0)).toFixed(3)}
            onChange={c => commit({ ...(parsed ?? { l: 0.5, h: 0, alpha: 1 }), c: c / 100 })}
          />
          <Slider
            label={t("tabs.colorH")}
            min={0}
            max={360}
            value={Math.round(parsed?.h ?? 0)}
            valueLabel={`${Math.round(parsed?.h ?? 0)}°`}
            onChange={h => commit({ ...(parsed ?? { l: 0.5, c: 0.1, alpha: 1 }), h })}
          />
          <Slider
            label={t("tabs.colorAlpha")}
            min={0}
            max={100}
            value={Math.round((parsed?.alpha ?? 1) * 100)}
            valueLabel={`${Math.round((parsed?.alpha ?? 1) * 100)}%`}
            onChange={alpha => commit({ ...(parsed ?? { l: 0.5, c: 0.1, h: 0 }), alpha: alpha / 100 })}
          />

          {parsed && (
            <>
              <p className="m3-field-hint" data-color-gamut={gamutOf(parsed)}>
                {t("tabs.colorGamut", { gamut: gamutOf(parsed) })}
                {clipsSrgb(parsed) ? ` — ${t("tabs.colorClips")}` : ""}
              </p>
              {/* Every notation, each copyable. The alternative to translating
                  here is the user opening a second tab and a website. */}
              <ul className="m3-color-rows" aria-label={t("tabs.colorTranslator")}>
                {rows.map(row => (
                  <li key={row.space} className="m3-row" data-color-space={row.space}>
                    <span className="m3-color-space">{row.label}</span>
                    <code className="m3-color-value">{row.value}</code>
                    <Button
                      variant="text"
                      aria-label={t("tabs.colorCopyOne", { space: row.label })}
                      onClick={() => { void navigator.clipboard?.writeText(row.value); }}
                    >
                      {t("tabs.colorCopy")}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Field>
  );
}
