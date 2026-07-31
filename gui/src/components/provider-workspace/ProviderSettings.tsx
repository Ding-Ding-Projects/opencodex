/**
 * ProviderSettings — adapter/baseUrl/defaultModel/authMode/note editing form
 * for the workspace Settings tab (WP091). Uses PATCH /api/providers via an
 * onUpdateProvider prop. May fetch `/api/provider-presets` once per provider
 * to discover `baseUrlChoices` (e.g. Qwen Cloud endpoint picker).
 *
 * Parent should remount on provider change (`key={item.name}`) so choice-loading
 * state resets cleanly without sync setState-in-effect.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../../base-url-choice";
import { readJsonIfOk } from "../../fetch-json";
import { useT } from "../../i18n/shared";
import { IconLock, IconSearch } from "../../icons";
import { Chip, TextInput } from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";
import { makeMatcher } from "../../pages/models-shared";
import { isCatalogProviderId } from "../../provider-icons";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import { authModeLabel } from "./ProviderRail";
import type { WorkspaceItem, ProviderUpdatePatch } from "./types";

const ADAPTERS = ["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"] as const;
const EMPTY_MODELS: string[] = [];
const NO_OTHER_TAB_SETTINGS: OtherTabSetting[] = [];

const SEARCH_ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
const SEARCH_INPUT: CSSProperties = { flex: "1 1 200px", width: "auto", minWidth: 0 };
const SEARCH_NOTE: CSSProperties = { color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" };
const SEARCH_ERROR: CSSProperties = { color: "var(--m3-error)", fontSize: "var(--t-label-m)" };

/** Every control this form owns, addressable by the settings search. */
type SettingId =
  | "providerId" | "adapter" | "endpoint" | "baseUrl" | "defaultModel"
  | "authMode" | "apiKeyTransport" | "note" | "allowPrivateNetwork" | "liveModels";

/**
 * A settings control that lives on a DIFFERENT tab of this provider's detail view.
 * A hit here is reported by name rather than silently dropped, so a user who types a
 * setting's name learns where it actually is instead of seeing "no match".
 */
export interface OtherTabSetting {
  /** The tab's visible label, as the tablist spells it. */
  tab: string;
  /** Everything that tab's controls are findable by: labels, descriptions, values. */
  text: string;
}

type ChoicesStatus = "idle" | "loading" | "ready" | "error";

export default function ProviderSettings({
  item, availableModels = EMPTY_MODELS, apiBase, onUpdateProvider, onDirtyChange, onRegisterSave,
  otherTabSettings = NO_OTHER_TAB_SETTINGS,
}: {
  item: WorkspaceItem;
  availableModels?: string[];
  /** When set, load endpoint choices for catalog providers that expose baseUrlChoices. */
  apiBase?: string;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Lets parent dialogs trigger the same save path as the sticky bar. */
  onRegisterSave?: (save: (() => Promise<boolean>) | null) => void;
  /** Settings on the sibling detail tabs, so a cross-tab hit can be named. */
  otherTabSettings?: OtherTabSetting[];
}) {
  const t = useT();
  const initialAuth = String(item.authMode ?? (item.keyOptional ? "local" : "key"));
  const [adapter, setAdapter] = useState(item.adapter);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [defaultModel, setDefaultModel] = useState(item.defaultModel ?? "");
  const [authMode, setAuthMode] = useState(initialAuth);
  const [apiKeyTransport, setApiKeyTransport] = useState(item.apiKeyTransport ?? "x-api-key");
  const [note, setNote] = useState(item.note ?? "");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(item.allowPrivateNetwork ?? false);
  const [liveModels, setLiveModels] = useState(item.liveModels !== false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [baseUrlChoices, setBaseUrlChoices] = useState<CatalogPreset["baseUrlChoices"]>();
  const [choicesStatus, setChoicesStatus] = useState<ChoicesStatus>(apiBase ? "loading" : "idle");
  const [endpointChoice, setEndpointChoice] = useState(() => "custom");
  const [settingsQuery, setSettingsQuery] = useState("");
  /** Plain text by default; `.*` is an explicit opt-in, exactly as on the rail search. */
  const [settingsRegex, setSettingsRegex] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- intentional form reset when saved provider fields change */
  useEffect(() => {
    setAdapter(item.adapter);
    setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? "");
    setAuthMode(String(item.authMode ?? (item.keyOptional ? "local" : "key")));
    setApiKeyTransport(item.apiKeyTransport ?? "x-api-key");
    setNote(item.note ?? "");
    setAllowPrivateNetwork(item.allowPrivateNetwork ?? false);
    setLiveModels(item.liveModels !== false);
    setMsg(null);
    queueMicrotask(() => setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl)));
  }, [item.adapter, item.baseUrl, item.defaultModel, item.authMode, item.apiKeyTransport, item.keyOptional, item.note, item.allowPrivateNetwork, item.liveModels, baseUrlChoices]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    const providerId = item.name;
    const savedBaseUrl = item.baseUrl;
    fetch(`${apiBase}/api/provider-presets`)
      .then(r => readJsonIfOk<{ providers?: CatalogPreset[] }>(r))
      .then((d) => {
        if (cancelled) return;
        if (!d) {
          setBaseUrlChoices(undefined);
          setChoicesStatus("error");
          return;
        }
        const preset = (d.providers ?? []).find(p => p.id === providerId);
        const choices = preset?.baseUrlChoices;
        setBaseUrlChoices(choices);
        setChoicesStatus("ready");
        setEndpointChoice(matchChoiceId(choices, savedBaseUrl));
      })
      .catch(() => {
        if (cancelled) return;
        setBaseUrlChoices(undefined);
        setChoicesStatus("error");
      });
    return () => { cancelled = true; };
    // Remount via key={item.name}; capture savedBaseUrl once per mount/fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item.baseUrl sync is handled by the form-reset effect
  }, [apiBase, item.name]);

  const dirty = adapter.trim() !== item.adapter
    || baseUrl.trim() !== item.baseUrl
    || defaultModel.trim() !== (item.defaultModel ?? "")
    || authMode !== String(item.authMode ?? (item.keyOptional ? "local" : "key"))
    || (adapter.trim() === "anthropic" && authMode === "key" && apiKeyTransport !== (item.apiKeyTransport ?? "x-api-key"))
    || note.trim() !== (item.note ?? "")
    || allowPrivateNetwork !== (item.allowPrivateNetwork ?? false)
    || liveModels !== (item.liveModels !== false);

  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

  const modelOptions = useMemo(() => {
    const set = new Set(availableModels);
    if (defaultModel.trim()) set.add(defaultModel.trim());
    if (item.defaultModel) set.add(item.defaultModel);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [availableModels, defaultModel, item.defaultModel]);

  const adapterOptions = useMemo(() => {
    const list = [...ADAPTERS] as string[];
    if (adapter && !list.includes(adapter)) list.unshift(adapter);
    return list;
  }, [adapter]);

  const isPreset = isCatalogProviderId(item.name);
  const hasEndpointPicker = choicesStatus === "ready" && !!(baseUrlChoices && baseUrlChoices.length > 0);
  const supportsApiKeyTransport = adapter.trim() === "anthropic" && authMode === "key";
  // Lock plain baseUrl for presets while loading or when there is no picker.
  // On fetch error, keep it editable so allowBaseUrlOverride providers are not trapped.
  const plainBaseUrlLocked = isPreset && choicesStatus !== "error";

  /**
   * The search index for this surface: each entry carries its label, its description
   * and its CURRENT value, so typing a remembered base URL finds the field as readily
   * as typing "Base URL". Entries for controls this provider does not have are omitted,
   * so the search can never point at a field that is not on screen.
   */
  const settingsEntries = useMemo((): { id: SettingId; text: string }[] => {
    const rows: { id: SettingId; text: string }[] = [
      { id: "providerId", text: `${t("pws.providerId")} ${item.name}` },
      { id: "adapter", text: `${t("modal.adapter")} ${adapter}` },
    ];
    if (hasEndpointPicker) rows.push({ id: "endpoint", text: `${t("modal.endpoint")} ${endpointChoice} ${baseUrl}` });
    if (!hasEndpointPicker || endpointChoice === "custom") {
      rows.push({ id: "baseUrl", text: `${t("modal.baseUrl")} ${baseUrl}` });
    }
    rows.push(
      { id: "defaultModel", text: `${t("pws.cell.defaultModel")} ${t("pws.defaultModelNone")} ${defaultModel}` },
      { id: "authMode", text: `${t("pws.authMode")} ${authModeLabel(item, t)} ${authMode}` },
    );
    if (supportsApiKeyTransport) {
      rows.push({
        id: "apiKeyTransport",
        text: [t("modal.apiKeyTransport"), t("modal.apiKeyTransportNative"), t("modal.apiKeyTransportBearer"), apiKeyTransport].join(" "),
      });
    }
    rows.push(
      { id: "note", text: `${t("pws.note")} ${note}` },
      { id: "allowPrivateNetwork", text: t("pws.allowPrivateNetwork") },
      { id: "liveModels", text: `${t("pws.liveModels")} ${t("pws.liveModelsDesc")}` },
    );
    return rows;
  }, [adapter, apiKeyTransport, authMode, baseUrl, defaultModel, endpointChoice, hasEndpointPicker, item, note, supportsApiKeyTransport, t]);

  const { settingMatches, settingsError, settingsHits, elsewhereTabs } = useMemo(() => {
    const matcher = makeMatcher(settingsQuery, settingsRegex);
    const hits = new Set(settingsEntries.filter(entry => matcher.test(entry.text)).map(entry => entry.id));
    const elsewhere = otherTabSettings.filter(entry => matcher.test(`${entry.tab} ${entry.text}`));
    return {
      settingMatches: (id: SettingId) => hits.has(id),
      settingsError: matcher.error,
      settingsHits: hits.size,
      elsewhereTabs: [...new Set(elsewhere.map(entry => entry.tab))],
    };
  }, [otherTabSettings, settingsEntries, settingsQuery, settingsRegex]);

  const searching = settingsQuery.trim().length > 0;
  /** Before a query is typed nothing is filtered — the form is not a search result. */
  const show = (id: SettingId) => !searching || settingMatches(id);

  const save = async (): Promise<boolean> => {
    if (!onUpdateProvider) { setMsg({ ok: false, text: t("pws.updatesUnavailable") }); return false; }
    const nextBaseUrl = hasEndpointPicker
      ? resolvedBaseUrlForChoice(baseUrlChoices, endpointChoice, baseUrl)
      : baseUrl.trim();
    if (!adapter.trim() || !nextBaseUrl) { setMsg({ ok: false, text: t("pws.adapterBaseRequired") }); return false; }
    setSaving(true);
    setMsg(null);
    try {
      const patch: ProviderUpdatePatch = { adapter: adapter.trim(), baseUrl: nextBaseUrl, defaultModel: defaultModel.trim(), authMode, note: note.trim(), allowPrivateNetwork, liveModels };
      if (supportsApiKeyTransport) patch.apiKeyTransport = apiKeyTransport;
      else if (item.apiKeyTransport !== undefined) patch.apiKeyTransport = "";
      const res = await onUpdateProvider(item.name, patch);
      setMsg(res.ok ? { ok: true, text: t("pws.settingsSaved") } : { ok: false, text: res.error || t("prov.saveFailed") });
      return res.ok;
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (!onRegisterSave) return;
    onRegisterSave(() => saveRef.current());
    return () => onRegisterSave(null);
  }, [onRegisterSave]);

  const discard = () => {
    setAdapter(item.adapter); setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? ""); setAuthMode(initialAuth);
    setApiKeyTransport(item.apiKeyTransport ?? "x-api-key");
    setNote(item.note ?? ""); setAllowPrivateNetwork(item.allowPrivateNetwork ?? false); setLiveModels(item.liveModels !== false); setMsg(null);
    setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl));
  };

  const endpointLabel = (id: string, fallback: string) => {
    switch (id) {
      case "token-plan": return t("modal.endpoint.tokenPlan");
      case "payg": return t("modal.endpoint.payAsYouGo");
      case "custom": return t("modal.endpoint.custom");
      default: return fallback;
    }
  };

  return (
    <div className="pwi-settings-form">
      {/* Every settings surface carries its own search, wired to the full builder and
          bound to this field alone — it never shares state with the rail search. */}
      <div style={SEARCH_ROW} role="search">
        <IconSearch width={18} height={18} aria-hidden="true" className="muted" />
        <TextInput
          type="search"
          value={settingsQuery}
          onChange={e => setSettingsQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={!!settingsError}
          style={SEARCH_INPUT}
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
          value={settingsQuery}
          onApply={pattern => setSettingsQuery(pattern)}
          regex={settingsRegex}
          onRegexChange={setSettingsRegex}
          // This provider's own settings index, so the sample is the text the
          // pattern will be run over rather than an invented example.
          sample={settingsEntries.map(entry => entry.text).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      {settingsError && (
        <p role="alert" style={SEARCH_ERROR}>{t("regex.invalid")}: {settingsError}</p>
      )}
      {!settingsError && searching && elsewhereTabs.length > 0 && (
        <p role="status" style={SEARCH_NOTE}>
          {t("settings.otherTab", { count: elsewhereTabs.length, tabs: elsewhereTabs.join(", ") })}
        </p>
      )}
      {!settingsError && searching && settingsHits === 0 && (
        <p role="status" style={SEARCH_NOTE}>{t("settings.noMatch")}</p>
      )}
      {show("providerId") && (
      <label className="pwi-settings-field">
        <span className="pwi-settings-label"><IconLock style={{ width: 12, height: 12 }} /> {t("pws.providerId")}</span>
        <input className="m3-input" value={item.name} readOnly disabled />
      </label>
      )}
      {show("adapter") && (
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("modal.adapter")}</span>
        {isPreset ? <input className="m3-input" value={adapter} readOnly disabled /> : (
          <select className="m3-input" value={adapter} onChange={e => setAdapter(e.target.value)}>
            {adapterOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </label>
      )}
      {hasEndpointPicker ? (
        <>
          {show("endpoint") && (
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.endpoint")}</span>
            <select
              className="m3-input"
              value={endpointChoice}
              onChange={e => {
                const id = e.target.value;
                setEndpointChoice(id);
                setBaseUrl(baseUrlForChoice(baseUrlChoices, id, baseUrl));
              }}
            >
              {baseUrlChoices!.map(c => (
                <option key={c.id} value={c.id}>{endpointLabel(c.id, c.label)}</option>
              ))}
            </select>
          </label>
          )}
          {endpointChoice === "custom" && show("baseUrl") && (
            <label className="pwi-settings-field">
              <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
              <input className="m3-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t("modal.baseUrlPlaceholder")} />
            </label>
          )}
        </>
      ) : show("baseUrl") && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
          <input className="m3-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} readOnly={plainBaseUrlLocked} disabled={plainBaseUrlLocked} />
        </label>
      )}
      {show("defaultModel") && (
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.cell.defaultModel")}</span>
        {modelOptions.length > 0 ? (
          <select className="m3-input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)}>
            <option value="">{t("pws.defaultModelNone")}</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input className="m3-input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder={t("pws.optionalPlaceholder")} />
        )}
      </label>
      )}
      {show("authMode") && (
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.authMode")}</span>
        {isPreset ? <input className="m3-input" value={authModeLabel(item, t)} readOnly disabled /> : (
          <select className="m3-input" value={authMode} onChange={e => setAuthMode(e.target.value)}>
            <option value="key">{t("modal.badge.apiKey")}</option>
            <option value="forward">{t("pws.auth.chatgptPassthrough")}</option>
            <option value="oauth">{t("modal.badge.oauth")}</option>
            <option value="local">{t("modal.badge.local")}</option>
          </select>
        )}
      </label>
      )}
      {supportsApiKeyTransport && show("apiKeyTransport") && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.apiKeyTransport")}</span>
          <select className="m3-input" value={apiKeyTransport} onChange={e => setApiKeyTransport(e.target.value as "x-api-key" | "bearer")}>
            <option value="x-api-key">{t("modal.apiKeyTransportNative")}</option>
            <option value="bearer">{t("modal.apiKeyTransportBearer")}</option>
          </select>
        </label>
      )}
      {show("note") && (
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.note")}</span>
        <textarea className="m3-input pwi-settings-textarea" value={note} onChange={e => setNote(e.target.value)} rows={2} />
      </label>
      )}
      {show("allowPrivateNetwork") && (
      <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={allowPrivateNetwork} onChange={e => setAllowPrivateNetwork(e.target.checked)} />
        <span className="pwi-settings-label">{t("pws.allowPrivateNetwork")}</span>
      </label>
      )}
      {show("liveModels") && (
      <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <input type="checkbox" checked={liveModels} onChange={e => setLiveModels(e.target.checked)} />
        <span>
          <span className="pwi-settings-label">{t("pws.liveModels")}</span>
          <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>{t("pws.liveModelsDesc")}</span>
        </span>
      </label>
      )}
      {dirty && (
        <div className="pwi-settings-sticky-bar">
          <span className="muted">{t("pws.settingsUnsavedBar")}</span>
          <div className="pwi-settings-sticky-bar-actions">
            <button type="button" className="m3-btn m3-btn--text pws-btn-sm" onClick={discard} disabled={saving}>{t("pws.discardSettings")}</button>
            <button type="button" className="m3-btn m3-btn--filled pws-btn-sm" onClick={() => void save()} disabled={saving}>{saving ? t("pws.saving") : t("pws.saveSettings")}</button>
          </div>
        </div>
      )}
      {msg && <div className={msg.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>{msg.text}</div>}
    </div>
  );
}
