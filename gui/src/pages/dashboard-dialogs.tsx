import { IconAlert, IconRefresh, IconX } from "../icons";
import { Select } from "../ui";
import { Dialog, Empty, Toggle } from "../shell/m3-ui";
import {
  updateReasonLabel,
  type UpdateChannel,
} from "./dashboard-shared";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardDialogs(d: Dash) {
  const {
    t,
    updateOpen, closeUpdateDialog,
    updateChannel, changeUpdateChannel, updateLoading, updateError, updateCheck,
    fetchUpdateCheck, updateRestart, setUpdateRestart, runUpdate,
    maHelpOpen, setMaHelpOpen,
    effortCapHelpOpen, setEffortCapHelpOpen,
    shadowCallHelpOpen, setShadowCallHelpOpen,
  } = d;

  return (
    <>
      {/* `Dialog` owns the native <dialog>, its showModal()/close() and Escape, so
          none of these four pass a ref or an onCancel any more. The headline id
          stays on a span the caller renders: `labelledBy` keeps the dialog's
          accessible name exactly what it was before the port. */}
      <Dialog
        open={updateOpen}
        onClose={closeUpdateDialog}
        id="dashboard-update-dialog"
        title={t("dash.updateTitle")}
        headAction={
          <button type="button" className="m3-icon-btn" onClick={closeUpdateDialog} aria-label={t("common.cancel")}>
            <IconX />
          </button>
        }
        description={t("dash.updateDesc")}
        /* The channel and the restart toggle are unsaved until "Run update" runs,
           and this dialog never dismissed on a backdrop click before the port —
           it is the one here that carries input, so a stray click must not close it. */
        dismissOnScrim={false}
        actions={
          <>
            <button type="button" className="m3-btn m3-btn--text" onClick={closeUpdateDialog}>{t("common.cancel")}</button>
            <button
              type="button"
              className="m3-btn m3-btn--filled"
              onClick={runUpdate}
              disabled={!updateCheck?.canUpdate || updateLoading}
            >
              {t("dash.runUpdate")}
            </button>
          </>
        }
      >
        <div className="update-row">
          {/* A span, not a <label htmlFor>: `Select` renders a listbox button with its
              own aria-label, and nothing on this screen has ever carried the id the
              htmlFor pointed at — a dangling association names nothing. */}
          <span className="m3-field-label">{t("dash.updateChannel")}</span>
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
          <div className="dash-notice m3-row" role="status"><IconAlert width={16} height={16} aria-hidden="true" /><span>{updateError}</span></div>
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
              <div className="dash-notice dash-notice--warn m3-row" role="status"><IconAlert width={16} height={16} aria-hidden="true" /><span>{t("dash.updateSource")}</span></div>
            )}
            {updateCheck.reason === "latest_unavailable" && (
              <div className="dash-notice dash-notice--warn m3-row" role="status">
                <IconAlert width={16} height={16} aria-hidden="true" />
                <span>{t("dash.updateUnavailable")}</span>
                <button
                  type="button"
                  className="m3-btn m3-btn--text"
                  disabled={updateLoading}
                  onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                >
                  <IconRefresh aria-hidden="true" /> {t("dash.updateRetry")}
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
                  <IconRefresh aria-hidden="true" /> {updateLoading ? t("dash.updateChecking") : t("dash.updateRecheck")}
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
      </Dialog>

      {/* The three help dialogs carry no input, and each already dismissed on a
          backdrop click through its own invisible button — `dismissOnScrim`
          defaults to true, which is that same route. */}
      <Dialog
        open={maHelpOpen}
        onClose={() => setMaHelpOpen(false)}
        id="multi-agent-help-dialog"
        // Help text, not a decision: it opens because the user asked to read
        // it, so it must not inert the page it is explaining.
        modal={false}
        title={t("dash.multiAgent")}
        headAction={
          <button type="button" className="m3-icon-btn" onClick={() => setMaHelpOpen(false)} aria-label={t("common.close")}>
            <IconX />
          </button>
        }
        description={<span style={{ whiteSpace: "pre-line" }}>{t("models.v2Help")}</span>}
        actions={<button type="button" className="m3-btn m3-btn--filled" onClick={() => setMaHelpOpen(false)}>{t("common.ok")}</button>}
      >
        <div>
          <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--m3-primary)" }}>
            {t("models.v2DocsLink")}
          </a>
        </div>
      </Dialog>

      <Dialog
        open={effortCapHelpOpen}
        onClose={() => setEffortCapHelpOpen(false)}
        id="effort-cap-help-dialog"
        // Help text, not a decision: it opens because the user asked to read
        // it, so it must not inert the page it is explaining.
        modal={false}
        title={t("dash.effortCapLabel")}
        headAction={
          <button type="button" className="m3-icon-btn" onClick={() => setEffortCapHelpOpen(false)} aria-label={t("common.close")}>
            <IconX />
          </button>
        }
        description={<span style={{ whiteSpace: "pre-line" }}>{t("dash.effortCapHelp")}</span>}
        actions={<button type="button" className="m3-btn m3-btn--filled" onClick={() => setEffortCapHelpOpen(false)}>{t("common.ok")}</button>}
      />

      <Dialog
        open={shadowCallHelpOpen}
        onClose={() => setShadowCallHelpOpen(false)}
        id="shadow-call-help-dialog"
        // Help text, not a decision: it opens because the user asked to read
        // it, so it must not inert the page it is explaining.
        modal={false}
        title={t("dash.shadowCallIntercept")}
        headAction={
          <button type="button" className="m3-icon-btn" onClick={() => setShadowCallHelpOpen(false)} aria-label={t("common.close")}>
            <IconX />
          </button>
        }
        description={<span style={{ whiteSpace: "pre-line" }}>{t("dash.shadowCallTooltip")}</span>}
        actions={<button type="button" className="m3-btn m3-btn--filled" onClick={() => setShadowCallHelpOpen(false)}>{t("common.ok")}</button>}
      />
    </>
  );
}
