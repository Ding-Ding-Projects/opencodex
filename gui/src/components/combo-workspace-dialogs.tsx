/**
 * Confirmation dialogs for the combo workspace. Both are Material 3 `Dialog`s:
 * the `showModal()` effect, the dialog ref, the `onCancel` (Escape) handler and
 * the backdrop-dismiss button each component used to repeat inline now live in
 * `Dialog` itself.
 *
 * Both render their own `<h*>` id so `aria-labelledby` keeps pointing at the
 * headline text, which is also what the workspace tests assert on.
 */
import { useT } from "../i18n/shared";
import { Button, Dialog } from "../shell/m3-ui";

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

  return (
    <Dialog
      onClose={onCancel}
      labelledBy="cwi-remove-title"
      width={420}
      title={<span id="cwi-remove-title">{t("cws.removeConfirmTitle", { model })}</span>}
      description={t("cws.removeConfirmDesc")}
      actions={
        <>
          <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("common.remove")}</Button>
        </>
      }
    />
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

  return (
    // Scrim dismissal stays on: this dialog holds no input of its own, and every
    // casual dismissal route (scrim, Escape) lands on `onKeep`, which is the
    // non-destructive branch that leaves the edits alone.
    <Dialog
      onClose={onKeep}
      labelledBy="cwi-unsaved-title"
      width={420}
      title={<span id="cwi-unsaved-title">{t("cws.unsavedTitle")}</span>}
      description={t("cws.unsavedDesc")}
      actions={
        <>
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
        </>
      }
    />
  );
}
