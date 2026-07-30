import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ComboItem,
  comboPublicModelId,
  emptyDraft,
  intersectComboEfforts,
  validateComboDraft,
} from "../combo-workspace-data";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import { Button, TextInput } from "../shell/m3-ui";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    requestClose();
  }, [requestClose]);

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
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="cwi-add-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={requestClose} />
      <div className="cwi-dialog-card cwi-dialog-card--add" onClick={(e) => e.stopPropagation()}>
        <div className="m3-row m3-row--split">
          <h3 id="cwi-add-title" className="cwi-dialog-title">{t("cws.addTitle")}</h3>
          <button type="button" className="cwi-icon-btn" onClick={requestClose} disabled={busy} aria-label={t("common.close")}>
            <IconX width={20} height={20} aria-hidden="true" />
          </button>
        </div>
        <p className="cwi-dialog-desc">{t("cws.addSubtitle")}</p>
        {error && <Notice tone="err">{error}</Notice>}
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
        <div className="cwi-modal-actions">
          <Button variant="text" onClick={requestClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="filled" onClick={() => { void submit(); }} disabled={busy}>
            {busy ? t("common.saving") : t("cws.create")}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
