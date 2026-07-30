/**
 * Settings screen — types, the read of every settings endpoint, and the write helper.
 *
 * Split from `Settings.tsx` so the page file holds only rows and handlers. Every
 * endpoint touched here already exists and is already read by another screen
 * (`use-dashboard-data.ts`, `Storage.tsx`, `Debug.tsx`); nothing new was invented.
 *
 * Each read is independently tolerant: an older proxy that lacks `/api/effort-caps`
 * or `/api/storage/cleanup-policy` still yields a usable page, with the missing
 * group simply absent rather than the whole screen failing. `/api/settings` is the
 * exception — it is the core read, so its failure is reported to the user.
 */

import { readJsonOrThrow } from "../fetch-json";
import type { Page } from "../app-routing";
import type { TKey } from "../i18n/shared";

/** The six headings the settings copy defines, in render order. */
export type SettingsGroupId = "proxy" | "routing" | "agents" | "storage" | "appearance" | "privacy";

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; tkey: TKey }> = [
  { id: "proxy", tkey: "settings.groupProxy" },
  { id: "routing", tkey: "settings.groupRouting" },
  { id: "agents", tkey: "settings.groupAgents" },
  { id: "storage", tkey: "settings.groupStorage" },
  { id: "appearance", tkey: "settings.groupAppearance" },
  { id: "privacy", tkey: "settings.groupPrivacy" },
];

export type MultiAgentMode = "v1" | "default" | "v2";
export type CleanupSchedule = "startup" | "daily" | "weekly" | "manual";
export type CleanupMode = "quarantine" | "permanent";

export interface ProxySettings {
  codexAutoStart: boolean;
  port: number | null;
  hostname: string;
}

export interface InjectionSettings {
  multiAgentGuidanceEnabled: boolean;
  syncCodexSubagentDefaults: boolean;
  model: string;
  effort: string;
}

export interface EffortCapSettings {
  effortCap: string;
  subagentEffortCap: string;
}

export interface ShadowCallSettings {
  enabled: boolean;
  model: string;
}

export interface SidecarSettings {
  webSearch: string;
  vision: string;
}

export interface CleanupPolicySettings {
  enabled: boolean;
  schedule: CleanupSchedule;
  mode: CleanupMode;
  archivedBytesOver: number;
  removeOldestPercent: number | null;
  reduceToBytes: number | null;
}

export interface DebugFlags {
  debug: boolean;
  usage: boolean;
  injection: boolean;
  claude: boolean;
}

/** Everything this screen can show, one field per endpoint. `null` = not available. */
export interface SettingsSnapshot {
  proxy: ProxySettings | null;
  injection: InjectionSettings | null;
  effortCaps: EffortCapSettings | null;
  maMode: MultiAgentMode | null;
  shadowCall: ShadowCallSettings | null;
  sidecar: SidecarSettings | null;
  policy: CleanupPolicySettings | null;
  debug: DebugFlags | null;
}

export const EMPTY_SNAPSHOT: SettingsSnapshot = {
  proxy: null,
  injection: null,
  effortCaps: null,
  maMode: null,
  shadowCall: null,
  sidecar: null,
  policy: null,
  debug: null,
};

/** True once at least one endpoint answered — otherwise the page has nothing to show. */
export function snapshotHasData(snapshot: SettingsSnapshot): boolean {
  return Object.values(snapshot).some(value => value !== null);
}

/** Where a setting's full editor lives, for the `settings.jumpTo` link. */
export interface JumpTarget {
  page: Page;
  tkey: TKey;
}

async function getJson<T>(apiBase: string, path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(`${apiBase}${path}`, { signal });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

/**
 * One settings write. Throws on a non-OK response so the caller can revert the
 * optimistic paint; the resolved value is the server's echo of what it stored,
 * which is the only thing allowed to decide whether a revision is recorded.
 */
export async function putSetting<T>(apiBase: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJsonOrThrow<T>(res);
  // A 204/empty body cannot be checked for movement, so it is treated as a failure
  // rather than silently recording a change nobody can verify.
  if (data === undefined) throw new Error(path);
  return data;
}

type SettingsResponse = { codexAutoStart?: unknown; port?: unknown; hostname?: unknown };
type InjectionResponse = {
  multiAgentGuidanceEnabled?: unknown;
  syncCodexSubagentDefaults?: unknown;
  model?: unknown;
  effort?: unknown;
};
type EffortCapsResponse = { effortCap?: unknown; subagentEffortCap?: unknown };
type V2Response = { multiAgentMode?: unknown };
type ShadowCallResponse = { enabled?: unknown; model?: unknown };
type SidecarResponse = { webSearch?: { model?: unknown }; vision?: { model?: unknown } };
type PolicyResponse = {
  enabled?: unknown;
  schedule?: unknown;
  mode?: unknown;
  trigger?: { archivedBytesOver?: unknown };
  target?: { removeOldestPercent?: unknown; reduceToBytes?: unknown };
};
type DebugResponse = { enabled?: unknown; usage?: unknown; injection?: unknown; claude?: unknown };

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function readProxy(data: SettingsResponse): ProxySettings {
  return {
    codexAutoStart: data.codexAutoStart === true,
    port: num(data.port),
    hostname: str(data.hostname),
  };
}

export function readInjection(data: InjectionResponse): InjectionSettings {
  return {
    // The server treats an absent flag as on, exactly as the dashboard poll does.
    multiAgentGuidanceEnabled: data.multiAgentGuidanceEnabled !== false,
    syncCodexSubagentDefaults: data.syncCodexSubagentDefaults === true,
    model: str(data.model),
    effort: str(data.effort),
  };
}

export function readEffortCaps(data: EffortCapsResponse): EffortCapSettings {
  return { effortCap: str(data.effortCap), subagentEffortCap: str(data.subagentEffortCap) };
}

export function readMode(data: V2Response): MultiAgentMode {
  return data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default";
}

export function readShadowCall(data: ShadowCallResponse): ShadowCallSettings {
  return { enabled: data.enabled === true, model: str(data.model) };
}

export function readPolicy(data: PolicyResponse): CleanupPolicySettings {
  const schedule = data.schedule;
  const mode = data.mode;
  return {
    enabled: data.enabled === true,
    schedule: schedule === "startup" || schedule === "daily" || schedule === "weekly" ? schedule : "manual",
    mode: mode === "permanent" ? "permanent" : "quarantine",
    archivedBytesOver: num(data.trigger?.archivedBytesOver) ?? 0,
    removeOldestPercent: num(data.target?.removeOldestPercent),
    reduceToBytes: num(data.target?.reduceToBytes),
  };
}

export function readDebug(data: DebugResponse): DebugFlags {
  return {
    debug: data.enabled === true,
    usage: data.usage === true,
    injection: data.injection === true,
    claude: data.claude === true,
  };
}

export interface SettingsLoad {
  snapshot: SettingsSnapshot;
  /** Verbatim failure of the core `/api/settings` read; `null` when it answered. */
  error: string | null;
}

export async function loadSettingsSnapshot(apiBase: string, signal?: AbortSignal): Promise<SettingsLoad> {
  let error: string | null = null;
  let proxy: ProxySettings | null = null;
  try {
    const res = await fetch(`${apiBase}/api/settings`, { signal });
    const data = await readJsonOrThrow<SettingsResponse>(res);
    if (data === undefined) throw new Error("/api/settings");
    proxy = readProxy(data);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    error = err instanceof Error ? err.message : String(err);
  }

  const [injection, caps, v2, shadow, sidecar, policy, debug] = await Promise.all([
    getJson<InjectionResponse>(apiBase, "/api/injection-model", signal),
    getJson<EffortCapsResponse>(apiBase, "/api/effort-caps", signal),
    getJson<V2Response>(apiBase, "/api/v2", signal),
    getJson<ShadowCallResponse>(apiBase, "/api/shadow-call-settings", signal),
    getJson<SidecarResponse>(apiBase, "/api/sidecar-settings", signal),
    getJson<PolicyResponse>(apiBase, "/api/storage/cleanup-policy", signal),
    getJson<DebugResponse>(apiBase, "/api/debug", signal),
  ]);

  return {
    error,
    snapshot: {
      proxy,
      injection: injection ? readInjection(injection) : null,
      effortCaps: caps ? readEffortCaps(caps) : null,
      maMode: v2 ? readMode(v2) : null,
      shadowCall: shadow ? readShadowCall(shadow) : null,
      sidecar: sidecar
        ? { webSearch: str(sidecar.webSearch?.model), vision: str(sidecar.vision?.model) }
        : null,
      policy: policy ? readPolicy(policy) : null,
      debug: debug ? readDebug(debug) : null,
    },
  };
}
