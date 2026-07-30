import { useCallback, useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import { Button } from "../shell/m3-ui";

export function RemoveComboDialog({
  model,
  onCancel,
  onConfirm,
}: {
  model: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onCancel();
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="cwi-remove-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onCancel} />
      <div className="cwi-dialog-card cwi-dialog-card--confirm" onClick={(e) => e.stopPropagation()}>
        <h3 id="cwi-remove-title" className="cwi-dialog-title">
          {t("cws.removeConfirmTitle", { model })}
        </h3>
        <p className="cwi-dialog-desc">{t("cws.removeConfirmDesc")}</p>
        <div className="cwi-modal-actions">
          <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("common.remove")}</Button>
        </div>
      </div>
    </dialog>
  );
}

export function UnsavedLeaveDialog({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onKeep();
  }, [onKeep]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="cwi-unsaved-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onKeep} />
      <div className="cwi-dialog-card cwi-dialog-card--confirm" onClick={(e) => e.stopPropagation()}>
        <h3 id="cwi-unsaved-title" className="cwi-dialog-title">{t("cws.unsavedTitle")}</h3>
        <p className="cwi-dialog-desc">{t("cws.unsavedDesc")}</p>
        <div className="cwi-modal-actions">
          <Button
            variant="text"
            data-testid="cwi-unsaved-keep"
            onClick={onKeep}
          >
            {t("cws.keepEditing")}
          </Button>
          <Button
            variant="danger"
            data-testid="cwi-unsaved-discard"
            onClick={onDiscard}
          >
            {t("common.discard")}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
