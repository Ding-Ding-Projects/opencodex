import { type Dispatch, type SetStateAction } from "react";
import { IconChevron, IconSearch } from "../icons";
import type { TFn } from "../i18n/shared";
import { Card, Empty } from "../shell/m3-ui";
import type { ModelInfo } from "./dashboard-shared";

export function DashboardModelsSection({
  t,
  models,
  modelsLoading,
  modelQuery,
  setModelQuery,
  filteredGroups,
  expandedProviders,
  setExpandedProviders,
}: {
  t: TFn;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelQuery: string;
  setModelQuery: (v: string) => void;
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
          <div className="pws-search-wrap dash-model-search">
            <IconSearch className="pws-search-icon" width={14} height={14} aria-hidden="true" />
            <input
              type="search"
              className="m3-input pws-search-input"
              placeholder={t("models.search")}
              value={modelQuery}
              onChange={e => setModelQuery(e.target.value)}
              aria-label={t("models.search")}
            />
          </div>
          {filteredGroups.length === 0 ? (
            <p className="dash-hint">{t("dash.modelsNoResults")}</p>
          ) : (
            <div className="dash-model-acc">
              {filteredGroups.map(([provider, rows]) => {
                const q = modelQuery.trim().toLowerCase();
                const open = q !== "" || expandedProviders.has(provider);
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
                          <code key={`${m.provider}/${m.id}`} className="dash-model-chip">{m.id}</code>
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
