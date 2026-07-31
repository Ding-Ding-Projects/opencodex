/**
 * ProviderModels — the models tab: searchable wrapping model chips with
 * default/selected flags and copy-to-clipboard ids. Uses a wrap layout so
 * short lists fill horizontal space instead of a tall single-column stack.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { Chip } from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../../shell/settings-search";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { filterModels } from "../../provider-workspace/report";

export default function ProviderModels({
  item,
  apiBase,
  availableModels,
  hasLiveModels,
  selectedModels,
  modelsLoading = false,
  modelsLoadFailed = false,
  needsReauth = false,
  onRetryModels,
  onOpenAccounts,
}: {
  item: WorkspaceItem;
  apiBase: string;
  availableModels: string[];
  selectedModels: string[];
  /** Server-reported: did the last successful discovery return any rows? */
  hasLiveModels: boolean;
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  /** Active OAuth account needs a fresh login before live discovery works. */
  needsReauth?: boolean;
  onRetryModels?: () => void;
  onOpenAccounts?: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  /**
   * The regex opt-in and the flags the builder hands back.
   *
   * This search bar shipped with neither — it was one of three in the app that
   * offered no way to reach the builder at all, so a model catalogue of several
   * hundred ids could only be narrowed by substring. Plain text stays the
   * default; `.*` is the explicit opt-in, exactly as on every other search bar.
   */
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [customModelId, setCustomModelId] = useState("");
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [customSuccess, setCustomSuccess] = useState("");
  const [customModelIds, setCustomModelIds] = useState<string[]>([]);
  const [customModelsReady, setCustomModelsReady] = useState(false);
  const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
  const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const configuredModels = useMemo(() => item.models ?? [], [item.models]);
  const trimmedCustomModelId = customModelId.trim();
  const customModelInvalid = !customModelsReady
    || !trimmedCustomModelId
    || trimmedCustomModelId.includes("/")
    || availableModels.includes(trimmedCustomModelId)
    || customModelIds.includes(trimmedCustomModelId)
    || configuredModels.includes(trimmedCustomModelId)
    || item.defaultModel === trimmedCustomModelId;
  const matcher = useMemo(() => settingsMatcher(query, useRegex, flags), [query, useRegex, flags]);
  /** The catalogue as it stands before any query, for the builder to test against. */
  const allModelIds = useMemo(
    () => filterModels(availableModels, item.defaultModel, "", configuredModels, customModelIds, hasLiveModels),
    [availableModels, item.defaultModel, configuredModels, customModelIds, hasLiveModels],
  );
  const models = useMemo(
    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels, matcher),
    [availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels, matcher],
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/custom-models`);
        if (!response.ok) throw new Error();
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("Invalid custom model list");
        if (!active) return;
        setCustomModelIds(rows.flatMap(row => {
          if (!row || typeof row !== "object") return [];
          const model = row as { provider?: unknown; modelId?: unknown };
          return model.provider === item.name && typeof model.modelId === "string" ? [model.modelId] : [];
        }));
        setCustomModelsLoadFailed(false);
        setCustomError("");
        setCustomModelsReady(true);
      } catch {
        if (!active) return;
        setCustomModelIds([]);
        // Without this the component stays permanently unable to add a model: `customModelsReady`
        // never flips back and the effect has no trigger left, so a single transient GET failure
        // disabled Add until the whole panel remounted.
        setCustomModelsReady(false);
        setCustomModelsLoadFailed(true);
        setCustomError(t("models.networkError"));
      }
    };
    void load();
    return () => { active = false; };
  }, [apiBase, item.name, t, customModelsLoadEpoch]);

  const retryCustomModels = () => {
    setCustomModelsReady(false);
    setCustomModelsLoadFailed(false);
    setCustomError("");
    setCustomModelsLoadEpoch(epoch => epoch + 1);
  };

  useEffect(() => () => {
    if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
  }, []);

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedId(modelId);
      if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => {
        setCopiedId(prev => (prev === modelId ? null : prev));
        copyResetRef.current = null;
      }, 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const addCustomModel = async () => {
    if (customModelInvalid || customSaving) return;
    setCustomSaving(true);
    setCustomError("");
    setCustomSuccess("");
    try {
      const response = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.name, modelId: trimmedCustomModelId }),
      });
      if (response.ok) {
        setCustomModelIds(ids => ids.includes(trimmedCustomModelId) ? ids : [...ids, trimmedCustomModelId]);
        setCustomModelId("");
        setCustomSuccess(t("models.customAdded"));
        onRetryModels?.();
      } else {
        setCustomError(t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const emptyBase = availableModels.length === 0
    && configuredModels.length === 0
    && customModelIds.length === 0
    && !item.defaultModel;
  const showingConfiguredFallback = availableModels.length === 0 && configuredModels.length > 0;
  // Aggregators (OpenRouter etc.) can return thousands of ids; capping the mounted
  // chips keeps the tab responsive. Filtering narrows the list, so the cap only
  // bites on the unfiltered full catalog.
  const CHIP_RENDER_CAP = 300;
  const capped = models.length > CHIP_RENDER_CAP;
  const visibleModels = capped ? models.slice(0, CHIP_RENDER_CAP) : models;

  return (
    <div className="pws-section">
      <div className="pws-section-head">
        <h3 className="pws-section-title">{t("pws.tab.models")}</h3>
        {models.length > 0 && (
          <span className="muted">{t("pws.modelsAvailable", { count: models.length })}</span>
        )}
      </div>
      {needsReauth && (
        <div className="pws-inline-error" role="status">
          <span>{t("pws.modelsNeedsReauth")}</span>
          {onOpenAccounts && (
            <button type="button" className="m3-btn m3-btn--text pws-btn-sm" onClick={onOpenAccounts}>
              {t("pws.tab.accounts")}
            </button>
          )}
        </div>
      )}
      {showingConfiguredFallback && !needsReauth && (
        <p className="muted text-label" style={{ marginBottom: 10 }}>{t("pws.modelsConfiguredFallback")}</p>
      )}
      <label className="text-label pws-custom-model-label" htmlFor={`pws-custom-model-${item.name}`}>
        {t("models.customAdd")}
      </label>
      <div className="row pws-custom-model-row">
        <input
          id={`pws-custom-model-${item.name}`}
          className="m3-input"
          value={customModelId}
          onChange={event => setCustomModelId(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") void addCustomModel(); }}
          placeholder={t("models.customFieldModelIdPlaceholder")}
          aria-label={t("models.customAdd")}
          disabled={customSaving}
        />
        <button
          type="button"
          className="m3-btn m3-btn--filled pws-btn-sm"
          onClick={() => { void addCustomModel(); }}
          disabled={customSaving || customModelInvalid}
        >
          {customSaving ? t("models.customSaving") : t("models.customAddBtn")}
        </button>
      </div>
      {customSuccess && <p className="muted text-label" role="status">{customSuccess}</p>}
      {customError && (
        <p className="pws-inline-error" role="alert">
          {customError}
          {customModelsLoadFailed && (
            <button type="button" className="m3-btn m3-btn--text pws-btn-sm" onClick={retryCustomModels} style={{ marginLeft: 8 }}>
              {t("common.retry")}
            </button>
          )}
        </p>
      )}
      {!emptyBase && (
        <div className="m3-row pws-model-search-row" role="search">
          <input
            type="search"
            className="m3-input pws-model-search"
            placeholder={t("pws.modelSearchPlaceholder")}
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label={t("pws.modelSearchPlaceholder")}
            aria-invalid={!!matcher.error}
            aria-describedby={matcher.error ? "pws-model-search-error" : undefined}
          />
          <Chip
            selected={useRegex}
            onClick={() => setUseRegex(!useRegex)}
            title={t("regex.regexMode")}
            aria-label={t("regex.regexMode")}
          >
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
          <RegexBuilderButton
            value={query}
            flags={flags}
            regex={useRegex}
            onRegexChange={setUseRegex}
            onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
            // The whole catalogue, not `models`: a sample taken from the already
            // filtered list would hide every id the half-written pattern is being
            // built to reach.
            sample={allModelIds.join("\n")}
          />
        </div>
      )}
      {matcher.error && (
        <p id="pws-model-search-error" className="pws-inline-error" role="alert">
          {t("regex.invalid")}: {matcher.error}
        </p>
      )}
      {modelsLoading && emptyBase ? (
        <p className="muted" role="status">{t("pws.modelsLoading")}</p>
      ) : modelsLoadFailed && emptyBase ? (
        <div role="alert" className="pws-inline-error">
          <span>{t("pws.modelsLoadFailed")}</span>
          {onRetryModels && (
            <button type="button" className="m3-btn m3-btn--text pws-btn-sm" onClick={onRetryModels}>
              {t("pws.retry")}
            </button>
          )}
        </div>
      ) : emptyBase ? (
        <p className="muted">{t("pws.noModels")}</p>
      ) : models.length === 0 ? (
        <p className="muted" role="status">{t("pws.noModelMatch")}</p>
      ) : (
        <ul className="pws-model-list">
          {visibleModels.map(modelId => {
            const isDefault = modelId === item.defaultModel;
            const isSelected = selectedSet.has(modelId);
            const copied = copiedId === modelId;
            return (
              <li key={modelId} className="pws-model-chip">
                <button
                  type="button"
                  className="pws-model-chip-main"
                  onClick={() => { void copyModelId(modelId); }}
                  title={modelId}
                  aria-label={copied ? t("pws.modelCopied") : t("pws.copyModelId")}
                >
                  <span className="pws-model-id">{modelId}</span>
                </button>
                {isDefault ? <span className="badge badge-muted pws-model-flag">{t("prov.defaultBadge")}</span> : null}
                {isSelected ? <span className="badge badge-accent pws-model-flag">{t("pws.selected")}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {capped && (
        <p className="muted text-label" style={{ marginTop: 10 }}>
          {t("pws.modelsTruncated", { shown: String(CHIP_RENDER_CAP), total: String(models.length) })}
        </p>
      )}
    </div>
  );
}
