/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define` as the UI version fallback.
declare const __APP_VERSION__: string;
/** Run number that produced this build, or "dev" outside CI. */
declare const __APP_BUILD__: string;
/** Commit this build came from; empty outside CI. Names the dish codename too. */
declare const __APP_COMMIT__: string;

/** Injected by the desktop shell's preload (electron/preload.mjs). Absent in a browser. */
interface Window {
  opencodexDesktop?: {
    isDesktop: boolean;
    platform: string;
    /**
     * True when the shell draws no native window controls, so the app bar must
     * supply them. Absent in older shells and on macOS, where the native traffic
     * lights stay — treat a missing value as "do not draw our own".
     */
    customWindowControls?: boolean;
    window?: {
      minimize: () => Promise<void>;
      /** Resolves to the new maximised state. */
      toggleMaximize: () => Promise<boolean>;
      isMaximized: () => Promise<boolean>;
      /** Closes the window; the tray keeps the app alive. Not a quit. */
      close: () => Promise<void>;
      /** Really quits. Call only after the proxy has confirmed it stopped. */
      exitApp: () => Promise<void>;
      /** Subscribe to out-of-band maximise changes; returns an unsubscribe. */
      onMaximizedChanged: (handler: (maximized: boolean) => void) => () => void;
    };
  };
}
