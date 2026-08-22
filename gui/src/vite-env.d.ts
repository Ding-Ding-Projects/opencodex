/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define` as the UI version fallback.
declare const __APP_VERSION__: string;
/** Run number that produced this build, or "dev" outside CI. */
declare const __APP_BUILD__: string;
/** Commit this build came from; empty outside CI. Names the dish codename too. */
declare const __APP_COMMIT__: string;
/** One-use public-catalog release codename, or null when none was resolved. */
declare const __APP_CODENAME__: {
  id: string;
  name: string;
  zh: string;
  jyutping: string;
  emoji: string;
} | null;

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
    /**
     * Starting the proxy from the one screen that cannot reach it over http.
     * Absent in a browser, where nothing can start a local process — so the
     * offline banner falls back to naming the command instead of offering a
     * button that could not work.
     */
    proxy?: {
      status: () => Promise<{ running: boolean; port: number; pid: number | null; managed: boolean }>;
      /** Resolves only once `/healthz` answers, or explains why it did not. */
      start: () => Promise<{ ok: true; port: number; adopted: boolean } | { ok: false; error: string }>;
      /** Fixed native restore operation; no renderer path, command, or argv. */
      restoreNative: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
    };
    updater?: {
      state: () => Promise<DesktopUpdateBridgeState>;
      start: () => Promise<DesktopUpdateBridgeState>;
      check: () => Promise<unknown>;
      cancel: () => Promise<unknown>;
      install: () => Promise<{ ok: boolean; reason?: string }>;
      onState: (handler: (state: DesktopUpdateBridgeState) => void) => () => void;
    };
    /**
     * The native file/folder picker behind every path text box.
     *
     * Absent in a browser, where nothing can open one — so `PathInput` renders
     * the plain text field alone rather than a Browse button guaranteed to do
     * nothing. `mode` is a word this bridge chooses from, not an Electron
     * `properties` array; the main process decides what each means.
     *
     * Always resolves: a cancelled dialog is `{ ok: true, canceled: true }`,
     * because changing your mind is a normal outcome rather than a failure to
     * catch.
     */
    dialog?: {
      openPath: (options: {
        mode: "file" | "directory" | "save";
        title?: string;
        /** Starting directory only — the user still chooses what comes back. */
        defaultPath?: string;
      }) => Promise<{ ok: boolean; canceled: boolean; path?: string; error?: string }>;
    };
  };
}

interface DesktopUpdateBridgeState {
  status: "current" | "checking" | "available" | "downloading" | "ready" | "failed" | "offline" | "cancelled" | "corrupt";
  version: string | null;
  progress: number;
  releaseNotesUrl?: string;
  error?: string | null;
}
