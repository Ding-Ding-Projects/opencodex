/** Official fixed-window environment pair; empty for automatic/invalid values. */
export function fixedContextEnv(maxContextTokens: number | null | undefined): Record<string, string> {
  if (typeof maxContextTokens !== "number" || !Number.isSafeInteger(maxContextTokens) || maxContextTokens <= 0) return {};
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.floor(maxContextTokens)),
    DISABLE_COMPACT: "1",
  };
}
