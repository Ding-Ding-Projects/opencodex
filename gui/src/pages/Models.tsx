import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "../ui";
import { Banner, Button, Chip, Dialog, Empty, SelectField, TextInput, Toggle } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { IconChevron, IconInfo, IconSearch, IconShuffle } from "../icons";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm } from "../shell/confirm-context";
import { recordRevision } from "../shell/revisions";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { type ComboItem, parseComboList } from "../combo-workspace-data";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import {
  buildProviderModelGroups,
  type ConfiguredProviderSummary,
  type ProviderModelGroup,
} from "../models-groups";
import {
  fetchSelectedModels,
  modelVisible,
  putModelVisibility,
  shouldApplyLoadGeneration,
  type ProviderModelMap,
  type ModelVisibilityScope,
  type ModelVisibilityTarget,
} from "../model-visibility";
import {
  activeModelOptions,
  CAP_OPTION_SET,
  CAP_OPTIONS,
  collectDisabledNamespaced,
  CUSTOM_OPTION,
  fmtK,
  PAGE,
  readCollapsedProviders,
  readCombosOpen,
  THREAD_OPTION_SET,
  THREAD_OPTIONS,
  writeCollapsedProviders,
  writeCombosOpen,
  discoveryFailureLabel,
  effortRange,
  makeMatcher,
  type ModelsSettingId,
  type ModelRow,
  type ProviderContextCapsResponse,
  type ShadowCallData,
  type V2Status,
} from "./models-shared";
import { EmptyProviderHint } from "./models-provider-hints";

/**
 * How much of the catalogue the anchored builder is handed as sample text. The
 * string is built on every render of the search row, not only while the panel is
 * open, and this page routinely lists thousands of models across dozens of
 * providers — an unbounded join would be paid for on every keystroke.
 */
const SAMPLE_GROUPS = 8;
const SAMPLE_ROWS_PER_GROUP = 8;

export default function Models({ apiBase }: { apiBase: string }) {
  const t: TFn = useT();
  const { notify } = useNotifications();
  // Shadows the global `confirm` deliberately: an accidental native call in this
  // file is now a type error rather than a grey Windows box at runtime.
  const confirm = useConfirm();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [providers, setProviders] = useState<ConfiguredProviderSummary[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<ProviderModelMap | null>(null);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsRegex, setSettingsRegex] = useState(false);
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [contextCaps, setContextCaps] = useState<Record<string, number>>({});
  const [contextCapValue, setContextCapValue] = useState(350_000);
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedProviders);
  // A failed reload is a standing page condition, not an event: the 10s poll would otherwise
  // stack one un-dismissable error snackbar per tick, so it stays an inline banner.
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadPendingRef = useRef(false);
  // multi_agent_v2 / ultra gate. null = endpoint unavailable (older proxy build) -> section hidden.
  const [v2, setV2] = useState<V2Status | null>(null);
  const [v2Busy, setV2Busy] = useState(false);
  const [v2Note, setV2Note] = useState("");
  const v2BusyRef = useRef(false);
  const [threadsCustom, setThreadsCustom] = useState("");
  const [showThreadsCustom, setShowThreadsCustom] = useState(false);
  const [v2HelpOpen, setV2HelpOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
  const [customModalProvider, setCustomModalProvider] = useState("");
  const [customModalId, setCustomModalId] = useState("");
  const [customFormModelId, setCustomFormModelId] = useState("");
  const [customFormDisplayName, setCustomFormDisplayName] = useState("");
  const [customFormContextWindow, setCustomFormContextWindow] = useState("");
  const [customFormShowCustomCtx, setCustomFormShowCustomCtx] = useState(false);
  const [customFormModalities, setCustomFormModalities] = useState<string[]>(["text"]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [hoveredModel, setHoveredModel] = useState<{ namespaced: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  // Combo summary section. null = loading or failed (section hidden on failure —
  // an API error must never masquerade as "no combos configured").
  const [combos, setCombos] = useState<ComboItem[] | null>(null);
  const [combosError, setCombosError] = useState(false);
  const [combosOpen, setCombosOpen] = useState(readCombosOpen);

  // App owns the in-session view mode; fallback to persisted mode for isolated renders/tests.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const toggleCombosOpen = () => {
    const next = !combosOpen;
    writeCombosOpen(next);
    setCombosOpen(next);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${apiBase}/api/combos`);
        const j = await readJsonOrThrow<unknown>(r);
        if (!cancelled) {
          setCombos(parseComboList(j));
          setCombosError(false);
        }
      } catch {
        if (!cancelled) {
          setCombos(null);
          setCombosError(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled, selectedModels ?? {}),
    [models, disabled, selectedModels],
  );

  const loadShadowCall = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`);
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch { /* old server / network: keep the section disabled */ }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    try {
      const r = await fetch(`${apiBase}/api/v2`);
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) { setV2(null); return; }
      const data = await readJsonIfOk<V2Status>(r);
      if (!data || typeof data.enabled !== "boolean") { setV2(null); return; }
      setV2({
        enabled: data.enabled,
        agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
        maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
        multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
      });
    } catch {
      setV2(null); // old server / network: hide the section instead of guessing
    }
  }, [apiBase]);

  const load = useCallback(async (force = false): Promise<boolean> => {
    if (loadPendingRef.current && !force) return false;
    loadPendingRef.current = true;
    const generation = ++loadGenerationRef.current;
    try {
      const [modelsRes, capsRes, providersRes, selectionData] = await Promise.all([
        fetch(`${apiBase}/api/models`),
        fetch(`${apiBase}/api/provider-context-caps`),
        fetch(`${apiBase}/api/providers`),
        fetchSelectedModels(apiBase),
      ]);
      const [data, capsData, providerData] = await Promise.all([
        readJsonOrThrow<ModelRow[]>(modelsRes),
        readJsonOrThrow<ProviderContextCapsResponse>(capsRes),
        readJsonOrThrow<ConfiguredProviderSummary[]>(providersRes),
      ]);
      if (data === undefined || capsData === undefined || providerData === undefined) {
        throw new Error("models payload missing");
      }
      if (!shouldApplyLoadGeneration(generation, loadGenerationRef.current)) return false;
      void loadV2(); // best-effort, independent of the models fetch
      void loadShadowCall();
      const nextGroups = buildProviderModelGroups(data, providerData);
      setSelectedProvider(prev => (
        prev !== null && !nextGroups.some(group => group.provider === prev)
          ? null
          : prev
      ));
      setModels(data);
      setProviders(providerData);
      setDisabled(collectDisabledNamespaced(data));
      setSelectedModels(selectionData);
      const value = typeof capsData.value === "number" && Number.isFinite(capsData.value) && capsData.value > 0
        ? capsData.value
        : (typeof capsData.cap === "number" && Number.isFinite(capsData.cap) && capsData.cap > 0 ? capsData.cap : undefined);
      if (value !== undefined) setContextCapValue(value);
      setContextCaps(capsData.caps ?? {});
      setLoadError(false);
      return true;
    } catch {
      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
        setLoadError(true);
      }
      return false;
    } finally {
      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
        loadPendingRef.current = false;
        setLoading(false);
      }
    }
  }, [apiBase, loadShadowCall, loadV2]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load (e.g. anthropic right after login) would otherwise stay missing until a manual
    // remove/re-add. Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const timer = window.setInterval(() => {
      if (!busyRef.current) {
        void load();
      }
    }, 10000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [load]);

  const groups = useMemo(
    () => buildProviderModelGroups(models, providers),
    [models, providers],
  );

  /**
   * One search across every provider group, plain text by default with `.*` as an
   * explicit opt-in — see `makeMatcher` for the 400-character cap and the local
   * evaluation that keeps a pasted novel from becoming a backtracking payload.
   */
  const { matchesQuery, regexError } = useMemo(() => {
    const matcher = makeMatcher(query, useRegex);
    return { matchesQuery: matcher.test, regexError: matcher.error };
  }, [query, useRegex]);
  const rowMatches = useCallback(
    (provider: string, row: ModelRow) => matchesQuery(`${row.id} ${row.namespaced} ${provider}`),
    [matchesQuery],
  );

  /**
   * The screen's own settings search, wired to the same builder as the model search.
   * It indexes the settings this page owns — each entry carries the label, the
   * description and the current value, so typing a remembered value finds the control
   * as readily as typing its name.
   */
  const settingsEntries = useMemo((): { id: ModelsSettingId; text: string }[] => [
    {
      id: "shadowCall",
      text: `${t("models.shadowCallIntercept")} ${t("models.shadowCallInterceptHint")} ${shadowCall?.model ?? ""}`,
    },
    {
      id: "subAgent",
      text: [
        t("models.v2Label"),
        t("models.v2Mode_v1"),
        t("models.v2Mode_default"),
        t("models.v2Mode_v2"),
        t("models.v2ModeDesc_v1"),
        t("models.v2ModeDesc_default"),
        t("models.v2ModeDesc_v2"),
      ].join(" "),
    },
    {
      id: "threads",
      text: `${t("models.v2ThreadsLabel")} ${t("models.v2ThreadsDefault")} ${v2?.maxConcurrentThreadsPerSession ?? ""}`,
    },
    {
      id: "contextCap",
      text: [
        t("models.contextCapLabel"),
        t("models.capValue", { value: fmtK(contextCapValue) }),
        t("models.setAll"),
        t("models.setAllHint", { value: fmtK(contextCapValue) }),
      ].join(" "),
    },
  ], [contextCapValue, shadowCall?.model, t, v2?.maxConcurrentThreadsPerSession]);

  const { settingMatches, settingsError, settingsHits } = useMemo(() => {
    const matcher = makeMatcher(settingsQuery, settingsRegex);
    const hits = new Set(settingsEntries.filter(entry => matcher.test(entry.text)).map(entry => entry.id));
    return {
      settingMatches: (id: ModelsSettingId) => hits.has(id),
      settingsError: matcher.error,
      settingsHits: hits.size,
    };
  }, [settingsEntries, settingsQuery, settingsRegex]);

  /** Version history entry for a settings change made here — restore needs a named event, not "Updated". */
  const logRevision = (summary: string) => {
    recordRevision({ scope: "settings", label: t("nav.models"), summary });
  };

  const effectiveVisibleCount = useMemo(() => {
    if (!selectedModels) return 0;
    return models.filter(model => modelVisible(
      selectedModels,
      model.provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    )).length;
  }, [disabled, models, selectedModels]);

  const applyVisibility = async (
    scope: ModelVisibilityScope,
    provider: string,
    targets: ModelVisibilityTarget[],
    enabled: boolean,
  ) => {
    ++loadGenerationRef.current;
    setBusy(true);
    busyRef.current = true;
    let errorKey: "models.saveFailed" | "models.networkError" | null = null;
    try {
      const response = await putModelVisibility(apiBase, scope, provider, targets, enabled);
      if (!response.ok) errorKey = "models.saveFailed";
    } catch {
      errorKey = "models.networkError";
    } finally {
      const refreshed = await load(true);
      if (errorKey) {
        notify({ tone: "error", title: t(errorKey) });
      } else if (refreshed) {
        notify({ tone: "success", title: t("models.applied") });
        logRevision(`${targets.map(target => (target.native ? target.id : `${provider}/${target.id}`)).join(", ")} — ${enabled ? t("models.tipActive") : t("models.tipDisabled")}`);
      }
      setBusy(false);
      busyRef.current = false;
    }
  };

  const toggleProviderCap = async (provider: string) => {
    setBusy(true);
    busyRef.current = true;
    const enabled = contextCaps[provider] !== contextCapValue;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
        setContextCaps(data?.caps ?? {});
        notify({ tone: "success", title: t("models.capApplied") });
        logRevision(`${provider} — ${t("models.capValue", { value: fmtK(contextCapValue) })} ${enabled ? t("models.tipActive") : t("models.tipDisabled")}`);
        await load(true);
      } catch (e) {
        notify({ tone: "error", title: e instanceof Error ? e.message : t("models.capSaveFailed") });
      }
    } catch {
      notify({ tone: "error", title: t("models.networkError") });
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const toggleCollapse = (p: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else n.add(p);
      writeCollapsedProviders(n);
      return n;
    });
  };
  const setAllCollapsed = (collapse: boolean) => {
    setCollapsed(() => {
      const n = collapse ? new Set(groups.map(group => group.provider)) : new Set<string>();
      writeCollapsedProviders(n);
      return n;
    });
  };

  const putCap = async (body: Record<string, unknown>) => {
    setBusy(true);
    busyRef.current = true;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
        if (typeof data?.value === "number" && Number.isFinite(data.value) && data.value > 0) setContextCapValue(data.value);
        setContextCaps(data?.caps ?? {});
        notify({ tone: "success", title: t("models.capApplied") });
        logRevision(`${t("models.contextCapLabel")} ${fmtK(typeof data?.value === "number" ? data.value : contextCapValue)}`);
        await load(true);
      } catch (e) {
        notify({ tone: "error", title: e instanceof Error ? e.message : t("models.capSaveFailed") });
      }
    } catch {
      notify({ tone: "error", title: t("models.networkError") });
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const setGlobalCap = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    void putCap({ value: Math.floor(value) });
  };

  const onSelectCap = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowCustom(true); setCustomCap(String(contextCapValue)); return; }
    setShowCustom(false);
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value !== contextCapValue) setGlobalCap(value);
  };

  const applyCustomCap = () => {
    const value = Number(customCap.replace(/[_,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0) { notify({ tone: "error", title: t("models.capSaveFailed") }); return; }
    setShowCustom(false);
    setGlobalCap(value);
  };

  const allCapped = useMemo(
    () => {
      // Cap aggregate counts routed providers only; the single native group has no cap switch.
      const routed = groups.filter(group => !group.native && group.rows.length > 0);
      return routed.length > 0 && routed.every(group => contextCaps[group.provider] === contextCapValue);
    },
    [groups, contextCaps, contextCapValue],
  );
  const setAll = () => { void putCap({ setAll: !allCapped }); };

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      logRevision(`${t("models.shadowCallIntercept")} — ${patch.enabled ?? shadowCall.enabled ? t("models.tipActive") : t("models.tipDisabled")}${patch.model !== undefined ? ` ${patch.model}` : ""}`);
    } finally {
      setShadowCallSaving(false);
    }
  };

  const setMultiAgentMode = async (mode: "v1" | "default" | "v2") => {
    if (!v2 || v2BusyRef.current) return;
    if (v2.multiAgentMode === mode) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(r, t("models.saveFailed"));
        void loadV2();
        notify({ tone: "success", title: t("models.v2Applied") });
        logRevision(`${t("models.v2Label")} — ${t(`models.v2Mode_${mode}` as TKey)}`);
        setV2Note((data?.warnings ?? []).join(" "));
      } catch (e) {
        notify({ tone: "error", title: e instanceof Error ? e.message : t("models.saveFailed") });
      }
    } catch {
      notify({ tone: "error", title: t("models.networkError") });
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const putV2Threads = async (value: number) => {
    // Same guards as the flag toggle: single-flight + server-side idempotence
    // (setMaxConcurrentThreads no-ops on equal value), so a re-selected current
    // value or a double click can never double-write config.toml.
    if (!v2 || v2BusyRef.current) return;
    if (!Number.isInteger(value) || value < 1) { notify({ tone: "error", title: t("models.v2ThreadsInvalid") }); return; }
    if (v2.maxConcurrentThreadsPerSession === value) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentThreadsPerSession: value }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(r, t("models.saveFailed"));
        if (!data || typeof data.enabled !== "boolean") {
          notify({ tone: "error", title: t("models.saveFailed") });
          return;
        }
        setV2({
          enabled: data.enabled,
          agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
          maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
          multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
        });
        notify({ tone: "success", title: t("models.v2ThreadsApplied") });
        logRevision(`${t("models.v2ThreadsLabel")} — ${value}`);
        setShowThreadsCustom(false);
      } catch (e) {
        notify({ tone: "error", title: e instanceof Error ? e.message : t("models.saveFailed") });
      }
    } catch {
      notify({ tone: "error", title: t("models.networkError") });
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const onSelectThreads = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowThreadsCustom(true); setThreadsCustom(String(v2?.maxConcurrentThreadsPerSession ?? "")); return; }
    setShowThreadsCustom(false);
    void putV2Threads(Number(raw));
  };

  const onRowEnter = (namespaced: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredModel({ namespaced, rect: el.getBoundingClientRect() });
    }, 300);
  };

  const onRowFocus = (namespaced: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredModel({ namespaced, rect: el.getBoundingClientRect() });
  };

  const onRowLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredModel(null), 120);
  };

  const keepRowTipOpen = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  };

  const addCustomModel = async (
    provider: string,
    modelId: string,
    displayName?: string,
    contextWindow?: number,
    inputModalities?: string[],
  ) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId, displayName, contextWindow, inputModalities }),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        notify({ tone: "success", title: t("models.customAdded"), body: `${provider}/${modelId}` });
        logRevision(`${t("models.customAdded")} — ${provider}/${modelId}`);
        await load(true);
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const updateCustomModel = async (id: string, patch: Record<string, unknown>) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        notify({ tone: "success", title: t("models.customUpdated"), body: String(patch.modelId ?? id) });
        logRevision(`${t("models.customUpdated")} — ${String(patch.modelId ?? id)}`);
        await load(true);
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const deleteCustomModel = async (id: string, label: string) => {
    try {
      const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) {
        notify({ tone: "success", title: t("models.customDeleted"), body: label });
        logRevision(`${t("models.customDeleted")} — ${label}`);
        await load(true);
      } else {
        notify({ tone: "error", title: t("models.customSaveFailed") });
      }
    } catch {
      notify({ tone: "error", title: t("models.networkError") });
    }
  };

  if (loading) return <div className="row muted"><span className="spin" /> {t("models.loading")}</div>;
  if (!selectedModels) {
    return <Banner tone="error">{t("models.loadFail")}</Banner>;
  }


  const renderGroup = (group: ProviderModelGroup<ModelRow>) => {
    const { provider, rows, native, liveModels, discovery } = group;
    const isCollapsed = collapsed.has(provider);
    // Final visibility, not just the disable flag: a model is visible to Codex only when the
    // provider allowlist admits it AND it is not disabled. Reading `disabled` alone made the
    // switches disagree with what the picker actually offers.
    const isVisible = (model: ModelRow) => modelVisible(
      selectedModels,
      provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    );
    const activeCount = rows.filter(isVisible).length;
    const capOn = contextCaps[provider] === contextCapValue;
    const isNative = native;
    const discoveryFailure = liveModels && discovery?.status === "failed" ? discovery : undefined;
    const filtered = rows.filter(m => rowMatches(provider, m));
    // Display-only: enabled models float to the top of each provider group so they
    // stay findable in long lists. The sort is stable, so the server order is kept
    // inside each partition, and this does not affect the picker order above
    // (visibility toggles still only filter).
    const sorted = filtered.toSorted((a, b) => Number(!isVisible(a)) - Number(!isVisible(b)));
    const shown = limit[provider] ?? PAGE;
    const visible = sorted.slice(0, shown);
    const remaining = filtered.length - visible.length;
     // An empty provider has nothing to send: keep both bulk buttons inert so we never PUT an
     // empty target list (the management API rejects it with 400).
     const hasRows = rows.length > 0;
     const allOn = !hasRows || rows.every(isVisible);
     const allOff = !hasRows || rows.every(m => !isVisible(m));
     const bulkToggle = (enable: boolean) => {
       if (!hasRows) return;
       void applyVisibility(
         "provider",
         provider,
         rows.map(m => ({ id: m.id, native: m.native === true })),
         enable,
       );
     };
    return (
      <div key={provider} className="m3-card models-provider-card">
       <div className={`row group-head models-provider-head${isCollapsed ? "" : " open"}`}>
          <button
            type="button"
            className="row models-provider-toggle"
            onClick={() => toggleCollapse(provider)}
            aria-expanded={!isCollapsed}
          >
          <IconChevron aria-hidden="true" className="models-provider-chevron" style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }} />
          <span className="text-body font-semibold">{provider}</span>
          {isNative && <span className="models-tag">{t("models.nativeGroupLabel")}</span>}
         {discoveryFailure && (
           <span
             className="badge badge-amber"
             role="status"
             title={discoveryFailureLabel(t, discoveryFailure)}
           >
             {t("models.discoveryFailedBadge")}
           </span>
         )}
          <span className="muted mono text-label">{t("models.active", { active: activeCount, total: rows.length })}</span>
          </button>
           <div className="row models-provider-actions">
             {!isNative && (
               <Button
                 variant="text"
                 className="models-provider-add"
                 onClick={(e) => {
                   e.stopPropagation();
                   setCustomModalMode("add");
                   setCustomModalProvider(provider);
                   setCustomModalId("");
                   setCustomFormModelId("");
                   setCustomFormDisplayName("");
                   setCustomFormContextWindow("");
                   setCustomFormShowCustomCtx(false);
                   setCustomFormModalities(["text"]);
                   setCustomError("");
                   setCustomModalOpen(true);
                 }}
                 aria-label={t("models.customAdd")}
                 aria-haspopup="dialog"
               >+</Button>
             )}
             <Button variant="text" disabled={busy || allOn} onClick={() => bulkToggle(true)}>{t("models.allOn")}</Button>
             <Button variant="text" className="models-btn-quiet" disabled={busy || allOff} onClick={() => bulkToggle(false)}>{t("models.allOff")}</Button>
             {!isNative && <>
               <Toggle on={capOn} onChange={() => void toggleProviderCap(provider)} disabled={busy} label={t("models.capValue", { value: fmtK(contextCapValue) })} />
               <span className="muted mono text-label">{t("models.capValue", { value: fmtK(contextCapValue) })}</span>
             </>}
           </div>
        </div>
        {!isCollapsed && (
          <div className="models-provider-body">
            {isNative && <p className="muted text-label models-provider-note">{t("models.nativeHint")}</p>}
            {rows.length === 0 && (
              <EmptyProviderHint liveModels={liveModels} discovery={discovery} showFailureBadge={false} />
            )}
             {visible.map(m => {
               // The row reflects the same final-visibility answer as the count and the picker.
               const off = !isVisible(m);
               return (
                 <div
                   key={m.namespaced}
                   className="model-row-wrap"
                   onMouseEnter={(e) => onRowEnter(m.namespaced, e.currentTarget)}
                   onMouseLeave={onRowLeave}
                   onFocus={(e) => onRowFocus(m.namespaced, e.currentTarget)}
                   onBlur={(e) => {
                     if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredModel(null);
                   }}
                 >
                   {/* Context and modalities read inline, as the design shows them: a hover-only
                       tooltip hides them from touch and from anyone scanning the list. */}
                   <div className="row models-model-row" style={{ flexWrap: "wrap" }}>
                     <Toggle on={!off} onChange={() => void applyVisibility("models", provider, [{ id: m.id, native: m.native === true }], off)} disabled={busy} label={m.native ? m.id : m.namespaced} />
                     <code className={`mono text-control models-model-id${off ? " models-model-id--off" : ""}`} style={{ flex: "1 1 220px" }}>{m.native ? modelLabel(m.id) : m.namespaced}</code>
                     {(m.contextWindow || m.contextCap) && (
                       <span className="muted text-label" style={{ whiteSpace: "nowrap" }}>
                         {t("models.ctxValue", { value: fmtK(m.contextWindow ?? m.contextCap ?? 0) })}
                       </span>
                     )}
                     {m.inputModalities && m.inputModalities.length > 0 && (
                       <span className="muted text-label" style={{ whiteSpace: "nowrap" }}>{m.inputModalities.join(", ")}</span>
                     )}
                     {effortRange(m.reasoningEfforts) && (
                       <span className="muted mono text-label" style={{ whiteSpace: "nowrap" }}>{effortRange(m.reasoningEfforts)}</span>
                     )}
                     {m.custom && (
                       <span className="models-tag">
                         {t("models.customBadge")}
                       </span>
                     )}
                     {m.contextCapped && <span className="models-tag">{t("models.contextCappedValue", { value: fmtK(m.contextCap ?? contextCapValue) })}</span>}
                   </div>
                   {hoveredModel?.namespaced === m.namespaced && (() => {
                     const r = hoveredModel.rect;
                     const tipTop = r.bottom + 4;
                     const flipUp = tipTop + 360 > window.innerHeight;
                     return (
                       <div
                         className={`model-tip${m.custom ? " has-actions" : ""}${flipUp ? " flip-up" : ""}`}
                         role="tooltip"
                         style={{
                           position: "fixed",
                           left: r.left + 24,
                           ...(flipUp
                             ? { bottom: window.innerHeight - r.top + 4 }
                             : { top: tipTop }),
                         }}
                         onMouseEnter={keepRowTipOpen}
                         onMouseLeave={onRowLeave}
                       >
                         <div className="model-tip-id">{m.native ? m.id : m.namespaced}</div>
                         {m.displayName && <div className="model-tip-display">{m.displayName}</div>}
                         {m.custom && (
                           <span className="models-tag models-tag--block">
                             {t("models.customBadge")}
                           </span>
                         )}
                         <div className="model-tip-grid">
                           <span className="model-tip-key">{t("models.tipProvider")}</span>
                           <span className="model-tip-val">{m.provider}</span>
                           {(m.contextWindow || m.contextCap) && (
                             <>
                               <span className="model-tip-key">{t("models.tipContext")}</span>
                               <span className="model-tip-val">{fmtK(m.contextWindow ?? m.contextCap ?? 0)}</span>
                             </>
                           )}
                           {m.inputModalities && m.inputModalities.length > 0 && (
                             <>
                               <span className="model-tip-key">{t("models.tipModalities")}</span>
                               <span className="model-tip-val">{m.inputModalities.join(", ")}</span>
                             </>
                           )}
                           <span className="model-tip-key">{t("models.tipStatus")}</span>
                           <span className="model-tip-val">{off ? t("models.tipDisabled") : t("models.tipActive")}</span>
                         </div>
                         {m.custom && m.customId && (
                           <div className="model-tip-actions">
                             <Button
                               variant="text"
                               onClick={() => {
                                 setCustomModalMode("edit");
                                 setCustomModalProvider(m.provider);
                                 setCustomModalId(m.customId!);
                                 setCustomFormModelId(m.id);
                                 setCustomFormDisplayName(m.displayName ?? "");
                                 setCustomFormContextWindow(m.contextWindow ? String(m.contextWindow) : "");
                                 setCustomFormShowCustomCtx(false);
                                 setCustomFormModalities(m.inputModalities ?? ["text"]);
                                 setCustomError("");
                                 setCustomModalOpen(true);
                                 setHoveredModel(null);
                               }}
                             >{t("models.customEdit")}</Button>
                             <Button
                               variant="text"
                               className="models-btn-danger"
                               onClick={() => {
                                 // The hover card is dismissed first, not after
                                 // the await: it is anchored to a row the dialog
                                 // now covers, and leaving it up behind a modal
                                 // is a tooltip the user cannot dismiss.
                                 const customId = m.customId!;
                                 const namespaced = m.namespaced;
                                 setHoveredModel(null);
                                 void (async () => {
                                   const confirmed = await confirm({
                                     title: t("confirm.deleteModelTitle"),
                                     body: t("models.customDeleteConfirm", { name: m.displayName ?? m.id }),
                                     confirmLabel: t("confirm.deleteAction"),
                                     tone: "danger",
                                   });
                                   if (confirmed) await deleteCustomModel(customId, namespaced);
                                 })();
                               }}
                             >{t("models.customDelete")}</Button>
                           </div>
                         )}
                       </div>
                     );
                   })()}
                 </div>
               );
             })}
             {remaining > 0 && (
               <Button
                 variant="text"
                 onClick={() => setLimit(prev => ({ ...prev, [provider]: shown + PAGE }))}
                 className="models-show-more"
               >{t("models.showMore", { n: remaining })}</Button>
             )}
           </div>
         )}
       </div>
     );
  };

  const scopedGroups = selectedProvider
    ? groups.filter(group => group.provider === selectedProvider)
    : groups;
  // A searching user wants hits, not a wall of headers: groups that match nothing drop out,
  // and every group dropping out is what raises the no-match state below.
  const searching = query.trim().length > 0;
  const visibleGroups = searching
    ? scopedGroups.filter(group => group.rows.some(row => rowMatches(group.provider, row)))
    : scopedGroups;

  // Sample text for the anchored builder: the same haystack `rowMatches` tests, taken
  // from the scoped groups rather than the visible ones — seeding it from what the
  // current query already kept would hide the rows a new pattern is being written for.
  // Bounded per group as well as overall, so one enormous provider cannot crowd out
  // every other name a pattern might need to be tried against.
  const modelSearchSample = scopedGroups
    .slice(0, SAMPLE_GROUPS)
    .flatMap(group => group.rows.slice(0, SAMPLE_ROWS_PER_GROUP).map(row => `${row.id} ${row.namespaced} ${group.provider}`))
    .join("\n");

  const searchBlock = (
    <>
      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-2)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" className="muted" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("models.search")}
          aria-label={t("models.search")}
          aria-invalid={!!regexError}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip
          selected={useRegex}
          onClick={() => setUseRegex(v => !v)}
          title={t("regex.regexMode")}
          aria-label={t("search.regexHint")}
        >
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          className="models-icon-btn"
          value={query}
          onApply={pattern => setQuery(pattern)}
          regex={useRegex}
          onRegexChange={setUseRegex}
          // Real catalogue rows in the same shape the search matches them, taken
          // from the groups in scope rather than from what the query already kept.
          sample={modelSearchSample}
        />
      </div>
      {/* The design reserves this line whether or not a pattern is broken, so typing an
          unfinished regex does not shunt the whole provider list up and down. */}
      <div className="models-search-error" role="alert" style={{ minHeight: 20, color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
        {regexError ? `${t("regex.invalid")}: ${regexError}` : ""}
      </div>
    </>
  );

  // The settings surface on this screen gets its own search bar and its own builder,
  // bound to this field alone — it never shares state with the model search above it.
  const settingsSearchBlock = (
    <>
      <div className="m3-row models-settings-search" role="search" style={{ marginBottom: "var(--sp-2)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" className="muted" />
        <TextInput
          value={settingsQuery}
          onChange={e => setSettingsQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={!!settingsError}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        <Chip
          selected={settingsRegex}
          onClick={() => setSettingsRegex(v => !v)}
          title={t("regex.regexMode")}
          aria-label={t("search.regexHint")}
        >
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          className="models-icon-btn"
          value={settingsQuery}
          onApply={pattern => setSettingsQuery(pattern)}
          regex={settingsRegex}
          onRegexChange={setSettingsRegex}
          // This screen's settings index, which is a different corpus from the
          // model search above — the two builders never share a sample.
          sample={settingsEntries.map(entry => entry.text).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      {/* One status line, as the prototype has it: the broken pattern wins over the
          no-match message, because an unusable pattern is why nothing matched. */}
      <div className="models-settings-status" role="status" style={{ minHeight: 20, marginBottom: "var(--sp-2)", fontSize: "var(--t-label-m)" }}>
        {settingsError
          ? <span style={{ color: "var(--m3-error)" }}>{`${t("regex.invalid")}: ${settingsError}`}</span>
          : (settingsQuery.trim().length > 0 && settingsHits === 0
            ? <span className="muted">{t("settings.noMatch")}</span>
            : "")}
      </div>
    </>
  );

  const controlsBlock = (
    <>
      <div className="models-control-top-row">
        {settingMatches("shadowCall") && <div className="models-shadow-row row muted text-control">
          <span className="models-shadow-label">{t("models.shadowCallIntercept")} <Tooltip content={t("models.shadowCallInterceptHint")} side="top" maxWidth={320}><span style={{ cursor: "help" }} aria-label={t("models.shadowCallInterceptHint")}>ⓘ</span></Tooltip></span>
          <code className="text-caption models-shadow-warning" style={{ opacity: 0.6 }}>{t("models.shadowCallOriginal")}</code>
          <Toggle on={shadowCall?.enabled ?? false} onChange={() => void saveShadowCall({ enabled: !shadowCall?.enabled })} disabled={!shadowCall || shadowCallSaving} label={t("models.shadowCallIntercept")} />
          <div className="models-shadow-model-slot">
            <SelectField value={shadowCall?.model ?? ""} options={[{ value: "", label: "\u2014" }, ...shadowModelOptions]} onChange={v => { setShadowCall(c => c ? { ...c, model: v } : c); void saveShadowCall({ model: v }); }} disabled={!shadowCall || shadowCallSaving || !shadowCall.enabled} label={t("models.shadowCallIntercept")} />
          </div>
        </div>}

        {v2 && settingMatches("subAgent") && (
          <div className="models-v2-mode-row row">
            <span className="muted text-control">{t("models.v2Label")}</span>
            <div className="m3-segmented" role="radiogroup" aria-label={t("models.v2Label")}>
              {(["v1", "default", "v2"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={(v2.multiAgentMode ?? "default") === mode}
                  className={`m3-segment${(v2.multiAgentMode ?? "default") === mode ? " selected" : ""}`}
                  disabled={v2Busy}
                  onClick={() => void setMultiAgentMode(mode)}
                >
                  {t(`models.v2Mode_${mode}` as TKey)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="models-icon-btn"
              onClick={() => setV2HelpOpen(true)}
              aria-label={t("models.v2Label")}
              aria-haspopup="dialog"
            >
              <IconInfo width={20} height={20} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {v2 && settingMatches("threads") && (v2.enabled || v2.agentsMaxThreadsConflict || v2Note) && (
        <div className="models-v2-detail-row row">
          {v2.enabled && (
            <>
              <span className="muted text-control">{t("models.v2ThreadsLabel")}</span>
              <SelectField
                value={showThreadsCustom
                  ? CUSTOM_OPTION
                  : (v2.maxConcurrentThreadsPerSession !== null && v2.maxConcurrentThreadsPerSession !== undefined
                    ? (THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) ? String(v2.maxConcurrentThreadsPerSession) : CUSTOM_OPTION)
                    : "")}
                options={[
                  ...(v2.maxConcurrentThreadsPerSession === null || v2.maxConcurrentThreadsPerSession === undefined
                    ? [{ value: "", label: t("models.v2ThreadsDefault") }] : []),
                  ...(v2.maxConcurrentThreadsPerSession !== null && v2.maxConcurrentThreadsPerSession !== undefined
                    && !THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) && !showThreadsCustom
                    ? [{ value: CUSTOM_OPTION, label: String(v2.maxConcurrentThreadsPerSession) }] : []),
                  ...THREAD_OPTIONS.map(v => ({ value: String(v), label: String(v) })),
                  { value: CUSTOM_OPTION, label: t("models.custom") },
                ]}
                onChange={v => onSelectThreads(v)}
                disabled={v2Busy}
                label={t("models.v2ThreadsLabel")}
              />
              {showThreadsCustom && (
                <>
                  <input
                    className="m3-input models-input-narrow"
                    inputMode="numeric"
                    value={threadsCustom}
                    onChange={e => setThreadsCustom(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}
                    disabled={v2Busy}
                    aria-label={t("models.v2ThreadsLabel")}
                  />
                  <Button variant="tonal" disabled={v2Busy}
                    onClick={() => { void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}>
                    {t("models.v2ThreadsApply")}
                  </Button>
                </>
              )}
            </>
          )}
          {v2.enabled && v2.agentsMaxThreadsConflict && (
            <span className="mono text-label models-conflict">{t("models.v2Conflict")}</span>
          )}
          {v2Note && <span className="muted text-label">{v2Note}</span>}
        </div>
      )}

      {settingMatches("contextCap") && <div className="row models-cap-row" role="group" aria-label={t("models.contextCapLabel")}>
        <span className="muted text-control">{t("models.contextCapLabel")}</span>
        {CAP_OPTIONS.map(v => (
          <Chip
            key={v}
            selected={!showCustom && contextCapValue === v}
            disabled={busy}
            onClick={() => onSelectCap(String(v))}
          >{fmtK(v)}</Chip>
        ))}
        <Chip
          selected={showCustom || !CAP_OPTION_SET.has(contextCapValue)}
          disabled={busy}
          onClick={() => onSelectCap(CUSTOM_OPTION)}
        >{!showCustom && !CAP_OPTION_SET.has(contextCapValue) ? fmtK(contextCapValue) : t("models.custom")}</Chip>
        {showCustom && (
          <>
            <input
              className="m3-input models-input-cap"
              inputMode="numeric"
              placeholder={t("models.customPlaceholder")}
              value={customCap}
              onChange={e => setCustomCap(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") applyCustomCap(); }}
              disabled={busy}
              aria-label={t("models.customPlaceholder")}
            />
            <Button variant="tonal" onClick={applyCustomCap} disabled={busy}>{t("models.customApply")}</Button>
          </>
        )}
        <Toggle on={allCapped} onChange={setAll} disabled={busy} label={t("models.setAll")} />
        <span className="muted text-label leading-body">{t("models.setAllHint", { value: fmtK(contextCapValue) })}</span>
      </div>}

      {(() => {
        const customCount = models.filter(m => m.custom).length;
        if (customCount === 0) return null;
        return (
          <div className="row muted text-label models-custom-summary">
            <span className="models-tag">
              {t("models.customSummary", { count: customCount })}
            </span>
          </div>
        );
      })()}

      <div className="row muted text-label leading-body models-order-hint">
        <IconInfo width={18} height={18} aria-hidden="true" />
        <span>{t("models.orderHint")}</span>
      </div>
    </>
  );

  const combosBlock = (
    <>
     {combos !== null && !combosError && combos.length === 0 && (
       <div className="m3-card models-combos-card">
         <div className="row models-combos-head models-row-split">
           <div className="row models-combos-title">
             <IconShuffle width={18} height={18} aria-hidden="true" />
             <strong>{t("nav.combos")}</strong>
             <span className="muted text-label">{t("models.combosEmpty")}</span>
           </div>
           <a className="m3-btn m3-btn--tonal" href="#combos">{t("models.combosSetup")}</a>
         </div>
       </div>
     )}
     {combos !== null && !combosError && combos.length > 0 && (
       <div className="m3-card models-combos-card">
         <div className={`row group-head models-combos-head${combosOpen ? " open" : ""}`}>
           <button
             type="button"
             className="row models-combos-toggle"
             aria-expanded={combosOpen}
             onClick={toggleCombosOpen}
           >
             <IconChevron aria-hidden="true" className="models-provider-chevron" style={{ transform: combosOpen ? "rotate(90deg)" : "none" }} />
             <IconShuffle width={18} height={18} aria-hidden="true" />
             <strong>{t("nav.combos")}</strong>
             <span className="muted mono text-label">{t("models.combosActive", { count: combos.length })}</span>
           </button>
           <a className="m3-btn m3-btn--text" href="#combos">{t("models.combosSetup")}</a>
         </div>
         {combosOpen && (
           <div>
             {combos.map(c => (
               <div key={c.id} className="row models-combo-row">
                 <span className="mono leading-ui">{c.model}</span>
                 <span className="muted text-label">{c.strategy} · {c.targets.length}</span>
               </div>
             ))}
             <a className="row muted models-combos-add" href="#combos">
               + {t("models.combosAdd")}
             </a>
           </div>
         )}
       </div>
     )}
    </>
  );

  const collapseControls = (
    <div className="row models-collapse-row">
      <Button variant="text" onClick={() => setAllCollapsed(true)} disabled={busy}>
        <IconChevron width={16} height={16} aria-hidden="true" /> {t("models.collapseAll")}
      </Button>
      <Button variant="text" onClick={() => setAllCollapsed(false)} disabled={busy}>
        <IconChevron width={16} height={16} aria-hidden="true" style={{ transform: "rotate(90deg)" }} /> {t("models.expandAll")}
      </Button>
    </div>
  );

  const emptyStateBlock = (
    <>
      {groups.length === 0 && (
        <Empty title={t("models.noRouted")}>
          {t("models.noRoutedHint")}
        </Empty>
      )}
    </>
  );

  // The prototype's search_off state: the search found nothing, which is not the same
  // as "no routed models" (that empty state lives above and speaks about setup).
  const noMatchBlock = (
    <Empty title={t("models.noMatch")} />
  );

  const modalsBlock = (
    <>
      {v2HelpOpen && (
        <Dialog
          onClose={() => setV2HelpOpen(false)}
          // Help text about the v2 models, opened to be read while the list it
          // describes stays visible. Not a decision, so not blocking.
          modal={false}
          // The headline carries the id so the dialog keeps the accessible name the
          // legacy overlay set with `aria-label` — `<dialog>` gets no name from its
          // contents, and Dialog exposes `labelledBy` rather than an aria-label prop.
          title={<span id="models-v2-help-title">{t("models.v2Label")}</span>}
          labelledBy="models-v2-help-title"
          // The help text is authored with newlines, so it stays `pre-line`.
          description={<span className="leading-relaxed" style={{ whiteSpace: "pre-line" }}>{t("models.v2Help")}</span>}
          actions={
            <>
              <Button variant="text" className="models-modal-close" onClick={() => setV2HelpOpen(false)} aria-label={t("common.close")}>&times;</Button>
              <Button variant="filled" onClick={() => setV2HelpOpen(false)}>{t("common.ok")}</Button>
            </>
          }
        >
          <div>
            <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--m3-primary)" }}>
              {t("models.v2DocsLink")}
            </a>
          </div>
        </Dialog>
      )}

      {customModalOpen && (
        <Dialog
          // Escape still cannot abandon a save in flight, exactly as the legacy
          // overlay's keydown guard had it.
          onClose={() => { if (!customSaving) setCustomModalOpen(false); }}
          // The form holds whatever the user typed, so a stray scrim click must
          // not discard it.
          dismissOnScrim={false}
          title={
            <span id="models-custom-model-title">
              {customModalMode === "add"
                ? t("models.customAddTitle", { provider: customModalProvider })
                : t("models.customEditTitle", { provider: customModalProvider })}
            </span>
          }
          labelledBy="models-custom-model-title"
          actions={
            <>
              <Button
                variant="text"
                className="models-modal-close"
                onClick={() => setCustomModalOpen(false)}
                disabled={customSaving}
                aria-label={t("common.close")}
              >&times;</Button>
              <Button variant="text" onClick={() => setCustomModalOpen(false)} disabled={customSaving}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="filled"
                disabled={customSaving || !customFormModelId.trim()}
                onClick={() => {
                  const modelId = customFormModelId.trim();
                  const displayName = customFormDisplayName.trim();
                  const ctxVal = customFormContextWindow ? Number(customFormContextWindow.replace(/[_,\s]/g, "")) : undefined;
                  const contextWindow = ctxVal && ctxVal > 0 ? Math.floor(ctxVal) : undefined;
                  if (customModalMode === "add") {
                    void addCustomModel(
                      customModalProvider,
                      modelId,
                      displayName || undefined,
                      contextWindow,
                      customFormModalities.length > 0 ? customFormModalities : undefined,
                    );
                  } else {
                    void updateCustomModel(customModalId, {
                      modelId,
                      displayName,
                      contextWindow: contextWindow ?? null,
                      inputModalities: customFormModalities,
                    });
                  }
                }}
              >
                {customSaving
                  ? t("models.customSaving")
                  : (customModalMode === "add" ? t("models.customAddBtn") : t("models.customEditBtn"))}
              </Button>
            </>
          }
        >
          {/* Inline, not a snackbar: it names why THIS form was refused, and it
              belongs beside the fields the user has to correct. */}
          {customError && <Banner tone="error">{customError}</Banner>}

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {t("models.customFieldModelId")}
              <input
                className="m3-input"
                value={customFormModelId}
                onChange={e => setCustomFormModelId(e.target.value)}
                disabled={customSaving}
                placeholder={t("models.customFieldModelIdPlaceholder")}
                autoFocus
              />
            </label>

            <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {t("models.customFieldDisplayName")}
              <input
                className="m3-input"
                value={customFormDisplayName}
                onChange={e => setCustomFormDisplayName(e.target.value)}
                disabled={customSaving}
                placeholder={t("models.customFieldDisplayNamePlaceholder")}
              />
            </label>

            <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {t("models.customFieldContext")}
              <div className="row" style={{ gap: 6 }}>
                <SelectField
                  value={customFormShowCustomCtx ? CUSTOM_OPTION : customFormContextWindow}
                  options={[
                    { value: "", label: "—" },
                    { value: "100000", label: "100k" },
                    { value: "128000", label: "128k" },
                    { value: "200000", label: "200k" },
                    { value: "256000", label: "256k" },
                    { value: "352000", label: "352k" },
                    { value: "500000", label: "500k" },
                    { value: "1000000", label: "1M" },
                    { value: CUSTOM_OPTION, label: t("models.custom") },
                  ]}
                  onChange={v => {
                    if (v === CUSTOM_OPTION) {
                      setCustomFormShowCustomCtx(true);
                      return;
                    }
                    setCustomFormShowCustomCtx(false);
                    setCustomFormContextWindow(v);
                  }}
                  disabled={customSaving}
                  label={t("models.customFieldContext")}
                />
                {customFormShowCustomCtx && (
                  <input
                    className="m3-input models-input-narrow"
                    inputMode="numeric"
                    value={customFormContextWindow}
                    onChange={e => setCustomFormContextWindow(e.target.value)}
                    disabled={customSaving}
                    placeholder={t("models.customPlaceholder")}
                    aria-label={t("models.customFieldContext")}
                  />
                )}
              </div>
            </label>

            <div className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {t("models.customFieldModalities")}
              <div className="row" style={{ gap: 8 }}>
                {(["text", "image", "audio"] as const).map(mod => (
                  <label key={mod} className="row" style={{ gap: 4, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={customFormModalities.includes(mod)}
                      onChange={e => {
                        setCustomFormModalities(prev => (
                          e.target.checked ? [...prev, mod] : prev.filter(m => m !== mod)
                        ));
                      }}
                      disabled={customSaving}
                    />
                    <span className="text-control">{mod}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );

  return (
    <div className="models-workspace-shell">
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <div className="row">
          <span className="muted mono text-label">{t("models.active", { active: effectiveVisibleCount, total: models.length })}</span>
        </div>
      </div>
      {/* The prototype leads the screen with body-large copy at a 74ch measure. */}
      <p className="m3-page-lead" style={{ whiteSpace: "pre-line" }}>{t("models.subtitle")}</p>
      {loadError && <Banner tone="error">{t("models.loadFail")}</Banner>}
      <div className="models-workspace-root">
        <aside className="models-workspace-rail" aria-label={t("nav.models")}>
          <div className="models-workspace-rail-header">
            <span className="models-workspace-rail-title">{t("models.workspace.providers")}</span>
            <span className="models-workspace-rail-count">{groups.length}</span>
          </div>
          <div className="models-workspace-rail-list">
            <button
              type="button"
              className={`models-workspace-rail-row${selectedProvider === null ? " models-workspace-rail-row--selected" : ""}`}
              onClick={() => setSelectedProvider(null)}
              aria-current={selectedProvider === null ? "true" : undefined}
            >
              <span className="models-workspace-rail-name">{t("models.workspace.allProviders")}</span>
              <span className="models-workspace-rail-meta">{t("models.active", { active: effectiveVisibleCount, total: models.length })}</span>
            </button>
            {groups.map(group => {
              const { provider, rows } = group;
              // Same final-visibility rule as the provider card, so the rail never disagrees with it.
              const activeCount = rows.filter(m => modelVisible(
                selectedModels,
                provider,
                m.id,
                m.native === true,
                disabled.has(m.namespaced),
              )).length;
              return (
                <button
                  key={provider}
                  type="button"
                  className={`models-workspace-rail-row${selectedProvider === provider ? " models-workspace-rail-row--selected" : ""}`}
                  onClick={() => setSelectedProvider(provider)}
                  aria-current={selectedProvider === provider ? "true" : undefined}
                >
                  <span className="models-workspace-rail-name">{provider}</span>
                  <span className="models-workspace-rail-meta">{t("models.active", { active: activeCount, total: rows.length })}</span>
                </button>
              );
            })}
          </div>
        </aside>
        <section className="models-workspace-main" aria-label={t("models.workspace.mainAria")}>
          {searchBlock}
          {settingsSearchBlock}
          {controlsBlock}
          {combosBlock}
          {collapseControls}
          {
            // eslint-disable-next-line react-hooks/refs -- The hover ref is only read by row event handlers nested in this renderer.
            visibleGroups.map(group => renderGroup(group))
          }
          {groups.length === 0 && emptyStateBlock}
          {groups.length > 0 && visibleGroups.length === 0 && noMatchBlock}
        </section>
      </div>
      {modalsBlock}
    </div>
  );

}
