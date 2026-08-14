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

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { onOutsidePress } from "./outside-press";
import { Button, Field, Slider, TextInput } from "./m3-ui";
import { ColorField } from "../components/appearance/ColorPicker";
import { FontPicker } from "../components/appearance/FontPicker";
import { IconLock, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { SettingsSearchRow } from "./SettingsSearch";
import { useSettingsSearch } from "./use-settings-search";
import type { SettingsOption } from "./settings-search";
import { clampToViewport, tabStyleProps, type TabStyle } from "./use-tabs";
import { FONT_CHOICES } from "../theme/m3";
import { LockWizard } from "./LockWizard";
import { UnlockPrompt } from "./UnlockPrompt";
import { findLock, isUnlocked, subscribeLocks } from "./locks";
import { hashRouteFor } from "../app-routing";

/* The hex fallbacks and the `HEX` test that used to live here are gone with the
   `<input type="color">` they existed for. That input cannot hold a CSS variable,
   so every colour row needed a concrete hex for the swatch, a text field beside it
   for the real value, and a hint admitting the swatch was showing something else.
   `ColorField` holds the value itself, so none of that scaffolding has anything
   left to do. */

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

const PANEL: React.CSSProperties = {
  position: "fixed",
  zIndex: 80,
  // `min()` rather than a flat 340: a fixed panel wider than the viewport hangs
  // off the right edge and, because a fixed box still counts toward the
  // document's scrollable overflow, takes the whole page's horizontal scrollbar
  // with it. `clampToViewport` cannot rescue that — it pins the left edge, which
  // on a 320px phone just moves the overflow rather than removing it.
  width: "min(340px, calc(100vw - 16px))",
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
  /**
   * What is being styled.
   *
   * A tab and a group header carry the same `TabStyle` and want the same
   * controls, so they share this editor rather than getting a near-identical
   * second one — the alternative is two panels that drift the moment either
   * gains a property. Only the preview and the accent differ, and both are
   * driven from here.
   */
  kind: "tab" | "group";
  /** The styled record's id, exposed as a data attribute so tests can find it. */
  id: string;
  style: TabStyle | undefined;
  /** The tab's page icon. A group header has none, so the preview omits it. */
  Icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** The visible label — the editor's accessible name, and its preview text. */
  label: string;
  /**
   * A group's accent colour, which lives on the group record rather than in its
   * `TabStyle` because it tints the whole run, not just the header's text.
   * Absent for a tab, and the row is not rendered then.
   */
  accent?: string;
  onAccentChange?: (color: string | undefined) => void;
  /** The button this panel sits beside; it is measured, never mutated. */
  anchor: HTMLElement | null;
  /** Merges a patch into the record's style. `undefined` clears a property. */
  onChange: (patch: TabStyle) => void;
  onClose: () => void;
}

export default function TabAppearanceEditor(props: TabAppearanceEditorProps) {
  const { kind, id, Icon, label, accent, onAccentChange, anchor, onChange, onClose } = props;
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const colorId = `${baseId}-color`;
  const titleId = `${baseId}-title`;
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  const style = props.style ?? {};
  const preview = tabStyleProps(props.style);

  /**
   * "Lock this tab…" / "Lock this group…" — the same `LockWizard` and
   * `UnlockPrompt` every other appearance surface uses, keyed by this panel's
   * own `kind`/`id`, which line up exactly with `LockKind`/`targetId`. Read
   * fresh on every `subscribeLocks` tick rather than once, so a lock created
   * or removed from the Locks list while this panel happens to be open is
   * reflected here without requiring a reopen.
   */
  const [lock, setLock] = useState(() => findLock(kind, id));
  const [lockWizardOpen, setLockWizardOpen] = useState(false);
  // State rather than reading `panelRef.current` inside the JSX below: the
  // wizard needs an anchor element, but resolving one from a ref during
  // render is exactly what `eslint-plugin-react-hooks`'s `refs` rule forbids
  // (refs are for event handlers and effects, not render). Captured at the
  // moment the lock button is actually clicked, which is an event handler.
  const [lockAnchorEl, setLockAnchorEl] = useState<HTMLElement | null>(null);
  // `isUnlocked()` reads session state directly and is not itself reactive —
  // nothing re-renders this panel just because a session grant landed. This
  // flag is what `UnlockPrompt`'s `onUnlocked`/`onRelocked` callbacks flip, so
  // the gate below actually reflects the outcome of using it.
  const [locallyUnlocked, setLocallyUnlocked] = useState(() => (lock ? isUnlocked(lock.id) : false));
  useEffect(() => subscribeLocks(() => setLock(findLock(kind, id))), [kind, id]);
  const gated = !!lock && !locallyUnlocked;

  /**
   * An appearance editor is a settings surface like any other, and seven
   * properties in a 340px panel is exactly the size at which "obviously
   * scannable" stops being true — the badge field is below the fold on a short
   * viewport. Each row carries its current value as well as its name, so typing
   * the colour you set finds the control that set it, and the placeholder text
   * ("Inherits from the theme") is indexed too, because that is what the row
   * visibly reads while a property is unset.
   */
  const options: SettingsOption[] = useMemo(() => {
    const inherits = t("tabs.styleInherits");
    const rows: SettingsOption[] = [
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
    // Only a group has an accent, so it is only searchable while one is being edited.
    if (onAccentChange) {
      rows.unshift({ id: "groupAccent", label: t("tabs.groupAccent"), value: accent ?? inherits, keywords: t("tabs.groupAccentPicker") });
    }
    return rows;
  }, [t, accent, onAccentChange, style.color, style.bg, style.font, style.size, style.weight, style.badge]);

  // `"all"`, not a page id: this panel is anchored to a tab and can be opened
  // from any screen, so none of the app's pages is "here" and every registered
  // setting is legitimately somewhere else. Typing "theme" into a tab's style
  // editor should say that theme lives on Appearance rather than nothing at all.
  const search = useSettingsSearch({ options, scope: "all" });
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
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
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
      data-tab-style-editor={kind === "tab" ? id : undefined}
      data-group-style-editor={kind === "group" ? id : undefined}
      style={{ ...PANEL, left: position.left, top: position.top }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 id={titleId} className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>
          {t(kind === "group" ? "tabs.groupStyleFor" : "tabs.styleFor", { name: label })}
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

      <div className="m3-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <Button
          variant="text"
          onClick={event => { setLockAnchorEl(event.currentTarget); setLockWizardOpen(true); }}
        >
          <span className="m3-row" style={{ gap: 4, alignItems: "center" }}>
            <IconLock width={16} height={16} aria-hidden="true" />
            {lock ? t("locks.changeCredential") : t(kind === "group" ? "lock.wizard.lockThisGroup" : "lock.wizard.lockThisTab")}
          </span>
        </Button>
      </div>

      {lock && (
        <div style={{ marginBottom: 8 }}>
          <UnlockPrompt
            lock={lock}
            onUnlocked={() => setLocallyUnlocked(true)}
            onRelocked={() => setLocallyUnlocked(false)}
            // No Locks-page context to carry across: this panel is not the
            // Locks page, so the ticket form on the far side opens without
            // the convenience prefill that following the link *from* that
            // page gets. `hashRouteFor` is the router's own spelling of the
            // route, kept in step with `app-routing.ts` rather than
            // hand-typed here.
            onForgotten={() => { window.location.hash = hashRouteFor("locks"); }}
          />
        </div>
      )}

      {lockWizardOpen && (
        <LockWizard
          anchor={lockAnchorEl}
          kind={kind}
          targetId={id}
          targetLabel={label}
          onClose={() => setLockWizardOpen(false)}
          onSaved={record => { setLock(record); setLocallyUnlocked(true); setLockWizardOpen(false); }}
        />
      )}

      {/* Every property below is what a lock on this tab/group actually
          protects (as a toy, not a security boundary — see the disclosure
          `UnlockPrompt` itself renders above). Selecting a locked target
          shows the unlock gate rather than teleporting past it into these
          controls, per the contract's own search/palette rule applied here
          to the one surface that already knows this target is locked. */}
      {gated ? null : (
      <>
      <Field label={t("tabs.stylePreview")}>
        {/* Rendered with the same classes and the same `tabStyleProps` the strip
            uses, so the preview cannot show one thing and the strip another. */}
        {kind === "group" ? (
          <div className="m3-tabgroup" style={{ ["--m3-group-color" as string]: accent ?? "var(--m3-tertiary)" }}>
            <span className="m3-tabgroup-head" style={{ ...preview.label, cursor: "default" }}>
              <span className="m3-tabgroup-name">{label}</span>
              {style.badge && <span className="m3-tabgroup-count">{style.badge}</span>}
            </span>
          </div>
        ) : (
          <div className="m3-tab selected" style={{ ...preview.surface, maxWidth: "none", borderRadius: "var(--r-s)" }}>
            <span className="m3-tab-btn" style={{ ...preview.label, cursor: "default" }}>
              {Icon && <Icon aria-hidden />}
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
        )}
      </Field>

      {/* `compact`: this panel is 340px wide, so the row's default field basis
          would push the builder trigger onto a line of its own. */}
      <SettingsSearchRow search={search} compact />

      {/* A group's accent tints its whole run, so it is edited here beside the
          rest of the group's appearance rather than from a separate surface. */}
      {onAccentChange && matches("groupAccent") && (
        <ColorField
          label={t("tabs.groupAccent")}
          value={accent}
          onChange={onAccentChange}
        />
      )}

      {/* The infinite picker, not a swatch input. The two it replaces could not
          accept a CSS variable, so each needed a hex fallback beside it and a
          hint explaining that the swatch was showing something other than the
          stored value — all of which the picker's own value row makes
          unnecessary, while adding alpha, gamut and a contrast readout. */}
      {matches("color") && (
        <ColorField
          id={colorId}
          label={t("tabs.styleColor")}
          value={style.color}
          onChange={color => onChange({ color })}
        />
      )}

      {matches("bg") && (
        <ColorField label={t("tabs.styleBg")} value={style.bg} onChange={bg => onChange({ bg })} />
      )}

      {matches("font") && (
        <Field label={t("tabs.styleFont")}>
          {/* Every installed family, not the five bundled ones the select offered.
              No axis sliders: `TabStyle` stores one stack and has nowhere to put
              axis values, and a slider that saves nothing is worse than none. */}
          <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <FontPicker value={style.font} onChange={font => onChange({ font })} />
            </div>
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
            disabled={!props.style}
            onClick={() => onChange({ color: undefined, bg: undefined, font: undefined, size: undefined, weight: undefined, badge: undefined })}
          >
            {t("tabs.styleResetAll")}
          </Button>
        </div>
      )}
      </>
      )}
    </div>
  );
}
