/**
 * The per-element appearance editor: one anchored, non-modal panel for every
 * element on the site.
 *
 * Generalised from `gui/src/shell/TabAppearanceEditor.tsx` rather than copied
 * per element type. That editor knows it is editing a tab — the style lives on
 * the tab record and the strip applies it — and there is no equivalent record
 * behind a heading, a link card, a code block or Starlight's search field. So
 * the target here is an `ElementTarget` derived from the DOM
 * (`shared/m3/elements.ts`) and the style is stored against its id, which means
 * a new element type needs no new component and no new store.
 *
 * Non-modal, deliberately and specifically. The user opened this to change how
 * something in front of them looks; inerting the page would hide the one thing
 * being edited, and every change here applies live, so the preview is the real
 * element rather than a mock of one. What it keeps from the dialog contract is
 * the part that is not about blocking: focus moves in on open, Escape closes,
 * an outside click closes, and the element that opened it gets focus back.
 *
 * Below `NARROW_PX` it becomes a bottom sheet instead. That is the modal
 * fallback the rules permit "only at genuinely constrained widths" — a 340px
 * panel anchored to a 40px-wide element on a 360px phone cannot be both beside
 * its anchor and on screen, and pretending otherwise produces a panel hanging
 * half off the edge. The sheet still returns focus to the originating element on
 * close, which is the part that must not be traded away.
 *
 * The search field at the top is not decoration either: every settings surface
 * carries one wired to the regex builder, searching its own option labels,
 * descriptions and current values, and saying plainly when a match sits on a
 * different tab. `matchesSection` below is what makes the last part true.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { computePlacement } from "../../../../shared/m3/anchor";
import {
  declarationsFor,
  type ElementStyle,
  type ElementTarget,
} from "../../../../shared/m3/elements";
// See `FontPicker` — one shared predicate, so plain-text and regex modes
// cannot drift apart between two search fields on the same panel.
import { tabMatcher as matcher } from "../../../../shared/m3/tabs";
import { isEmptyTypography, type TypographyStyle } from "../../../../shared/m3/typography";
import type { TFn } from "../../lib/strings";
import type { DocsPreset } from "../../lib/element-styles";
import { Button, Chip, Field } from "../ui";
import { ColorField } from "./ColorPicker";
import { RegexBuilderButton } from "./RegexPopover";
import { TypographyEditor } from "./TypographyEditor";

/** Below this the anchored panel cannot fit beside anything; see the module comment. */
const NARROW_PX = 560;

type Section = "text" | "box" | "presets";

export interface ElementAppearanceEditorProps {
  target: ElementTarget;
  /** The clicked element's containers, so the user can retarget upwards. */
  chain: ElementTarget[];
  style: ElementStyle | undefined;
  onChange: (patch: Partial<ElementStyle>) => void;
  onText: (patch: Partial<TypographyStyle>) => void;
  onResetElement: () => void;
  onResetAll: () => void;
  onRetarget: (target: ElementTarget) => void;
  /** The node this panel sits beside. Measured, never mutated. */
  anchor: HTMLElement | null;
  onClose: () => void;
  presets: DocsPreset[];
  onSavePreset: (name: string) => void;
  onApplyPreset: (preset: DocsPreset) => void;
  onDeletePreset: (name: string) => void;
  onExportPresets: () => void;
  onImportPresets: (file: File) => void;
  t: TFn;
}

export function ElementAppearanceEditor(props: ElementAppearanceEditorProps) {
  const { target, chain, style, onChange, onText, onClose, anchor, t } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const [section, setSection] = useState<Section>("text");
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [flags, setFlags] = useState("i");
  const [presetName, setPresetName] = useState("");
  const [narrow, setNarrow] = useState(false);
  const [placement, setPlacement] = useState({ side: "below" as "below" | "above", left: 0, top: 0, maxHeight: 520 });

  /* Measured in a layout effect — after the DOM is committed but BEFORE the
     browser paints — so the panel's first frame is already in the right place;
     a panel that paints at 0,0 and then jumps reads as a flicker bug. Re-measured
     on scroll and resize so it stays beside an element that moved. */
  const place = useCallback(() => {
    const isNarrow = window.innerWidth < NARROW_PX;
    setNarrow(isNarrow);
    if (isNarrow) return;
    const rect = anchor?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!rect || !panel) return;
    const computed = computePlacement(
      rect,
      { width: panel.width, height: panel.height },
      { width: window.innerWidth, height: window.innerHeight },
      { align: "start" },
    );
    setPlacement({
      side: computed.side,
      // `computePlacement` returns a wrapper-relative left; this panel is
      // `position: fixed` against the viewport because its anchor is an
      // arbitrary node elsewhere in the document, so the anchor's own left is
      // added back.
      left: rect.left + computed.left,
      top: computed.side === "above" ? Math.max(8, rect.top - panel.height - 8) : rect.bottom + 8,
      maxHeight: computed.maxHeight,
    });
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    // Capturing: the scroll that moves this is usually an ancestor's, and those
    // do not bubble.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);

  // Focus the search field, not the container: focusing the panel makes a
  // keyboard user's first move be tabbing past a heading to reach what they
  // opened this for.
  useEffect(() => { searchRef.current?.focus(); }, [target.id]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    // Escape is handled on the document rather than the panel: this does not
    // trap focus, so the focused element may legitimately be outside it by the
    // time Escape is pressed and a handler on the panel would never see it. The
    // nested popovers stop their own Escape first, so one press closes one layer.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /**
   * The settings search.
   *
   * Matches an option's label *and* its current value, per the rule — someone
   * who remembers setting something to `oklch(60% …)` and not what the control
   * was called can still find it. An invalid regex matches everything rather
   * than nothing, because a pattern is invalid for most of the time it is being
   * typed and a panel that empties itself mid-keystroke reads as "no settings".
   */
  const test = useMemo(() => matcher(query, regex, flags), [query, regex, flags]);
  const match = useCallback((label: string) => {
    if (!test.ok) return true;
    return test.test(label);
  }, [test]);

  /**
   * Which other sections hold a match, so the panel can say so.
   *
   * Only the box and preset sections can be answered from a static label list;
   * the text section's labels live in `TypographyEditor`, which filters itself.
   * So this reports the two it can name and never claims the text tab is empty —
   * a false "nothing here" is worse than no hint at all.
   */
  const boxLabels = useMemo(() => [
    t("box.bg"), t("box.radius"), t("box.pad"), t("box.border"),
    t("box.borderColor"), t("box.borderStyle"), t("box.elevation"), t("box.opacity"),
  ], [t]);
  const presetLabels = useMemo(() => [t("preset.title"), t("preset.save"), t("preset.export"), t("preset.import")], [t]);

  const elsewhere = useMemo(() => {
    if (!test.ok || !query.trim()) return [] as { section: Section; label: string }[];
    const out: { section: Section; label: string }[] = [];
    if (section !== "box" && boxLabels.some(l => test.test(l))) out.push({ section: "box", label: t("ap.secBox") });
    if (section !== "presets" && presetLabels.some(l => test.test(l))) out.push({ section: "presets", label: t("ap.secPresets") });
    return out;
  }, [test, query, section, boxLabels, presetLabels, t]);

  const preview = declarationsFor(style) as CSSProperties;
  const hasStyle = !!style && Object.keys(style).length > 0;
  const textStyle: TypographyStyle = style?.text ?? {};

  const searchable = [
    ...boxLabels, ...presetLabels,
    t("font.family"), t("type.size"), t("type.weight"), t("type.color"),
  ].join("\n");

  const body = (
    <>
      <header className="ap-editor__head">
        <h2 id={`${id}-title`} className="ap-editor__title">{t("ap.title", { name: target.label })}</h2>
        <button type="button" className="ap-iconbtn" aria-label={t("ap.close")} title={t("ap.close")} onClick={onClose}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <p className="m3-field-hint ap-editor__scope">
        {t("ap.applies", { name: target.label })} <code>{target.selector}</code>
      </p>

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
          query={query} onQuery={setQuery}
          regex={regex} onRegex={setRegex}
          flags={flags} onFlags={setFlags}
          sample={searchable}
          t={t}
          returnFocusTo={() => searchRef.current}
        />
      </div>
      {elsewhere.length > 0 && (
        <p className="ap-editor__elsewhere" role="status">
          {elsewhere.map(hit => (
            <button key={hit.section} type="button" className="ap-editor__jump" onClick={() => setSection(hit.section)}>
              {hit.label}
            </button>
          ))}
        </p>
      )}

      {chain.length > 1 && (
        <div className="ap-row">
          <span className="m3-field-label">{t("ap.containers")}</span>
          <div className="ap-chips">
            {chain.map(item => (
              <Chip key={item.id} selected={item.id === target.id} onClick={() => props.onRetarget(item)}>
                {item.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="ap-editor__preview" aria-label={t("ap.preview")}>
        <span style={preview}>{t("ap.previewText")}</span>
      </div>

      <div className="ap-editor__tabs" role="tablist" aria-label={t("ap.title", { name: target.label })}>
        {(["text", "box", "presets"] as Section[]).map(key => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-tab-${key}`}
            aria-selected={section === key}
            aria-controls={`${id}-panel`}
            tabIndex={section === key ? 0 : -1}
            className={`ap-editor__tab${section === key ? " selected" : ""}`}
            onClick={() => setSection(key)}
            onKeyDown={event => {
              const order: Section[] = ["text", "box", "presets"];
              const at = order.indexOf(section);
              if (event.key === "ArrowRight") setSection(order[(at + 1) % order.length]);
              else if (event.key === "ArrowLeft") setSection(order[(at - 1 + order.length) % order.length]);
              else return;
              event.preventDefault();
            }}
          >
            {key === "text" ? t("ap.secText") : key === "box" ? t("ap.secBox") : t("ap.secPresets")}
          </button>
        ))}
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${section}`} className="ap-editor__panel">
        {section === "text" && (
          <TypographyEditor style={textStyle} onChange={onText} t={t} match={match} />
        )}

        {section === "box" && (
          <>
            {match(t("box.bg")) && (
              <ColorField label={t("box.bg")} value={style?.bg} t={t} onChange={bg => onChange({ bg })} />
            )}
            {match(t("box.radius")) && (
              <NumberRow id={`${id}-r`} label={t("box.radius")} value={style?.radius} fallback={12} min={0} max={64} unit="px" t={t}
                onChange={radius => onChange({ radius })} onClear={() => onChange({ radius: undefined })} />
            )}
            {match(t("box.pad")) && (
              <NumberRow id={`${id}-p`} label={t("box.pad")} value={style?.pad} fallback={12} min={0} max={80} unit="px" t={t}
                onChange={pad => onChange({ pad })} onClear={() => onChange({ pad: undefined })} />
            )}
            {match(t("box.border")) && (
              <NumberRow id={`${id}-b`} label={t("box.border")} value={style?.border} fallback={1} min={0} max={12} unit="px" t={t}
                onChange={border => onChange({ border })} onClear={() => onChange({ border: undefined })} />
            )}
            {!!style?.border && match(t("box.borderColor")) && (
              <ColorField label={t("box.borderColor")} value={style?.borderColor} t={t} onChange={borderColor => onChange({ borderColor })} />
            )}
            {!!style?.border && match(t("box.borderStyle")) && (
              <div className="ap-row">
                <span className="m3-field-label">{t("box.borderStyle")}</span>
                <div className="ap-chips" role="group" aria-label={t("box.borderStyle")}>
                  {(["solid", "dashed", "dotted", "double"] as const).map(value => (
                    <Chip key={value} selected={style?.borderStyle === value} onClick={() => onChange({ borderStyle: value })}>
                      {t(`box.${value}`)}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
            {match(t("box.elevation")) && (
              <div className="ap-row">
                <span className="m3-field-label">{t("box.elevation")}</span>
                <div className="ap-chips" role="group" aria-label={t("box.elevation")}>
                  {([undefined, "none", "e1", "e2", "e3"] as const).map(value => (
                    <Chip key={value ?? "__unset"} selected={style?.elevation === value} onClick={() => onChange({ elevation: value })}>
                      {value === undefined ? t("ap.inherits") : value === "none" ? t("ap.none") : value}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
            {match(t("box.opacity")) && (
              <NumberRow id={`${id}-o`} label={t("box.opacity")} value={style?.opacity} fallback={1} min={0} max={1} step={0.05} t={t}
                onChange={opacity => onChange({ opacity })} onClear={() => onChange({ opacity: undefined })} />
            )}
          </>
        )}

        {section === "presets" && (
          <>
            <p className="m3-field-hint">{t("preset.includes")}</p>
            <Field id={`${id}-pn`} label={t("preset.name")}>
              <div className="ap-search">
                <input
                  id={`${id}-pn`}
                  className="m3-input"
                  value={presetName}
                  placeholder={t("preset.namePh")}
                  maxLength={64}
                  onChange={event => setPresetName(event.target.value)}
                />
                <Button
                  variant="filled"
                  disabled={!presetName.trim()}
                  onClick={() => { props.onSavePreset(presetName.trim()); setPresetName(""); }}
                >
                  {t("preset.save")}
                </Button>
              </div>
            </Field>

            {props.presets.length === 0 && <p className="m3-field-hint">{t("preset.none")}</p>}
            <ul className="ap-presets">
              {props.presets.map(preset => (
                <li key={preset.name}>
                  <button type="button" className="ap-presets__apply" onClick={() => props.onApplyPreset(preset)}>
                    <strong>{preset.name}</strong>
                    <span>{new Date(preset.createdAt).toLocaleDateString()}</span>
                  </button>
                  <Button variant="text" aria-label={t("preset.delete", { name: preset.name })} onClick={() => props.onDeletePreset(preset.name)}>
                    {t("ap.reset")}
                  </Button>
                </li>
              ))}
            </ul>

            <div className="ap-editor__actions">
              <Button variant="outlined" onClick={props.onExportPresets}>{t("preset.export")}</Button>
              <Button variant="outlined" onClick={() => fileRef.current?.click()}>{t("preset.import")}</Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="m3-sr-only"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) props.onImportPresets(file);
                  // Cleared so choosing the same file twice fires `change` again;
                  // without this a failed import cannot be retried.
                  event.target.value = "";
                }}
              />
            </div>
          </>
        )}
      </div>

      <div className="ap-editor__actions">
        <Button variant="outlined" disabled={!hasStyle && isEmptyTypography(style?.text)} onClick={props.onResetElement}>
          {t("ap.resetElement")}
        </Button>
        <Button variant="text" onClick={props.onResetAll}>{t("ap.resetAll")}</Button>
      </div>
      <p className="m3-field-hint">{t("ap.keyboardHint")}</p>
    </>
  );

  if (narrow) {
    return (
      <div
        ref={panelRef}
        className="ap-editor ap-editor--sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-m3-el="appearanceEditor"
      >
        {body}
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="ap-editor"
      // `dialog` with no `aria-modal`: nothing behind this is inert, and saying
      // otherwise tells a screen reader the rest of the page is unavailable.
      role="dialog"
      aria-labelledby={`${id}-title`}
      data-side={placement.side}
      data-m3-el="appearanceEditor"
      style={{ left: placement.left, top: placement.top, maxHeight: placement.maxHeight }}
    >
      {body}
    </div>
  );
}

/** Local twin of the typography editor's row, for the box properties. */
function NumberRow({ label, id, value, fallback, min, max, step, unit, onChange, onClear, t }: {
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
  t: TFn;
}) {
  return (
    <div className="ap-row">
      <label className="m3-field-label" htmlFor={id}>{label}</label>
      <div className="m3-slider-row">
        <input id={id} className="m3-slider" type="range" min={min} max={max} step={step ?? 1}
          value={value ?? fallback} onChange={event => onChange(Number(event.target.value))} />
        <span className="m3-slider-value">{value == null ? t("ap.inherits") : `${value}${unit ?? ""}`}</span>
        <Button variant="text" disabled={value == null} aria-label={t("ap.resetOne", { name: label })} onClick={onClear}>
          {t("ap.reset")}
        </Button>
      </div>
    </div>
  );
}
