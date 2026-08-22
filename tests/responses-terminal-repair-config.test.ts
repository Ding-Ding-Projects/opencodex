import { describe, expect, test } from "bun:test";
import { providerModelResponsesTerminalRepair } from "../src/providers/registry";
import { responsesTerminalRepairConfigError } from "../src/providers/terminal-repair";
import type { OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: "https://custom.example/v1", apiKey: "key", ...overrides };
}

describe("custom Responses terminal-repair policy", () => {
  test("is explicit, case-insensitive per model, and model-local", () => {
    const value = provider({ modelResponsesTerminalRepair: { "Model-A": { graceMs: 250 } } });
    expect(responsesTerminalRepairConfigError(value)).toBeNull();
    expect(providerModelResponsesTerminalRepair("custom", value, "model-a")).toEqual({ graceMs: 250 });
    expect(providerModelResponsesTerminalRepair("custom", value, "model-b")).toBeUndefined();
  });

  test("never resolves registry repair for forward-auth providers", () => {
    const value = provider({
      authMode: "forward",
      modelResponsesTerminalRepair: { model: { graceMs: 250 } },
    });
    expect(providerModelResponsesTerminalRepair("deepseek", value, "deepseek-v4-flash")).toBeUndefined();
  });

  test.each([
    ["wrong wire", provider({ adapter: "openai-chat", modelResponsesTerminalRepair: { model: {} } }), "openai-responses"],
    ["forward auth", provider({ authMode: "forward", modelResponsesTerminalRepair: { model: {} } }), "forward-auth"],
    ["case duplicate", provider({ modelResponsesTerminalRepair: { Model: {}, model: {} } }), "differ only by case"],
    ["invalid grace", provider({ modelResponsesTerminalRepair: { model: { graceMs: 0 } } }), "graceMs"],
  ] as const)("rejects %s", (_label, value, expected) => {
    expect(responsesTerminalRepairConfigError(value)).toContain(expected);
  });
});
