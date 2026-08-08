import { useCallback, useMemo, useState } from "react";
import {
  type ComboItem,
  comboPublicModelId,
  emptyDraft,
  intersectComboEfforts,
  validateComboDraft,
} from "../combo-workspace-data";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { Banner, Button, Dialog, TextInput } from "../shell/m3-ui";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { EffortSelect, StrategySeg, TargetEditor } from "./combo-workspace-controls";
import { clampedNumberInput } from "./combo-workspace-utils";

export function AddComboModal({
  existingIds,
  existingAliases,
  providerMap,
  providers,
  models,
  onClose,
  onSubmit,
}: {
  existingIds: string[];
  existingAliases: string[];
  providerMap: Readonly<Record<string, { disabled?: boolean }>>;
  providers: ProviderOption[];
  models: ModelOption[];
  onClose: () => void;
  onSubmit: (item: ComboItem) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ComboItem>(() => emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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

  // Every dismissal route funnels through here so an in-flight save is never
  // interrupted half-way: Escape, the close button and Cancel all no-op while
  // `busy`.
  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const submit = async () => {
    const code = validateComboDraft(draft, {
      existingIds,
      existingAliases,
      isCreate: true,
      providers: providerMap,
    });
    if (code) {
      setError(t(`cws.err.${code}`));
      return;
    }
    setBusy(true);
    setError("");
    const id = draft.id.trim();
    const alias = draft.alias?.trim() || null;
    try {
      const res = await onSubmit({ ...draft, id, alias, model: comboPublicModelId(id, alias) });
      if (!res.ok) {
        setError(res.error || t("cws.saveFailed"));
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onClose={requestClose}
      // The headline is rendered as a child rather than passed as `title`,
      // because the head also carries the close affordance and a button nested
      // inside the M3 headline would land in the dialog's accessible name. This
      // owns the `cwi-add-title` id instead, exactly as it did before.
      labelledBy="cwi-add-title"
      width={600}
      // A whole page of unsaved typing — id, alias, targets. A stray click on
      // the scrim must not throw it away; Escape and Cancel remain the way out.
      dismissOnScrim={false}
      actions={(
        <>
          <Button variant="text" onClick={requestClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="filled" onClick={() => { void submit(); }} disabled={busy}>
            {busy ? t("common.saving") : t("cws.create")}
          </Button>
        </>
      )}
    >
      <header className="m3-dialog__head">
        <div className="m3-row m3-row--split">
          <h2 id="cwi-add-title" className="m3-dialog__title">{t("cws.addTitle")}</h2>
          <button type="button" className="cwi-icon-btn" onClick={requestClose} disabled={busy} aria-label={t("common.close")}>
            <IconX width={20} height={20} aria-hidden="true" />
          </button>
        </div>
        <p className="m3-dialog__desc">{t("cws.addSubtitle")}</p>
      </header>
      {/* Inline, not a snackbar: it says why THIS form was refused, it sits above the
          fields that have to change, and it clears only when the next submit gets
          further than validation. */}
      {error && <Banner tone="error">{error}</Banner>}
      {/* The fields keep their own scroll region so the headline and the action
          row stay put while a long target list scrolls underneath them. */}
      <div className="cwi-modal-form">
        <div className="cwi-field">
          <label htmlFor="cwi-new-id">{t("cws.field.id")}</label>
          <TextInput
            id="cwi-new-id"
            className="mono"
            value={draft.id}
            disabled={busy}
            onChange={(e) => setDraft((d) => ({
              ...d,
              id: e.target.value,
              model: comboPublicModelId(e.target.value, d.alias),
            }))}
          />
          <p className="m3-field-hint">
            {t("cws.field.idInternalHint")}
          </p>
        </div>
        <div className="cwi-field">
          <label htmlFor="cwi-new-alias">{t("cws.field.alias")}</label>
          <TextInput
            id="cwi-new-alias"
            className="mono"
            value={draft.alias ?? ""}
            placeholder={t("cws.field.aliasPlaceholder")}
            disabled={busy}
            onChange={(e) => setDraft((d) => ({
              ...d,
              alias: e.target.value.trim() ? e.target.value : null,
              model: comboPublicModelId(d.id, e.target.value),
            }))}
          />
          <p className="m3-field-hint">
            {t("cws.field.aliasHint")}
          </p>
          <p className="m3-field-hint">
            {t("cws.field.idHint", {
              model: draft.id.trim() ? comboPublicModelId(draft.id, draft.alias) : "…",
            })}
          </p>
        </div>
        <div className="cwi-field">
          <span className="field-label">{t("cws.strategy")}</span>
          <StrategySeg
            value={draft.strategy}
            disabled={busy}
            onChange={(strategy) => setDraft((d) => ({ ...d, strategy }))}
          />
          <p className="m3-field-hint">
            {draft.strategy === "failover" ? t("cws.strategy.failoverHint") : t("cws.strategy.roundRobinHint")}
          </p>
        </div>
        <div className="cwi-field">
          <label htmlFor="cwi-new-effort">{t("cws.field.defaultEffort")}</label>
          <EffortSelect
            id="cwi-new-effort"
            value={draft.defaultEffort}
            disabled={busy}
            allowedEfforts={allowedEfforts}
            onChange={(defaultEffort) => setDraft((d) => ({ ...d, defaultEffort }))}
          />
          <p className="m3-field-hint">
            {t("cws.field.defaultEffortHint")}
          </p>
        </div>
        {draft.strategy === "round-robin" && (
          <div className="cwi-field">
            <label htmlFor="cwi-new-sticky">{t("cws.field.stickyLimit")}</label>
            <TextInput
              id="cwi-new-sticky"
              className="mono"
              type="number"
              min={1}
              max={100}
              value={draft.stickyLimit}
              disabled={busy}
              onChange={(e) => {
                const stickyLimit = clampedNumberInput(e.target.value, 1, 100);
                if (stickyLimit === undefined) return;
                setDraft((d) => ({ ...d, stickyLimit }));
              }}
            />
            <p className="m3-field-hint">
              {t("cws.field.stickyLimitHint")}
            </p>
          </div>
        )}
        <div className="cwi-field">
          <span className="field-label">{t("cws.targets")}</span>
          <p className="m3-field-hint" style={{ margin: "0 0 8px" }}>
            {draft.strategy === "failover" ? t("cws.targets.failoverHint") : t("cws.targets.roundRobinHint")}
          </p>
          <TargetEditor
            targets={draft.targets}
            strategy={draft.strategy}
            providers={providers}
            models={models}
            onChange={(targets) => setDraft((d) => ({ ...d, targets }))}
          />
        </div>
      </div>
    </Dialog>
  );
}
