/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave.
 *
 * ## Why these render the shared `Dialog` rather than their own markup
 *
 * They used to be hand-rolled: `<div className="dialog-backdrop" onClick={onCancel}>`
 * wrapping `<div className="dialog" role="alertdialog">`. That looks complete and
 * is operable with a mouse, which is exactly why it survived — but this file
 * contained no keydown handler at all, and the only window-level Escape listener
 * in the app (`App.tsx`) closes the nav drawer and nothing else. So:
 *
 *   - **Escape did not close them.** A keyboard user who opened "Remove provider"
 *     had no way to dismiss it.
 *   - **Focus was never moved in, and never trapped.** Tab walked straight out of
 *     the dialog into the page behind the scrim.
 *   - **Focus never came back** to the button that opened it.
 *
 * A modal you can open by keyboard and cannot leave by keyboard is a trap, not a
 * dialog. `shell/m3-ui.tsx`'s `Dialog` renders a native `<dialog>` through
 * `showModal()`, which gives all three behaviours from the platform rather than
 * from hand-written listeners.
 *
 * `components/combo-workspace-dialogs.tsx` had the identical inline pattern, says
 * so in its own header, and was moved onto the shared component for these exact
 * reasons. That fix simply never reached this file.
 *
 * Scrim dismissal stays on (the `Dialog` default) for both: on each of them the
 * scrim maps to *cancel*, which is the non-destructive choice — the provider is
 * not removed, and the unsaved settings are kept by staying on the screen.
 */
import { Button, Dialog } from "../../shell/m3-ui";
import { useT } from "../../i18n/shared";

export function RemoveConfirmDialog({
  providerName, onConfirm, onCancel,
}: {
  providerName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      onClose={onCancel}
      labelledBy="pws-remove-title"
      width={420}
      title={<span id="pws-remove-title">{t("pws.removeConfirmTitle")}</span>}
      description={t("pws.removeConfirmBody", { name: providerName })}
      actions={
        <>
          <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("pws.removeConfirm")}</Button>
        </>
      }
    />
  );
}

export function UnsavedLeaveDialog({
  onSave, onDiscard, onCancel, saving = false,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const t = useT();
  return (
    <Dialog
      onClose={onCancel}
      labelledBy="pws-unsaved-title"
      width={420}
      title={<span id="pws-unsaved-title">{t("pws.unsavedLeaveTitle")}</span>}
      description={t("pws.unsavedLeaveBody")}
      actions={
        <>
          <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="text" onClick={onDiscard}>{t("pws.discardSettings")}</Button>
          <Button variant="filled" onClick={onSave} disabled={saving}>
            {saving ? t("pws.saving") : t("pws.saveSettings")}
          </Button>
        </>
      }
    />
  );
}
