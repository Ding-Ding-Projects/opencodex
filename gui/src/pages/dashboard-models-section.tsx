import { type Dispatch, type SetStateAction } from "react";
import { IconChevron, IconRegex, IconSearch } from "../icons";
import type { TFn } from "../i18n/shared";
import { Card, Chip, Empty } from "../shell/m3-ui";
import { modelMetaLabel, type ModelInfo } from "./dashboard-shared";

export function DashboardModelsSection({
  t,
  models,
  modelsLoading,
  modelQuery,
  setModelQuery,
  modelRegex,
  setModelRegex,
  modelRegexError,
  filteredGroups,
  expandedProviders,
  setExpandedProviders,
}: {
  t: TFn;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelQuery: string;
  setModelQuery: (v: string) => void;
  modelRegex: boolean;
  setModelRegex: Dispatch<SetStateAction<boolean>>;
  modelRegexError: string | null;
  filteredGroups: Array<[string, ModelInfo[]]>;
  expandedProviders: Set<string>;
  setExpandedProviders: Dispatch<SetStateAction<Set<string>>>;
}) {
  return (
    <Card
      title={t("dash.availableModels")}
      subtitle={String(models.length)}
      actions={modelsLoading ? <span className="spin" aria-hidden="true" /> : undefined}
    >
      {models.length === 0 && !modelsLoading ? (
        <Empty title={t("dash.noModels")} />
      ) : (
        <>
          <div className="m3-row dash-model-search" role="search">
            <div className="pws-search-wrap">
              <IconSearch className="pws-search-icon" width={14} height={14} aria-hidden="true" />
              <input
                type="search"
                className="m3-input pws-search-input"
                placeholder={t("models.search")}
                value={modelQuery}
                onChange={e => setModelQuery(e.target.value)}
                aria-label={t("models.search")}
                aria-invalid={!!modelRegexError}
              />
            </div>
            {/* Plain text stays the default; `.*` is an explicit opt-in, and the
                builder sits beside the field it belongs to. */}
            <Chip selected={modelRegex} onClick={() => setModelRegex(v => !v)} title={t("search.regexHint")}>
              <code style={{ fontFamily: "var(--mono)" }}>.*</code>
            </Chip>
            <a className="m3-icon-btn" href="#regex" title={t("search.openBuilder")} aria-label={t("search.openBuilder")}>
              <IconRegex width={18} height={18} aria-hidden="true" />
            </a>
          </div>
          {modelRegexError && (
            <p role="alert" className="dash-hint" style={{ color: "var(--m3-error)" }}>
              {t("regex.invalid")}: {modelRegexError}
            </p>
          )}
          {filteredGroups.length === 0 ? (
            <p className="dash-hint">{t("dash.modelsNoResults")}</p>
          ) : (
            <div className="dash-model-acc">
              {filteredGroups.map(([provider, rows]) => {
                const open = modelQuery.trim() !== "" || expandedProviders.has(provider);
                return (
                  <div key={provider} className="dash-model-group">
                    <button
                      type="button"
                      className="dash-model-head"
                      onClick={() => setExpandedProviders(prev => { const next = new Set(prev); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; })}
                      aria-expanded={open}
                    >
                      <IconChevron width={12} height={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s", color: "var(--m3-on-surface-variant)" }} aria-hidden="true" />
                      <span className="font-semibold">{provider}</span>
                      <span className="count">{rows.length}</span>
                    </button>
                    {open && (
                      <div className="dash-model-chips">
                        {rows.map(m => (
                          // The prototype prints `provider · ctx · cap` under every model.
                          // The group heading already names the provider, so the chip
                          // carries the part the heading does not.
                          <code key={`${m.provider}/${m.id}`} className="dash-model-chip" title={modelMetaLabel(m, t)}>
                            {m.id}
                            <span className="muted">{modelMetaChipSuffix(m, t)}</span>
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** The meta line minus the provider, which the group heading above already states. */
function modelMetaChipSuffix(model: ModelInfo, t: TFn): string {
  const full = modelMetaLabel(model, t);
  const rest = full.slice(model.provider.length);
  return rest;
}
