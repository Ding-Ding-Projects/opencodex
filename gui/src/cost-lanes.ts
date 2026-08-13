/**
 * Which cost figure a surface should show, and what it is allowed to claim.
 *
 * The server splits cost accounting into two deliberately isolated lanes
 * (`src/usage/cost.ts`): `direct` is real per-token billing for API-key
 * products, and `api_equivalent` is an explicitly *non-billing* comparison for
 * subscription/OAuth traffic. A request belongs to exactly one of them, and a
 * product in neither set has no published price at all.
 *
 * Every GUI cost surface used to read only the direct lane. That is correct for
 * an API-key user and silently wrong for everybody else: a subscription session
 * has no direct figure, so the surface fell through to `0` and rendered
 * "$0.000" — asserting free for traffic that has a perfectly well-defined
 * API-equivalent value. This module is the single place that decides which lane
 * answers, so no surface can quietly reintroduce that fallthrough.
 *
 * The resolution is deliberately *not* a sum. Adding an api-equivalent total to
 * a direct total would present non-billing money as billable, which is the exact
 * misreading the two-lane split exists to prevent. Lanes stay separate all the
 * way to the pixel; a caller that wants both renders both, labelled.
 */

export type PricingSourceClassification = "direct_api_key" | "subscription_api_equivalent";

/**
 * What a surface should render. `unpriced` means no published schedule covers
 * this traffic — it is rendered as an em dash and a reason, never as `$0`,
 * because zero is a claim about price and absence is not.
 */
export type CostDisplayKind = "direct" | "api_equivalent" | "unpriced";

/** One lane's per-request result as the management API serializes it. */
export interface CostLaneResult<E> {
  kind: "value" | "unavailable";
  sourceClassification?: PricingSourceClassification;
  estimate?: E;
}

/**
 * The per-request cost payload, generic over the estimate shape so each page
 * keeps its own local estimate type rather than being forced onto a shared one.
 * `direct`/`apiEquivalent` are optional because the server omits both when the
 * provider belongs to neither lane, and because an older remote proxy predates
 * the split entirely.
 */
export interface LaneBearingCost<E> {
  kind: "value" | "unavailable";
  estimate?: E;
  direct?: CostLaneResult<E>;
  apiEquivalent?: CostLaneResult<E>;
}

export interface ResolvedCost<E> {
  kind: CostDisplayKind;
  estimate: E | null;
}

/**
 * Pick the lane a single request should display.
 *
 * Direct wins when present because it is the only lane that represents money
 * actually owed. The bare top-level `estimate` is checked *after* the lanes and
 * treated as direct: on a current server it is populated from the direct lane
 * anyway, so it only ever answers for a pre-split remote proxy, where a value
 * there did mean real API-key billing.
 */
export function resolveCost<E>(cost: LaneBearingCost<E> | undefined | null): ResolvedCost<E> {
  if (!cost) return { kind: "unpriced", estimate: null };
  if (cost.direct?.kind === "value" && cost.direct.estimate) {
    return { kind: "direct", estimate: cost.direct.estimate };
  }
  if (cost.apiEquivalent?.kind === "value" && cost.apiEquivalent.estimate) {
    return { kind: "api_equivalent", estimate: cost.apiEquivalent.estimate };
  }
  if (cost.kind === "value" && cost.estimate) {
    return { kind: "direct", estimate: cost.estimate };
  }
  return { kind: "unpriced", estimate: null };
}

/** Per-lane aggregate totals as `/api/usage` serializes them. */
export interface PricingLaneTotals {
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface ResolvedLaneTotal {
  total: number;
  pricedRequests: number;
}

/**
 * Aggregate resolution for a whole range.
 *
 * Both lanes can be non-empty at once — one machine can hold an API key and a
 * subscription — so both are reported and the caller shows both. `primary` is
 * only the headline for surfaces with room for exactly one figure (the app-bar
 * chip); it prefers direct because a real bill outranks a comparison.
 *
 * A lane counts as present only when it actually priced something. A lane that
 * priced nothing contributes `0`, and rendering that `0` is the bug this whole
 * module exists to remove.
 */
export interface ResolvedSummaryCost {
  direct: ResolvedLaneTotal | null;
  apiEquivalent: ResolvedLaneTotal | null;
  primary: { kind: "direct" | "api_equivalent"; total: number } | null;
}

export interface LaneBearingSummary {
  estimatedCostUsd?: number;
  pricedRequests?: number;
  direct?: PricingLaneTotals;
  apiEquivalent?: PricingLaneTotals;
}

function laneTotal(lane: PricingLaneTotals | undefined): ResolvedLaneTotal | null {
  if (!lane) return null;
  if (!Number.isFinite(lane.estimatedCostUsd) || lane.estimatedCostUsd < 0) return null;
  if (!(lane.pricedRequests > 0)) return null;
  return { total: lane.estimatedCostUsd, pricedRequests: lane.pricedRequests };
}

export function resolveSummaryCost(summary: LaneBearingSummary | undefined | null): ResolvedSummaryCost {
  if (!summary) return { direct: null, apiEquivalent: null, primary: null };
  let direct = laneTotal(summary.direct);
  const apiEquivalent = laneTotal(summary.apiEquivalent);

  // Pre-split remote proxy: no lane objects at all, but a legacy aggregate that
  // was direct-only by construction. Honour it rather than blanking the meter.
  if (!direct && !apiEquivalent && !summary.direct && !summary.apiEquivalent) {
    const legacy = summary.estimatedCostUsd;
    if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0) {
      direct = { total: legacy, pricedRequests: summary.pricedRequests ?? 0 };
    }
  }

  const primary = direct
    ? { kind: "direct" as const, total: direct.total }
    : apiEquivalent
      ? { kind: "api_equivalent" as const, total: apiEquivalent.total }
      : null;
  return { direct, apiEquivalent, primary };
}
