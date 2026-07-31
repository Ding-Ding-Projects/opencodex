import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "../shell/m3-ui";
import { useNotifications } from "../shell/notifications-context";
import { useI18n, useT, LOCALES } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { reconcileAutoConnectState } from "./claude-autoconnect";
import { buildManualEnv } from "./claude-manual-env";
import {
  ClaudeCodeAliasesSection,
  ClaudeCodeModelMapSection,
  ClaudeCodeQuickstartSection,
  ClaudeCodeSaveBar,
  ClaudeCodeSettingsCard,
} from "./claude-code-sections";
import { serializeSidecarOverride } from "./claude-code-sidecar";
import { formatCompactWindow, newClientId, type ClaudeCodeState, type MapRow } from "./claude-code-types";
import { ClaudeSettingsSearchRow, SmallFastModelSetting } from "./claude-code-settings";
import { claudeSettingsSearch } from "./claude-settings-search";

export { AutoConnectSetting, SmallFastModelSetting } from "./claude-code-settings";

export default function ClaudeCode({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const { locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang ?? "en";
  const [state, setState] = useState<ClaudeCodeState | null>(null);
  const [rows, setRows] = useState<MapRow[]>([]);
  // Load failure only. A save outcome is a snackbar — this one is not, because when
  // the config never arrives there is no screen left behind a snackbar to read it on.
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  // This tab's own settings search. Bound to this field alone — it never shares state
  // with another search bar, so two surfaces can hold different queries at once.
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsRegex, setSettingsRegex] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/claude-code`);
      const r = await readJsonOrThrow<ClaudeCodeState & { modelMap?: Record<string, string> }>(
        res,
        t("claude.loadFail"),
      );
      if (!r) {
        setLoadError(t("claude.loadFail"));
        return;
      }
      setState({
        ...r,
        // No coercion: an absent config key is AUTO, and coercing it to subscription is
        // what silently converted an untouched auto config on every save.
        authMode: r.authMode === "proxy" || r.authMode === "subscription" ? r.authMode : "auto",
        ...reconcileAutoConnectState(r),
        fastMode: r.fastMode ?? null,
        maxContextTokens: r.maxContextTokens ?? null,
        autoContext: r.autoContext !== false,
        autoCompactWindow: r.autoCompactWindow ?? null,
        injectAgents: r.injectAgents !== false,
        effectiveModelEnv: r.effectiveModelEnv ?? {},
      });
      setRows(Object.entries(r.modelMap ?? {}).map(([from, to]) => ({ id: newClientId(), from, to: String(to) })));
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error && error.message ? error.message : t("claude.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    // Deferred initial load (matches Models/Usage): avoids synchronous setState
    // inside the effect, per the react-hooks/set-state-in-effect lint gate.
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  // Plain slugs, not `modelLabel()`: the helper-model picker is a native <select>
  // now, and a browser drops markup inside an <option> rather than rendering it —
  // so the icon-prefixed variant would have shown up as nothing at all.
  const modelOptions = useMemo(() => {
    const options = (state?.available ?? []).map(m => ({ value: m, label: m }));
    return [{ value: "", label: t("claude.smallFastModelUnsetOption") }, ...options];
  }, [state?.available, t]);

  // Auto-compact window presets (devlog 020 + user request): dropdown like the model
  // pickers. "" = 350k default; a saved off-ladder value is surfaced as its own option.
  const autoCompactOptions = useMemo(() => {
    const ladder = [100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000, 900_000, 1_000_000];
    // Compact SI-style units (1M / 350k) — technical number format, not prose.
    const current = state?.autoCompactWindow ?? null;
    const values = current !== null && !ladder.includes(current) ? [...ladder, current].sort((a, b) => a - b) : ladder;
    return [
      { value: "", label: t("claude.autoCompactDefault") },
      ...values.map(value => ({ value: String(value), label: formatCompactWindow(value, localeTag) })),
    ];
  }, [state?.autoCompactWindow, t, localeTag]);

  const search = useMemo(
    () => claudeSettingsSearch(settingsQuery, settingsRegex, t),
    [settingsQuery, settingsRegex, t],
  );

  const save = async () => {
    if (!state) return;
    const modelMap: Record<string, string> = {};
    for (const row of rows) {
      if (row.from.trim() && row.to.trim()) modelMap[row.from.trim()] = row.to.trim();
    }
    try {
      const r = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: state.enabled,
          authMode: state.authMode,
          systemEnv: state.systemEnv,
          fastMode: state.fastMode,
          autoContext: state.autoContext,
          autoCompactWindow: state.autoCompactWindow,
          injectAgents: state.injectAgents,
          smallFastModel: state.smallFastModel,
          modelMap,
          webSearchSidecar: serializeSidecarOverride(state.webSearchSidecar),
          visionSidecar: serializeSidecarOverride(state.visionSidecar),
        }),
      });
      await readJsonOrThrow(r, t("claude.saveFailed"));
      // A one-shot outcome, so it leaves as a snackbar rather than pushing the whole
      // form down the page and staying there until the next save clears it.
      notify({ tone: "success", title: t("claude.saved") });
      await load();
    } catch (error) {
      notify({
        tone: "error",
        title: error instanceof Error && error.message ? error.message : t("claude.networkError"),
      });
    }
  };

  if (loading) return <div role="status" style={{ padding: 8, color: "var(--m3-on-surface-variant)" }}>{t("claude.loading")}</div>;
  if (!state) return <Banner tone="error">{loadError || t("claude.loadFail")}</Banner>;

  return (
    <>
      {/* No page title here: the app bar names the screen and the tab names the panel, so
          a third heading was the same words a third time. The lede moved up to Claude.tsx. */}
      {/* Search first, per the prototype: it filters the four cards below it, and reports a
          hit that lives on the Desktop tab instead of pretending the setting does not exist. */}
      <ClaudeSettingsSearchRow
        query={settingsQuery}
        onQuery={setSettingsQuery}
        regexOn={settingsRegex}
        onRegex={setSettingsRegex}
        search={search}
      />
      {/* Always rendered: it commits every setting on this tab, so no query may hide it. */}
      <ClaudeCodeSaveBar onSave={() => { void save(); }} />
      <ClaudeCodeSettingsCard state={state} autoCompactOptions={autoCompactOptions} onStateChange={setState} match={search.matches} />
      {search.matches("quickstart") && <ClaudeCodeQuickstartSection manualEnv={buildManualEnv(state)} />}
      {search.matches("smallFastModel") && <SmallFastModelSetting
        value={state.smallFastModel}
        tierHaikuModel={state.tierModels?.haiku}
        options={modelOptions}
        onChange={smallFastModel => setState({ ...state, smallFastModel })}
      />}
      {search.matches("modelMap") && <ClaudeCodeModelMapSection rows={rows} onRowsChange={setRows} />}
      {search.matches("aliases") && <ClaudeCodeAliasesSection aliases={state.aliases} />}
    </>
  );
}
