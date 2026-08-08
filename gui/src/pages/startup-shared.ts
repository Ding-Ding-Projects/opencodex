import type { TKey } from "../i18n/shared";
import { startupRiskDetailKey } from "../startup-health-ui";

export type StartupStatus = "native" | "protected" | "at-risk";
export type StartupProtection = "service" | "shim" | "none";
export type StartupInstallAction = "install-service" | "install-shim";

export interface StartupHealthData {
  status: StartupStatus;
  routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
  routingInjected: boolean;
  localRoutingDependency: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: "full" | "cli-only" | "none";
  platform: string;
  recommendedCommand: string | null;
  diagnosticStale: boolean;
  commands: {
    installService: string;
    installShim: string;
    restoreNative: string;
  };
}

export interface TrayStatusData {
  supported: boolean;
  installed: boolean;
  running: boolean;
  stale: boolean;
  summary: string;
}

export function isTrayStatusData(value: unknown): value is TrayStatusData {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.supported === "boolean"
    && typeof row.installed === "boolean"
    && typeof row.running === "boolean"
    && typeof row.stale === "boolean"
    && typeof row.summary === "string";
}

export const STATUS_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.status.native",
  protected: "startup.status.protected",
  "at-risk": "startup.status.atRisk",
};

export const SUMMARY_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.summary.native",
  protected: "startup.summary.protected",
  "at-risk": "startup.summary.atRisk",
};

export const PROTECTION_KEYS: Record<StartupProtection, TKey> = {
  service: "startup.protection.service",
  shim: "startup.protection.shim",
  none: "startup.protection.none",
};

/**
 * The id each searchable row on the Startup screen is indexed under.
 *
 * `Startup.tsx` builds the option list and `startup-sections.tsx` gates its own
 * rows, so the two files have to name every row identically. A typo in either
 * one does not fail a build — it hides a row for as long as anything is typed in
 * the search field, which is the one failure this whole feature exists to
 * remove. So the names are written once and read from both sides.
 */
export const SEARCH_ID = {
  status: "status",
  routing: "routing",
  protection: "protection",
  preference: "preference",
  service: "service",
  shim: "shim",
  trayLogin: "trayLogin",
  trayInstall: "trayInstall",
  trayStart: "trayStart",
  trayStop: "trayStop",
  trayUninstall: "trayUninstall",
  commandService: "command-service",
  commandShim: "command-shim",
  commandNative: "command-native",
} as const;

/**
 * A status pill exactly as it renders: the one word it shows, and whether that
 * word is good news.
 *
 * These live here rather than beside the markup because the search has to index
 * the *same* word the pill shows — "Not installed" is precisely what a user
 * types when they go looking for the tray row. Deriving the word twice, once to
 * render and once to index, is how a search starts disagreeing with the screen
 * it is searching.
 */
export interface StartupPill {
  key: TKey;
  ok: boolean;
}

export function routingKey(data: StartupHealthData): TKey {
  switch (data.routingKind) {
    case "opencodex-local": return "startup.routing.proxy";
    case "custom-local": return "startup.routing.customLocal";
    case "custom-remote": return "startup.routing.customRemote";
    case "unknown": return "startup.routing.unknown";
    default: return "startup.routing.native";
  }
}

/** The hero's status pill — the word above the summary headline. */
export function heroStatusKey(data: StartupHealthData, failed: boolean): TKey {
  return failed ? "startup.status.atRisk" : STATUS_KEYS[data.status];
}

/** The hero's headline. A failed diagnostic replaces it outright: the last
 *  known summary would read as a fresh verdict it no longer is. */
export function heroSummaryKey(data: StartupHealthData, failed: boolean): TKey {
  return failed ? "startup.error" : SUMMARY_KEYS[data.status];
}

/** The paragraph under the headline. */
export function heroDetailKey(data: StartupHealthData, failed: boolean): TKey {
  if (failed) return "startup.staleData";
  return data.status === "at-risk" ? startupRiskDetailKey(data) : "startup.safeDetail";
}

export function servicePill(data: StartupHealthData): StartupPill {
  if (data.serviceViable) return { key: "startup.viable", ok: true };
  const key: TKey = data.serviceConflict ? "startup.conflict"
    : data.serviceStale ? "startup.stale"
      : data.serviceInstalled ? "startup.unhealthy"
        : data.serviceSupported ? "startup.notInstalled"
          : "startup.unsupported";
  return { key, ok: false };
}

export function shimPill(data: StartupHealthData): StartupPill {
  if (data.shimHealthy && data.autostartEnabled) {
    return { key: data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy", ok: true };
  }
  const key: TKey = data.shimInstalled
    ? data.shimHealthy && !data.autostartEnabled ? "startup.installedDisabled" : "startup.stale"
    : "startup.notInstalled";
  return { key, ok: false };
}

/**
 * The tray's pill. "Checking…" and "Status unavailable" are not good news, so
 * they take the same warn tone a stopped tray does — the row must never look
 * settled while the status behind it is unknown.
 */
export function trayPill(tray: TrayStatusData | null, loading: boolean, error: boolean): StartupPill {
  if (loading) return { key: "startup.tray.loading", ok: false };
  if (error || !tray) return { key: "startup.tray.unavailable", ok: false };
  if (tray.running && !tray.stale) return { key: "startup.tray.running", ok: true };
  const key: TKey = tray.stale ? "startup.tray.stale"
    : tray.installed ? "startup.tray.stopped"
      : "startup.tray.notInstalled";
  return { key, ok: false };
}

export interface TrayActionsAvailable {
  install: boolean;
  start: boolean;
  stop: boolean;
  uninstall: boolean;
}

/**
 * Which tray buttons the current status actually offers.
 *
 * The search only indexes a button the screen is really showing: counting
 * "Show tray icon" while the tray is already running would report a match the
 * user then cannot find, which is the same lie as hiding a row that exists.
 */
export function trayActionsAvailable(
  tray: TrayStatusData | null,
  loading: boolean,
  error: boolean,
): TrayActionsAvailable {
  if (loading || error || !tray) return { install: false, start: false, stop: false, uninstall: false };
  return {
    install: !tray.installed && !tray.stale,
    start: tray.installed && !tray.stale && !tray.running,
    stop: tray.running && !tray.stale,
    uninstall: tray.installed || tray.stale,
  };
}

export interface StartupCommandRow {
  id: string;
  labelKey: TKey;
  command: string;
}

/**
 * The repair commands, in the order they are listed. The service command is
 * absent on a platform that has no service to install, so the index never
 * promises a row the card does not draw.
 */
export function startupCommandRows(data: StartupHealthData): StartupCommandRow[] {
  return [
    ...(data.serviceSupported
      ? [{ id: SEARCH_ID.commandService, labelKey: "startup.command.service" as TKey, command: data.commands.installService }]
      : []),
    { id: SEARCH_ID.commandShim, labelKey: "startup.command.shim", command: data.commands.installShim },
    { id: SEARCH_ID.commandNative, labelKey: "startup.command.native", command: data.commands.restoreNative },
  ];
}
