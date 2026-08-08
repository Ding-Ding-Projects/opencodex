/**
 * The regex builder, anchored to the search bar that opens it.
 *
 * Every search bar in the app used to "offer" the builder with an anchor pointing
 * at the `#regex` route — a link that navigated the whole window to the builder
 * page. That is the defect this replaces: leaving the field you are typing in,
 * building a pattern on another screen, and then carrying it back by hand is
 * the entire problem, and no amount of polish on the destination page fixes it.
 * `RegexBuilderButton` is a drop-in for that anchor. Same 48px icon button, same
 * place in the row, but it opens the builder *beside* the field instead of
 * replacing the screen, and hands the finished pattern straight back.
 *
 * Anchored, not modal. The panel is `position: fixed` and placed from the
 * trigger's measured rect, repositioning on scroll and resize so it moves with
 * the button and can never visually detach from it. It was `absolute` inside the
 * trigger's wrapper, which needed no listener but was clipped by every scrolling
 * ancestor between the two — and this opens from search bars inside two of them.
 * `showModal()` is
 * deliberately not used: the user opened this to build a pattern for the field
 * behind it, so inerting that field and trapping focus would be exactly wrong.
 * What it does keep from the dialog contract is the part that is not about
 * blocking: Escape closes and returns focus to the trigger, an outside click
 * closes, and focus moves into the panel on open.
 *
 * The evaluation is not implemented here — it comes from `src/regex/engine.ts`,
 * shared with the full-page builder, so the two surfaces cannot disagree about
 * what a pattern matches or which index a named group has.
 *
 * What it deliberately does NOT do: persist anything, run the host's search, or
 * transmit a pattern. Applying calls `onApply` and closes; the host owns its own
 * query, its own mode and its own storage.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { INITIAL_PLACEMENT, fixedPanelStyle, type Placement } from "../../../shared/m3/anchor";
import { computeViewportPlacement } from "./use-anchored-placement";
import { Button, Chip, Field, TextArea, TextInput } from "./m3-ui";
import { IconRegex, IconX } from "../icons";
import { useT } from "../i18n/shared";
import {
  EMPTY_MARK, FLAGS, MATCH_CAP, NO_VALUE_MARK, PATTERN_CAP, SAMPLE_CAP, TOKEN_GROUPS,
  capPattern, capSample, describeGroups, evaluate, groupNameMap, groupsLabel,
} from "../regex/engine";
import type { TFn } from "../i18n/shared";

/**
 * The flags every search bar in this app actually compiles today (`new
 * RegExp(query, "i")`). Seeding anything else would have the popover report
 * matches the host search then does not find, which is the drift this component
 * exists to remove. A host that compiles different flags passes its own.
 */
const DEFAULT_FLAGS = "i";

/**
 * Placement comes from `shared/m3/anchor.ts`.
 *
 * It used to be a file-local `computePlacement` here — and that function is
 * literally where the shared one was ported *from*, so for a while the
 * repository had the original and the extraction sitting side by side. They had
 * already diverged in the way that matters on a phone: the local copy returned
 * only a wrapper-relative `left`, for a panel positioned `absolute` inside the
 * trigger's wrapper, and an `overflow` ancestor clips an absolutely positioned
 * descendant at the container's edge rather than the viewport's. This panel
 * opens from search bars inside two of them — `.m3-page` scrolls, and the tab
 * strip's own menus scroll — so at 320px, where the horizontal clamp produces a
 * large negative offset, the builder was cut off on the left every time.
 *
 * `position: fixed` plus the shared module's viewport coordinates is the only
 * thing that escapes that, which is why the shared version returns both spaces.
 */

export interface RegexBuilderButtonProps {
  /** The host search field's current text. Seeds the pattern when the panel opens. */
  value: string;
  /** The user committed a pattern. The host writes it into its own query state. */
  onApply: (pattern: string, flags: string) => void;
  /** The host's regex-mode flag, when it has one. */
  regex?: boolean;
  /** Present when the host can be switched into regex mode; applying switches it. */
  onRegexChange?: (next: boolean) => void;
  /** The flags the host compiles. Defaults to the `i` every search bar uses today. */
  flags?: string;
  /** Real rows from the host surface, so the pattern is tested against actual data. */
  sample?: string;
  /** Overrides the trigger's accessible name where "Open regex builder" is ambiguous. */
  label?: string;
  /**
   * The icon-button class of the row this replaces an anchor in. Not every search
   * row uses `m3-icon-btn`: the Models screen has its own 44px `models-icon-btn`,
   * and swapping the class as a side effect of this change would resize a control
   * that only ever changed what it opens.
   */
  className?: string;
}

export function RegexBuilderButton({ value, onApply, regex, onRegexChange, flags, sample, label, className }: RegexBuilderButtonProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const triggerLabel = label ?? t("search.openBuilder");

  /**
   * Every close a keyboard user drove has to put focus back on the trigger.
   * Memoized so the document listeners below can depend on it honestly rather
   * than closing over a fresh copy each render and pretending they do not.
   */
  const closeAndRestore = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape is handled on the document rather than on the panel: the panel does
    // not trap focus, so by the time Escape is pressed the focused element may
    // legitimately be outside it, and a handler on the panel would never see it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAndRestore();
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closeAndRestore]);

  return (
    <div className="m3-rxpop-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={className ?? "m3-icon-btn"}
        // `dialog`, not `menu`: what opens is a form, and a screen reader that
        // announces "menu" primes the user for arrow-key navigation this has none of.
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={triggerLabel}
        aria-label={triggerLabel}
        onClick={() => setOpen(prev => !prev)}
      >
        <IconRegex width={20} height={20} aria-hidden="true" />
      </button>

      {/*
        Mounted only while open, which is what makes the seed a `useState`
        initializer rather than an effect that has to notice `value` changing
        after the fact. Re-opening always re-seeds from the field as it is now.
      */}
      {open && (
        <RegexPopover
          id={panelId}
          t={t}
          anchorRef={wrapRef}
          seedPattern={value}
          seedFlags={flags ?? DEFAULT_FLAGS}
          seedSample={sample ?? ""}
          hostRegexMode={regex}
          canSwitchMode={!!onRegexChange}
          onDismiss={closeAndRestore}
          onApply={(pattern, appliedFlags) => {
            onApply(pattern, appliedFlags);
            // The host is told about the mode before the panel goes away: a
            // pattern written into a field still in plain-text mode is matched
            // literally, which silently finds nothing.
            onRegexChange?.(true);
            closeAndRestore();
          }}
        />
      )}
    </div>
  );
}

const MONO = { fontFamily: "var(--mono)" } as const;

function RegexPopover({
  id, t, anchorRef, seedPattern, seedFlags, seedSample, hostRegexMode, canSwitchMode, onApply, onDismiss,
}: {
  id: string;
  t: TFn;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  seedPattern: string;
  seedFlags: string;
  seedSample: string;
  hostRegexMode?: boolean;
  canSwitchMode: boolean;
  onApply: (pattern: string, flags: string) => void;
  onDismiss: () => void;
}) {
  const [pattern, setPattern] = useState(() => capPattern(seedPattern));
  const [flags, setFlags] = useState(seedFlags);
  const [sample, setSample] = useState(() => capSample(seedSample));
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT);

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `${id}-title`;
  const errorId = `${id}-error`;
  const patternId = `${id}-pattern`;
  const sampleId = `${id}-sample`;

  const result = useMemo(() => evaluate(pattern, flags, sample), [pattern, flags, sample]);
  const captureGroups = useMemo(() => describeGroups(pattern, result), [pattern, result]);
  const groupNames = useMemo(() => groupNameMap(captureGroups), [captureGroups]);

  // Focus goes to the pattern field, not to the panel: that is the control the
  // user opened this for, and focusing the container would make the first thing
  // a keyboard user does be tabbing past the heading to reach it.
  //
  // Looked up by id rather than held in a ref because `TextInput` is a plain
  // function component that does not forward one, and teaching it to would
  // change a primitive fifteen screens share for the sake of one caller.
  useEffect(() => {
    const field: { focus?: () => void } | null = document.getElementById(patternId);
    field?.focus?.();
  }, [patternId]);

  // Measured after paint, then remeasured whenever the page moves under it, so
  // the panel stays attached to a trigger that scrolled or a window that resized.
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(computeViewportPlacement(anchor, panel, {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    };
    reposition();
    window.addEventListener("resize", reposition);
    // Capturing, because the scroll that moves this panel is usually a scrolling
    // ancestor (`.m3-page`) rather than the window, and those do not bubble.
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  const toggleFlag = (flag: string) => {
    setFlags(prev => (prev.includes(flag) ? prev.replace(flag, "") : prev + flag));
  };

  const canApply = !!pattern && !result.error;

  return (
    <div
      id={id}
      ref={panelRef}
      role="dialog"
      // No `aria-modal`: this does not inert anything behind it, and claiming
      // otherwise tells a screen reader the rest of the page is unavailable.
      aria-labelledby={titleId}
      className={`m3-rxpop m3-rxpop--${placement.side}`}
      style={fixedPanelStyle(placement)}
    >
      <header className="m3-rxpop-head">
        <h2 className="m3-rxpop-title" id={titleId}>{t("regex.title")}</h2>
        <button
          type="button"
          className="m3-icon-btn m3-rxpop-close"
          title={t("regexpop.close")}
          aria-label={t("regexpop.close")}
          onClick={onDismiss}
        >
          <IconX width={18} height={18} aria-hidden="true" />
        </button>
      </header>

      <div className="m3-rxpop-body">
        <p className="m3-rxpop-engine">{t("regex.engineNote")}</p>

        <Field
          id={patternId}
          label={t("regex.pattern")}
          hint={t("regex.patternCap", { used: String(pattern.length), cap: String(PATTERN_CAP) })}
        >
          {/* The `/…/flags` delimiters make the literal the user is building readable at a glance. */}
          <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <span aria-hidden="true" className="m3-rxpop-slash">/</span>
            <TextInput
              id={patternId}
              value={pattern}
              spellCheck={false}
              aria-invalid={!!result.error}
              aria-describedby={errorId}
              onChange={e => setPattern(capPattern(e.target.value))}
              style={{ ...MONO, flex: "1 1 auto", minWidth: 0, width: "auto" }}
            />
            <span aria-hidden="true" className="m3-rxpop-slash">/{flags}</span>
          </div>
        </Field>

        {/* Reserved height: the error appearing must not shove the flags row down. */}
        <p id={errorId} role="alert" className="m3-rxpop-error">
          {result.error ? `${t("regex.invalid")}: ${result.error}` : ""}
        </p>

        <Field label={t("regex.flags")}>
          <div className="m3-row" style={{ gap: 6 }} role="group" aria-label={t("regex.flags")}>
            {FLAGS.map(f => (
              <Chip key={f.flag} selected={flags.includes(f.flag)} onClick={() => toggleFlag(f.flag)} title={t(f.tkey)}>
                <code style={MONO}>{f.flag}</code>
              </Chip>
            ))}
          </div>
        </Field>

        <div className="m3-rxpop-section" role="group" aria-label={t("regex.palette")}>
          <h3 className="m3-rxpop-heading">{t("regex.build")}</h3>
          {TOKEN_GROUPS.map(group => (
            <div key={group.tkey} className="m3-rxpop-tokgroup">
              <h4 className="m3-rxpop-subheading">{t(group.tkey)}</h4>
              <div className="m3-row" style={{ gap: 6 }} role="group" aria-label={t(group.tkey)}>
                {/* The description stays visible rather than moving into a `title`:
                    a tooltip is unreachable by keyboard and never read aloud, so
                    the construct would be a bare symbol for everyone who needs it
                    explained most. */}
                {group.items.map(tok => (
                  <Chip
                    key={tok.insert}
                    onClick={() => setPattern(prev => capPattern(prev + tok.insert))}
                  >
                    <code style={MONO}>{tok.insert}</code>
                    <span className="m3-rxpop-tokdesc">{t(tok.tkey)}</span>
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>

        <Field
          id={sampleId}
          label={t("regex.sample")}
          hint={t("regex.sampleCap", { used: String(sample.length), cap: String(SAMPLE_CAP) })}
        >
          <TextArea
            id={sampleId}
            value={sample}
            spellCheck={false}
            rows={4}
            onChange={e => setSample(capSample(e.target.value))}
          />
        </Field>

        <div className="m3-rxpop-section">
          <h3 className="m3-rxpop-heading">
            {t("regex.matches")}
            {" · "}
            {result.truncated
              ? t("regex.matchTruncated", { cap: String(MATCH_CAP) })
              : t("regex.matchCountValue", { count: String(result.rows.length) })}
          </h3>
          {result.rows.length === 0 ? (
            <p className="m3-rxpop-empty">{pattern && !result.error ? t("regex.noMatches") : ""}</p>
          ) : (
            <ul className="m3-rxpop-list">
              {result.rows.map((row, i) => (
                <li key={`${row.index}-${i}`} className="m3-row m3-rxpop-row">
                  <span className="m3-rxpop-at">@{row.index}</span>
                  <mark className="m3-rxpop-hit">{row.text || EMPTY_MARK}</mark>
                  <span className="m3-rxpop-caps">{groupsLabel(row, groupNames)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="m3-rxpop-section">
          <h3 className="m3-rxpop-heading">{t("regex.groups")}</h3>
          {captureGroups.length === 0 ? (
            /*
              Only once there is a pattern worth the statement: an empty box says
              nothing about a pattern the user has not typed, and while the
              pattern is invalid the real problem is already on the error line.
            */
            <p className="m3-rxpop-empty">{pattern && !result.error ? t("regex.noGroups") : ""}</p>
          ) : (
            <ul className="m3-rxpop-list">
              {captureGroups.map(group => (
                <li key={group.name} className="m3-row m3-rxpop-row">
                  <span className="m3-rxpop-at">${group.index}</span>
                  <span className="m3-rxpop-name">{group.name}</span>
                  <span className="m3-rxpop-caps">{group.value ?? NO_VALUE_MARK}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="m3-rxpop-safety">
          {t("regex.safety", {
            pattern: String(PATTERN_CAP),
            sample: String(SAMPLE_CAP),
            matches: String(MATCH_CAP),
          })}
        </p>
      </div>

      <footer className="m3-rxpop-foot">
        {/*
          Says what applying will actually do, and says it differently when the
          host has no regex mode to switch — promising a mode change to a field
          that has none is the kind of small lie that makes the next promise
          untrustworthy.
        */}
        <p className="m3-rxpop-hint">
          {canSwitchMode && !hostRegexMode ? t("regexpop.applyHint") : t("regexpop.applyHintPlain")}
        </p>
        <Button onClick={() => onApply(pattern, flags)} disabled={!canApply}>
          {t("regexpop.apply")}
        </Button>
      </footer>
    </div>
  );
}

export interface SearchFieldProps extends Omit<RegexBuilderButtonProps, "onApply"> {
  /** The host's query state, written back on every keystroke. */
  onChange: (next: string) => void;
  /** Accessible name for the input; these rows rarely have a visible label. */
  searchLabel: string;
  placeholder?: string;
  id?: string;
  /** Defaults to putting the pattern in the field, which is what a search bar wants. */
  onApply?: (pattern: string, flags: string) => void;
}

/**
 * A search input with the builder trigger already attached.
 *
 * A convenience only. Most call sites own their own input markup — a chip row, a
 * count, a clear button — and adopt `RegexBuilderButton` alone; this exists so a
 * new surface does not have to reassemble the pair by hand and get the wrapper
 * row subtly wrong.
 */
export function SearchField({
  value, onChange, searchLabel, placeholder, id, onApply, regex, onRegexChange, flags, sample, label, className,
}: SearchFieldProps) {
  return (
    <div className="m3-row m3-rxpop-searchrow">
      <TextInput
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={searchLabel}
        onChange={event => onChange(event.target.value)}
        style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
      />
      <RegexBuilderButton
        value={value}
        onApply={onApply ?? (pattern => onChange(pattern))}
        regex={regex}
        onRegexChange={onRegexChange}
        flags={flags}
        sample={sample}
        label={label}
        className={className}
      />
    </div>
  );
}
