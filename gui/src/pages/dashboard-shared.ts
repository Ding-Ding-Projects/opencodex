import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { readJsonOrThrow } from "../fetch-json";
import type { TFn, TKey } from "../i18n/shared";
import type { ProviderConfigurationState } from "../provider-configuration";
import type { StartupHealthStatus } from "../startup-health-ui";
import { fmtK } from "./models-shared";

export type DashboardSection = "overview" | "providers" | "models";

/** Every settings control the Overview tab owns, addressable by the settings search. */
export type DashboardSettingId =
  | "effortCap"
  | "injection"
  | "codexAutoStart"
  | "webSearch"
  | "vision"
  | "shadowCall"
  | "memory"
  | "maintenance";

/** Middle dot the prototype uses between meta fragments. Punctuation, not prose. */
const META_SEPARATOR = " · ";

export function readDashboardSectionFromHash(): DashboardSection {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (raw === "dashboard/providers") return "providers";
  if (raw === "dashboard/models") return "models";
  return "overview";
}

/** Overview is the bare `#dashboard`; the other sections carry a suffix. */
export function dashboardHashForSection(section: DashboardSection): string {
  return section === "overview" ? "dashboard" : `dashboard/${section}`;
}

/** Like readJsonOrThrow, but rejects empty/204 bodies that would otherwise yield undefined. */
export async function requireJson<T>(res: Response, fallbackMessage?: string): Promise<T> {
  const data = await readJsonOrThrow<T>(res, fallbackMessage);
  if (data === undefined) throw new Error(fallbackMessage ?? "empty response");
  return data;
}

export interface HealthData { status: string; version: string; uptime: number }
export interface ProviderInfo extends ProviderConfigurationState {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  hasApiKey: boolean;
}
/**
 * `/api/models` already returns the context/capability metadata the Models screen
 * renders; the Dashboard used to drop it on the floor, which is why its model list
 * showed a bare id where the prototype shows `provider · ctx · cap`.
 */
export interface ModelInfo {
  id: string;
  provider: string;
  owned_by?: string;
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
  inputModalities?: string[];
}
export interface SettingsData {
  codexAutoStart: boolean;
  port: number;
  hostname: string;
  startupHealth?: {
    status: "native" | "protected" | "at-risk";
    routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
    autostartEnabled: boolean;
    shimCoverage: "full" | "cli-only" | "none";
    diagnosticStale: boolean;
  };
}
export type SidecarBackend = "openai" | "anthropic";
export interface SidecarSetting { backend?: SidecarBackend; model: string }
export interface SidecarData { webSearch: SidecarSetting; vision: SidecarSetting }
export interface SidecarPatch {
  webSearch?: { backend?: SidecarBackend | null; model?: string };
  vision?: { backend?: SidecarBackend | null; model?: string };
}
export interface ShadowCallData { enabled: boolean; model: string }
export interface UsageSummary30d { summary: { requests: number; totalTokens: number; coverageRatio: number } }
export type UpdateChannel = "latest" | "preview";
export type Installer = "npm" | "bun" | "source";
export type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";
export interface SyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  nativeSubagentDefaultsWarning?: string;
  staleAppServerHint?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
}
export interface ProjectCodexConfigWarning {
  path: string;
  code: string;
  detail: string;
  message: string;
}
export interface ProjectCodexConfigGroup {
  path: string;
  issues: string[];
  bypass: string;
}
export interface UpdateCheckData {
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}
export interface UpdateJob {
  id: string;
  status: UpdateJobStatus;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  restart: boolean;
  command: string;
  log: string[];
  error?: string;
  restarted?: boolean;
}

export const EFFORT_CAP_LEVELS = ["low", "medium", "high", "xhigh"];
export const UPDATE_CHECK_MAX_AUTO_RETRIES = 2;
export const UPDATE_CHECK_RETRY_BASE_MS = 800;

export function defaultUpdateChannel(version: string | undefined): UpdateChannel {
  return version?.includes("-preview.") ? "preview" : "latest";
}

export function updateReasonLabel(reason: string | undefined, t: (key: TKey) => string): string {
  switch (reason) {
    case "source_checkout": return t("dash.updateReason.source_checkout");
    case "desktop_installer": return t("dash.updateReason.desktop_installer");
    case "latest_unavailable": return t("dash.updateReason.latest_unavailable");
    case "already_latest": return t("dash.updateReason.already_latest");
    default: return t("dash.updateReason.unknown");
  }
}

export function updateJobLabel(status: UpdateJobStatus, t: (key: TKey) => string): string {
  switch (status) {
    case "running": return t("dash.updateStatus.running");
    case "restarting": return t("dash.updateStatus.restarting");
    case "succeeded": return t("dash.updateStatus.succeeded");
    case "failed": return t("dash.updateStatus.failed");
  }
}

export function mergeSidecarSetting(
  current: SidecarSetting,
  update?: { backend?: SidecarBackend | null; model?: string },
): SidecarSetting {
  const merged = { ...current };
  if (update?.model !== undefined) merged.model = update.model;
  if (update?.backend === null) delete merged.backend;
  else if (update?.backend !== undefined) merged.backend = update.backend;
  return merged;
}

/**
 * `provider · 400k ctx · 350k cap`, the per-model meta line the prototype puts under
 * every model on the Models tab. Every part is real payload data — a model with no
 * reported context window simply contributes nothing, rather than inventing a number.
 */
export function modelMetaLabel(model: ModelInfo, t: TFn): string {
  const parts = [model.provider];
  const ctx = model.contextWindow ?? model.contextCap;
  if (ctx) parts.push(t("models.ctxValue", { value: fmtK(ctx) }));
  if (model.contextCapped && model.contextCap) {
    parts.push(t("models.contextCappedValue", { value: fmtK(model.contextCap) }));
  }
  if (model.inputModalities && model.inputModalities.length > 0) {
    parts.push(model.inputModalities.join(", "));
  }
  return parts.join(META_SEPARATOR);
}

/**
 * `Ready (9) · Needs setup (2) · Disabled (1)` under the providers stat.
 * The server-authored configuration status is shared with the provider rows, so
 * no-key forward/OAuth/local providers cannot be mislabeled as missing a key.
 */
export function providersStatHint(providers: ProviderInfo[], t: TFn): string {
  if (providers.length === 0) return "";
  const ready = providers.filter(p => p.configurationStatus === "ready").length;
  const needsSetup = providers.filter(p => p.configurationStatus === "needs_setup").length;
  const disabled = providers.filter(p => p.configurationStatus === "disabled").length;
  const parts = [t("pws.groupReady", { count: ready })];
  if (needsSetup > 0) parts.push(t("pws.groupNeedsSetup", { count: needsSetup }));
  if (disabled > 0) parts.push(t("pws.groupDisabled", { count: disabled }));
  return parts.join(META_SEPARATOR);
}

export function providerStatusPresentation(provider: ProviderInfo, t: TFn): { label: string; dotClass: string } {
  switch (provider.configurationStatus) {
    case "ready":
      return { label: t("pws.status.ready"), dotClass: "dot-green" };
    case "disabled":
      return { label: t("prov.disabledBadge"), dotClass: "dot-muted" };
    case "needs_setup":
      return { label: t("pws.status.needsSetup"), dotClass: "dot-amber" };
  }
}

export function sidecarModelOptions(models: ModelInfo[]) {
  const out: Array<{ value: string; label: string }> = [];
  for (const model of models) {
    if (model.provider === "openai" || model.provider === "anthropic") {
      out.push({ value: model.id, label: `${model.provider}/${model.id}` });
    }
  }
  return out;
}

export function sidecarBackendForModel(models: ModelInfo[], modelId: string): SidecarBackend {
  return models.find(model => model.id === modelId)?.provider === "anthropic" ? "anthropic" : "openai";
}

let lastInputWasKeyboard = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", () => { lastInputWasKeyboard = true; }, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => { lastInputWasKeyboard = false; }, { capture: true, passive: true });
}

function focusTriggerQuietly(trigger: HTMLButtonElement | null) {
  if (!trigger) return;
  if (lastInputWasKeyboard) {
    trigger.focus({ preventScroll: true });
    return;
  }
  try {
    trigger.focus({ preventScroll: true, focusVisible: false });
  } catch {
    trigger.focus({ preventScroll: true });
  }
}

export function useModalDialog(open: boolean, triggerRef: RefObject<HTMLButtonElement | null>) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }

    if (dialog.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [open, triggerRef]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [triggerRef]);

  return dialogRef;
}

export type { StartupHealthStatus };
