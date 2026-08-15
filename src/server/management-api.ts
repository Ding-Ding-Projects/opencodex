import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfigPreservingClaudeCode,
} from "../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../oauth";
import { removeCredential } from "../oauth/store";
import { providerDestinationResolvedError } from "../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../oauth/key-providers";
import { deriveProviderPresets } from "../providers/derive";
import { providerCodexAccountMode } from "../providers/registry";
import { routedSlug, slugEquals } from "../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { clearThreadAccountMap } from "../codex/routing";
import { primeCodexPoolQuotas } from "../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../providers/context-cap";
import { resolveCodexHomeDir } from "../codex/home";
import { readUsageEntries } from "../usage/log";
import { getUsageDebugLogEntries } from "../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../usage/summary";
import { stripCodexRuntimeProviderFields } from "../codex/auth-context";
import { getProviderRegistryEntry } from "../providers/registry";
import { getDebugLogEntries } from "../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../lib/debug-settings";
import type { OcxClaudeCodeConfig, OcxClaudeDesktopProfile, OcxConfig, OcxCustomModel, OcxProviderConfig } from "../types";
import type { DesktopProfileModel } from "../claude/desktop-profile";
import { drainAndShutdown } from "./lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "./request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../usage/cost";
import type { PersistedUsageAttempt } from "../usage/log";
import { isAllowedDownloadCaptureOrigin, isAllowedManagementOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "./auth-cors";
import { applySystemEnvToggle } from "./system-env";

import type { ManagementApiDeps } from "./management/context";
import { handleConfigRoutes } from "./management/config-routes";
import { handleLogsUsageRoutes } from "./management/logs-usage-routes";
import { handleProviderRoutes } from "./management/provider-routes";
import { handleModelRoutes } from "./management/model-routes";
import { handleAgentSettingsRoutes } from "./management/agent-settings-routes";
import { handleOauthAccountRoutes } from "./management/oauth-account-routes";
import { handleComboRoutes } from "./management/combo-routes";
import { handleSystemRoutes } from "./management/system-routes";
import { handleChangelogRoutes } from "./management/changelog-routes";
import { handleNarratorRoutes } from "./management/narrator-routes";
import { handleExportRoutes, type Dataset } from "./management/export-routes";
import { DATASETS } from "../lib/export-datasets";
import { handleHostRoutes } from "./management/host-routes";
import { handleScheduleRoutes } from "./management/schedule-routes";
import { handleAuthenticatorRoutes } from "./management/authenticator-routes";
import { handleSchoolModeRoutes } from "./management/school-mode-routes";
import { handlePdfRoutes } from "./management/pdf-routes";
import { handleConverterRoutes } from "./management/converter-routes";
import { handleConverterQueueRoutes } from "./management/converter-queue-routes";
import { handleModelRuntimeRoutes } from "./management/model-runtime-routes";
import { handleDownloadRoutes } from "./management/download-routes";
import type { ManagementContext } from "./management/context";
export type { ManagementApiDeps } from "./management/context";
import { fetchAllModels } from "./management/shared";

// installed npm version instead of a stale hardcode.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

/**
 * The run number and commit that produced this install, for `/healthz`.
 *
 * `VERSION` alone cannot answer "which build is this": it moves only when an npm
 * release is cut, so every automated build in between reports the same string.
 * That is survivable for a version banner and not survivable for the desktop
 * shell, which asks a proxy already holding its port whether it is the same
 * build before adopting it. Answering that with `VERSION` alone made the
 * previous version of the app indistinguishable from this one, so an updated app
 * adopted the old proxy and served the old dashboard — see
 * `electron/proxy-adoption.mjs`.
 *
 * Read from `build-info.json` beside `package.json`, written by CI. Absent, this
 * is a source checkout or a local package, and it says `dev` rather than
 * inventing a number — a fabricated build id here would be treated as a real
 * identity by the adoption check.
 */
export const BUILD_STAMP: { build: string; commit: string } = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../build-info.json", import.meta.url), "utf8"));
    return {
      build: typeof raw.build === "string" && raw.build ? raw.build : "dev",
      commit: typeof raw.commit === "string" ? raw.commit : "",
    };
  } catch {
    return { build: "dev", commit: "" };
  }
})();

/**
 * The collections `/api/export` can write out.
 *
 * Defined in `lib/export-datasets` so the CLI answers with the same list and the
 * same redaction — the repo's headless-parity test exists precisely to stop one
 * surface drifting ahead of the other.
 */
function exportDatasets(config: OcxConfig): Map<string, Dataset> {
  return new Map(DATASETS.map(dataset => [
    dataset.id,
    { id: dataset.id, label: dataset.label, rows: () => dataset.rows(config) },
  ]));
}

export async function handleManagementAPI(req: Request, url: URL, config: OcxConfig, deps: ManagementApiDeps = {}): Promise<Response | null> {
  // The download-capture family accepts one more caller than the rest of the
  // management plane: the opencodex browser extension itself, whose fetches
  // carry a `*-extension://` origin rather than the dashboard's own. See
  // `isAllowedDownloadCaptureOrigin` in `./auth-cors` for exactly how narrow
  // that widening is — it never applies to any other `/api/*` prefix.
  const originAllowed = isAllowedManagementOrigin(req, config)
    || (url.pathname.startsWith("/api/downloads") && isAllowedDownloadCaptureOrigin(req, config));
  if (!originAllowed) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403, req, config);
  }
  // Management bodies are small JSON (provider names, key ids, settings). Reject oversized
  // payloads before any handler buffers them — the data plane has its own decompression cap.
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return jsonResponse({ error: "request body too large" }, 413, req, config);
    }
  }
  async function refreshCodexCatalogBestEffort(): Promise<void> {
    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
    try {
      const { refreshCodexModelCatalog } = await import("../codex/refresh");
      await refreshCodexModelCatalog(config);
    } catch {
      /* catalog absent */
    }
  }

  async function syncClaudeAgentDefsBestEffort(): Promise<void> {
    try {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
        injectClaudeAgentDefs(config, {});
        return;
      }
      try {
        const [models, { buildClaudeContextWindows }, { visibleNativeSlugs }] = await Promise.all([
          fetchAllModels(config),
          import("../claude/context-windows"),
          import("../codex/catalog"),
        ]);
        injectClaudeAgentDefs(config, buildClaudeContextWindows([...visibleNativeSlugs(config)], models));
      } catch {
        // Keep routes available through a provider-discovery blip. A later
        // launch-time sync restores any context markers missing from this pass.
        injectClaudeAgentDefs(config, {});
      }
    } catch { /* best-effort */ }
  }
  const ctx: ManagementContext = { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort };
  const routed =
    (await handleConfigRoutes(ctx))
    ??     (await handleLogsUsageRoutes(ctx))
    ??     (await handleProviderRoutes(ctx))
    ??     (await handleModelRoutes(ctx))
    ??     (await handleAgentSettingsRoutes(ctx))
    ??     (await handleOauthAccountRoutes(ctx))
    ??     (await handleComboRoutes(ctx))
    ??     (await handleSystemRoutes(ctx))
    ??     (await handleChangelogRoutes(ctx))
    ??     (await handleNarratorRoutes(ctx))
    ??     (await handleExportRoutes(ctx, exportDatasets(config)))
    ??     (await handleHostRoutes(ctx))
    ??     (await handleScheduleRoutes(ctx))
    ??     (await handleAuthenticatorRoutes(ctx))
    ??     (await handleSchoolModeRoutes(ctx))
    ??     (await handlePdfRoutes(ctx))
    ??     (await handleConverterRoutes(ctx))
    ??     (await handleConverterQueueRoutes(ctx))
    ??     (await handleModelRuntimeRoutes(ctx))
    ??     (await handleDownloadRoutes(ctx));
  if (routed) return routed;

  if (url.pathname === "/api/stop" && req.method === "POST") {
    const { restoreNativeCodex } = await import("../codex/inject");
    const { stopServiceIfInstalled, isServiceOwnershipError } = await import("../service");
    try {
      stopServiceIfInstalled();
    } catch (err) {
      if (isServiceOwnershipError(err)) {
        // The installed service belongs to another CODEX_HOME/OPENCODEX_HOME: it would respawn
        // this proxy immediately, and its shared config is not ours to tear down. Refuse the
        // stop instead of half-performing it. 409, not 500 — the request is well-formed.
        return jsonResponse({ success: false, message: err.message }, 409, req, config);
      }
      throw err;
    }
    const restore = restoreNativeCodex();
    // Both managed configs come down together on an explicit teardown. The daemon's own
    // syncCleanup skips this when OCX_SERVICE is set (so a crash/respawn keeps the fence),
    // which is exactly why an intentional stop has to do it here.
    const { stripGrokConfig } = await import("../grok/inject");
    const grok = stripGrokConfig();
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);
    const grokNote = grok.ok ? "" : ` Grok config cleanup failed: ${grok.message}`;
    return jsonResponse(restore.success
      ? { success: true, message: `Proxy stopping, native Codex restored.${grokNote}` }
      : { success: false, message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.${grokNote}` });
  }

  if (url.pathname.startsWith("/api/codex-auth/")) {
    const { handleCodexAuthAPI } = await import("../codex/auth-api");
    return handleCodexAuthAPI(req, url, config);
  }

  return null;
}


export { buildClaudeDesktopState, fetchAllModels } from "./management/shared";
