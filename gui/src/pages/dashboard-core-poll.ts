import { readJsonIfOk } from "../fetch-json";
import { createBoundedFetch } from "../bounded-fetch";
import { isProviderConfigurationState } from "../provider-configuration";
import {
  settingsPollMayCommit,
  beginPollEpochs,
  mapStartupHealthProbe,
  type StartupHealthStatus,
} from "../startup-health-ui";
import {
  requireJson,
  type HealthData,
  type ModelInfo,
  type ProjectCodexConfigGroup,
  type ProviderInfo,
  type SettingsData,
  type ShadowCallData,
  type SidecarData,
  type UsageSummary30d,
} from "./dashboard-shared";

export type InjectionPoll = {
  multiAgentGuidanceEnabled: boolean;
  syncCodexSubagentDefaults: boolean;
  injectionModel: string;
  injectionEffort: string;
  injectionEfforts: string[];
  injectionAvailable: Array<{ provider: string; model: string; namespaced: string }>;
};

export type InjectionSelectionResponse = {
  multiAgentGuidanceEnabled?: boolean;
  syncCodexSubagentDefaults?: boolean;
  model?: string | null;
  effort?: string | null;
};

export function normalizeInjectionSelection(data: InjectionSelectionResponse) {
  return {
    multiAgentGuidanceEnabled: data.multiAgentGuidanceEnabled !== false,
    syncCodexSubagentDefaults: data.syncCodexSubagentDefaults === true,
    injectionModel: data.model ?? "",
    injectionEffort: data.effort ?? "",
  };
}

export type EffortCapPoll = {
  effortCap: string;
  subagentEffortCap: string;
};

export type DashboardCorePoll = {
  health: HealthData | null;
  /** Undefined means this optional resource failed; callers retain the prior snapshot. */
  providers: ProviderInfo[] | undefined;
  settings: SettingsData | undefined;
  /** Settings-derived seed payload; merge against latest startup-health at commit time. */
  startupHealthSeed: SettingsData["startupHealth"] | null | undefined;
  sidecar: SidecarData | undefined;
  shadowCall: ShadowCallData | null | undefined;
  maMode: "v1" | "default" | "v2";
  maModeResolved: boolean;
  /** Absent when the optional endpoint failed — callers must keep prior UI state. */
  injection: InjectionPoll | undefined;
  effortCaps: EffortCapPoll | undefined;
  error: boolean;
};

export type DashboardEpochRefs = {
  settingsRequestEpochRef: { current: number };
  settingsMutationEpochRef: { current: number };
  settingsMutationInFlightRef: { current: boolean };
  shadowCallRequestEpochRef: { current: number };
  shadowCallMutationEpochRef: { current: number };
  shadowCallMutationInFlightRef: { current: boolean };
};

const DASHBOARD_CORE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Keep each core resource bounded while still honouring the client-resource abort.
 * A stalled optional endpoint must not hold the health snapshot hostage forever.
 */
async function fetchCoreResource(url: string, parentSignal: AbortSignal): Promise<Response> {
  const bounded = createBoundedFetch(DASHBOARD_CORE_REQUEST_TIMEOUT_MS);
  const abort = () => bounded.controller.abort();
  if (parentSignal.aborted) bounded.controller.abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { signal: bounded.signal });
  } finally {
    parentSignal.removeEventListener("abort", abort);
    bounded.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isHealthData(value: unknown): value is HealthData {
  return isRecord(value)
    && value.status === "ok"
    && typeof value.version === "string"
    && value.version.length > 0
    && typeof value.uptime === "number"
    && Number.isFinite(value.uptime);
}

function isProviderInfoList(value: unknown): value is ProviderInfo[] {
  return Array.isArray(value) && value.every(item => isRecord(item)
    && typeof item.name === "string"
    && typeof item.adapter === "string"
    && typeof item.baseUrl === "string"
    && typeof item.hasApiKey === "boolean"
    && isProviderConfigurationState(item));
}

function isSettingsData(value: unknown): value is SettingsData {
  return isRecord(value)
    && typeof value.codexAutoStart === "boolean"
    && typeof value.port === "number"
    && Number.isFinite(value.port)
    && typeof value.hostname === "string";
}

function isSidecarData(value: unknown): value is SidecarData {
  if (!isRecord(value) || !isRecord(value.webSearch) || !isRecord(value.vision)) return false;
  const validSetting = (setting: Record<string, unknown>) =>
    typeof setting.model === "string"
    && (setting.backend === undefined || setting.backend === "openai" || setting.backend === "anthropic");
  return validSetting(value.webSearch) && validSetting(value.vision);
}

function isShadowCallData(value: unknown): value is ShadowCallData {
  return isRecord(value) && typeof value.enabled === "boolean" && typeof value.model === "string";
}

async function readOptionalJson<T>(response: Response | null, isValid: (value: unknown) => value is T): Promise<T | undefined> {
  if (!response) return undefined;
  const data = await readJsonIfOk<unknown>(response);
  return data !== null && data !== undefined && isValid(data) ? data : undefined;
}

export async function fetchStartupHealth(apiBase: string, signal: AbortSignal): Promise<StartupHealthStatus> {
  try {
    const response = await fetch(`${apiBase}/api/startup-health`, { signal });
    if (!response.ok) throw new Error("startup health unavailable");
    const data = await response.json() as { status?: unknown; diagnosticStale?: unknown };
    const mapped = mapStartupHealthProbe(data);
    if (!mapped) throw new Error("invalid startup health response");
    return mapped;
  } catch {
    return "error";
  }
}

export async function fetchProjectConfigDiagnostics(
  apiBase: string,
  signal: AbortSignal,
): Promise<ProjectCodexConfigGroup[]> {
  try {
    const pcRes = await fetch(`${apiBase}/api/diagnostics/project-config`, { signal });
    const pcData = await readJsonIfOk<{ grouped?: ProjectCodexConfigGroup[] }>(pcRes);
    return pcData?.grouped ?? [];
  } catch {
    return [];
  }
}

export async function fetchDashboardModels(apiBase: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const response = await fetch(`${apiBase}/api/models`, { signal });
  // Throw on non-OK / empty so client-resource retains the prior snapshot instead of
  // treating an HTTP error as a successful empty list.
  return requireJson<ModelInfo[]>(response);
}

export async function fetchDashboardUsage(apiBase: string, signal: AbortSignal): Promise<UsageSummary30d> {
  const response = await fetch(`${apiBase}/api/usage?range=30d`, { signal });
  // Usage can be expensive on an older server. Keeping it in its own resource means
  // it cannot delay health/provider/settings commits, and a failed refresh retains
  // the last good usage snapshot.
  return requireJson<UsageSummary30d>(response);
}

export async function fetchDashboardCore(
  apiBase: string,
  signal: AbortSignal,
  epochs: DashboardEpochRefs,
): Promise<DashboardCorePoll> {
  const epochSnapshot = beginPollEpochs({
    settingsRequest: epochs.settingsRequestEpochRef,
    settingsMutation: epochs.settingsMutationEpochRef,
    shadowRequest: epochs.shadowCallRequestEpochRef,
    shadowMutation: epochs.shadowCallMutationEpochRef,
  });
  const settingsRequestEpoch = epochSnapshot.settings.request;
  const settingsMutationEpoch = epochSnapshot.settings.mutation;
  const shadowRequestEpoch = epochSnapshot.shadow.request;
  const shadowMutationEpoch = epochSnapshot.shadow.mutation;

  const empty: DashboardCorePoll = {
    health: null,
    providers: undefined,
    settings: undefined,
    startupHealthSeed: undefined,
    sidecar: undefined,
    shadowCall: undefined,
    maMode: "default",
    maModeResolved: true,
    injection: undefined,
    effortCaps: undefined,
    error: true,
  };

  try {
    const [hResult, pResult, sResult, scResult, shResult] = await Promise.allSettled([
      fetchCoreResource(`${apiBase}/healthz`, signal),
      fetchCoreResource(`${apiBase}/api/providers`, signal),
      fetchCoreResource(`${apiBase}/api/settings`, signal),
      fetchCoreResource(`${apiBase}/api/sidecar-settings`, signal),
      fetchCoreResource(`${apiBase}/api/shadow-call-settings`, signal),
    ]);
    const responseOrNull = (result: PromiseSettledResult<Response>) => result.status === "fulfilled" ? result.value : null;
    const hRes = responseOrNull(hResult);
    const pRes = responseOrNull(pResult);
    const sRes = responseOrNull(sResult);
    const scRes = responseOrNull(scResult);
    const shRes = responseOrNull(shResult);

    // Health is the only required resource: a missing or malformed probe must
    // still produce the honest Offline/error state.
    const health = hRes ? await requireJson<unknown>(hRes) : undefined;
    if (!isHealthData(health)) throw new Error("invalid health response");

    // These management resources are optional to the dashboard shell. A 503,
    // rejected request, or malformed body is represented as absent so the hook
    // keeps its last valid snapshot instead of turning a healthy proxy offline.
    const providers = await readOptionalJson(pRes, isProviderInfoList);
    const nextSettings = await readOptionalJson(sRes, isSettingsData);
    let settings: SettingsData | undefined = undefined;
    let startupHealthSeed: SettingsData["startupHealth"] | null | undefined = undefined;
    if (settingsPollMayCommit(
      { request: settingsRequestEpoch, mutation: settingsMutationEpoch },
      {
        request: epochs.settingsRequestEpochRef.current,
        mutation: epochs.settingsMutationEpochRef.current,
        mutationInFlight: epochs.settingsMutationInFlightRef.current,
      },
    )) {
      settings = nextSettings;
      startupHealthSeed = nextSettings?.startupHealth;
    }

    const sidecar = await readOptionalJson(scRes, isSidecarData);
    let shadowCall: ShadowCallData | null | undefined = undefined;
    const nextShadow = await readOptionalJson(shRes, isShadowCallData);
    if (nextShadow && settingsPollMayCommit(
      { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
      {
        request: epochs.shadowCallRequestEpochRef.current,
        mutation: epochs.shadowCallMutationEpochRef.current,
        mutationInFlight: epochs.shadowCallMutationInFlightRef.current,
      },
    )) {
      shadowCall = nextShadow;
    } else if (!nextShadow) {
      if (settingsPollMayCommit(
        { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
        {
          request: epochs.shadowCallRequestEpochRef.current,
          mutation: epochs.shadowCallMutationEpochRef.current,
          mutationInFlight: epochs.shadowCallMutationInFlightRef.current,
        },
      )) {
        shadowCall = undefined;
      }
    }

    let maMode: "v1" | "default" | "v2" = "default";
    let maModeResolved = false;
    try {
      const v2Res = await fetch(`${apiBase}/api/v2`, { signal });
      if (v2Res.ok) {
        const v2Data = await v2Res.json();
        if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") maMode = v2Data.multiAgentMode;
        else maMode = "default";
      }
    } catch { /* old server */ }
    finally { maModeResolved = true; }

    let injection: InjectionPoll | undefined;
    try {
      const imRes = await fetch(`${apiBase}/api/injection-model`, { signal });
      if (imRes.ok) {
        const imData = await imRes.json() as InjectionSelectionResponse & {
          efforts?: string[];
          available?: InjectionPoll["injectionAvailable"];
        };
        injection = {
          ...normalizeInjectionSelection(imData),
          injectionEfforts: imData.efforts ?? [],
          injectionAvailable: imData.available ?? [],
        };
      }
    } catch { /* old server / malformed — keep prior UI state */ }

    let effortCaps: EffortCapPoll | undefined;
    try {
      const ecRes = await fetch(`${apiBase}/api/effort-caps`, { signal });
      if (ecRes.ok) {
        const ecData = await ecRes.json() as { effortCap?: string | null; subagentEffortCap?: string | null };
        effortCaps = {
          effortCap: ecData.effortCap ?? "",
          subagentEffortCap: ecData.subagentEffortCap ?? "",
        };
      }
    } catch { /* old server */ }

    return {
      health,
      providers,
      settings,
      startupHealthSeed,
      sidecar,
      shadowCall,
      maMode,
      maModeResolved,
      injection,
      effortCaps,
      error: false,
    };
  } catch {
    return empty;
  }
}
