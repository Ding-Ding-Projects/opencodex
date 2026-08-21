import { expect, test } from "bun:test";
import { en } from "../src/i18n/en";
import { M3_EN } from "../src/i18n/m3";
import { interpolate, type TFn } from "../src/i18n/shared";
import {
  fetchDashboardCore,
  normalizeInjectionSelection,
  type DashboardEpochRefs,
} from "../src/pages/dashboard-core-poll";
import {
  defaultUpdateChannel,
  modelMetaLabel,
  providerStatusPresentation,
  providersStatHint,
  type ProviderInfo,
} from "../src/pages/dashboard-shared";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS } from "../src/startup-health-ui";

/** English resolver, enough for the pure label helpers below. */
const t: TFn = (key, vars) => interpolate(
  (en as Record<string, string>)[key] ?? (M3_EN as Record<string, string>)[key] ?? key,
  vars,
);

test("project-config diagnostics poll cadence is owned by the shared constant", () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
});

test("Dashboard wires a single project-config diagnostics owner outside the settings poll", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  // Diagnostics live in their own fetcher + client-resource poll, not inside core health.
  expect(core.match(/diagnostics\/project-config/g)?.length ?? 0).toBe(1);
  expect(hook).toContain("fetchProjectConfigDiagnostics");
  expect(hook).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  // Core poll must not own the diagnostics endpoint.
  const coreFnStart = core.indexOf("export async function fetchDashboardCore");
  expect(coreFnStart).toBeGreaterThan(-1);
  const coreBody = core.slice(coreFnStart);
  expect(coreBody).not.toContain("diagnostics/project-config");
});

test("Dashboard usage polling cannot delay core health and settings", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const coreFnStart = core.indexOf("export async function fetchDashboardCore");
  const usageFnStart = core.indexOf("export async function fetchDashboardUsage");
  expect(coreFnStart).toBeGreaterThan(-1);
  expect(usageFnStart).toBeGreaterThan(-1);
  expect(core.slice(coreFnStart)).not.toContain("/api/usage?range=30d");
  expect(hook).toContain("dashboard-usage:${apiBase}");
  expect(hook).toContain("fetchDashboardUsage(apiBase, signal)");
  expect(hook).toMatch(/dashboard-usage:\$\{apiBase\}[\s\S]*pollMs: 60_000/);
});

test("Dashboard workspace pane is a labelled section, not a nested main landmark", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("dashboard-workspace-main");
  expect(src).toContain("dash.workspace.sections");
  expect(src).not.toMatch(/<main\b[^>]*dashboard-workspace-main/);
  expect(src).toMatch(/<(section)\b[^>]*dashboard-workspace-main/);
});

test("native Codex subagent defaults stay separate from OpenCodex guidance", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const sections = await Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text();
  const head = await Bun.file(new URL("../src/pages/dashboard-overview-head.tsx", import.meta.url)).text();
  expect(core).toContain("syncCodexSubagentDefaults: data.syncCodexSubagentDefaults === true");
  expect(sections).toContain("saveInjection({ syncCodexSubagentDefaults: !syncCodexSubagentDefaults })");
  expect(sections).toContain("disabled={injectionSaving || !injectionModel}");
  expect(sections).not.toContain("injectionSaving || !multiAgentGuidanceEnabled");
  expect(sections).not.toContain("dash.injectionActive");
  expect(en["dash.syncCodexSubagentDefaults"]).toBe("Use as native Codex subagent defaults");
  expect(en["dash.syncCodexSubagentDefaultsHint"]).toContain("Off by default");
  expect(en["dash.syncCodexSubagentDefaultsHint"]).toContain("existing user-owned [agents] defaults are preserved rather than overwritten");
  expect(en["dash.multiAgentGuidanceHint"]).not.toContain("proactive");
  expect(head).toContain("models.v2Mode_");
});

test("injection writes consume the server's model-clear normalization", () => {
  expect(normalizeInjectionSelection({
    multiAgentGuidanceEnabled: true,
    syncCodexSubagentDefaults: false,
    model: null,
    effort: null,
  })).toEqual({
    multiAgentGuidanceEnabled: true,
    syncCodexSubagentDefaults: false,
    injectionModel: "",
    injectionEffort: "",
  });
});

test("a healthy proxy stays online when an optional management resource is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const epochs: DashboardEpochRefs = {
    settingsRequestEpochRef: { current: 0 },
    settingsMutationEpochRef: { current: 0 },
    settingsMutationInFlightRef: { current: false },
    shadowCallRequestEpochRef: { current: 0 },
    shadowCallMutationEpochRef: { current: 0 },
    shadowCallMutationInFlightRef: { current: false },
  };
  try {
    for (const failure of ["503", "malformed", "rejected"] as const) {
      globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/healthz") return Response.json({ status: "ok", version: "0.0.0-test", uptime: 1 });
        if (path === "/api/providers") {
          if (failure === "503") return new Response("temporarily unavailable", { status: 503 });
          if (failure === "malformed") return Response.json({ providers: "not-an-array" });
          throw new Error("provider request rejected");
        }
        if (path === "/api/settings") return Response.json({ codexAutoStart: true, port: 10100, hostname: "127.0.0.1" });
        if (path === "/api/sidecar-settings") {
          return Response.json({ webSearch: { model: "search" }, vision: { model: "vision" } });
        }
        if (path === "/api/shadow-call-settings") return Response.json({ enabled: false, model: "gpt-5.5" });
        if (path === "/api/v2") return Response.json({ multiAgentMode: "default" });
        if (path === "/api/injection-model") return Response.json({ model: null, effort: null, efforts: [], available: [] });
        if (path === "/api/effort-caps") return Response.json({ effortCap: null, subagentEffortCap: null });
        throw new Error(`unexpected dashboard request: ${path}`);
      };

      const data = await fetchDashboardCore("http://127.0.0.1:10100", new AbortController().signal, epochs);
      expect(data.health).toEqual({ status: "ok", version: "0.0.0-test", uptime: 1 });
      expect(data.error).toBe(false);
      expect(data.providers).toBeUndefined();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * Supersession: the Material 3 port moved the sync outcome off the Maintenance
 * card and onto the shell's snackbar host, because an informational result is a
 * notification, not a panel that shoves the buttons down the card. The invariant
 * being defended is unchanged and re-pinned at the new location — a sync that
 * rewrote native Codex subagent defaults must still say so, and must not be
 * reported as a clean success.
 */
test("Dashboard sync surfaces native subagent default warnings", async () => {
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  expect(hook).toContain("data.nativeSubagentDefaultsWarning");
  // The warning rides in the snackbar body and drags the tone off "success".
  expect(hook).toMatch(/tone: data\.nativeSubagentDefaultsWarning \? "warn" : "success"/);
  expect(hook).toMatch(/notify\(\{\s*tone: "error", title: t\("dash\.syncFailed"/);
  // And the Maintenance card no longer keeps a private copy of the result.
  const sections = await Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text();
  expect(sections).not.toContain("syncResult");
});

/**
 * The prototype prints `provider · ctx · cap` under every model on the Models tab.
 * `/api/models` has always returned that metadata; the Dashboard's own `ModelInfo`
 * dropped it, so the list rendered a bare id. Every part is real payload data — a
 * model that reports no context window contributes nothing rather than a made-up
 * number.
 */
test("Dashboard model meta is built from the payload, never invented", () => {
  expect(modelMetaLabel({ id: "gpt-5.5", provider: "openai", contextWindow: 400_000 }, t))
    .toBe("openai · 400k ctx");
  expect(modelMetaLabel({
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    contextCap: 350_000,
    contextCapped: true,
    inputModalities: ["text", "image"],
  }, t)).toBe("anthropic · 1000k ctx · 350k cap · text, image");
  // No metadata at all: the provider alone, not a fabricated window.
  expect(modelMetaLabel({ id: "mystery", provider: "openrouter" }, t)).toBe("openrouter");
});

/**
 * The providers stat hint and row presentation consume the same server-authored
 * configuration status, so no-key routes and disabled providers stay distinct.
 */
test("Dashboard provider summary and rows use authoritative configuration status", () => {
  const provider = (
    name: string,
    configurationStatus: ProviderInfo["configurationStatus"],
    configurationReason: ProviderInfo["configurationReason"],
    hasApiKey = false,
  ): ProviderInfo => ({
    name,
    adapter: "openai",
    baseUrl: "https://example.invalid",
    hasApiKey,
    configurationStatus,
    configurationReason,
  });
  const forward = provider("forward", "ready", "forward");
  const keyed = provider("keyed", "ready", "api_key", true);
  const missing = provider("missing", "needs_setup", "missing_api_key", true);
  const disabled = provider("disabled", "disabled", "disabled", true);

  expect(providersStatHint([forward, keyed, missing, disabled], t))
    .toBe("Ready (2) · Needs setup (1) · Disabled (1)");
  // Nothing to split: zero-count setup and disabled fragments stay omitted.
  expect(providersStatHint([forward], t)).toBe("Ready (1)");
  expect(providersStatHint([], t)).toBe("");

  expect(providerStatusPresentation(forward, t)).toEqual({ label: "Ready", dotClass: "dot-green" });
  expect(providerStatusPresentation(missing, t)).toEqual({ label: "Needs setup", dotClass: "dot-amber" });
  expect(providerStatusPresentation(disabled, t)).toEqual({ label: "Disabled", dotClass: "dot-muted" });
});

/**
 * Every settings mutation on this screen is recorded in the append-only revision log,
 * so a mistaken toggle or a replaced model can be found and undone. The entries are
 * named after what changed ("… set to …"), never "Updated", and each carries the prior
 * value in `before` so a restore has something to put back.
 */
test("Dashboard settings mutations are recorded as version-history revisions", async () => {
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  expect(hook).toContain('import { recordRevision } from "../shell/revisions"');
  expect(hook).toContain('scope: "settings"');
  expect(hook).toContain('t("dash.revision.changed", { setting, value })');
  expect(hook).toContain('t("dash.revision.cleared", { setting })');
  // Every mutation the screen owns logs one.
  for (const setting of [
    "dash.webSearchSidecar",
    "dash.visionSidecar",
    "dash.shadowCallIntercept",
    "dash.shadowCallModel",
    "dash.multiAgent",
    "dash.multiAgentGuidance",
    "dash.syncCodexSubagentDefaults",
    "dash.injectionLabel",
    "dash.injectionEffortLabel",
    "dash.codexAutoStart",
  ]) {
    expect(hook).toMatch(new RegExp(`logSettingRevision\\(\\s*t\\("${setting.replace(".", "\\.")}"\\)`));
  }
  // Effort caps live in the panel file and log through the same helper.
  const sections = await Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text();
  expect(sections).toContain('logSettingRevision(t("dash.effortCapLabel")');
  expect(sections).toContain('logSettingRevision(t("dash.subagentEffortCapLabel")');
  // An unchanged state records nothing, so the panel stays a list of real events.
  expect(hook).toContain("!== previous.webSearch.model");
  expect(sections).toContain("nextCap !== before.effortCap");
});

/**
 * Startup health is the prototype's tonal banner with a real action button, not the
 * legacy hairline strip whose only affordance was a bare hash link. The error state
 * keeps the error container; everything else is tertiary.
 */
test("Dashboard startup health renders the tonal banner with an action", async () => {
  const head = await Bun.file(new URL("../src/pages/dashboard-overview-head.tsx", import.meta.url)).text();
  expect(head).toContain("dash-banner--tertiary");
  expect(head).toContain('className="dash-banner__action"');
  expect(head).toContain('navigateHash("startup")');
  expect(head).toContain('t("nav.startup")');
  // The legacy strip is gone.
  expect(head).not.toContain("startup-health-bar");
  // Health is still announced, and the slot keeps its live region.
  expect(head).toContain('aria-live="polite"');
});

/**
 * Both search bars on this screen keep plain text as the default and expose the same
 * regex opt-in plus a builder shortcut anchored beside the field — the settings search
 * on Overview and the model search on the Models tab never share state.
 */
test("Dashboard search bars are wired to the regex builder", async () => {
  const panels = await Bun.file(new URL("../src/pages/dashboard-overview-panels.tsx", import.meta.url)).text();
  const modelsTab = await Bun.file(new URL("../src/pages/dashboard-models-section.tsx", import.meta.url)).text();
  for (const src of [panels, modelsTab]) {
    // Anchored beside the field, never a link to the builder page: navigating away
    // is what made the shortcut useless to someone mid-query.
    expect(src).toContain("<RegexBuilderButton");
    expect(src).not.toContain('href="#regex"');
    expect(src).toContain('t("search.regexHint")');
  }
  expect(panels).toContain('t("settings.search")');
  expect(panels).toContain('t("settings.noMatch")');
  expect(panels).toContain('t("settings.openBuilder")');
  expect(panels).toContain("settingMatches(");
  // Each builder is bound to its own field's state, so one cannot rewrite the other's query.
  expect(panels).toContain("value={settingsQuery}");
  expect(modelsTab).toContain("value={modelQuery}");
  // Separate state per field: the settings query never drives the model list.
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  expect(hook).toContain("makeMatcher(modelQuery, modelRegex)");
  expect(hook).toContain("makeMatcher(settingsQuery, settingsRegex)");
});

/**
 * Supersession: the update dialog used the legacy `.notice` / `.notice-warn` pair,
 * which alias the pre-M3 colour variables and cannot be themed with the rest of the
 * screen. The same two states are re-pinned on the M3 vocabulary.
 */
test("Dashboard dialog notices use the M3 notice, not the legacy one", async () => {
  const dialogs = await Bun.file(new URL("../src/pages/dashboard-dialogs.tsx", import.meta.url)).text();
  expect(dialogs).toContain("dash-notice");
  expect(dialogs).toContain("dash-notice--warn");
  expect(dialogs).not.toMatch(/className="notice[ "]/);
  expect(dialogs).not.toContain("notice-warn");
  expect(dialogs).not.toContain("notice-err");
});

/**
 * Supersession: the Models tab drew each model as a `white-space: nowrap` pill whose
 * only readable content was the id — the `provider · ctx · cap` line the prototype
 * prints under every model was hidden in a `title` attribute, which is unreachable by
 * keyboard and unspoken by most screen readers. The prototype's two-line card is now
 * the markup, and the meta is real rendered text.
 */
test("Models tab renders the prototype's two-line cards, not nowrap pills", async () => {
  const modelsTab = await Bun.file(new URL("../src/pages/dashboard-models-section.tsx", import.meta.url)).text();
  expect(modelsTab).toContain('className="dash-model-grid"');
  expect(modelsTab).toContain('className="dash-model-card"');
  expect(modelsTab).toContain('className="dash-model-card__id"');
  expect(modelsTab).toContain('className="dash-model-card__meta"');
  // The meta is the shared label, rendered — not stashed in a tooltip.
  expect(modelsTab).toContain("modelMetaLabel(m, t)");
  expect(modelsTab).not.toContain("dash-model-chip");
  expect(modelsTab).not.toContain("title={modelMetaLabel");

  // The card grid the prototype specifies: auto-fill at a 260px minimum, so a long
  // model id wraps inside its card instead of scrolling the page sideways.
  const css = await Bun.file(new URL("../src/styles-dashboard-workspace.css", import.meta.url)).text();
  const grid = css.slice(css.indexOf(".dash-model-grid {"), css.indexOf("}", css.indexOf(".dash-model-grid {")));
  expect(grid).toContain("minmax(260px, 1fr)");

  // A collection keeps its search bar; the grid replaces the pills, not the field.
  expect(modelsTab).toContain('t("models.search")');
  expect(modelsTab).toContain('role="search"');
});

/**
 * The version stat's hint. The prototype hard-codes "npm latest", which reads as a
 * freshness claim the dashboard cannot make before an update check has run. The hint
 * states only what the running version proves — which dist-tag this build came from —
 * and derives it from the same helper that seeds the update dialog's channel.
 */
test("the version stat hints the release channel, not an unchecked freshness claim", async () => {
  const head = await Bun.file(new URL("../src/pages/dashboard-overview-head.tsx", import.meta.url)).text();
  expect(head).toContain('t("dash.channelHint"');
  expect(head).toContain("defaultUpdateChannel(health.version)");
  // No borrowed freshness copy.
  expect(head).not.toContain("npm latest");

  // The hint is only claimed when a version actually arrived.
  expect(head).toContain("health?.version ? t(\"dash.channelHint\"");

  expect(M3_EN["dash.channelHint"]).toBe("{channel} channel");
  expect(t("dash.channelHint", { channel: defaultUpdateChannel("0.0.33.1") })).toBe("latest channel");
  expect(t("dash.channelHint", { channel: defaultUpdateChannel("0.0.34-preview.2") })).toBe("preview channel");
});

/**
 * Every screen is one labelled landmark named by its own lead paragraph, so a screen
 * reader can jump to it and hear which screen it landed on. The Dashboard was an
 * anonymous div whose only name was the nav item that had opened it.
 */
test("the Dashboard is a landmark named by its lead paragraph", async () => {
  const page = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(page).toContain("const DASHBOARD_LEAD_ID = \"dashboard-lead\"");
  expect(page).toContain('<section className="dashboard-workspace-shell" aria-labelledby={DASHBOARD_LEAD_ID}>');
  expect(page).toContain('<p id={DASHBOARD_LEAD_ID} className="m3-page-lead dash-subtitle">');
  // The lead is body-large at a readable measure, not the body-small card subtitle.
  const shell = await Bun.file(new URL("../src/styles/m3-shell.css", import.meta.url)).text();
  const lead = shell.slice(shell.indexOf(".m3-page-lead {"), shell.indexOf("}", shell.indexOf(".m3-page-lead {")));
  expect(lead).toContain("max-width: 74ch");
  expect(lead).toContain("var(--t-body-l)");
});
