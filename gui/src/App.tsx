import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { setClientResourceData, useKeyedClientResource } from "./client-resource";
import Dashboard from "./pages/Dashboard";
import Terminal from "./pages/Terminal";
import MobileRemote from "./pages/Mobile";
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
import ScheduledSettings from "./pages/ScheduledSettings";
import ScheduleNotificationBridge from "./scheduling/ScheduleNotificationBridge";
import RegexBuilder from "./pages/RegexBuilder";
import Changelog from "./pages/Changelog";
import Docs from "./pages/Docs";
import VersionHistory from "./pages/VersionHistory";
import NotificationsPage from "./pages/Notifications";
import Network from "./pages/Network";
import Authenticator from "./pages/Authenticator";
import SettingsPage from "./pages/Settings";
import LocksPage from "./pages/Locks";
import PdfTools from "./pages/PdfTools";
import Converter from "./pages/Converter";
import OnboardingWizard from "./shell/OnboardingWizard";
import ErrorBoundary from "./components/ErrorBoundary";
import RemoteConnectionDialog from "./components/RemoteConnectionDialog";
import { useT } from "./i18n/shared";
import { installApiAuthFetch } from "./api";
import type { Page } from "./app-routing";
import { openRemoteDashboard } from "./remote-navigation";
import { requestProxyStop } from "./stop-proxy";
import { usePrefs } from "./theme/prefs-context";
import { useAppLogoFaviconSync } from "./theme/use-app-logo";
import { useAppDisplayName } from "./theme/use-app-name";
import { SettingsDraftProvider } from "./settings-drafts";
import { LanguageProvider } from "./i18n/provider";
import { PrefsProvider } from "./theme/prefs";
import { NotificationsProvider } from "./shell/notifications";
import { ConfirmProvider } from "./shell/confirm";
import { useNotifications } from "./shell/notifications-context";
import { useConfirm } from "./shell/confirm-context";
import { useTabRouting } from "./shell/use-tab-routing";
import { setNotificationSourcePage } from "./shell/notification-source";
import { codenameLabel, fullBuildLabel, readBuildInfo, shortBuildLabel, windowTitle } from "./shell/build-info";
import AdaptiveNav, { BottomNav } from "./shell/AdaptiveNav";
import AppBar from "./shell/AppBar";
import CommandPalette from "./shell/CommandPalette";
import ElementAppearanceHost from "./shell/ElementAppearanceHost";
import TabStrip from "./shell/TabStrip";
import SnackbarHost from "./shell/SnackbarHost";
import DimSumCard from "./shell/DimSumCard";
import { PAGE_META_BY_ID } from "./shell/page-meta";
import { readJsonIfOk } from "./fetch-json";
import { applyLockedOnLaunch } from "./shell/locks"
import { configureSchoolModeApiBase, startSchoolModeSync, stopSchoolModeSync } from "./school-mode/client";

installApiAuthFetch();

const API_BASE = import.meta.env.VITE_API_BASE || "";
// School Mode's store polls `/api/school-mode` on its own — see
// `school-mode/client.ts` — and needs to know where "own server" is before
// its first poll fires, exactly like `configureNarrator`'s `apiBase`.
//
// Recording the base is safe at module scope; **starting the poll is not**.
// This module is imported by well over a hundred test files, and a timer
// started at import time is one no test can clean up: it survives every
// teardown, fires into a later file's mocked `fetch`, and shows up there as a
// stray probe that file never made. That is precisely how the onboarding
// wizard's "does not probe" assertion started failing in the suite while
// passing alone. The interval belongs to a mounted app, so it starts in an
// effect and is torn down with it.
configureSchoolModeApiBase(API_BASE);

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
const WIDE_PAGES = new Set<Page>(["combos", "providers", "models", "logs", "docs", "authenticator"]);


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
    case "schedule": return <ScheduledSettings apiBase={API_BASE} />;
    case "regex": return <RegexBuilder />;
    case "changelog": return <Changelog apiBase={API_BASE} />;
    case "docs": return <Docs />;
    case "history": return <VersionHistory />;
    case "notifications": return <NotificationsPage />;
    case "network": return <Network apiBase={API_BASE} />;
    case "locks": return <LocksPage />
    case "authenticator": return <Authenticator apiBase={API_BASE} />;
    case "settings": return <SettingsPage apiBase={API_BASE} />;
    case "terminal": return <Terminal apiBase={API_BASE} />;
    case "pdf": return <PdfTools apiBase={API_BASE} />;
    case "converter": return <Converter apiBase={API_BASE} />;
    case "mobile": return <MobileRemote apiBase={API_BASE} />;
  }
}

export default function App() {
  return (
    <SettingsDraftProvider>
      <LanguageProvider>
        <PrefsProvider>
          <NotificationsProvider>
            <ConfirmProvider>
              <AppShell />
            </ConfirmProvider>
          </NotificationsProvider>
        </PrefsProvider>
      </LanguageProvider>
    </SettingsDraftProvider>
  );
}

/** Allows direct component tests to retain the same provider stack as main.tsx. */
function AppShell() {
  const { windowClass } = usePrefs();
  const { notify } = useNotifications();
  // Shadows the global `confirm` deliberately: an accidental native call in this
  // file is now a type error rather than a grey Windows box at runtime.
  const confirm = useConfirm();
  const t = useT();
  // Keeps the document's browser-tab favicon in step with the active app
  // logo — the one piece of chrome the nav rail's own `<img>` cannot reach,
  // since it lives in `<head>` rather than in this component tree. Mounted
  // once, here, rather than in every screen that happens to render.
  useAppLogoFaviconSync();
  // The name the app calls itself, for the OS window title below.
  const appName = useAppDisplayName();

  // The tab strip owns the active page and the hash follows it. Both directions
  // live in one hook because wiring them as a pair of effects here is a cycle
  // with no fixed point — see the note in `use-tab-routing.ts`.
  const tabs = useTabRouting();
  // Held rather than derived so growing past the compact breakpoint closes the
  // drawer without an effect that would cascade a second render.
  const [drawerRequested, setDrawerRequested] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);

  const connectRemote = useCallback((url: string) => {
    const result = openRemoteDashboard(url);
    if (!result.opened) {
      notify({ tone: "error", title: t("remote.popupBlocked"), body: result.url });
      return;
    }
    setRemoteDialogOpen(false);
    notify({ tone: "success", title: t("remote.connectOpened"), body: url });
  }, [notify, t]);

  const connectRemoteDialog = useCallback(() => setRemoteDialogOpen(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerRequested(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Every toy lock configured to "lock again on launch" (the default) drops
  // any session unlock that survived from before this app instance started.
  // Explicit function call rather than a module-load side effect in
  // `locks.ts` itself — see that function's own doc for why: this is the one
  // place "the app started" actually means something, and a hot reload during
  // development must not relock a lock the developer just unlocked.
  useEffect(() => { applyLockedOnLaunch(); }, []);

  // The shared School Mode record is watched for as long as this app is
  // mounted, and no longer. See the note beside `configureSchoolModeApiBase`:
  // starting this at module scope leaked a timer into every test file that
  // imports `App`.
  useEffect(() => {
    startSchoolModeSync();
    return () => { stopSchoolModeSync(); };
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

  // `/api/claude-code` is a management route and the management plane is open, so
  // the nav rail can keep its Claude switch live even while the mobile remote tab
  // is active. No admin-token prompt or data-plane credential is involved.
  const claudePoll = useKeyedClientResource(
    `app-claude-code:${API_BASE}`,
    [],
    fetchClaudeEnabled,
    {},
  );
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
    // A stop is a decision, so it keeps a blocking dialog rather than a snackbar
    // — an M3 one the app owns, not the browser's untranslatable OK/Cancel box.
    const confirmed = await confirm({
      title: t("confirm.stopTitle"),
      body: t("dash.stopConfirm"),
      confirmLabel: t("dash.stop"),
    });
    if (!confirmed) return;
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

  // Mirrors the active page into `notification-source.ts` so `notify()` can
  // stamp a new notice with the screen that triggered it, even though
  // `NotificationsProvider` sits above this component in the provider stack
  // and cannot read `tabs.activePage` any other way.
  useEffect(() => {
    setNotificationSourcePage(activePage);
  }, [activePage]);

  const title = t(PAGE_META_BY_ID[activePage].tkey);
  // The semantic version alone read the same across a dozen installers, so it
  // could not answer "is the fix in the build I am running". Build number and
  // dish codename come along now; the dish is derived from the commit with the
  // same function that titles the release, so the line matches the release list.
  const buildInfo = readBuildInfo(displayedVersion);
  const statusLine = shortBuildLabel(buildInfo, health?.port ?? null);
  const statusTitle = fullBuildLabel(buildInfo);
  const codename = codenameLabel(buildInfo);

  // The window title, which in a frameless shell is the one piece of chrome the
  // app does NOT draw: it is what Windows shows in the taskbar, in Alt+Tab and
  // in the window list. It read `opencodex · proxy dashboard` for every build
  // ever shipped, so two running builds were indistinguishable in the only place
  // the OS shows them beside each other. Set from here rather than from
  // `BrowserWindow({ title })` because the page's own <title> wins the moment it
  // loads — which is why the value passed at window creation never survived.
  //
  // The name is the user's chosen display name, so a rename reaches the
  // taskbar and Alt+Tab live. The build identity beside it is untouched by
  // that: version, run number and code name still say exactly which build this
  // is, which is what makes the retitled window still identifiable to anyone
  // reading over the user's shoulder.
  useEffect(() => {
    document.title = windowTitle(buildInfo, appName);
  }, [buildInfo.version, buildInfo.build, buildInfo.commit, appName]);

  // The remote control used to short-circuit the whole shell here, on the
  // reasoning that a nav rail and a tab strip are the wrong furniture for a
  // thumb on a phone. The furniture was the wrong thing to argue about: what it
  // actually did was make `#/mobile` a dead end with three panels behind it, so
  // a phone could reach the chat and nothing else — no settings, no appearance,
  // no logs, no changelog, none of the other twenty-one pages.
  //
  // So the remote is a page like any other now, and the *shell* is what adapts:
  // `windowClass === "compact"` already swaps the rail for a drawer and adds a
  // bottom bar, and the strip, the menus and the anchored editors below now hold
  // up at 320px. One shell, one set of components, one place a fix lands — the
  // alternative was a second implementation of everything, which is how two
  // surfaces start disagreeing about what a pin protects.

  return (
    // The appearance host wraps the shell rather than sitting inside it: every
    // surface that offers "Edit appearance…" — the rail, the app bar, the tab
    // strip — has to be a descendant of the provider, and those three have no
    // common ancestor further down.
    <ElementAppearanceHost>
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
          statusTitle={statusTitle}
          codename={codename}
          onOpenDrawer={() => setDrawerRequested(true)}
          drawerOpen={drawerOpen}
          onOpen={openPage}
          onConnectRemote={connectRemoteDialog}
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
      {/* Ctrl+Shift+F, from anywhere in the app — decides for itself whether it
          is open, exactly like OnboardingWizard below it. */}
      <CommandPalette tabs={tabs} />
      <RemoteConnectionDialog
        key={remoteDialogOpen ? "open" : "closed"}
        open={remoteDialogOpen}
        onClose={() => setRemoteDialogOpen(false)}
        onConnect={connectRemote}
      />
      {/* Decides for itself whether this is a first run; renders nothing otherwise. */}
      <OnboardingWizard apiBase={API_BASE} />
      {/* Renders nothing; raises a snackbar when a scheduled rule's remote source fails. */}
      <ScheduleNotificationBridge />
    </div>
    </ElementAppearanceHost>
  );
}
