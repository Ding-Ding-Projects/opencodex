import type { ReactNode } from "react";
import { Trans } from "../i18n/provider";
import { useT } from "../i18n/shared";
import { IconSearch } from "../icons";
import { Card, Chip, SelectField, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { claudeSettingLabels } from "./claude-settings-search";
import type { ClaudeSettingsSearch } from "./claude-settings-search";

/**
 * The settings-search row the prototype puts at the top of the Claude Code tab, and
 * that every settings surface owes its user: plain-text search by default, an
 * explicit `.*` opt-in, and the full builder one click away — anchored to this field
 * rather than hidden behind a menu. The status line under it reports a cross-tab hit
 * by name, so a miss here can still say where the setting actually lives.
 */
export function ClaudeSettingsSearchRow({
  query,
  onQuery,
  regexOn,
  onRegex,
  search,
}: {
  query: string;
  onQuery: (next: string) => void;
  regexOn: boolean;
  onRegex: (next: boolean) => void;
  search: ClaudeSettingsSearch;
}) {
  const t = useT();
  const note = search.error
    ? `${t("regex.invalid")}: ${search.error}`
    : search.otherHits > 0
      ? t("settings.otherTab", { count: search.otherHits, tabs: search.otherTabs.join(", ") })
      : search.active && search.hits === 0
        ? t("settings.noMatch")
        : "";
  return (
    <>
      <div className="m3-row" role="search" style={{ gap: 8, marginBottom: 8 }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={query}
          onChange={e => onQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={search.error !== null}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 420 }}
        />
        {/* Plain text stays the default; `.*` is the explicit opt-in every search bar carries. */}
        <Chip selected={regexOn} onClick={() => onRegex(!regexOn)} title={t("regex.regexMode")} aria-label={t("regex.regexMode")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          onApply={pattern => onQuery(pattern)}
          regex={regexOn}
          onRegexChange={onRegex}
          // The names of the settings this tab owns, so a pattern is tried against
          // the same words the row above filters on.
          sample={claudeSettingLabels(t).map(row => row.label).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <p
        role={search.error ? "alert" : "status"}
        style={{
          minHeight: 20,
          margin: "0 0 16px",
          color: search.error ? "var(--m3-error)" : "var(--m3-on-surface-variant)",
          fontSize: "var(--t-label-m)",
        }}
      >
        {note}
      </p>
    </>
  );
}

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
  last = false,
}: {
  supported: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  const t = useT();
  const unsupportedDescriptionId = supported ? undefined : "claude-system-env-unsupported";

  return (
    <SettingRow
      title={t("claude.systemEnv")}
      last={last}
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
  /**
   * Plain-text labels: the native `<option>` this feeds cannot hold markup, so
   * an icon-decorated model name would be dropped on the floor by the browser
   * rather than rendered.
   */
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const effectiveHelperModel = tierHaikuModel ?? value;
  return (
    <Card title={t("claude.smallFastModel")} subtitle={t("claude.smallFastModelAccurateHint")}>
      <SelectField
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
            background: "var(--m3-warn-container)",
            color: "var(--m3-on-warn-container)",
            fontSize: "var(--t-body-s)",
          }}
        >
          {t("claude.smallFastModelNativeWarning")}
        </p>
      )}
    </Card>
  );
}
