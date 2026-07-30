import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildComboAttention,
  type ComboItem,
  comboModelId,
  comboPublicModelId,
  draftEquals,
  intersectComboEfforts,
  validateComboDraft,
} from "../combo-workspace-data";
import { IconAlert, IconChevron, IconRegex, IconSearch, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import { Button, Card, Chip, TextInput } from "../shell/m3-ui";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { EffortSelect, StrategySeg, TargetEditor } from "./combo-workspace-controls";
import { attentionCopy } from "./combo-workspace-attention";
import { comboSettingsSearch } from "./combo-workspace-settings-search";
import { clampedNumberInput } from "./combo-workspace-utils";

type DetailTab = "config" | "about";

export function DetailPanel({
  baseline,
  isCreate = false,
  otherIds,
  otherAliases,
  cataloguedComboIds,
  providerMap,
  providers,
  models,
  onBack,
  onSaved,
  onRequestRemove,
  onSave,
  onDirtyChange,
}: {
  baseline: ComboItem;
  isCreate?: boolean;
  /** Ids of all OTHER combos — rename collisions validate against these. */
  otherIds: string[];
  /** Aliases of all OTHER combos — alias uniqueness validates against these. */
  otherAliases: string[];
  /** Combo ids the live model catalog advertises — a missing one is flagged here. */
  cataloguedComboIds?: ReadonlySet<string>;
  providerMap: Readonly<Record<string, { disabled?: boolean }>>;
  providers: ProviderOption[];
  models: ModelOption[];
  onBack?: () => void;
  onSaved: (item: ComboItem) => void;
  onRequestRemove?: () => void;
  onSave: (item: ComboItem, isCreate: boolean, renameFrom?: string) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("config");
  const [draft, setDraft] = useState<ComboItem>(baseline);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // This tab's own settings search. Bound to this field alone — it never shares state
  // with the rail's combo search, which looks for a different kind of thing.
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsRegex, setSettingsRegex] = useState(false);
  const dirty = !draftEquals(draft, baseline);
  const baselineSyncKey = `${baseline.id}:${baseline.alias ?? ""}:${baseline.strategy}:${baseline.stickyLimit}:${baseline.defaultEffort}:${baseline.targets.map((t) => `${t.provider}/${t.model}:${t.weight ?? 1}`).join(",")}`;
  const effortMap = useMemo(() => {
    const map = new Map<string, string[] | undefined>();
    for (const model of models) {
      map.set(`${model.provider}/${model.id}`, model.reasoningEfforts);
    }
    return map;
  }, [models]);
  const allowedEfforts = useMemo(
    () => intersectComboEfforts(draft.targets, effortMap),
    [draft.targets, effortMap],
  );
  // The prototype banners the selected combo's own warnings under its title. They were
  // only reachable from the overview list before, so opening a combo hid the reason you
  // opened it. Read from the saved baseline, matching what the overview reports.
  const attention = useMemo(
    () => (isCreate ? [] : buildComboAttention([baseline], { cataloguedComboIds })),
    [isCreate, baseline, cataloguedComboIds],
  );
  const settingsSearch = useMemo(
    () => comboSettingsSearch(settingsQuery, settingsRegex, t),
    [settingsQuery, settingsRegex, t],
  );
  const settingsNote = settingsSearch.error
    ? `${t("regex.invalid")}: ${settingsSearch.error}`
    : settingsSearch.otherHits > 0
      ? t("settings.otherTab", {
        count: settingsSearch.otherHits,
        tabs: settingsSearch.otherTabs.join(", "),
      })
      : settingsSearch.active && settingsSearch.hits === 0
        ? t("settings.noMatch")
        : "";

  const updateDraft = useCallback((updater: (prev: ComboItem) => ComboItem) => {
    const next = updater(draft);
    setDraft(next);
    onDirtyChange(!draftEquals(next, baseline));
  }, [draft, baseline, onDirtyChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDraft(baseline);
      setMsg(null);
      setTab("config");
      setSettingsQuery("");
      onDirtyChange(false);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: key captures baseline payload
  }, [baselineSyncKey]);

  const copyModel = async () => {
    try {
      await navigator.clipboard.writeText(baseline.model);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    const code = validateComboDraft(draft, {
      existingIds: otherIds,
      existingAliases: otherAliases,
      isCreate,
      providers: providerMap,
    });
    if (code) {
      setMsg({ ok: false, text: t(`cws.err.${code}`) });
      return;
    }
    setBusy(true);
    const trimmedId = draft.id.trim();
    const alias = draft.alias?.trim() || null;
    const item = {
      ...draft,
      id: trimmedId,
      alias,
      model: comboPublicModelId(trimmedId, alias),
    };
    const renameFrom = !isCreate && trimmedId !== baseline.id ? baseline.id : undefined;
    try {
      const res = await onSave(item, isCreate, renameFrom);
      if (!res.ok) {
        setMsg({ ok: false, text: res.error || t("cws.saveFailed") });
        return;
      }
      setMsg({
        ok: true,
        text: isCreate ? t("cws.created", { model: item.model }) : t("cws.saved"),
      });
      onSaved(item);
    } finally {
      setBusy(false);
    }
  };

  const headerModel = isCreate
    ? (draft.id.trim() ? comboPublicModelId(draft.id, draft.alias) : t("cws.addTitle"))
    : baseline.model;

  return (
    <div className="combos-workspace-detail">
      <div className="combos-workspace-detail-head">
        {onBack && (
          <Button variant="text" className="pwi-back-overview" onClick={onBack} aria-label={t("cws.backToAll")}>
            <IconChevron style={{ transform: "rotate(180deg)" }} aria-hidden="true" />
            {t("cws.allCombos")}
          </Button>
        )}
        <h2 className="combos-workspace-detail-title">{headerModel}</h2>
        {!isCreate && (
          <Chip className="cwi-copy-chip" onClick={() => { void copyModel(); }} title={t("cws.copyModel")}>
            {copied ? t("cws.copied") : t("cws.copyModel")}
          </Chip>
        )}
        {dirty && <span className="m3-chip cwi-dirty-chip">{t("cws.unsavedTitle")}</span>}
        <div className="combos-workspace-detail-actions">
          {!isCreate && onRequestRemove && (
            <Button variant="outlined" onClick={onRequestRemove}>
              <IconTrash aria-hidden="true" /> {t("common.remove")}
            </Button>
          )}
          <Button variant="filled" disabled={(!isCreate && !dirty) || busy} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t(isCreate ? "cws.create" : "common.save")}
          </Button>
        </div>
      </div>

      {attention.map((item) => (
        <div
          key={item.reason}
          className="dash-notice dash-notice--warn"
          role="status"
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          <IconAlert width={18} height={18} aria-hidden="true" style={{ flex: "0 0 auto" }} />
          <span>{attentionCopy(item.reason, t)}</span>
        </div>
      ))}

      {msg && <Notice tone={msg.ok ? "ok" : "err"}>{msg.text}</Notice>}

      <div className="combos-workspace-tabs" role="tablist" aria-label={t("cws.tabsAria")}>
        <button type="button" role="tab" aria-selected={tab === "config"} className={`combos-workspace-tab${tab === "config" ? " combos-workspace-tab--active" : ""}`} onClick={() => setTab("config")}>
          {t("cws.tab.config")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "about"} className={`combos-workspace-tab${tab === "about" ? " combos-workspace-tab--active" : ""}`} onClick={() => setTab("about")}>
          {t("cws.tab.about")}
        </button>
      </div>

      <div className="combos-workspace-tab-content" role="tabpanel">
        {tab === "config" ? (
          <>
            {/* Every settings surface carries its own search: plain text by default,
                an explicit `.*` opt-in, and the full builder anchored beside the
                field. A miss here still reports the sibling tab that does match. */}
            <div className="m3-row" role="search" style={{ gap: 8 }}>
              <IconSearch width={20} height={20} aria-hidden="true" />
              <TextInput
                type="search"
                value={settingsQuery}
                onChange={(e) => setSettingsQuery(e.target.value)}
                placeholder={t("settings.search")}
                aria-label={t("settings.search")}
                aria-invalid={settingsSearch.error !== null}
                style={{ flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 420 }}
              />
              <Chip
                selected={settingsRegex}
                onClick={() => setSettingsRegex((on) => !on)}
                title={t("regex.regexMode")}
                aria-label={t("regex.regexMode")}
              >
                <code style={{ fontFamily: "var(--mono)" }}>.*</code>
              </Chip>
              <a className="m3-icon-btn" href="#regex" title={t("settings.openBuilder")} aria-label={t("settings.openBuilder")}>
                <IconRegex width={20} height={20} aria-hidden="true" />
              </a>
            </div>
            {settingsNote && (
              <p
                role={settingsSearch.error ? "alert" : "status"}
                style={{
                  margin: 0,
                  color: settingsSearch.error ? "var(--m3-error)" : "var(--m3-on-surface-variant)",
                  fontSize: "var(--t-label-m)",
                }}
              >
                {settingsNote}
              </p>
            )}
            {settingsSearch.matches("identity") && (
            <Card title={t("cws.tab.config")}>
              <div className="cwi-form-grid">
                <div className="cwi-field">
                  <label htmlFor="cwi-edit-id">{t("cws.field.id")}</label>
                  <TextInput
                    id="cwi-edit-id"
                    className="mono"
                    value={draft.id}
                    disabled={busy}
                    onChange={(e) => updateDraft((d) => ({
                      ...d,
                      id: e.target.value,
                      model: comboPublicModelId(e.target.value, d.alias),
                    }))}
                  />
                  <p className="m3-field-hint">
                    {isCreate
                      ? t("cws.field.idInternalHint")
                      : t("cws.field.idHintEdit", { model: comboPublicModelId(draft.id, draft.alias) })}
                  </p>
                </div>
                <div className="cwi-field">
                  <label htmlFor="cwi-edit-alias">{t("cws.field.alias")}</label>
                  <TextInput
                    id="cwi-edit-alias"
                    className="mono"
                    value={draft.alias ?? ""}
                    placeholder={comboModelId(draft.id.trim() || "…")}
                    disabled={busy}
                    onChange={(e) => updateDraft((d) => ({
                      ...d,
                      alias: e.target.value.trim() ? e.target.value : null,
                      model: comboPublicModelId(d.id, e.target.value),
                    }))}
                  />
                  <p className="m3-field-hint">
                    {t("cws.field.aliasHint")}
                  </p>
                </div>
              </div>
            </Card>
            )}

            {settingsSearch.matches("strategy") && (
            <Card title={t("cws.strategy")}>
              <div className="cwi-form-grid">
                <div className="cwi-field">
                  <StrategySeg
                    value={draft.strategy}
                    disabled={busy}
                    onChange={(strategy) => updateDraft((d) => ({ ...d, strategy }))}
                  />
                  <p className="m3-field-hint">
                    {draft.strategy === "failover" ? t("cws.strategy.failoverHint") : t("cws.strategy.roundRobinHint")}
                  </p>
                </div>
                <div className="cwi-field">
                  <label htmlFor="cwi-effort">{t("cws.field.defaultEffort")}</label>
                  <EffortSelect
                    id="cwi-effort"
                    value={draft.defaultEffort}
                    disabled={busy}
                    allowedEfforts={allowedEfforts}
                    onChange={(defaultEffort) => updateDraft((d) => ({ ...d, defaultEffort }))}
                  />
                  <p className="m3-field-hint">
                    {t("cws.field.defaultEffortHint")}
                  </p>
                </div>
                {draft.strategy === "round-robin" && (
                  <div className="cwi-field">
                    <label htmlFor="cwi-sticky">{t("cws.field.stickyLimit")}</label>
                    <TextInput
                      id="cwi-sticky"
                      className="mono"
                      type="number"
                      min={1}
                      max={100}
                      value={draft.stickyLimit}
                      disabled={busy}
                      onChange={(e) => {
                        const stickyLimit = clampedNumberInput(e.target.value, 1, 100);
                        if (stickyLimit === undefined) return;
                        updateDraft((d) => ({ ...d, stickyLimit }));
                      }}
                    />
                    <p className="m3-field-hint">{t("cws.field.stickyLimitHint")}</p>
                  </div>
                )}
              </div>
            </Card>
            )}

            {settingsSearch.matches("targets") && (
            <Card
              title={t("cws.targets")}
              subtitle={draft.strategy === "failover" ? t("cws.targets.failoverHint") : t("cws.targets.roundRobinHint")}
            >
              <TargetEditor
                targets={draft.targets}
                strategy={draft.strategy}
                providers={providers}
                models={models}
                onChange={(targets) => updateDraft((d) => ({ ...d, targets }))}
              />
            </Card>
            )}
          </>
        ) : (
          <Card title={t("cws.aboutTitle")}>
            <p className="m3-card-sub" style={{ margin: 0 }}>{t("cws.aboutBody")}</p>
          </Card>
        )}
      </div>
    </div>
  );
}
