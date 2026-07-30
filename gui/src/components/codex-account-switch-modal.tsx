import { useCallback, useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import { chipStyle } from "./codex-account-pool-m3";

export function CodexAccountSwitchModal({
  confirm,
  mainEmail,
  accountModeState,
  switchingId,
  onCancel,
  onConfirm,
}: {
  confirm: CodexAccountEntry;
  mainEmail?: string;
  accountModeState: CodexAccountModeState | null;
  switchingId: string | null;
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
      aria-labelledby="codex-switch-title"
      onCancel={handleCancel}
     
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onCancel} />
      <div className="modal-card" onClick={e => e.stopPropagation()} role="document">
        <h3 id="codex-switch-title">{accountModeState === "direct"
          ? t("codexAuth.preparePoolTitle")
          : confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</h3>
        <p className="modal-desc">
          {accountModeState === "direct"
            ? t("codexAuth.preparePoolDesc")
            : confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
        </p>
        <div className="m3-card m3-row" style={{ margin: "var(--sp-2) 0", gap: 8 }}>
          <strong>{confirm.id === "__main__" ? (mainEmail || t("codexAuth.codexApp")) : confirm.email}</strong>
          {confirm.plan && (
            <span className="m3-chip" style={chipStyle("ok")}>{confirm.plan}</span>
          )}
        </div>
        {confirm.id !== "__main__" && (
          <div
            className="m3-row"
            style={{
              padding: "var(--sp-2)",
              borderRadius: "var(--r-m)",
              background: "var(--m3-warn-container)",
              color: "var(--m3-on-warn-container)",
            }}
          >
            <IconAlert width={14} aria-hidden="true" /> {t("codexAuth.cacheWarning")}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="m3-btn m3-btn--text" onClick={onCancel}>{t("codexAuth.cancel")}</button>
          <button type="button" className="m3-btn m3-btn--filled" disabled={Boolean(switchingId)} onClick={onConfirm}>
            {switchingId ? t("pws.accountSwitching") : t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
