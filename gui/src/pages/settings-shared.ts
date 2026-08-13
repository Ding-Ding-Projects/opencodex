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

/**
 * A server-backed field that Settings can stage. The identifiers deliberately
 * describe data rather than screen rows: one endpoint may echo more than one
 * row, but a revision is only earned by the field the user actually changed.
 */
export type SettingsDraftField =
  | "codexAutoStart"
  | "shadowCall"
  | "maMode"
  | "multiAgentGuidanceEnabled"
  | "syncCodexSubagentDefaults"
  | "effortCap"
  | "subagentEffortCap"
  | "policyEnabled"
  | "policySchedule"
  | "debug"
  | "usage"
  | "injection"
  | "claude";

export interface AcceptedSettingsChange {
  field: SettingsDraftField;
  before: unknown;
  after: unknown;
}

/**
 * A field the endpoint answered for but did not store: it echoed something other
 * than what was asked. There is no error to quote here — the write succeeded and
 * the server simply kept its own value — so the echo *is* the reason, and saying
 * which value was kept is the only honest account of what happened.
 */
export interface RefusedSettingsChange {
  field: SettingsDraftField;
  /** What the user staged. */
  desired: unknown;
  /** What the endpoint echoed instead, which is what is actually stored. */
  echoed: unknown;
}

export type SettingsEndpoint =
  | "settings"
  | "shadow"
  | "mode"
  | "injection"
  | "effortCaps"
  | "policy"
  | "debug";

/** An endpoint that could not be written at all, as distinct from one that refused a value. */
export interface FailedSettingsWrite {
  endpoint: SettingsEndpoint;
  /**
   * The staged fields that endpoint carried. Kept so a notice can name the
   * settings the user actually touched rather than the route they travel on —
   * "Shadow Call Intercept" is something a reader recognises; "shadow" is not.
   */
  fields: SettingsDraftField[];
  /** The server's own error copy where it sent one, otherwise the transport failure, verbatim. */
  reason: string;
}

/**
 * What one apply did, in the three states a caller has to tell apart: stored,
 * refused, and never written. The draft coordinator hands this back so a surface
 * that sits inside the language and notification providers — which the
 * coordinator itself does not — can say so on screen.
 */
export interface SettingsSaveOutcome {
  /** User-requested fields whose echoed value proves that they were accepted. */
  accepted: AcceptedSettingsChange[];
  /** Fields the endpoint answered for but did not store, still staged for another attempt. */
  refused: RefusedSettingsChange[];
  /** Endpoint groups that could not be written or did not return a usable echo. */
  failed: FailedSettingsWrite[];
}

export interface SettingsApplyResult extends SettingsSaveOutcome {
  /** Server-confirmed baseline, including any endpoint side effects it echoed. */
  applied: SettingsSnapshot;
  /** Only fields an endpoint did not accept remain staged for another attempt. */
  draft: SettingsSnapshot | null;
}

/**
 * The row label each staged field is shown under on the Settings screen.
 *
 * A notice and a Version history entry both have to name a setting, and the only
 * name a user has ever seen for it is the one on its row. Reusing those keys
 * keeps all three surfaces saying the same words, and means a relabelled row
 * moves its notice copy with it rather than leaving a second name to go stale.
 */
export const SETTINGS_FIELD_LABELS: Record<SettingsDraftField, TKey> = {
  codexAutoStart: "dash.codexAutoStart",
  shadowCall: "dash.shadowCallIntercept",
  maMode: "dash.multiAgent",
  multiAgentGuidanceEnabled: "dash.multiAgentGuidance",
  syncCodexSubagentDefaults: "dash.syncCodexSubagentDefaults",
  effortCap: "dash.effortCapLabel",
  subagentEffortCap: "dash.subagentEffortCapLabel",
  policyEnabled: "storage.policy.enabled",
  policySchedule: "storage.policy.schedule",
  debug: "debug.debug",
  usage: "debug.usage",
  injection: "debug.injection",
  claude: "debug.claude",
};

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The one equality used for persisted snapshots and staged server echoes. */
export function settingsSnapshotsEqual(left: SettingsSnapshot, right: SettingsSnapshot): boolean {
  return sameValue(left, right);
}

function changed<T extends object>(before: T, desired: T, fields: readonly (keyof T)[]): (keyof T)[] {
  return fields.filter(field => !sameValue(before[field], desired[field]));
}

function retainUnaccepted<T extends object>(echoed: T, desired: T, fields: readonly (keyof T)[]): T {
  const next = { ...echoed } as T;
  for (const field of fields) {
    if (!sameValue(echoed[field], desired[field])) {
      Object.assign(next, { [field]: desired[field] });
    }
  }
  return next;
}

function acceptedChanges<T extends object>(
  fields: readonly (keyof T)[],
  before: T,
  desired: T,
  echoed: T,
  names: Record<keyof T, SettingsDraftField | undefined>,
): AcceptedSettingsChange[] {
  const out: AcceptedSettingsChange[] = [];
  for (const field of fields) {
    const name = names[field];
    if (name && sameValue(echoed[field], desired[field]) && !sameValue(echoed[field], before[field])) {
      out.push({ field: name, before: before[field], after: echoed[field] });
    }
  }
  return out;
}

/**
 * The refusals, under the *same* predicate `retainUnaccepted` uses to keep a
 * field staged. Deliberately the same test rather than a second one that happens
 * to agree today: a control that springs back with no notice and a notice about
 * a control that did not spring back are both worse than either alone.
 */
function refusedChanges<T extends object>(
  fields: readonly (keyof T)[],
  desired: T,
  echoed: T,
  names: Record<keyof T, SettingsDraftField | undefined>,
): RefusedSettingsChange[] {
  const out: RefusedSettingsChange[] = [];
  for (const field of fields) {
    const name = names[field];
    if (name && !sameValue(echoed[field], desired[field])) {
      out.push({ field: name, desired: desired[field], echoed: echoed[field] });
    }
  }
  return out;
}

/** The staged fields an endpoint was asked to write, for a failure that has no echo to read. */
function requestedFields<T extends object>(
  fields: readonly (keyof T)[],
  names: Record<keyof T, SettingsDraftField | undefined>,
): SettingsDraftField[] {
  const out: SettingsDraftField[] = [];
  for (const field of fields) {
    const name = names[field];
    if (name) out.push(name);
  }
  return out;
}

/**
 * The server's own words where it sent any.
 *
 * `readJsonOrThrow` already lifts an error body's `error`/`message` into the
 * thrown Error, so the useful copy is sitting in `message` and only needs to be
 * kept rather than swallowed. The endpoint path is the fallback: it is at least
 * a true statement about which write failed, which a generic apology is not.
 */
function reasonOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error).trim();
  return text && text !== "[object Object]" ? text : fallback;
}

/** Count only editable values; read-only endpoint echoes must never make a draft look dirty. */
export function countSettingsDraftChanges(applied: SettingsSnapshot, draft: SettingsSnapshot): number {
  let count = 0;
  if (applied.proxy && draft.proxy && applied.proxy.codexAutoStart !== draft.proxy.codexAutoStart) count += 1;
  if (applied.shadowCall && draft.shadowCall && applied.shadowCall.enabled !== draft.shadowCall.enabled) count += 1;
  if (applied.maMode !== null && draft.maMode !== null && applied.maMode !== draft.maMode) count += 1;
  if (applied.injection && draft.injection) {
    if (applied.injection.multiAgentGuidanceEnabled !== draft.injection.multiAgentGuidanceEnabled) count += 1;
    if (applied.injection.syncCodexSubagentDefaults !== draft.injection.syncCodexSubagentDefaults) count += 1;
  }
  if (applied.effortCaps && draft.effortCaps) {
    if (applied.effortCaps.effortCap !== draft.effortCaps.effortCap) count += 1;
    if (applied.effortCaps.subagentEffortCap !== draft.effortCaps.subagentEffortCap) count += 1;
  }
  if (applied.policy && draft.policy) {
    if (applied.policy.enabled !== draft.policy.enabled) count += 1;
    if (applied.policy.schedule !== draft.policy.schedule) count += 1;
  }
  if (applied.debug && draft.debug) {
    for (const key of ["debug", "usage", "injection", "claude"] as const) {
      if (applied.debug[key] !== draft.debug[key]) count += 1;
    }
  }
  return count;
}

/**
 * Apply one staged settings snapshot with at most one PUT per endpoint.
 *
 * The coordinator owns the only call site for this helper. It starts from the
 * durable baseline, sends all changed fields for each endpoint together, trusts
 * only parsed server echoes, and leaves a refused or failed field in `draft`.
 * That makes a partial save retryable without pretending the rejected values
 * landed or recording a revision for them.
 *
 * It also reports what it did in all three states — accepted, refused, failed —
 * because leaving a field staged is the whole of what the user sees otherwise,
 * and a control that stays dirty with no explanation reads as a broken Save
 * rather than as a server that said no.
 */
export async function applySettingsDraft(
  apiBase: string,
  applied: SettingsSnapshot,
  desired: SettingsSnapshot,
): Promise<SettingsApplyResult> {
  let nextApplied: SettingsSnapshot = { ...applied };
  let nextDraft: SettingsSnapshot = { ...desired };
  const accepted: AcceptedSettingsChange[] = [];
  const refused: RefusedSettingsChange[] = [];
  const failed: FailedSettingsWrite[] = [];

  if (applied.proxy && desired.proxy) {
    const names: Record<keyof ProxySettings, SettingsDraftField | undefined> = {
      codexAutoStart: "codexAutoStart", port: undefined, hostname: undefined,
    };
    const fields = changed(applied.proxy, desired.proxy, ["codexAutoStart"]);
    if (fields.length) {
      try {
        const data = await putSetting<SettingsResponse>(apiBase, "/api/settings", {
          codexAutoStart: desired.proxy.codexAutoStart,
        });
        const echoed = readProxy(data);
        nextApplied = { ...nextApplied, proxy: echoed };
        nextDraft = { ...nextDraft, proxy: retainUnaccepted(echoed, desired.proxy, fields) };
        accepted.push(...acceptedChanges(fields, applied.proxy, desired.proxy, echoed, names));
        refused.push(...refusedChanges(fields, desired.proxy, echoed, names));
      } catch (error) {
        failed.push({
          endpoint: "settings",
          fields: requestedFields(fields, names),
          reason: reasonOf(error, "/api/settings"),
        });
      }
    }
  }

  if (applied.shadowCall && desired.shadowCall) {
    const names: Record<keyof ShadowCallSettings, SettingsDraftField | undefined> = {
      enabled: "shadowCall", model: undefined,
    };
    const fields = changed(applied.shadowCall, desired.shadowCall, ["enabled"]);
    if (fields.length) {
      try {
        const data = await putSetting<ShadowCallResponse>(apiBase, "/api/shadow-call-settings", {
          enabled: desired.shadowCall.enabled,
        });
        const echoed = readShadowCall(data);
        nextApplied = { ...nextApplied, shadowCall: echoed };
        nextDraft = { ...nextDraft, shadowCall: retainUnaccepted(echoed, desired.shadowCall, fields) };
        accepted.push(...acceptedChanges(fields, applied.shadowCall, desired.shadowCall, echoed, names));
        refused.push(...refusedChanges(fields, desired.shadowCall, echoed, names));
      } catch (error) {
        failed.push({
          endpoint: "shadow",
          fields: requestedFields(fields, names),
          reason: reasonOf(error, "/api/shadow-call-settings"),
        });
      }
    }
  }

  if (applied.maMode !== null && desired.maMode !== null && applied.maMode !== desired.maMode) {
    try {
      const data = await putSetting<V2Response>(apiBase, "/api/v2", { multiAgentMode: desired.maMode });
      const echoed = readMode(data);
      nextApplied = { ...nextApplied, maMode: echoed };
      nextDraft = { ...nextDraft, maMode: echoed === desired.maMode ? echoed : desired.maMode };
      if (echoed === desired.maMode) accepted.push({ field: "maMode", before: applied.maMode, after: echoed });
      else refused.push({ field: "maMode", desired: desired.maMode, echoed });
    } catch (error) {
      failed.push({ endpoint: "mode", fields: ["maMode"], reason: reasonOf(error, "/api/v2") });
    }
  }

  if (applied.injection && desired.injection) {
    const names: Record<keyof InjectionSettings, SettingsDraftField | undefined> = {
      multiAgentGuidanceEnabled: "multiAgentGuidanceEnabled",
      syncCodexSubagentDefaults: "syncCodexSubagentDefaults",
      model: undefined,
      effort: undefined,
    };
    const fields = changed(applied.injection, desired.injection, [
      "multiAgentGuidanceEnabled",
      "syncCodexSubagentDefaults",
    ]);
    if (fields.length) {
      try {
        const body: Partial<Pick<InjectionSettings, "multiAgentGuidanceEnabled" | "syncCodexSubagentDefaults">> = {};
        for (const field of fields) Object.assign(body, { [field]: desired.injection[field] });
        const data = await putSetting<InjectionResponse>(apiBase, "/api/injection-model", body);
        const echoed = readInjection(data);
        nextApplied = { ...nextApplied, injection: echoed };
        nextDraft = { ...nextDraft, injection: retainUnaccepted(echoed, desired.injection, fields) };
        accepted.push(...acceptedChanges(fields, applied.injection, desired.injection, echoed, names));
        refused.push(...refusedChanges(fields, desired.injection, echoed, names));
      } catch (error) {
        failed.push({
          endpoint: "injection",
          fields: requestedFields(fields, names),
          reason: reasonOf(error, "/api/injection-model"),
        });
      }
    }
  }

  if (applied.effortCaps && desired.effortCaps) {
    const names: Record<keyof EffortCapSettings, SettingsDraftField | undefined> = {
      effortCap: "effortCap", subagentEffortCap: "subagentEffortCap",
    };
    const fields = changed(applied.effortCaps, desired.effortCaps, ["effortCap", "subagentEffortCap"]);
    if (fields.length) {
      try {
        const body: Partial<Record<keyof EffortCapSettings, string | null>> = {};
        for (const field of fields) Object.assign(body, { [field]: desired.effortCaps[field] || null });
        const data = await putSetting<EffortCapsResponse>(apiBase, "/api/effort-caps", body);
        const echoed = readEffortCaps(data);
        nextApplied = { ...nextApplied, effortCaps: echoed };
        nextDraft = { ...nextDraft, effortCaps: retainUnaccepted(echoed, desired.effortCaps, fields) };
        accepted.push(...acceptedChanges(fields, applied.effortCaps, desired.effortCaps, echoed, names));
        refused.push(...refusedChanges(fields, desired.effortCaps, echoed, names));
      } catch (error) {
        failed.push({
          endpoint: "effortCaps",
          fields: requestedFields(fields, names),
          reason: reasonOf(error, "/api/effort-caps"),
        });
      }
    }
  }

  if (applied.policy && desired.policy) {
    const names: Record<keyof CleanupPolicySettings, SettingsDraftField | undefined> = {
      enabled: "policyEnabled",
      schedule: "policySchedule",
      mode: undefined,
      archivedBytesOver: undefined,
      removeOldestPercent: undefined,
      reduceToBytes: undefined,
    };
    const fields = changed(applied.policy, desired.policy, ["enabled", "schedule"]);
    if (fields.length) {
      try {
        const body: Partial<Pick<CleanupPolicySettings, "enabled" | "schedule">> = {};
        for (const field of fields) Object.assign(body, { [field]: desired.policy[field] });
        const data = await putSetting<{ policy?: PolicyResponse }>(apiBase, "/api/storage/cleanup-policy", body);
        if (!data.policy) throw new Error("/api/storage/cleanup-policy");
        const echoed = readPolicy(data.policy);
        nextApplied = { ...nextApplied, policy: echoed };
        nextDraft = { ...nextDraft, policy: retainUnaccepted(echoed, desired.policy, fields) };
        accepted.push(...acceptedChanges(fields, applied.policy, desired.policy, echoed, names));
        refused.push(...refusedChanges(fields, desired.policy, echoed, names));
      } catch (error) {
        failed.push({
          endpoint: "policy",
          fields: requestedFields(fields, names),
          reason: reasonOf(error, "/api/storage/cleanup-policy"),
        });
      }
    }
  }

  if (applied.debug && desired.debug) {
    const names: Record<keyof DebugFlags, SettingsDraftField | undefined> = {
      debug: "debug", usage: "usage", injection: "injection", claude: "claude",
    };
    const fields = changed(applied.debug, desired.debug, ["debug", "usage", "injection", "claude"]);
    if (fields.length) {
      try {
        const body: Partial<DebugFlags> = {};
        for (const field of fields) Object.assign(body, { [field]: desired.debug[field] });
        const data = await putSetting<DebugResponse>(apiBase, "/api/debug", body);
        const echoed = readDebug(data);
        nextApplied = { ...nextApplied, debug: echoed };
        nextDraft = { ...nextDraft, debug: retainUnaccepted(echoed, desired.debug, fields) };
        accepted.push(...acceptedChanges(fields, applied.debug, desired.debug, echoed, names));
        refused.push(...refusedChanges(fields, desired.debug, echoed, names));
      } catch (error) {
        failed.push({
          endpoint: "debug",
          fields: requestedFields(fields, names),
          reason: reasonOf(error, "/api/debug"),
        });
      }
    }
  }

  return {
    applied: nextApplied,
    draft: settingsSnapshotsEqual(nextApplied, nextDraft) ? null : nextDraft,
    accepted,
    refused,
    failed,
  };
}
