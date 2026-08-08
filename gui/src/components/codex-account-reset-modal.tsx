import { useI18n } from "../i18n/shared";
import { IconAlert, IconTicket } from "../icons";
import { Dialog } from "../shell/m3-ui";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { CodexCreditItem } from "./codex-account-pool-helpers";
import { formatCreditDate } from "./codex-account-pool-utils";

export function CodexAccountResetModal({
  resetPopup,
  resetConfirm,
  creditDetails,
  creditDetailsLoading,
  redeeming,
  onClose,
  onShowConfirm,
  onCancelConfirm,
  onRedeem,
}: {
  resetPopup: CodexAccountEntry;
  resetConfirm: boolean;
  creditDetails: { granted_at: string; expires_at: string }[] | null;
  creditDetailsLoading: boolean;
  redeeming: boolean;
  onClose: () => void;
  onShowConfirm: () => void;
  onCancelConfirm: () => void;
  onRedeem: () => void;
}) {
  const { locale, t } = useI18n();

  // The confirm step keeps its own centred hero — the amber alert badge above a
  // centred headline — which is why it names the dialog through `labelledBy`
  // instead of the `title` slot. Both steps keep the `codex-reset-title` id, so
  // the accessible name of the dialog is unchanged from the legacy markup.
  return resetConfirm ? (
    <Dialog
      onClose={onClose}
      labelledBy="codex-reset-title"
      actions={
        <>
          <button type="button" className="m3-btn m3-btn--text" onClick={onCancelConfirm}>{t("codexAuth.cancel")}</button>
          <button type="button" className="m3-btn m3-btn--danger" onClick={onRedeem} disabled={redeeming}>
            {redeeming ? t("codexAuth.redeeming") : t("codexAuth.useCredit")}
          </button>
        </>
      }
    >
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div className="confirm-icon"><IconAlert width={22} aria-hidden="true" /></div>
        <h3 id="codex-reset-title" className="m3-dialog__title">{t("codexAuth.confirmResetTitle")}</h3>
        <p className="m3-dialog__desc">{t("codexAuth.confirmResetDesc", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
        {creditDetails && creditDetails[0] && (
          <p className="faint text-label">
            {t("codexAuth.confirmWhichCredit", { date: formatCreditDate(creditDetails[0].granted_at, locale) })}
          </p>
        )}
        <p className="faint text-label">{t("codexAuth.irreversible")}</p>
      </div>
    </Dialog>
  ) : (
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
            FIFO note below has to stay attached to it.
          */}
          <button type="button" className="m3-btn m3-btn--filled" style={{ width: "100%" }}
            onClick={onShowConfirm} disabled={redeeming}>
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
