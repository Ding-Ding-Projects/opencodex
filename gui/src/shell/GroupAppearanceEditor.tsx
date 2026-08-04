/**
 * The per-group appearance editor, anchored beside the group header it edits.
 *
 * A group header is a different kind of element from a tab, and this is why it
 * has its own editor rather than a reused one. A tab has a label and a colour; a
 * group header additionally has a border, a corner radius, spacing to its
 * members, a separator before its run, and four *states* — expanded, collapsed,
 * hovered, focused — that a user can see all of and none of at once. An editor
 * that offered a tab's six properties for a group would leave the other twelve
 * unreachable, which is exactly the gap this closes.
 *
 * Non-modal, like every other anchored surface here. The user opened it to
 * change how a header in front of them looks, so inerting that header and
 * trapping focus away from it would hide the one thing being edited. What it
 * keeps from the dialog contract is the part that is not about blocking: focus
 * moves in on open, Escape closes, an outside click closes, and the header that
 * opened it gets focus back — `onClose` does the restoring, because only the
 * strip knows which button to return to.
 *
 * Every edit applies immediately, so the live preview is the real header in the
 * strip rather than a mock of one. The preview row here exists for the case the
 * header has scrolled out of sight, and for the states that cannot be seen at
 * the same time: the collapsed and hover fills are rendered as static samples
 * because a user cannot hover a header while dragging a slider.
 *
 * ## What decoration is not allowed to do
 *
 * It never replaces the group's accessible name or its expanded/collapsed state.
 * The icon is decoration beside a name that is still text; small caps is a
 * `font-variant`, so the stored name is never rewritten; the badge is additional
 * rather than instead. A screen reader gets `name` and `aria-expanded` whatever
 * this editor is set to — which is the entire reason the decoration lives in a
 * `GroupDecor` record that the header's ARIA never reads.
 *
 * Contrast is checked rather than enforced: `ColorField` reports the ratio and
 * the WCAG grade for the label against the fill it will actually be read on. The
 * editor does not refuse a failing pair, because it cannot see the user's
 * display or their reason — but it never lets one be chosen silently.
 *
 * What it deliberately does NOT do: persist anything itself, record a revision,
 * or store what "default" means. Clearing a property writes `undefined`, which
 * `readGroupDecor` drops, and the header falls back to the theme — a stored copy
 * of today's default would stop following a theme the user later changes.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, Field, SelectField, Slider, TextInput, Toggle } from "./m3-ui";
import ColorField from "./ColorField";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { clampToViewport, groupDecorProps, readGroupDecor, type GroupDecor, type TabGroup } from "./use-tabs";
import { FONT_CHOICES } from "../theme/m3";

/** Matches the clamps in `readGroupDecor`; a slider offering a range the store
 * then narrows would silently discard the end of its own scale. */
const LIMITS = {
  size: { min: 9, max: 24, fallback: 12 },
  weight: { min: 300, max: 700, fallback: 500 },
  radius: { min: 0, max: 24, fallback: 999 },
  border: { min: 0, max: 4, fallback: 0 },
  gap: { min: 0, max: 16, fallback: 4 },
  pad: { min: 0, max: 20, fallback: 10 },
  tracking: { min: -1, max: 4, fallback: 0 },
} as const;

const BADGE_MAX = 12;
/** Two code points: enough for a flag or a ZWJ-free pair, not enough to be a label. */
const ICON_MAX = 2;

const PANEL: React.CSSProperties = {
  position: "fixed",
  zIndex: 80,
  width: 380,
  maxHeight: "min(76vh, 620px)",
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
 * unmounts and remounts it each time — taking the focus ring with it mid-edit.
 */
function ResetButton({ on, name, clear }: { on: boolean; name: string; clear: () => void }) {
  const t = useT();
  return (
    <Button variant="text" disabled={!on} onClick={clear} aria-label={t("tabs.styleResetOne", { name })}>
      {t("tabs.styleReset")}
    </Button>
  );
}

/** A slider with its reset, which is the shape nine of the rows below need. */
function DecorSlider({ label, value, fallback, min, max, step, unit, onChange, onClear }: {
  label: string;
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "end" }}>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <Slider
          label={label}
          min={min}
          max={max}
          step={step}
          value={value ?? fallback}
          valueLabel={value == null ? t("tabs.styleInherits") : `${value}${unit ?? ""}`}
          onChange={onChange}
        />
      </div>
      <ResetButton on={value != null} name={label} clear={onClear} />
    </div>
  );
}

export interface GroupAppearanceEditorProps {
  group: TabGroup;
  /** How many tabs are in it, for the preview's collapsed count. */
  memberCount: number;
  /** The header button this panel sits beside; it is measured, never mutated. */
  anchor: HTMLElement | null;
  /** Merges a decoration patch. `undefined` in a field clears that property. */
  onChange: (patch: Partial<GroupDecor>) => void;
  /** The group accent, which lives on the group record rather than in `decor`. */
  onAccent: (color?: string) => void;
  onRename: (name: string) => void;
  onClose: () => void;
}

export default function GroupAppearanceEditor({
  group, memberCount, anchor, onChange, onAccent, onRename, onClose,
}: GroupAppearanceEditorProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const titleId = `${baseId}-title`;
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const [transfer, setTransfer] = useState<string | null>(null);

  const decor = group.decor ?? {};

  // Measured after paint and re-measured when the page moves under it, so the
  // panel stays beside a header that scrolled or a window that was resized. Off
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

  // Focus lands on the name field, not on the container: focusing the panel
  // would make a keyboard user's first move be tabbing past a heading to reach
  // the thing they opened this for.
  useEffect(() => {
    const field: { focus?: () => void } | null = document.getElementById(nameId);
    field?.focus?.();
  }, [nameId]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    // Escape is handled on the document rather than on the panel: this does not
    // trap focus, so the focused element may legitimately be outside it by the
    // time Escape is pressed, and a handler on the panel would never see it.
    // An Escape inside a nested dialog — the colour translator's own popover —
    // belongs to that dialog and is left alone.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"]');
      if (dialog && dialog !== panelRef.current) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /** The decoration rendered on a sample header, for the states hover cannot show. */
  const sample = (override?: Partial<GroupDecor>) =>
    groupDecorProps({ ...decor, ...override }, group.color) as React.CSSProperties;

  /**
   * Export and import as text rather than as a file dialog.
   *
   * A group's decoration is twenty short values; a textarea the user can copy
   * out of and paste into is a share mechanism that works between two machines,
   * two profiles and a chat window, with no file picker and no permission
   * prompt. It is read back through `readGroupDecor`, so a pasted blob that has
   * been edited by hand cannot put a value into the store that the header would
   * refuse to draw.
   */
  const applyTransfer = () => {
    if (transfer == null) return;
    try {
      const parsed = readGroupDecor(JSON.parse(transfer));
      // A cleared field is a deliberate "reset everything", so an empty parse is
      // applied rather than ignored — the caller's patch names every property.
      onChange({
        icon: undefined, badge: undefined, text: undefined, highlight: undefined, bg: undefined,
        collapsedBg: undefined, hoverBg: undefined, focusRing: undefined, border: undefined,
        borderWidth: undefined, borderStyle: undefined, radius: undefined, gap: undefined,
        pad: undefined, separator: undefined, font: undefined, size: undefined, weight: undefined,
        italic: undefined, underline: undefined, caps: undefined, letterSpacing: undefined,
        ...parsed,
      });
      setTransfer(null);
    } catch {
      // Left in the box with the error stated, rather than silently discarded:
      // the user's paste is the only copy of what they were trying to apply.
      setTransfer(current => current);
    }
  };

  const parsedTransfer = (() => {
    if (transfer == null || !transfer.trim()) return true;
    try { JSON.parse(transfer); return true; } catch { return false; }
  })();

  return (
    <div
      ref={panelRef}
      // `dialog` without `aria-modal`: nothing behind this is inert, and saying
      // otherwise tells a screen reader the rest of the page is unavailable.
      role="dialog"
      aria-labelledby={titleId}
      data-group-style-editor={group.id}
      style={{ ...PANEL, left: position.left, top: position.top }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 id={titleId} className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>
          {t("tabs.groupStyleFor", { name: group.name })}
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

      {/* Four states, side by side. Hover and focus cannot be seen while a
          slider is being dragged, and collapsed cannot be seen while the group
          is open, so each is drawn as a static sample rather than left to be
          discovered later. */}
      <Field label={t("tabs.groupStates")}>
        <div className="m3-group-samples">
          {([
            { key: "expanded", label: t("tabs.groupStateExpanded"), override: undefined },
            { key: "collapsed", label: t("tabs.groupStateCollapsed"), override: { bg: decor.collapsedBg ?? decor.bg } },
            { key: "hover", label: t("tabs.groupStateHover"), override: { bg: decor.hoverBg ?? decor.bg } },
            { key: "focus", label: t("tabs.groupStateFocus"), override: undefined },
          ] as const).map(state => (
            <div key={state.key} className="m3-group-sample" data-group-state={state.key}>
              <span className="m3-group-sample-label">{state.label}</span>
              <span
                className={`m3-tabgroup-head${state.key === "focus" ? " sample-focus" : ""}`}
                style={sample(state.override)}
              >
                {decor.icon && <span aria-hidden="true">{decor.icon}</span>}
                <span className="m3-tabgroup-name">{group.name}</span>
                {state.key === "collapsed" && <span className="m3-tabgroup-count">{memberCount}</span>}
                {decor.badge && <span className="m3-tabgroup-badge">{decor.badge}</span>}
              </span>
            </div>
          ))}
        </div>
      </Field>

      <Field id={nameId} label={t("tabs.groupName")}>
        <TextInput
          id={nameId}
          value={group.name}
          maxLength={64}
          aria-label={t("tabs.groupName")}
          onChange={event => onRename(event.target.value)}
          style={{ width: "100%" }}
        />
      </Field>

      <ColorField
        label={t("tabs.groupAccent")}
        value={group.color}
        onChange={onAccent}
      />

      <h3 className="m3-menu-heading" style={{ padding: "12px 0 0" }}>{t("tabs.groupSectionText")}</h3>

      <ColorField
        label={t("tabs.groupText")}
        value={decor.text}
        onChange={text => onChange({ text })}
        against={decor.highlight ?? decor.bg ?? group.color}
        againstLabel={decor.highlight ? t("tabs.groupHighlight") : t("tabs.groupBg")}
        large
      />
      <ColorField
        label={t("tabs.groupHighlight")}
        value={decor.highlight}
        onChange={highlight => onChange({ highlight })}
      />

      <Field label={t("tabs.styleFont")}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <SelectField
            label={t("tabs.styleFont")}
            value={decor.font ?? ""}
            onChange={next => onChange({ font: next || undefined })}
            options={[
              { value: "", label: t("tabs.styleFontInherit") },
              ...FONT_CHOICES.map(font => ({ value: font.stack, label: font.label })),
            ]}
            style={{ flex: "1 1 auto", minWidth: 0 }}
          />
          <ResetButton on={!!decor.font} name={t("tabs.styleFont")} clear={() => onChange({ font: undefined })} />
        </div>
      </Field>

      <DecorSlider
        label={t("tabs.styleSize")}
        value={decor.size}
        fallback={LIMITS.size.fallback}
        min={LIMITS.size.min}
        max={LIMITS.size.max}
        unit="px"
        onChange={size => onChange({ size })}
        onClear={() => onChange({ size: undefined })}
      />
      <DecorSlider
        label={t("tabs.styleWeight")}
        value={decor.weight}
        fallback={LIMITS.weight.fallback}
        min={LIMITS.weight.min}
        max={LIMITS.weight.max}
        step={100}
        onChange={weight => onChange({ weight })}
        onClear={() => onChange({ weight: undefined })}
      />
      <DecorSlider
        label={t("tabs.groupTracking")}
        value={decor.letterSpacing}
        fallback={LIMITS.tracking.fallback}
        min={LIMITS.tracking.min}
        max={LIMITS.tracking.max}
        step={0.5}
        unit="px"
        onChange={letterSpacing => onChange({ letterSpacing })}
        onClear={() => onChange({ letterSpacing: undefined })}
      />

      {/* Italic, underline and small caps are switches rather than a single
          "style" select, because they compose: a group can be all three. */}
      <div className="m3-row" style={{ gap: 16, flexWrap: "wrap", margin: "8px 0" }}>
        {([
          { key: "italic", label: t("tabs.groupItalic") },
          { key: "underline", label: t("tabs.groupUnderline") },
          { key: "caps", label: t("tabs.groupCaps") },
        ] as const).map(row => (
          <div key={row.key} className="m3-row" style={{ gap: 8, fontSize: "var(--t-body-s)" }}>
            <Toggle
              on={!!decor[row.key]}
              onChange={on => onChange({ [row.key]: on || undefined } as Partial<GroupDecor>)}
              label={row.label}
            />
            {/* A div rather than a <label>: a `<label>` wrapping a button does
                not make the text activate it, so it would look clickable and do
                nothing. The switch carries its own accessible name. */}
            <span aria-hidden="true">{row.label}</span>
          </div>
        ))}
      </div>

      <Field label={t("tabs.groupIcon")} hint={t("tabs.groupIconHint")}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <TextInput
            value={decor.icon ?? ""}
            maxLength={ICON_MAX * 2}
            aria-label={t("tabs.groupIcon")}
            onChange={event => onChange({ icon: event.target.value || undefined })}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
          />
          <ResetButton on={!!decor.icon} name={t("tabs.groupIcon")} clear={() => onChange({ icon: undefined })} />
        </div>
      </Field>

      <Field label={t("tabs.styleBadge")} hint={t("tabs.styleBadgeHint", { max: String(BADGE_MAX) })}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <TextInput
            value={decor.badge ?? ""}
            maxLength={BADGE_MAX}
            aria-label={t("tabs.styleBadge")}
            onChange={event => onChange({ badge: event.target.value || undefined })}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
          />
          <ResetButton on={!!decor.badge} name={t("tabs.styleBadge")} clear={() => onChange({ badge: undefined })} />
        </div>
      </Field>

      <h3 className="m3-menu-heading" style={{ padding: "12px 0 0" }}>{t("tabs.groupSectionSurface")}</h3>

      <ColorField
        label={t("tabs.groupBg")}
        value={decor.bg}
        onChange={bg => onChange({ bg })}
      />
      <ColorField
        label={t("tabs.groupCollapsedBg")}
        value={decor.collapsedBg}
        onChange={collapsedBg => onChange({ collapsedBg })}
      />
      <ColorField
        label={t("tabs.groupHoverBg")}
        value={decor.hoverBg}
        onChange={hoverBg => onChange({ hoverBg })}
      />
      <ColorField
        label={t("tabs.groupFocusRing")}
        value={decor.focusRing}
        onChange={focusRing => onChange({ focusRing })}
        against={decor.bg ?? group.color}
        againstLabel={t("tabs.groupBg")}
      />

      <h3 className="m3-menu-heading" style={{ padding: "12px 0 0" }}>{t("tabs.groupSectionShape")}</h3>

      <ColorField
        label={t("tabs.groupBorder")}
        value={decor.border}
        onChange={border => onChange({ border })}
      />
      <DecorSlider
        label={t("tabs.groupBorderWidth")}
        value={decor.borderWidth}
        fallback={LIMITS.border.fallback}
        min={LIMITS.border.min}
        max={LIMITS.border.max}
        unit="px"
        onChange={borderWidth => onChange({ borderWidth })}
        onClear={() => onChange({ borderWidth: undefined })}
      />
      <Field label={t("tabs.groupBorderStyle")}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <SelectField
            label={t("tabs.groupBorderStyle")}
            value={decor.borderStyle ?? ""}
            onChange={next => onChange({ borderStyle: (next || undefined) as GroupDecor["borderStyle"] })}
            options={[
              { value: "", label: t("tabs.styleFontInherit") },
              { value: "solid", label: t("tabs.groupBorderSolid") },
              { value: "dashed", label: t("tabs.groupBorderDashed") },
              { value: "dotted", label: t("tabs.groupBorderDotted") },
            ]}
            style={{ flex: "1 1 auto", minWidth: 0 }}
          />
          <ResetButton
            on={!!decor.borderStyle}
            name={t("tabs.groupBorderStyle")}
            clear={() => onChange({ borderStyle: undefined })}
          />
        </div>
      </Field>
      <DecorSlider
        label={t("tabs.groupRadius")}
        value={decor.radius}
        fallback={12}
        min={LIMITS.radius.min}
        max={LIMITS.radius.max}
        unit="px"
        onChange={radius => onChange({ radius })}
        onClear={() => onChange({ radius: undefined })}
      />
      <DecorSlider
        label={t("tabs.groupPad")}
        value={decor.pad}
        fallback={LIMITS.pad.fallback}
        min={LIMITS.pad.min}
        max={LIMITS.pad.max}
        unit="px"
        onChange={pad => onChange({ pad })}
        onClear={() => onChange({ pad: undefined })}
      />
      <DecorSlider
        label={t("tabs.groupGap")}
        value={decor.gap}
        fallback={LIMITS.gap.fallback}
        min={LIMITS.gap.min}
        max={LIMITS.gap.max}
        unit="px"
        onChange={gap => onChange({ gap })}
        onClear={() => onChange({ gap: undefined })}
      />
      <Field label={t("tabs.groupSeparator")} hint={t("tabs.groupSeparatorHint")}>
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <SelectField
            label={t("tabs.groupSeparator")}
            value={decor.separator ?? ""}
            onChange={next => onChange({ separator: (next || undefined) as GroupDecor["separator"] })}
            options={[
              { value: "", label: t("tabs.styleFontInherit") },
              { value: "none", label: t("tabs.groupSepNone") },
              { value: "line", label: t("tabs.groupSepLine") },
              { value: "space", label: t("tabs.groupSepSpace") },
            ]}
            style={{ flex: "1 1 auto", minWidth: 0 }}
          />
          <ResetButton
            on={!!decor.separator}
            name={t("tabs.groupSeparator")}
            clear={() => onChange({ separator: undefined })}
          />
        </div>
      </Field>

      <h3 className="m3-menu-heading" style={{ padding: "12px 0 0" }}>{t("tabs.groupSectionShare")}</h3>

      {transfer == null ? (
        <div className="m3-row" style={{ gap: 8, marginTop: 8 }}>
          <Button variant="outlined" onClick={() => setTransfer(JSON.stringify(decor, null, 2))}>
            {t("tabs.groupExport")}
          </Button>
          <Button variant="outlined" onClick={() => setTransfer("")}>
            {t("tabs.groupImport")}
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <Field
            label={t("tabs.groupTransfer")}
            hint={parsedTransfer ? t("tabs.groupTransferHint") : t("tabs.groupTransferInvalid")}
          >
            <textarea
              className="m3-input"
              rows={5}
              spellCheck={false}
              value={transfer}
              aria-label={t("tabs.groupTransfer")}
              aria-invalid={!parsedTransfer}
              onChange={event => setTransfer(event.target.value)}
              style={{ width: "100%", fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}
            />
          </Field>
          <div className="m3-row" style={{ gap: 8, justifyContent: "end" }}>
            <Button variant="text" onClick={() => setTransfer(null)}>{t("tabs.cancel")}</Button>
            <Button disabled={!parsedTransfer} onClick={applyTransfer}>{t("tabs.groupTransferApply")}</Button>
          </div>
        </div>
      )}

      <div className="m3-row" style={{ justifyContent: "end", marginTop: 12 }}>
        <Button
          variant="outlined"
          disabled={!group.decor && !group.color}
          onClick={() => {
            onAccent(undefined);
            onChange({
              icon: undefined, badge: undefined, text: undefined, highlight: undefined, bg: undefined,
              collapsedBg: undefined, hoverBg: undefined, focusRing: undefined, border: undefined,
              borderWidth: undefined, borderStyle: undefined, radius: undefined, gap: undefined,
              pad: undefined, separator: undefined, font: undefined, size: undefined, weight: undefined,
              italic: undefined, underline: undefined, caps: undefined, letterSpacing: undefined,
            });
          }}
        >
          {t("tabs.styleResetAll")}
        </Button>
      </div>
    </div>
  );
}
