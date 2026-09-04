import { expect, test } from "bun:test";
import {
  resolveCost,
  resolveSummaryCost,
  type LaneBearingCost,
  type LaneBearingSummary,
} from "../src/cost-lanes";

/**
 * Unit coverage for gui/src/cost-lanes.ts — the module that decides which cost
 * figure a surface may show.
 *
 * This is honesty-critical resolution logic that previously had no direct
 * tests: a regression that reintroduced "$0.00" for subscription users, summed
 * the two lanes into one figure, or rendered a priced subtotal as complete
 * while unpriced traffic existed would have passed every source-grep in the
 * suite. These tests call the real functions, so they fail on behaviour rather
 * than on wording.
 */

const DIRECT = { estimatedCostUsd: 1.25, pricedRequests: 10, unpricedRequests: 2 };
const EQUIVALENT = { estimatedCostUsd: 0.5, pricedRequests: 4, unpricedRequests: 1 };

// ---- resolveCost: which lane answers for ONE request ------------------------

test("resolveCost: nothing to read is unpriced, never zero", () => {
  expect(resolveCost(undefined)).toEqual({ kind: "unpriced", estimate: null });
  expect(resolveCost(null)).toEqual({ kind: "unpriced", estimate: null });
});

test("resolveCost: direct outranks equivalent because it is money owed", () => {
  const cost = {
    kind: "value",
    estimate: { total: 9 },
    direct: { kind: "value", estimate: { total: 1 } },
    apiEquivalent: { kind: "value", estimate: { total: 2 } },
  } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(cost)).toEqual({ kind: "direct", estimate: { total: 1 } });
});

test("resolveCost: equivalent answers when no direct lane priced", () => {
  const cost = {
    kind: "value",
    apiEquivalent: { kind: "value", estimate: { total: 2 } },
  } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(cost)).toEqual({ kind: "api_equivalent", estimate: { total: 2 } });
});

test("resolveCost: an unavailable lane is skipped, not read as a value", () => {
  const cost = {
    kind: "unavailable",
    direct: { kind: "unavailable" },
    apiEquivalent: { kind: "value", estimate: { total: 3 } },
  } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(cost)).toEqual({ kind: "api_equivalent", estimate: { total: 3 } });
});

test("resolveCost: the bare legacy estimate answers only after both lanes pass", () => {
  // Pre-split remote proxy shape: no lanes at all, just a top-level estimate.
  const legacyOnly = { kind: "value", estimate: { total: 7 } } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(legacyOnly)).toEqual({ kind: "direct", estimate: { total: 7 } });

  // With lanes present, the legacy field loses to whichever lane is populated —
  // on a current server it is derived from the direct lane anyway.
  const withLanes = {
    kind: "value",
    estimate: { total: 7 },
    apiEquivalent: { kind: "value", estimate: { total: 2 } },
  } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(withLanes)).toEqual({ kind: "api_equivalent", estimate: { total: 2 } });

  // Selection is presence-based: a populated estimate object answers as direct
  // even at a $0 total (a genuinely free model row), because this module picks
  // the lane while each surface decides how to render the figure.
  const zero = { kind: "value", estimate: { total: 0 } } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(zero)).toEqual({ kind: "direct", estimate: { total: 0 } });
  // Absence is different: no estimate object means no lane answered.
  const absent = { kind: "value" } satisfies LaneBearingCost<{ total: number }>;
  expect(resolveCost(absent)).toEqual({ kind: "unpriced", estimate: null });
});

// ---- resolveSummaryCost: aggregate resolution over a whole range ------------

test("resolveSummaryCost: empty input resolves to nothing claimable", () => {
  expect(resolveSummaryCost(undefined)).toEqual({ direct: null, apiEquivalent: null, primary: null });
  expect(resolveSummaryCost(null)).toEqual({ direct: null, apiEquivalent: null, primary: null });
  expect(resolveSummaryCost({})).toEqual({ direct: null, apiEquivalent: null, primary: null });
});

test("resolveSummaryCost: a lane that priced nothing contributes nothing", () => {
  // The exact "$0.00 for subscription users" bug: a present-but-empty lane
  // must not become a rendered zero.
  const summary = {
    direct: { ...DIRECT, estimatedCostUsd: 0, pricedRequests: 0 },
    apiEquivalent: { ...EQUIVALENT, estimatedCostUsd: 0, pricedRequests: 0 },
  } satisfies LaneBearingSummary;
  expect(resolveSummaryCost(summary)).toEqual({ direct: null, apiEquivalent: null, primary: null });
});

test("resolveSummaryCost: a lane needs BOTH a valid total and priced requests", () => {
  // A positive total with no priced requests cannot happen from a correct
  // server; if it ever does, refusing it is safer than rendering it.
  expect(
    resolveSummaryCost({ direct: { ...DIRECT, pricedRequests: 0 } }).direct,
  ).toBeNull();
  // Negative and non-finite totals are rejected outright.
  expect(resolveSummaryCost({ direct: { ...DIRECT, estimatedCostUsd: -1 } }).direct).toBeNull();
  expect(resolveSummaryCost({ direct: { ...DIRECT, estimatedCostUsd: Number.NaN } }).direct).toBeNull();
  // And a priced count of zero disqualifies even an otherwise-valid lane.
  expect(resolveSummaryCost({ direct: { estimatedCostUsd: 5, pricedRequests: 0, unpricedRequests: 3 } }).primary).toBeNull();
});

test("resolveSummaryCost: both lanes are reported and direct wins the headline", () => {
  const resolved = resolveSummaryCost({ direct: DIRECT, apiEquivalent: EQUIVALENT });
  expect(resolved.direct).toEqual({ total: 1.25, pricedRequests: 10, unpricedRequests: 2 });
  expect(resolved.apiEquivalent).toEqual({ total: 0.5, pricedRequests: 4, unpricedRequests: 1 });
  expect(resolved.primary).toEqual({ kind: "direct", total: 1.25, unpricedRequests: 2 });
});

test("resolveSummaryCost: a subscription-only range headlines the equivalent lane", () => {
  const resolved = resolveSummaryCost({ apiEquivalent: EQUIVALENT });
  expect(resolved.primary).toEqual({ kind: "api_equivalent", total: 0.5, unpricedRequests: 1 });
});

test("resolveSummaryCost: the legacy aggregate is honoured only without any lane object", () => {
  // Pre-split proxy: a lone finite positive aggregate was direct-only by construction.
  const legacy = resolveSummaryCost({ estimatedCostUsd: 3.25, pricedRequests: 8 });
  expect(legacy.direct).toEqual({ total: 3.25, pricedRequests: 8, unpricedRequests: 0 });
  expect(legacy.primary).toEqual({ kind: "direct", total: 3.25, unpricedRequests: 0 });

  // Zero, negative, or garbage aggregates are not prices.
  expect(resolveSummaryCost({ estimatedCostUsd: 0 }).primary).toBeNull();
  expect(resolveSummaryCost({ estimatedCostUsd: -2 }).primary).toBeNull();
  expect(resolveSummaryCost({ estimatedCostUsd: Number.NaN }).primary).toBeNull();

  // Lane objects that exist but priced nothing must NOT fall through to the
  // legacy field — the lanes are the newer authority, and mixing them would
  // double-count a pre-split total against post-split traffic.
  const mixed = resolveSummaryCost({
    estimatedCostUsd: 3.25,
    direct: { estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0 },
  });
  expect(mixed.primary).toBeNull();

  // An unknown exclusion count renders as zero exclusions, not as a fabricated one.
  const noCounter = resolveSummaryCost({
    direct: { estimatedCostUsd: 1, pricedRequests: 2, unpricedRequests: Number.NaN },
  });
  expect(noCounter.direct?.unpricedRequests).toBe(0);
});
