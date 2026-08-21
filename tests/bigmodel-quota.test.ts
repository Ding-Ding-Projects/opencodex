import { afterEach, describe, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports, parseZaiQuotaLimits } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

describe("BigModel coding-plan quota", () => {
  afterEach(() => {
    clearProviderQuotaCache();
  });

  test("maps token, weekly, and TIME_LIMIT unit 5 MCP rows without guessing unknown units", () => {
    const quota = parseZaiQuotaLimits({ limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 72, nextResetTime: 1_789_000_000_000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 31, nextResetTime: 1_789_100_000_000 },
      { type: "TIME_LIMIT", unit: 5, percentage: 12, nextResetTime: 1_789_200_000_000 },
      { type: "TOKENS_LIMIT", unit: 99, percentage: 99, nextResetTime: 1_789_300_000_000 },
    ] });
    expect(quota).toMatchObject({ fiveHourPercent: 72, weeklyPercent: 31, monthlyPercent: 12 });
    expect(quota?.fiveHourResetAt).toBe(1_789_000_000_000);
    expect(quota?.weeklyResetAt).toBe(1_789_100_000_000);
    expect(quota?.monthlyResetAt).toBe(1_789_200_000_000);
  });

  test("uses the pinned BigModel endpoint and direct API-key Authorization", async () => {
    const previous = globalThis.fetch;
    let captured: { url: string; headers: Headers } | undefined;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), headers: new Headers(init?.headers) };
      return Response.json({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }] } });
    }) as typeof fetch;
    try {
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "zhipu-bigmodel",
        providers: {
          "zhipu-bigmodel": {
            adapter: "openai-chat",
            baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
            apiKey: "bigmodel-secret",
          },
        },
      };
      const response = await fetchProviderQuotaReports(config, true);
      expect(response.reports[0]?.quota.fiveHourPercent).toBe(1);
      expect(captured?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
      expect(captured?.headers.get("authorization")).toBe("bigmodel-secret");
      expect(captured?.headers.get("authorization")).not.toContain("Bearer");
    } finally {
      globalThis.fetch = previous;
    }
  });
});
