import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice } from "../ui";
import { useI18n, useT, LOCALES } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { backgroundHelperOptions } from "./claude-code-helper-options";
import { reconcileAutoConnectState } from "./claude-autoconnect";
import { buildManualEnv } from "./claude-manual-env";
import {
  ClaudeCodeAliasesSection,
  ClaudeCodeModelMapSection,
  ClaudeCodeQuickstartSection,
  ClaudeCodeSettingsCard,
} from "./claude-code-sections";
import { serializeSidecarOverride } from "./claude-code-sidecar";
import { formatCompactWindow, newClientId, type ClaudeCodeState, type MapRow } from "./claude-code-types";
import { SmallFastModelSetting } from "./claude-code-settings";

export { AutoConnectSetting, SmallFastModelSetting } from "./claude-code-settings";

const CONTEXT_WINDOW_PRESETS = [100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000, 900_000, 1_000_000];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function buildWindowOptions(current: number | null, automaticLabel: string, locale: string) {
  const values = current !== null && !CONTEXT_WINDOW_PRESETS.includes(current)
    ? [...CONTEXT_WINDOW_PRESETS, current].sort((a, b) => a - b)
    : CONTEXT_WINDOW_PRESETS;
  return [
    { value: "", label: automaticLabel },
    ...values.map(value => ({
      value: String(value),
      label: current === value && !CONTEXT_WINDOW_PRESETS.includes(value)
        ? new Intl.NumberFormat(locale).format(value)
        : formatCompactWindow(value, locale),
    })),
  ];
}

export default function ClaudeCode({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang ?? "en";
  const [state, setState] = useState<ClaudeCodeState | null>(null);
  const [persistedMaxContextTokens, setPersistedMaxContextTokens] = useState<number | null>(null);
  const [invalidStoredMaxContext, setInvalidStoredMaxContext] = useState(false);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/claude-code`);
      const r = await readJsonOrThrow<ClaudeCodeState & { modelMap?: Record<string, string> }>(
        res,
        t("claude.loadFail"),
      );
      if (!r) {
        setOk(false);
        setStatus(t("claude.loadFail"));
        return;
      }
      const maxContextTokens = isPositiveInteger(r.maxContextTokens) ? r.maxContextTokens : null;
      setPersistedMaxContextTokens(maxContextTokens);
      setInvalidStoredMaxContext(r.maxContextTokens !== null && r.maxContextTokens !== undefined && maxContextTokens === null);
      setState({
        ...r,
        // No coercion: an absent config key is AUTO, and coercing it to subscription is
        // what silently converted an untouched auto config on every save.
        authMode: r.authMode === "proxy" || r.authMode === "subscription" ? r.authMode : "auto",
        ...reconcileAutoConnectState(r),
        fastMode: r.fastMode ?? null,
        maxContextTokens,
        autoContext: r.autoContext !== false,
        autoCompactWindow: r.autoCompactWindow ?? null,
        injectAgents: r.injectAgents !== false,
        effectiveModelEnv: r.effectiveModelEnv ?? {},
      });
      setRows(Object.entries(r.modelMap ?? {}).map(([from, to]) => ({ id: newClientId(), from, to: String(to) })));
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.loadFail"));
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

  const modelOptions = useMemo(
    () => backgroundHelperOptions(state?.available, t("claude.smallFastModelUnsetOption")),
    [state?.available, t],
  );

  // Auto-compact window presets (devlog 020 + user request): dropdown like the model
  // pickers. "" = 350k default; a saved off-ladder value is surfaced as its own option.
  const autoCompactOptions = useMemo(
    () => buildWindowOptions(state?.autoCompactWindow ?? null, t("claude.autoCompactDefault"), localeTag),
    [state?.autoCompactWindow, t, localeTag],
  );

  const contextWindowOptions = useMemo(
    () => buildWindowOptions(state?.maxContextTokens ?? null, t("claude.maxContextAutomatic"), localeTag),
    [state?.maxContextTokens, t, localeTag],
  );

  const save = async () => {
    if (!state) return;
    setStatus("");
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
          maxContextTokens: state.maxContextTokens,
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
      setOk(true);
      setStatus(t("claude.saved"));
      await load();
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    }
  };

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("claude.loading")}</div>;
  if (!state) return <Notice tone="err">{status || t("claude.loadFail")}</Notice>;

  return (
    <>
      <div className="page-head"><h2>{t("claude.pageTitle")}</h2></div>
      <p className="page-sub">{t("claude.subtitle")}</p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}
      <ClaudeCodeSettingsCard
        state={state}
        persistedMaxContextTokens={persistedMaxContextTokens}
        invalidStoredMaxContext={invalidStoredMaxContext}
        contextWindowOptions={contextWindowOptions}
        autoCompactOptions={autoCompactOptions}
        onStateChange={setState}
      />
      <ClaudeCodeQuickstartSection manualEnv={buildManualEnv(state)} />
      <SmallFastModelSetting
        value={state.smallFastModel}
        tierHaikuModel={state.tierModels?.haiku}
        options={modelOptions}
        onChange={smallFastModel => setState({ ...state, smallFastModel })}
      />
      <ClaudeCodeModelMapSection rows={rows} onRowsChange={setRows} onSave={() => { void save(); }} />
      <ClaudeCodeAliasesSection aliases={state.aliases} />
    </>
  );
}
