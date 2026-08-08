/**
 * Settings — every adjustable value in the app on one surface.
 *
 * The settings this dashboard owns are scattered across Dashboard, Startup,
 * Storage, Claude, Grok and Appearance because each grew where its screen was.
 * This page gathers them under the six headings the settings copy defines and
 * makes the simple ones editable in place. A setting whose real editor is a
 * richer screen (a model picker, a colour engine, a cleanup preview) shows its
 * current value and a `settings.jumpTo` link instead of a worse copy of that
 * control — a half-built duplicate of a destructive control is worse than none.
 *
 * Three rules the whole page follows:
 *
 * 1. Every write is optimistic, then reconciled against the server's echo. The
 *    echo — never the value the UI asked for — decides whether anything moved.
 * 2. A value that did not move records nothing and claims nothing. The Version
 *    history is a list of real events, so a refused or no-op write must not
 *    appear in it, and "Setting saved" must not be shown for a save that the
 *    server declined. A control that visibly springs back still says why.
 * 3. Plain-text search by default, `.*` an explicit opt-in, patterns capped at
 *    400 characters and evaluated locally — the same matcher every other search
 *    bar in the GUI uses.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { elsewhereFor } from "./settings-elsewhere";
import { IconRefresh, IconSearch } from "../icons";
import { LOCALES, useI18n, type TKey } from "../i18n/shared";
import { Button, Card, Chip, Empty, Segmented, TextInput, Toggle } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { useNotifications } from "../shell/notifications-context";
import { readRevisions, recordRevision } from "../shell/revisions";
import { usePrefs } from "../theme/prefs-context";
import { FONT_CHOICES } from "../theme/m3";
import { formatBytes } from "../format-bytes";
import { EFFORT_CAP_LEVELS } from "./dashboard-shared";
import { makeMatcher } from "./models-shared";
import {
  EMPTY_SNAPSHOT,
  SETTINGS_GROUPS,
  loadSettingsSnapshot,
  putSetting,
  readDebug,
  readEffortCaps,
  readInjection,
  readMode,
  readPolicy,
  readShadowCall,
  snapshotHasData,
  type CleanupSchedule,
  type JumpTarget,
  type MultiAgentMode,
  type SettingsGroupId,
  type SettingsSnapshot,
} from "./settings-shared";

/** Placeholder for a value the server reports as unset. Punctuation, not prose. */
const UNSET = "—";

/** Row-id prefix for the four capture switches, kept out of a template literal. */
const DEBUG_ROW = "debug-";

const DEBUG_FLAGS = ["debug", "usage", "injection", "claude"] as const;

/**
 * Settings this page deliberately does not aggregate, because their editors are
 * whole workspaces (a provider table, a model catalogue, an account pool). The
 * search reports a hit on one of these by name and says which tab owns it, so a
 * miss here never reads as "that setting does not exist".
 */
// One shared registry, so every settings search reports the same neighbours.
const ELSEWHERE = elsewhereFor("nav.settings");

const LEAD_ROW: CSSProperties = { marginBottom: "var(--sp-3)", alignItems: "flex-start" };
const LEAD: CSSProperties = { margin: 0 };

/**
 * The history promise, rendered where the user can see it before they change
 * anything — a guarantee nobody is told about is not a guarantee.
 */
const HISTORY_NOTE: CSSProperties = {
  margin: "0 0 var(--sp-3)",
  padding: "10px 12px",
  borderRadius: "var(--r-s)",
  background: "var(--m3-tertiary-container)",
  color: "var(--m3-on-tertiary-container)",
  fontSize: "var(--t-body-s)",
  maxWidth: "74ch",
};

const SEARCH_ROW: CSSProperties = { marginBottom: 0 };
const SEARCH_INPUT: CSSProperties = { flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 460 };
const MONO: CSSProperties = { fontFamily: "var(--mono)" };
const STATUS: CSSProperties = {
  minHeight: 20,
  margin: "4px 0 var(--sp-3)",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-m)",
};
const ERROR_TEXT: CSSProperties = { margin: 0, color: "var(--m3-error)", fontSize: "var(--t-body-m)" };
const PARTIAL_ERROR: CSSProperties = { ...ERROR_TEXT, marginBottom: "var(--sp-3)" };

const CARD_GAP: CSSProperties = { marginBottom: "var(--sp-3)" };
/** Rows stack rather than sit in a grid, so a long bilingual label never clips a control. */
const ROW: CSSProperties = {
  gap: "var(--sp-3)",
  padding: "var(--sp-2) 0",
  alignItems: "flex-start",
  borderTop: "1px solid var(--m3-outline-variant)",
};
const ROW_FIRST: CSSProperties = { ...ROW, borderTop: "none" };
const ROW_TEXT: CSSProperties = { flex: "1 1 260px", minWidth: 0 };
const ROW_LABEL: CSSProperties = { fontSize: "var(--t-body-m)", fontWeight: 500 };
const ROW_DESC: CSSProperties = { margin: "2px 0 0", maxWidth: "68ch" };
const ROW_CONTROL: CSSProperties = { flex: "0 1 auto", justifyContent: "flex-end", gap: "var(--sp-2)" };
const ROW_VALUE: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-l)",
  color: "var(--m3-on-surface-variant)",
  overflowWrap: "anywhere",
};
const SELECT: CSSProperties = { width: "auto", minWidth: 160 };

/** One row of the settings index: what it is, what it reads now, how to change it. */
interface SettingRow {
  id: string;
  group: SettingsGroupId;
  label: string;
  desc?: string;
  /** Current value, in the same words the control shows. Indexed by the search. */
  value: string;
  /** Editable in place. When absent the row shows its value and (usually) a jump link. */
  control?: ReactNode;
  /** The screen that owns this setting's full editor. */
  jump?: JumpTarget;
}

/** One recorded change: the setting's name, the value it moved to, what it replaced. */
interface SettingChange {
  setting: string;
  value: string;
  before: string;
}

function SelectControl({ label, value, options, disabled, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <select
      className="m3-input"
      style={SELECT}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={e => onChange(e.target.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export default function SettingsPage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();
  const { prefs } = usePrefs();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Id of the control being written, or null. One write at a time keeps server order. */
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [revisionCount, setRevisionCount] = useState(0);
  const loadGenerationRef = useRef(0);

  // `recordRevision` fires this event, so the history count stays honest whether the
  // change was made here or on another screen.
  useEffect(() => {
    const refresh = () => setRevisionCount(readRevisions().length);
    refresh();
    window.addEventListener("ocx-revisions", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("ocx-revisions", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const { snapshot: next, error } = await loadSettingsSnapshot(apiBase, signal);
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setSnapshot(next);
      setLoadError(error);
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase]);

  // Deferred a tick so the fetch does not cascade renders out of the effect body.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      // Invalidate before aborting, so a superseded request's finally cannot clear
      // loading in the gap before its replacement bumps the generation.
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [load]);

  const onOff = useCallback(
    (on: boolean) => t(on ? "startup.enabled" : "startup.disabled"),
    [t],
  );

  const scheduleLabel = useCallback((schedule: CleanupSchedule): string => {
    switch (schedule) {
      case "startup": return t("storage.policy.schedule.startup");
      case "daily": return t("storage.policy.schedule.daily");
      case "weekly": return t("storage.policy.schedule.weekly");
      default: return t("storage.policy.schedule.manual");
    }
  }, [t]);

  /**
   * One settings write, start to finish.
   *
   * `optimistic` paints immediately, `request` returns the snapshot the *server*
   * reports plus the values that genuinely moved. Nothing is recorded and nothing
   * is claimed when that list is empty.
   */
  const runSave = async (
    id: string,
    optimistic: SettingsSnapshot,
    request: () => Promise<{ next: SettingsSnapshot; changes: SettingChange[] }>,
  ) => {
    if (busy !== null) return;
    const before = snapshot;
    setBusy(id);
    setSnapshot(optimistic);
    try {
      const { next, changes } = await request();
      setSnapshot(next);
      if (changes.length === 0) {
        // The server echoed the value it already had: refused, or a no-op. Recording
        // it would put a change that never happened into the history. The control
        // has just sprung back to the server's value, so say why rather than
        // leaving the user to wonder whether the click registered.
        if (JSON.stringify(next) !== JSON.stringify(optimistic)) {
          notify({ tone: "warn", title: t("settings.saveFailed") });
        }
        return;
      }
      for (const change of changes) {
        recordRevision({
          scope: "settings",
          label: t("settings.title"),
          summary: change.value
            ? t("dash.revision.changed", { setting: change.setting, value: change.value })
            : t("dash.revision.cleared", { setting: change.setting }),
          before: change.before,
        });
      }
      notify({ tone: "success", title: t("settings.savedTitle"), body: t("settings.savedBody") });
    } catch {
      setSnapshot(before);
      notify({ tone: "error", title: t("settings.saveFailed") });
    } finally {
      setBusy(null);
    }
  };

  const { proxy, injection, effortCaps, maMode, shadowCall, sidecar, policy, debug } = snapshot;
  const saving = busy !== null;

  /* ------------------------------------------------------------- handlers -- */

  const saveCodexAutoStart = (nextValue: boolean) => {
    if (!proxy) return;
    void runSave("codexAutoStart", { ...snapshot, proxy: { ...proxy, codexAutoStart: nextValue } }, async () => {
      const data = await putSetting<{ codexAutoStart?: unknown }>(apiBase, "/api/settings", { codexAutoStart: nextValue });
      const echoed = data.codexAutoStart === true;
      return {
        next: { ...snapshot, proxy: { ...proxy, codexAutoStart: echoed } },
        changes: echoed === proxy.codexAutoStart ? [] : [{
          setting: t("dash.codexAutoStart"),
          value: onOff(echoed),
          before: JSON.stringify({ codexAutoStart: proxy.codexAutoStart }),
        }],
      };
    });
  };

  const saveShadowCall = (nextValue: boolean) => {
    if (!shadowCall) return;
    void runSave("shadowCall", { ...snapshot, shadowCall: { ...shadowCall, enabled: nextValue } }, async () => {
      const data = await putSetting<{ enabled?: unknown; model?: unknown }>(
        apiBase,
        "/api/shadow-call-settings",
        { enabled: nextValue },
      );
      const echoed = readShadowCall(data);
      return {
        next: { ...snapshot, shadowCall: echoed },
        changes: echoed.enabled === shadowCall.enabled ? [] : [{
          setting: t("dash.shadowCallIntercept"),
          value: onOff(echoed.enabled),
          before: JSON.stringify(shadowCall),
        }],
      };
    });
  };

  const saveMode = (nextValue: MultiAgentMode) => {
    if (maMode === null || maMode === nextValue) return;
    void runSave("maMode", { ...snapshot, maMode: nextValue }, async () => {
      const data = await putSetting<{ multiAgentMode?: unknown }>(apiBase, "/api/v2", { multiAgentMode: nextValue });
      const echoed = readMode(data);
      return {
        next: { ...snapshot, maMode: echoed },
        changes: echoed === maMode ? [] : [{
          setting: t("dash.multiAgent"),
          value: t(`models.v2Mode_${echoed}` as TKey),
          before: JSON.stringify({ multiAgentMode: maMode }),
        }],
      };
    });
  };

  const saveInjectionFlag = (
    id: "multiAgentGuidanceEnabled" | "syncCodexSubagentDefaults",
    nextValue: boolean,
  ) => {
    if (!injection) return;
    void runSave(id, { ...snapshot, injection: { ...injection, [id]: nextValue } }, async () => {
      const data = await putSetting<{
        multiAgentGuidanceEnabled?: unknown;
        syncCodexSubagentDefaults?: unknown;
        model?: unknown;
        effort?: unknown;
      }>(apiBase, "/api/injection-model", { [id]: nextValue });
      const echoed = readInjection(data);
      const before = JSON.stringify(injection);
      const changes: SettingChange[] = [];
      // The endpoint echoes all four fields and can clear the model-dependent ones
      // as a side effect, so each is compared rather than assuming only `id` moved.
      if (echoed.multiAgentGuidanceEnabled !== injection.multiAgentGuidanceEnabled) {
        changes.push({ setting: t("dash.multiAgentGuidance"), value: onOff(echoed.multiAgentGuidanceEnabled), before });
      }
      if (echoed.syncCodexSubagentDefaults !== injection.syncCodexSubagentDefaults) {
        changes.push({
          setting: t("dash.syncCodexSubagentDefaults"),
          value: onOff(echoed.syncCodexSubagentDefaults),
          before,
        });
      }
      if (echoed.model !== injection.model) {
        changes.push({ setting: t("dash.injectionLabel"), value: echoed.model, before });
      }
      if (echoed.effort !== injection.effort) {
        changes.push({ setting: t("dash.injectionEffortLabel"), value: echoed.effort, before });
      }
      return { next: { ...snapshot, injection: echoed }, changes };
    });
  };

  const saveEffortCap = (field: "effortCap" | "subagentEffortCap", nextValue: string) => {
    if (!effortCaps) return;
    void runSave(field, { ...snapshot, effortCaps: { ...effortCaps, [field]: nextValue } }, async () => {
      const data = await putSetting<{ effortCap?: unknown; subagentEffortCap?: unknown }>(
        apiBase,
        "/api/effort-caps",
        { [field]: nextValue || null },
      );
      const echoed = readEffortCaps(data);
      const before = JSON.stringify(effortCaps);
      const changes: SettingChange[] = [];
      if (echoed.effortCap !== effortCaps.effortCap) {
        changes.push({ setting: t("dash.effortCapLabel"), value: echoed.effortCap, before });
      }
      if (echoed.subagentEffortCap !== effortCaps.subagentEffortCap) {
        changes.push({ setting: t("dash.subagentEffortCapLabel"), value: echoed.subagentEffortCap, before });
      }
      return { next: { ...snapshot, effortCaps: echoed }, changes };
    });
  };

  const savePolicy = (id: string, patch: { enabled?: boolean; schedule?: CleanupSchedule }) => {
    if (!policy) return;
    void runSave(id, { ...snapshot, policy: { ...policy, ...patch } }, async () => {
      const data = await putSetting<{
        policy?: {
          enabled?: unknown;
          schedule?: unknown;
          mode?: unknown;
          trigger?: { archivedBytesOver?: unknown };
          target?: { removeOldestPercent?: unknown; reduceToBytes?: unknown };
        };
      }>(apiBase, "/api/storage/cleanup-policy", patch);
      if (!data.policy) throw new Error("/api/storage/cleanup-policy");
      const echoed = readPolicy(data.policy);
      const before = JSON.stringify(policy);
      const changes: SettingChange[] = [];
      if (echoed.enabled !== policy.enabled) {
        changes.push({ setting: t("storage.policy.enabled"), value: onOff(echoed.enabled), before });
      }
      if (echoed.schedule !== policy.schedule) {
        changes.push({ setting: t("storage.policy.schedule"), value: scheduleLabel(echoed.schedule), before });
      }
      return { next: { ...snapshot, policy: echoed }, changes };
    });
  };

  const saveDebugFlag = (flag: (typeof DEBUG_FLAGS)[number], nextValue: boolean) => {
    if (!debug) return;
    void runSave(DEBUG_ROW + flag, { ...snapshot, debug: { ...debug, [flag]: nextValue } }, async () => {
      const data = await putSetting<{
        enabled?: unknown; usage?: unknown; injection?: unknown; claude?: unknown;
      }>(apiBase, "/api/debug", { [flag]: nextValue });
      const echoed = readDebug(data);
      const before = JSON.stringify(debug);
      const changes: SettingChange[] = [];
      // The endpoint returns the whole settings object, so every stream is compared:
      // an env-driven flag that flips alongside the one clicked is a real change too.
      for (const key of DEBUG_FLAGS) {
        if (echoed[key] !== debug[key]) {
          changes.push({ setting: t(`debug.${key}` as TKey), value: onOff(echoed[key]), before });
        }
      }
      return { next: { ...snapshot, debug: echoed }, changes };
    });
  };

  /* ---------------------------------------------------------------- rows -- */

  const themeLabel = t(prefs.theme === "light" ? "theme.light" : prefs.theme === "dark" ? "theme.dark" : "theme.system");
  const fontLabel = (FONT_CHOICES.find(f => f.id === prefs.fontId) ?? FONT_CHOICES[0]).label;

  const rows: SettingRow[] = [];

  if (proxy) {
    rows.push({
      id: "codexAutoStart",
      group: "proxy",
      label: t("dash.codexAutoStart"),
      desc: t("dash.codexAutoStartHint"),
      value: onOff(proxy.codexAutoStart),
      control: (
        <Toggle
          on={proxy.codexAutoStart}
          disabled={saving}
          label={t("dash.codexAutoStart")}
          onChange={saveCodexAutoStart}
        />
      ),
    });
    rows.push({
      id: "endpoint",
      group: "proxy",
      label: t("network.hostTitle"),
      desc: t("network.hostSub"),
      value: proxy.port === null ? proxy.hostname || UNSET : `${proxy.hostname}:${proxy.port}`,
      jump: { page: "network", tkey: "nav.network" },
    });
  }

  if (shadowCall) {
    rows.push({
      id: "shadowCall",
      group: "routing",
      label: t("dash.shadowCallIntercept"),
      desc: t("dash.shadowCallInterceptHint"),
      value: onOff(shadowCall.enabled),
      control: (
        <Toggle
          on={shadowCall.enabled}
          disabled={saving}
          label={t("dash.shadowCallIntercept")}
          onChange={saveShadowCall}
        />
      ),
    });
    rows.push({
      id: "shadowCallModel",
      group: "routing",
      label: t("dash.shadowCallModel"),
      desc: t("dash.shadowCallTooltip"),
      value: shadowCall.model || UNSET,
      jump: { page: "dashboard", tkey: "nav.dashboard" },
    });
  }

  if (sidecar) {
    rows.push({
      id: "webSearchSidecar",
      group: "routing",
      label: t("dash.webSearchSidecar"),
      desc: t("dash.webSearchSidecarHint"),
      value: sidecar.webSearch || UNSET,
      jump: { page: "dashboard", tkey: "nav.dashboard" },
    });
    rows.push({
      id: "visionSidecar",
      group: "routing",
      label: t("dash.visionSidecar"),
      desc: t("dash.visionSidecarHint"),
      value: sidecar.vision || UNSET,
      jump: { page: "dashboard", tkey: "nav.dashboard" },
    });
  }

  if (maMode !== null) {
    rows.push({
      id: "maMode",
      group: "agents",
      label: t("dash.multiAgent"),
      desc: t(`models.v2ModeDesc_${maMode}` as TKey),
      value: t(`models.v2Mode_${maMode}` as TKey),
      control: (
        <Segmented<MultiAgentMode>
          value={maMode}
          label={t("dash.multiAgent")}
          onChange={saveMode}
          options={[
            { value: "v1", label: t("models.v2Mode_v1") },
            { value: "default", label: t("models.v2Mode_default") },
            { value: "v2", label: t("models.v2Mode_v2") },
          ]}
        />
      ),
    });
  }

  if (injection) {
    rows.push({
      id: "multiAgentGuidanceEnabled",
      group: "agents",
      label: t("dash.multiAgentGuidance"),
      desc: t("dash.multiAgentGuidanceHint"),
      value: onOff(injection.multiAgentGuidanceEnabled),
      control: (
        <Toggle
          on={injection.multiAgentGuidanceEnabled}
          disabled={saving}
          label={t("dash.multiAgentGuidance")}
          onChange={next => saveInjectionFlag("multiAgentGuidanceEnabled", next)}
        />
      ),
    });
    rows.push({
      id: "injectionModel",
      group: "agents",
      label: t("dash.injectionLabel"),
      desc: t("dash.injectionHint"),
      value: injection.model || t("dash.injectionNone"),
      jump: { page: "dashboard", tkey: "nav.dashboard" },
    });
    rows.push({
      id: "injectionEffort",
      group: "agents",
      label: t("dash.injectionEffortLabel"),
      value: injection.effort || t("dash.injectionEffortNone"),
      jump: { page: "dashboard", tkey: "nav.dashboard" },
    });
    rows.push({
      id: "syncCodexSubagentDefaults",
      group: "agents",
      label: t("dash.syncCodexSubagentDefaults"),
      desc: t("dash.syncCodexSubagentDefaultsHint"),
      value: onOff(injection.syncCodexSubagentDefaults),
      control: (
        <Toggle
          on={injection.syncCodexSubagentDefaults}
          // The server refuses this flag without an injection model, so the control
          // is only offered once there is one to attach it to.
          disabled={saving || !injection.model}
          label={t("dash.syncCodexSubagentDefaults")}
          onChange={next => saveInjectionFlag("syncCodexSubagentDefaults", next)}
        />
      ),
    });
  }

  if (effortCaps) {
    const capOptions = [
      { value: "", label: t("dash.effortCapNone") },
      ...EFFORT_CAP_LEVELS.map(level => ({ value: level, label: level })),
    ];
    rows.push({
      id: "effortCap",
      group: "agents",
      label: t("dash.effortCapLabel"),
      desc: t("dash.effortCapHelp"),
      value: effortCaps.effortCap || t("dash.effortCapNone"),
      control: (
        <SelectControl
          label={t("dash.effortCapLabel")}
          value={effortCaps.effortCap}
          options={capOptions}
          disabled={saving}
          onChange={next => saveEffortCap("effortCap", next)}
        />
      ),
    });
    rows.push({
      id: "subagentEffortCap",
      group: "agents",
      // The help above covers both ceilings by name, so it is not repeated here.
      label: t("dash.subagentEffortCapLabel"),
      value: effortCaps.subagentEffortCap || t("dash.effortCapNone"),
      control: (
        <SelectControl
          label={t("dash.subagentEffortCapLabel")}
          value={effortCaps.subagentEffortCap}
          options={capOptions}
          disabled={saving}
          onChange={next => saveEffortCap("subagentEffortCap", next)}
        />
      ),
    });
  }

  if (policy) {
    rows.push({
      id: "policyEnabled",
      group: "storage",
      label: t("storage.policy.enabled"),
      desc: t("storage.policy.enabledHint"),
      value: onOff(policy.enabled),
      control: (
        <Toggle
          on={policy.enabled}
          disabled={saving}
          label={t("storage.policy.enabled")}
          onChange={next => savePolicy("policyEnabled", { enabled: next })}
        />
      ),
    });
    rows.push({
      id: "policySchedule",
      group: "storage",
      label: t("storage.policy.schedule"),
      desc: t("storage.policy.help"),
      value: scheduleLabel(policy.schedule),
      control: (
        <SelectControl
          label={t("storage.policy.schedule")}
          value={policy.schedule}
          disabled={saving}
          options={[
            { value: "manual", label: t("storage.policy.schedule.manual") },
            { value: "startup", label: t("storage.policy.schedule.startup") },
            { value: "daily", label: t("storage.policy.schedule.daily") },
            { value: "weekly", label: t("storage.policy.schedule.weekly") },
          ]}
          onChange={next => savePolicy("policySchedule", { schedule: next as CleanupSchedule })}
        />
      ),
    });
    rows.push({
      id: "policyMode",
      group: "storage",
      label: t("storage.policy.mode"),
      // Deliberately not editable here: permanent mode cannot be undone, and the
      // warning that decision needs belongs beside the preview on the Storage screen.
      desc: t("storage.policy.permanentWarn"),
      value: t(policy.mode === "permanent" ? "storage.policy.mode.permanent" : "storage.policy.mode.quarantine"),
      jump: { page: "storage", tkey: "nav.storage" },
    });
    rows.push({
      id: "policyThreshold",
      group: "storage",
      label: t("storage.policy.threshold"),
      value: formatBytes(policy.archivedBytesOver, locale),
      jump: { page: "storage", tkey: "nav.storage" },
    });
    rows.push({
      id: "policyTarget",
      group: "storage",
      label: t("storage.policy.target"),
      desc: policy.removeOldestPercent === null ? t("storage.policy.targetReduce") : t("storage.policy.targetPercent"),
      value: policy.removeOldestPercent === null
        ? formatBytes(policy.reduceToBytes ?? 0, locale)
        : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })
          .format(policy.removeOldestPercent / 100),
      jump: { page: "storage", tkey: "nav.storage" },
    });
  }

  rows.push(
    {
      id: "theme",
      group: "appearance",
      label: t("appearance.themeTitle"),
      desc: t("appearance.themeSub"),
      value: themeLabel,
      jump: { page: "appearance", tkey: "nav.appearance" },
    },
    {
      id: "density",
      group: "appearance",
      label: t("appearance.densityTitle"),
      desc: t("appearance.densitySub"),
      value: String(prefs.density),
      jump: { page: "appearance", tkey: "nav.appearance" },
    },
    {
      id: "font",
      group: "appearance",
      label: t("appearance.font"),
      desc: t("appearance.typeSub"),
      value: fontLabel,
      jump: { page: "appearance", tkey: "nav.appearance" },
    },
    {
      id: "language",
      group: "appearance",
      label: t("lang.mode"),
      desc: t("lang.sub"),
      value: LOCALES.find(entry => entry.code === locale)?.name ?? locale,
      jump: { page: "language", tkey: "nav.language" },
    },
    {
      id: "narrator",
      group: "appearance",
      label: t("narrator.title"),
      desc: t("narrator.sub"),
      value: onOff(prefs.narrator),
      jump: { page: "language", tkey: "nav.language" },
    },
    {
      id: "dimsum",
      group: "appearance",
      label: t("dimsum.toggle"),
      desc: t("dimsum.toggleHint"),
      value: onOff(prefs.dimsum),
      jump: { page: "language", tkey: "nav.language" },
    },
  );

  if (debug) {
    for (const flag of DEBUG_FLAGS) {
      rows.push({
        id: DEBUG_ROW + flag,
        group: "privacy",
        label: t(`debug.${flag}` as TKey),
        desc: t("debug.captureSub"),
        value: onOff(debug[flag]),
        control: (
          <Toggle
            on={debug[flag]}
            disabled={saving}
            label={t(`debug.${flag}` as TKey)}
            onChange={next => saveDebugFlag(flag, next)}
          />
        ),
      });
    }
  }

  rows.push({
    id: "history",
    group: "privacy",
    label: t("history.title"),
    desc: t("history.sub"),
    value: revisionCount.toLocaleString(locale),
    jump: { page: "history", tkey: "nav.history" },
  });

  /* -------------------------------------------------------------- search -- */

  const matcher = useMemo(() => makeMatcher(query, useRegex), [query, useRegex]);
  const visible = rows.filter(row => matcher.test(`${row.label} ${row.desc ?? ""} ${row.value}`));
  const groups = SETTINGS_GROUPS
    .map(group => ({ ...group, rows: visible.filter(row => row.group === group.id) }))
    .filter(group => group.rows.length > 0);
  // Hits on settings this page does not carry at all. Claimed only once something
  // was typed — an untouched field has not matched anything, here or elsewhere.
  const elsewhere = query
    ? ELSEWHERE.filter(entry => matcher.test(`${t(entry.tkey)} ${entry.descKey ? t(entry.descKey) : ""}`))
    : [];
  const elsewhereTabs = [...new Set(elsewhere.map(entry => t(entry.tabKey)))].join(", ");

  const status = matcher.error
    ? `${t("regex.invalid")}: ${matcher.error}`
    : elsewhere.length > 0
      ? t("settings.otherTab", { count: elsewhere.length, tabs: elsewhereTabs })
      : query && visible.length === 0
        ? t("settings.noMatch")
        : "";

  const hasData = snapshotHasData(snapshot);

  return (
    <>
      {/* No in-page <h1>: the app bar already renders the screen title. */}
      <div className="m3-row m3-row--split" style={LEAD_ROW}>
        <p className="m3-page-lead" style={LEAD}>{t("settings.sub")}</p>
        <Button variant="text" disabled={loading} onClick={() => void load()}>
          <IconRefresh aria-hidden="true" /> {t("startup.refresh")}
        </Button>
      </div>

      <p style={HISTORY_NOTE}>{t("settings.historyNote")}</p>

      <div className="m3-row" role="search" style={SEARCH_ROW}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={!!matcher.error}
          style={SEARCH_INPUT}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(value => !value)} title={t("regex.regexMode")}>
          <code style={MONO}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          onApply={pattern => setQuery(pattern)}
          regex={useRegex}
          onRegexChange={setUseRegex}
          // Every indexed setting, label, description and current value alike, so a
          // pattern is tried against the same text this page searches.
          sample={rows.map(row => `${row.label} ${row.desc ?? ""} ${row.value}`).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <p role="status" style={STATUS}>{status}</p>

      {loading && !hasData ? (
        <Empty title={t("common.loading")} />
      ) : !hasData && loadError ? (
        <Card>
          {/* The proxy's own words, not an invented sentence about what went wrong. */}
          <p role="alert" style={ERROR_TEXT}>{loadError}</p>
          <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="tonal" onClick={() => void load()}>{t("common.retry")}</Button>
          </div>
        </Card>
      ) : (
        <>
          {/* Partial failure: the other endpoints answered, so the page is usable —
              but the group whose read failed is simply missing, and a silently
              absent setting reads as a setting that does not exist. */}
          {loadError && <p role="alert" style={PARTIAL_ERROR}>{loadError}</p>}
          {groups.map(group => (
            <Card key={group.id} title={t(group.tkey)} style={CARD_GAP}>
              {group.rows.map((row, index) => (
                <div key={row.id} className="m3-row" style={index === 0 ? ROW_FIRST : ROW}>
                  <div style={ROW_TEXT}>
                    <div style={ROW_LABEL}>{row.label}</div>
                    {row.desc && <p className="m3-card-sub" style={ROW_DESC}>{row.desc}</p>}
                  </div>
                  <div className="m3-row" style={ROW_CONTROL}>
                    {row.control ?? <span style={ROW_VALUE}>{row.value}</span>}
                    {row.jump && (
                      <a className="m3-btn m3-btn--text" href={`#${row.jump.page}`}>
                        {t("settings.jumpTo", { page: t(row.jump.tkey) })}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          ))}
        </>
      )}
    </>
  );
}
