import { redactSecretString } from "../lib/redact";

const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Resolve a soft compaction threshold without ever exceeding hard model/input limits. */
export function clampAutoCompactTokenLimit(contextWindow: number, maxInputTokens?: number, configuredLimit?: number): number {
  const candidates = [Math.floor(contextWindow * 0.9), contextWindow];
  if (positiveSafeInteger(maxInputTokens)) candidates.push(maxInputTokens);
  if (positiveSafeInteger(configuredLimit)) candidates.push(configuredLimit);
  return Math.min(...candidates);
}

export type AutoCompactBudgetValidationOptions = Readonly<{ allowTombstones?: boolean; requireNativeIds?: boolean }>;

export function modelAutoCompactTokenLimitsConfigError(value: unknown, options: AutoCompactBudgetValidationOptions = {}): string | null {
  const field = "modelAutoCompactTokenLimits";
  if (value === undefined || (options.allowTombstones && value === null)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object${options.allowTombstones ? " or null" : ""}`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [modelId, entry] of Object.entries(value as Record<string, unknown>)) {
    const safeModelId = JSON.stringify(redactSecretString(modelId));
    if (!modelId.trim()) return `${field} keys must be nonblank model ids`;
    if (RESERVED_OBJECT_KEYS.has(modelId)) return `${field} key ${safeModelId} is reserved`;
    if (options.requireNativeIds && (modelId.includes("/") || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(modelId))) return `${field} key ${safeModelId} must be an exact supported native model id`;
    if (options.allowTombstones && entry === null) continue;
    if (!positiveSafeInteger(entry)) return `${field}[${safeModelId}] must be a positive safe integer${options.allowTombstones ? " or null" : ""}`;
  }
  return null;
}
