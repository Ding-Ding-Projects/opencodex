import { describe, expect, test } from "bun:test";
import { CHAT_PARAMETER_BOUNDS, DEFAULT_CHAT_PARAMETERS, validateChatParameters } from "../src/lib/model-runtime/chat-types";

describe("validateChatParameters", () => {
  test("a fully valid set passes through unchanged with no adjustments", () => {
    const input = { temperature: 0.5, topP: 0.8, topK: 20, numCtx: 8192, repeatPenalty: 1.2, seed: 42 };
    const { parameters, adjustments } = validateChatParameters(input);
    expect(parameters).toEqual(input);
    expect(adjustments).toEqual([]);
  });

  test("missing input falls back entirely to documented defaults", () => {
    const { parameters, adjustments } = validateChatParameters(undefined);
    expect(parameters).toEqual(DEFAULT_CHAT_PARAMETERS);
    expect(adjustments).toEqual([]);
  });

  test("a value above bound is clamped down, and the clamp is reported", () => {
    const { parameters, adjustments } = validateChatParameters({ temperature: 99 });
    expect(parameters.temperature).toBe(CHAT_PARAMETER_BOUNDS.temperature.max);
    expect(adjustments.some(a => a.includes("temperature"))).toBe(true);
  });

  test("a value below bound is clamped up, and the clamp is reported", () => {
    const { parameters, adjustments } = validateChatParameters({ topK: -5 });
    expect(parameters.topK).toBe(CHAT_PARAMETER_BOUNDS.topK.min);
    expect(adjustments.some(a => a.includes("topK"))).toBe(true);
  });

  test("a non-finite value falls back to the default rather than propagating NaN/Infinity", () => {
    const { parameters } = validateChatParameters({ temperature: Number.NaN, numCtx: Number.POSITIVE_INFINITY });
    expect(parameters.temperature).toBe(DEFAULT_CHAT_PARAMETERS.temperature);
    expect(parameters.numCtx).toBe(DEFAULT_CHAT_PARAMETERS.numCtx);
  });

  test("seed null stays null (random) with no adjustment", () => {
    const { parameters, adjustments } = validateChatParameters({ seed: null });
    expect(parameters.seed).toBeNull();
    expect(adjustments).toEqual([]);
  });

  test("a non-numeric seed resets to null and is reported", () => {
    const { parameters, adjustments } = validateChatParameters({ seed: "not a number" as unknown as number });
    expect(parameters.seed).toBeNull();
    expect(adjustments.some(a => a.includes("seed"))).toBe(true);
  });

  test("every documented bound is a real, non-degenerate range", () => {
    for (const [key, bound] of Object.entries(CHAT_PARAMETER_BOUNDS)) {
      expect(bound.min).toBeLessThan(bound.max);
      expect(DEFAULT_CHAT_PARAMETERS[key as keyof typeof DEFAULT_CHAT_PARAMETERS]).toBeGreaterThanOrEqual(bound.min);
      expect(DEFAULT_CHAT_PARAMETERS[key as keyof typeof DEFAULT_CHAT_PARAMETERS]).toBeLessThanOrEqual(bound.max);
    }
  });
});
