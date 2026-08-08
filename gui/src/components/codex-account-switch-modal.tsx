import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import { Dialog } from "../shell/m3-ui";
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

  return (
    <Dialog
      onClose={onCancel}
      // The headline carries the id so `aria-labelledby` keeps naming the exact
      // same text it did before the M3 migration.
      labelledBy="codex-switch-title"
      title={<span id="codex-switch-title">{accountModeState === "direct"
        ? t("codexAuth.preparePoolTitle")
        : confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</span>}
      description={accountModeState === "direct"
        ? t("codexAuth.preparePoolDesc")
        : confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
      actions={
        <>
          <button type="button" className="m3-btn m3-btn--text" onClick={onCancel}>{t("codexAuth.cancel")}</button>
          <button type="button" className="m3-btn m3-btn--filled" disabled={Boolean(switchingId)} onClick={onConfirm}>
            {switchingId ? t("pws.accountSwitching") : t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext")}
          </button>
        </>
      }
    >
      <div className="m3-card m3-row" style={{ gap: 8 }}>
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
    </Dialog>
  );
}
