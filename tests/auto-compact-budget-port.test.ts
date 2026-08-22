import { describe, expect, test } from "bun:test";
import { clampAutoCompactTokenLimit, modelAutoCompactTokenLimitsConfigError } from "../src/providers/auto-compact-budget";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import { deriveComboCatalogModel } from "../src/codex/catalog/aggregation";

describe("per-model compaction budgets", () => {
  test("lower the soft threshold but never raise a hard input ceiling", () => {
    expect(clampAutoCompactTokenLimit(1_000)).toBe(900);
    expect(clampAutoCompactTokenLimit(1_000, 800)).toBe(800);
    expect(clampAutoCompactTokenLimit(1_000, 800, 700)).toBe(700);
    expect(clampAutoCompactTokenLimit(1_000, 800, 5_000)).toBe(800);
  });

  test("rejects malformed, inherited, reserved, and unsupported native keys", () => {
    expect(modelAutoCompactTokenLimitsConfigError({ model: 64_000 })).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError({ "gpt-5.6-sol": 64_000 }, { requireNativeIds: true })).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError({ "provider/gpt-5.6-sol": 64_000 }, { requireNativeIds: true })).toContain("exact supported native model id");
    expect(modelAutoCompactTokenLimitsConfigError({ constructor: 1 })).toContain("reserved");
    expect(modelAutoCompactTokenLimitsConfigError(Object.create({ inherited: 1 }))).toContain("plain object");
    expect(modelAutoCompactTokenLimitsConfigError({ model: null }, { allowTombstones: true })).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError({ model: 0 })).not.toBeNull();
  });

  test("provider hints clamp max-input and configured soft policy together", () => {
    const hinted = applyProviderConfigHints("provider", {
      adapter: "openai-chat",
      baseUrl: "https://provider.example/v1",
      modelContextWindows: { model: 321_000 },
      modelMaxInputTokens: { model: 60_000 },
      modelAutoCompactTokenLimits: { model: 80_000 },
    }, { provider: "provider", id: "model" });
    expect(hinted).toMatchObject({ contextWindow: 321_000, maxInputTokens: 60_000, autoCompactTokenLimit: 60_000 });
  });

  test("combo threshold uses the smallest member window and input ceiling", () => {
    const derived = deriveComboCatalogModel("bounded", { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } as any, [
      { provider: "a", id: "m1", contextWindow: 700_000, maxInputTokens: 922_000, autoCompactTokenLimit: 800_000 },
      { provider: "b", id: "m2", contextWindow: 800_000, maxInputTokens: 900_000, autoCompactTokenLimit: 700_000 },
    ]);
    expect(derived).toMatchObject({ contextWindow: 700_000, maxInputTokens: 700_000, autoCompactTokenLimit: 630_000 });
  });
});
