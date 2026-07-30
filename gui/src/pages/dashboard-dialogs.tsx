import { IconAlert, IconRefresh, IconX } from "../icons";
import { Select } from "../ui";
import { Empty, Toggle } from "../shell/m3-ui";
import {
  updateReasonLabel,
  type UpdateChannel,
} from "./dashboard-shared";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

/** The prototype's dialog trails its actions; `.modal-actions` still stretches
    the legacy `.btn`, so the alignment travels with the M3 buttons. */
const DIALOG_ACTIONS = { justifyContent: "flex-end" } as const;

export function DashboardDialogs(d: Dash) {
  const {
    t,
    updateOpen, closeUpdateDialog, updateDialogRef,
    updateChannel, changeUpdateChannel, updateLoading, updateError, updateCheck,
    fetchUpdateCheck, updateRestart, setUpdateRestart, runUpdate,
    maHelpOpen, setMaHelpOpen, maHelpDialogRef,
    effortCapHelpOpen, setEffortCapHelpOpen, effortCapHelpDialogRef,
    shadowCallHelpOpen, setShadowCallHelpOpen, shadowCallHelpDialogRef,
  } = d;

  return (
    <>
      <dialog
        ref={updateDialogRef}
        id="dashboard-update-dialog"
        className="modal-overlay"
        style={{ display: updateOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="update-title"
        onCancel={event => { event.preventDefault(); closeUpdateDialog(); }}
      >
        <div className="modal-card">
          <div className="modal-head">
            <h3 id="update-title">{t("dash.updateTitle")}</h3>
            <button type="button" className="m3-icon-btn" onClick={closeUpdateDialog} aria-label={t("common.cancel")}>
              <IconX />
            </button>
          </div>
          <div className="modal-desc">{t("dash.updateDesc")}</div>
          <div className="update-row">
            <label className="m3-field-label" htmlFor="update-channel">{t("dash.updateChannel")}</label>
            <Select
              value={updateChannel}
              options={[{ value: "latest", label: "latest" }, { value: "preview", label: "preview" }]}
              onChange={v => changeUpdateChannel(v as UpdateChannel)}
              disabled={updateLoading}
              label={t("dash.updateChannel")}
              portal={false}
            />
          </div>
          {updateLoading && (
            <Empty title={t("dash.updateChecking")}><span className="spin" aria-hidden="true" /></Empty>
          )}
          {updateError && (
            <div className="notice notice-err" role="status"><IconAlert /><span>{updateError}</span></div>
          )}
          {updateCheck && !updateLoading && (
            <div className="update-box">
              <div className="spread">
                <div>
                  <div className="muted text-label">{t("dash.updateInstalled")}</div>
                  <div className="mono">{updateCheck.currentVersion}</div>
                </div>
                <div>
                  <div className="muted text-label">{t("dash.updateLatest")}</div>
                  <div className="mono">{updateCheck.latestVersion ?? "—"}</div>
                </div>
                <span className={`m3-chip${updateCheck.updateAvailable ? " selected" : ""}`}>
                  {updateCheck.updateAvailable ? t("dash.updateAvailable") : t("dash.updateCurrent")}
                </span>
              </div>
              <div className="muted update-command">{t("dash.updateCommand")} <code className="m3-chip">{updateCheck.command}</code></div>
              {updateCheck.reason === "source_checkout" && (
                <div className="notice-warn" role="status"><IconAlert /> {t("dash.updateSource")}</div>
              )}
              {updateCheck.reason === "latest_unavailable" && (
                <div className="notice-warn" role="status">
                  <IconAlert /> {t("dash.updateUnavailable")}
                  <button
                    type="button"
                    className="m3-btn m3-btn--text"
                    disabled={updateLoading}
                    onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                    style={{ marginLeft: 12 }}
                  >
                    <IconRefresh /> {t("dash.updateRetry")}
                  </button>
                </div>
              )}
              {!updateCheck.canUpdate && updateCheck.reason !== "latest_unavailable" && updateCheck.reason !== "source_checkout" && (
                <div className="update-recheck">
                  <span className="muted update-recheck-reason">
                    {t("dash.updateCannotAuto", { reason: updateReasonLabel(updateCheck.reason, t) })}
                  </span>
                  <button
                    type="button"
                    className="m3-btn m3-btn--text"
                    disabled={updateLoading}
                    onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                  >
                    <IconRefresh /> {updateLoading ? t("dash.updateChecking") : t("dash.updateRecheck")}
                  </button>
                </div>
              )}
              {updateCheck.canUpdate && (
                <div className="spread update-restart">
                  <div>
                    <div className="font-semibold">{t("dash.updateRestart")}</div>
                    <div className="muted text-label">{t("dash.updateRestartHint")}</div>
                  </div>
                  <Toggle
                    on={updateRestart}
                    onChange={next => setUpdateRestart(next)}
                    label={t("dash.updateRestart")}
                  />
                </div>
              )}
            </div>
          )}
          <div className="modal-actions" style={DIALOG_ACTIONS}>
            <button type="button" className="m3-btn m3-btn--text" onClick={closeUpdateDialog}>{t("common.cancel")}</button>
            <button
              type="button"
              className="m3-btn m3-btn--filled"
              onClick={runUpdate}
              disabled={!updateCheck?.canUpdate || updateLoading}
            >
              {t("dash.runUpdate")}
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={maHelpDialogRef}
        id="multi-agent-help-dialog"
        className="modal-overlay"
        style={{ display: maHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="multi-agent-help-title"
        onCancel={event => { event.preventDefault(); setMaHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setMaHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="multi-agent-help-title">{t("dash.multiAgent")}</h3>
            <button type="button" className="m3-icon-btn" onClick={() => setMaHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("models.v2Help")}
          </div>
          <div style={{ marginTop: 12 }}>
            <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--m3-primary)" }}>
              {t("models.v2DocsLink")}
            </a>
          </div>
          <div className="modal-actions" style={DIALOG_ACTIONS}>
            <button type="button" className="m3-btn m3-btn--filled" onClick={() => setMaHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={effortCapHelpDialogRef}
        id="effort-cap-help-dialog"
        className="modal-overlay"
        style={{ display: effortCapHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="effort-cap-help-title"
        onCancel={event => { event.preventDefault(); setEffortCapHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setEffortCapHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="effort-cap-help-title">{t("dash.effortCapLabel")}</h3>
            <button type="button" className="m3-icon-btn" onClick={() => setEffortCapHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("dash.effortCapHelp")}
          </div>
          <div className="modal-actions" style={DIALOG_ACTIONS}>
            <button type="button" className="m3-btn m3-btn--filled" onClick={() => setEffortCapHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={shadowCallHelpDialogRef}
        id="shadow-call-help-dialog"
        className="modal-overlay"
        style={{ display: shadowCallHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="shadow-call-help-title"
        onCancel={event => { event.preventDefault(); setShadowCallHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setShadowCallHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="shadow-call-help-title">{t("dash.shadowCallIntercept")}</h3>
            <button type="button" className="m3-icon-btn" onClick={() => setShadowCallHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("dash.shadowCallTooltip")}
          </div>
          <div className="modal-actions" style={DIALOG_ACTIONS}>
            <button type="button" className="m3-btn m3-btn--filled" onClick={() => setShadowCallHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
