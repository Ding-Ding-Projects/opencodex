/**
 * The typeface picker: every family this machine has, each previewed in its own
 * face, searchable, with the variable axes it actually carries.
 *
 * Three things make this more than a `<select>`, and all three are required:
 *
 *  1. **Each family is rendered in itself.** A list of names in the UI font
 *     tells the reader nothing about the difference between two grotesques.
 *     Only the rows on screen are given their own `font-family`, because a
 *     hundred simultaneous font loads is a visible stall on a phone — the list
 *     is windowed by the search, which is what keeps that number small.
 *  2. **The list says where it came from.** `queryLocalFonts` is Chromium-only
 *     and permission-gated, so on most browsers this is a *measured* list of
 *     families we thought to name. Presenting that as "your fonts" would be a
 *     lie the user discovers by not finding theirs, so the note says what it is
 *     and the free-text field below accepts any family name regardless.
 *  3. **Axes are read from the font.** `shared/m3/fonts.ts` parses the `fvar`
 *     table out of the actual file. An axis list written by hand is a claim
 *     about a file on someone else's computer.
 *
 * The search carries the anchored regex builder, per the rule that every search
 * bar does. Plain text is the default; regex is opt-in and shares one string
 * with the field, so the two can never disagree about what is being searched.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  loadAxesFor,
  loadFontCatalogue,
  stackFor,
  type FontCatalogue,
  type FontFamily,
  type VariationAxis,
} from "../../../../shared/m3/fonts";
// The one predicate every search bar in this repository compiles. It lives in
// the tab module because that is where it was first needed, not because it is
// about tabs: plain text by default, an opt-in regex sharing the same string,
// and the same caps. A second copy here would be a second place the two modes
// could stop being inverses of each other.
import { tabMatcher as matcher } from "../../../../shared/m3/tabs";
import type { TFn } from "../../lib/strings";
import { Button, Field } from "../ui";
import { RegexBuilderButton } from "./RegexPopover";

export interface FontPickerProps {
  /** The full stack currently applied, or undefined for "inherits". */
  value: string | undefined;
  onChange: (stack: string | undefined) => void;
  /** Axis values currently set, so the sliders start where the style is. */
  axes: Record<string, number> | undefined;
  onAxes: (axes: Record<string, number> | undefined) => void;
  t: TFn;
}

/** The family name out of a stack, so a stored stack selects its own row. */
function familyOf(stack: string | undefined): string | null {
  if (!stack) return null;
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "") || null;
}

export function FontPicker({ value, onChange, axes, onAxes, t }: FontPickerProps) {
  const [catalogue, setCatalogue] = useState<FontCatalogue | null>(null);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [flags, setFlags] = useState("i");
  const [custom, setCustom] = useState("");
  const [liveAxes, setLiveAxes] = useState<VariationAxis[] | undefined>(undefined);
  const [axesLoaded, setAxesLoaded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const selected = familyOf(value);

  /* The catalogue is loaded once per mount and never prompts on its own: a
     permission dialog nobody asked for, fired by merely opening a font menu, is
     the kind of thing a reader denies permanently out of irritation — which
     would degrade this picker for good. The button below asks explicitly. */
  useEffect(() => {
    let alive = true;
    void loadFontCatalogue().then(result => { if (alive) setCatalogue(result); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selected) { setLiveAxes(undefined); setAxesLoaded(true); return; }
    let alive = true;
    setAxesLoaded(false);
    void loadAxesFor(selected).then(result => {
      if (!alive) return;
      setLiveAxes(result);
      setAxesLoaded(true);
    });
    return () => { alive = false; };
  }, [selected]);

  const families = catalogue?.families ?? [];

  /**
   * The filtered list.
   *
   * An invalid regex shows *everything* rather than nothing. A half-typed
   * pattern is invalid for most of the time it is being typed, and a list that
   * empties itself on every third keystroke reads as "no fonts match" — the
   * error belongs in the builder, which says exactly what is wrong with it.
   */
  const shown = useMemo(() => {
    const test = matcher(query, regex, flags);
    if (!test.ok) return families;
    return families.filter(f => test.test(f.family));
  }, [families, query, regex, flags]);

  const grantAccess = useCallback(async () => {
    setCatalogue(await loadFontCatalogue({ allowPrompt: true }));
  }, []);

  const choose = (family: FontFamily | string) => {
    const name = typeof family === "string" ? family : family.family;
    onChange(typeof family === "string" ? stackFor(name) : family.stack);
    // Axes belong to a face. Carrying a `wdth` set on one family over to another
    // that has no such axis leaves a `font-variation-settings` that silently
    // does nothing, and the slider that set it would still be showing a value.
    onAxes(undefined);
  };

  const setAxis = (tag: string, next: number) => {
    onAxes({ ...(axes ?? {}), [tag]: next });
  };

  const sourceNote = !catalogue ? "" : catalogue.note;
  const canPrompt = typeof window !== "undefined" && "queryLocalFonts" in window && catalogue?.source !== "local";

  return (
    <div className="ap-fonts">
      <div className="ap-search">
        <label className="m3-sr-only" htmlFor={`${id}-q`}>{t("font.search")}</label>
        <input
          ref={searchRef}
          id={`${id}-q`}
          className="m3-input"
          type="search"
          value={query}
          placeholder={t("font.searchPh")}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
        />
        <RegexBuilderButton
          query={query}
          onQuery={setQuery}
          regex={regex}
          onRegex={setRegex}
          flags={flags}
          onFlags={setFlags}
          // The list itself is the sample, so a pattern is previewed against the
          // exact strings it will be run against rather than against lorem ipsum.
          sample={families.map(f => f.family).join("\n")}
          t={t}
          returnFocusTo={() => searchRef.current}
        />
      </div>

      {/* A list of toggle buttons, not a `listbox`. See the note in the a11y
          pass: a listbox owns its options directly and is one tab stop with
          arrow-key navigation, and this is neither — so claiming the role would
          describe a widget that does not behave the way it says it does. */}
      <ul className="ap-fonts__list" aria-label={t("font.family")}>
        {shown.length === 0 && <li className="ap-fonts__empty">{t("font.noMatch")}</li>}
        {shown.map(family => (
          <li key={family.family}>
            <button
              type="button"
              aria-pressed={family.family === selected}
              className={`ap-fonts__row${family.family === selected ? " selected" : ""}`}
              onClick={() => choose(family)}
            >
              <span className="ap-fonts__name">{family.family}</span>
              <span className="ap-fonts__sample" style={{ fontFamily: family.stack }}>{t("font.sample")}</span>
            </button>
          </li>
        ))}
      </ul>

      {sourceNote && <p className="m3-field-hint">{sourceNote}</p>}
      {canPrompt && (
        <Button variant="outlined" onClick={grantAccess} title={t("font.installedHint")}>{t("font.installed")}</Button>
      )}

      <Field id={`${id}-custom`} label={t("font.custom")}>
        <div className="ap-search">
          <input
            id={`${id}-custom`}
            className="m3-input"
            value={custom}
            placeholder={t("font.customPh")}
            spellCheck={false}
            autoComplete="off"
            onChange={event => setCustom(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter" || !custom.trim()) return;
              event.preventDefault();
              choose(custom.trim());
            }}
          />
          <Button variant="tonal" disabled={!custom.trim()} onClick={() => choose(custom.trim())}>{t("ap.use")}</Button>
        </div>
      </Field>

      {selected && (
        <div className="ap-fonts__axes">
          <span className="m3-field-label">{t("font.axes")}</span>
          {!axesLoaded && <p className="m3-field-hint">…</p>}
          {axesLoaded && liveAxes === undefined && <p className="m3-field-hint">{t("font.axesUnknown")}</p>}
          {axesLoaded && liveAxes?.length === 0 && <p className="m3-field-hint">{t("font.axesNone")}</p>}
          {liveAxes?.map(axis => (
            <label key={axis.tag} className="ap-axis">
              <span>{axis.name} <code>{axis.tag}</code></span>
              <input
                type="range"
                className="m3-slider"
                min={axis.min}
                max={axis.max}
                step={(axis.max - axis.min) / 100}
                value={axes?.[axis.tag] ?? axis.default}
                onChange={event => setAxis(axis.tag, Number(event.target.value))}
              />
              <span className="m3-slider-value">{Math.round(axes?.[axis.tag] ?? axis.default)}</span>
            </label>
          ))}
        </div>
      )}

      {value != null && (
        <Button variant="text" onClick={() => { onChange(undefined); onAxes(undefined); }}>
          {t("ap.resetOne", { name: t("font.family") })}
        </Button>
      )}
    </div>
  );
}
