/**
 * The changelog viewer: every released version, filtered by date and text.
 *
 * ## Where the data comes from
 *
 * `lib/changelog-data.ts`, which is the only module that knows the history is a
 * `?raw` import of the repository's `CHANGELOG.md`. Keeping that specifier out
 * of this file is what lets a test mount the viewer against a fixture: `?raw`
 * resolves inside Astro's pipeline and nowhere else, so any module naming it can
 * only be loaded by a bundler.
 *
 * The data arrives in this island's own chunk, so the ~160 kB of release history
 * is downloaded by the one page whose entire purpose is that history and by no
 * other page on the site. The alternative — passing it as island props — would
 * inline the same bytes into the HTML of this page in every one of the five
 * locales, which is the same data five times over in the one place it is least
 * compressible.
 *
 * ## Two filters that compose
 *
 * The date range and the search are ANDed, and the empty state says so: a reader
 * who has a date range set from ten minutes ago and then types a word gets
 * "nothing matches both", not "nothing matches", because the second sends them
 * hunting for a release that is right there behind a filter they forgot about.
 *
 * The search is `SearchBar`, so it is the site's one search component with its
 * own anchored regex builder — plain text by default, regex an explicit opt-in,
 * pattern and flags and mode synchronised in one commit when the builder
 * applies. The sample the builder previews against is seeded from the release
 * entries actually on screen, so a pattern that matches in the popover matches
 * here.
 *
 * ## The export is the screen
 *
 * `toMarkdown` is handed the exact rows that were rendered rather than a second
 * query built from the same filter state. That is what makes "the export honours
 * the filter" a structural property instead of a promise: there is no second
 * query that could disagree.
 *
 * ## What this deliberately does not do
 *
 * It does not fetch, and it does not paginate. Ninety-eight releases render in
 * one pass; virtualising them would break in-page find, which is the one thing a
 * reader looking for a specific fix reaches for first.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EDGE_PAD_PX as EDGE_PAD, GAP_PX as GAP, computePlacement, type Placement } from "../../../shared/m3/anchor";
import { SAMPLE_CAP } from "../../../shared/m3/regex";
import {
  OPEN_RANGE,
  countEntries,
  filterReleases,
  groupByKind,
  isIsoDate,
  iso,
  lastDays,
  monthGrid,
  thisYear,
  toMarkdown,
  type ChangeKind,
  type DateRange,
} from "../lib/changelog";
import { RELEASES } from "../lib/changelog-data";
import { notify } from "../lib/notifications";
import { useUi } from "../lib/i18n/use-ui";
import { uiTranslator } from "../lib/i18n";
import type { UiKey } from "../lib/i18n/keys";
import { SearchBar } from "./RegexBuilder";
import { useSearchQuery } from "../lib/use-search-query";
import { Button, Chip, Icon } from "./ui";
import { EXPORT_FORMATS, FORMAT_META, filenameFor, serialize, type ExportFormat } from "../../../shared/export-formats";

const KIND_KEY: Record<ChangeKind, UiKey> = {
  feat: "changelog.kindFeat",
  fix: "changelog.kindFix",
  perf: "changelog.kindPerf",
  docs: "changelog.kindDocs",
  test: "changelog.kindTest",
  refactor: "changelog.kindRefactor",
  ci: "changelog.kindCi",
  chore: "changelog.kindChore",
  other: "changelog.kindOther",
};

const CalendarIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

/* ------------------------------------------------------------- date field -- */

interface DateFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Already-translated error, or null. */
  error: string | null;
  t: (key: UiKey, vars?: Record<string, string | number>) => string;
  /** The locale to format the month heading in. */
  htmlLang: string;
}

/**
 * A typed ISO date plus an anchored calendar.
 *
 * The text input is the source of truth and it is **never** rewritten while the
 * reader is typing. `2026-0` is not a date, and a field that erased it or
 * "corrected" it to something else would make the box unusable — so an
 * unparseable value stays exactly as typed, reports itself inline, and simply
 * does not narrow the filter until it becomes a real date. That is the rule
 * about not discarding what the user typed, implemented rather than promised.
 *
 * `type="text"` and not `type="date"`: the native control renders in the
 * platform's locale format, which means the hint saying "YYYY-MM-DD" would be
 * describing something the reader cannot see, and on a phone it opens a picker
 * that makes typing impossible. The calendar beside it is the picker, and it is
 * the same one on every platform.
 */
function DateField({ label, value, onChange, error, t, htmlLang }: DateFieldProps) {
  const fieldId = useId();
  const errorId = `${fieldId}-err`;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** `Placement`, plus the wrapper-relative `top` this component derives. */
  const [placement, setPlacement] = useState<(Placement & { top: number }) | null>(null);

  const today = useMemo(() => new Date(), []);
  const anchorDate = isIsoDate(value) ? new Date(`${value}T00:00:00Z`) : today;
  const [year, setYear] = useState(anchorDate.getUTCFullYear());
  const [month, setMonth] = useState(anchorDate.getUTCMonth());

  /*
    Measure, place, then translate the placement into this wrapper's coordinates.

    `computePlacement` returns `left` relative to the **anchor**, on the
    assumption that the panel is positioned inside a wrapper drawn tightly around
    the trigger. This wrapper is not: it is the whole field — label, input and
    button — so its left edge sits about 320px to the left of the button's at a
    phone width. Applying the anchor-relative offset to it put the calendar at
    x = -226 on a 430px screen, measured in a real browser. Adding the delta is
    the whole fix, and it is arithmetic rather than a second placement rule.

    `maxHeight` is applied as well, and the grid scrolls inside it. Under
    `pointer: coarse` the day cells are 44px, which makes the panel tall enough
    to be flipped above a field that has no room above it either — and a panel
    that has been flipped into a space too small for it has to scroll, or it
    hangs off the top of the page.
  */
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const anchor = triggerRef.current?.getBoundingClientRect();
    const wrapper = wrapRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !wrapper || !panel) return;
    const placed = computePlacement(anchor, { width: panel.width, height: panel.height }, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    // Both axes are translated for the same reason. CSS could express "below the
    // wrapper" or "above the wrapper", but the placement was computed against the
    // *button* — 27px lower than the wrapper's top and 320px to the right of its
    // left — so letting CSS do it put the flipped-above calendar 38px off the top
    // of the screen even with the height cap applied.
    const capped = Math.min(panel.height, placed.maxHeight);
    const top = placed.side === "above"
      ? anchor.top - GAP - capped - wrapper.top
      : anchor.bottom + GAP - wrapper.top;
    setPlacement({
      ...placed,
      left: placed.left + (anchor.left - wrapper.left),
      // Never above the viewport's own padding, whatever the arithmetic said.
      top: Math.max(EDGE_PAD - wrapper.top, top),
    });
  }, [open, year, month]);

  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const monthName = useMemo(
    () => new Intl.DateTimeFormat(htmlLang, { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, month, 1))),
    [htmlLang, year, month],
  );
  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(htmlLang, { weekday: "narrow", timeZone: "UTC" });
    // 2024-01-01 was a Monday, which is the column order `monthGrid` produces.
    return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 1 + i))));
  }, [htmlLang]);

  const step = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth());
  };

  return (
    <div className="ocx-datefield" ref={wrapRef}>
      <label className="m3-field-label" htmlFor={fieldId}>{label}</label>
      <div className="ocx-datefield-row">
        <input
          id={fieldId}
          className="m3-input ocx-datefield-input"
          type="text"
          inputMode="numeric"
          value={value}
          placeholder="YYYY-MM-DD"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          onChange={event => onChange(event.target.value)}
        />
        <button
          type="button"
          ref={triggerRef}
          className="m3-icon-btn"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t("changelog.openCalendar")}
          title={t("changelog.openCalendar")}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {CalendarIcon}
        </button>
      </div>
      {error ? <p className="m3-field-hint ocx-error" id={errorId}>{error}</p> : null}

      {open && (
        <div
          ref={panelRef}
          className="ocx-calendar"
          role="dialog"
          aria-label={label}
          style={{
            left: placement ? `${placement.left}px` : undefined,
            top: placement ? `${placement.top}px` : undefined,
            maxHeight: placement ? `${placement.maxHeight}px` : undefined,
            // Hidden until measured, so it is never painted in the wrong place
            // and then jumped into the right one.
            visibility: placement ? "visible" : "hidden",
          }}
        >
          <div className="ocx-calendar-head">
            <button type="button" className="m3-icon-btn" aria-label={t("changelog.prevMonth")} onClick={() => step(-1)}>
              <span className="ocx-chev-left" aria-hidden="true">{Icon.chevron}</span>
            </button>
            <div className="ocx-calendar-jump">
              <label className="m3-sr-only" htmlFor={`${fieldId}-m`}>{t("changelog.month")}</label>
              <select
                id={`${fieldId}-m`}
                className="m3-input"
                value={month}
                onChange={event => setMonth(Number(event.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i} value={i}>
                    {new Intl.DateTimeFormat(htmlLang, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, i, 1)))}
                  </option>
                ))}
              </select>
              <label className="m3-sr-only" htmlFor={`${fieldId}-y`}>{t("changelog.year")}</label>
              <input
                id={`${fieldId}-y`}
                className="m3-input ocx-calendar-year"
                type="number"
                value={year}
                min={2000}
                max={2999}
                onChange={event => setYear(Number(event.target.value))}
              />
            </div>
            <button type="button" className="m3-icon-btn" aria-label={t("changelog.nextMonth")} onClick={() => step(1)}>
              {Icon.chevron}
            </button>
          </div>

          <p className="ocx-calendar-month" aria-live="polite">{monthName}</p>

          <div className="ocx-calendar-grid" role="grid" aria-label={monthName}>
            {weekdays.map((day, i) => (
              <span key={`w${i}`} className="ocx-calendar-weekday" aria-hidden="true">{day}</span>
            ))}
            {grid.map(day => (
              <button
                key={day.iso}
                type="button"
                className={`ocx-calendar-day${day.outside ? " outside" : ""}${day.iso === value ? " selected" : ""}`}
                aria-pressed={day.iso === value}
                aria-label={day.iso}
                onClick={() => { onChange(day.iso); close(); }}
              >
                {day.day}
              </button>
            ))}
          </div>

          <div className="ocx-calendar-foot">
            <Button variant="text" onClick={() => { onChange(iso(new Date())); close(); }}>
              {t("changelog.today")}
            </Button>
            <Button variant="text" onClick={() => { onChange(""); close(); }}>
              {t("changelog.clearFilters")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- viewer -- */

export default function Changelog() {
  const ui = useUi();
  const t = ui.t;
  const tf = useMemo(() => uiTranslator(), [ui.resolved, ui.funny.en, ui.funny.yue]);
  const htmlLang = ui.resolved === "yue" ? "zh-HK" : ui.resolved === "bi" ? "en" : ui.resolved === "zh-cn" ? "zh-CN" : ui.resolved;

  const [range, setRange] = useState<DateRange>(OPEN_RANGE);
  const search = useSearchQuery();

  /* A typed value that is not yet a date narrows nothing and is reported inline,
     rather than being coerced into a bound the reader never asked for. */
  const effective: DateRange = {
    from: isIsoDate(range.from) ? range.from : "",
    to: isIsoDate(range.to) ? range.to : "",
  };
  const fromError = range.from && !isIsoDate(range.from) ? t("changelog.invalidDate", { value: range.from }) : null;
  const toError = range.to && !isIsoDate(range.to) ? t("changelog.invalidDate", { value: range.to }) : null;

  const rows = useMemo(
    () => filterReleases(RELEASES, effective, search.matcher.ok ? search.matcher.test : null),
    [effective.from, effective.to, search.matcher],
  );
  const entryCount = useMemo(() => countEntries(rows), [rows]);

  /* Seed the builder from what this surface can actually see, capped where the
     engine caps it, so a pattern previewed in the popover behaves identically
     when it is applied here. */
  const sample = useMemo(
    () => rows.slice(0, 6).flatMap(row => row.entries.map(entry => entry.text)).join("\n").slice(0, SAMPLE_CAP),
    [rows],
  );

  const rangeText = effective.from && effective.to ? t("changelog.rangeBoth", { from: effective.from, to: effective.to })
    : effective.from ? t("changelog.rangeFrom", { from: effective.from })
    : effective.to ? t("changelog.rangeTo", { to: effective.to })
    : t("changelog.rangeAll");

  const buildExport = useCallback(() => toMarkdown(rows, {
    title: t("changelog.title"),
    range: rangeText,
    search: search.query || t("changelog.searchNone"),
    note: t("changelog.exportNote", { range: rangeText, search: search.query || t("changelog.searchNone") }),
    undated: t("changelog.undated"),
  }), [rows, rangeText, search.query, t]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildExport());
      notify({ tone: "success", title: t("changelog.copied") });
    } catch {
      notify({ tone: "error", title: t("changelog.copyFailed") });
    }
  }, [buildExport, t]);

  /**
   * Export the filtered rows in any of the coding formats, not only Markdown.
   *
   * Same serialisers the app and the CLI use, from `shared/export-formats` —
   * "what a CSV of this looks like" must have one answer, and a second
   * implementation here would drift from it the first time either changed.
   *
   * Markdown keeps its own path deliberately: `toMarkdown` writes a *document*
   * with the active range and search stated in it, which is what someone
   * exporting a changelog to read actually wants. The generic writers produce a
   * table of the same rows, which is what someone exporting it to process wants.
   * Both are correct; they are answering different questions.
   */
  const onExportAs = useCallback((format: ExportFormat) => {
    const body = format === "markdown"
      ? buildExport()
      : serialize({ name: "changelog", rows: rows as unknown as Array<Record<string, unknown>> }, format);
    const blob = new Blob([body], { type: `${FORMAT_META[format].mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameFor("opencodex-changelog", format);
    link.click();
    // Revoked on the next task rather than immediately: Safari has not started
    // reading the blob when `click()` returns, and revoking synchronously
    // downloads a zero-byte file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    notify({ tone: "success", title: t("changelog.exported", { count: rows.length }) });
  }, [buildExport, notify, rows, t]);

  /** The Markdown button keeps working exactly as it did. */
  const onExport = useCallback(() => onExportAs("markdown"), [onExportAs]);

  const applyPreset = (next: DateRange) => setRange(next);

  const resultsId = "ocx-changelog-results";

  return (
    <div className="ocx-changelog">
      <p className="ocx-changelog-lead">{t("changelog.lead")}</p>

      <div className="ocx-changelog-filters">
        <SearchBar
          t={tf}
          state={search}
          searchLabel={t("changelog.search")}
          placeholder={t("changelog.searchPh")}
          sample={sample}
          controls={resultsId}
        />

        <div className="ocx-changelog-dates">
          <DateField
            label={t("changelog.from")}
            value={range.from}
            onChange={from => setRange(current => ({ ...current, from }))}
            error={fromError}
            t={t}
            htmlLang={htmlLang}
          />
          <DateField
            label={t("changelog.to")}
            value={range.to}
            onChange={to => setRange(current => ({ ...current, to }))}
            error={toError}
            t={t}
            htmlLang={htmlLang}
          />
        </div>
        <p className="m3-field-hint">{t("changelog.dateHint")}</p>

        <div className="m3-row ocx-changelog-presets">
          <Chip onClick={() => applyPreset(lastDays(7))}>{t("changelog.preset7")}</Chip>
          <Chip onClick={() => applyPreset(lastDays(30))}>{t("changelog.preset30")}</Chip>
          <Chip onClick={() => applyPreset(lastDays(90))}>{t("changelog.preset90")}</Chip>
          <Chip onClick={() => applyPreset(thisYear())}>{t("changelog.presetYear")}</Chip>
          <Chip onClick={() => applyPreset(OPEN_RANGE)}>{t("changelog.presetAll")}</Chip>
        </div>

        <div className="m3-row ocx-changelog-actions">
          <p className="ocx-changelog-count" role="status">
            {t("changelog.shown", { shown: rows.length, total: RELEASES.length, entries: entryCount })}
          </p>
          <span className="ocx-spacer" />
          <Button variant="outlined" onClick={onCopy}>{t("changelog.copy")}</Button>
          <Button variant="tonal" onClick={onExport}>{t("changelog.export")}</Button>
          {/* Every format, not only the one that happened to be implemented
              first. The select carries the same list the app and the CLI offer,
              so a reader who wants this as CSV for a spreadsheet is not told to
              go and convert a Markdown table by hand. */}
          <label className="ocx-export-as">
            <span className="ocx-visually-hidden">{t("changelog.exportAs")}</span>
            <select
              className="ocx-select"
              value=""
              aria-label={t("changelog.exportAs")}
              onChange={event => {
                const chosen = event.target.value;
                if (chosen) onExportAs(chosen as ExportFormat);
                event.target.value = "";
              }}
            >
              <option value="">{t("changelog.exportAs")}</option>
              {EXPORT_FORMATS.map(format => (
                <option key={format} value={format}>{FORMAT_META[format].label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div id={resultsId}>
        {RELEASES.length === 0 ? (
          <p className="ocx-changelog-empty">{t("changelog.empty")}</p>
        ) : rows.length === 0 ? (
          <div className="ocx-changelog-empty">
            <p>{t("changelog.noResults")}</p>
            <p className="m3-field-hint">{t("changelog.noResultsHint")}</p>
          </div>
        ) : (
          rows.map(row => (
            <section key={row.release.version} className="ocx-release">
              <h2 className="ocx-release-head">
                <span className="ocx-release-version">{row.release.version}</span>
                <span className="ocx-release-date">
                  {row.release.date ?? t("changelog.undated")}
                </span>
              </h2>
              {groupByKind(row.entries).map(group => (
                <div key={group.kind} className="ocx-release-group">
                  <h3 className={`ocx-release-kind ocx-kind--${group.kind}`}>{t(KIND_KEY[group.kind])}</h3>
                  <ul className="ocx-release-list">
                    {group.entries.map((entry, index) => (
                      <li key={`${group.kind}-${index}`}>{entry.text}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {row.hidden > 0 && (
                <p className="m3-field-hint">{t("changelog.entriesHidden", { count: row.hidden })}</p>
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
