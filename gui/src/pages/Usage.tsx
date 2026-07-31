import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n, type TFn, type Locale } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { cachedNumberFormat, formatEstimatedUsdValue as formatUsdEstimate } from "../intl-formatters";
import {
  IconBolt,
  IconClock,
  IconCoin,
  IconDataUsage,
  IconGauge,
  IconSearch,
  IconSwapVert,
} from "../icons";
import { Notice } from "../ui";
import { Button, Chip, Empty } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { modelLabel } from "../model-display";

type Range = "all" | "30d" | "7d";
type UsageSurface = "all" | "codex" | "claude" | "grok";

interface UsageSummaryTotals {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  unmeteredRequests?: number;
}

interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

interface UsageResponse {
  range: Range;
  surface: UsageSurface;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  error?: string;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * How many model rows the anchored builder is handed as sample text. Bounded
 * because a busy install reports hundreds of models and the string would
 * otherwise be rebuilt for a panel that is usually closed.
 */
const SAMPLE_ROWS = 40;

// ---- Locale-aware calendar labels -------------------------------------------
// The heatmap's month strip and the day tooltips are calendar labels, not product copy, so they
// come from Intl in the active locale rather than an English array baked into this file.
const MONTH_OPTIONS: Intl.DateTimeFormatOptions = { month: "short" };
const DAY_OPTIONS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const FULL_DAY_OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedDateFormat(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let fmt = dateFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, fmt);
  }
  return fmt;
}

/**
 * Parse a `YYYY-MM-DD` bucket key as a *local* calendar day. `new Date(iso)` would read it as UTC
 * midnight, which renders the previous day west of Greenwich — a heatmap cell labelled with the
 * wrong date is worse than no label at all.
 */
function parseIsoDay(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Localized `Jul 30`; falls back to the raw bucket key so a malformed date still identifies itself. */
function formatDayShort(iso: string, locale: Locale): string {
  const date = parseIsoDay(iso);
  return date ? cachedDateFormat(locale, DAY_OPTIONS).format(date) : iso;
}

/** Localized `Jul 30, 2026` for the tooltips, where the year disambiguates a year-long heatmap. */
function formatDayFull(iso: string, locale: Locale): string {
  const date = parseIsoDay(iso);
  return date ? cachedDateFormat(locale, FULL_DAY_OPTIONS).format(date) : iso;
}

/** Share readout beside each bar — one decimal, so the long tail of small models stays distinguishable. */
function formatShare(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Request counts are grouped (9,148) — a bare six-digit run is unreadable in a stat tile. */
function formatCount(n: number, locale: Locale): string {
  return cachedNumberFormat(locale).format(n);
}

// Stable per-model bar color: hash the provider/model id to a hue so the same model keeps its color
// across days and renders. Saturation/lightness are fixed for a cohesive palette on the dark chart.
function modelColor(model: string, provider: string): string {
  const key = `${provider}/${model}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

// Last 7 calendar days (oldest → newest), zero-filled, for the 7d bar chart. The API's `days` only
// carries dates with activity, so missing days are backfilled to 0 to keep a stable 7-bar axis.
function lastSevenDays(days: UsageDay[]): UsageDay[] {
  const byDate = new Map(days.map(d => [d.date, d]));
  const out: UsageDay[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const d = byDate.get(iso);
    out.push({
      date: iso,
      requests: d?.requests ?? 0,
      measuredRequests: d?.measuredRequests ?? 0,
      reportedRequests: d?.reportedRequests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      models: d?.models ?? [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

function buildHeatmap(days: UsageDay[], locale: Locale): { weeks: HeatmapCell[][]; months: { label: string; col: number }[]; buckets: number[] } {
  const buckets = quantileBuckets(days.map(d => d.totalTokens));
  const dayMap = new Map(days.map(d => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const monthFormat = cachedDateFormat(locale, MONTH_OPTIONS);
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const m = cursor.getMonth();
    if (cursor.getDay() === 0 && m !== prevMonthIdx && weeks.length - lastMonthCol >= 4) {
      months.push({ label: monthFormat.format(cursor), col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.totalTokens, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}

// ---- M3 presentation tokens -------------------------------------------------
// Inline because the Usage screen has no dedicated stylesheet and the shared
// ones are off-limits; every value is an --m3-* role token or a shell metric.
const TAB_STYLE: React.CSSProperties = { minHeight: 44, display: "inline-flex", alignItems: "center", gap: 6 };
const STAT_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: "var(--sp-2)",
  marginBottom: "var(--sp-4)",
};
const STAT_TILE: React.CSSProperties = {
  minHeight: "var(--h-stat, 96px)",
  padding: "var(--pad-card)",
  borderRadius: "var(--r-l)",
  border: "1px solid var(--m3-outline-variant)",
  background: "var(--m3-surface-container-low)",
};
// The prototype's tile label is an icon + text row, so the six tiles are scannable by mark
// before the eye reaches the words.
const STAT_LABEL: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-l)",
};
const STAT_VALUE: React.CSSProperties = {
  marginTop: 6,
  fontFamily: "var(--mono)",
  fontSize: "var(--t-title-l)",
  fontWeight: 500,
};
const STAT_HINT: React.CSSProperties = { minHeight: 16, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-s)" };
const BAR_TRACK: React.CSSProperties = {
  display: "block",
  minWidth: 80,
  height: 8,
  borderRadius: "var(--r-pill)",
  background: "var(--m3-surface-container-highest)",
  overflow: "hidden",
};
const SEARCH_INPUT: React.CSSProperties = { flex: "1 1 auto", minWidth: 0, maxWidth: 420 };
const SHARE_CELL: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, minWidth: 160 };
const SHARE_BAR: React.CSSProperties = { ...BAR_TRACK, flex: "1 1 120px" };
const SHARE_VALUE: React.CSSProperties = {
  flex: "0 0 56px",
  textAlign: "right",
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
};
const COVERAGE_ROW: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
  marginBottom: 12,
};
const COVERAGE_LABEL: React.CSSProperties = {
  flex: "0 0 140px",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-l)",
};
const COVERAGE_VALUE: React.CSSProperties = {
  flex: "0 0 80px",
  textAlign: "right",
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
};
const COVERAGE_BAR: React.CSSProperties = { ...BAR_TRACK, flex: "1 1 160px", minWidth: 100 };
const REGEX_ERROR_TEXT: React.CSSProperties = {
  margin: "0 0 12px",
  color: "var(--m3-error)",
  fontSize: "var(--t-body-s)",
};
const NOTE_TEXT: React.CSSProperties = {
  margin: "12px 0 0",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-body-s)",
};

function StatTile({ icon, label, value, hint, title }: {
  icon: ReactNode;
  label: string;
  value: string | number;
  hint?: ReactNode;
  title?: string;
}) {
  return (
    <div style={STAT_TILE} title={title}>
      <div style={STAT_LABEL}>{icon}{label}</div>
      <div style={STAT_VALUE}>{value}</div>
      {/* Reserved even when empty: the prototype keeps every tile the same height. */}
      <div style={STAT_HINT}>{hint}</div>
    </div>
  );
}

const STAT_ICON = { width: 18, height: 18, "aria-hidden": true } as const;

/** Share meter — functional data colour, carries the progressbar contract. */
function ShareBar({ ratio, label, tone = "var(--m3-primary)", style }: {
  ratio: number;
  label: string;
  tone?: string;
  style?: React.CSSProperties;
}) {
  const pct = Math.round(ratio * 100);
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      style={style ?? BAR_TRACK}
    >
      {/* A 2% floor keeps a non-zero share visible; a hairline fill reads as "none recorded". */}
      <span style={{ display: "block", width: `${ratio > 0 ? Math.max(2, pct) : 0}%`, height: "100%", background: tone }} />
    </span>
  );
}

function UsageFilters({
  surface,
  range,
  onSurface,
  onRange,
  t,
}: {
  surface: UsageSurface;
  range: Range;
  onSurface: (surface: UsageSurface) => void;
  onRange: (range: Range) => void;
  t: TFn;
}) {
  return (
    <div className="m3-row" style={{ gap: "var(--sp-2)" }}>
      <div className="m3-segmented" role="tablist" aria-label={t("logs.filter.surface.label")}>
        {(["all", "codex", "claude", "grok"] as UsageSurface[]).map(choice => {
          const label = t(`logs.filter.surface.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              role="tab"
              className={`m3-segment${surface === choice ? " selected" : ""}`}
              style={TAB_STYLE}
              aria-label={label}
              aria-selected={surface === choice}
              onClick={() => onSurface(choice)}
            >
              {choice === "codex" && (
                <img className="usage-source-mark" src="/provider-icons/openai.svg" alt="" aria-hidden="true" />
              )}
              {choice === "claude" && (
                <img className="usage-source-mark" src="/provider-icons/claude.svg" alt="" aria-hidden="true" />
              )}
              {choice === "grok" && (
                <img className="usage-source-mark" src="/provider-icons/grok.svg" alt="" aria-hidden="true" />
              )}
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <div className="m3-segmented" role="tablist" aria-label={t("usage.title")}>
        {(["all", "30d", "7d"] as Range[]).map(choice => {
          const label = t(`usage.range.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              role="tab"
              className={`m3-segment${range === choice ? " selected" : ""}`}
              style={TAB_STYLE}
              aria-label={label}
              aria-selected={range === choice}
              onClick={() => onRange(choice)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UsageSummaryCards({
  summary,
  activeDays,
  locale,
  t,
}: {
  summary: UsageSummaryTotals;
  activeDays: number;
  locale: Locale;
  t: TFn;
}) {
  const cacheWrites = summary.cacheCreationInputTokens ?? 0;
  const unpriced = summary.unpricedRequests ?? 0;
  // Tile order, marks and hints follow the prototype's six usage cards. "Measured" is no longer
  // its own tile there — it is the requests hint, which keeps the pair of numbers side by side.
  return (
    <div style={STAT_GRID} role="group" aria-label={t("usage.title")}>
      <StatTile
        icon={<IconSwapVert {...STAT_ICON} />}
        label={t("usage.card.requests")}
        value={formatCount(summary.requests, locale)}
        hint={t("usage.card.requestsHint", { count: formatCount(summary.measuredRequests, locale) })}
      />
      <StatTile
        icon={<IconDataUsage {...STAT_ICON} />}
        label={t("usage.card.totalTokens")}
        value={formatTokens(summary.totalTokens, locale)}
        hint={t("usage.card.totalTokensHint", { count: formatCount(summary.reportedRequests, locale) })}
      />
      <StatTile
        icon={<IconBolt {...STAT_ICON} />}
        label={t("usage.card.cachedTokens")}
        title={t("usage.card.cachedTokensHint")}
        value={formatTokens(summary.cacheReadInputTokens ?? summary.cachedInputTokens, locale)}
        hint={cacheWrites > 0 ? `${formatTokens(cacheWrites, locale)} ${t("usage.card.cacheWriteTokens")}` : undefined}
      />
      <StatTile
        icon={<IconGauge {...STAT_ICON} />}
        label={t("usage.card.coverage")}
        value={formatPct(summary.coverageRatio)}
        hint={unpriced > 0 ? t("usage.card.coverageHint", { count: formatCount(unpriced, locale) }) : undefined}
      />
      <StatTile
        icon={<IconClock {...STAT_ICON} />}
        label={t("usage.card.activeDays")}
        value={activeDays}
      />
      {summary.estimatedCostUsd !== undefined && (
        <StatTile
          icon={<IconCoin {...STAT_ICON} />}
          label={t("usage.card.estCost")}
          // The short label is the tile; the long one stays reachable, so nobody reads
          // "Est. cost" as a bill.
          title={t("usage.cost.total")}
          value={formatUsdEstimate(summary.estimatedCostUsd, locale)}
          hint={t("usage.card.costHint")}
        />
      )}
    </div>
  );
}

function WeekDayBars({ weekBars, locale, t }: { weekBars: UsageDay[]; locale: Locale; t: TFn }) {
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const max = Math.max(1, ...weekBars.map(day => day.totalTokens));

  return (
    <div className="daybars" role="img" aria-label={t("usage.section.heatmap")}>
      {weekBars.map(day => {
        const percentage = Math.round((day.totalTokens / max) * 100);
        const label = formatDayShort(day.date, locale);
        return (
          <div
            key={day.date}
            className="daybar"
            onMouseEnter={() => setHoverDay(day.date)}
            onMouseLeave={() => setHoverDay(current => (current === day.date ? null : current))}
          >
            <div className="daybar-track">
              <div className="daybar-stack" style={{ height: `${percentage}%` }}>
                {day.models.map(model => (
                  <div
                    key={`${model.provider}/${model.model}`}
                    className="daybar-seg"
                    style={{ flexGrow: model.totalTokens, background: modelColor(model.model, model.provider) }}
                  />
                ))}
                {day.models.length === 0 && day.totalTokens > 0 && (
                  <div className="daybar-seg" style={{ flexGrow: 1, background: "var(--m3-ok)" }} />
                )}
              </div>
            </div>
            {hoverDay === day.date && day.totalTokens > 0 && (
              <div className="daybar-tip" role="tooltip">
                <div className="daybar-tip-date">{formatDayFull(day.date, locale)}</div>
                {day.models.slice(0, 8).map(model => (
                  <div key={`${model.provider}/${model.model}`} className="daybar-tip-row">
                    <span className="daybar-tip-swatch" style={{ background: modelColor(model.model, model.provider) }} />
                    <span className="daybar-tip-name">{modelLabel(model.model)}</span>
                    <span className="daybar-tip-val">{formatTokens(model.totalTokens, locale)}</span>
                  </div>
                ))}
              </div>
            )}
            <span className="daybar-count">{formatTokens(day.totalTokens, locale)}</span>
            <span className="daybar-label muted">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function UsageHeatmapPanel({
  range,
  heatmap,
  weekBars,
  locale,
  t,
}: {
  range: Range;
  heatmap: ReturnType<typeof buildHeatmap>;
  weekBars: UsageDay[];
  locale: Locale;
  t: TFn;
}) {
  const heatmapRef = useRef<HTMLDivElement | null>(null);
  const [hoverCell, setHoverCell] = useState<{ weekIndex: number; dayIndex: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const element = heatmapRef.current;
    if (!element) return;
    const pinRight = () => { element.scrollLeft = element.scrollWidth; };
    pinRight();
    const observer = new ResizeObserver(pinRight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [heatmap, range]);

  const titleId = "usage-heatmap-title";
  return (
    <section className="m3-card" aria-labelledby={titleId}>
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id={titleId} className="m3-card-title">{t("usage.section.heatmap")}</h2>
        </div>
      </header>
      {range === "7d" ? (
        <WeekDayBars weekBars={weekBars} locale={locale} t={t} />
      ) : (
        <div className="heatmap" ref={heatmapRef} role="img" aria-labelledby={titleId}>
          <div className="heatmap-months" style={{ gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, calc(var(--hm-cell) + var(--hm-gap)))` }}>
            <span className="heatmap-day-spacer" />
            {heatmap.months.map(month => (
              <span key={`${month.label}-${month.col}`} className="heatmap-month" style={{ gridColumn: month.col + 2 }}>{month.label}</span>
            ))}
          </div>
          <div className="heatmap-body">
            <div className="heatmap-days">
              <span /><span>{t("usage.dayMon")}</span><span /><span>{t("usage.dayWed")}</span><span /><span>{t("usage.dayFri")}</span><span />
            </div>
            <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, var(--hm-cell))` }}>
              {heatmap.weeks.map((week, weekIndex) => (
                <div key={week[0]?.date || `week-${weekIndex}`} className="heatmap-week">
                  {week.map((cell, dayIndex) => (
                    <div
                      key={cell.date || `pad-${weekIndex}-${dayIndex}`}
                      className={`heatmap-cell heatmap-cell-${cell.level}`}
                      onMouseEnter={event => {
                        if (!cell.date) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setHoverCell({ weekIndex, dayIndex, x: rect.left + rect.width / 2, y: rect.top });
                      }}
                      onMouseLeave={() => setHoverCell(current => (
                        current?.weekIndex === weekIndex && current.dayIndex === dayIndex ? null : current
                      ))}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {hoverCell && (() => {
            const cell = heatmap.weeks[hoverCell.weekIndex]?.[hoverCell.dayIndex];
            if (!cell?.date) return null;
            return (
              <div className="heatmap-tip" role="tooltip" style={{ left: hoverCell.x, top: hoverCell.y }}>
                <div className="heatmap-tip-date">{formatDayFull(cell.date, locale)}</div>
                <div className="heatmap-tip-val">{t("usage.heatmap.tooltipTokens", { tokens: formatTokens(cell.totalTokens, locale) })}</div>
                <div className="heatmap-tip-req muted">{t("usage.heatmap.tooltipRequests", { requests: cell.requests })}</div>
              </div>
            );
          })()}
          <div className="heatmap-legend muted">
            <span>{t("usage.heatmap.less")}</span>
            {[0, 1, 2, 3, 4].map(level => <span key={level} className={`heatmap-cell heatmap-cell-${level}`} />)}
            <span>{t("usage.heatmap.more")}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function UsageModelsTable({
  models,
  sample,
  modelQuery,
  onModelQuery,
  useRegex,
  onUseRegex,
  regexError,
  locale,
  t,
}: {
  models: UsageModel[];
  /**
   * Sample text for the anchored builder, built from the UNFILTERED model list.
   * `models` here is already narrowed by the current query, and testing a new
   * pattern against the old pattern's survivors is how a builder reports "no
   * matches" for a pattern that would in fact have found something.
   */
  sample: string;
  modelQuery: string;
  onModelQuery: (query: string) => void;
  useRegex: boolean;
  onUseRegex: (next: boolean) => void;
  regexError: string | null;
  locale: Locale;
  t: TFn;
}) {
  const searchLabel = t("usage.search.models");
  const sectionLabel = t("usage.section.models");
  const titleId = "usage-models-title";
  const searchInput = (
    <div className="m3-row" role="search" style={{ gap: 8 }}>
      <IconSearch aria-hidden="true" />
      <input
        className="m3-input"
        style={SEARCH_INPUT}
        aria-label={searchLabel}
        placeholder={searchLabel}
        aria-invalid={!!regexError}
        value={modelQuery}
        onChange={event => onModelQuery(event.target.value)}
      />
      {/* Plain text stays the default; `.*` is the explicit opt-in every search bar carries. */}
      <Chip selected={useRegex} onClick={() => onUseRegex(!useRegex)} title={t("search.regexHint")}>
        <code style={{ fontFamily: "var(--mono)" }}>.*</code>
      </Chip>
      {/* The builder sits beside the field it serves, not behind a menu. */}
      <RegexBuilderButton
        value={modelQuery}
        onApply={pattern => onModelQuery(pattern)}
        regex={useRegex}
        onRegexChange={onUseRegex}
        sample={sample}
      />
    </div>
  );
  const table = (
    <div className="usage-scroll" style={{ overflowX: "auto" }}>
      <table className="m3-table">
        <thead>
          <tr>
            <th>{t("logs.col.model")}</th>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map(model => (
            <tr key={`${model.provider}/${model.model}`}>
              <td className="mono">{modelLabel(model.model)}</td>
              <td className="muted">{model.provider}</td>
              <td className="num">{formatCount(model.requests, locale)}</td>
              <td className="num">{formatCount(model.measuredRequests, locale)}</td>
              <td className="num mono">{formatTokens(model.totalTokens, locale)}</td>
              <td>
                <span style={SHARE_CELL}>
                  <ShareBar ratio={model.shareRatio} label={model.model} style={SHARE_BAR} />
                  <span style={SHARE_VALUE}>{formatShare(model.shareRatio)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="m3-card" aria-labelledby={titleId}>
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id={titleId} className="m3-card-title">{sectionLabel}</h2>
        </div>
        <div className="m3-card-actions">{searchInput}</div>
      </header>
      {regexError ? (
        <p role="alert" style={REGEX_ERROR_TEXT}>{t("regex.invalid")}: {regexError}</p>
      ) : null}
      {/* Only a *search* that matched nothing gets the no-match state; an unfiltered empty list
          would be a different fact, and the page-level empty state already covers it. */}
      {models.length === 0 && modelQuery.trim() ? <Empty title={t("models.noMatch")} /> : table}
    </section>
  );
}

function UsageProvidersTable({
  providers,
  locale,
  t,
}: {
  providers: UsageProvider[];
  locale: Locale;
  t: TFn;
}) {
  const sectionLabel = t("usage.section.providers");
  const titleId = "usage-providers-title";
  const table = (
    <div className="usage-scroll" style={{ overflowX: "auto" }}>
      <table className="m3-table">
        <thead>
          <tr>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(provider => (
            <tr key={provider.provider}>
              <td className="mono">{provider.provider}</td>
              <td className="num">{formatCount(provider.requests, locale)}</td>
              <td className="num">{formatCount(provider.measuredRequests, locale)}</td>
              <td className="num mono">{formatTokens(provider.totalTokens, locale)}</td>
              <td>
                <span style={SHARE_CELL}>
                  {/* Tertiary, so a provider row is never mistaken for the model row above it. */}
                  <ShareBar ratio={provider.shareRatio} label={provider.provider} tone="var(--m3-tertiary)" style={SHARE_BAR} />
                  <span style={SHARE_VALUE}>{formatShare(provider.shareRatio)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="m3-card" aria-labelledby={titleId}>
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id={titleId} className="m3-card-title">{sectionLabel}</h2>
        </div>
      </header>
      {table}
    </section>
  );
}

function UsageCoveragePanel({
  summary,
  locale,
  t,
}: {
  summary: UsageSummaryTotals;
  locale: Locale;
  t: TFn;
}) {
  const sectionLabel = t("usage.section.coverage");
  const titleId = "usage-coverage-title";
  // Every row is a share of the same denominator, so the bars are comparable down the column.
  const total = Math.max(1, summary.requests);
  const excluded = (summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0);
  const rows: { key: string; label: string; value: number; tone: string }[] = [
    { key: "measured", label: t("usage.coverage.measured"), value: summary.measuredRequests, tone: "var(--m3-primary)" },
    { key: "reported", label: t("usage.coverage.reported"), value: summary.reportedRequests, tone: "var(--m3-tertiary)" },
    { key: "estimated", label: t("usage.coverage.estimated"), value: summary.estimatedRequests, tone: "var(--m3-warn)" },
    { key: "unreported", label: t("logs.tokens.unreported"), value: summary.unreportedRequests, tone: "var(--m3-warn)" },
    { key: "unsupported", label: t("logs.tokens.unsupported"), value: summary.unsupportedRequests, tone: "var(--m3-warn)" },
  ];
  const body = (
    <>
      {rows.map(row => (
        <div key={row.key} style={COVERAGE_ROW}>
          <span style={COVERAGE_LABEL}>{row.label}</span>
          <ShareBar ratio={row.value / total} label={row.label} tone={row.tone} style={COVERAGE_BAR} />
          <span style={COVERAGE_VALUE}>{formatCount(row.value, locale)}</span>
        </div>
      ))}
      <p style={NOTE_TEXT}>{t("usage.coverage.note")}</p>
      {/* The coverage tile's hint counts unpriced requests; the exact excluded total (unpriced
          plus unmetered) belongs here, where the rest of the request accounting lives. */}
      {excluded > 0 && <p style={NOTE_TEXT}>{t("usage.cost.unpricedNote", { count: excluded })}</p>}
      {summary.estimatedCostUsd !== undefined && (
        <p style={NOTE_TEXT}>{t("usage.cost.disclaimer")}</p>
      )}
    </>
  );

  return (
    <section className="m3-card" aria-labelledby={titleId}>
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id={titleId} className="m3-card-title">{sectionLabel}</h2>
        </div>
      </header>
      {body}
    </section>
  );
}

export default function Usage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const [surface, setSurface] = useState<UsageSurface>("all");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const loadGenerationRef = useRef(0);

  const fetchUsage = useCallback(async (nextRange: Range, nextSurface: UsageSurface, signal: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/usage?range=${nextRange}&surface=${nextSurface}`, { signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const json = await res.json() as UsageResponse;
      if (signal.aborted || generation !== loadGenerationRef.current) return;
      setData(json);
    } catch (cause) {
      // A stale request (range/apiBase changed, or unmount) must not overwrite newer state.
      if (signal.aborted || generation !== loadGenerationRef.current) return;
      const detail = cause instanceof Error ? cause.message : "";
      setError(detail ? `${t("usage.loadError")} ${detail}` : t("usage.loadError"));
    } finally {
      // Only the current request may clear loading — a superseded abort must not
      // settle the UI while a newer fetch is still in flight.
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetchUsage(range, surface, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      // Invalidate before abort so a superseded request's finally cannot clear
      // loading in the gap before the deferred replacement increments generation.
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchUsage, range, surface]);

  const heatmap = useMemo(() => buildHeatmap(data?.days ?? [], locale), [data?.days, locale]);
  const weekBars = useMemo(() => lastSevenDays(data?.days ?? []), [data?.days]);
  const activeDays = useMemo(() => (data?.days ?? []).filter(d => d.requests > 0).length, [data?.days]);
  // Plain substring by default; the `.*` chip switches the same field to ECMAScript RegExp,
  // evaluated locally and capped at 400 pattern chars like every other search bar here.
  const { filteredModels, regexError } = useMemo(() => {
    const query = modelQuery.trim();
    const models = data?.models ?? [];
    const sorted = models.toSorted((a, b) => b.totalTokens - a.totalTokens);
    if (!query) return { filteredModels: sorted.slice(0, 100), regexError: null as string | null };

    let matches: (haystack: string) => boolean;
    if (useRegex) {
      try {
        const re = new RegExp(query.slice(0, 400), "i");
        matches = haystack => re.test(haystack);
      } catch (cause) {
        // An in-progress pattern must not blank the screen silently — the row below says why.
        return { filteredModels: [], regexError: cause instanceof Error ? cause.message : String(cause) };
      }
    } else {
      const needle = query.toLowerCase();
      matches = haystack => haystack.toLowerCase().includes(needle);
    }
    const filtered = sorted.filter(m => matches(`${m.model} ${m.provider} ${m.resolvedModel ?? ""}`));
    return { filteredModels: filtered.slice(0, 100), regexError: null as string | null };
  }, [data?.models, modelQuery, useRegex]);

  // The same haystack `filteredModels` matches against, from the unfiltered list.
  const modelSample = useMemo(
    () => (data?.models ?? [])
      .slice(0, SAMPLE_ROWS)
      .map(m => `${m.model} ${m.provider} ${m.resolvedModel ?? ""}`.trim())
      .join("\n"),
    [data?.models],
  );

  const sortedProviders = useMemo(() =>
    (data?.providers ?? []).toSorted((a, b) => b.totalTokens - a.totalTokens),
    [data?.providers],
  );

  return (
    <>
      <p className="m3-page-lead">{t("usage.subtitle")}</p>
      <div className="m3-row" style={{ marginBottom: "var(--sp-4)" }}>
        <UsageFilters surface={surface} range={range} onSurface={setSurface} onRange={setRange} t={t} />
      </div>

      {error ? (
        <Notice tone="err">
          {error}{" "}
          <Button
            variant="text"
            onClick={() => void fetchUsage(range, surface, new AbortController().signal)}
            disabled={loading}
          >
            {t("common.retry")}
          </Button>
        </Notice>
      ) : loading && !data ? (
        <Empty title={t("usage.loading")} />
      ) : data?.summary.requests === 0 ? (
        <Empty title={t("usage.empty")} />
      ) : data ? (
        <>
          <UsageSummaryCards summary={data.summary} activeDays={activeDays} locale={locale} t={t} />
          <UsageHeatmapPanel range={range} heatmap={heatmap} weekBars={weekBars} locale={locale} t={t} />
          <UsageModelsTable
            models={filteredModels}
            sample={modelSample}
            modelQuery={modelQuery}
            onModelQuery={setModelQuery}
            useRegex={useRegex}
            onUseRegex={setUseRegex}
            regexError={regexError}
            locale={locale}
            t={t}
          />
          <UsageProvidersTable providers={sortedProviders} locale={locale} t={t} />
          <UsageCoveragePanel summary={data.summary} locale={locale} t={t} />
        </>
      ) : null}
    </>
  );
}
