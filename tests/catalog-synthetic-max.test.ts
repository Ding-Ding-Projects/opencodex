import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, syntheticMaxSuppressedCatalogSlugs } from "../src/codex/catalog/sync";
import { applyReasoningLevels } from "../src/codex/catalog/effort";
import type { OcxConfig } from "../src/types";

describe("model-scoped synthetic max policy", () => {
  test("suppresses only the invented max rung and preserves ultra", () => {
    const [row] = buildCatalogEntries(null, [], [{
      provider: "google",
      id: "gemini-3.7-flash",
      reasoningEfforts: ["low", "medium", "high"],
      suppressSyntheticMax: true,
    }]);
    expect((row?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "medium", "high", "ultra"]);
  });

  test("keeps a provider-declared max even when suppression is enabled", () => {
    const entry: Record<string, unknown> = {};
    applyReasoningLevels(entry, ["low", "high", "max"], undefined, false, true);
    expect((entry.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "high", "max", "ultra"]);
  });

  test("policy slugs include only enabled true entries", () => {
    const config = {
      providers: {
        google: {
          adapter: "google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          modelSuppressSyntheticMax: { "gemini-3.7-flash": true, legacy: false },
        },
        disabled: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          disabled: true,
          modelSuppressSyntheticMax: { hidden: true },
        },
      },
    } as unknown as Pick<OcxConfig, "providers">;
    expect(syntheticMaxSuppressedCatalogSlugs(config)).toEqual(new Set(["google/gemini-3.7-flash"]));
  });
});
