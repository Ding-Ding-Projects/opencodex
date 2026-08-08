import { afterEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import {
  addRequestLog,
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const config = { providers: [] } as unknown as OcxConfig;

afterEach(() => clearRequestLogsForTests());

async function readLogs(): Promise<Array<Record<string, any>>> {
  const url = new URL("http://localhost/api/logs");
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  return await response!.json() as Array<Record<string, any>>;
}

function baseEntry(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    model: "claude-opus-5",
    provider: "anthropic-apikey",
    cacheRetention: "short",
    status: 200,
    durationMs: 2000,
    usageStatus: "reported",
    ...overrides,
  };
}

describe("GET /api/logs display metrics", () => {
  test("adds tok/s and cost without mutating the stored log", async () => {
    addRequestLog(baseEntry({
      usage: { inputTokens: 1000, outputTokens: 240 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "value", value: 120, estimated: false });
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.cost.total).toBeGreaterThan(0);
    expect(dto!.displayMetrics.cost.estimate.price.source).toBe("expected");
    expect(dto!.displayMetrics.cost.estimate.price).toMatchObject({
      scheduleId: "anthropic-apikey/claude-opus-5/cache-5m",
      verifiedAt: "2026-08-07",
      sourceRef: "https://platform.claude.com/docs/en/about-claude/pricing",
    });
    // stored entry stays clean
    expect(Object.hasOwn(getRequestLogEntries()[0]!, "displayMetrics")).toBe(false);
  });

  test("estimated positive output marks tok/s estimated and keeps cost value", async () => {
    addRequestLog(baseEntry({
      usageStatus: "estimated",
      usage: { inputTokens: 500, outputTokens: 25, estimated: true },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "value", value: 12.5, estimated: true });
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.estimated).toBe(true);
    expect(dto!.displayMetrics.cost.estimateReasons).toContain("usage_estimated");
    expect(dto!.displayMetrics.cost.estimateReasons).toContain("cache_detail_missing");
  });

  test("unmatched price is unavailable instead of zero", async () => {
    addRequestLog(baseEntry({
      provider: "no-such-provider",
      model: "no-such-model",
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond.kind).toBe("value");
    expect(dto!.displayMetrics.cost).toEqual({
      kind: "unavailable",
      reason: "price_unmatched",
      pricingReason: "price_unmatched",
    });
  });

  test("subscription products expose an exact unpriced-product reason", async () => {
    addRequestLog(baseEntry({
      provider: "anthropic",
      model: "claude-opus-5",
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({
      kind: "unavailable",
      reason: "price_unmatched",
      pricingReason: "pricing_product_unpriced",
    });
  });

  test("missing Anthropic cache tier is exposed when cache writes are present", async () => {
    addRequestLog(baseEntry({
      cacheRetention: undefined,
      usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 50 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({
      kind: "unavailable",
      reason: "price_unmatched",
      pricingReason: "pricing_context_missing",
    });
  });

  test("extreme finite timestamps fail closed in Logs without throwing", async () => {
    for (const timestamp of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
      clearRequestLogsForTests();
      addRequestLog(baseEntry({
        timestamp,
        model: "claude-sonnet-5",
        usage: { inputTokens: 100, outputTokens: 10 },
      }));
      const [dto] = await readLogs();
      expect(dto!.displayMetrics.cost).toEqual({
        kind: "unavailable",
        reason: "price_unmatched",
        pricingReason: "pricing_condition_unmatched",
      });
    }
  });

  test("invalid usage reasons never masquerade as pricing failures", async () => {
    const cases = [
      [{ inputTokens: Number.NaN, outputTokens: 1 }, "invalid_usage"],
      [{ inputTokens: 50, outputTokens: 1, cacheReadInputTokens: 40, cacheCreationInputTokens: 20 }, "invalid_cache_breakdown"],
    ] as const;
    for (const [usage, reason] of cases) {
      clearRequestLogsForTests();
      addRequestLog(baseEntry({ usage: usage as RequestLogEntry["usage"] }));
      const [dto] = await readLogs();
      expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason });
      expect(dto!.displayMetrics.cost).not.toHaveProperty("pricingReason");
    }
  });

  test("combo attempts with missing or invalid usage omit pricingReason", async () => {
    for (const usage of [undefined, { inputTokens: Number.NaN, outputTokens: 1 }]) {
      clearRequestLogsForTests();
      addRequestLog(baseEntry({
        provider: "combo",
        model: "combo/invalid",
        usage: { inputTokens: 100, outputTokens: 10 },
        attempts: [{
          ordinal: 1,
          timestamp: Date.now(),
          provider: "deepseek",
          model: "deepseek-v4-flash",
          adapter: "openai-chat",
          status: 200,
          durationMs: 1,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: usage ? "reported" : "unreported",
          ...(usage ? { usage } : {}),
        }],
      }));
      const [dto] = await readLogs();
      expect(dto!.displayMetrics.cost.kind).toBe("unavailable");
      expect(dto!.displayMetrics.cost).not.toHaveProperty("pricingReason");
    }
  });

  test("usage-missing rows are unavailable for both metrics", async () => {
    addRequestLog(baseEntry({ usageStatus: "unreported", usage: undefined }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "unavailable", reason: "usage_missing" });
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "usage_missing" });
  });

  test("zero output is output_missing, not 0 tok/s", async () => {
    addRequestLog(baseEntry({ usage: { inputTokens: 100, outputTokens: 0 } }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "unavailable", reason: "output_missing" });
  });

  test("enriches combo attempts and fails top-level cost closed on unmatched attempt", async () => {
    addRequestLog(baseEntry({
      model: "combo/my-combo",
      provider: "combo",
      usage: { inputTokens: 200, outputTokens: 20 },
      attempts: [
        {
          ordinal: 1,
          provider: "anthropic-apikey",
          model: "claude-opus-5",
          adapter: "anthropic",
          status: 200,
          durationMs: 900,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
        {
          ordinal: 2,
          provider: "unpriced-provider",
          model: "unpriced-model",
          adapter: "openai-chat",
          status: 200,
          durationMs: 1100,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      ],
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({
      kind: "unavailable",
      reason: "combo_attempt_unavailable",
      pricingReason: "price_unmatched",
    });
    expect(dto!.attempts).toHaveLength(2);
    expect(dto!.attempts[0].displayMetrics.cost.kind).toBe("value");
    expect(dto!.attempts[0].displayMetrics.tokPerSecond.kind).toBe("value");
    expect(dto!.attempts[1].displayMetrics.cost).toEqual({
      kind: "unavailable",
      reason: "price_unmatched",
      pricingReason: "price_unmatched",
    });
  });

  test("legacy recoverable cache row is priced, not invalid_cache_breakdown", async () => {
    // canonical reading R=60,W=20 contradicts I=70; legacy retry recovers R=40,W=20.
    addRequestLog(baseEntry({
      usage: { inputTokens: 70, outputTokens: 10, cachedInputTokens: 60, cacheCreationInputTokens: 20 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost.kind).toBe("value");
  });

  test("doubly-contradictory cache row is invalid_cache_breakdown", async () => {
    addRequestLog(baseEntry({
      usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 60, cacheCreationInputTokens: 20 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "invalid_cache_breakdown" });
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
