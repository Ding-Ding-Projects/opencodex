/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define` as the UI version fallback.
declare const __APP_VERSION__: string;

/** Injected by the desktop shell's preload (electron/preload.mjs). Absent in a browser. */
interface Window {
  opencodexDesktop?: {
    isDesktop: boolean;
    platform: string;
  };
}
