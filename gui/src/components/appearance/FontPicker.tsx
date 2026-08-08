/**
 * The typeface picker: every family this machine has, each previewed in its own
 * face, searchable, with the variable axes it actually carries.
 *
 * Three things make this more than the five chips it replaces, and all three are
 * required:
 *
 *  1. **Each family is rendered in itself.** A list of names in the UI font
 *     tells the reader nothing about the difference between two grotesques, and
 *     nothing at all about whether a face covers 廣東話.
 *  2. **The list says where it came from.** `queryLocalFonts` is Chromium-only
 *     and permission-gated, so on most engines this is a *measured* list of
 *     families we thought to name. Presenting that as "your fonts" would be a
 *     lie the user discovers by not finding theirs, so the note says what it is
 *     and the free-text field below accepts any family name regardless.
 *  3. **Axes are read from the font.** `shared/m3/fonts.ts` parses the `fvar`
 *     table out of the actual file. An axis list written by hand is a claim
 *     about a file on someone else's computer.
 *
 * The catalogue note is rendered from a translated key rather than the English
 * sentence the shared module returns, because this app renders in eight locales
 * with a per-language funny level over the top. `reason` is the shared module's
 * machine-readable version of the same fact, and it exists for exactly this.
 *
 * The search carries the anchored regex builder, per the rule that every search
 * bar does. Plain text is the default; regex is opt-in and shares one string
 * with the field, so the two can never disagree about what is being searched.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { FontCatalogue, FontFamily, VariationAxis } from "../../../../shared/m3/fonts";
import { familyOf, guiStackFor, loadGuiAxesFor, loadGuiFontCatalogue } from "../../theme/fonts";
// The one predicate every search bar in this repository compiles. It lives in
// the tab module because that is where it was first needed, not because it is
// about tabs: plain text by default, an opt-in regex sharing the same string,
// and the same caps. A second copy here would be a second place the two modes
// could stop being inverses of each other.
import { tabMatcher } from "../../shell/use-tabs";
import { useT } from "../../i18n/shared";
import type { TKey } from "../../i18n/shared";
import { Button, Chip, Field, TextInput } from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";

export interface FontPickerProps {
  /** The full stack currently applied, or undefined for "inherits". */
  value: string | undefined;
  onChange: (stack: string | undefined) => void;
  /** Axis values currently set, so the sliders start where the style is. */
  axes?: Record<string, number> | undefined;
  /**
   * Absent on a surface whose style model has nowhere to put axes — the tab
   * editor, today. The axis sliders are then not rendered at all rather than
   * rendered inert: a control that moves and changes nothing is worse than one
   * that is honestly missing.
   */
  onAxes?: (axes: Record<string, number> | undefined) => void;
  /** The settings search this surface sits under. Absent means "show everything". */
  match?: (label: string) => boolean;
}

/** Why the catalogue is what it is, as a key this app can translate. */
const REASON_KEY: Record<FontCatalogue["reason"], TKey | null> = {
  granted: null,
  notPrompted: "font.noteNotPrompted",
  unsupported: "font.noteUnsupported",
  denied: "font.noteDenied",
  failed: "font.noteFailed",
  noSurface: "font.noteNoSurface",
};

export function FontPicker({ value, onChange, axes, onAxes, match }: FontPickerProps) {
  const t = useT();
  const [catalogue, setCatalogue] = useState<FontCatalogue | null>(null);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [custom, setCustom] = useState("");
  const [liveAxes, setLiveAxes] = useState<VariationAxis[] | undefined>(undefined);
  const [axesLoaded, setAxesLoaded] = useState(false);
  const id = useId();

  const selected = familyOf(value);

  /* The catalogue is loaded once per mount and never prompts on its own: a
     permission dialog nobody asked for, fired by merely opening a font menu, is
     the kind of thing a reader denies permanently out of irritation — which
     would degrade this picker for good. The button below asks explicitly. */
  useEffect(() => {
    let alive = true;
    void loadGuiFontCatalogue().then(result => {
      if (alive) setCatalogue(result);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Only read when the surface can actually store axes and a family is chosen.
  // The early return leaves the previous family's axes in state, which is safe
  // because the axis block does not render at all in either of those cases —
  // and clearing them here would be a synchronous state write in an effect,
  // costing an extra render pass to reach the same screen.
  useEffect(() => {
    if (!selected || !onAxes) return;
    let alive = true;
    const read = async () => {
      setAxesLoaded(false);
      const result = await loadGuiAxesFor(selected);
      if (!alive) return;
      setLiveAxes(result);
      setAxesLoaded(true);
    };
    void read();
    return () => {
      alive = false;
    };
  }, [selected, onAxes]);

  const families = useMemo(() => catalogue?.families ?? [], [catalogue]);

  /**
   * The filtered list.
   *
   * An invalid regex shows *everything* rather than nothing. A half-typed
   * pattern is invalid for most of the time it is being typed, and a list that
   * empties itself on every third keystroke reads as "no fonts match" — the
   * error belongs in the builder, which says exactly what is wrong with it.
   */
  const shown = useMemo(() => {
    const test = tabMatcher(query, regex);
    if (!test.ok) return families;
    return families.filter(f => test.test(f.family));
  }, [families, query, regex]);

  const grantAccess = useCallback(async () => {
    setCatalogue(await loadGuiFontCatalogue({ allowPrompt: true }));
  }, []);

  const choose = (family: FontFamily | string) => {
    const name = typeof family === "string" ? family : family.family;
    onChange(typeof family === "string" ? guiStackFor(name) : family.stack);
    // Axes belong to a face. Carrying a `wdth` set on one family over to another
    // that has no such axis leaves a `font-variation-settings` that silently
    // does nothing, and the slider that set it would still be showing a value.
    onAxes?.(undefined);
  };

  const noteKey = catalogue ? REASON_KEY[catalogue.reason] : null;
  const canPrompt =
    typeof window !== "undefined" && "queryLocalFonts" in window && catalogue != null && catalogue.source !== "local";

  if (match && !match(t("font.family"))) return null;

  return (
    <div className="ap-fonts">
      <div className="ap-search" role="search">
        <label className="sr-only" htmlFor={`${id}-q`}>{t("font.search")}</label>
        <TextInput
          id={`${id}-q`}
          type="search"
          value={query}
          placeholder={t("font.searchPh")}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in, as on every
            other search bar in the app. */}
        <Chip selected={regex} onClick={() => setRegex(v => !v)} title={t("regex.regexMode")}>
          <code>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          onApply={pattern => setQuery(pattern)}
          regex={regex}
          onRegexChange={setRegex}
          // The list itself is the sample, so a pattern is previewed against the
          // exact strings it will be run against rather than against lorem ipsum.
          sample={families.map(f => f.family).join("\n")}
          label={t("font.openBuilder")}
        />
      </div>

      {/* A list of toggle buttons, not a `listbox`: a listbox owns its options
          directly and is one tab stop with arrow-key navigation, and this is
          neither — so claiming the role would describe a widget that does not
          behave the way it says it does. */}
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
              {/* The name in its own face, which is the whole point: two
                  grotesques are indistinguishable as words in the UI font. */}
              <span className="ap-fonts__name" style={{ fontFamily: family.stack }}>{family.family}</span>
              <span className="ap-fonts__sample" style={{ fontFamily: family.stack }}>{t("font.sample")}</span>
            </button>
          </li>
        ))}
      </ul>

      {noteKey && <p className="m3-field-hint">{t(noteKey)}</p>}
      {canPrompt && (
        <Button variant="outlined" onClick={grantAccess} title={t("font.installedHint")}>
          {t("font.installed")}
        </Button>
      )}

      <Field id={`${id}-custom`} label={t("font.custom")} hint={t("font.customHint")}>
        <div className="ap-search">
          <TextInput
            id={`${id}-custom`}
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
          <Button variant="tonal" disabled={!custom.trim()} onClick={() => choose(custom.trim())}>
            {t("ap.use")}
          </Button>
        </div>
      </Field>

      {selected && onAxes && (
        <div className="ap-fonts__axes">
          <span className="m3-field-label">{t("font.axes")}</span>
          {!axesLoaded && <p className="m3-field-hint">{t("font.axesLoading")}</p>}
          {/* `undefined` and `[]` are different facts: one is "we could not
              read the file", the other is "we read it and it is static". Only
              the second is a reason to stop offering axis sliders. */}
          {axesLoaded && liveAxes === undefined && <p className="m3-field-hint">{t("font.axesUnknown")}</p>}
          {axesLoaded && liveAxes?.length === 0 && <p className="m3-field-hint">{t("font.axesNone")}</p>}
          {liveAxes?.map(axis => (
            <label key={axis.tag} className="ap-axis">
              <span>
                {axis.name} <code>{axis.tag}</code>
              </span>
              <input
                type="range"
                className="m3-slider"
                min={axis.min}
                max={axis.max}
                step={(axis.max - axis.min) / 100}
                value={axes?.[axis.tag] ?? axis.default}
                aria-label={t("font.axisLabel", { name: axis.name, tag: axis.tag })}
                onChange={event => onAxes({ ...(axes ?? {}), [axis.tag]: Number(event.target.value) })}
              />
              <span className="m3-slider-value">{Math.round(axes?.[axis.tag] ?? axis.default)}</span>
            </label>
          ))}
        </div>
      )}

      {value != null && (
        <Button
          variant="text"
          onClick={() => {
            onChange(undefined);
            onAxes?.(undefined);
          }}
        >
          {t("ap.resetOne", { name: t("font.family") })}
        </Button>
      )}
    </div>
  );
}
