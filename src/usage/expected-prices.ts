/**
 * Release-versioned first-party API price authority.
 *
 * Prices are display-time list-price estimates in USD per 1M tokens. A row is
 * usable only for the exact OpenCodex billing product and model ID named here.
 * Provider catalog aliases, OAuth products, coding plans, routers, regions,
 * and matching model names never inherit direct-billing rates implicitly.
 */

/** The OpenCodex release carrying this immutable pricing authority. */
export const OFFICIAL_PRICE_CATALOG_VERSION = "2.7.42+build.152" as const;
export const OFFICIAL_PRICE_CATALOG_RELEASE_VERSION = "2.7.42" as const;

export interface Cost4 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type OfficialPriceStatus = "verified";
export type CacheRetention = "none" | "short" | "long";

/**
 * Which published price band a schedule row represents.
 *
 * `standard` is the model's base list rate. The other two are separately
 * published bands that reprice the WHOLE request, so they are real rows in this
 * authority rather than a factor applied somewhere downstream — a reader of a
 * doubled figure can point at the exact row that produced it.
 */
export type PriceTierBand = "standard" | "priority" | "long_context";

export interface PriceTier {
  band: PriceTierBand;
  /**
   * Per-field factor from the model's base published rate to this row's rate.
   * `standard` carries an all-1 factor so every row answers the question
   * "what was multiplied?" without the caller special-casing absence.
   */
  multiplier: Cost4;
}

export interface OfficialPriceConditions {
  /** Exact prompt-cache write tier selected by OpenCodex configuration. */
  cacheRetention?: "short" | "long";
  /** Exact upstream service tier required by this schedule. */
  serviceTier?: string;
  /** Raw prompt-token range. It is never inferred from response usage. */
  promptInputTokensMinExclusive?: number;
  /** Raw prompt-token range. It is never inferred from response usage. */
  promptInputTokensMaxInclusive?: number;
  /** The official source does not publish a separate cache-write price. */
  cacheWriteAvailability?: "priced" | "unavailable";
  /** Inclusive UTC calendar date on which a price starts. */
  validFrom?: string;
  /** Inclusive UTC calendar date for a temporary price. */
  validThrough?: string;
}

export interface OfficialPriceSchedule {
  scheduleId: string;
  provider: string;
  modelId: string;
  cost4: Cost4;
  sourceUrl: string;
  verifiedAt: string;
  status: OfficialPriceStatus;
  conditions?: OfficialPriceConditions;
  /** Present on every row whose model publishes more than one band. */
  tier?: PriceTier;
}

export interface OfficialPriceContext {
  cacheRetention?: CacheRetention;
  serviceTier?: string;
  /** Persisted raw request prompt size, not inclusive response usage. */
  promptInputTokens?: number;
  timestamp?: number;
}

export type PricingUnavailableReason =
  | "price_unmatched"
  | "pricing_product_unpriced"
  | "pricing_context_missing"
  | "pricing_condition_unmatched"
  | "pricing_schedule_invalid";

export type OfficialPriceResolution =
  | { kind: "matched"; schedule: OfficialPriceSchedule }
  | { kind: "unavailable"; reason: PricingUnavailableReason };

const VERIFIED_AT = "2026-08-07" as const;
const OPENAI_VERIFIED_AT = "2026-08-09" as const;
const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const DEEPSEEK_PRICING = "https://api-docs.deepseek.com/quick_start/pricing";

/**
 * OpenAI Fast mode (`service_tier=priority`) price factors, by exact model slug.
 * Source: https://openai.com/api-fast-mode/. Fast applies ONE uniform factor to
 * every token type — input, output, cache read and cache write alike.
 *
 * A model absent from this map has no published Fast rate, so it gets no
 * priority row at all and a Fast request against it resolves to
 * `pricing_condition_unmatched`. That is deliberate: billing an unlisted model
 * at its standard rate would under-charge it by exactly the factor we could not
 * find, which is the failure this table exists to prevent.
 */
export const OPENAI_PRIORITY_MULTIPLIERS: Readonly<Record<string, number>> = {
  "gpt-5.6-sol": 2,
  "gpt-5.6-terra": 2,
  "gpt-5.6-luna": 2,
  "gpt-5.5": 2.5,
};

/**
 * OpenAI long-context band: prompts above 272K input tokens are priced at 2x
 * input and 1.5x output for the full request; cached input and cache writes
 * double alongside input, per the published short/long columns.
 *
 * THE COMPARISON IS EXCLUSIVE (`>`), so a prompt of exactly 272,000 tokens is
 * still SHORT. That is expressed here as `promptInputTokensMaxInclusive` on the
 * short row and `promptInputTokensMinExclusive` on the long row, both at the
 * same number: the resolver tests `<= max` and `> min`, so the two rows meet
 * exactly at the boundary with neither a gap nor an overlap.
 *
 * The measured quantity is the persisted RAW request prompt size
 * (`promptInputTokens`, written by the request builder at send time), never the
 * normalized billable input. Normalization subtracts cache read and write, so a
 * 280k prompt sitting on a 200k cache read has only 80k billable input and would
 * fall back under the boundary — under-charging exactly the cache-heavy long
 * requests the band exists to catch.
 */
export const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
export const OPENAI_LONG_CONTEXT_MULTIPLIER: Cost4 = {
  input: 2,
  output: 1.5,
  cacheRead: 2,
  cacheWrite: 2,
};

const NO_MULTIPLIER: Cost4 = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };

function uniformMultiplier(factor: number): Cost4 {
  return { input: factor, output: factor, cacheRead: factor, cacheWrite: factor };
}

/**
 * Derive a band's rate from the model's base tuple rather than restating it.
 *
 * A hand-typed derived rate is a second declaration of the same price, and the
 * two only agree until someone corrects one of them — at which point the stale
 * copy keeps billing silently. Multiplying keeps every band arithmetically
 * bound to the one base tuple above it.
 */
function scaleCost4(base: Cost4, factor: Cost4): Cost4 {
  return {
    input: base.input * factor.input,
    output: base.output * factor.output,
    cacheRead: base.cacheRead * factor.cacheRead,
    cacheWrite: base.cacheWrite * factor.cacheWrite,
  };
}

/**
 * Every published band for one OpenAI model: standard short, standard long, and
 * Fast where the model publishes a Fast rate.
 *
 * The Fast row is capped at the same 272k boundary ON PURPOSE. OpenAI does not
 * serve long context in Fast mode, so a Fast-tagged request above the boundary
 * was necessarily served as something else — but this fork's pricing layer
 * receives only the collapsed service-tier scalar from `effectiveServiceTier()`,
 * which cannot distinguish a response-confirmed Fast request from one that was
 * merely requested Fast and then downgraded. Rather than guess between the Fast
 * rate and the long rate, that combination matches no row and reports
 * `pricing_condition_unmatched`. A response-confirmed downgrade already reports
 * its served tier ("default"), so the ordinary case still prices correctly as
 * standard-long; only the genuinely ambiguous request declines.
 */
function openAiSchedules(
  modelId: "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.5",
  cost4: Cost4,
  cacheWriteAvailability: "priced" | "unavailable" = "priced",
): OfficialPriceSchedule[] {
  const row = (
    suffix: string,
    multiplier: Cost4,
    band: PriceTierBand,
    conditions: Omit<OfficialPriceConditions, "cacheWriteAvailability">,
  ): OfficialPriceSchedule => ({
    scheduleId: `openai-apikey/${modelId}/${suffix}`,
    provider: "openai-apikey",
    modelId,
    cost4: scaleCost4(cost4, multiplier),
    sourceUrl: OPENAI_PRICING,
    verifiedAt: OPENAI_VERIFIED_AT,
    status: "verified",
    conditions: { ...conditions, cacheWriteAvailability },
    tier: { band, multiplier },
  });

  const schedules: OfficialPriceSchedule[] = [
    row("standard/short-context", NO_MULTIPLIER, "standard", {
      serviceTier: "standard",
      promptInputTokensMaxInclusive: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
    }),
    row("standard/long-context", OPENAI_LONG_CONTEXT_MULTIPLIER, "long_context", {
      serviceTier: "standard",
      promptInputTokensMinExclusive: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
    }),
  ];

  const priority = OPENAI_PRIORITY_MULTIPLIERS[modelId];
  if (priority !== undefined) {
    schedules.push(row("priority/short-context", uniformMultiplier(priority), "priority", {
      serviceTier: "priority",
      promptInputTokensMaxInclusive: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
    }));
  }
  return schedules;
}

function anthropicSchedules(
  modelId: string,
  base: Omit<Cost4, "cacheWrite">,
  fiveMinuteCacheWrite: number,
  oneHourCacheWrite: number,
  conditions: Pick<OfficialPriceConditions, "validFrom" | "validThrough"> = {},
): OfficialPriceSchedule[] {
  const dateSuffix = conditions.validFrom
    ? `/from-${conditions.validFrom}`
    : conditions.validThrough
      ? `/through-${conditions.validThrough}`
      : "";
  return [
    {
      scheduleId: `anthropic-apikey/${modelId}/cache-5m${dateSuffix}`,
      provider: "anthropic-apikey",
      modelId,
      cost4: { ...base, cacheWrite: fiveMinuteCacheWrite },
      sourceUrl: ANTHROPIC_PRICING,
      verifiedAt: VERIFIED_AT,
      status: "verified",
      conditions: { ...conditions, cacheRetention: "short" },
    },
    {
      scheduleId: `anthropic-apikey/${modelId}/cache-1h${dateSuffix}`,
      provider: "anthropic-apikey",
      modelId,
      cost4: { ...base, cacheWrite: oneHourCacheWrite },
      sourceUrl: ANTHROPIC_PRICING,
      verifiedAt: VERIFIED_AT,
      status: "verified",
      conditions: { ...conditions, cacheRetention: "long" },
    },
  ];
}

export const OFFICIAL_PRICE_SCHEDULES: readonly OfficialPriceSchedule[] = [
  ...openAiSchedules(
    "gpt-5.6-sol",
    { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  ),
  ...openAiSchedules(
    "gpt-5.6-terra",
    { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  ),
  ...openAiSchedules(
    "gpt-5.6-luna",
    { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  ),
  ...openAiSchedules(
    "gpt-5.5",
    { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    "unavailable",
  ),
  ...anthropicSchedules(
    "claude-fable-5",
    { input: 10, output: 50, cacheRead: 1 },
    12.5,
    20,
  ),
  ...anthropicSchedules(
    "claude-sonnet-5",
    { input: 2, output: 10, cacheRead: 0.2 },
    2.5,
    4,
    { validThrough: "2026-08-31" },
  ),
  ...anthropicSchedules(
    "claude-sonnet-5",
    { input: 3, output: 15, cacheRead: 0.3 },
    3.75,
    6,
    { validFrom: "2026-09-01" },
  ),
  ...anthropicSchedules(
    "claude-opus-5",
    { input: 5, output: 25, cacheRead: 0.5 },
    6.25,
    10,
  ),
  ...anthropicSchedules(
    "claude-opus-4-8",
    { input: 5, output: 25, cacheRead: 0.5 },
    6.25,
    10,
  ),
  ...anthropicSchedules(
    "claude-opus-4-7",
    { input: 5, output: 25, cacheRead: 0.5 },
    6.25,
    10,
  ),
  ...anthropicSchedules(
    "claude-opus-4-6",
    { input: 5, output: 25, cacheRead: 0.5 },
    6.25,
    10,
  ),
  ...anthropicSchedules(
    "claude-sonnet-4-6",
    { input: 3, output: 15, cacheRead: 0.3 },
    3.75,
    6,
  ),
  ...anthropicSchedules(
    "claude-haiku-4-5",
    { input: 1, output: 5, cacheRead: 0.1 },
    1.25,
    2,
  ),
  {
    scheduleId: "deepseek/deepseek-v4-flash/standard",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    cost4: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
    sourceUrl: DEEPSEEK_PRICING,
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
  {
    scheduleId: "deepseek/deepseek-v4-pro/standard",
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    cost4: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },
    sourceUrl: DEEPSEEK_PRICING,
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
  {
    scheduleId: "moonshot/kimi-k3/standard",
    provider: "moonshot",
    modelId: "kimi-k3",
    cost4: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
    sourceUrl: "https://platform.kimi.ai/docs/pricing/chat-k3",
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
  {
    scheduleId: "moonshot/kimi-k2.7-code/standard",
    provider: "moonshot",
    modelId: "kimi-k2.7-code",
    cost4: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 },
    sourceUrl: "https://platform.kimi.ai/docs/pricing/chat-k27-code",
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
  {
    scheduleId: "moonshot/kimi-k2.7-code-highspeed/standard",
    provider: "moonshot",
    modelId: "kimi-k2.7-code-highspeed",
    cost4: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 },
    sourceUrl: "https://platform.kimi.ai/docs/pricing/chat-k27-code",
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
  {
    scheduleId: "moonshot/kimi-k2.6/standard",
    provider: "moonshot",
    modelId: "kimi-k2.6",
    cost4: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.95 },
    sourceUrl: "https://platform.kimi.ai/docs/pricing/chat-k26",
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
  {
    scheduleId: "moonshot/kimi-k2.5/standard",
    provider: "moonshot",
    modelId: "kimi-k2.5",
    cost4: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.6 },
    sourceUrl: "https://platform.kimi.ai/docs/pricing/chat-k25",
    verifiedAt: VERIFIED_AT,
    status: "verified",
  },
];

const UNPRICED_BILLING_PRODUCTS = new Set([
  "openai",
  "openai-multi",
  "chatgpt",
  "anthropic",
  "cursor",
  "kiro",
  "google-antigravity",
  "kimi",
  "kimi-code",
  "github-copilot",
  "openrouter",
  "orcarouter",
  "bizrouter",
  "alibaba-token-plan",
  "alibaba-token-plan-intl",
  "tencent-coding-plan",
  "umans",
  "minimax",
  "minimax-cn",
]);

function requiresUnpersistedPricingContext(provider: string, modelId: string): boolean {
  if (provider === "openai-apikey") {
    return modelId === "gpt-5.5"
      || /^gpt-5\.6-(sol|terra|luna)(-pro)?$/.test(modelId);
  }
  if (provider === "google" || provider === "google-vertex" || provider === "xai") {
    return true;
  }
  return false;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validCost4(cost: Cost4): boolean {
  return finiteNonNegative(cost.input)
    && finiteNonNegative(cost.output)
    && finiteNonNegative(cost.cacheRead)
    && finiteNonNegative(cost.cacheWrite)
    && (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0);
}

function validDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) return false;
  const roundTrip = new Date(timestamp);
  return roundTrip.getUTCFullYear() === year
    && roundTrip.getUTCMonth() === month - 1
    && roundTrip.getUTCDate() === day;
}

function selectorKey(row: OfficialPriceSchedule): string {
  return JSON.stringify([
    row.provider,
    row.modelId,
    row.conditions?.cacheRetention ?? null,
    row.conditions?.serviceTier ?? null,
    row.conditions?.promptInputTokensMinExclusive ?? null,
    row.conditions?.promptInputTokensMaxInclusive ?? null,
    row.conditions?.validFrom ?? null,
    row.conditions?.validThrough ?? null,
  ]);
}

/** Validate the entire authority set. Any malformed or duplicate row invalidates it. */
export function validateOfficialPriceSchedules(
  schedules: readonly OfficialPriceSchedule[],
): string[] {
  const errors: string[] = [];
  const scheduleIds = new Set<string>();
  const selectors = new Set<string>();
  for (const row of schedules) {
    if (!row.scheduleId || !row.provider || !row.modelId) {
      errors.push("schedule identity is incomplete");
      continue;
    }
    if (scheduleIds.has(row.scheduleId)) errors.push(`duplicate schedule id: ${row.scheduleId}`);
    scheduleIds.add(row.scheduleId);
    const selector = selectorKey(row);
    if (selectors.has(selector)) errors.push(`duplicate schedule selector: ${row.provider}/${row.modelId}`);
    selectors.add(selector);
    if (!validCost4(row.cost4)) errors.push(`invalid cost tuple: ${row.scheduleId}`);
    if (row.status !== "verified") errors.push(`invalid status: ${row.scheduleId}`);
    if (!validDateOnly(row.verifiedAt)) errors.push(`invalid verification date: ${row.scheduleId}`);
    try {
      const source = new URL(row.sourceUrl);
      if (source.protocol !== "https:") errors.push(`non-HTTPS source: ${row.scheduleId}`);
    } catch {
      errors.push(`invalid source URL: ${row.scheduleId}`);
    }
    if (row.conditions?.cacheRetention !== undefined
      && row.conditions.cacheRetention !== "short"
      && row.conditions.cacheRetention !== "long") {
      errors.push(`invalid cache retention: ${row.scheduleId}`);
    }
    if (row.conditions?.serviceTier !== undefined && !row.conditions.serviceTier.trim()) {
      errors.push(`invalid service tier: ${row.scheduleId}`);
    }
    for (const [key, value] of [
      ["promptInputTokensMinExclusive", row.conditions?.promptInputTokensMinExclusive],
      ["promptInputTokensMaxInclusive", row.conditions?.promptInputTokensMaxInclusive],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        errors.push(`invalid ${key}: ${row.scheduleId}`);
      }
    }
    if (row.conditions?.promptInputTokensMinExclusive !== undefined
      && row.conditions?.promptInputTokensMaxInclusive !== undefined
      && row.conditions.promptInputTokensMinExclusive >= row.conditions.promptInputTokensMaxInclusive) {
      errors.push(`invalid prompt input range: ${row.scheduleId}`);
    }
    if (row.conditions?.cacheWriteAvailability !== undefined
      && row.conditions.cacheWriteAvailability !== "priced"
      && row.conditions.cacheWriteAvailability !== "unavailable") {
      errors.push(`invalid cache write availability: ${row.scheduleId}`);
    }
    if (row.tier) {
      // Strictly positive, not merely non-negative: a zero factor would silently
      // render a whole band free, which is the one arithmetic error a price
      // table must never be able to express.
      const factors = row.tier.multiplier;
      const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
      if (!positive(factors.input) || !positive(factors.output)
        || !positive(factors.cacheRead) || !positive(factors.cacheWrite)) {
        errors.push(`invalid tier multiplier: ${row.scheduleId}`);
      }
      if (row.tier.band !== "standard" && row.tier.band !== "priority" && row.tier.band !== "long_context") {
        errors.push(`invalid tier band: ${row.scheduleId}`);
      }
    }
    if (row.conditions?.validFrom && !validDateOnly(row.conditions.validFrom)) {
      errors.push(`invalid valid-from date: ${row.scheduleId}`);
    }
    if (row.conditions?.validThrough && !validDateOnly(row.conditions.validThrough)) {
      errors.push(`invalid valid-through date: ${row.scheduleId}`);
    }
    if (row.conditions?.validFrom && row.conditions.validThrough
      && row.conditions.validFrom > row.conditions.validThrough) {
      errors.push(`invalid date range: ${row.scheduleId}`);
    }
  }
  for (let leftIndex = 0; leftIndex < schedules.length; leftIndex++) {
    const left = schedules[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < schedules.length; rightIndex++) {
      const right = schedules[rightIndex]!;
      const sameConditionLane = left.provider === right.provider
        && left.modelId === right.modelId
        && left.conditions?.cacheRetention === right.conditions?.cacheRetention
        && normalizedServiceTier(left.conditions?.serviceTier) === normalizedServiceTier(right.conditions?.serviceTier)
        && left.conditions?.promptInputTokensMinExclusive === right.conditions?.promptInputTokensMinExclusive
        && left.conditions?.promptInputTokensMaxInclusive === right.conditions?.promptInputTokensMaxInclusive;
      if (!sameConditionLane) continue;
      const leftStart = left.conditions?.validFrom ?? "0000-01-01";
      const leftEnd = left.conditions?.validThrough ?? "9999-12-31";
      const rightStart = right.conditions?.validFrom ?? "0000-01-01";
      const rightEnd = right.conditions?.validThrough ?? "9999-12-31";
      if (leftStart <= rightEnd && rightStart <= leftEnd) {
        errors.push(`overlapping schedule ranges: ${left.scheduleId} and ${right.scheduleId}`);
      }
    }
  }
  return errors;
}

const OFFICIAL_PRICE_SCHEDULE_ERRORS = validateOfficialPriceSchedules(OFFICIAL_PRICE_SCHEDULES);

/**
 * Fold the wire spellings of a service tier onto the names this authority's rows
 * use. `fast` is the product name for `priority`; `default` is what the upstream
 * response reports for the tier this authority calls `standard`.
 *
 * The `default` alias is load-bearing rather than cosmetic. A served response
 * echoes `service_tier: "default"` for ordinary traffic, and
 * `effectiveServiceTier()` prefers that response-confirmed value over anything
 * requested — so without this fold, every OpenAI request that actually reported
 * its served tier matched no row at all and went unpriced.
 */
function normalizedServiceTier(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "fast") return "priority";
  if (normalized === "default") return "standard";
  return normalized || undefined;
}

function utcDateOnly(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8_640_000_000_000_000) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function isWithinDateCondition(row: OfficialPriceSchedule, timestamp: number): boolean {
  const date = utcDateOnly(timestamp);
  if (!date) return false;
  const validFrom = row.conditions?.validFrom;
  const validThrough = row.conditions?.validThrough;
  return (!validFrom || date >= validFrom) && (!validThrough || date <= validThrough);
}

/**
 * Resolve one exact schedule. cacheWriteTokens controls whether cache retention is
 * a price-affecting required fact; rows with no cache writes remain priceable when
 * historical logs predate retention persistence.
 */
const OFFICIAL_RESOLUTION_MEMO = new Map<string, OfficialPriceResolution>();
const MAX_OFFICIAL_RESOLUTION_MEMO = 512;

export function resolveOfficialPriceSchedule(
  provider: string,
  modelId: string,
  context: OfficialPriceContext = {},
  cacheWriteTokens = 0,
  schedules: readonly OfficialPriceSchedule[] = OFFICIAL_PRICE_SCHEDULES,
): OfficialPriceResolution {
  if (schedules === OFFICIAL_PRICE_SCHEDULES) {
    const timestampDate = utcDateOnly(context.timestamp ?? Date.now());
    const key = JSON.stringify([
      provider,
      modelId,
      context.cacheRetention ?? null,
      normalizedServiceTier(context.serviceTier) ?? null,
      context.promptInputTokens ?? null,
      timestampDate,
      cacheWriteTokens > 0,
    ]);
    const cached = OFFICIAL_RESOLUTION_MEMO.get(key);
    if (cached) return cached;
    const resolution = resolveOfficialPriceScheduleUncached(
      provider,
      modelId,
      context,
      cacheWriteTokens,
      schedules,
    );
    if (OFFICIAL_RESOLUTION_MEMO.size >= MAX_OFFICIAL_RESOLUTION_MEMO) {
      OFFICIAL_RESOLUTION_MEMO.clear();
    }
    OFFICIAL_RESOLUTION_MEMO.set(key, resolution);
    return resolution;
  }
  return resolveOfficialPriceScheduleUncached(provider, modelId, context, cacheWriteTokens, schedules);
}

function resolveOfficialPriceScheduleUncached(
  provider: string,
  modelId: string,
  context: OfficialPriceContext,
  cacheWriteTokens: number,
  schedules: readonly OfficialPriceSchedule[],
): OfficialPriceResolution {
  const validationErrors = schedules === OFFICIAL_PRICE_SCHEDULES
    ? OFFICIAL_PRICE_SCHEDULE_ERRORS
    : validateOfficialPriceSchedules(schedules);
  if (validationErrors.length > 0) {
    return { kind: "unavailable", reason: "pricing_schedule_invalid" };
  }

  let candidates = schedules.filter(row => row.provider === provider && row.modelId === modelId);
  if (candidates.length === 0) {
    if (requiresUnpersistedPricingContext(provider, modelId)) {
      return { kind: "unavailable", reason: "pricing_context_missing" };
    }
    return {
      kind: "unavailable",
      reason: UNPRICED_BILLING_PRODUCTS.has(provider)
        ? "pricing_product_unpriced"
        : "price_unmatched",
    };
  }

  const timestamp = context.timestamp ?? Date.now();
  candidates = candidates.filter(row => isWithinDateCondition(row, timestamp));
  if (candidates.length === 0) {
    return { kind: "unavailable", reason: "pricing_condition_unmatched" };
  }

  const serviceTierRows = candidates.filter(row => row.conditions?.serviceTier !== undefined);
  if (serviceTierRows.length > 0) {
    // An omitted service tier is OpenAI's documented standard tier. An explicit
    // nonstandard tier must match an explicit schedule; never silently bill it as standard.
    const tier = normalizedServiceTier(context.serviceTier) ?? "standard";
    candidates = serviceTierRows.filter(row => normalizedServiceTier(row.conditions?.serviceTier) === tier);
    if (candidates.length === 0) {
      return { kind: "unavailable", reason: "pricing_condition_unmatched" };
    }
  }

  const promptRangeRows = candidates.filter(row => (
    row.conditions?.promptInputTokensMinExclusive !== undefined
    || row.conditions?.promptInputTokensMaxInclusive !== undefined
  ));
  if (promptRangeRows.length > 0) {
    const rawPromptInputTokens = context.promptInputTokens;
    if (!Number.isSafeInteger(rawPromptInputTokens) || rawPromptInputTokens === undefined || rawPromptInputTokens < 0) {
      return { kind: "unavailable", reason: "pricing_context_missing" };
    }
    const promptInputTokens = rawPromptInputTokens;
    candidates = promptRangeRows.filter(row => {
      const min = row.conditions?.promptInputTokensMinExclusive;
      const max = row.conditions?.promptInputTokensMaxInclusive;
      return (min === undefined || promptInputTokens > min)
        && (max === undefined || promptInputTokens <= max);
    });
    if (candidates.length === 0) {
      return { kind: "unavailable", reason: "pricing_condition_unmatched" };
    }
  }

  const cacheWriteUnavailable = candidates.some(row => (
    row.conditions?.cacheWriteAvailability === "unavailable"
  ));
  if (cacheWriteTokens > 0 && cacheWriteUnavailable) {
    return { kind: "unavailable", reason: "pricing_context_missing" };
  }

  const retentionRows = candidates.filter(row => row.conditions?.cacheRetention !== undefined);
  if (retentionRows.length > 0) {
    if (cacheWriteTokens > 0) {
      if (!context.cacheRetention) {
        return { kind: "unavailable", reason: "pricing_context_missing" };
      }
      candidates = retentionRows.filter(row => row.conditions?.cacheRetention === context.cacheRetention);
      if (candidates.length === 0) {
        return { kind: "unavailable", reason: "pricing_condition_unmatched" };
      }
    } else if (context.cacheRetention === "long" || context.cacheRetention === "short") {
      candidates = retentionRows.filter(row => row.conditions?.cacheRetention === context.cacheRetention);
    } else {
      candidates = retentionRows.filter(row => row.conditions?.cacheRetention === "short");
    }
  }

  return candidates.length === 1
    ? { kind: "matched", schedule: candidates[0]! }
    : { kind: "unavailable", reason: "pricing_schedule_invalid" };
}
