import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex/catalog/sync";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import type { OcxProviderConfig } from "../src/types";
import { resolveMatchedPrice } from "../src/usage/cost";

describe("xAI Priority Processing", () => {
  function provider(authMode: "key" | "oauth"): OcxProviderConfig {
    return {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode,
      models: ["grok-4.6"],
      liveModels: false,
      apiKey: "test-only-key",
    };
  }

  test("API-key transport advertises Priority Processing in the catalog", () => {
    const hinted = applyProviderConfigHints("xai", provider("key"), { id: "grok-4.6", provider: "xai" });
    expect(hinted.supportsServiceTier).toBe(true);
    const [entry] = buildCatalogEntries(null, [], [hinted]);
    expect(entry?.service_tiers).toEqual([{
      id: "priority",
      name: "Fast",
      description: "Priority processing, 2x token price",
    }]);
    expect(entry?.additional_speed_tiers).toEqual(["fast"]);
  });

  test("OAuth transport stays unclassified and does not advertise the tier", () => {
    const hinted = applyProviderConfigHints("xai", provider("oauth"), { id: "grok-4.6", provider: "xai" });
    expect(hinted.supportsServiceTier).toBeUndefined();
    const [entry] = buildCatalogEntries(null, [], [hinted]);
    expect(entry).not.toHaveProperty("service_tiers");
    expect(entry).not.toHaveProperty("additional_speed_tiers");
  });

  test("priority pricing is exact-provider scoped and doubles xAI's published base", () => {
    expect(resolveMatchedPrice("xai", "grok-4.6", { serviceTier: "standard" })?.cost4).toEqual({
      input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0,
    });
    expect(resolveMatchedPrice("xai", "grok-4.6", { serviceTier: "priority" })?.cost4).toEqual({
      input: 4, output: 12, cacheRead: 1, cacheWrite: 0,
    });
    expect(resolveMatchedPrice("openrouter", "grok-4.6", { serviceTier: "priority" })).toBeNull();
  });
});
