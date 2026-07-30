import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n/provider";
import { PrefsProvider } from "./theme/prefs";
import { NotificationsProvider } from "./shell/notifications";
import "./styles.css";

// Inside the desktop shell the native title bar is hidden and the M3 app bar is
// the window chrome; this attribute switches on its drag region and the inset
// that keeps controls clear of the Windows min/max/close overlay.
if (window.opencodexDesktop?.isDesktop) {
  document.documentElement.setAttribute("data-desktop", "true");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <PrefsProvider>
        <NotificationsProvider>
          <App />
        </NotificationsProvider>
      </PrefsProvider>
    </LanguageProvider>
  </React.StrictMode>
);
