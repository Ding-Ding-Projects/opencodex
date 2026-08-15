import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DownloadPopup from "./pages/DownloadPopup";
import { parseDownloadPopupHash } from "./download-popup-route";
import { LanguageProvider } from "./i18n/provider";
import { PrefsProvider } from "./theme/prefs";
import { SettingsDraftProvider } from "./settings-drafts";
import { NotificationsProvider } from "./shell/notifications";
import { ConfirmProvider } from "./shell/confirm";
import "./styles.css";

/**
 * The always-on-top Electron popup windows load this SAME bundle at
 * `#/downloads?popup=start&id=…` — see `electron/main.mjs`'s
 * `openDownloadPopup` and `download-popup-route.ts`. Rendering `DownloadPopup`
 * full-bleed instead of `App` here is what keeps those windows small and
 * chrome-less: no nav rail, no app bar, no tab strip, just the one decision or
 * completion card the popup exists to show.
 */
const popupRoute = parseDownloadPopupHash(window.location.hash);

// Inside the desktop shell the native title bar is hidden and the M3 app bar is
// the window chrome; this attribute switches on its drag region and the inset
// that keeps controls clear of the Windows min/max/close overlay.
if (window.opencodexDesktop?.isDesktop) {
  document.documentElement.setAttribute("data-desktop", "true");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsDraftProvider>
      <LanguageProvider>
        <PrefsProvider>
          <NotificationsProvider>
            {/* Inside the notifications provider so a confirmation renders above a
                live snackbar rather than under it — the dialog is the thing the
                user has to answer before anything else continues. */}
            <ConfirmProvider>
              {popupRoute ? <DownloadPopup route={popupRoute} /> : <App />}
            </ConfirmProvider>
          </NotificationsProvider>
        </PrefsProvider>
      </LanguageProvider>
    </SettingsDraftProvider>
  </React.StrictMode>
);
