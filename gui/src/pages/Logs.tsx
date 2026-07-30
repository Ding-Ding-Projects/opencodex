import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, LOCALES, type TFn } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { hashLogConversationQuery, matchesLogConversationId } from "../log-conversation-id";
import { statusCodeInfo } from "../status-codes";
import { IconRegex, IconSearch, IconX } from "../icons";
import { modelLabel } from "../model-display";
import { Notice } from "../ui";
import { Button, Chip, Empty, TextInput, Toggle } from "../shell/m3-ui";
import Debug from "./Debug";

import { M3_TABLIST_STYLE, m3TabStyle } from "./debug-shared";
import { consumeLogsSearchHandoff } from "./logs-search-handoff";
import type { LogsTab } from "./logs-tab-keydown";
import { logsTabKeyDown, readTabFromHash, selectLogsTab } from "./logs-tab-keydown";

interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
}

type LogUsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

type MetricUnavailableReason =
  | "usage_missing" | "usage_unsupported" | "output_missing" | "invalid_duration"
  | "price_unmatched" | "invalid_cache_breakdown"
  | "invalid_usage" | "combo_attempt_unavailable";

type CostEstimateReason = "usage_estimated" | "cache_detail_missing" | "expected_price_overlay";

type TokPerSecondResult =
  | { kind: "value"; value: number; estimated: boolean }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

interface MatchedPriceInfo {
  provider: string;
  modelId: string;
  jawcodeProvider?: string;
  source: "jawcode" | "expected";
  sourceRef?: string;
  verifiedAt?: string;
  status: "verified" | "verified-derived";
}

type CostResult =
  | {
    kind: "value";
    estimate: {
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      estimated: boolean;
      price?: MatchedPriceInfo;
      attempts?: Array<{ ordinal: number; price: MatchedPriceInfo }>;
    };
    estimateReasons: CostEstimateReason[];
  }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

interface LogDisplayMetrics {
  tokPerSecond: TokPerSecondResult;
  cost: CostResult;
}

type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "image-413";

interface LogAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: LogUsageStatus;
  inputTokenEstimate?: number;
  usage?: UsageBreakdown;
  totalTokens?: number;
  errorCode?: string;
  firstOutputMs?: number;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
  displayMetrics?: LogDisplayMetrics;
}

interface LogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  // Mirrors the server's `PersistedUsageEntry["surface"]`. Codex is the unlabelled
  // default, so an absent value is a Codex request rather than an unknown one.
  surface?: "claude" | "claude-desktop" | "grok";
  conversationId?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  responseServiceTier?: string;
  resolvedModel?: string;
  modelSupportsServiceTier?: boolean;
  status: number;
  durationMs: number;
  errorCode?: string;
  upstreamError?: string;
  usageStatus?: LogUsageStatus;
  usage?: UsageBreakdown;
  totalTokens?: number;
  firstOutputMs?: number;
  attempts?: LogAttempt[];
  displayMetrics?: LogDisplayMetrics;
}

function isCursorUsageProvider(provider: string): boolean {
  return provider === "cursor" || provider.startsWith("cursor-");
}

function tokensTitle(log: LogEntry, t: TFn): string | undefined {
  if (!log.usage) return undefined;
  const split = cacheSplit(log);
  const parts = [
    `${t("logs.tokens.input")}=${log.usage.inputTokens}`,
    `${t("logs.tokens.output")}=${log.usage.outputTokens}`,
  ];
  if (split.read !== undefined) parts.push(`${t("logs.tokens.cacheRead")}=${split.read}`);
  if (split.write !== undefined) parts.push(`${t("logs.tokens.cacheWrite")}=${split.write}`);
  if (typeof log.usage.reasoningOutputTokens === "number") parts.push(`${t("logs.tokens.reasoning")}=${log.usage.reasoningOutputTokens}`);
  if (log.usageStatus === "estimated") parts.push(t("logs.tokens.estimatedNote"));
  if (log.usageStatus === "estimated" && split.read === undefined && split.write === undefined) {
    parts.push(t(isCursorUsageProvider(log.provider) ? "logs.tokens.noCacheCursorNote" : "logs.tokens.noCacheNote"));
  }
  return parts.join(" \xC2\xB7 ");
}

function displayTokenTotal(log: LogEntry): number | undefined {
  if (!log.usage) return typeof log.totalTokens === "number" ? log.totalTokens : undefined;
  // inputTokens is inclusive of cache read/write (canonical convention, devlog 070);
  // never re-add cache detail. max() keeps legacy pre-070 rows honest.
  const baseTotal = log.usage.inputTokens + log.usage.outputTokens;
  const explicitTotal = log.usage.totalTokens ?? log.totalTokens;
  return typeof explicitTotal === "number" ? Math.max(explicitTotal, baseTotal) : baseTotal;
}

/** Cache read/write split; recovers reads from legacy rows that stored read+write combined. */
function cacheSplit(log: LogEntry): { read?: number; write?: number } {
  const u = log.usage;
  if (!u) return {};
  const write = typeof u.cacheCreationInputTokens === "number" ? u.cacheCreationInputTokens : undefined;
  const read = typeof u.cacheReadInputTokens === "number"
    ? u.cacheReadInputTokens
    : typeof u.cachedInputTokens === "number" && write !== undefined
      ? Math.max(0, u.cachedInputTokens - write)
      : u.cachedInputTokens;
  return { read, write };
}

function speedLabel(log: LogEntry): string | undefined {
  if (log.requestedSpeedLabel) return log.requestedSpeedLabel;
  if (log.modelSupportsServiceTier && log.configuredSpeedLabel) return log.configuredSpeedLabel;
  return undefined;
}

interface ReasoningLogFields {
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
}

function effortLabel(log: ReasoningLogFields): string {
  const requested = log.requestedEffort?.replace(/\s*->\s*/g, " → ");
  const effective = log.effectiveEffort;
  if (!requested) return effective ?? "-";
  // requestedEffort may already contain a cap/clamp chain (for example max->high).
  // Only append the adapter result when it differs from that chain's terminal value.
  if (!effective || requested === effective || requested.split(" → ").at(-1) === effective) return requested;
  return `${requested} → ${effective}`;
}

function reasoningWireLabel(log: ReasoningLogFields): string | undefined {
  if (!log.reasoningWireField || log.reasoningWireValue === undefined) return undefined;
  return `${log.reasoningWireField}=${log.reasoningWireValue}`;
}

function formatTokPerSecond(result: TokPerSecondResult | undefined, localeTag?: string): string {
  if (!result || result.kind === "unavailable" || !Number.isFinite(result.value) || result.value <= 0) return "\u2014";
  const digits = result.value >= 100 ? 0 : 1;
  const value = new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(result.value);
  return `${result.estimated ? "~" : ""}${value}`;
}

function formatEstimatedUsd(result: CostResult | undefined, localeTag?: string): string {
  if (!result || result.kind === "unavailable" || !Number.isFinite(result.estimate.cost.total) || result.estimate.cost.total < 0) return "\u2014";
  const totalUsd = result.estimate.cost.total;
  return `~$${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(totalUsd)}`;
}

function formatEstimatedUsdValue(value: number, localeTag?: string): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  return `~$${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)}`;
}

const METRIC_REASON_KEYS = {
  usage_missing: "logs.detail.reason.usage_missing",
  usage_unsupported: "logs.detail.reason.usage_unsupported",
  output_missing: "logs.detail.reason.output_missing",
  invalid_duration: "logs.detail.reason.invalid_duration",
  price_unmatched: "logs.detail.reason.price_unmatched",
  invalid_cache_breakdown: "logs.detail.reason.invalid_cache_breakdown",
  invalid_usage: "logs.detail.reason.invalid_usage",
  combo_attempt_unavailable: "logs.detail.reason.combo_attempt_unavailable",
} as const satisfies Record<MetricUnavailableReason, string>;

const ESTIMATE_REASON_KEYS = {
  usage_estimated: "logs.detail.estimate.usage_estimated",
  cache_detail_missing: "logs.detail.estimate.cache_detail_missing",
  expected_price_overlay: "logs.detail.estimate.expected_price_overlay",
} as const satisfies Record<CostEstimateReason, string>;

function metricReasonKey(reason: MetricUnavailableReason) {
  return METRIC_REASON_KEYS[reason];
}

function estimateReasonKey(reason: CostEstimateReason) {
  return ESTIMATE_REASON_KEYS[reason];
}

function verificationKey(status: MatchedPriceInfo["status"]): "logs.detail.verification.verified" | "logs.detail.verification.derived" {
  return status === "verified" ? "logs.detail.verification.verified" : "logs.detail.verification.derived";
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return "var(--m3-ok)";
  if (status >= 400) return "var(--m3-error)";
  return "var(--m3-warn)";
}

/**
 * Status is a tonal badge in the prototype, toned 2xx ok / 3xx-4xx warn / 5xx
 * error. Status palettes are functional data colours, so the containers are
 * addressed directly rather than through a chrome class.
 */
function statusBadgeStyle(status: number): CSSProperties {
  const tone = status < 300
    ? { background: "var(--m3-ok-container)", color: "var(--m3-on-ok-container)" }
    : status < 500
      ? { background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)" }
      : { background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" };
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 10px",
    borderRadius: "var(--r-pill)",
    fontFamily: "var(--mono)",
    fontSize: "var(--t-label-s)",
    fontWeight: 600,
    letterSpacing: "0.2px",
    whiteSpace: "nowrap",
    ...tone,
  };
}

type SurfaceFilter = "all" | "codex" | "claude" | "grok";

/**
 * Grok used to fall into the Codex bucket because the filter was a two-way
 * `surface === "claude"` split, which silently hid it behind the wrong chip.
 * Claude Desktop rides the Claude surface and is grouped with it.
 */
function matchesSurfaceFilter(filter: SurfaceFilter, surface: LogEntry["surface"]): boolean {
  if (filter === "all") return true;
  if (filter === "claude") return surface === "claude" || surface === "claude-desktop";
  if (filter === "grok") return surface === "grok";
  return surface === undefined;
}

function isClaudeSurface(surface: LogEntry["surface"]): boolean {
  return surface === "claude" || surface === "claude-desktop";
}

/**
 * Haystack for the primary logs search, matching the prototype's matcher
 * (`id model provider status error`). `resolvedModel` is included because the
 * table renders it in preference to the requested id, so what the user reads is
 * what the search finds.
 */
function logSearchText(log: LogEntry): string {
  return [
    log.requestId,
    log.model,
    log.resolvedModel,
    log.provider,
    String(log.status),
    log.errorCode,
    log.upstreamError,
  ].filter(Boolean).join(" ");
}

/**
 * `.m3-table` intentionally carries no numeric-column rule, so the right
 * alignment the legacy `.tbl .num` selector supplied is re-applied inline with
 * role tokens. Cells keep `.num`/`.mono` for the mono face + tabular figures.
 */
/** Same bound every other search in the app applies before compiling a pattern. */
const PATTERN_CAP = 400;

const NUM_CELL: CSSProperties = { textAlign: "right" };

/**
 * The prototype's Details affordance is a text-button pill, not the underlined
 * caption link `.log-detail-btn` still describes. styles.css is imported after
 * m3-shell.css, so the legacy rule outranks `.m3-btn--text` at equal specificity —
 * the M3 anatomy has to be applied inline to win, and the class stays for its
 * existing test and styling hooks.
 */
const DETAIL_BTN: CSSProperties = {
  minHeight: "var(--h-btn)",
  padding: "0 12px",
  borderRadius: "var(--r-pill)",
  color: "var(--m3-primary)",
  fontSize: "var(--t-label-m)",
  fontWeight: 500,
  textDecoration: "none",
};

/** Rounded surface the log table scrolls inside, replacing legacy `.tbl-wrap`. */
const TABLE_SHELL: CSSProperties = {
  border: "1px solid var(--m3-outline-variant)",
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-lowest)",
  overflowY: "auto",
  overflowX: "auto",
  maxHeight: "calc(100vh - 260px)",
};

function formatLogTimestamp(ts: number, localeTag?: string): string {
  return new Date(ts).toLocaleTimeString(localeTag);
}

function formatLogDateTime(ts: number, localeTag?: string): string {
  return new Date(ts).toLocaleString(localeTag);
}

function modelTitle(log: LogEntry): string {
  const details = [
    `model=${log.model}`,
    log.resolvedModel ? `resolved=${log.resolvedModel}` : undefined,
    log.requestedServiceTier ? `requestedTier=${log.requestedServiceTier}` : undefined,
    log.configuredServiceTier ? `configuredTier=${log.configuredServiceTier}` : undefined,
    log.responseServiceTier ? `responseTier=${log.responseServiceTier}` : undefined,
    log.modelSupportsServiceTier !== undefined ? `supportsTier=${log.modelSupportsServiceTier}` : undefined,
  ].filter(Boolean);
  return details.join(" \xC2\xB7 ");
}

function summarizeFilteredLogs(entries: LogEntry[]): {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedRequests: number;
  unmeteredRequests: number;
} {
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let unpricedRequests = 0;
  let unmeteredRequests = 0;
  for (const entry of entries) {
    const tokens = displayTokenTotal(entry);
    if (tokens !== undefined) totalTokens += tokens;
    if (entry.usageStatus === "unsupported") {
      unmeteredRequests += 1;
      continue;
    }
    const cost = entry.displayMetrics?.cost;
    const total = cost?.kind === "value" ? cost.estimate.cost.total : undefined;
    if (total !== undefined && Number.isFinite(total) && total >= 0) {
      estimatedCostUsd += total;
      continue;
    }
    unpricedRequests += 1;
  }
  return { requests: entries.length, totalTokens, estimatedCostUsd, unpricedRequests, unmeteredRequests };
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detail, setDetail] = useState<LogEntry | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>("all");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [conversationFilter, setConversationFilter] = useState("");
  const [conversationQueryHash, setConversationQueryHash] = useState<string | undefined>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  // The hash is the source of truth for the active tab (#logs vs #logs/debug),
  // so refresh/bookmark/back-forward keep the tab choice.
  const [tab, setTab] = useState<LogsTab>(readTabFromHash);

  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The regex builder navigates here after stashing a finished pattern. Claiming
  // it in an effect rather than a lazy initialiser keeps StrictMode's double
  // mount honest: the record is gone by the second pass, and the state set on the
  // first one survives, so the pattern is neither lost nor applied twice.
  useEffect(() => {
    const handoff = consumeLogsSearchHandoff();
    if (!handoff) return;
    setQuery(handoff.pattern);
    setUseRegex(handoff.regex);
  }, []);

  const selectTab = selectLogsTab;

  const fetchLogs = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    // Silent polls must not clear an existing error or toggle loading — otherwise
    // failures flicker between the error banner, empty state, and stale table.
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/logs`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      setLogs(await res.json());
      setError(null);
    } catch (cause) {
      if (silent) return;
      const detail = cause instanceof Error ? cause.message : "";
      setError(detail ? `${t("logs.loadError")} ${detail}` : t("logs.loadError"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    if (tab !== "logs") return;
    void fetchLogs();
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchLogs({ silent: true }), 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs, tab]);

  const detailInfo = detail ? statusCodeInfo(detail.status, locale) : null;
  const conversationQuery = conversationFilter.trim();

  useEffect(() => {
    let cancelled = false;
    if (!conversationQuery) {
      setConversationQueryHash(undefined);
      return;
    }
    void hashLogConversationQuery(conversationQuery).then(hash => {
      if (!cancelled) setConversationQueryHash(hash);
    });
    return () => { cancelled = true; };
  }, [conversationQuery]);

  // Plain text is the default; `.*` opts the same field into ECMAScript RegExp,
  // evaluated locally. An invalid pattern matches nothing and says why rather
  // than silently falling back to a substring search.
  //
  // Bounded like every other search in the app. This one matters more than the
  // rest now: the regex-builder hand-off writes a pattern into this field from
  // outside the screen, so it is the only search bar whose input does not come
  // from the box in front of the user — and it was the only one without the cap.
  // An unbounded pattern over every log line is a page the tab cannot recover from.
  const { matchesQuery, regexError } = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return { matchesQuery: () => true, regexError: null as string | null };
    if (useRegex) {
      try {
        const re = new RegExp(trimmed.slice(0, PATTERN_CAP), "i");
        return { matchesQuery: (text: string) => re.test(text), regexError: null as string | null };
      } catch (cause) {
        return {
          matchesQuery: () => false,
          regexError: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
    const needle = trimmed.toLowerCase();
    return {
      matchesQuery: (text: string) => text.toLowerCase().includes(needle),
      regexError: null as string | null,
    };
  }, [query, useRegex]);

  const filteredLogs = logs.filter(log => (
    matchesSurfaceFilter(surfaceFilter, log.surface)
    && matchesQuery(logSearchText(log))
    && (!conversationQuery || matchesLogConversationId(log.conversationId, conversationQuery, conversationQueryHash))
  ));
  const conversationTotals = conversationQuery ? summarizeFilteredLogs(filteredLogs) : null;
  // "No requests yet" and "nothing matched" are different facts, and telling the
  // user the wrong one hides their own filter from them. Anything that narrows
  // the table counts, including the surface chips.
  const isNarrowed = query.trim() !== "" || conversationQuery !== "" || surfaceFilter !== "all";

  // TanStack Virtual returns unstable function identities; React Compiler skips this call.
  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const rowVirtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 44,
    overscan: 15,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <>
      {/* Pill tablist per the prototype's LOGS section; roving focus still comes
          from logsTabKeyDown so ArrowLeft/Right/Home/End keep working. */}
      <div role="tablist" aria-label={t("logs.sectionsAria")} style={{ ...M3_TABLIST_STYLE, marginBottom: 16 }}>
        <button
          type="button"
          role="tab"
          id="logs-tab-logs"
          aria-selected={tab === "logs"}
          aria-controls="logs-panel-logs"
          tabIndex={tab === "logs" ? 0 : -1}
          style={m3TabStyle(tab === "logs")}
          onClick={() => selectTab("logs")}
          onKeyDown={logsTabKeyDown}
        >
          {t("logs.tabLogs")}
        </button>
        <button
          type="button"
          role="tab"
          id="logs-tab-debug"
          aria-selected={tab === "debug"}
          aria-controls="logs-panel-debug"
          tabIndex={tab === "debug" ? 0 : -1}
          style={m3TabStyle(tab === "debug")}
          onClick={() => selectTab("debug")}
          onKeyDown={logsTabKeyDown}
        >
          {t("logs.tabDebug")}
        </button>
      </div>

      {tab === "debug" && (
        <div role="tabpanel" id="logs-panel-debug" aria-labelledby="logs-tab-debug">
          <Debug apiBase={apiBase} embedded />
        </div>
      )}

      {tab === "logs" && (
      <div role="tabpanel" id="logs-panel-logs" aria-labelledby="logs-tab-logs">
      <p className="m3-page-lead" style={{ whiteSpace: "pre-line" }}>
        {t("logs.subtitle")}
      </p>

      {/* One control row per the prototype: search (+ `.*` opt-in and the
          builder shortcut), surface filter, auto-refresh. */}
      <div className="m3-row" style={{ gap: 8, marginBottom: 8 }}>
        <div className="m3-row" role="search" style={{ gap: 6, flex: "1 1 300px", minWidth: 0 }}>
          <IconSearch width={20} height={20} aria-hidden="true" className="muted" />
          <TextInput
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("logs.search")}
            aria-label={t("logs.searchAria")}
            aria-invalid={!!regexError}
            aria-describedby="logs-regex-error"
            style={{ flex: "1 1 auto", width: "auto", minWidth: 0 }}
          />
          {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
          <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
          <a className="m3-icon-btn" href="#regex" title={t("search.openBuilder")} aria-label={t("search.openBuilder")}>
            <IconRegex width={20} height={20} aria-hidden="true" />
          </a>
        </div>
        {/* Filter chips, not a segmented button: the prototype paints the surface
            filter with `chipStyle`, and the segmented pills are spent on the
            Logs/Debug tablist above. The group keeps the accessible name. */}
        <div className="m3-row" role="group" aria-label={t("logs.filter.surface.label")} style={{ gap: 6 }}>
          {(["all", "codex", "claude", "grok"] as const).map(surface => (
            <Chip
              key={surface}
              selected={surfaceFilter === surface}
              onClick={() => setSurfaceFilter(surface)}
            >
              {t(`logs.filter.surface.${surface}`)}
            </Chip>
          ))}
        </div>
        <div className="m3-row" style={{ gap: 8 }}>
          <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)" }}>{t("logs.autoRefresh")}</span>
          <Toggle on={autoRefresh} onChange={setAutoRefresh} label={t("logs.autoRefresh")} />
        </div>
      </div>
      {/* Height is reserved so an invalid pattern does not reflow the table, as
          in the prototype's fixed 20px error line. */}
      <p id="logs-regex-error" role="alert" style={{ minHeight: 20, margin: "0 0 12px", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
        {regexError ? `${t("regex.invalid")}: ${regexError}` : ""}
      </p>

      {/* Conversation id is a second, exact-match filter: the ids are hashed, so
          it cannot ride the substring/regex search above. */}
      <div className="m3-row" style={{ gap: 8, marginBottom: 12 }}>
        <label className="m3-row" style={{ gap: 8, flex: "1 1 300px", minWidth: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)" }}>
          {t("logs.filter.conversation.label")}
          <input
            type="search"
            className="m3-input mono"
            value={conversationFilter}
            onChange={e => setConversationFilter(e.target.value)}
            placeholder={t("logs.filter.conversation.placeholder")}
            aria-label={t("logs.filter.conversation.label")}
            style={{ flex: "1 1 auto", minWidth: 200, maxWidth: 360 }}
          />
        </label>
        {conversationQuery && (
          <Button variant="text" onClick={() => setConversationFilter("")}>
            {t("logs.filter.conversation.clear")}
          </Button>
        )}
      </div>

      {conversationTotals && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="ok">
            {t("logs.conversation.totals", {
              requests: conversationTotals.requests,
              tokens: formatTokens(conversationTotals.totalTokens, localeTag ?? locale),
              cost: formatEstimatedUsdValue(conversationTotals.estimatedCostUsd, localeTag),
            })}
            {" "}
            <span className="muted">
              {t("logs.conversation.scope")}
              {(conversationTotals.unpricedRequests + conversationTotals.unmeteredRequests) > 0
                ? ` ${t("logs.conversation.excluded", {
                  unpriced: conversationTotals.unpricedRequests,
                  unmetered: conversationTotals.unmeteredRequests,
                })}`
                : ""}
            </span>
          </Notice>
        </div>
      )}

      {error ? (
        <Notice tone="err">
          {error}{" "}
          <Button variant="text" onClick={() => void fetchLogs()} disabled={loading}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : loading && logs.length === 0 ? (
        <Empty title={t("common.loading")} />
      ) : filteredLogs.length === 0 ? (
        <Empty title={t(logs.length > 0 && isNarrowed ? "logs.noMatch" : "logs.noRequests")} />
      ) : (
        <div ref={scrollContainerRef} style={TABLE_SHELL}>
          <table className="m3-table logs-table">
            <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--m3-surface-container-lowest)" }}>
             <tr>
               <th scope="col">{t("logs.col.time")}</th>
               <th scope="col">{t("logs.col.request")}</th>
               <th scope="col" className="log-col-model">{t("logs.col.model")}</th>
               <th scope="col">{t("logs.col.provider")}</th>
               <th scope="col">{t("logs.col.status")}</th>
               <th scope="col" className="log-col-tokens">{t("logs.col.tokens")}</th>
                <th scope="col" className="num log-col-rate" style={NUM_CELL} title={t("logs.metric.tokPerSecTitle")}>{t("logs.col.tokPerSec")}</th>
                <th scope="col" className="num log-col-cost" style={NUM_CELL} title={t("logs.metric.estimatedCostTitle")}>{t("logs.col.estimatedCost")}</th>
               <th scope="col"><span className="sr-only">{t("logs.details")}</span></th>
             </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr>
                  <td colSpan={9} style={{ height: paddingTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {virtualRows.map(virtualRow => {
                const log = filteredLogs[filteredLogs.length - 1 - virtualRow.index];
                const reasoningWire = reasoningWireLabel(log);
                return (
               <tr
                 key={log.requestId ?? `${log.timestamp}-${virtualRow.index}`}
                 data-index={virtualRow.index}
                 ref={rowVirtualizer.measureElement}
               >
                 <td className="muted mono" style={{ whiteSpace: "nowrap" }}>{formatLogTimestamp(log.timestamp, localeTag)}</td>
                  <td className="muted mono"><span className="log-reqid" title={log.requestId}>{log.requestId ?? "-"}</span></td>
                 <td className="mono log-col-model" title={modelTitle(log)}>
                   <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>{modelLabel(log.resolvedModel ?? log.model)}</span>
                      {isClaudeSurface(log.surface) && (
                        <span className="m3-chip selected" style={{ minHeight: 24, padding: "0 8px", fontSize: "var(--t-label-s)" }}>
                          {t("logs.badge.claude")}
                        </span>
                      )}
                      {speedLabel(log) && (
                        <span
                          className="m3-chip"
                          style={{ minHeight: 24, padding: "0 8px", fontSize: "var(--t-label-s)", background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)", borderColor: "transparent" }}
                        >
                          {speedLabel(log)}
                        </span>
                      )}
                    </span>
                    {/* Effort rides under the model id in the prototype rather than
                        owning a column; the class still names the reasoning cell. */}
                    <div className="log-reasoning-cell muted text-caption leading-tight" title={reasoningWire}>
                      {effortLabel(log)}{reasoningWire ? ` (${reasoningWire})` : ""}
                    </div>
                  </td>
                  <td style={{ color: "var(--m3-on-surface-variant)" }}>{log.provider}</td>
                  <td>
                    <span style={statusBadgeStyle(log.status)}>{log.status}</span>
                 </td>
                  <td className="mono log-col-tokens" title={tokensTitle(log, t)}>
                    {(() => {
                      const tokenTotal = displayTokenTotal(log);
                      const { read, write } = cacheSplit(log);
                      const hasCacheDetail = (read !== undefined && read > 0) || (write !== undefined && write > 0);
                      // The prototype's Tokens column is an input/output split, not a
                      // single total; the total still lives in the detail dialog. A row
                      // whose usage never arrived keeps the total it does have.
                      const primary = log.usage
                        ? t("logs.tokens.inOut", {
                          in: formatTokens(log.usage.inputTokens, locale),
                          out: formatTokens(log.usage.outputTokens, locale),
                        })
                        : tokenTotal !== undefined ? formatTokens(tokenTotal, locale) : undefined;
                      return primary !== undefined
                        ? (
                            <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                              <span style={{ whiteSpace: "nowrap" }}>{log.usageStatus === "estimated" ? "~" : ""}{primary}</span>
                              {(read !== undefined && read > 0) && (
                                <span className="muted text-caption leading-tight">
                                  c {formatTokens(read, locale)}
                                </span>
                              )}
                              {(write !== undefined && write > 0) && (
                                <span className="muted text-caption leading-tight">
                                  w {formatTokens(write, locale)}
                                </span>
                              )}
                              {/* The prototype always carries a cache line, so a row with no
                                  cache detail says so instead of leaving a silent blank. */}
                              {!hasCacheDetail && (
                                <span className="muted text-caption leading-tight">
                                  {t(isCursorUsageProvider(log.provider) ? "logs.tokens.noCacheCursor" : "logs.tokens.noCache")}
                                </span>
                              )}
                            </span>
                          )
                        : <span className="muted">{t(`logs.tokens.${log.usageStatus ?? "unreported"}`)}</span>;
                    })()}
                  </td>
                  <td className="num mono log-col-rate" style={NUM_CELL}>
                    {formatTokPerSecond(log.displayMetrics?.tokPerSecond, localeTag)}
                  </td>
                  <td className="num mono log-col-cost" style={NUM_CELL}>
                    {formatEstimatedUsd(log.displayMetrics?.cost, localeTag)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="log-detail-btn"
                      style={DETAIL_BTN}
                      onClick={() => setDetail(log)}
                      aria-label={`${t("logs.details")}: ${log.requestId ?? log.status}`}
                    >
                      {t("logs.details")}
                    </button>
                  </td>
                </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr>
                  <td colSpan={9} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <LogDetailDialog
          detail={detail}
          detailInfo={detailInfo}
          localeCode={locale}
          localeTag={localeTag}
          t={t}
          onClose={() => setDetail(null)}
          onFilterConversation={id => {
            setConversationFilter(id);
            setDetail(null);
          }}
        />
      )}
      </div>
      )}
    </>
  );
}

function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return ref;
}

function LogDetailDialog({
  detail, detailInfo, localeCode, localeTag, t, onClose, onFilterConversation,
}: {
  detail: LogEntry;
  detailInfo: ReturnType<typeof statusCodeInfo> | null;
  localeCode: string;
  localeTag?: string;
  t: TFn;
  onClose: () => void;
  onFilterConversation?: (conversationId: string) => void;
}) {
  const dialogRef = useModalDialog(true);
  const [copied, setCopied] = useState(false);
  const tokenSplit = cacheSplit(detail);
  const cost = detail.displayMetrics?.cost;
  const reasoningWire = reasoningWireLabel(detail);

  const copyRequestId = async () => {
    if (!detail.requestId) return;
    try {
      await navigator.clipboard.writeText(detail.requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // copy failure must not break the dialog
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="log-detail-title"
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-card log-detail-card">
        <div className="modal-head">
          <h3 id="log-detail-title">
            <span className="mono" style={{ color: statusColor(detail.status) }}>{detail.status}</span>
            {detailInfo && <span style={{ marginLeft: 8 }}>{detailInfo.label}</span>}
          </h3>
          <Button variant="text" onClick={onClose} aria-label={t("common.cancel")}><IconX aria-hidden="true" /></Button>
        </div>
        {detailInfo && <p className="modal-desc">{detailInfo.description}</p>}

        <section className="log-detail-section" aria-labelledby="log-detail-basic">
          <h4 id="log-detail-basic" className="log-detail-section-title">{t("logs.detail.section.basic")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.col.time")}</span><span className="mono">{formatLogDateTime(detail.timestamp, localeTag)}</span>
            <span className="muted">{t("logs.col.request")}</span>
            <span className="log-detail-request-row">
              <span className="mono log-detail-break">{detail.requestId ?? "\u2014"}</span>
              {detail.requestId && (
                <Button variant="text" onClick={() => void copyRequestId()}>
                  {t(copied ? "logs.detail.copied" : "logs.detail.copyRequestId")}
                </Button>
              )}
            </span>
            {detail.conversationId && (
              <>
                <span className="muted">{t("logs.detail.conversation")}</span>
                <span className="log-detail-request-row">
                  <span className="mono log-detail-break">{detail.conversationId}</span>
                  {onFilterConversation && (
                    <Button variant="text" onClick={() => onFilterConversation(detail.conversationId!)}>
                      {t("logs.filter.conversation.apply")}
                    </Button>
                  )}
                </span>
              </>
            )}
            <span className="muted">{t("logs.col.model")}</span><span className="mono">{modelLabel(detail.resolvedModel ?? detail.model)}</span>
            <span className="muted">{t("logs.col.provider")}</span><span>{detail.provider}</span>
            {(detail.requestedEffort || detail.effectiveEffort) && (
              <><span className="muted">{t("logs.col.effort")}</span><span className="mono">{effortLabel(detail)}{reasoningWire ? ` (${reasoningWire})` : ""}</span></>
            )}
            {detail.errorCode && (<><span className="muted">{t("logs.col.error")}</span><span className="mono">{detail.errorCode}</span></>)}
            {detail.upstreamError && (<><span className="muted">{t("logs.col.upstreamReason")}</span><span className="mono log-detail-break">{detail.upstreamError}</span></>)}
          </div>
        </section>

        <section className="log-detail-section" aria-labelledby="log-detail-performance">
          <h4 id="log-detail-performance" className="log-detail-section-title">{t("logs.detail.section.performance")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.col.duration")}</span><span className="mono">{detail.durationMs}ms</span>
            <span className="muted">{t("logs.col.tokPerSec")}</span><span className="mono">{formatTokPerSecond(detail.displayMetrics?.tokPerSecond, localeTag)}</span>
            {detail.firstOutputMs !== undefined && (
              <><span className="muted">{t("logs.detail.ttft")}</span><span className="mono">{detail.firstOutputMs}ms</span></>
            )}
          </div>
          {detail.displayMetrics?.tokPerSecond.kind === "unavailable" && (
            <p className="log-detail-notes-line muted">{t(metricReasonKey(detail.displayMetrics.tokPerSecond.reason))}</p>
          )}
        </section>

        <section className="log-detail-section" aria-labelledby="log-detail-cost">
          <h4 id="log-detail-cost" className="log-detail-section-title">{t("logs.detail.section.cost")}</h4>
          <p className="log-detail-notes-line muted">{t("usage.cost.disclaimer")}</p>
          {cost?.kind === "value" ? (
            <>
              <div className="log-detail-grid">
                <span className="muted">{t("logs.detail.costTotal")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.total, localeTag)}</span>
                <span className="muted">{t("logs.tokens.input")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.input, localeTag)}</span>
                <span className="muted">{t("logs.tokens.cacheRead")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheRead, localeTag)}</span>
                <span className="muted">{t("logs.tokens.cacheWrite")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheWrite, localeTag)}</span>
                <span className="muted">{t("logs.tokens.output")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.output, localeTag)}</span>
                {cost.estimate.price && (
                  <>
                    <span className="muted">{t("logs.detail.matchedKey")}</span>
                    <span className="mono log-detail-break">{cost.estimate.price.jawcodeProvider ?? cost.estimate.price.provider}/{cost.estimate.price.modelId}</span>
                    <span className="muted">{t("logs.detail.priceSource")}</span>
                    <span>{t(`logs.detail.source.${cost.estimate.price.source}`)} · {t(verificationKey(cost.estimate.price.status))}</span>
                  </>
                )}
              </div>
              {cost.estimateReasons.length > 0 && (
                <ul className="log-detail-notes">
                  {cost.estimateReasons.map(reason => <li key={reason}>{t(estimateReasonKey(reason))}</li>)}
                </ul>
              )}
            </>
          ) : (
            <div className="log-detail-grid">
              <span className="muted">{t("logs.detail.costTotal")}</span><span className="mono">{"\u2014"}</span>
              <span className="muted">{t("logs.detail.unavailableReason")}</span>
              <span>{cost?.kind === "unavailable" ? t(metricReasonKey(cost.reason)) : t("logs.detail.reason.usage_missing")}</span>
            </div>
          )}
        </section>

        {detail.attempts?.length ? (
          <section className="log-detail-section" aria-labelledby="log-detail-attempts">
            <h4 id="log-detail-attempts" className="log-detail-section-title">{t("logs.detail.section.attempts")}</h4>
            <p className="log-detail-notes-line muted">{t("logs.detail.attempt.e2eNote")}</p>
            <div className="log-detail-attempts-wrap">
              <table className="m3-table log-detail-attempts">
                <thead><tr>
                  <th scope="col" className="num" style={NUM_CELL}>#</th>
                  <th scope="col">{t("logs.detail.attempt.target")}</th>
                  <th scope="col" className="num" style={NUM_CELL}>{t("logs.col.duration")}</th>
                  <th scope="col" className="num" style={NUM_CELL}>{t("logs.col.tokPerSec")}</th>
                  <th scope="col" className="num" style={NUM_CELL}>{t("logs.col.estimatedCost")}</th>
                  <th scope="col">{t("logs.detail.attempt.reason")}</th>
                </tr></thead>
                <tbody>{detail.attempts.toSorted((a, b) => a.ordinal - b.ordinal).map(attempt => {
                  const attemptCost = attempt.displayMetrics?.cost;
                  const attemptReasoningWire = reasoningWireLabel(attempt);
                  const matched = attemptCost?.kind === "value" ? attemptCost.estimate.price : undefined;
                  const reason = attempt.errorCode
                    ?? (attempt.recoveryKinds.length ? attempt.recoveryKinds.join(", ") : undefined)
                    ?? (attemptCost?.kind === "unavailable" ? t(metricReasonKey(attemptCost.reason)) : t("logs.detail.attempt.completed"));
                  return (
                    <tr key={`${attempt.ordinal}-${attempt.provider}-${attempt.model}`}>
                      <td className="num mono" style={NUM_CELL}>{attempt.ordinal}</td>
                      <td>
                        <span>{attempt.provider}</span><br />
                        <span className="mono muted log-detail-break">{attempt.model}</span>
                        {(attempt.requestedEffort || attempt.effectiveEffort) && (
                          <>
                            <br />
                            <span className="mono muted text-caption log-detail-break">
                              {effortLabel(attempt)}{attemptReasoningWire ? ` (${attemptReasoningWire})` : ""}
                            </span>
                          </>
                        )}
                        {matched && (
                          <>
                            <br />
                            <span className="muted text-caption log-detail-break">
                              {matched.jawcodeProvider ?? matched.provider}/{matched.modelId} · {t(`logs.detail.source.${matched.source}`)} · {t(verificationKey(matched.status))}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="num mono" style={NUM_CELL}>{attempt.durationMs}ms</td>
                      <td className="num mono" style={NUM_CELL}>{formatTokPerSecond(attempt.displayMetrics?.tokPerSecond, localeTag)}</td>
                      <td className="num mono" style={NUM_CELL}>{formatEstimatedUsd(attemptCost, localeTag)}</td>
                      <td className="log-detail-break">{reason}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="log-detail-section" aria-labelledby="log-detail-usage">
          <h4 id="log-detail-usage" className="log-detail-section-title">{t("logs.detail.section.usage")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.tokens.input")}</span><span className="mono">{detail.usage ? formatTokens(detail.usage.inputTokens, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.output")}</span><span className="mono">{detail.usage ? formatTokens(detail.usage.outputTokens, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.cacheRead")}</span><span className="mono">{tokenSplit.read !== undefined ? formatTokens(tokenSplit.read, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.cacheWrite")}</span><span className="mono">{tokenSplit.write !== undefined ? formatTokens(tokenSplit.write, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.reasoning")}</span><span className="mono">{detail.usage?.reasoningOutputTokens !== undefined ? formatTokens(detail.usage.reasoningOutputTokens, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.detail.totalTokens")}</span><span className="mono">{displayTokenTotal(detail) !== undefined ? formatTokens(displayTokenTotal(detail)!, localeCode) : "\u2014"}</span>
          </div>
          {detail.usageStatus === "estimated" && (
            <p className="log-detail-notes-line muted">{t("logs.tokens.estimatedNote")}</p>
          )}
        </section>

        <details className="log-detail-raw">
          <summary>{t("logs.detailRaw")}</summary>
          <pre className="log-detail-json">{JSON.stringify(detail, null, 2)}</pre>
        </details>
      </div>
    </dialog>
  );
}
