import type { ReactNode } from "react";
import { Trans } from "../i18n/provider";
import { useT } from "../i18n/shared";
import { Card } from "../shell/m3-ui";
import { Select, type SelectOption } from "../ui";

/**
 * M3 settings row: label stack on the left, control on the right, hairline rule
 * between rows. `last` drops the rule so a card never ends on a dangling border.
 * Inline styles because the shared stylesheets are off-limits to a screen rewrite.
 */
export function SettingRow({
  title,
  desc,
  control,
  align = "center",
  last = false,
}: {
  title: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
  align?: "center" | "flex-start";
  last?: boolean;
}) {
  return (
    <div
      className="m3-row m3-row--split"
      style={{
        alignItems: align,
        padding: "12px 0",
        borderBottom: last ? "none" : "1px solid var(--m3-outline-variant)",
      }}
    >
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div style={{ fontSize: "var(--t-body-m)", fontWeight: 500 }}>{title}</div>
        {desc && <div style={{ marginTop: "2px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{desc}</div>}
      </div>
      {control && <div className="m3-row" style={{ flex: "0 0 auto", gap: "8px" }}>{control}</div>}
    </div>
  );
}

/**
 * The connection/feature switch. `role="switch"` + `aria-checked` is the a11y
 * contract for M3 toggles; it replaces the legacy checkbox-in-a-label, but keeps
 * the same `aria-label` / `aria-describedby` wiring the callers rely on.
 */
export function SettingToggle({
  label,
  checked,
  onChange,
  disabled = false,
  describedBy,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`m3-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="m3-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function AutoConnectSetting({
  supported,
  checked,
  onChange,
}: {
  supported: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useT();
  const unsupportedDescriptionId = supported ? undefined : "claude-system-env-unsupported";

  return (
    <SettingRow
      title={t("claude.systemEnv")}
      desc={
        <>
          {supported ? (
            <span>{t("claude.systemEnvDesc")}</span>
          ) : (
            <span id={unsupportedDescriptionId}>
              <Trans k="claude.systemEnvUnsupported" cmd="ocx claude" />
            </span>
          )}
          {supported && checked && (
            <span style={{ display: "block", marginTop: "4px", color: "var(--m3-error)" }}>
              {t("claude.systemEnvWarn")}
            </span>
          )}
        </>
      }
      control={
        <SettingToggle
          label={t("claude.systemEnv")}
          checked={supported && checked}
          disabled={!supported}
          describedBy={unsupportedDescriptionId}
          onChange={onChange}
        />
      }
    />
  );
}

export function SmallFastModelSetting({
  value,
  tierHaikuModel,
  options,
  onChange,
}: {
  value: string;
  tierHaikuModel?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const effectiveHelperModel = tierHaikuModel ?? value;
  return (
    <Card title={t("claude.smallFastModel")} subtitle={t("claude.smallFastModelAccurateHint")}>
      <Select
        value={value}
        options={options}
        onChange={onChange}
        label={t("claude.smallFastModel")}
        style={{ maxWidth: 420 }}
      />
      {effectiveHelperModel === "" && (
        <p
          className="notice-warn"
          role="status"
          style={{
            margin: "12px 0 0",
            padding: "10px 14px",
            borderRadius: "var(--r-s)",
            background: "var(--amber-soft)",
            color: "var(--text)",
            fontSize: "var(--t-body-s)",
          }}
        >
          {t("claude.smallFastModelNativeWarning")}
        </p>
      )}
    </Card>
  );
}
