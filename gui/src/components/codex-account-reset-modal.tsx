import { useRef } from "react";
import { useI18n } from "../i18n/shared";
import { IconTicket } from "../icons";
import { Dialog } from "../shell/m3-ui";
import { SuperConfirmGate } from "../shell/super-confirm";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { CodexCreditItem } from "./codex-account-pool-helpers";
import { formatCreditDate } from "./codex-account-pool-utils";

/**
 * Redeeming a reset credit spends something that cannot be earned back on the
 * spot — `codexAuth.irreversible` already said so before this gate existed —
 * so the confirm step is the destructive-action super-confirmation gate
 * rather than a single "Use Credit" button. The info step (this account's
 * available credits, when the next one expires) is unchanged and stays an
 * ordinary `Dialog`, because reading that information destroys nothing.
 */
export function CodexAccountResetModal({
  resetPopup,
  resetConfirm,
  creditDetails,
  creditDetailsLoading,
  onClose,
  onShowConfirm,
  onAuthorize,
}: {
  resetPopup: CodexAccountEntry;
  resetConfirm: boolean;
  creditDetails: { granted_at: string; expires_at: string }[] | null;
  creditDetailsLoading: boolean;
  onClose: () => void;
  onShowConfirm: () => void;
  /**
   * Runs exactly once, only when both gate keys are on and the slider has
   * reached its end. Resolves on a successful redemption; rejects (with a
   * message the gate shows inline) on anything else — the account already
   * had none left, the request raced another tab, the network dropped.
   */
  onAuthorize: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  // Kept even though the button it names is gone by the time a dismissal or a
  // completion needs it — `resetConfirm` swaps this whole component out for
  // the gate's own modal, unmounting the button along with the rest of the
  // info step. `SuperConfirmGate` no-ops a `focus()` on a ref that resolved to
  // nothing, at which point its own `Dialog` falls back to restoring focus to
  // whatever opened *that* dialog. That is the same behaviour the two-Dialog
  // version of this screen already had — Cancel on the old amber-alert step
  // could not literally refocus "Use Credit" either, because both steps only
  // ever shared one opener capture, taken when the account row's own button
  // first opened this modal.
  const useCreditRef = useRef<HTMLButtonElement>(null);

  if (resetConfirm) {
    const remaining = resetPopup.quota?.resetCredits ?? 0;
    const nextCredit = creditDetails?.[0];
    const body = [
      t("codexAuth.confirmResetDesc", { count: String(remaining) }),
      nextCredit ? t("codexAuth.confirmWhichCredit", { date: formatCreditDate(nextCredit.granted_at, locale) }) : "",
      t("codexAuth.irreversible"),
    ].filter(Boolean).join("\n\n");

    return (
      <SuperConfirmGate
        anchorRef={useCreditRef}
        presentation="modal"
        title={t("codexAuth.confirmResetTitle")}
        body={body}
        keyLabels={[
          t("codexAuth.gateKey1", { email: resetPopup.email }),
          t("codexAuth.gateKey2"),
        ]}
        sliderLabel={t("codexAuth.gateSlider")}
        workingLabel={t("codexAuth.redeeming")}
        doneLabel={t("codexAuth.resetSuccessGeneric")}
        onAuthorize={onAuthorize}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      onClose={onClose}
      labelledBy="codex-reset-title"
      title={<><IconTicket width={16} aria-hidden="true" /> <span id="codex-reset-title">{t("codexAuth.resetCreditsTitle")}</span></>}
      description={`${resetPopup.email}${resetPopup.plan ? ` · ${resetPopup.plan}` : ""}`}
    >
      {(resetPopup.quota?.resetCredits ?? 0) > 0 ? (
        <>
          <p>{t("codexAuth.resetCreditsAvailable", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
          {creditDetailsLoading && <p className="faint text-label">{t("common.loading")}</p>}
          {creditDetails && creditDetails.length > 0 && (
            <div className="credit-list">
              {creditDetails.map((c, i) => (
                <CodexCreditItem key={`${c.granted_at}:${c.expires_at}`} index={i} grantedAt={c.granted_at} expiresAt={c.expires_at} isNext={i === 0} locale={locale} t={t} />
              ))}
            </div>
          )}
          {/*
            Full-width and inside the body rather than the action area: this
            starts the confirm step, it does not resolve the dialog, and the
            FIFO note below has to stay attached to it. A native `<button>`,
            not the shared `Button` component: `Button` has no `forwardRef`, so
            a `ref` handed to it never reaches the DOM.
          */}
          <button
            ref={useCreditRef}
            type="button"
            className="m3-btn m3-btn--filled"
            style={{ width: "100%" }}
            onClick={onShowConfirm}
          >
            {t("codexAuth.useOneCredit")}
          </button>
          <p className="m3-dialog__desc text-caption" style={{ textAlign: "center" }}>{t("codexAuth.fifoNote")}</p>
        </>
      ) : (
        <>
          <p className="faint">{t("codexAuth.noResetCredits")}</p>
          <p className="m3-dialog__desc">{t("codexAuth.earnCreditsHint")}</p>
        </>
      )}
    </Dialog>
  );
}
