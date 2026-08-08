import { describe, expect, test } from "bun:test";
import { buildInitProviders, initProviderIndex } from "../src/cli/init";

describe("ocx init provider choice", () => {
  test("blank input selects the first keyless ChatGPT/Codex provider", () => {
    const providers = buildInitProviders();
    const selected = providers[initProviderIndex("   ")];

    expect(selected?.id).toBe("openai");
    expect(selected?.kind).toBe("forward");
  });

  test("explicit menu choices retain their one-based numbering", () => {
    expect(initProviderIndex("1")).toBe(0);
    expect(initProviderIndex("2")).toBe(1);
  });
});
