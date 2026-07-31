import { type ReactNode } from "react";
import { IconAlert } from "../icons";
import LaunchCard from "../components/LaunchCard";
import { StartProxyButton } from "../components/StartProxyButton";
import { Trans } from "../i18n/provider";
import { navigateHash } from "../hash-routing";
import { DashboardDialogs } from "./dashboard-dialogs";
import { DashboardModelsSection } from "./dashboard-models-section";
import { DashboardOverviewSection } from "./dashboard-overview-section";
import { DashboardProvidersSection } from "./dashboard-providers-section";
import {
  dashboardHashForSection,
  type DashboardSection,
} from "./dashboard-shared";
import { useDashboardData } from "./use-dashboard-data";

/** The lead paragraph names the screen's landmark; both ends must agree on the id. */
const DASHBOARD_LEAD_ID = "dashboard-lead";

function selectDashboardTab(next: DashboardSection) {
  // Deliberate navigation: push a history entry so Back/Forward restore the tab.
  navigateHash(dashboardHashForSection(next));
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const d = useDashboardData(apiBase);
  const {
    t, error, selectedSection,
    providers, models, modelsLoading, modelQuery, setModelQuery,
    modelRegex, setModelRegex, modelRegexError,
    filteredGroups, expandedProviders, setExpandedProviders,
  } = d;

  if (error) {
    return (
      <div className="dash-banner" role="alert">
        <IconAlert aria-hidden="true" />
        <div>
          <div className="dash-banner__title">{t("dash.cannotConnect")}</div>
          {/* The command stays visible even beside the button: in a browser the
              button renders nothing, and if starting fails the command is the
              fallback that has to still be there. */}
          <div className="dash-banner__body"><Trans k="dash.runStart" cmd="ocx start" /></div>
          <div className="dash-banner__actions">
            {/* A reload rather than a refetch: every poll on this screen failed
                while the proxy was down, and the hook has no way to restart them
                individually. It is also what `use-dashboard-data` already does
                after an update lands, so the two recovery paths behave alike. */}
            <StartProxyButton onStarted={() => window.location.reload()} />
          </div>
        </div>
      </div>
    );
  }

  const overviewSection = <DashboardOverviewSection {...d} />;
  const providersSection = <DashboardProvidersSection t={t} providers={providers} />;
  const modelsSection = (
    <DashboardModelsSection
      t={t}
      models={models}
      modelsLoading={modelsLoading}
      modelQuery={modelQuery}
      setModelQuery={setModelQuery}
      modelRegex={modelRegex}
      setModelRegex={setModelRegex}
      modelRegexError={modelRegexError}
      filteredGroups={filteredGroups}
      expandedProviders={expandedProviders}
      setExpandedProviders={setExpandedProviders}
    />
  );
  const updateDialog = <DashboardDialogs {...d} />;

  const sections: { id: DashboardSection; label: string; body: ReactNode }[] = [
    { id: "overview", label: t("dash.workspace.overview"), body: overviewSection },
    { id: "providers", label: t("dash.activeProviders"), body: providersSection },
    { id: "models", label: t("dash.availableModels"), body: modelsSection },
  ];
  const selected = sections.find(s => s.id === selectedSection) ?? sections[0];
  const selectTab = selectDashboardTab;
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const index = sections.findIndex(s => s.id === selectedSection);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % sections.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + sections.length) % sections.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = sections.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = sections[next]!;
    selectTab(target.id);
    document.getElementById(`dashboard-tab-${target.id}`)?.focus();
  };

  return (
    // The prototype wraps each screen in a section named by its lead paragraph, so the
    // screen is one labelled landmark a screen reader can jump to and announce, rather
    // than an anonymous div whose only name is the nav item that opened it.
    <section className="dashboard-workspace-shell" aria-labelledby={DASHBOARD_LEAD_ID}>
      {/* The prototype leads every screen with body-large copy at a 74ch measure. */}
      <p id={DASHBOARD_LEAD_ID} className="m3-page-lead dash-subtitle">{t("dash.subtitle")}</p>
      {/* Above the section tabs on purpose: launching an agent is a one-press action
          from the landing screen, not something to navigate to. */}
      <LaunchCard apiBase={apiBase} />
      <div className="dash-tabs" role="tablist" aria-label={t("dash.workspace.sections")}>
        {sections.map(s => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`dashboard-tab-${s.id}`}
            aria-selected={selectedSection === s.id}
            aria-controls={`dashboard-panel-${s.id}`}
            tabIndex={selectedSection === s.id ? 0 : -1}
            className={`dash-tab${selectedSection === s.id ? " dash-tab--active" : ""}`}
            onClick={() => selectTab(s.id)}
            onKeyDown={onTabKeyDown}
          >
            {s.label}
          </button>
        ))}
      </div>
      <section
        className="dashboard-workspace-main"
        role="tabpanel"
        id={`dashboard-panel-${selected.id}`}
        aria-labelledby={`dashboard-tab-${selected.id}`}
        tabIndex={0}
      >
        {selected.body}
      </section>
      {updateDialog}
    </section>
  );
}
