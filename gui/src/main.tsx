import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n/provider";
import { PrefsProvider } from "./theme/prefs";
import { NotificationsProvider } from "./shell/notifications";
import "./styles.css";

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
