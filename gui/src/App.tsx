import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { setClientResourceData, useKeyedClientResource } from "./client-resource";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Combos from "./pages/Combos";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Usage from "./pages/Usage";
import Storage from "./pages/Storage";
import CodexAuth from "./pages/CodexAuth";
import ApiKeys from "./pages/ApiKeys";
import Claude from "./pages/Claude";
import Grok from "./pages/Grok";
import Startup from "./pages/Startup";
import Appearance from "./pages/Appearance";
import LanguageVoice from "./pages/LanguageVoice";
import RegexBuilder from "./pages/RegexBuilder";
import Changelog from "./pages/Changelog";
import VersionHistory from "./pages/VersionHistory";
import NotificationsPage from "./pages/Notifications";
import Network from "./pages/Network";
import SettingsPage from "./pages/Settings";
import OnboardingWizard from "./shell/OnboardingWizard";
import ErrorBoundary from "./components/ErrorBoundary";
import { useT } from "./i18n/shared";
import { installApiAuthFetch } from "./api";
import { type Page } from "./app-routing";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { usePrefs } from "./theme/prefs-context";
import { useNotifications } from "./shell/notifications-context";
import { useTabs } from "./shell/use-tabs";
import AdaptiveNav, { BottomNav } from "./shell/AdaptiveNav";
import AppBar from "./shell/AppBar";
import TabStrip from "./shell/TabStrip";
import SnackbarHost from "./shell/SnackbarHost";
import DimSumCard from "./shell/DimSumCard";
import { PAGE_META_BY_ID } from "./shell/page-meta";
import { readJsonIfOk } from "./fetch-json";

installApiAuthFetch();

const API_BASE = import.meta.env.VITE_API_BASE || "";

interface Health {
  version: string | null;
  port: number | null;
  uptime: number | null;
}

function readHealth(data: unknown): Health {
  if (!data || typeof data !== "object") return { version: null, port: null, uptime: null };
  const d = data as Record<string, unknown>;
  return {
    version: typeof d.version === "string" && d.version ? d.version : null,
    port: typeof d.port === "number" ? d.port : null,
    uptime: typeof d.uptime === "number" ? d.uptime : null,
  };
}

/** Pages that need the full width; everything else is centred at 1180px. */
const WIDE_PAGES = new Set<Page>(["combos", "providers", "models", "logs"]);


/** One mounted instance per open tab; the switch keeps each page's JSX greppable. */
function renderPage(page: Page): ReactNode {
  switch (page) {
    case "dashboard": return <Dashboard apiBase={API_BASE} />;
    case "startup": return <Startup apiBase={API_BASE} />;
    case "providers": return <Providers apiBase={API_BASE} />;
    case "models": return <Models apiBase={API_BASE} />;
    case "combos": return <Combos apiBase={API_BASE} />;
    case "subagents": return <Subagents apiBase={API_BASE} />;
    case "logs": return <Logs apiBase={API_BASE} />;
    case "usage": return <Usage apiBase={API_BASE} />;
    case "storage": return <Storage apiBase={API_BASE} />;
    case "codex-auth": return <CodexAuth apiBase={API_BASE} />;
    case "api": return <ApiKeys apiBase={API_BASE} />;
    case "claude": return <Claude apiBase={API_BASE} />;
    case "grok": return <Grok apiBase={API_BASE} />;
    case "appearance": return <Appearance />;
    case "language": return <LanguageVoice />;
    case "regex": return <RegexBuilder />;
    case "changelog": return <Changelog apiBase={API_BASE} />;
    case "history": return <VersionHistory />;
    case "notifications": return <NotificationsPage />;
    case "network": return <Network apiBase={API_BASE} />;
    case "settings": return <SettingsPage apiBase={API_BASE} />;
  }
}

export default function App() {
  const { page, setPageState, navigateToPage } = useAppRouteState();
  const { windowClass } = usePrefs();
  const { notify } = useNotifications();
  const t = useT();

  // The tab strip owns navigation; the hash router stays the source of truth for deep links.
  const tabs = useTabs(page, navigateToPage);
  // Held rather than derived so growing past the compact breakpoint closes the
  // drawer without an effect that would cascade a second render.
  const [drawerRequested, setDrawerRequested] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Hash changes from outside the strip (back/forward, a pasted link) retarget the active tab.
  useEffect(() => { tabs.setActivePage(page); }, [page, tabs]);
  // Keep the legacy route state in step so `hashBelongsToPage` normalisation stays correct.
  useEffect(() => { setPageState(tabs.activePage); }, [tabs.activePage, setPageState]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerRequested(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const compact = windowClass === "compact";
  const drawerOpen = compact && drawerRequested;

  const healthPoll = useKeyedClientResource(
    `app-healthz:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/healthz`, { signal });
      if (!res.ok) return null;
      return readHealth(await res.json());
    },
    { pollMs: 30_000 },
  );

  const health = healthPoll.data;
  const displayedVersion = health?.version ?? __APP_VERSION__;

  // The Claude nav row owns the connection toggle, as it did in the old sidebar.
  const fetchClaudeEnabled = useCallback(async (signal: AbortSignal) => {
    const res = await fetch(`${API_BASE}/api/claude-code`, { signal });
    const d = await readJsonIfOk<{ enabled?: unknown }>(res);
    return d && typeof d.enabled === "boolean" ? d.enabled : null;
  }, []);

  const claudePoll = useKeyedClientResource(`app-claude-code:${API_BASE}`, [], fetchClaudeEnabled);
  const claudeEnabled = claudePoll.data ?? null;
  // A ref, not state: the guard has to hold within a single click burst, before
  // React has re-rendered with the pending flag.
  const claudeToggleInFlight = useRef(false);
  const [claudeTogglePending, setClaudeTogglePending] = useState(false);

  const toggleClaude = async () => {
    if (claudeEnabled === null || claudeToggleInFlight.current) return;
    claudeToggleInFlight.current = true;
    setClaudeTogglePending(true);
    const next = !claudeEnabled;
    setClientResourceData(`app-claude-code:${API_BASE}`, next);
    try {
      const res = await fetch(`${API_BASE}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) setClientResourceData(`app-claude-code:${API_BASE}`, !next);
    } catch {
      setClientResourceData(`app-claude-code:${API_BASE}`, !next);
    } finally {
      claudeToggleInFlight.current = false;
      setClaudeTogglePending(false);
    }
  };

  const openPage = useCallback((next: Page, newTab: boolean) => {
    tabs.openPage(next, newTab);
    setDrawerRequested(false);
  }, [tabs]);

  const handleStop = async () => {
    // A stop is a decision, so it keeps a blocking confirm rather than a snackbar.
    if (!confirm(t("dash.stopConfirm"))) return;
    setStopping(true);
    const outcome = await requestProxyStop(API_BASE, {
      formatFailure: status => t("dash.stopFailed", { status: String(status) }),
    });
    if (!outcome.accepted) {
      setStopping(false);
      notify({ tone: "error", title: t("dash.stopFailedTitle"), body: outcome.message });
    }
  };

  const activePage = tabs.activePage;
  const title = t(PAGE_META_BY_ID[activePage].tkey);
  const statusLine = health?.port
    ? `v${displayedVersion} · :${health.port}`
    : `v${displayedVersion}`;

  return (
    <div className={`m3-app${compact ? " m3-app--compact" : ""}`}>
      <AdaptiveNav
        activePage={activePage}
        onOpen={openPage}
        version={displayedVersion}
        port={health?.port != null ? String(health.port) : null}
        onStop={() => void handleStop()}
        stopping={stopping}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerRequested(false)}
        claudeEnabled={claudeEnabled}
        claudeTogglePending={claudeTogglePending}
        onToggleClaude={() => void toggleClaude()}
      />

      <div className="m3-main-col">
        <AppBar
          apiBase={API_BASE}
          title={title}
          statusLine={statusLine}
          onOpenDrawer={() => setDrawerRequested(true)}
          drawerOpen={drawerOpen}
          onOpen={openPage}
        />
        <TabStrip tabs={tabs} />

        <main className="m3-page">
          {/*
            Keep-alive tabs: every open tab's page stays mounted and hidden
            rather than being torn down on switch. Remounting heavy pages on
            every tab change caused visible stutter, and browser-style tabs
            promise preserved state anyway. Shared client-resource keys mean
            hidden duplicates share fetches instead of stacking polls.
          */}
          {tabs.tabs.map(tab => (
            <div
              key={tab.id}
              className={`m3-page-inner${WIDE_PAGES.has(tab.page) ? " m3-page-inner--wide" : ""}`}
              hidden={tab.id !== tabs.activeTab}
            >
              <ErrorBoundary
                key={`${tab.id}:${tab.page}`}
                pageName={t(PAGE_META_BY_ID[tab.page].tkey)}
                title={t("errorBoundary.title")}
                message={t("errorBoundary.message")}
                detailsLabel={t("errorBoundary.details")}
                reloadLabel={t("errorBoundary.reload")}
              >
                {renderPage(tab.page)}
              </ErrorBoundary>
            </div>
          ))}
        </main>

        {compact && <BottomNav activePage={activePage} onOpen={openPage} />}
      </div>

      <SnackbarHost />
      <DimSumCard version={displayedVersion} />
      {/* Decides for itself whether this is a first run; renders nothing otherwise. */}
      <OnboardingWizard apiBase={API_BASE} />
    </div>
  );
}
