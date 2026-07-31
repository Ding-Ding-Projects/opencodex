/**
 * Word-processor-depth typography controls.
 *
 * Every property `shared/m3/typography.ts` models has a control here, including
 * the ones CSS supports badly. That is the requirement and it is also the
 * interesting design constraint: a property the platform cannot honour "stays
 * visible with a clear platform-capability explanation instead of disappearing
 * or silently dropping a saved value". So `CapabilityNote` renders beside each
 * control, sourced from the same `CAPABILITIES` table the CSS generator reads —
 * one description of what `strike: "double"` compiles to, not two that can
 * drift.
 *
 * Nothing here has a default. An unset property shows "inherits" rather than a
 * number, and its reset is *disabled* rather than hidden so the rows do not
 * change height as properties are cleared and the control a user is reaching for
 * does not slide out from under the pointer. Storing a copy of today's default
 * would also stop the element following a theme they change tomorrow, which is
 * the whole reason unset is a distinct state.
 *
 * Every colour control is the infinite picker. There is no `<input type="color">`
 * in this file, deliberately: that control is swatch-and-spectrum in some
 * browsers and a fixed grid in others, has no alpha, no colour space, no gamut
 * and no contrast readout, and the rule names it explicitly as insufficient.
 *
 * `match` is how this surface answers the rule that every settings surface
 * carries its own search. Each row asks the predicate about its own visible
 * label and hides itself when the answer is no; the editor above owns the field,
 * the anchored regex builder beside it, and the count of what is hidden. Rows
 * filter themselves rather than being filtered against a table of labels held
 * elsewhere, because such a table goes stale the first time a label is reworded
 * and nothing fails — the setting simply becomes unfindable.
 */

import { useId } from "react";
import {
  CAPABILITY_BY_ID,
  capabilityState,
  type CapsMode,
  type ScriptMode,
  type SlantMode,
  type StrikeMode,
  type TextAlign,
  type TextDirection,
  type TypographyStyle,
  type UnderlineStyle,
} from "../../../../shared/m3/typography";
import type { TFn } from "../../lib/strings";
import { Button, Chip } from "../ui";
import { ColorField } from "./ColorPicker";
import { FontPicker } from "./FontPicker";

export interface TypographyEditorProps {
  style: TypographyStyle;
  /** `undefined` in a patch clears that property. */
  onChange: (patch: Partial<TypographyStyle>) => void;
  t: TFn;
  /** The settings search. Absent means "show everything". */
  match?: (label: string) => boolean;
}

/**
 * What a control compiles to, and where the platform falls short.
 *
 * Rendered for every state except a clean "supported", including `"unknown"`:
 * a browser with no `CSS.supports` has not told us the feature is missing, and
 * saying nothing there would be as misleading as claiming full support.
 */
function CapabilityNote({ id, t }: { id: string; t: TFn }) {
  const capability = CAPABILITY_BY_ID[id];
  if (!capability) return null;
  const state = capabilityState(id);
  if (state === "supported") return null;
  const message =
    state === "unsupported" ? t("type.unsupported", { css: capability.css })
    : state === "unknown" ? t("type.unknown", { css: capability.css })
    : t("type.partial", { caveat: capability.caveat });
  return <p className={`m3-field-hint ap-cap ap-cap--${state}`}>{message}</p>;
}

/** A per-property reset, disabled rather than hidden — see the module comment. */
function Reset({ on, name, clear, t }: { on: boolean; name: string; clear: () => void; t: TFn }) {
  return (
    <Button variant="text" disabled={!on} aria-label={t("ap.resetOne", { name })} onClick={clear}>
      {t("ap.reset")}
    </Button>
  );
}

/** A number slider whose unset state reads "inherits" instead of a fabricated default. */
function NumberRow({ label, id, value, fallback, min, max, step, unit, onChange, onClear, capability, t, match }: {
  label: string;
  id: string;
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  onClear: () => void;
  capability?: string;
  t: TFn;
  match?: (label: string) => boolean;
}) {
  if (match && !match(label)) return null;
  return (
    <div className="ap-row">
      <label className="m3-field-label" htmlFor={id}>{label}</label>
      <div className="m3-slider-row">
        <input
          id={id}
          className="m3-slider"
          type="range"
          min={min}
          max={max}
          step={step ?? 1}
          value={value ?? fallback}
          onChange={event => onChange(Number(event.target.value))}
        />
        <span className="m3-slider-value">{value == null ? t("ap.inherits") : `${value}${unit ?? ""}`}</span>
        <Reset on={value != null} name={label} clear={onClear} t={t} />
      </div>
      {capability ? <CapabilityNote id={capability} t={t} /> : null}
    </div>
  );
}

/** A row of mutually exclusive chips where "unset" is one of the options. */
function ChoiceRow<T extends string>({ label, value, options, onChange, capability, t, match }: {
  label: string;
  value: T | undefined;
  options: { value: T | undefined; label: string }[];
  onChange: (value: T | undefined) => void;
  capability?: string;
  t: TFn;
  match?: (label: string) => boolean;
}) {
  if (match && !match(label)) return null;
  return (
    <div className="ap-row">
      <span className="m3-field-label">{label}</span>
      <div className="ap-chips" role="group" aria-label={label}>
        {options.map(option => (
          <Chip
            key={option.value ?? "__unset"}
            selected={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Chip>
        ))}
      </div>
      {capability ? <CapabilityNote id={capability} t={t} /> : null}
    </div>
  );
}

export function TypographyEditor({ style, onChange, t, match }: TypographyEditorProps) {
  const id = useId();
  /** Whether a row survives the settings search. */
  const show = (label: string) => !match || match(label);
  /** A colour row that answers the same search as every other row. */
  const Color = (props: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; hint?: string }) =>
    show(props.label) ? <ColorField {...props} t={t} /> : null;

  return (
    <div className="ap-type">
      {show(t("font.family")) && (
        <>
          <FontPicker
            value={style.family}
            onChange={family => onChange({ family })}
            axes={style.axes}
            onAxes={axes => onChange({ axes })}
            t={t}
          />
          <CapabilityNote id="axes" t={t} />
        </>
      )}

      <NumberRow
        id={`${id}-size`} label={t("type.size")} value={style.size} fallback={16}
        min={6} max={96} unit="px" t={t} match={match}
        onChange={size => onChange({ size })} onClear={() => onChange({ size: undefined })}
      />
      <NumberRow
        id={`${id}-weight`} label={t("type.weight")} value={style.weight} fallback={400}
        min={100} max={900} step={50} capability="weight" t={t} match={match}
        onChange={weight => onChange({ weight })} onClear={() => onChange({ weight: undefined })}
      />

      <ChoiceRow<SlantMode>
        label={t("type.slant")} value={style.slant} capability="slant" t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "none", label: t("ap.none") },
          { value: "italic", label: t("type.italic") },
          { value: "oblique", label: t("type.oblique") },
        ]}
        onChange={slant => onChange({ slant })}
      />
      {style.slant === "oblique" && (
        <NumberRow
          id={`${id}-oblique`} label={t("type.obliqueAngle")} value={style.obliqueAngle} fallback={14}
          min={-45} max={45} unit="°" t={t} match={match}
          onChange={obliqueAngle => onChange({ obliqueAngle })} onClear={() => onChange({ obliqueAngle: undefined })}
        />
      )}

      <ChoiceRow<UnderlineStyle>
        label={t("type.underline")} value={style.underline} capability="underline" t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "none", label: t("ap.none") },
          { value: "solid", label: t("box.solid") },
          { value: "double", label: t("box.double") },
          { value: "dotted", label: t("box.dotted") },
          { value: "dashed", label: t("box.dashed") },
          { value: "wavy", label: "wavy" },
        ]}
        onChange={underline => onChange({ underline })}
      />
      {style.underline && style.underline !== "none" && (
        <>
          <Color
            label={t("type.underlineColor")} value={style.underlineColor}
            onChange={underlineColor => onChange({ underlineColor })}
          />
          <NumberRow
            id={`${id}-ulw`} label={t("type.underlineThickness")} value={style.underlineThickness} fallback={1}
            min={0} max={12} unit="px" capability="underlineThickness" t={t} match={match}
            onChange={underlineThickness => onChange({ underlineThickness })}
            onClear={() => onChange({ underlineThickness: undefined })}
          />
        </>
      )}

      <ChoiceRow<StrikeMode>
        label={t("type.strike")} value={style.strike} capability="strike" t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "none", label: t("ap.none") },
          { value: "single", label: t("type.strikeSingle") },
          { value: "double", label: t("type.strikeDouble") },
        ]}
        onChange={strike => onChange({ strike })}
      />

      {show(t("type.overline")) && <div className="ap-row">
        <span className="m3-field-label">{t("type.overline")}</span>
        <div className="ap-chips">
          <Chip selected={!!style.overline} onClick={() => onChange({ overline: style.overline ? undefined : true })}>
            {style.overline ? t("type.overline") : t("ap.none")}
          </Chip>
        </div>
      </div>}

      <ChoiceRow<CapsMode>
        label={t("type.caps")} value={style.caps} capability="caps" t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "none", label: t("ap.none") },
          { value: "uppercase", label: t("type.upper") },
          { value: "lowercase", label: t("type.lower") },
          { value: "capitalize", label: t("type.capitalize") },
          { value: "small-caps", label: t("type.smallCaps") },
          { value: "all-small-caps", label: t("type.allSmallCaps") },
        ]}
        onChange={caps => onChange({ caps })}
      />

      <ChoiceRow<ScriptMode>
        label={t("type.script")} value={style.script} capability="script" t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "none", label: t("ap.none") },
          { value: "super", label: t("type.super") },
          { value: "sub", label: t("type.sub") },
        ]}
        onChange={script => onChange({ script })}
      />

      <Color label={t("type.color")} value={style.color} onChange={color => onChange({ color })} />
      <Color
        label={t("type.highlight")} value={style.highlight}
        onChange={highlight => onChange({ highlight })}
        hint={CAPABILITY_BY_ID.highlight?.caveat}
      />

      <NumberRow
        id={`${id}-outline`} label={t("type.outline")} value={style.outlineWidth} fallback={0}
        min={0} max={6} step={0.25} unit="px" capability="outlineWidth" t={t} match={match}
        onChange={outlineWidth => onChange({ outlineWidth })} onClear={() => onChange({ outlineWidth: undefined })}
      />
      {!!style.outlineWidth && (
        <Color label={t("type.outlineColor")} value={style.outlineColor} onChange={outlineColor => onChange({ outlineColor })} />
      )}

      <NumberRow
        id={`${id}-shx`} label={t("type.shadowX")} value={style.shadowX} fallback={0}
        min={-20} max={20} unit="px" t={t} match={match}
        onChange={shadowX => onChange({ shadowX })} onClear={() => onChange({ shadowX: undefined })}
      />
      <NumberRow
        id={`${id}-shy`} label={t("type.shadowY")} value={style.shadowY} fallback={1}
        min={-20} max={20} unit="px" t={t} match={match}
        onChange={shadowY => onChange({ shadowY })} onClear={() => onChange({ shadowY: undefined })}
      />
      <NumberRow
        id={`${id}-shb`} label={t("type.shadowBlur")} value={style.shadowBlur} fallback={2}
        min={0} max={40} unit="px" t={t} match={match}
        onChange={shadowBlur => onChange({ shadowBlur })} onClear={() => onChange({ shadowBlur: undefined })}
      />
      <Color label={t("type.shadowColor")} value={style.shadowColor} onChange={shadowColor => onChange({ shadowColor })} />

      <NumberRow
        id={`${id}-glow`} label={t("type.glow")} value={style.glowBlur} fallback={0}
        min={0} max={40} unit="px" capability="glowBlur" t={t} match={match}
        onChange={glowBlur => onChange({ glowBlur })} onClear={() => onChange({ glowBlur: undefined })}
      />
      {!!style.glowBlur && (
        <Color label={t("type.glowColor")} value={style.glowColor} onChange={glowColor => onChange({ glowColor })} />
      )}

      <NumberRow
        id={`${id}-ls`} label={t("type.letterSpacing")} value={style.letterSpacing} fallback={0}
        min={-4} max={16} step={0.1} unit="px" t={t} match={match}
        onChange={letterSpacing => onChange({ letterSpacing })} onClear={() => onChange({ letterSpacing: undefined })}
      />
      <NumberRow
        id={`${id}-ws`} label={t("type.wordSpacing")} value={style.wordSpacing} fallback={0}
        min={-8} max={40} step={0.5} unit="px" t={t} match={match}
        onChange={wordSpacing => onChange({ wordSpacing })} onClear={() => onChange({ wordSpacing: undefined })}
      />
      <NumberRow
        id={`${id}-lh`} label={t("type.lineHeight")} value={style.lineHeight} fallback={1.5}
        min={0.8} max={3} step={0.05} t={t} match={match}
        onChange={lineHeight => onChange({ lineHeight })} onClear={() => onChange({ lineHeight: undefined })}
      />
      <NumberRow
        id={`${id}-bl`} label={t("type.baseline")} value={style.baselineShift} fallback={0}
        min={-20} max={20} unit="px" capability="baselineShift" t={t} match={match}
        onChange={baselineShift => onChange({ baselineShift })} onClear={() => onChange({ baselineShift: undefined })}
      />

      <ChoiceRow<TextDirection>
        label={t("type.direction")} value={style.direction} t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "ltr", label: t("type.ltr") },
          { value: "rtl", label: t("type.rtl") },
        ]}
        onChange={direction => onChange({ direction })}
      />
      <ChoiceRow<TextAlign>
        label={t("type.align")} value={style.align} t={t} match={match}
        options={[
          { value: undefined, label: t("ap.inherits") },
          { value: "start", label: t("type.alignStart") },
          { value: "center", label: t("type.alignCenter") },
          { value: "end", label: t("type.alignEnd") },
          { value: "justify", label: t("type.alignJustify") },
        ]}
        onChange={align => onChange({ align })}
      />
    </div>
  );
}
