import { IconDownload, IconInfo, IconRefresh } from "../icons";
import { Select } from "../ui";
import { Button, Card, Toggle } from "../shell/m3-ui";
import { EFFORT_CAP_LEVELS, requireJson, sidecarBackendForModel } from "./dashboard-shared";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardEffortCapPanel({ apiBase, d }: { apiBase: string; d: Dash }) {
  const {
    t, maMode, maModeResolved, logSettingRevision,
    effortCapHelpTriggerRef, effortCapHelpOpen, setEffortCapHelpOpen,
    effortCap, subagentEffortCap, effortCapSaving, setEffortCap, setSubagentEffortCap, setEffortCapSaving,
  } = d;

  if (!maModeResolved || maMode === "v1") return null;

  /** Both selects write the same endpoint and both belong in the version history. */
  const commitEffortCaps = (
    data: { effortCap?: string | null; subagentEffortCap?: string | null },
    before: { effortCap: string; subagentEffortCap: string },
  ) => {
    const nextCap = data.effortCap ?? "";
    const nextSubagentCap = data.subagentEffortCap ?? "";
    setEffortCap(nextCap);
    setSubagentEffortCap(nextSubagentCap);
    if (nextCap !== before.effortCap) {
      logSettingRevision(t("dash.effortCapLabel"), nextCap, JSON.stringify(before));
    }
    if (nextSubagentCap !== before.subagentEffortCap) {
      logSettingRevision(t("dash.subagentEffortCapLabel"), nextSubagentCap, JSON.stringify(before));
    }
  };

  return (
    <Card>
      <div className="injection-head">
        <span className="injection-label dash-stat-card__label">
          {t("dash.effortCapLabel")}
          <button
            ref={effortCapHelpTriggerRef}
            type="button"
            className="dash-help-btn"
            onClick={() => setEffortCapHelpOpen(open => !open)}
            aria-label={t("dash.effortCapLabel")}
            aria-expanded={effortCapHelpOpen}
            aria-haspopup="dialog"
            aria-controls="effort-cap-help-dialog"
          >
            <IconInfo width={13} height={13} aria-hidden="true" />
          </button>
        </span>
        <Select
          value={effortCap}
          options={[
            { value: "", label: t("dash.effortCapNone") },
            ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
          ]}
          onChange={async (v) => {
            if (effortCapSaving) return;
            const before = { effortCap, subagentEffortCap };
            setEffortCapSaving(true);
            try {
              const res = await fetch(`${apiBase}/api/effort-caps`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ effortCap: v || null }),
              });
              const data = await requireJson<{ ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null }>(res);
              commitEffortCaps(data, before);
            } catch { /* ignore */ }
            finally { setEffortCapSaving(false); }
          }}
          disabled={effortCapSaving}
          label={t("dash.effortCapLabel")}
        />
        <Select
          value={subagentEffortCap}
          options={[
            { value: "", label: t("dash.effortCapNone") },
            ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
          ]}
          onChange={async (v) => {
            if (effortCapSaving) return;
            const before = { effortCap, subagentEffortCap };
            setEffortCapSaving(true);
            try {
              const res = await fetch(`${apiBase}/api/effort-caps`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subagentEffortCap: v || null }),
              });
              const data = await requireJson<{ ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null }>(res);
              commitEffortCaps(data, before);
            } catch { /* ignore */ }
            finally { setEffortCapSaving(false); }
          }}
          disabled={effortCapSaving}
          label={t("dash.subagentEffortCapLabel")}
        />
      </div>
    </Card>
  );
}

export function DashboardInjectionPanel({ d }: { apiBase: string; d: Dash }) {
  const {
    t,
    injectionModel, injectionEffort, injectionEfforts, injectionAvailable, injectionSaving,
    multiAgentGuidanceEnabled, syncCodexSubagentDefaults, saveInjection,
  } = d;

  return (
    <Card>
      <div className="injection-head">
        <span className="injection-label dash-stat-card__label">{t("dash.injectionLabel")}</span>
        <Select
          value={injectionModel}
          options={[
            { value: "", label: t("dash.injectionNone") },
            ...injectionAvailable.map(m => ({ value: m.namespaced, label: `${m.provider} / ${m.model}` })),
          ]}
          onChange={(v) => { void saveInjection({ model: v || null, effort: injectionEffort || null }); }}
          disabled={injectionSaving}
          label={t("dash.injectionLabel")}
        />
        {injectionModel && injectionEfforts.length > 0 && (
          <Select
            value={injectionEffort}
            options={[
              { value: "", label: t("dash.injectionEffortNone") },
              ...injectionEfforts.map(e => ({ value: e, label: e })),
            ]}
            onChange={(v) => { void saveInjection({ model: injectionModel || null, effort: v || null }); }}
            disabled={injectionSaving}
            label={t("dash.injectionEffortLabel")}
          />
        )}
      </div>
      <p className="dash-hint">{t("dash.injectionHint")}</p>
      <div className="dash-toggle-row dash-subagent-guidance-row">
        <div className="dash-toggle-row__copy">
          <div className="font-semibold">{t("dash.syncCodexSubagentDefaults")}</div>
          <p className="dash-hint">{t("dash.syncCodexSubagentDefaultsHint")}</p>
        </div>
        <Toggle
          on={syncCodexSubagentDefaults}
          onChange={() => { void saveInjection({ syncCodexSubagentDefaults: !syncCodexSubagentDefaults }); }}
          disabled={injectionSaving || !injectionModel}
          label={t("dash.syncCodexSubagentDefaults")}
        />
      </div>
      <div className="dash-toggle-row dash-subagent-guidance-row">
        <div className="dash-toggle-row__copy">
          <div className="font-semibold">{t("dash.multiAgentGuidance")}</div>
          <p className="dash-hint">{t("dash.multiAgentGuidanceHint")}</p>
        </div>
        <Toggle
          on={multiAgentGuidanceEnabled}
          onChange={() => { void saveInjection({ multiAgentGuidanceEnabled: !multiAgentGuidanceEnabled }); }}
          disabled={injectionSaving}
          label={t("dash.multiAgentGuidance")}
        />
      </div>
    </Card>
  );
}

export function DashboardMaintenancePanel({ d }: { d: Dash }) {
  const {
    t, runSync, syncing, updateTriggerRef, openUpdateDialog, updateLoading, updateOpen,
  } = d;

  // Sync and update outcomes leave here as snackbars (see `use-dashboard-data`):
  // a one-shot result that pushed the buttons down the card every time it landed
  // is exactly the informational message the shell's notification host is for.
  return (
    <Card title={t("dash.maintenance")} subtitle={t("dash.maintenanceHint")}>
      <div className="m3-row">
        <Button variant="filled" onClick={runSync} disabled={syncing}>
          <IconRefresh aria-hidden="true" /> {syncing ? t("dash.syncing") : t("dash.syncModels")}
        </Button>
        {/* Raw button: the update dialog's focus-return needs a real DOM ref,
            which the M3 `Button` helper does not forward. */}
        <button
          ref={updateTriggerRef}
          type="button"
          className="m3-btn m3-btn--outlined"
          onClick={openUpdateDialog}
          disabled={updateLoading}
          aria-haspopup="dialog"
          aria-controls="dashboard-update-dialog"
          aria-expanded={updateOpen}
        >
          <IconDownload aria-hidden="true" /> {t("dash.checkUpdate")}
        </button>
      </div>
    </Card>
  );
}

export function DashboardSidecarPanels({ d }: { d: Dash }) {
  const {
    t, settings, settingsSaving, toggleCodexAutoStart, settingMatches,
    sidecar, sidecarSaving, sidecarModels, models, saveSidecar,
    shadowCall, shadowCallSaving, shadowCallHelpTriggerRef, shadowCallHelpOpen, setShadowCallHelpOpen, saveShadowCall,
  } = d;
  const showWebSearch = settingMatches("webSearch");
  const showVision = settingMatches("vision");

  return (
    <>
      {settingMatches("codexAutoStart") && <Card>
        <div className="dash-toggle-row">
          <div className="dash-toggle-row__copy">
            <div className="font-semibold">{t("dash.codexAutoStart")}</div>
            <p className="dash-hint">{t("dash.codexAutoStartHint")}</p>
          </div>
          <Toggle
            on={settings?.codexAutoStart ?? true}
            onChange={() => { void toggleCodexAutoStart(); }}
            disabled={!settings || settingsSaving}
            label={t("dash.codexAutoStart")}
          />
        </div>
      </Card>}

      {(showWebSearch || showVision) && <div className="dash-sidecar-grid">
        {showWebSearch && <div className="m3-card dash-sidecar-card">
          <div className="dash-sidecar-card__row">
            <div className="font-semibold">{t("dash.webSearchSidecar")}</div>
            <Select
              value={sidecar?.webSearch.model ?? "gpt-5.6-luna"}
              options={sidecarModels}
              onChange={model => { void saveSidecar({ webSearch: { model, backend: sidecarBackendForModel(models, model) } }); }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
            />
          </div>
          <p className="dash-hint">{t("dash.webSearchSidecarHint")}</p>
        </div>}

        {showVision && <div className="m3-card dash-sidecar-card">
          <div className="dash-sidecar-card__row">
            <div className="font-semibold">{t("dash.visionSidecar")}</div>
            <Select
              value={sidecar?.vision.model ?? "gpt-5.6-luna"}
              options={sidecarModels}
              onChange={model => { void saveSidecar({ vision: { model, backend: sidecarBackendForModel(models, model) } }); }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
            />
          </div>
          <p className="dash-hint">{t("dash.visionSidecarHint")}</p>
        </div>}
      </div>}

      {settingMatches("shadowCall") && <Card>
        <div className="dash-toggle-row">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span className="font-semibold">{t("dash.shadowCallIntercept")}</span>
            <button
              ref={shadowCallHelpTriggerRef}
              type="button"
              className="dash-help-btn"
              onClick={() => setShadowCallHelpOpen(open => !open)}
              aria-label={t("dash.shadowCallIntercept")}
              aria-expanded={shadowCallHelpOpen}
              aria-haspopup="dialog"
              aria-controls="shadow-call-help-dialog"
            >
              <IconInfo width={13} height={13} aria-hidden="true" />
            </button>
            <code className="m3-chip">⚠ 5.4-mini</code>
          </div>
          <div className="setting-controls" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Toggle
              on={shadowCall?.enabled ?? false}
              onChange={() => saveShadowCall({ enabled: !shadowCall?.enabled })}
              disabled={!shadowCall || shadowCallSaving}
              label={t("dash.shadowCallIntercept")}
            />
            <Select
              value={shadowCall?.model ?? ""}
              options={[{ value: "", label: "—" }, ...models.map(m => ({ value: m.id, label: `${m.provider}/${m.id}` }))]}
              onChange={v => { void saveShadowCall({ model: v }); }}
              disabled={!shadowCall || shadowCallSaving || !shadowCall?.enabled}
              label={t("dash.shadowCallModel")}
              align="right"
            />
          </div>
        </div>
      </Card>}
    </>
  );
}
