import { IconPlus, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { Select } from "../ui";
import { Button, Card, Empty, Segmented } from "../shell/m3-ui";
import {
  applySidecarBackendChange,
  applySidecarModelChange,
  sidecarSelectValue,
  type SidecarSelectValue,
} from "./claude-code-sidecar";
import { AutoConnectSetting, SettingRow, SettingToggle } from "./claude-code-settings";
import type { ClaudeCodeState, MapRow } from "./claude-code-types";
import { newClientId } from "./claude-code-types";
import type { TFn, TKey } from "../i18n/shared";

/**
 * Which detector proved the Claude login. Falls back to a generic label so an
 * unrecognised source id from a newer backend never renders a raw key.
 */
function authSourceLabel(source: string | undefined, t: TFn): string {
  const known = ["claude-json-oauth", "claude-credentials-file", "macos-keychain", "exported-env"];
  return source && known.includes(source)
    ? t(`claude.authSource.${source}` as TKey)
    : t("claude.authSource.unknown");
}

export function ClaudeCodeSettingsCard({
  state,
  autoCompactOptions,
  onStateChange,
}: {
  state: ClaudeCodeState;
  autoCompactOptions: { value: string; label: string }[];
  onStateChange: (next: ClaudeCodeState) => void;
}) {
  const t = useT();

  const sidecarKeys = ["webSearchSidecar", "visionSidecar"] as const;

  return (
    <Card>
      <SettingRow
        title={t("claude.enabledLabel")}
        desc={t("claude.enabledHint")}
        control={<SettingToggle label={t("claude.enabledLabel")} checked={state.enabled} onChange={enabled => onStateChange({ ...state, enabled })} />}
      />

      {/* Auth mode is a one-of-three choice, so it reads as a pill group rather than a
          dropdown. Auto stays FIRST: it is the way back out of a sticky manual mode. */}
      <SettingRow
        title={t("claude.authMode")}
        desc={t("claude.authModeHint")}
        align="flex-start"
        control={
          <Segmented<NonNullable<ClaudeCodeState["authMode"]>>
            value={state.authMode}
            options={[
              { value: "auto", label: t("claude.authModeAuto") },
              { value: "subscription", label: t("claude.authModeSubscription") },
              { value: "proxy", label: t("claude.authModeProxy") },
            ]}
            onChange={v => onStateChange({ ...state, authMode: v })}
            label={t("claude.authMode")}
          />
        }
      />

      {state.authModeOrigin && (
        <SettingRow
          title={t("claude.effectiveMode.label")}
          desc={
            <span style={state.authModeOrigin === "auto-unknown" ? { color: "var(--amber)" } : undefined}>
              {state.authModeOrigin === "manual"
                ? t("claude.effectiveMode.manual", {
                  mode: state.markerMode === "proxy" ? t("claude.authModeProxy") : t("claude.authModeSubscription"),
                })
                : state.authModeOrigin === "auto-present"
                  ? t("claude.effectiveMode.autoPresent", { source: authSourceLabel(state.authFoundBy, t) })
                  : state.authModeOrigin === "auto-absent"
                    ? t("claude.effectiveMode.autoAbsent")
                    : t("claude.effectiveMode.autoUnknown")}
              {state.admissionKeyActive === true ? ` ${t("claude.effectiveMode.admissionKey")}` : ""}
            </span>
          }
        />
      )}

      <AutoConnectSetting
        supported={state.autoConnectSupported}
        checked={state.systemEnv}
        onChange={systemEnv => onStateChange({ ...state, systemEnv })}
      />

      <SettingRow
        title={t("claude.fastMode")}
        desc={t("claude.fastModeDesc")}
        align="flex-start"
        control={
          <Segmented<"auto" | "on" | "off">
            value={state.fastMode === null ? "auto" : state.fastMode ? "on" : "off"}
            options={[
              { value: "auto", label: t("claude.fastAuto") },
              { value: "on", label: t("claude.fastOn") },
              { value: "off", label: t("claude.fastOff") },
            ]}
            onChange={v => onStateChange({ ...state, fastMode: v === "auto" ? null : v === "on" })}
            label={t("claude.fastMode")}
          />
        }
      />

      <SettingRow
        title={t("claude.autoContext")}
        desc={
          <>
            {t("claude.autoContextDesc")}
            {state.maxContextTokens !== null && <span style={{ display: "block", marginTop: "4px" }}>{t("claude.autoContextInert")}</span>}
          </>
        }
        control={<SettingToggle label={t("claude.autoContext")} checked={state.autoContext} onChange={autoContext => onStateChange({ ...state, autoContext })} />}
      />

      {state.autoContext && (
        <SettingRow
          title={t("claude.autoCompactWindow")}
          desc={
            <>
              {t("claude.autoCompactWindowDesc")}
              {state.autoCompactWindow !== null && (
                <span style={{ display: "block", marginTop: "4px", color: "var(--m3-error)" }}>{t("claude.autoCompactWindowWarn")}</span>
              )}
            </>
          }
          control={
            <Select
              value={state.autoCompactWindow === null ? "" : String(state.autoCompactWindow)}
              options={autoCompactOptions}
              onChange={v => onStateChange({ ...state, autoCompactWindow: v === "" ? null : Number(v) })}
              label={t("claude.autoCompactWindow")}
              style={{ minWidth: 130 }}
              portal
            />
          }
        />
      )}

      <SettingRow
        title={t("claude.injectAgents")}
        desc={t("claude.injectAgentsDesc")}
        control={<SettingToggle label={t("claude.injectAgents")} checked={state.injectAgents} onChange={injectAgents => onStateChange({ ...state, injectAgents })} />}
      />

      {sidecarKeys.map((key, index) => {
        const override = state[key];
        const titleKey = key === "webSearchSidecar" ? "claude.webSearchSidecar" : "claude.visionSidecar";
        const hintKey = key === "webSearchSidecar" ? "claude.webSearchSidecarHint" : "claude.visionSidecarHint";
        return (
          <SettingRow
            key={key}
            title={t(titleKey)}
            desc={t(hintKey)}
            align="flex-start"
            last={index === sidecarKeys.length - 1}
            control={
              <>
                <Select
                  value={sidecarSelectValue(override)}
                  options={[
                    { value: "inherit", label: t("claude.useMainSetting") },
                    { value: "auto", label: t("dash.backendAuto") },
                    { value: "openai", label: t("dash.backendOpenAI") },
                    { value: "anthropic", label: t("dash.backendAnthropic") },
                  ]}
                  onChange={value => {
                    // Auto may exist as an empty in-memory draft so the model input
                    // stays enabled; empty Auto serializes to null on save.
                    onStateChange({
                      ...state,
                      [key]: applySidecarBackendChange(override, value as SidecarSelectValue),
                    });
                  }}
                  label={t("dash.sidecarBackend")}
                  portal
                />
                <input
                  className="m3-input mono"
                  value={override?.model ?? ""}
                  onChange={e => {
                    onStateChange({
                      ...state,
                      [key]: applySidecarModelChange(override, e.target.value),
                    });
                  }}
                  placeholder={t("claude.sidecarModelPlaceholder")}
                  disabled={!override}
                  aria-label={t("dash.sidecarModel")}
                  style={{ width: "auto", minWidth: 210 }}
                />
              </>
            }
          />
        );
      })}
    </Card>
  );
}

export function ClaudeCodeQuickstartSection({ manualEnv }: { manualEnv: string }) {
  const t = useT();
  const snippetStyle = {
    padding: "12px 16px",
    borderRadius: "var(--r-s)",
    background: "var(--m3-surface-container-lowest)",
    border: "1px solid var(--m3-outline-variant)",
    overflowX: "auto" as const,
    fontSize: "var(--t-body-s)",
  };
  return (
    <Card title={t("claude.quickstart")} subtitle={<Trans k="claude.quickstartHint" cmd="ocx claude" />}>
      <pre className="mono" style={{ ...snippetStyle, margin: 0 }}>ocx claude</pre>
      <details style={{ margin: "12px 0 0" }}>
        <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", color: "var(--m3-primary)", fontSize: "var(--t-label-l)", fontWeight: 500 }}>
          {t("claude.manualEnv")}
        </summary>
        <pre className="mono" style={{ ...snippetStyle, margin: "8px 0 0" }}>{manualEnv}</pre>
      </details>
    </Card>
  );
}

export function ClaudeCodeModelMapSection({
  rows,
  onRowsChange,
  onSave,
}: {
  rows: MapRow[];
  onRowsChange: (rows: MapRow[]) => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <Card
      title={<>{t("claude.modelMap")} <span className="count">{rows.length}</span></>}
      subtitle={t("claude.modelMapHint")}
      actions={<Button variant="filled" onClick={onSave}>{t("common.save")}</Button>}
    >
      <div className="m3-stack">
        {rows.map((row, i) => (
          <div key={row.id} className="m3-row" style={{ gap: 10 }}>
            <input
              className="m3-input mono"
              value={row.from}
              placeholder={t("claude.mapFrom")}
              aria-label={t("claude.mapFrom")}
              onChange={e => onRowsChange(rows.map((r, j) => j === i ? { ...r, from: e.target.value } : r))}
              style={{ flex: "1 1 180px", minWidth: 0 }}
            />
            <span style={{ color: "var(--m3-on-surface-variant)" }} aria-hidden>→</span>
            <input
              className="m3-input mono"
              value={row.to}
              placeholder={t("claude.mapTo")}
              aria-label={t("claude.mapTo")}
              onChange={e => onRowsChange(rows.map((r, j) => j === i ? { ...r, to: e.target.value } : r))}
              style={{ flex: "1 1 180px", minWidth: 0 }}
            />
            {/* 44px square so the destructive icon clears the minimum hit target. */}
            <button
              type="button"
              onClick={() => onRowsChange(rows.filter((_, j) => j !== i))}
              aria-label={t("claude.removeMapping")}
              style={{ display: "grid", placeItems: "center", flex: "0 0 auto", width: 44, height: 44, border: "none", borderRadius: "999px", background: "transparent", color: "var(--m3-error)", cursor: "pointer" }}
            >
              <IconX aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <Button variant="outlined" onClick={() => onRowsChange([...rows, { id: newClientId(), from: "", to: "" }])}>
          <IconPlus aria-hidden="true" /> {t("claude.addMapping")}
        </Button>
      </div>
    </Card>
  );
}

type AliasRow = { id: string; display_name: string };

/** Sentinel bucket key for aliases whose display_name has no trailing `(provider)`. */
const ALIAS_PROVIDER_OTHER = "etc";

function groupAliasesByProvider(aliases: AliasRow[]): Array<[string, AliasRow[]]> {
  const groups = new Map<string, AliasRow[]>();
  for (const alias of aliases) {
    const match = /\(([^)]+)\)\s*$/.exec(alias.display_name);
    const provider = match ? match[1]! : ALIAS_PROVIDER_OTHER;
    const bucket = groups.get(provider);
    if (bucket) bucket.push(alias);
    else groups.set(provider, [alias]);
  }
  return Array.from(groups);
}

export function ClaudeCodeAliasesSection({ aliases }: { aliases: AliasRow[] }) {
  const t = useT();
  return (
    <Card
      title={<>{t("claude.aliases")} <span className="count">{aliases.length}</span></>}
      subtitle={t("claude.aliasesHint")}
    >
      {aliases.length === 0 ? (
        <Empty title={t("claude.none")} />
      ) : (
        <div className="m3-stack" style={{ maxHeight: 360, overflowY: "auto" }}>
          {groupAliasesByProvider(aliases).map(([provider, aliasRows]) => (
            <div key={provider}>
              <div style={{ textTransform: "uppercase", letterSpacing: "var(--tracking-wide)", margin: "6px 2px 8px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)", fontWeight: 600 }}>
                {provider === ALIAS_PROVIDER_OTHER ? t("claude.aliasProviderOther") : provider} · {aliasRows.length}
              </div>
              {/* Prototype "Available models": tonal chips, not a card per alias. */}
              <div className="m3-row" style={{ gap: 8 }}>
                {aliasRows.map(a => (
                  <span
                    key={a.id}
                    title={a.display_name}
                    style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, padding: "0 14px", borderRadius: "999px", background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)", fontSize: "var(--t-label-m)" }}
                  >
                    <code className="mono">{a.id}</code>
                    <span style={{ opacity: 0.72 }}>{a.display_name}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
