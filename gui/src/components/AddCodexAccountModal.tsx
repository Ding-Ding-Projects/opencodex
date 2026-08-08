import { useEffect, useReducer } from "react";
import { useT } from "../i18n/shared";
import { Dialog } from "../shell/m3-ui";
import {
  addCodexAccountUiReducer,
  initialAddCodexAccountUiState,
} from "./add-codex-account-reducer";
import { AddCodexAccountPickStep } from "./add-codex-account-pick-step";
import { AddCodexAccountWaitingStep } from "./add-codex-account-waiting-step";
import { useAddCodexAccountOAuth } from "./use-add-codex-account-oauth";

/**
 * Both steps render their own visible heading, so the dialog's accessible name
 * cannot come from them — `Dialog` names itself by id only. This carries the
 * exact string the removed `aria-label` did, from an element that is in the
 * accessibility tree but not on screen.
 */
const DIALOG_LABEL_ID = "add-codex-account-dialog-title";

export default function AddCodexAccountModal({
  apiBase, onClose, onAdded, reauthAccountId,
}: {
  apiBase: string;
  onClose: () => void;
  onAdded: () => void;
  reauthAccountId?: string;
}) {
  const t = useT();
  const [ui, dispatch] = useReducer(addCodexAccountUiReducer, reauthAccountId, initialAddCodexAccountUiState);

  const oauth = useAddCodexAccountOAuth({ apiBase, reauthAccountId, ui, dispatch, t });
  const { manualCodeBusy, manualCodeWaiting, bindCallbacks, closeModal, startOAuth, submitManualCode } = oauth;

  useEffect(() => {
    bindCallbacks(onAdded, onClose);
  }, [bindCallbacks, onAdded, onClose]);

  const dialogLabel = reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.addTitle");

  return (
    <Dialog
      onClose={closeModal}
      labelledBy={DIALOG_LABEL_ID}
      width={440}
      // Never dismissed by the scrim: the legacy `<dialog>` had no scrim click
      // handler at all, and both steps hold typed input — the account id, and
      // the pasted redirect URL — that a stray click must not discard.
      dismissOnScrim={false}
    >
      <span id={DIALOG_LABEL_ID} className="m3-visually-hidden">{dialogLabel}</span>
      {ui.step === "pick" && (
        <AddCodexAccountPickStep
          id={ui.id}
          error={ui.error}
          onIdChange={value => dispatch({ type: "set-id", id: value })}
          onStartOAuth={() => { void startOAuth(ui.id); }}
          onClose={closeModal}
        />
      )}
      {ui.step === "oauth-waiting" && (
        <AddCodexAccountWaitingStep
          reauthAccountId={reauthAccountId}
          authUrl={ui.authUrl}
          manualCode={ui.manualCode}
          manualCodeBusy={manualCodeBusy}
          manualCodeWaiting={manualCodeWaiting}
          statusNotice={ui.statusNotice}
          statusTone={ui.statusTone}
          flowId={ui.flowId}
          error={ui.error}
          onManualCodeChange={value => dispatch({ type: "set-manual-code", manualCode: value })}
          onSubmitManualCode={() => { void submitManualCode(); }}
          onClose={closeModal}
        />
      )}
    </Dialog>
  );
}
