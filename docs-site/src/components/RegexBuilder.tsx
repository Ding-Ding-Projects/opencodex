/**
 * The regex builder, anchored to the search bar that opens it.
 *
 * The rule this implements is specific about the shape: the builder belongs to
 * the field the reader is already typing in, as an adjacent affordance opening a
 * popover that stays visually attached to *that* field. Not a separate page, not
 * a global dialog, and not one shared builder that applies to whichever field was
 * touched last. Every search bar on this site mounts its own `SearchBar`, and
 * every `SearchBar` mounts its own builder bound to its own query, flags and
 * mode.
 *
 * Anchored, not modal. `showModal()` is deliberately not used: the reader opened
 * this to build a pattern for the field behind it, and inerting that field would
 * be exactly wrong. What it keeps from the dialog contract is the part that is
 * not about blocking — Escape closes and returns focus to the trigger, an outside
 * click closes, and focus moves into the panel on open.
 *
 * Positioned `fixed` in viewport coordinates rather than absolutely inside the
 * trigger's wrapper, and that is not a preference. Two of the places this opens
 * from are inside `overflow: auto` containers — the tab strip scrolls
 * horizontally below 50em, and the tab-search panel's own body scrolls
 * vertically — and an absolutely positioned descendant of a scroll container is
 * clipped by it. The builder would have been cut off at the container's edge,
 * which on a phone means cut off almost entirely. `fixed` escapes the clip; the
 * cost is that it has to be repositioned on scroll and resize, which this already
 * does to stay attached.
 *
 * The evaluation is not implemented here. It comes from `shared/m3/regex.ts`,
 * which is the dashboard's engine re-exported, so the two surfaces cannot
 * disagree about what a pattern matches, which index a named group has, or where
 * the safety caps sit.
 *
 * On a phone: the panel is `min(480px, 100vw - 24px)` wide and
 * `computePlacement` clamps it into the viewport and flips it above the trigger
 * when there is more room there, so a builder opened from a field near the bottom
 * of a 430x932 screen reposition rather than overflows. It stays non-modal at
 * every width — this is a docs site, and covering the page the reader is
 * searching would defeat the search.
 *
 * What it deliberately does NOT do: persist anything, run the host's search, or
 * transmit a pattern. Applying calls `onApply` and closes; the host owns its own
 * query, its own mode and its own storage. Nothing typed here leaves the browser.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { INITIAL_PLACEMENT, computePlacement, fixedPanelStyle, type Placement } from "../../../shared/m3/anchor";
import {
  EMPTY_MARK, FLAGS, MATCH_CAP, NO_VALUE_MARK, PATTERN_CAP, SAMPLE_CAP, TOKEN_GROUPS,
  capPattern, capSample, describeGroups, evaluate, groupNameMap, groupsLabel,
} from "../../../shared/m3/regex";
import { TAB_MATCH_FLAGS } from "../../../shared/m3/tabs";
import type { TFn } from "../lib/strings";
import type { SearchQueryState } from "../lib/use-search-query";
import { Button, Chip, Field, Icon, IconButton, TextArea, TextInput } from "./ui";

const MONO = { fontFamily: "var(--mono)" } as const;

export interface RegexBuilderButtonProps {
  t: TFn;
  /** The host field's current text. Seeds the pattern when the panel opens. */
  value: string;
  /** The host's flags. Defaults to the `i` every search bar on this site compiles. */
  flags?: string;
  /** Whether the host is already in regex mode, so the apply hint can tell the truth. */
  regex?: boolean;
  /** Real text from the host surface, so the pattern is tried against actual data. */
  sample?: string;
  /** Committed pattern and flags. The host writes them into its own state. */
  onApply: (pattern: string, flags: string) => void;
  /** Overrides the trigger's accessible name where "Open the regex builder" is ambiguous. */
  label?: string;
}

export function RegexBuilderButton({ t, value, flags, regex, sample, onApply, label }: RegexBuilderButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const triggerLabel = label ?? t("regex.open");

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
    /**
     * Escape closes the innermost open surface, and only that one.
     *
     * On the document rather than on the panel, because the panel does not trap
     * focus: by the time Escape is pressed the focused element may legitimately
     * be outside it, and a handler on the panel would never see the key.
     *
     * In the CAPTURE phase, and that is the part that took a browser to find.
     * Every surface this builder opens inside — the appearance panel, the tab
     * search panel, the site search panel — already has its own document-level
     * Escape handler, registered when it opened, which is *earlier* than this
     * one. Listeners on the same node fire in registration order, so a
     * bubble-phase handler here runs last: pressing Escape in the builder closed
     * the builder AND the panel behind it, and focus landed on whatever that
     * panel restores to. Capture on `document` runs before every bubble listener
     * on `document`, so this sees the key first and
     * `stopImmediatePropagation` keeps the outer surfaces from seeing it at all.
     */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      closeAndRestore();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, closeAndRestore]);

  return (
    <div className="m3-rxpop-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="m3-icon-btn"
        // `dialog`, not `menu`: what opens is a form, and a screen reader that
        // announces "menu" primes the reader for arrow-key navigation this has
        // none of.
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={triggerLabel}
        aria-label={triggerLabel}
        onClick={() => setOpen(prev => !prev)}
      >
        {Icon.regex}
      </button>

      {/*
        Mounted only while open, which is what makes the seed a `useState`
        initializer rather than an effect that has to notice `value` changing
        after the fact. Re-opening always re-seeds from the field as it is now.
        It also means the evaluator, the palette and 30-odd nodes cost nothing
        at all until somebody asks for them — which on a phone is the difference
        between a search bar and a search bar plus a builder nobody opened.
      */}
      {open && (
        <RegexPopover
          id={panelId}
          t={t}
          anchorRef={wrapRef}
          seedPattern={value}
          seedFlags={flags ?? TAB_MATCH_FLAGS}
          seedSample={sample ?? ""}
          hostRegexMode={regex}
          onDismiss={closeAndRestore}
          onApply={(pattern, appliedFlags) => {
            onApply(pattern, appliedFlags);
            closeAndRestore();
          }}
        />
      )}
    </div>
  );
}

function RegexPopover({
  id, t, anchorRef, seedPattern, seedFlags, seedSample, hostRegexMode, onApply, onDismiss,
}: {
  id: string;
  t: TFn;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  seedPattern: string;
  seedFlags: string;
  seedSample: string;
  hostRegexMode?: boolean;
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
  // reader opened this for, and focusing the container would make the first
  // thing a keyboard user does be tabbing past the heading to reach it.
  useEffect(() => {
    document.getElementById(patternId)?.focus();
  }, [patternId]);

  // Measured after paint, then remeasured whenever the page moves under it, so
  // the panel stays attached to a trigger that scrolled or a window that resized
  // — including the address-bar collapse that changes `innerHeight` mid-scroll
  // on a phone.
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(computePlacement(anchor, panel, { width: window.innerWidth, height: window.innerHeight }));
    };
    reposition();
    window.addEventListener("resize", reposition);
    // Capturing, because the scroll that moves this panel is usually a scrolling
    // ancestor rather than the window, and those do not bubble.
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  const toggleFlag = (flag: string) =>
    setFlags(prev => (prev.includes(flag) ? prev.replace(flag, "") : prev + flag));

  const canApply = !!pattern && !result.error;

  return (
    <div
      id={id}
      ref={panelRef}
      role="dialog"
      // No `aria-modal`: this inerts nothing behind it, and claiming otherwise
      // tells a screen reader the rest of the page is unavailable.
      aria-labelledby={titleId}
      className={`m3-rxpop m3-rxpop--${placement.side}`}
      style={fixedPanelStyle(placement)}
    >
      <header className="m3-rxpop-head">
        <h2 className="m3-rxpop-title" id={titleId}>{t("regex.title")}</h2>
        <IconButton className="m3-rxpop-close" title={t("regex.close")} aria-label={t("regex.close")} onClick={onDismiss}>
          {Icon.close}
        </IconButton>
      </header>

      <div className="m3-rxpop-body">
        <p className="m3-rxpop-engine">{t("regex.engineNote")}</p>

        <Field
          id={patternId}
          label={t("regex.pattern")}
          hint={t("regex.patternCap", { used: pattern.length, cap: PATTERN_CAP })}
        >
          {/* The `/…/flags` delimiters make the literal being built readable at a glance. */}
          <div className="m3-row m3-rxpop-patternrow">
            <span aria-hidden="true" className="m3-rxpop-slash">/</span>
            <TextInput
              id={patternId}
              value={pattern}
              spellCheck={false}
              autoComplete="off"
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
          <div className="m3-row m3-rxpop-chiprow" role="group" aria-label={t("regex.flags")}>
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
              <div className="m3-row m3-rxpop-chiprow" role="group" aria-label={t(group.tkey)}>
                {/* The description stays visible rather than moving into a `title`:
                    a tooltip is unreachable by keyboard and never read aloud, so
                    the construct would be a bare symbol for exactly the readers
                    who need it explained most. */}
                {group.items.map(tok => (
                  <Chip key={tok.insert} onClick={() => setPattern(prev => capPattern(prev + tok.insert))}>
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
          hint={`${t("regex.sampleCap", { used: sample.length, cap: SAMPLE_CAP })}${seedSample ? ` · ${t("regex.sampleSeeded")}` : ""}`}
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
              ? t("regex.matchTruncated", { cap: MATCH_CAP })
              : t("regex.matchCountValue", { count: result.rows.length })}
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
            /* Only once there is a pattern worth the statement: an empty box says
               nothing about a pattern nobody has typed, and while the pattern is
               invalid the error line is already saying the only useful thing. */
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
          {t("regex.safety", { pattern: PATTERN_CAP, sample: SAMPLE_CAP, matches: MATCH_CAP })}
        </p>
      </div>

      <footer className="m3-rxpop-foot">
        {/* Says what applying will actually do, and says it differently when the
            host is already in regex mode — promising a mode change that is not
            going to happen is the kind of small lie that makes the next promise
            untrustworthy. */}
        <p className="m3-rxpop-hint">{hostRegexMode ? t("regex.applyHintPlain") : t("regex.applyHint")}</p>
        <Button onClick={() => onApply(pattern, flags)} disabled={!canApply}>{t("regex.apply")}</Button>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- search bar -- */

export interface SearchBarProps {
  t: TFn;
  /** This field's own query state. One per field — never shared. */
  state: SearchQueryState;
  /** Accessible name; these rows rarely have a visible label. */
  searchLabel: string;
  placeholder?: string;
  id?: string;
  /** Real text from this surface, so the builder tests against what the field sees. */
  sample?: string;
  /** `aria-controls` target, when the results live in a region with an id. */
  controls?: string;
  /** Rendered between the field and the trigger — a result count, a scope chip. */
  children?: React.ReactNode;
}

/**
 * A search input with its mode switch and its own builder attached.
 *
 * The order in the row is the order of the decision: type, then choose how it is
 * matched, then reach for the builder if the pattern is worth building. The mode
 * switch is a visible chip rather than a hidden preference because "is this
 * regex?" changes what every keystroke means, and a mode you cannot see is a
 * mode you cannot trust.
 *
 * Validation is inline and immediate: an unfinished pattern like `(foo` reports
 * the engine's own message under the field the moment it is typed, rather than
 * silently returning no results and letting the reader conclude the site has
 * nothing about foo.
 */
export function SearchBar({ t, state, searchLabel, placeholder, id, sample, controls, children }: SearchBarProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;

  return (
    <div className="m3-searchbar">
      <div className="m3-row m3-searchbar-row">
        <div className="m3-searchbar-field">
          <span className="m3-searchbar-icon" aria-hidden="true">{Icon.search}</span>
          <TextInput
            id={fieldId}
            type="search"
            value={state.query}
            placeholder={placeholder}
            aria-label={searchLabel}
            aria-invalid={!!state.error}
            aria-describedby={state.error ? errorId : undefined}
            aria-controls={controls}
            spellCheck={false}
            autoComplete="off"
            onChange={event => state.setQuery(event.target.value)}
          />
          {state.query ? (
            <button
              type="button"
              className="m3-searchbar-clear"
              title={t("search.clear")}
              aria-label={t("search.clear")}
              onClick={state.clear}
            >
              {Icon.close}
            </button>
          ) : null}
        </div>
        <Chip
          selected={state.regex}
          onClick={() => state.setRegex(!state.regex)}
          title={state.regex ? t("search.regexMode") : t("search.plainMode")}
        >
          <code style={MONO}>.*</code>
          <span className="m3-searchbar-modelabel">{state.regex ? t("search.regexMode") : t("search.plainMode")}</span>
        </Chip>
        <RegexBuilderButton
          t={t}
          value={state.query}
          flags={state.flags}
          regex={state.regex}
          sample={sample}
          onApply={state.apply}
        />
        {children}
      </div>
      {state.error ? (
        <p id={errorId} role="alert" className="m3-searchbar-error">
          {t("tabs.invalidQuery", { error: state.error })}
        </p>
      ) : null}
    </div>
  );
}
