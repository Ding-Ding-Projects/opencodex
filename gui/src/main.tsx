import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DownloadPopup from "./pages/DownloadPopup";
import { parseDownloadPopupHash } from "./download-popup-route";
import { LanguageProvider } from "./i18n/provider";
import { SettingsDraftProvider } from "./settings-drafts";
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
    {popupRoute ? (
      // The popup card reads `t()`, so it needs exactly the two providers the
      // language layer sits on — `SettingsDraftProvider` outermost, because
      // `LanguageProvider` reads its context. It uses no prefs, notifications
      // or confirmations, so those providers are deliberately absent rather
      // than mounted for show.
      <SettingsDraftProvider>
        <LanguageProvider>
          <DownloadPopup route={popupRoute} />
        </LanguageProvider>
      </SettingsDraftProvider>
    ) : (
      // `App` mounts this same provider stack itself (see the note in
      // tests/helpers/providers.tsx). Wrapping it again here used to give every
      // consumer an inner store while the outer one sat above it running a second,
      // invisible copy of everything — two schedule engines ticking, duplicated
      // media-query and resize listeners, effects firing twice on mount. Exactly
      // one coordinator, and `App` owns it.
      <App />
    )}
  </React.StrictMode>
);
