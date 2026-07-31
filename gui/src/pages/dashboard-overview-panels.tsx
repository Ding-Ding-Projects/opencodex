import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { IconSearch } from "../icons";
import { Chip, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewPanels(props: Dash) {
  const {
    t, settingsQuery, setSettingsQuery, settingsRegex, setSettingsRegex,
    settingsError, settingsHits, settingMatches,
  } = props;

  // Maintenance closes the overview, as it does in the prototype: sync and
  // update act on everything configured above them, so they read as the last
  // step rather than an interruption in the middle of the settings stack.
  return (
    <>
      {/* Every settings surface carries its own search bar and its own anchored
          builder, bound to this field alone — it never shares state with the model
          search on the Models tab. */}
      <div>
        <div className="m3-row" role="search">
          <IconSearch width={20} height={20} aria-hidden="true" className="muted" />
          <TextInput
            value={settingsQuery}
            onChange={e => setSettingsQuery(e.target.value)}
            placeholder={t("settings.search")}
            aria-label={t("settings.search")}
            aria-invalid={!!settingsError}
            style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
          />
          <Chip selected={settingsRegex} onClick={() => setSettingsRegex(v => !v)} title={t("search.regexHint")}>
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
          <RegexBuilderButton
            value={settingsQuery}
            onApply={pattern => setSettingsQuery(pattern)}
            regex={settingsRegex}
            onRegexChange={setSettingsRegex}
            label={t("settings.openBuilder")}
          />
        </div>
        {settingsError && (
          <p role="alert" className="dash-hint" style={{ color: "var(--m3-error)" }}>
            {t("regex.invalid")}: {settingsError}
          </p>
        )}
        {!settingsError && settingsQuery.trim().length > 0 && settingsHits === 0 && (
          <p className="dash-hint" role="status">{t("settings.noMatch")}</p>
        )}
      </div>

      {settingMatches("effortCap") && <DashboardEffortCapPanel apiBase={props.apiBase} d={props} />}
      {settingMatches("injection") && <DashboardInjectionPanel apiBase={props.apiBase} d={props} />}
      <DashboardSidecarPanels d={props} />
      {settingMatches("memory") && <MemoryObservabilityCard apiBase={props.apiBase} />}
      {settingMatches("maintenance") && <DashboardMaintenancePanel d={props} />}
    </>
  );
}
