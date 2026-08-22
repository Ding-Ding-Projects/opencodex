/**
 * Display-time cost estimation for desktop Logs and Usage.
 *
 * All prices are estimates (~$), never billing reproductions. Monetary authority
 * comes only from the exact first-party schedules in expected-prices.ts. Jawcode
 * remains catalog metadata and never authorizes a price across product boundaries.
 */
import { CODEX_ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";
import type { OcxUsage } from "../types";
import type { PersistedUsageAttempt, UsageStatus } from "./log";
import {
  OFFICIAL_PRICE_SCHEDULES,
  resolveOfficialPriceSchedule,
  type CacheRetention,
  type Cost4,
  type OfficialPriceContext,
  type OfficialPriceSchedule,
  type PriceTier,
  type PricingUnavailableReason,
} from "./expected-prices";

export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MatchedPrice {
  provider: string;
  modelId: string;
  scheduleId: string;
  cost4: Cost4;
  /** Retained for GUI/API compatibility; now means authoritative official schedule. */
  source: "expected";
  sourceRef: string;
  verifiedAt: string;
  status: "verified";
  conditions?: OfficialPriceSchedule["conditions"];
  /**
   * Which published band produced `cost4`, and the factor that got it there.
   * Carried to the GUI so a doubled figure can say why it doubled instead of
   * leaving the reader to compare it against a rate card by hand.
   */
  tier?: PriceTier;
}

export type MatchedPriceResolution =
  | { kind: "matched"; price: MatchedPrice }
  | { kind: "unavailable"; reason: PricingUnavailableReason };

export interface PricingContext extends OfficialPriceContext {
  cacheRetention?: CacheRetention;
}

export interface AttemptCostEstimate {
  ordinal: number;
  provider: string;
  model: string;
  tokens: CostTokens;
  price: MatchedPrice;
  cost: CostBreakdown;
  estimated: boolean;
}

export interface CostEstimate {
  tokens: CostTokens;
  cost: CostBreakdown;
  estimated: boolean;
  attempts?: AttemptCostEstimate[];
  price?: MatchedPrice;
}

/**
 * Accounting is deliberately split by source product. `direct` is the only
 * billable-product estimate. `api_equivalent` is an explicit non-billing
 * comparison for supported subscription/OAuth traffic.
 */
export type PricingLane = "direct" | "api_equivalent";
export type PricingSourceClassification = "direct_api_key" | "subscription_api_equivalent";

export interface LaneCostEstimate extends CostEstimate {
  lane: PricingLane;
  sourceClassification: PricingSourceClassification;
}

export interface CostEstimateLanes {
  direct: LaneCostEstimate | null;
  apiEquivalent: LaneCostEstimate | null;
}

export type UsageCostUnavailableReason =
  | "usage_missing"
  | "usage_unsupported"
  | "invalid_cache_breakdown"
  | "invalid_usage";

export type UsageCostClassification =
  | { kind: "metered"; tokens: CostTokens }
  | { kind: "unavailable"; reason: UsageCostUnavailableReason };

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Normalize inclusive OcxUsage (inputTokens includes cache read/write) into
 * uncached-input, output, cache-read, and cache-write tokens without double charge.
 */
export function classifyUsageForCost(
  usage: OcxUsage | undefined,
  usageStatus: UsageStatus = "reported",
): UsageCostClassification {
  if (!usage) return { kind: "unavailable", reason: "usage_missing" };
  if (usageStatus === "unsupported") {
    return { kind: "unavailable", reason: "usage_unsupported" };
  }
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const primaryRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  if (![input, output, primaryRead, cacheWrite].every(finiteNonNegative)) {
    return { kind: "unavailable", reason: "invalid_usage" };
  }
  const candidates: number[] = [primaryRead];
  if (typeof usage.cacheReadInputTokens !== "number"
    && typeof usage.cachedInputTokens === "number"
    && typeof usage.cacheCreationInputTokens === "number") {
    candidates.push(Math.max(0, usage.cachedInputTokens - usage.cacheCreationInputTokens));
  }
  for (const cacheRead of candidates) {
    if (cacheRead + cacheWrite > input) continue;
    return {
      kind: "metered",
      tokens: {
        input: Math.max(0, input - cacheRead - cacheWrite),
        output,
        cacheRead,
        cacheWrite,
      },
    };
  }
  return { kind: "unavailable", reason: "invalid_cache_breakdown" };
}

export function normalizeCostTokens(usage: OcxUsage): CostTokens | null {
  const result = classifyUsageForCost(usage);
  return result.kind === "metered" ? result.tokens : null;
}

/** Official schedule unit convention: USD per 1M tokens. */
export function calculateCost(tokens: CostTokens, cost4: Cost4): CostBreakdown {
  const input = cost4.input * tokens.input / 1_000_000;
  const output = cost4.output * tokens.output / 1_000_000;
  const cacheRead = cost4.cacheRead * tokens.cacheRead / 1_000_000;
  const cacheWrite = cost4.cacheWrite * tokens.cacheWrite / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

const SUFFIXED_SUBSCRIPTION_LOG_PRODUCTS = new Set([
  "openai",
  "chatgpt",
  "anthropic",
  "cursor",
  "kiro",
  "google-antigravity",
  "kimi",
]);

/**
 * Normalize only bounded account-log suffixes. `openai` and legacy
 * `openai-multi` retain their subscription product identity for accounting;
 * display-only provider grouping is intentionally handled elsewhere.
 */
function billingProviderId(provider: string): string {
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return provider;
  const suffix = provider.slice(cut + 1);
  const base = provider.slice(0, cut);
  return SUFFIXED_SUBSCRIPTION_LOG_PRODUCTS.has(base)
    && (suffix === "main" || CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix))
    ? base
    : provider;
}

function matchedPrice(schedule: OfficialPriceSchedule): MatchedPrice {
  return {
    provider: schedule.provider,
    modelId: schedule.modelId,
    scheduleId: schedule.scheduleId,
    cost4: schedule.cost4,
    source: "expected",
    sourceRef: schedule.sourceUrl,
    verifiedAt: schedule.verifiedAt,
    status: schedule.status,
    ...(schedule.conditions ? { conditions: schedule.conditions } : {}),
    ...(schedule.tier ? { tier: schedule.tier } : {}),
  };
}

const DIRECT_API_KEY_PRODUCTS = new Set([
  "openai-apikey",
  "anthropic-apikey",
  "deepseek",
  "moonshot",
]);

/** Only these subscription/OAuth products have an explicitly supported comparison lane. */
const API_EQUIVALENT_PRODUCTS = new Map<string, "openai-apikey" | "anthropic-apikey">([
  ["openai", "openai-apikey"],
  ["openai-multi", "openai-apikey"],
  ["chatgpt", "openai-apikey"],
  ["anthropic", "anthropic-apikey"],
]);

/**
 * Resolve a log provider into an accounting lane without collapsing product
 * boundaries. Suffixes are accepted only for known account log labels.
 */
export function pricingSourceClassification(provider: string): {
  lane: PricingLane;
  sourceClassification: PricingSourceClassification;
  pricingProvider: string;
} | null {
  const product = billingProviderId(provider);
  if (DIRECT_API_KEY_PRODUCTS.has(product)) {
    return {
      lane: "direct",
      sourceClassification: "direct_api_key",
      pricingProvider: product,
    };
  }
  const pricingProvider = API_EQUIVALENT_PRODUCTS.get(product);
  return pricingProvider
    ? {
      lane: "api_equivalent",
      sourceClassification: "subscription_api_equivalent",
      pricingProvider,
    }
    : null;
}

function estimateWithPricingProvider(
  input: {
    provider: string;
    pricingProvider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus: UsageStatus;
    serviceTier?: string;
    cacheRetention?: CacheRetention;
    promptInputTokens?: number;
    timestamp?: number;
  },
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): CostEstimate | null {
  const usage = classifyUsageForCost(input.usage, input.usageStatus);
  if (usage.kind === "unavailable") return null;
  const tokens = usage.tokens;
  const price = resolveMatchedPrice(
    input.pricingProvider,
    input.model,
    {
      serviceTier: input.serviceTier,
      cacheRetention: input.cacheRetention,
      promptInputTokens: input.promptInputTokens,
      timestamp: input.timestamp,
    },
    tokens.cacheWrite,
    schedules,
  );
  if (!price) return null;
  return {
    tokens,
    price,
    cost: calculateCost(tokens, price.cost4),
    estimated: isEstimated(input.usage, input.usageStatus),
  };
}

function unavailablePricingReasonWithProvider(input: {
  provider: string;
  pricingProvider: string;
  model: string;
  usage?: OcxUsage;
  usageStatus?: UsageStatus;
  serviceTier?: string;
  cacheRetention?: CacheRetention;
  promptInputTokens?: number;
  timestamp?: number;
}, schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES): PricingUnavailableReason | undefined {
  const usage = classifyUsageForCost(input.usage, input.usageStatus);
  if (usage.kind === "unavailable") return undefined;
  const resolution = resolveMatchedPriceResult(
    input.pricingProvider,
    input.model,
    {
      serviceTier: input.serviceTier,
      cacheRetention: input.cacheRetention,
      promptInputTokens: input.promptInputTokens,
      timestamp: input.timestamp,
    },
    usage.tokens.cacheWrite,
    schedules,
  );
  return resolution.kind === "unavailable" ? resolution.reason : undefined;
}

export function resolveMatchedPriceResult(
  provider: string,
  modelId: string,
  context: PricingContext = {},
  cacheWriteTokens = 0,
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): MatchedPriceResolution {
  const productId = billingProviderId(provider);
  const resolution = resolveOfficialPriceSchedule(
    productId,
    modelId,
    context,
    cacheWriteTokens,
    schedules,
  );
  return resolution.kind === "matched"
    ? { kind: "matched", price: matchedPrice(resolution.schedule) }
    : resolution;
}

export function resolveMatchedPrice(
  provider: string,
  modelId: string,
  context: PricingContext = {},
  cacheWriteTokens = 0,
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): MatchedPrice | null {
  const resolution = resolveMatchedPriceResult(
    provider,
    modelId,
    context,
    cacheWriteTokens,
    schedules,
  );
  return resolution.kind === "matched" ? resolution.price : null;
}

function isEstimated(usage: OcxUsage | undefined, usageStatus: UsageStatus): boolean {
  return usage?.estimated === true || usageStatus === "estimated";
}

export function effectiveServiceTier(entry: {
  provider?: string;
  responseServiceTier?: string;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
}): string | undefined {
  if (entry.provider?.trim().toLowerCase() === "xai") {
    const confirmed = entry.responseServiceTier?.trim().toLowerCase();
    return confirmed === "priority" || confirmed === "fast" ? "priority" : "standard";
  }
  const value = entry.responseServiceTier ?? entry.requestedServiceTier ?? entry.configuredServiceTier;
  const normalized = value?.trim().toLowerCase();
  return normalized === "fast" ? "priority" : normalized || undefined;
}

export function estimateAttemptCost(
  attempt: Pick<PersistedUsageAttempt, "ordinal" | "timestamp" | "provider" | "model" | "usage" | "usageStatus" | "cacheRetention" | "promptInputTokens">,
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
  context: PricingContext = {},
): AttemptCostEstimate | null {
  const usage = classifyUsageForCost(attempt.usage, attempt.usageStatus);
  if (usage.kind === "unavailable") return null;
  const tokens = usage.tokens;
  const attemptContext = {
    ...context,
    timestamp: attempt.timestamp ?? context.timestamp,
    cacheRetention: attempt.cacheRetention ?? context.cacheRetention,
    promptInputTokens: attempt.promptInputTokens ?? context.promptInputTokens,
  };
  const price = resolveMatchedPrice(
    attempt.provider,
    attempt.model,
    attemptContext,
    tokens.cacheWrite,
    schedules,
  );
  if (!price) return null;
  return {
    ordinal: attempt.ordinal,
    provider: attempt.provider,
    model: attempt.model,
    tokens,
    price,
    cost: calculateCost(tokens, price.cost4),
    estimated: isEstimated(attempt.usage, attempt.usageStatus),
  };
}

/** Combo estimates are all-or-nothing; one unavailable attempt nulls the sum. */
export function estimateComboCost(
  attempts: readonly Pick<PersistedUsageAttempt, "ordinal" | "timestamp" | "provider" | "model" | "usage" | "usageStatus" | "cacheRetention" | "promptInputTokens">[],
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
  context: PricingContext = {},
): CostEstimate | null {
  if (attempts.length === 0) return null;
  const estimates: AttemptCostEstimate[] = [];
  for (const attempt of attempts) {
    const estimate = estimateAttemptCost(attempt, schedules, context);
    if (!estimate) return null;
    estimates.push(estimate);
  }
  const tokens: CostTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const estimate of estimates) {
    tokens.input += estimate.tokens.input;
    tokens.output += estimate.tokens.output;
    tokens.cacheRead += estimate.tokens.cacheRead;
    tokens.cacheWrite += estimate.tokens.cacheWrite;
    cost.input += estimate.cost.input;
    cost.output += estimate.cost.output;
    cost.cacheRead += estimate.cost.cacheRead;
    cost.cacheWrite += estimate.cost.cacheWrite;
    cost.total += estimate.cost.total;
  }
  return {
    tokens,
    cost,
    estimated: estimates.some(estimate => estimate.estimated),
    attempts: estimates,
  };
}

export function estimateRequestCost(
  input: {
    provider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus: UsageStatus;
    serviceTier?: string;
    cacheRetention?: CacheRetention;
    promptInputTokens?: number;
    timestamp?: number;
  },
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): CostEstimate | null {
  return estimateWithPricingProvider({ ...input, pricingProvider: input.provider }, schedules);
}

/**
 * Build isolated accounting outputs. A request can belong to exactly one lane:
 * direct API-key traffic or explicitly labelled subscription API equivalent.
 */
export function estimateRequestCostLanes(
  input: {
    provider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus: UsageStatus;
    serviceTier?: string;
    cacheRetention?: CacheRetention;
    promptInputTokens?: number;
    timestamp?: number;
  },
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): CostEstimateLanes {
  const source = pricingSourceClassification(input.provider);
  if (!source) return { direct: null, apiEquivalent: null };
  const estimate = estimateWithPricingProvider({ ...input, pricingProvider: source.pricingProvider }, schedules);
  if (!estimate) return { direct: null, apiEquivalent: null };
  const laneEstimate: LaneCostEstimate = { ...estimate, lane: source.lane, sourceClassification: source.sourceClassification };
  return source.lane === "direct"
    ? { direct: laneEstimate, apiEquivalent: null }
    : { direct: null, apiEquivalent: laneEstimate };
}

export function pricingUnavailableReason(input: {
  provider: string;
  model: string;
  usage?: OcxUsage;
  usageStatus?: UsageStatus;
  serviceTier?: string;
  cacheRetention?: CacheRetention;
  promptInputTokens?: number;
  timestamp?: number;
}, schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES): PricingUnavailableReason | undefined {
  return unavailablePricingReasonWithProvider({ ...input, pricingProvider: input.provider }, schedules);
}

export function pricingLaneUnavailableReason(
  lane: PricingLane,
  input: {
    provider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus?: UsageStatus;
    serviceTier?: string;
    cacheRetention?: CacheRetention;
    promptInputTokens?: number;
    timestamp?: number;
  },
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): PricingUnavailableReason | undefined {
  const source = pricingSourceClassification(input.provider);
  if (!source || source.lane !== lane) return undefined;
  return unavailablePricingReasonWithProvider({ ...input, pricingProvider: source.pricingProvider }, schedules);
}

export function comboUsageUnavailableReason(
  attempts: readonly Pick<PersistedUsageAttempt, "usage" | "usageStatus">[],
): UsageCostUnavailableReason | undefined {
  for (const attempt of attempts) {
    const usage = classifyUsageForCost(attempt.usage, attempt.usageStatus);
    if (usage.kind === "unavailable") return usage.reason;
  }
  return undefined;
}

export function comboPricingUnavailableReason(
  attempts: readonly Pick<PersistedUsageAttempt, "timestamp" | "provider" | "model" | "usage" | "usageStatus" | "cacheRetention" | "promptInputTokens">[],
  context: PricingContext = {},
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): PricingUnavailableReason | undefined {
  for (const attempt of attempts) {
    const usage = classifyUsageForCost(attempt.usage, attempt.usageStatus);
    if (usage.kind === "unavailable") return undefined;
    const attemptContext = {
      ...context,
      timestamp: attempt.timestamp ?? context.timestamp,
      cacheRetention: attempt.cacheRetention ?? context.cacheRetention,
      promptInputTokens: attempt.promptInputTokens ?? context.promptInputTokens,
    };
    const resolution = resolveMatchedPriceResult(
      attempt.provider,
      attempt.model,
      attemptContext,
      usage.tokens.cacheWrite,
      schedules,
    );
    if (resolution.kind === "unavailable") return resolution.reason;
  }
  return undefined;
}

/** End-to-end output rate; TTFT is intentionally a separate metric. */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (!finiteNonNegative(outputTokens) || !finiteNonNegative(durationMs)) return null;
  if (outputTokens <= 0 || durationMs <= 0) return null;
  return outputTokens / (durationMs / 1_000);
}
