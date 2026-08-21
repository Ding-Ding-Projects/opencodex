import { antigravityHostCandidates, isAntigravityHttpsHost } from "../adapters/google-antigravity-hosts";
import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { readBoundedResponseBody, BOUNDED_BODY_MAX_BYTES } from "../lib/bounded-body";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota";

export const ANTIGRAVITY_QUOTA_RESPONSE_MAX_BYTES = BOUNDED_BODY_MAX_BYTES;
const LIVE_QUOTA_PATH = "/v1internal:retrieveUserQuota";
const LIVE_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";
const CATALOG_PATH = "/v1internal:fetchAvailableModels";

type FetchImpl = typeof fetch;

export interface AntigravityLiveQuotaArgs {
  accessToken: string;
  projectId: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

interface Candidate { record: Record<string, unknown>; path: string[] }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function percent(value: unknown): number | undefined {
  const n = finite(value);
  return n === undefined ? undefined : Math.max(0, Math.min(100, n));
}
function resetAt(value: unknown): number | undefined {
  const n = finite(value);
  if (n !== undefined && n > 0) return n > 10_000_000_000 ? n : n * 1000;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function recordReset(record: Record<string, unknown>): number | undefined {
  return resetAt(record.resetTime ?? record.resetAt ?? record.resetsAt ?? record.reset_time ?? record.nextReset);
}
function remainingPercent(record: Record<string, unknown>): number | undefined {
  const fraction = finite(record.remainingFraction);
  if (fraction !== undefined) return percent(fraction * 100);
  return percent(record.remainingPercentage ?? record.remainingPercent ?? record.remaining_percent);
}
function usedPercent(record: Record<string, unknown>): number | undefined {
  const remaining = remainingPercent(record);
  return remaining === undefined ? undefined : percent(100 - remaining);
}
function collect(value: unknown, path: string[] = [], out: Candidate[] = []): Candidate[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collect(entry, [...path, String(index)], out));
    return out;
  }
  const record = asRecord(value);
  if (!record) return out;
  out.push({ record, path });
  for (const [key, child] of Object.entries(record)) {
    if (child && typeof child === "object") collect(child, [...path, key], out);
  }
  return out;
}
function modelName(record: Record<string, unknown>): string {
  const value = record.modelId ?? record.model_id ?? record.modelName ?? record.model ?? record.name ?? record.displayName;
  return typeof value === "string" ? value.toLowerCase() : "";
}
function parseGem(payload: unknown): ProviderQuotaWindow | undefined {
  for (const candidate of collect(payload)) {
    if (!modelName(candidate.record).includes("gemini")) continue;
    const used = usedPercent(candidate.record);
    if (used === undefined) continue;
    const reset = recordReset(candidate.record);
    return { label: "Gem", percent: used, ...(reset === undefined ? {} : { resetAt: reset }) };
  }
  return undefined;
}
function parseWeekly(payload: unknown): ProviderQuotaWindow | undefined {
  for (const candidate of collect(payload)) {
    const leaf = candidate.path.at(-1);
    if (typeof leaf !== "string" || !/weekly|week|seven[_-]?day/i.test(leaf)) continue;
    const used = usedPercent(candidate.record);
    if (used === undefined) continue;
    const reset = recordReset(candidate.record);
    return { label: "Weekly", percent: used, ...(reset === undefined ? {} : { resetAt: reset }) };
  }
  return undefined;
}
function catalogEntries(modelInfo: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const add = (value: unknown, tier?: string) => {
    const record = asRecord(value);
    if (record) entries.push(tier ? { ...record, tier } : record);
  };
  if (Array.isArray(modelInfo.quotaInfo)) modelInfo.quotaInfo.forEach(value => add(value));
  else add(modelInfo.quotaInfo);
  if (Array.isArray(modelInfo.quotaInfos)) modelInfo.quotaInfos.forEach(value => add(value));
  const byTier = asRecord(modelInfo.quotaInfoByTier);
  if (byTier) for (const [tier, value] of Object.entries(byTier)) {
    if (Array.isArray(value)) value.forEach(item => add(item, tier));
    else add(value, tier);
  }
  return entries;
}
function catalogFamily(modelId: string, modelInfo: Record<string, unknown>, quota: Record<string, unknown>): "Gem" | "Cla" | null {
  const displayName = typeof modelInfo.displayName === "string" ? modelInfo.displayName : "";
  const tier = typeof quota.tier === "string" ? quota.tier : "";
  const haystack = `${modelId} ${displayName} ${tier}`.toLowerCase();
  if (haystack.includes("gemini")) return "Gem";
  if (haystack.includes("claude") || haystack.includes("opus") || haystack.includes("sonnet") || haystack.includes("gpt-oss") || haystack.includes("gpt_oss")) return "Cla";
  return null;
}
async function readJson(response: Response, timeoutMs: number): Promise<unknown> {
  const bounded = await readBoundedResponseBody(response, { totalTimeoutMs: timeoutMs, inactivityTimeoutMs: timeoutMs });
  if (bounded.oversized || bounded.truncated || !bounded.displaySafe || bounded.text.length > ANTIGRAVITY_QUOTA_RESPONSE_MAX_BYTES) {
    throw new Error("Antigravity quota RPC returned unreadable JSON");
  }
  try { return JSON.parse(bounded.text) as unknown; } catch { throw new Error("Antigravity quota RPC returned unreadable JSON"); }
}

export class AntigravityQuotaRpcError extends Error {
  constructor(readonly status: number) { super(`Antigravity quota RPC failed: ${status}`); }
}
export function isTerminalAntigravityQuotaStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

async function rpc(fetchImpl: FetchImpl, host: string, path: string, args: AntigravityLiveQuotaArgs): Promise<unknown> {
  const response = await fetchImpl(`${host}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": antigravityUserAgent(), Authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({ project: args.projectId }),
    redirect: "error",
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!response.ok) throw new AntigravityQuotaRpcError(response.status);
  return readJson(response, args.timeoutMs);
}

async function fetchHostLive(fetchImpl: FetchImpl, host: string, args: AntigravityLiveQuotaArgs): Promise<ProviderQuota | null> {
  const [quotaResult, summaryResult] = await Promise.allSettled([
    rpc(fetchImpl, host, LIVE_QUOTA_PATH, args),
    rpc(fetchImpl, host, LIVE_SUMMARY_PATH, args),
  ]);
  const terminal = [quotaResult, summaryResult].find(result => result.status === "rejected" && result.reason instanceof AntigravityQuotaRpcError && isTerminalAntigravityQuotaStatus(result.reason.status));
  if (terminal && terminal.status === "rejected") throw terminal.reason;
  if (quotaResult.status === "rejected") return null;
  const gem = parseGem(quotaResult.value);
  const weekly = summaryResult.status === "fulfilled" ? parseWeekly(summaryResult.value) : undefined;
  if (!gem && !weekly) return null;
  return {
    ...(gem ? { customWindows: [gem] } : {}),
    ...(weekly ? { weeklyPercent: weekly.percent, ...(weekly.resetAt === undefined ? {} : { weeklyResetAt: weekly.resetAt }) } : {}),
    updatedAt: Date.now(),
  };
}

export async function fetchAntigravityLiveQuota(args: AntigravityLiveQuotaArgs): Promise<ProviderQuota | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  for (const host of antigravityHostCandidates(args.baseUrl)) {
    if (!isAntigravityHttpsHost(host)) continue;
    try {
      const quota = await fetchHostLive(fetchImpl, host, args);
      if (quota) return quota;
    } catch (error) {
      if (error instanceof AntigravityQuotaRpcError && isTerminalAntigravityQuotaStatus(error.status)) throw error;
    }
  }
  return null;
}

export async function fetchAntigravityAccountQuota(args: AntigravityLiveQuotaArgs): Promise<ProviderQuota | null> {
  const live = await fetchAntigravityLiveQuota(args);
  if (live) return live;
  const fetchImpl = args.fetchImpl ?? fetch;
  for (const host of antigravityHostCandidates(args.baseUrl)) {
    if (!isAntigravityHttpsHost(host)) continue;
    try {
      const response = await fetchImpl(`${host}${CATALOG_PATH}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": antigravityUserAgent(), Authorization: `Bearer ${args.accessToken}` },
        body: JSON.stringify({ project: args.projectId }),
        redirect: "error",
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      if (!response.ok) {
        if (response.status === 404 || response.status === 503) continue;
        if (isTerminalAntigravityQuotaStatus(response.status)) throw new AntigravityQuotaRpcError(response.status);
        continue;
      }
      const body = asRecord(await readJson(response, args.timeoutMs));
      const models = asRecord(body?.models);
      if (!models) return null;
      const windows = new Map<string, ProviderQuotaWindow>();
      for (const [modelId, raw] of Object.entries(models)) {
        const info = asRecord(raw);
        if (!info) continue;
        for (const quota of catalogEntries(info)) {
          const family = catalogFamily(modelId, info, quota);
          const used = usedPercent(quota);
          if (!family || used === undefined || windows.has(family)) continue;
          const reset = recordReset(quota);
          windows.set(family, { label: family, percent: used, ...(reset === undefined ? {} : { resetAt: reset }) });
        }
      }
      return windows.size ? { customWindows: [...windows.values()], updatedAt: Date.now() } : null;
    } catch (error) {
      if (error instanceof AntigravityQuotaRpcError && isTerminalAntigravityQuotaStatus(error.status)) throw error;
    }
  }
  return null;
}
