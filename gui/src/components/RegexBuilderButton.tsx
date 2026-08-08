import { useId, useMemo, useRef, useState } from "react";
import { IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { useCopyFeedback } from "./use-copy-feedback";
import { REGEX_GLOBAL_FLAG, type RegexSearchState } from "../regex-search";

const MAX_PATTERN_LENGTH = 512;
const MAX_SAMPLE_LENGTH = 4096;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function RegexBuilderButton({
  query,
  state,
  onStateChange,
}: {
  query: string;
  state: RegexSearchState;
  onStateChange: (next: RegexSearchState) => void;
}) {
  const t = useT();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const patternRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState("");
  const copyFeedback = useCopyFeedback<string>();
  const error = useMemo(() => {
    if (!state.pattern) return null;
    if (state.pattern.length > MAX_PATTERN_LENGTH) return t("api.regexTooLong");
    try {
      new RegExp(state.pattern, state.flags);
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : t("api.regexInvalid");
    }
  }, [state.flags, state.pattern, t]);
  const matches = useMemo(() => {
    if (!state.pattern || error || !sample) return [];
    const flags = state.flags.includes(REGEX_GLOBAL_FLAG) ? state.flags : `${state.flags}${REGEX_GLOBAL_FLAG}`;
    const regex = new RegExp(state.pattern, flags);
    const out: string[] = [];
    for (const match of sample.slice(0, MAX_SAMPLE_LENGTH).matchAll(regex)) {
      out.push(match[0] || t("api.regexZeroWidth"));
      if (out.length >= 20) break;
    }
    return out;
  }, [error, sample, state.flags, state.pattern, t]);
  const copyOutcome = copyFeedback.outcomeFor(state.pattern);

  const close = () => {
    setOpen(false);
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  };
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    window.setTimeout(() => patternRef.current?.focus(), 0);
  };

  return (
    <div className="regex-builder-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={`btn btn-sm btn-ghost regex-builder-trigger${state.enabled ? " regex-builder-trigger--active" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        <IconSearch aria-hidden="true" />
        {t("api.regexBuilder")}
      </button>
      {open && (
        <div
          id={id}
          className="regex-builder-popover"
          role="dialog"
          aria-label={t("api.regexBuilderTitle")}
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <div className="regex-builder-head">
            <strong>{t("api.regexBuilderTitle")}</strong>
            <button type="button" className="btn btn-sm btn-ghost" onClick={close}>{t("api.regexClose")}</button>
          </div>
          <label className="regex-builder-toggle">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={event => onStateChange({ ...state, enabled: event.target.checked })}
            />
            {t("api.regexEnable")}
          </label>
          <label>
            <span className="field-label">{t("api.regexPattern")}</span>
            <input
              ref={patternRef}
              className="input mono"
              value={state.pattern}
              maxLength={MAX_PATTERN_LENGTH}
              onChange={event => onStateChange({ ...state, pattern: event.target.value })}
              aria-invalid={!!error}
            />
          </label>
          <div className="regex-builder-guides" aria-label={t("api.regexGuided") }>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStateChange({ ...state, pattern: escapeRegex(query) })}>{t("api.regexLiteral")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStateChange({ ...state, pattern: `^${state.pattern}$` })}>{t("api.regexAnchors")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStateChange({ ...state, pattern: `(?:${state.pattern})` })}>{t("api.regexGroup")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStateChange({ ...state, pattern: `${state.pattern}|` })}>{t("api.regexAlternate")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStateChange({ ...state, pattern: `${state.pattern}+` })}>{t("api.regexQuantifier")}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStateChange({ ...state, pattern: `${state.pattern}[A-Za-z]` })}>{t("api.regexClass")}</button>
          </div>
          <fieldset className="regex-builder-flags">
            <legend>{t("api.regexFlags")}</legend>
            {["i", "m", "s", "u"].map(flag => (
              <label key={flag}>
                <input
                  type="checkbox"
                  checked={state.flags.includes(flag)}
                  onChange={event => {
                    const next = event.target.checked
                      ? `${state.flags}${flag}`
                      : state.flags.replaceAll(flag, "");
                    onStateChange({ ...state, flags: next });
                  }}
                />
                <code>{flag}</code>
              </label>
            ))}
          </fieldset>
          {error && <p className="regex-builder-error" role="alert">{error}</p>}
          <label>
            <span className="field-label">{t("api.regexSample")}</span>
            <textarea
              className="input regex-builder-sample"
              value={sample}
              maxLength={MAX_SAMPLE_LENGTH}
              onChange={event => setSample(event.target.value)}
            />
          </label>
          <p className="muted small" aria-live="polite">{t("api.regexMatches", { count: matches.length })}</p>
          {matches.length > 0 && <code className="regex-builder-results">{matches.join(" · ")}</code>}
          <button type="button" className="btn btn-sm btn-ghost" disabled={!state.pattern} onClick={() => copyFeedback.copy(state.pattern, state.pattern)}>
            {copyOutcome === "copied" ? t("api.copied") : copyOutcome === "unavailable" ? t("api.copyUnavailable") : t("api.regexCopy")}
          </button>
          <p className="muted small">{t("api.regexEngine")}</p>
        </div>
      )}
    </div>
  );
}
