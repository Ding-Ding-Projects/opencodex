import type { OcxProviderConfig, ResponsesTerminalRepairPolicy } from "../types";

const MAX_GRACE_MS = 120_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function responsesTerminalRepairConfigError(provider: OcxProviderConfig): string | null {
  const routes = provider.modelResponsesTerminalRepair;
  if (routes === undefined) return null;
  if (provider.adapter !== "openai-responses") {
    return "modelResponsesTerminalRepair requires the openai-responses adapter";
  }
  if (provider.authMode === "forward") {
    return "modelResponsesTerminalRepair is not allowed on forward-auth providers";
  }
  if (!isPlainRecord(routes)) return "modelResponsesTerminalRepair must be a plain object";
  const seen = new Set<string>();
  for (const [modelId, policy] of Object.entries(routes)) {
    const folded = modelId.trim().toLowerCase();
    if (!folded || modelId !== modelId.trim()) {
      return "modelResponsesTerminalRepair keys must be nonblank trimmed model ids";
    }
    if (seen.has(folded)) return "modelResponsesTerminalRepair keys must not differ only by case";
    seen.add(folded);
    if (!isPlainRecord(policy)) return `modelResponsesTerminalRepair.${modelId} must be a plain object`;
    const unknown = Object.keys(policy).find(key => key !== "graceMs");
    if (unknown) return `modelResponsesTerminalRepair.${modelId} contains unknown field "${unknown}"`;
    if (policy.graceMs !== undefined
      && (typeof policy.graceMs !== "number" || !Number.isInteger(policy.graceMs)
        || policy.graceMs < 1 || policy.graceMs > MAX_GRACE_MS)) {
      return `modelResponsesTerminalRepair.${modelId}.graceMs must be an integer from 1 to ${MAX_GRACE_MS}`;
    }
  }
  return null;
}

export function resolveCustomResponsesTerminalRepair(
  provider: OcxProviderConfig,
  modelId: string,
): ResponsesTerminalRepairPolicy | undefined {
  if (provider.adapter !== "openai-responses" || provider.authMode === "forward") return undefined;
  const routes = provider.modelResponsesTerminalRepair;
  if (!routes) return undefined;
  const exact = Object.entries(routes).find(([key]) => key.toLowerCase() === modelId.toLowerCase());
  if (!exact) return undefined;
  const graceMs = exact[1]?.graceMs ?? 5_000;
  return Number.isInteger(graceMs) && graceMs >= 1 && graceMs <= MAX_GRACE_MS ? { graceMs } : undefined;
}
