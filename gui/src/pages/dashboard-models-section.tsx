import { type Dispatch, type SetStateAction } from "react";
import { IconChevron, IconSearch } from "../icons";
import type { TFn } from "../i18n/shared";
import { Card, Chip, Empty } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { modelMetaLabel, type ModelInfo } from "./dashboard-shared";

/**
 * How many models the anchored builder is handed as sample text. Bounded because
 * the string is rebuilt on every render of the search row, and this list is the
 * whole catalogue rather than one provider's slice of it.
 */
const SAMPLE_ROWS = 40;

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
            <RegexBuilderButton
              value={modelQuery}
              onApply={pattern => setModelQuery(pattern)}
              regex={modelRegex}
              onRegexChange={setModelRegex}
              // The unfiltered catalogue in the same shape the search matches it —
              // `filteredGroups` is what the current query already kept, and a
              // pattern tested against those survivors proves nothing.
              sample={models.slice(0, SAMPLE_ROWS).map(m => `${m.id} ${m.provider}`).join("\n")}
            />
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
                      // The prototype renders every model as a two-line card — the id
                      // above `provider · ctx · cap` — where the port had a nowrap pill
                      // that could only ever hold the id and pushed the meta into a
                      // `title` no keyboard user could reach. The card repeats the
                      // provider the group heading states on purpose: a card surfaced by
                      // a search is read on its own, and the heading scrolls away.
                      <div className="dash-model-grid">
                        {rows.map(m => (
                          <div key={`${m.provider}/${m.id}`} className="dash-model-card">
                            <div className="dash-model-card__id">{m.id}</div>
                            <div className="dash-model-card__meta">{modelMetaLabel(m, t)}</div>
                          </div>
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
