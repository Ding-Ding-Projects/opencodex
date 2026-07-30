import { expect, test } from "bun:test";
import { en } from "../src/i18n/en";
import { M3_EN } from "../src/i18n/m3";
import { interpolate, type TFn } from "../src/i18n/shared";
import { normalizeInjectionSelection } from "../src/pages/dashboard-core-poll";
import { modelMetaLabel, providersStatHint } from "../src/pages/dashboard-shared";
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
 * The providers stat hint is computed from the same `hasApiKey` flag the providers
 * table draws its status dot from, so the two surfaces cannot disagree.
 */
test("Dashboard providers stat hint counts ready vs needs-setup", () => {
  const provider = (name: string, hasApiKey: boolean) =>
    ({ name, adapter: "openai", baseUrl: "https://example.invalid", hasApiKey });
  expect(providersStatHint([provider("a", true), provider("b", true), provider("c", false)], t))
    .toBe("Ready (2) · Needs setup (1)");
  // Nothing to split: the "needs setup" half is omitted rather than shown as zero.
  expect(providersStatHint([provider("a", true)], t)).toBe("Ready (1)");
  expect(providersStatHint([], t)).toBe("");
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
    expect(src).toContain('href="#regex"');
    expect(src).toContain('t("search.regexHint")');
  }
  expect(panels).toContain('t("settings.search")');
  expect(panels).toContain('t("settings.noMatch")');
  expect(panels).toContain('t("settings.openBuilder")');
  expect(panels).toContain("settingMatches(");
  expect(modelsTab).toContain('t("search.openBuilder")');
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
