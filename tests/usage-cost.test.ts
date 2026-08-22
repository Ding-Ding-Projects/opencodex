import { describe, expect, test } from "bun:test";
import {
  calculateCost,
  estimateAttemptCost,
  estimateComboCost,
  estimateRequestCost,
  estimateRequestCostLanes,
  effectiveServiceTier,
  pricingSourceClassification,
  normalizeCostTokens,
  pricingUnavailableReason,
  resolveMatchedPrice,
  resolveMatchedPriceResult,
  tokensPerSecond,
} from "../src/usage/cost";
import {
  OFFICIAL_PRICE_SCHEDULES,
  resolveOfficialPriceSchedule,
  validateOfficialPriceSchedules,
  type OfficialPriceSchedule,
} from "../src/usage/expected-prices";

const VERIFIED_AT = "2026-08-07" as const;
const TEST_SOURCE = "https://example.test/pricing";
const BASE_SCHEDULE: OfficialPriceSchedule = {
  scheduleId: "test/p/m/standard",
  provider: "p",
  modelId: "m",
  cost4: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 },
  sourceUrl: TEST_SOURCE,
  verifiedAt: VERIFIED_AT,
  status: "verified",
};

function requestCost(
  provider: string,
  model: string,
  overrides: Partial<Parameters<typeof estimateRequestCost>[0]> = {},
) {
  return estimateRequestCost({
    provider,
    model,
    usageStatus: "reported",
    usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    ...overrides,
  });
}

describe("normalizeCostTokens", () => {
  test("normalizes OpenAI cached input without double charging", () => {
    expect(normalizeCostTokens({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 }))
      .toEqual({ input: 60, output: 10, cacheRead: 40, cacheWrite: 0 });
  });

  test("normalizes Anthropic read/write splits without double charging", () => {
    const tokens = normalizeCostTokens({
      inputTokens: 160,
      outputTokens: 10,
      cachedInputTokens: 40,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 20,
    });
    expect(tokens).toEqual({ input: 100, output: 10, cacheRead: 40, cacheWrite: 20 });
    const cost = calculateCost(tokens!, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(cost.total).toBeCloseTo((300 + 150 + 12 + 75) / 1e6, 12);
  });

  test("keeps canonical cached-input semantics when they are valid", () => {
    expect(normalizeCostTokens({
      inputTokens: 160,
      outputTokens: 10,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 20,
    })).toEqual({ input: 80, output: 10, cacheRead: 60, cacheWrite: 20 });
  });

  test("recovers legacy read-plus-write cachedInputTokens only after contradiction", () => {
    expect(normalizeCostTokens({
      inputTokens: 70,
      outputTokens: 10,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 20,
    })).toEqual({ input: 10, output: 10, cacheRead: 40, cacheWrite: 20 });
  });

  test("fails closed for contradictory or invalid token counts", () => {
    expect(normalizeCostTokens({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 20,
    })).toBeNull();
    expect(normalizeCostTokens({ inputTokens: NaN, outputTokens: 1 })).toBeNull();
    expect(normalizeCostTokens({ inputTokens: -1, outputTokens: 1 })).toBeNull();
  });
});

describe("authoritative official schedules", () => {
  test("contains only exact direct products with dated first-party HTTPS sources", () => {
    // 45 = 25 prior non-OpenAI rows + 12 OpenAI rows + 8 xAI rows
    // (Grok 4.5/4.6 standard and priority short/long-context schedules).
    expect(OFFICIAL_PRICE_SCHEDULES).toHaveLength(45);
    expect(validateOfficialPriceSchedules(OFFICIAL_PRICE_SCHEDULES)).toEqual([]);
    // Every OpenAI model carries all three bands, so none can lose one silently.
    for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]) {
      const bands = OFFICIAL_PRICE_SCHEDULES
        .filter(row => row.provider === "openai-apikey" && row.modelId === modelId)
        .map(row => row.tier?.band)
        .sort();
      expect(bands, modelId).toEqual(["long_context", "priority", "standard"]);
    }
    const providers = new Set(OFFICIAL_PRICE_SCHEDULES.map(row => row.provider));
    expect(providers).toEqual(new Set(["anthropic-apikey", "openai-apikey", "xai", "deepseek", "moonshot"]));
    for (const row of OFFICIAL_PRICE_SCHEDULES) {
      expect(row.verifiedAt).toMatch(/^2026-08-(07|09|21)$/);
      expect(row.status).toBe("verified");
      expect(row.sourceUrl.startsWith("https://")).toBe(true);
    }
  });

  test("rejects duplicate, zero, invalid, and incomplete schedules", () => {
    const duplicate = [{ ...BASE_SCHEDULE }, { ...BASE_SCHEDULE, scheduleId: "duplicate-id" }];
    expect(validateOfficialPriceSchedules(duplicate).some(error => error.includes("duplicate schedule selector"))).toBe(true);
    expect(validateOfficialPriceSchedules([{ ...BASE_SCHEDULE, cost4: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]))
      .toContain("invalid cost tuple: test/p/m/standard");
    expect(validateOfficialPriceSchedules([{ ...BASE_SCHEDULE, cost4: { ...BASE_SCHEDULE.cost4, input: Number.NaN } }]))
      .toContain("invalid cost tuple: test/p/m/standard");
    expect(validateOfficialPriceSchedules([{ ...BASE_SCHEDULE, sourceUrl: "" }]))
      .toContain("invalid source URL: test/p/m/standard");
    expect(validateOfficialPriceSchedules([{
      ...BASE_SCHEDULE,
      conditions: { cacheRetention: "forever" as "short" },
    }])).toContain("invalid cache retention: test/p/m/standard");
    const overlapping: OfficialPriceSchedule[] = [
      { ...BASE_SCHEDULE, conditions: { validThrough: "2026-08-31" } },
      { ...BASE_SCHEDULE, scheduleId: "test/p/m/second", conditions: { validFrom: "2026-08-31" } },
    ];
    expect(validateOfficialPriceSchedules(overlapping).some(error => error.includes("overlapping schedule ranges"))).toBe(true);
    for (const impossible of ["2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10"]) {
      expect(validateOfficialPriceSchedules([{
        ...BASE_SCHEDULE,
        conditions: { validFrom: impossible },
      }])).toContain("invalid valid-from date: test/p/m/standard");
    }
    expect(resolveOfficialPriceSchedule("p", "m", {}, 0, duplicate)).toEqual({
      kind: "unavailable",
      reason: "pricing_schedule_invalid",
    });
  });

  test("resolves exact current Anthropic direct API rows", () => {
    const cases = [
      ["claude-fable-5", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
      ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
      ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
      ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
    ] as const;
    for (const [modelId, cost4] of cases) {
      expect(resolveMatchedPrice("anthropic-apikey", modelId, { cacheRetention: "short" }))
        .toMatchObject({ provider: "anthropic-apikey", modelId, cost4, verifiedAt: VERIFIED_AT });
    }
  });

  test("selects Anthropic 5-minute versus 1-hour cache writes", () => {
    const short = requestCost("anthropic-apikey", "claude-opus-5", {
      cacheRetention: "short",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
    });
    const long = requestCost("anthropic-apikey", "claude-opus-5", {
      cacheRetention: "long",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
    });
    expect(short?.price?.scheduleId).toEndWith("cache-5m");
    expect(short?.cost.total).toBeCloseTo(6.25, 9);
    expect(long?.price?.scheduleId).toEndWith("cache-1h");
    expect(long?.cost.total).toBeCloseTo(10, 9);
  });

  test("requires Anthropic cache retention only when cache writes affect the cost", () => {
    expect(requestCost("anthropic-apikey", "claude-opus-5")).not.toBeNull();
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000 };
    expect(requestCost("anthropic-apikey", "claude-opus-5", { usage })).toBeNull();
    expect(pricingUnavailableReason({ provider: "anthropic-apikey", model: "claude-opus-5", usage }))
      .toBe("pricing_context_missing");
  });

  test("switches Sonnet 5 from introductory to standard pricing at 2026-09-01", () => {
    const introductory = requestCost("anthropic-apikey", "claude-sonnet-5", {
      cacheRetention: "short",
      timestamp: Date.parse("2026-08-31T23:59:59.999Z"),
    });
    expect(introductory?.price?.cost4).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(introductory?.price?.scheduleId).toEndWith("through-2026-08-31");

    const standard = requestCost("anthropic-apikey", "claude-sonnet-5", {
      cacheRetention: "short",
      timestamp: Date.parse("2026-09-01T00:00:00.000Z"),
    });
    expect(standard?.price?.cost4).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(standard?.price?.scheduleId).toEndWith("from-2026-09-01");
  });

  test("extreme finite timestamps fail closed without throwing", () => {
    for (const timestamp of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(() => requestCost("anthropic-apikey", "claude-sonnet-5", {
        cacheRetention: "short",
        timestamp,
      })).not.toThrow();
      expect(requestCost("anthropic-apikey", "claude-sonnet-5", {
        cacheRetention: "short",
        timestamp,
      })).toBeNull();
      expect(pricingUnavailableReason({
        provider: "anthropic-apikey",
        model: "claude-sonnet-5",
        usage: { inputTokens: 1, outputTokens: 1 },
        usageStatus: "reported",
        cacheRetention: "short",
        timestamp,
      })).toBe("pricing_condition_unmatched");
    }
  });

  test("custom schedules stay uncached while immutable official schedules resolve repeatedly", () => {
    const custom: OfficialPriceSchedule[] = [{ ...BASE_SCHEDULE }];
    expect(resolveOfficialPriceSchedule("p", "m", {}, 0, custom)).toMatchObject({
      kind: "matched",
      schedule: { cost4: { input: 1 } },
    });
    custom[0] = { ...BASE_SCHEDULE, cost4: { ...BASE_SCHEDULE.cost4, input: 9 } };
    expect(resolveOfficialPriceSchedule("p", "m", {}, 0, custom)).toMatchObject({
      kind: "matched",
      schedule: { cost4: { input: 9 } },
    });
    for (let index = 0; index < 600; index++) {
      expect(resolveOfficialPriceSchedule("deepseek", "deepseek-v4-flash", {
        timestamp: Date.UTC(2026, 7, 7 + (index % 2)),
      }).kind).toBe("matched");
    }
  });

  test("combo attempts select date-conditional prices from their own timestamps", () => {
    const combo = estimateComboCost([
      {
        ordinal: 1,
        timestamp: Date.parse("2026-08-31T23:59:59.999Z"),
        provider: "anthropic-apikey",
        model: "claude-sonnet-5",
        cacheRetention: "short",
        usageStatus: "reported",
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
      {
        ordinal: 2,
        timestamp: Date.parse("2026-09-01T00:00:00.000Z"),
        provider: "anthropic-apikey",
        model: "claude-sonnet-5",
        cacheRetention: "short",
        usageStatus: "reported",
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    ], undefined, { timestamp: Date.parse("2026-08-31T00:00:00.000Z") });
    expect(combo?.cost.total).toBeCloseTo(5, 9);
    expect(combo?.attempts?.map(attempt => attempt.price.scheduleId)).toEqual([
      "anthropic-apikey/claude-sonnet-5/cache-5m/through-2026-08-31",
      "anthropic-apikey/claude-sonnet-5/cache-5m/from-2026-09-01",
    ]);
  });

  test("resolves exact current DeepSeek direct IDs and removes stale IDs", () => {
    expect(resolveMatchedPrice("deepseek", "deepseek-v4-flash")?.cost4)
      .toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 });
    expect(resolveMatchedPrice("deepseek", "deepseek-v4-pro")?.cost4)
      .toEqual({ input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 });
    expect(resolveMatchedPrice("deepseek", "deepseek-chat")).toBeNull();
    expect(resolveMatchedPrice("deepseek", "deepseek-reasoner")).toBeNull();
  });

  test("resolves exact Moonshot PAYG IDs only", () => {
    expect(resolveMatchedPrice("moonshot", "kimi-k3")?.cost4)
      .toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
    expect(resolveMatchedPrice("moonshot", "kimi-k2.7-code")?.cost4)
      .toEqual({ input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 });
    expect(resolveMatchedPrice("moonshot", "kimi-k2.7-code-highspeed")?.cost4)
      .toEqual({ input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 });
    expect(resolveMatchedPrice("moonshot", "kimi-k2.6")?.cost4)
      .toEqual({ input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.95 });
    expect(resolveMatchedPrice("moonshot", "kimi-k2.5")?.cost4)
      .toEqual({ input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.6 });
  });
});

describe("product and condition isolation", () => {
  test("subscription products never inherit direct vendor API prices", () => {
    for (const [provider, model] of [
      ["anthropic", "claude-opus-5"],
      ["cursor", "claude-fable-5"],
      ["kiro", "claude-opus-4.6"],
      ["google-antigravity", "claude-sonnet-4-6"],
      ["kimi", "kimi-k2.7-code"],
      ["kimi-code", "kimi-k2.7-code"],
      ["alibaba-token-plan", "qwen3.8-max-preview"],
      ["minimax", "MiniMax-M2.1-highspeed"],
      ["minimax-cn", "MiniMax-M2.1-highspeed"],
    ] as const) {
      expect(resolveMatchedPrice(provider, model)).toBeNull();
      expect(resolveMatchedPriceResult(provider, model)).toEqual({
        kind: "unavailable",
        reason: "pricing_product_unpriced",
      });
    }
  });

  test("routers and arbitrary same-model providers never inherit a vendor rate", () => {
    for (const provider of ["openrouter", "orcarouter", "custom-provider"]) {
      expect(resolveMatchedPrice(provider, "claude-opus-5")).toBeNull();
    }
  });

  test("only known subscription account suffixes collapse for billing", () => {
    expect(resolveMatchedPrice("anthropic-apikey-p123abc", "claude-opus-5", { cacheRetention: "short" }))
      .toBeNull();
    expect(resolveMatchedPriceResult("anthropic-p123abc", "claude-opus-5")).toEqual({
      kind: "unavailable",
      reason: "pricing_product_unpriced",
    });
  });

  test("OpenAI direct API prices the standard short-context row", () => {
    const usage = { inputTokens: 1_000, outputTokens: 100 };
    const standard = requestCost("openai-apikey", "gpt-5.6-sol", { usage, promptInputTokens: 1_000 });
    expect(standard?.price).toMatchObject({
      provider: "openai-apikey",
      modelId: "gpt-5.6-sol",
      cost4: { input: 5, cacheRead: 0.5, output: 30 },
      verifiedAt: "2026-08-09",
      tier: { band: "standard" },
    });
    expect(standard?.price?.scheduleId).toContain("standard/short-context");
    expect(effectiveServiceTier({ responseServiceTier: "fast" })).toBe("priority");
    expect(effectiveServiceTier({ responseServiceTier: "default", requestedServiceTier: "priority" })).toBe("default");
    expect(effectiveServiceTier({ provider: "xai", requestedServiceTier: "priority" })).toBe("standard");
    expect(effectiveServiceTier({ provider: "xai", configuredServiceTier: "priority" })).toBe("standard");
    expect(effectiveServiceTier({ provider: "xai", responseServiceTier: "default", requestedServiceTier: "priority" })).toBe("standard");
    expect(effectiveServiceTier({ provider: "xai", responseServiceTier: "priority", requestedServiceTier: "priority" })).toBe("priority");
  });

  test("the served-tier wire name 'default' resolves to the standard band", () => {
    // An OpenAI response echoes service_tier: "default" for ordinary traffic and
    // effectiveServiceTier() prefers that response-confirmed value, so without
    // the fold every request that actually reported its tier went unpriced.
    const usage = { inputTokens: 1_000, outputTokens: 100 };
    const served = requestCost("openai-apikey", "gpt-5.6-sol", {
      usage,
      promptInputTokens: 1_000,
      serviceTier: "default",
    });
    expect(served?.price?.scheduleId).toContain("standard/short-context");
    expect(served?.cost.total).toBeCloseTo(
      requestCost("openai-apikey", "gpt-5.6-sol", { usage, promptInputTokens: 1_000 })!.cost.total,
      12,
    );
  });

  test("OpenAI Fast tier prices at the published uniform multiplier", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    // Fast multiplies every token type by the same factor: sol/terra/luna 2x,
    // gpt-5.5 2.5x (https://openai.com/api-fast-mode/).
    for (const [model, factor] of [
      ["gpt-5.6-sol", 2],
      ["gpt-5.6-terra", 2],
      ["gpt-5.6-luna", 2],
      ["gpt-5.5", 2.5],
    ] as const) {
      const base = requestCost("openai-apikey", model, { usage, promptInputTokens: 1_000 });
      for (const serviceTier of ["priority", "fast"] as const) {
        const fast = requestCost("openai-apikey", model, {
          usage,
          promptInputTokens: 1_000,
          serviceTier,
        });
        expect(fast?.price?.tier).toMatchObject({ band: "priority" });
        expect(fast?.price?.scheduleId).toContain("priority");
        // Uniform means the whole bill scales, not just one component.
        expect(fast?.cost.total).toBeCloseTo(base!.cost.total * factor, 9);
        expect(fast?.cost.input).toBeCloseTo(base!.cost.input * factor, 9);
        expect(fast?.cost.output).toBeCloseTo(base!.cost.output * factor, 9);
      }
    }
  });

  test("OpenAI long context repricing is exclusive at exactly 272,000 tokens", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const at = (promptInputTokens: number) =>
      requestCost("openai-apikey", "gpt-5.6-sol", { usage, promptInputTokens });

    // Just below, exactly at, and just above. The published band is "> 272K",
    // so the boundary token count itself is still the short rate.
    expect(at(271_999)?.price?.scheduleId).toContain("standard/short-context");
    expect(at(272_000)?.price?.scheduleId).toContain("standard/short-context");
    expect(at(272_001)?.price?.scheduleId).toContain("standard/long-context");

    expect(at(272_000)?.price?.tier).toMatchObject({ band: "standard" });
    expect(at(272_001)?.price?.tier).toMatchObject({
      band: "long_context",
      multiplier: { input: 2, output: 1.5, cacheRead: 2, cacheWrite: 2 },
    });

    // 2x input and 1.5x output for the full request, not a flat doubling.
    const short = at(272_000)!;
    const long = at(272_001)!;
    expect(long.cost.input).toBeCloseTo(short.cost.input * 2, 9);
    expect(long.cost.output).toBeCloseTo(short.cost.output * 1.5, 9);
    expect(long.cost.total).toBeGreaterThan(short.cost.total);
  });

  test("a missing prompt size is unpriced rather than assumed short", () => {
    // The prompt size is what chooses between the two bands, so its absence is
    // a missing price input — never a licence to bill the cheaper one.
    const usage = { inputTokens: 1_000, outputTokens: 100 };
    expect(requestCost("openai-apikey", "gpt-5.6-sol", { usage })).toBeNull();
    expect(pricingUnavailableReason({
      provider: "openai-apikey",
      model: "gpt-5.6-sol",
      usage,
    })).toBe("pricing_context_missing");
  });

  test("a Fast request above the long-context boundary declines rather than guessing", () => {
    // OpenAI does not serve long context in Fast mode, so this request was
    // served as something else — but the collapsed tier scalar cannot say
    // whether Fast was confirmed or merely requested and then downgraded.
    // Pricing it at either band would be a guess, so it matches no row.
    const usage = { inputTokens: 1_000, outputTokens: 100 };
    expect(requestCost("openai-apikey", "gpt-5.6-sol", {
      usage,
      promptInputTokens: 400_000,
      serviceTier: "priority",
    })).toBeNull();
    expect(pricingUnavailableReason({
      provider: "openai-apikey",
      model: "gpt-5.6-sol",
      usage,
      promptInputTokens: 400_000,
      serviceTier: "priority",
    })).toBe("pricing_condition_unmatched");
  });

  test("both accounting lanes get the same band, because they read one authority", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const shape = { usageStatus: "reported" as const, usage, model: "gpt-5.6-sol" };
    for (const promptInputTokens of [272_001, 1_000]) {
      const direct = estimateRequestCostLanes({ ...shape, provider: "openai-apikey", promptInputTokens });
      const equivalent = estimateRequestCostLanes({ ...shape, provider: "chatgpt-pabcdef", promptInputTokens });
      expect(direct.direct?.price?.scheduleId).toBe(equivalent.apiEquivalent?.price?.scheduleId);
      expect(direct.direct?.cost.total).toBeCloseTo(equivalent.apiEquivalent!.cost.total, 12);
    }
    // And a Fast subscription request is multiplied in the comparison lane too.
    const fast = estimateRequestCostLanes({
      ...shape, provider: "chatgpt-pabcdef", promptInputTokens: 1_000, serviceTier: "priority",
    });
    const base = estimateRequestCostLanes({
      ...shape, provider: "chatgpt-pabcdef", promptInputTokens: 1_000,
    });
    expect(fast.apiEquivalent?.cost.total).toBeCloseTo(base.apiEquivalent!.cost.total * 2, 9);
  });

  test("prices supported OpenAI direct IDs and preserves unavailable cache writes", () => {
    // `inputTokens` is inclusive of the cache read, so `classifyUsageForCost` meters
    // this row as 900k uncached input + 100k output + 100k cache read — never 1M
    // input alongside a separately charged 100k, which would bill the cached tokens
    // twice. Each total below is that split against the published per-1M rates:
    //   sol   (5 / 30 / 0.5)     -> 0.9*5    + 0.1*30   + 0.1*0.5   = 7.55
    //   terra (2 / 12 / 0.2)     -> 0.9*2    + 0.1*12   + 0.1*0.2   = 3.02
    //   luna  (0.2 / 1.2 / 0.02) -> 0.9*0.2  + 0.1*1.2  + 0.1*0.02  = 0.302
    //   5.5   (5 / 30 / 0.5)     -> same as sol; its cache WRITE is unavailable,
    //                               which this row never exercises (no cache write).
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 100_000 };
    // Two lanes touched this block and disagreed, so the resolution is recorded
    // rather than left to look like one lane simply won.
    //
    // The band work added `promptInputTokens`, which is now required: the prompt
    // size is what selects the band, so without it the resolver correctly answers
    // `pricing_context_missing` instead of guessing the short rate. 1,000 keeps
    // these cases in the short band, where the rate is the same one they always
    // used — adding bands did not change the short figures.
    //
    // The figures themselves are the *corrected* ones. The originals (7.85 /
    // 3.14 / 0.314 / 7.85) were all uniformly consistent with output priced at
    // 110k tokens, where this usage meters to 100k — one hand-computation slip
    // applied four times. These were re-derived by running the estimator rather
    // than on paper: `inputTokens` is inclusive, so the usage below is 900k
    // uncached input, 100k output and 100k cache read.
    const short = { usage, promptInputTokens: 1_000 };
    expect(requestCost("openai-apikey", "gpt-5.6-sol", short)?.cost.total).toBeCloseTo(7.55, 9);
    expect(requestCost("openai-apikey", "gpt-5.6-terra", short)?.cost.total).toBeCloseTo(3.02, 9);
    expect(requestCost("openai-apikey", "gpt-5.6-luna", short)?.cost.total).toBeCloseTo(0.302, 9);
    expect(requestCost("openai-apikey", "gpt-5.5", short)?.cost.total).toBeCloseTo(7.55, 9);
    expect(requestCost("openai-apikey", "gpt-5.6-sol-pro", short)).toBeNull();
    expect(requestCost("openai-apikey", "gpt-5.5", {
      usage: { inputTokens: 1_000, outputTokens: 1, cacheCreationInputTokens: 1 },
      promptInputTokens: 1_000,
    })).toBeNull();
    expect(pricingUnavailableReason({
      provider: "openai-apikey",
      model: "gpt-5.5",
      usage: { inputTokens: 1_000, outputTokens: 1, cacheCreationInputTokens: 1 },
      promptInputTokens: 1_000,
    })).toBe("pricing_context_missing");
  });

  test("keeps direct API and supported subscription API-equivalent lanes separate", () => {
    const direct = estimateRequestCostLanes({
      provider: "openai-apikey",
      model: "gpt-5.6-luna",
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 10 },
      promptInputTokens: 100,
    });
    expect(direct.direct).toMatchObject({ lane: "direct", sourceClassification: "direct_api_key" });
    expect(direct.apiEquivalent).toBeNull();

    const subscription = estimateRequestCostLanes({
      provider: "chatgpt-pabcdef",
      model: "gpt-5.6-luna",
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 10 },
      promptInputTokens: 100,
    });
    expect(subscription.direct).toBeNull();
    expect(subscription.apiEquivalent).toMatchObject({
      lane: "api_equivalent",
      sourceClassification: "subscription_api_equivalent",
      price: { provider: "openai-apikey", modelId: "gpt-5.6-luna" },
    });
    expect(pricingSourceClassification("openai-apikey")?.lane).toBe("direct");
    expect(pricingSourceClassification("anthropic-pabcdef")?.lane).toBe("api_equivalent");
    expect(pricingSourceClassification("openrouter")).toBeNull();
  });

  test("Google, Vertex, and xAI conditional products remain unpriced without persisted thresholds or region", () => {
    for (const [provider, model] of [
      ["google", "gemini-3.6-flash"],
      ["google-vertex", "gemini-3-pro"],
      ["xai", "grok-4"],
    ] as const) {
      expect(resolveMatchedPriceResult(provider, model)).toEqual({
        kind: "unavailable",
        reason: "pricing_context_missing",
      });
    }
  });
});

describe("request and combo estimates", () => {
  test("prices exact direct requests and preserves estimated usage status", () => {
    const estimate = requestCost("deepseek", "deepseek-v4-flash", {
      usageStatus: "estimated",
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, estimated: true },
    });
    expect(estimate?.cost.total).toBeCloseTo(0.168, 9);
    expect(estimate?.estimated).toBe(true);
  });

  test("sums exact direct attempts", () => {
    const combo = estimateComboCost([
      {
        ordinal: 1,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usageStatus: "reported",
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
      {
        ordinal: 2,
        provider: "moonshot",
        model: "kimi-k2.5",
        usageStatus: "reported",
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    ]);
    expect(combo?.cost.total).toBeCloseTo(0.74, 9);
    expect(combo?.attempts).toHaveLength(2);
  });

  test("fails a combo closed when one attempt is a subscription product", () => {
    expect(estimateComboCost([
      {
        ordinal: 1,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      {
        ordinal: 2,
        provider: "cursor",
        model: "claude-opus-5",
        usageStatus: "estimated",
        usage: { inputTokens: 100, outputTokens: 10, estimated: true },
      },
    ])).toBeNull();
  });

  test("requires usage for request and attempt estimates", () => {
    expect(estimateRequestCost({ provider: "deepseek", model: "deepseek-v4-flash", usageStatus: "unreported" })).toBeNull();
    expect(estimateAttemptCost({ ordinal: 1, provider: "deepseek", model: "deepseek-v4-flash", usageStatus: "unreported" })).toBeNull();
    expect(estimateComboCost([])).toBeNull();
  });
});

describe("tokensPerSecond", () => {
  test("handles valid and unavailable edges", () => {
    expect(tokensPerSecond(100, 2000)).toBe(50);
    expect(tokensPerSecond(0, 2000)).toBeNull();
    expect(tokensPerSecond(100, 0)).toBeNull();
    expect(tokensPerSecond(-1, 2000)).toBeNull();
    expect(tokensPerSecond(Number.NaN, 2000)).toBeNull();
  });
});
