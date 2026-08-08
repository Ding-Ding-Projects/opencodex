import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n/provider";
import { PrefsProvider } from "./theme/prefs";
import { NotificationsProvider } from "./shell/notifications";
import { ConfirmProvider } from "./shell/confirm";
import ApiTokenPrompt from "./shell/api-token-prompt";
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
          {/* Inside the notifications provider so a confirmation renders above a
              live snackbar rather than under it — the dialog is the thing the
              user has to answer before anything else continues. */}
          <ConfirmProvider>
            <ApiTokenPrompt />
            <App />
          </ConfirmProvider>
        </NotificationsProvider>
      </PrefsProvider>
    </LanguageProvider>
  </React.StrictMode>
);
