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
import { useSettingsDrafts } from "../settings-drafts-context";
import { elsewhereFor } from "./settings-elsewhere";
import { IconRefresh, IconSearch } from "../icons";
import { LOCALES, useI18n, type TKey } from "../i18n/shared";
import { Button, Card, Chip, Empty, Segmented, TextInput, Toggle } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { readRevisions } from "../shell/revisions";
import { usePrefs } from "../theme/prefs-context";
import { FONT_CHOICES } from "../theme/m3";
import { formatBytes } from "../format-bytes";
import { EFFORT_CAP_LEVELS } from "./dashboard-shared";
import { makeMatcher } from "./models-shared";
import {
  EMPTY_SNAPSHOT,
  SETTINGS_GROUPS,
  loadSettingsSnapshot,
  snapshotHasData,
  type CleanupSchedule,
  type JumpTarget,
  type MultiAgentMode,
  type SettingsGroupId,
} from "./settings-shared";

/** Placeholder for a value the server reports as unset. Punctuation, not prose. */
const UNSET = "—";

/** Row-id prefix for the four capture switches, kept out of a template literal. */
const DEBUG_ROW = "debug-";

const DEBUG_FLAGS = ["debug", "usage", "injection", "claude"] as const;

/**
 * Every setting the app has, each tagged with the screen that owns its real
 * editor, so a hit this page cannot show is still named and located.
 *
 * This page aggregates a lot but not everything: some editors are whole
 * workspaces (a provider table, a model catalogue, an account pool), and even
 * the values it does mirror are fully editable only on their own screen. Reading
 * the shared registry rather than a list kept here means a setting added
 * anywhere becomes findable from this search bar without anyone remembering to
 * come and add it — which is what the eight hand-written rows this replaced
 * could never promise.
 *
 * Read at module scope, which is safe because the registry is contributed
 * statically: it describes screens that are not open, so it is complete before
 * the first render rather than filling in as pages mount.
 */
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
  const { prefs } = usePrefs();
  const { settings, setSettingsBaseline, setSettings, applying } = useSettingsDrafts();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      setSettingsBaseline(next);
      setLoadError(error);
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase, setSettingsBaseline]);

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

  // Server-backed rows edit the coordinator's snapshot only. The endpoint PUTs
  // and revision writes are centralized in SettingsDraftProvider.apply(), so an
  // edit can preview across tabs without becoming durable by accident.
  const snapshot = settings ?? EMPTY_SNAPSHOT;
  const saving = applying;
  const { proxy, injection, effortCaps, maMode, shadowCall, sidecar, policy, debug } = snapshot;

  const saveCodexAutoStart = (nextValue: boolean) => {
    setSettings(previous => previous.proxy
      ? { ...previous, proxy: { ...previous.proxy, codexAutoStart: nextValue } }
      : previous);
  };

  const saveShadowCall = (nextValue: boolean) => {
    setSettings(previous => previous.shadowCall
      ? { ...previous, shadowCall: { ...previous.shadowCall, enabled: nextValue } }
      : previous);
  };

  const saveMode = (nextValue: MultiAgentMode) => {
    setSettings(previous => previous.maMode === null ? previous : { ...previous, maMode: nextValue });
  };

  const saveInjectionFlag = (id: "multiAgentGuidanceEnabled" | "syncCodexSubagentDefaults", nextValue: boolean) => {
    setSettings(previous => previous.injection
      ? { ...previous, injection: { ...previous.injection, [id]: nextValue } }
      : previous);
  };

  const saveEffortCap = (field: "effortCap" | "subagentEffortCap", nextValue: string) => {
    setSettings(previous => previous.effortCaps
      ? { ...previous, effortCaps: { ...previous.effortCaps, [field]: nextValue } }
      : previous);
  };

  const savePolicy = (patch: { enabled?: boolean; schedule?: CleanupSchedule }) => {
    setSettings(previous => previous.policy
      ? { ...previous, policy: { ...previous.policy, ...patch } }
      : previous);
  };

  const saveDebugFlag = (flag: (typeof DEBUG_FLAGS)[number], nextValue: boolean) => {
    setSettings(previous => previous.debug
      ? { ...previous, debug: { ...previous.debug, [flag]: nextValue } }
      : previous);
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
          onChange={next => savePolicy({ enabled: next })}
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
          onChange={next => savePolicy({ schedule: next as CleanupSchedule })}
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
      // Not `onOff(...)`: there is no switch behind this row any more. It stays
      // searchable because somebody who has just been surprised by a dumpling
      // will come here looking for it, and a row that reports "Always on" tells
      // them the truth faster than an empty result would.
      value: t("dimsum.always"),
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
