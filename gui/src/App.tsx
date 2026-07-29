import { useCallback, useEffect, useState } from "react";
import { useKeyedClientResource } from "./client-resource";
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

  const accountPoll = useKeyedClientResource(
    `app-codex-account:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/api/codex/auth`, { signal });
      const d = await readJsonIfOk<{ email?: unknown; account?: { email?: unknown } }>(res);
      const email = d?.email ?? d?.account?.email;
      return typeof email === "string" && email ? email : null;
    },
    { pollMs: 60_000 },
  );

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
      />

      <div className="m3-main-col">
        <AppBar
          title={title}
          statusLine={statusLine}
          accountEmail={accountPoll.data ?? null}
          onOpenDrawer={() => setDrawerRequested(true)}
          drawerOpen={drawerOpen}
          onOpen={openPage}
        />
        <TabStrip tabs={tabs} />

        <main className="m3-page">
          <div className={`m3-page-inner${WIDE_PAGES.has(activePage) ? " m3-page-inner--wide" : ""}`}>
            <ErrorBoundary
              key={activePage}
              pageName={title}
              title={t("errorBoundary.title")}
              message={t("errorBoundary.message")}
              detailsLabel={t("errorBoundary.details")}
              reloadLabel={t("errorBoundary.reload")}
            >
              {activePage === "dashboard" && <Dashboard apiBase={API_BASE} />}
              {activePage === "startup" && <Startup apiBase={API_BASE} />}
              {activePage === "providers" && <Providers apiBase={API_BASE} />}
              {activePage === "models" && <Models apiBase={API_BASE} />}
              {activePage === "combos" && <Combos apiBase={API_BASE} />}
              {activePage === "subagents" && <Subagents apiBase={API_BASE} />}
              {activePage === "logs" && <Logs apiBase={API_BASE} />}
              {activePage === "usage" && <Usage apiBase={API_BASE} />}
              {activePage === "storage" && <Storage apiBase={API_BASE} />}
              {activePage === "codex-auth" && <CodexAuth apiBase={API_BASE} />}
              {activePage === "api" && <ApiKeys apiBase={API_BASE} />}
              {activePage === "claude" && <Claude apiBase={API_BASE} />}
              {activePage === "grok" && <Grok apiBase={API_BASE} />}
              {activePage === "appearance" && <Appearance />}
              {activePage === "language" && <LanguageVoice />}
              {activePage === "regex" && <RegexBuilder />}
              {activePage === "changelog" && <Changelog apiBase={API_BASE} />}
              {activePage === "history" && <VersionHistory />}
              {activePage === "notifications" && <NotificationsPage />}
            </ErrorBoundary>
          </div>
        </main>

        {compact && <BottomNav activePage={activePage} onOpen={openPage} />}
      </div>

      <SnackbarHost />
    </div>
  );
}
