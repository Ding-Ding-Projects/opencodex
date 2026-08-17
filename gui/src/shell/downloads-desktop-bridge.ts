/**
 * The Electron bridge behind the always-on-top Start-download and
 * Download-complete popups.
 *
 * Same shape as `app-data-path.ts`'s `desktopBridge()`: a local, narrowly-typed
 * cast of `window.opencodexDesktop` rather than an edit to the shared
 * `vite-env.d.ts` global — this feature does not need every other file that
 * touches `window.opencodexDesktop` to also know its shape.
 *
 * `openPopup` asks the main process (`electron/main.mjs`) to create or focus a
 * small `alwaysOnTop` `BrowserWindow` loaded at
 * `#/downloads?popup=<kind>&id=<id>` — see `pages/DownloadPopup.tsx` for what
 * renders there. In a plain browser tab (no bridge), `DownloadsBridge.tsx`
 * falls back to an in-page anchored dialog and a notification-centre toast;
 * neither can truthfully claim to float above the *browser's own* window, and
 * that gap is stated where the fallback renders rather than pretended away.
 */

export type DownloadPopupKind = "start" | "complete";

interface OpencodexDesktopDownloads {
  openPopup: (kind: DownloadPopupKind, id: string) => Promise<{ ok: boolean }>;
}

interface OpencodexDesktopGlobal {
  isDesktop?: boolean;
  downloads?: OpencodexDesktopDownloads;
}

function bridge(): OpencodexDesktopDownloads | null {
  const w = globalThis as unknown as { opencodexDesktop?: OpencodexDesktopGlobal };
  return w.opencodexDesktop?.downloads ?? null;
}

export function hasDownloadsPopupBridge(): boolean {
  return bridge() !== null;
}

/** Fire-and-forget: the main process owns dedup (re-asking for an already-open id focuses it rather than opening a second window). */
export function openDownloadPopup(kind: DownloadPopupKind, id: string): void {
  bridge()?.openPopup(kind, id)?.catch(() => { /* best-effort — the in-page fallback already covers this record */ });
}
