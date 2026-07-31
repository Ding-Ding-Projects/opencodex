/**
 * The anchored regex builder that sits beside a search field.
 *
 * The rules put a full builder next to *every* search bar, anchored to that
 * field rather than parked on a separate page or in a global dialog. So this is
 * a popover positioned inside the trigger's own wrapper, bound to one host
 * field's query, pattern, flags, validation and mode — never a shared instance
 * that silently applies to whichever field was touched last.
 *
 * The evaluation is `shared/m3/regex.ts`, which re-exports the dashboard's
 * engine. That matters more here than sharing a colour would: the caps are a
 * *safety* property. A 400-character pattern ceiling, a 20,000-character sample
 * ceiling, a 200-match ceiling and the forced advance past a zero-width match
 * are what stop a pattern someone is still typing from locking the main thread.
 * A second evaluator is a second place those four numbers can drift apart, and
 * the surface that loses one hangs the page.
 *
 * Bidirectional synchronisation is the whole contract: `pattern` and `query` are
 * the same string. Typing in the field updates the builder's pattern; building
 * in the popover updates the field. Plain text stays the default and regex is an
 * explicit opt-in, so a `.` a reader types into a search box is a full stop
 * until they say otherwise.
 *
 * Deliberately NOT here: any network call, and any state that outlives the host
 * field. Patterns and sample text are evaluated in this page and stored nowhere.
 *
 * This is the appearance surface's builder. If the tab-search stage lands its
 * own general-purpose one, this file should become an import of it rather than a
 * second implementation — the engine is already shared, so what would be
 * duplicated is only the markup, and one anchored builder for the whole site is
 * still the right end state.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_MARK,
  FLAGS,
  NO_VALUE_MARK,
  PATTERN_CAP,
  TOKEN_GROUPS,
  capPattern,
  capSample,
  describeGroups,
  evaluate,
} from "../../../../shared/m3/regex";
import { computePlacement } from "../../../../shared/m3/anchor";
import type { TFn } from "../../lib/strings";
import { Button, Chip, Field } from "../ui";

const RegexIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 5v14M5 5h3M5 19h3" />
    <path d="M19 5v14M19 5h-3M19 19h-3" />
    <path d="M12 9v6M9.5 10.5l5 3M14.5 10.5l-5 3" />
  </svg>
);

export interface RegexBuilderProps {
  /** The host field's current text. Pattern and query are one value, not two. */
  query: string;
  onQuery: (value: string) => void;
  regex: boolean;
  onRegex: (value: boolean) => void;
  flags: string;
  onFlags: (value: string) => void;
  /** Text the builder previews against — normally the very list being searched. */
  sample: string;
  t: TFn;
  /** Focused when the popover closes, per the anchored-surface rules. */
  returnFocusTo?: () => HTMLElement | null | undefined;
}

export function RegexBuilderButton({
  query, onQuery, regex, onRegex, flags, onFlags, sample, t, returnFocusTo,
}: RegexBuilderProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [localSample, setLocalSample] = useState(sample);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const patternRef = useRef<HTMLInputElement>(null);
  const id = useId();

  // The host's list changes as the user filters; the preview follows it until
  // they type their own sample, at which point theirs wins.
  const [sampleTouched, setSampleTouched] = useState(false);
  useEffect(() => { if (!sampleTouched) setLocalSample(sample); }, [sample, sampleTouched]);

  const result = useMemo(
    () => evaluate(regex ? capPattern(query) : "", flags, capSample(localSample)),
    [query, regex, flags, localSample],
  );
  const groups = useMemo(() => describeGroups(query, result), [query, result]);

  /** Viewport coordinates; the panel is `position: fixed` so it is not clipped
   *  by the scroll container it opens inside. See `ColorPicker` for the whole
   *  reasoning — this is the same arrangement. */
  const place = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    const computed = computePlacement(
      anchor,
      { width: panel.width, height: panel.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement({
      left: anchor.left + computed.left,
      top: computed.side === "above" ? Math.max(8, anchor.top - panel.height - 8) : anchor.bottom + 8,
      maxHeight: computed.maxHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    place();
    patternRef.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const close = useCallback(() => {
    setOpen(false);
    (returnFocusTo?.() ?? triggerRef.current)?.focus();
  }, [returnFocusTo]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // One Escape closes one layer. Without stopping it here the same keypress
      // also reaches the editor this is nested in and closes both.
      event.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  /**
   * Insert a construct at the caret rather than appending it.
   *
   * Appending is what makes a guided palette useless the moment a pattern is
   * more than one token long: the user positions the caret where the piece
   * belongs and the button drops it at the end anyway. The caret is left INSIDE
   * a construct that has a body — `()`, `(?:)`, `(?<name>)` — because that is
   * where the next thing they type has to go.
   */
  const insert = (token: string) => {
    const input = patternRef.current;
    const at = input?.selectionStart ?? query.length;
    const end = input?.selectionEnd ?? at;
    const next = capPattern(query.slice(0, at) + token + query.slice(end));
    if (!regex) onRegex(true);
    onQuery(next);
    const inside = token.endsWith(")") ? token.length - 1 : token.length;
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(at + inside, at + inside);
    });
  };

  const toggleFlag = (flag: string) => {
    onFlags(flags.includes(flag) ? flags.replace(flag, "") : flags + flag);
  };

  return (
    <div className="ap-rx" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`ap-iconbtn${regex ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("rx.open")}
        aria-label={t("rx.open")}
        onClick={() => setOpen(o => !o)}
      >
        {RegexIcon}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="ap-popover ap-rx__panel"
          role="dialog"
          aria-label={t("rx.title")}
          data-placed={placement ? "yes" : "no"}
          style={placement ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight } : undefined}
        >
          <div className="ap-rx__modes" role="group" aria-label={t("rx.mode")}>
            <Chip selected={!regex} onClick={() => onRegex(false)}>{t("rx.plain")}</Chip>
            <Chip selected={regex} onClick={() => onRegex(true)}>{t("rx.regex")}</Chip>
          </div>

          <Field
            id={`${id}-pattern`}
            label={t("rx.pattern")}
            hint={result.error ? t("rx.invalid", { error: result.error }) : `${query.length}/${PATTERN_CAP}`}
          >
            {/* A bare input, not the `TextInput` primitive: this one needs a
                ref for caret-aware insertion, and reaching through a wrapper for
                that is one indirection that buys nothing. */}
            <input
              ref={patternRef}
              id={`${id}-pattern`}
              className="m3-input m3-input--mono"
              value={query}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!result.error}
              onChange={event => onQuery(capPattern(event.target.value))}
            />
          </Field>

          <div className="ap-rx__flags" role="group" aria-label={t("rx.flags")}>
            {FLAGS.map(({ flag, tkey }) => (
              <Chip
                key={flag}
                selected={flags.includes(flag)}
                title={t(tkey)}
                aria-label={`${flag} — ${t(tkey)}`}
                onClick={() => toggleFlag(flag)}
                disabled={!regex}
              >
                {flag}
              </Chip>
            ))}
          </div>

          {TOKEN_GROUPS.map(group => (
            <div key={group.tkey} className="ap-rx__tokens" role="group" aria-label={t(group.tkey)}>
              <span className="ap-rx__tokenhead">{t(group.tkey)}</span>
              {group.items.map(item => (
                <button
                  key={item.insert}
                  type="button"
                  className="ap-rx__token"
                  title={t(item.tkey)}
                  aria-label={t("rx.insert", { token: item.insert })}
                  onClick={() => insert(item.insert)}
                >
                  <code>{item.insert}</code>
                </button>
              ))}
            </div>
          ))}

          <Field id={`${id}-sample`} label={t("rx.sample")}>
            <textarea
              id={`${id}-sample`}
              className="m3-input ap-rx__sample"
              rows={3}
              spellCheck={false}
              value={localSample}
              onChange={event => { setSampleTouched(true); setLocalSample(capSample(event.target.value)); }}
            />
          </Field>

          <p className="ap-rx__count" role="status">
            {result.error ? t("rx.invalid", { error: result.error })
              : result.rows.length === 0 ? t("rx.noMatches")
              : t("rx.matches", { count: result.rows.length })}
            {result.truncated ? ` ${t("rx.truncated")}` : ""}
          </p>

          {groups.length > 0 && (
            <div className="ap-rx__groups">
              <span className="ap-rx__tokenhead">{t("rx.groups")}</span>
              <ul>
                {groups.map(group => (
                  <li key={group.name}>
                    <code>${group.index}</code> {group.name}
                    {" — "}
                    <code>{group.value ?? NO_VALUE_MARK}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.rows.length > 0 && (
            <ul className="ap-rx__matches">
              {result.rows.slice(0, 12).map((row, i) => (
                <li key={`${row.index}-${i}`}><code>{row.text || EMPTY_MARK}</code> <span>@{row.index}</span></li>
              ))}
            </ul>
          )}

          <p className="m3-field-hint">{t("rx.engine")}</p>
          <div className="ap-rx__actions">
            <Button variant="text" onClick={close}>{t("rx.close")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
