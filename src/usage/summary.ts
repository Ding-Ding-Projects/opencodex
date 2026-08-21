import { baseProviderLabel } from "../providers/label";
import { canonicalAntigravityUsageModel } from "../providers/antigravity-models";
import { usageDisplayTotalTokens } from "./totals";
import type { PersistedUsageEntry, UsageStatus } from "./log";
import { classifyUsageForCost, comboPricingUnavailableReason, comboUsageUnavailableReason, estimateComboCost, estimateRequestCost, estimateRequestCostLanes, effectiveServiceTier, pricingLaneUnavailableReason, pricingSourceClassification, pricingUnavailableReason, type UsageCostUnavailableReason } from "./cost";
import type { PricingUnavailableReason } from "./expected-prices";

export type UsageRange = "7d" | "30d" | "all";
export type UsageSurface = "all" | "codex" | "claude" | "grok";

export interface PricingLaneTotals {
  /** Sum for this lane only. `api_equivalent` is explicitly non-billing. */
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  unpricedReasons: Partial<Record<PricingUnavailableReason | UsageCostUnavailableReason, number>>;
  /** Per provider/model rows make each lane's source classification inspectable. */
  sources: PricingLaneSource[];
}

export interface PricingLaneSource {
  provider: string;
  model: string;
  sourceClassification: "direct_api_key" | "subscription_api_equivalent";
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  estimatedCostUsd: number;
  unpricedReasons: Partial<Record<PricingUnavailableReason | UsageCostUnavailableReason, number>>;
}

export interface UsageSummaryTotals {
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  /** Display-time estimated cost in USD for the filtered window (WP6, devlog 004).
   *  Sums per-request estimateRequestCost / per-attempt combo costs; requests whose
   *  price is unmatched are excluded from the sum and counted separately. */
  estimatedCostUsd: number;
  pricedRequests: number;
  /** Requests with usage but no matched price anywhere (excluded from the sum). */
  unpricedRequests: number;
  /** Machine-readable exact-price failure counts for the filtered window. */
  unpricedReasons: Partial<Record<PricingUnavailableReason | UsageCostUnavailableReason, number>>;
  /** Strict direct API-key actual list-price accounting only. */
  direct: PricingLaneTotals;
  /** Explicit non-billing API-equivalent accounting for supported subscription/OAuth rows. */
  apiEquivalent: PricingLaneTotals;
  /** Requests whose usage itself is missing/unsupported, so no cost can be computed. */
  unmeteredRequests: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  attemptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number;
  cacheCoverage?: "complete" | "partial" | "unknown";
  totalTokens: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number;
  cacheCoverage?: "complete" | "partial" | "unknown";
  shareRatio: number;
  /** Direct API-key spend only, unchanged. Absent for subscription/OAuth rows. */
  estimatedCostUsd?: number;
  /**
   * Explicitly non-billing API-equivalent total for subscription/OAuth rows, so a
   * per-model breakdown can show a figure instead of an em dash. Kept as its own
   * field rather than folded into `estimatedCostUsd` because the two are
   * different kinds of number and must never be summed into one.
   */
  apiEquivalentCostUsd?: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
  costCoverage: "priced" | "partial" | "unknown";
}

export interface UsageProvider {
  provider: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  /**
   * Requests whose token counts were estimated rather than reported, matching
   * `UsageModel.estimatedRequests`. `buildProviders` has always written and
   * incremented this, and the GUI's provider rows read it, so it is part of the
   * shape rather than optional detail — it was dropped from this interface by
   * accident when the API-equivalent cost fields were added directly beneath it.
   */
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheHitRate?: number;
  cacheCoverage?: "complete" | "partial" | "unknown";
  shareRatio: number;
  /** Direct API-key spend only, unchanged. Absent for subscription/OAuth rows. */
  estimatedCostUsd?: number;
  /** Non-billing API-equivalent total; see `UsageModel.apiEquivalentCostUsd`. */
  apiEquivalentCostUsd?: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
  costCoverage: "priced" | "partial" | "unknown";
}

export interface UsageSummary {
  range: UsageRange;
  surface: UsageSurface;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
}

const DAY_MS = 86_400_000;

export function parseRange(input: string | null | undefined): UsageRange {
  if (input === "7d" || input === "30d" || input === "all") return input;
  return "30d";
}

export function parseUsageSurface(input: string | null | undefined): UsageSurface {
  if (input === "codex" || input === "claude" || input === "grok") return input;
  return "all";
}

function rangeWindow(range: UsageRange, now: number): { since: number | null; days: number } {
  if (range === "7d") return { since: now - 7 * DAY_MS, days: 7 };
  if (range === "30d") return { since: now - 30 * DAY_MS, days: 30 };
  return { since: null, days: 0 };
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayCountForAllRange(entries: PersistedUsageEntry[], now: number): number {
  if (entries.length === 0) return 1;
  const oldest = entries.reduce((min, e) => Math.min(min, e.timestamp), entries[0].timestamp);
  const days = Math.ceil((now - oldest) / DAY_MS) + 1;
  return Math.max(1, days);
}

function emptyPricingLaneTotals(): PricingLaneTotals {
  return {
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    unpricedReasons: {},
    sources: [],
  };
}

export function emptyUsageSummaryTotals(): UsageSummaryTotals {
  return {
    requests: 0,
    attemptCount: 0,
    measuredRequests: 0,
    reportedRequests: 0,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    coverageRatio: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    unpricedReasons: {},
    direct: emptyPricingLaneTotals(),
    apiEquivalent: emptyPricingLaneTotals(),
    unmeteredRequests: 0,
  };
}

function isMeasuredStatus(status: UsageStatus): boolean {
  return status === "reported" || status === "estimated";
}

interface UsageAttribution {
  requestId: string;
  provider: string;
  model: string;
  resolvedModel?: string;
  usageStatus: UsageStatus;
  usage?: PersistedUsageEntry["usage"];
  totalTokens?: number;
}


/**
 * Usage row identity for model breakdowns.
 * Google Antigravity collapses wire/compat/suffix ids to picker/call base models so
 * historical effort-variant logs merge with current base-model invocations.
 */
function usageModelIdentity(
  provider: string,
  model: string,
  resolvedModel?: string,
): { model: string; resolvedModel?: string } {
  if (baseProviderLabel(provider) !== "google-antigravity") {
    return resolvedModel ? { model, resolvedModel } : { model };
  }
  const fromModel = canonicalAntigravityUsageModel(model);
  const fromResolved = resolvedModel
    ? canonicalAntigravityUsageModel(resolvedModel)
    : undefined;
  // Prefer an explicit base mapping from model; if model is unknown but resolved maps
  // to a known base, use that (covers base call + upstream wire resolvedModel pairs).
  const canonical = fromModel !== model
    ? fromModel
    : (fromResolved && fromResolved !== resolvedModel ? fromResolved : fromModel);
  return { model: canonical };
}

function usageModelKey(providerKey: string, model: string): string {
  return `${providerKey}/${model}`;
}

function cacheParts(usage: PersistedUsageEntry["usage"] | undefined): {
  read?: number;
  write?: number;
  complete: boolean;
} {
  if (!usage) return { complete: false };
  const write = typeof usage.cacheCreationInputTokens === "number" ? usage.cacheCreationInputTokens : undefined;
  const read = typeof usage.cacheReadInputTokens === "number"
    ? usage.cacheReadInputTokens
    : typeof usage.cachedInputTokens === "number" && write !== undefined
      ? Math.max(0, usage.cachedInputTokens - write)
      : usage.cachedInputTokens;
  return { ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}), complete: read !== undefined && write !== undefined };
}

function setCacheCoverage(target: { cacheCoverage?: "complete" | "partial" | "unknown" }, usage: PersistedUsageEntry["usage"] | undefined): { read?: number; write?: number } {
  const parts = cacheParts(usage);
  if (!usage || (parts.read === undefined && parts.write === undefined)) {
    if (target.cacheCoverage === "complete") target.cacheCoverage = "partial";
    return parts;
  }
  if (parts.read !== undefined || parts.write !== undefined) {
    target.cacheCoverage = target.cacheCoverage === undefined && parts.complete ? "complete" : "partial";
  }
  return parts;
}

function antigravityUsageModel(provider: string, model: string): string {
  if (baseProviderLabel(provider) !== "google-antigravity") return model;
  return canonicalAntigravityUsageModel(model);
}

function usageAttributions(entry: PersistedUsageEntry): UsageAttribution[] {
  if (!entry.attempts?.length) {
    return [{
      requestId: entry.requestId,
      provider: entry.provider,
      ...usageModelIdentity(entry.provider, entry.model, entry.resolvedModel),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    }];
  }
  return entry.attempts.map(attempt => ({
    requestId: entry.requestId,
    provider: attempt.provider,
    ...usageModelIdentity(attempt.provider, attempt.model),
    usageStatus: attempt.usageStatus,
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
  }));
}

function foldAttributionStatuses(statuses: readonly UsageStatus[]): UsageStatus {
  if (statuses.length > 0 && statuses.every(status => status === "unsupported")) {
    return "unsupported";
  }
  if (statuses.some(status => status === "unreported" || status === "unsupported")) {
    return "unreported";
  }
  if (statuses.some(status => status === "estimated")) return "estimated";
  return statuses.length > 0 ? "reported" : "unreported";
}

function bumpStatus(totals: UsageSummaryTotals, status: UsageStatus): void {
  totals.requests += 1;
  if (isMeasuredStatus(status)) totals.measuredRequests += 1;
  if (status === "reported") totals.reportedRequests += 1;
  else if (status === "unreported") totals.unreportedRequests += 1;
  else if (status === "unsupported") totals.unsupportedRequests += 1;
  else if (status === "estimated") totals.estimatedRequests += 1;
}

function addTokens(
  totals: UsageSummaryTotals,
  entry: Pick<PersistedUsageEntry, "usage" | "totalTokens">,
): void {
  if (!entry.usage) return;
  totals.inputTokens += entry.usage.inputTokens;
  totals.outputTokens += entry.usage.outputTokens;
  // Prefer the explicit read/write split; legacy claude-route rows stored read+write
  // combined in cachedInputTokens with only the creation split present (devlog 070),
  // so recover reads by subtracting the write share for those rows.
  const creation = entry.usage.cacheCreationInputTokens;
  const read = typeof entry.usage.cacheReadInputTokens === "number"
    ? entry.usage.cacheReadInputTokens
    : typeof entry.usage.cachedInputTokens === "number" && typeof creation === "number"
      ? Math.max(0, entry.usage.cachedInputTokens - creation)
      : entry.usage.cachedInputTokens;
  if (typeof read === "number") {
    totals.cachedInputTokens += read;
    totals.cacheReadInputTokens += read;
  }
  if (typeof creation === "number") totals.cacheCreationInputTokens += creation;
  if (typeof entry.usage.reasoningOutputTokens === "number") totals.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
  totals.totalTokens += usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
}

function finalizeCoverage(totals: UsageSummaryTotals): void {
  totals.coverageRatio = totals.requests === 0 ? 0 : totals.measuredRequests / totals.requests;
}

function addLaneReason(
  lane: PricingLaneTotals,
  source: PricingLaneSource,
  reason: PricingUnavailableReason | UsageCostUnavailableReason,
): void {
  lane.unpricedReasons[reason] = (lane.unpricedReasons[reason] ?? 0) + 1;
  source.unpricedReasons[reason] = (source.unpricedReasons[reason] ?? 0) + 1;
}

function laneSource(
  lane: PricingLaneTotals,
  provider: string,
  model: string,
  sourceClassification: PricingLaneSource["sourceClassification"],
): PricingLaneSource {
  const existing = lane.sources.find(row => (
    row.provider === provider && row.model === model && row.sourceClassification === sourceClassification
  ));
  if (existing) return existing;
  const created: PricingLaneSource = {
    provider,
    model,
    sourceClassification,
    requests: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    estimatedCostUsd: 0,
    unpricedReasons: {},
  };
  lane.sources.push(created);
  return created;
}

function addEstimatedCost(
  totals: UsageSummaryTotals,
  entry: Pick<PersistedUsageEntry, "timestamp" | "provider" | "model" | "usageStatus" | "usage" | "attempts" | "responseServiceTier" | "requestedServiceTier" | "configuredServiceTier" | "cacheRetention" | "promptInputTokens">,
): void {
  const comboUsageReason = entry.attempts?.length
    ? comboUsageUnavailableReason(entry.attempts)
    : undefined;
  const singleUsage = entry.attempts?.length
    ? undefined
    : classifyUsageForCost(entry.usage, entry.usageStatus);
  const usageReason = comboUsageReason
    ?? (singleUsage?.kind === "unavailable" ? singleUsage.reason : undefined);
  if (usageReason === "usage_missing" || usageReason === "usage_unsupported") {
    totals.unmeteredRequests += 1;
    return;
  }
  if (usageReason) {
    totals.unpricedRequests += 1;
    totals.unpricedReasons[usageReason] = (totals.unpricedReasons[usageReason] ?? 0) + 1;
    return;
  }
  const context = {
    serviceTier: effectiveServiceTier(entry),
    cacheRetention: entry.cacheRetention,
    promptInputTokens: entry.promptInputTokens,
    timestamp: entry.timestamp,
  };

  // Preserve the old aggregate fields as the strict direct actual-list-price lane.
  // Combo rows remain all-or-nothing for that legacy projection.
  const estimate = entry.attempts?.length
    ? estimateComboCost(entry.attempts, undefined, context)
    : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, ...context });
  if (!estimate) {
    totals.unpricedRequests += 1;
    const reason = entry.attempts?.length
      ? comboPricingUnavailableReason(entry.attempts, context)
      : pricingUnavailableReason({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, ...context });
    const exactReason = reason ?? "price_unmatched";
    totals.unpricedReasons[exactReason] = (totals.unpricedReasons[exactReason] ?? 0) + 1;
  } else {
    totals.pricedRequests += 1;
    totals.estimatedCostUsd += estimate.cost.total;
  }

  const addOne = (provider: string, model: string, usage: PersistedUsageEntry["usage"], usageStatus: UsageStatus, promptInputTokens: number | undefined, timestamp: number | undefined, cacheRetention: PersistedUsageEntry["cacheRetention"]): void => {
    const source = pricingSourceClassification(provider);
    if (!source) return;
    const lane = source.lane === "direct" ? totals.direct : totals.apiEquivalent;
    const row = laneSource(lane, provider, model, source.sourceClassification);
    row.requests += 1;
    const laneEstimate = estimateRequestCostLanes({
      provider,
      model,
      usage,
      usageStatus,
      serviceTier: context.serviceTier,
      cacheRetention,
      promptInputTokens,
      timestamp,
    })[source.lane === "direct" ? "direct" : "apiEquivalent"];
    if (laneEstimate) {
      lane.pricedRequests += 1;
      lane.estimatedCostUsd += laneEstimate.cost.total;
      row.pricedRequests += 1;
      row.estimatedCostUsd += laneEstimate.cost.total;
      return;
    }
    lane.unpricedRequests += 1;
    row.unpricedRequests += 1;
    const reason = pricingLaneUnavailableReason(source.lane, {
      provider,
      model,
      usage,
      usageStatus,
      serviceTier: context.serviceTier,
      cacheRetention,
      promptInputTokens,
      timestamp,
    }) ?? "price_unmatched";
    addLaneReason(lane, row, reason);
  };

  if (entry.attempts?.length) {
    for (const attempt of entry.attempts) {
      addOne(
        attempt.provider,
        attempt.model,
        attempt.usage,
        attempt.usageStatus,
        attempt.promptInputTokens ?? entry.promptInputTokens,
        attempt.timestamp ?? entry.timestamp,
        attempt.cacheRetention ?? entry.cacheRetention,
      );
    }
  } else {
    addOne(
      entry.provider,
      entry.model,
      entry.usage,
      entry.usageStatus,
      entry.promptInputTokens,
      entry.timestamp,
      entry.cacheRetention,
    );
  }
}

function buildDayGrid(range: UsageRange, since: number | null, now: number, entries: PersistedUsageEntry[]): UsageDay[] {
  const window = rangeWindow(range, now);
  const days = range === "all" ? dayCountForAllRange(entries, now) : window.days;
  const grid = new Map<string, UsageDay>();
  // Per-day model breakdown accumulator, keyed by day then provider/model, so the 7d bar chart can
  // render a per-model stacked bar with a hover tooltip without a second pass over the entries.
  const dayModels = new Map<string, Map<string, UsageDayModel>>();
  const dayModelRequests = new Map<string, Set<string>>();
  const bumpDayModel = (dayKey: string, attribution: UsageAttribution): void => {
    let models = dayModels.get(dayKey);
    if (!models) { models = new Map(); dayModels.set(dayKey, models); }
    const providerKey = baseProviderLabel(attribution.provider);
    const mKey = usageModelKey(providerKey, attribution.model);
    let m = models.get(mKey);
    if (!m) {
      m = {
        model: attribution.model,
        provider: providerKey,
        requests: 0,
        attemptCount: 0,
        totalTokens: 0,
      };
      models.set(mKey, m);
    }
    const requestKey = `${dayKey}\0${mKey}`;
    let requests = dayModelRequests.get(requestKey);
    if (!requests) { requests = new Set(); dayModelRequests.set(requestKey, requests); }
    requests.add(attribution.requestId);
    m.requests = requests.size;
    m.attemptCount += 1;
    if (attribution.usage) {
      const cache = setCacheCoverage(m, attribution.usage);
      if (cache.read !== undefined || cache.write !== undefined) {
        m.inputTokens = (m.inputTokens ?? 0) + attribution.usage.inputTokens;
        m.outputTokens = (m.outputTokens ?? 0) + attribution.usage.outputTokens;
        if (cache.read !== undefined) m.cacheReadInputTokens = (m.cacheReadInputTokens ?? 0) + cache.read;
        if (cache.write !== undefined) m.cacheCreationInputTokens = (m.cacheCreationInputTokens ?? 0) + cache.write;
      }
    }
    m.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
  };
  for (let i = days - 1; i >= 0; i--) {
    const key = localDateKey(now - i * DAY_MS);
    grid.set(key, { date: key, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, models: [] });
  }
  for (const entry of entries) {
    const key = localDateKey(entry.timestamp);
    let day = grid.get(key);
    if (!day) {
      day = { date: key, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, models: [] };
      grid.set(key, day);
    }
    day.requests += 1;
    if (isMeasuredStatus(entry.usageStatus)) day.measuredRequests += 1;
    if (entry.usageStatus === "reported") day.reportedRequests += 1;
    day.totalTokens += usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
    for (const attribution of usageAttributions(entry)) bumpDayModel(key, attribution);
  }
  void since;
  const out = [...grid.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of out) {
    const models = dayModels.get(day.date);
    if (models) {
      day.models = [...models.values()].sort((a, b) => b.requests - a.requests);
      for (const model of day.models) {
        if (model.cacheReadInputTokens !== undefined && model.inputTokens > 0) {
          model.cacheHitRate = model.cacheReadInputTokens / model.inputTokens;
        }
      }
    }
  }
  return out;
}

function buildModels(entries: PersistedUsageEntry[], totalTokens: number): UsageModel[] {
  const byKey = new Map<string, UsageModel>();
  const statusesByKey = new Map<string, Map<string, UsageStatus[]>>();
  for (const entry of entries) {
    for (const attribution of usageAttributions(entry)) {
      const providerKey = baseProviderLabel(attribution.provider);
      // resolvedModel is a routing detail, not a row identity.
      const key = usageModelKey(providerKey, attribution.model);
      let model = byKey.get(key);
      if (!model) {
        model = {
          provider: providerKey,
          model: attribution.model,
          ...(attribution.resolvedModel ? { resolvedModel: attribution.resolvedModel } : {}),
          requests: 0,
          attemptCount: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          estimatedRequests: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCoverage: "unknown",
          shareRatio: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          unmeteredRequests: 0,
          costCoverage: "unknown",
        };
        byKey.set(key, model);
      }
      model.attemptCount += 1;
      let requests = statusesByKey.get(key);
      if (!requests) { requests = new Map(); statusesByKey.set(key, requests); }
      const statuses = requests.get(attribution.requestId) ?? [];
      statuses.push(attribution.usageStatus);
      requests.set(attribution.requestId, statuses);
      if (attribution.usage) {
        model.inputTokens += attribution.usage.inputTokens;
        model.outputTokens += attribution.usage.outputTokens;
        const cache = setCacheCoverage(model, attribution.usage);
        if (cache.read !== undefined) model.cacheReadInputTokens = (model.cacheReadInputTokens ?? 0) + cache.read;
        if (cache.write !== undefined) model.cacheCreationInputTokens = (model.cacheCreationInputTokens ?? 0) + cache.write;
        model.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
      }
    }
  }
  for (const [key, model] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
    model.requests = groups.size;
    for (const statuses of groups.values()) {
      const status = foldAttributionStatuses(statuses);
      if (isMeasuredStatus(status)) model.measuredRequests += 1;
      if (status === "reported") model.reportedRequests += 1;
      else if (status === "estimated") model.estimatedRequests += 1;
    }
  }
  // Coverage is counted per attributable provider/model request, not from the
  // aggregate dollar total, so an unknown row can never masquerade as $0.
  for (const entry of entries) {
    const context = { serviceTier: effectiveServiceTier(entry), cacheRetention: entry.cacheRetention, timestamp: entry.timestamp };
    for (const attribution of usageAttributions(entry)) {
      const key = usageModelKey(baseProviderLabel(attribution.provider), attribution.model);
      const model = byKey.get(key);
      if (!model) continue;
      const estimate = estimateRequestCost({
        provider: attribution.provider,
        model: attribution.model,
        usage: attribution.usage,
        usageStatus: attribution.usageStatus,
        ...context,
      });
      if (estimate) model.pricedRequests += 1;
      else if (!attribution.usage || attribution.usageStatus === "unreported" || attribution.usageStatus === "unsupported") model.unmeteredRequests += 1;
      else model.unpricedRequests += 1;
    }
  }
  // Accumulate per-model estimated cost
  for (const entry of entries) {
    const context = {
      serviceTier: effectiveServiceTier(entry),
      cacheRetention: entry.cacheRetention,
      timestamp: entry.timestamp,
    };
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts, undefined, context)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, ...context });
    if (!estimate) continue;

    if (entry.attempts?.length && estimate.attempts) {
      // Combo: attribute each attempt's cost to its own model
      for (const attemptEst of estimate.attempts) {
        const aProviderKey = baseProviderLabel(attemptEst.provider);
        const aKey = usageModelKey(aProviderKey, antigravityUsageModel(attemptEst.provider, attemptEst.model));
        const m = byKey.get(aKey);
        if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + attemptEst.cost.total;
      }
    } else {
      // Single-target: attribute to the entry's model
      const providerKey = baseProviderLabel(entry.provider);
      const key = usageModelKey(providerKey, antigravityUsageModel(entry.provider, entry.model));
      const m = byKey.get(key);
      if (m) m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + estimate.cost.total;
    }
  }
  // Second pass for the non-billing lane. Deliberately separate from the loop
  // above rather than merged into it: that one is the direct lane and its field
  // keeps its existing meaning exactly, so a subscription row gains a figure
  // without a billable row's number moving by a cent.
  for (const entry of entries) {
    const serviceTier = effectiveServiceTier(entry);
    const attributions = entry.attempts?.length
      ? entry.attempts.map(attempt => ({
        provider: attempt.provider,
        model: attempt.model,
        usage: attempt.usage,
        usageStatus: attempt.usageStatus,
        promptInputTokens: attempt.promptInputTokens ?? entry.promptInputTokens,
        cacheRetention: attempt.cacheRetention ?? entry.cacheRetention,
        timestamp: attempt.timestamp ?? entry.timestamp,
      }))
      : [{
        provider: entry.provider,
        model: entry.model,
        usage: entry.usage,
        usageStatus: entry.usageStatus,
        promptInputTokens: entry.promptInputTokens,
        cacheRetention: entry.cacheRetention,
        timestamp: entry.timestamp,
      }];
    for (const row of attributions) {
      const laneEstimate = estimateRequestCostLanes({ ...row, serviceTier }).apiEquivalent;
      if (!laneEstimate) continue;
      const key = usageModelKey(baseProviderLabel(row.provider), antigravityUsageModel(row.provider, row.model));
      const m = byKey.get(key);
      if (m) m.apiEquivalentCostUsd = (m.apiEquivalentCostUsd ?? 0) + laneEstimate.cost.total;
    }
  }
  const models = [...byKey.values()];
  for (const m of models) {
    m.shareRatio = totalTokens === 0 ? 0 : m.totalTokens / totalTokens;
    if (m.cacheReadInputTokens !== undefined && m.inputTokens > 0) m.cacheHitRate = m.cacheReadInputTokens / m.inputTokens;
    const accounted = m.pricedRequests + m.unpricedRequests + m.unmeteredRequests;
    m.costCoverage = accounted === 0 || m.pricedRequests === 0
      ? "unknown"
      : m.unpricedRequests + m.unmeteredRequests > 0 ? "partial" : "priced";
  }
  return models.sort((a, b) => b.requests - a.requests);
}

function buildProviders(entries: PersistedUsageEntry[], totalTokens: number): UsageProvider[] {
  const byKey = new Map<string, UsageProvider>();
  const statusesByKey = new Map<string, Map<string, UsageStatus[]>>();
  for (const entry of entries) {
    for (const attribution of usageAttributions(entry)) {
      const providerKey = baseProviderLabel(attribution.provider);
      let provider = byKey.get(providerKey);
      if (!provider) {
        provider = {
          provider: providerKey,
          requests: 0,
          attemptCount: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          estimatedRequests: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCoverage: "unknown",
          shareRatio: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          unmeteredRequests: 0,
          costCoverage: "unknown",
        };
        byKey.set(providerKey, provider);
      }
      provider.attemptCount += 1;
      let requests = statusesByKey.get(providerKey);
      if (!requests) { requests = new Map(); statusesByKey.set(providerKey, requests); }
      const statuses = requests.get(attribution.requestId) ?? [];
      statuses.push(attribution.usageStatus);
      requests.set(attribution.requestId, statuses);
      if (attribution.usage) {
        provider.inputTokens += attribution.usage.inputTokens;
        provider.outputTokens += attribution.usage.outputTokens;
        const cache = setCacheCoverage(provider, attribution.usage);
        if (cache.read !== undefined) provider.cacheReadInputTokens = (provider.cacheReadInputTokens ?? 0) + cache.read;
        if (cache.write !== undefined) provider.cacheCreationInputTokens = (provider.cacheCreationInputTokens ?? 0) + cache.write;
        provider.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
      }
    }
  }
  for (const [key, provider] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
    provider.requests = groups.size;
    for (const statuses of groups.values()) {
      const status = foldAttributionStatuses(statuses);
      if (isMeasuredStatus(status)) provider.measuredRequests += 1;
      if (status === "reported") provider.reportedRequests += 1;
      else if (status === "estimated") provider.estimatedRequests += 1;
    }
  }
  for (const entry of entries) {
    const context = { serviceTier: effectiveServiceTier(entry), cacheRetention: entry.cacheRetention, timestamp: entry.timestamp };
    for (const attribution of usageAttributions(entry)) {
      const provider = byKey.get(baseProviderLabel(attribution.provider));
      if (!provider) continue;
      const estimate = estimateRequestCost({ provider: attribution.provider, model: attribution.model, usage: attribution.usage, usageStatus: attribution.usageStatus, ...context });
      if (estimate) provider.pricedRequests += 1;
      else if (!attribution.usage || attribution.usageStatus === "unreported" || attribution.usageStatus === "unsupported") provider.unmeteredRequests += 1;
      else provider.unpricedRequests += 1;
    }
  }
  for (const entry of entries) {
    const context = {
      serviceTier: effectiveServiceTier(entry),
      cacheRetention: entry.cacheRetention,
      timestamp: entry.timestamp,
    };
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts, undefined, context)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, ...context });
    if (!estimate) continue;

    if (entry.attempts?.length && estimate.attempts) {
      for (const attemptEst of estimate.attempts) {
        const aProviderKey = baseProviderLabel(attemptEst.provider);
        const p = byKey.get(aProviderKey);
        if (p) p.estimatedCostUsd = (p.estimatedCostUsd ?? 0) + attemptEst.cost.total;
      }
    } else {
      const providerKey = baseProviderLabel(entry.provider);
      const p = byKey.get(providerKey);
      if (p) p.estimatedCostUsd = (p.estimatedCostUsd ?? 0) + estimate.cost.total;
    }
  }
  // Non-billing lane, kept in its own pass for the same reason as the model
  // rollup above: the direct field's meaning must not shift.
  for (const entry of entries) {
    const serviceTier = effectiveServiceTier(entry);
    const attributions = entry.attempts?.length
      ? entry.attempts.map(attempt => ({
        provider: attempt.provider,
        model: attempt.model,
        usage: attempt.usage,
        usageStatus: attempt.usageStatus,
        promptInputTokens: attempt.promptInputTokens ?? entry.promptInputTokens,
        cacheRetention: attempt.cacheRetention ?? entry.cacheRetention,
        timestamp: attempt.timestamp ?? entry.timestamp,
      }))
      : [{
        provider: entry.provider,
        model: entry.model,
        usage: entry.usage,
        usageStatus: entry.usageStatus,
        promptInputTokens: entry.promptInputTokens,
        cacheRetention: entry.cacheRetention,
        timestamp: entry.timestamp,
      }];
    for (const row of attributions) {
      const laneEstimate = estimateRequestCostLanes({ ...row, serviceTier }).apiEquivalent;
      if (!laneEstimate) continue;
      const p = byKey.get(baseProviderLabel(row.provider));
      if (p) p.apiEquivalentCostUsd = (p.apiEquivalentCostUsd ?? 0) + laneEstimate.cost.total;
    }
  }
  const providers = [...byKey.values()];
  for (const p of providers) {
    p.shareRatio = totalTokens === 0 ? 0 : p.totalTokens / totalTokens;
    if (p.cacheReadInputTokens !== undefined && p.inputTokens > 0) p.cacheHitRate = p.cacheReadInputTokens / p.inputTokens;
    const accounted = p.pricedRequests + p.unpricedRequests + p.unmeteredRequests;
    p.costCoverage = accounted === 0 || p.pricedRequests === 0
      ? "unknown"
      : p.unpricedRequests + p.unmeteredRequests > 0 ? "partial" : "priced";
  }
  return providers.sort((a, b) => b.requests - a.requests);
}

export function summarizeUsage(
  entries: PersistedUsageEntry[],
  range: UsageRange,
  now: number,
  surface: UsageSurface = "all",
): UsageSummary {
  const { since } = rangeWindow(range, now);
  const filteredEntries = entries.filter(entry => {
    if (since !== null && entry.timestamp < since) return false;
    if (surface === "claude") return entry.surface === "claude" || entry.surface === "claude-desktop";
    if (surface === "grok") return entry.surface === "grok";
    // Codex = the historical unlabelled bucket. Before the grok tag existed every
    // non-Claude turn landed here, and `surface !== "claude"` also swallowed
    // claude-desktop — disjoint predicates fix both.
    if (surface === "codex") return entry.surface === undefined;
    return true;
  });
  const totals = emptyUsageSummaryTotals();
  for (const entry of filteredEntries) {
    bumpStatus(totals, entry.usageStatus);
    totals.attemptCount += entry.attempts?.length ?? 1;
    addTokens(totals, entry);
    addEstimatedCost(totals, entry);
  }
  finalizeCoverage(totals);
  return {
    range,
    surface,
    since,
    generatedAt: now,
    summary: totals,
    days: buildDayGrid(range, since, now, filteredEntries),
    models: buildModels(filteredEntries, totals.totalTokens),
    providers: buildProviders(filteredEntries, totals.totalTokens),
  };
}
