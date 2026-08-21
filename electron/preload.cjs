/**
 * Preload for the desktop shell.
 *
 * **CommonJS on purpose, and it must stay that way.** The window runs with
 * `sandbox: true`, and Electron only supports an ESM preload when the sandbox is
 * off — a `.mjs` preload in a sandboxed renderer silently fails to load. Nothing
 * errors visibly; `window.opencodexDesktop` is simply never defined, so the
 * desktop marker never lands, `html[data-desktop]` never applies (taking the
 * frameless window's drag region with it), and the app bar's window controls
 * render nothing. The window looks right and cannot be moved. `.cjs` is what
 * makes this file actually run, because package.json declares `"type": "module"`.
 *
 * Deliberately tiny otherwise: the dashboard is the same build the browser loads
 * and talks to the proxy over http like any other client. No Node API is bridged
 * across, and nothing here can read the filesystem or spawn anything.
 *
 * What is exposed beyond the desktop marker is only what a *frameless* window
 * cannot do from web code: minimise, maximise, close, quit. Each call is a fixed
 * channel name with no caller-supplied arguments, so the renderer cannot ask the
 * main process for anything beyond these actions.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("opencodexDesktop", {
  isDesktop: true,
  platform: process.platform,
  /**
   * True when the shell draws its own window controls. macOS keeps its native
   * traffic lights, so the app bar must not add a second set there.
   */
  customWindowControls: process.platform !== "darwin",
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    /** Resolves to the new maximised state. */
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    /** Closes the window; the tray keeps the app alive. Not a quit. */
    close: () => ipcRenderer.invoke("window:close"),
    /**
     * Really quits. The dashboard calls this only after the proxy has confirmed
     * it stopped.
     */
    exitApp: () => ipcRenderer.invoke("app:exit"),
    /**
     * Maximise state changed outside the app bar — a drag-region double-click, a
     * Win+Up, or the OS restoring the window. Returns an unsubscribe function.
     */
    onMaximizedChanged: (handler) => {
      const listener = (_event, maximized) => handler(Boolean(maximized));
      ipcRenderer.on("window:maximized-changed", listener);
      return () => ipcRenderer.off("window:maximized-changed", listener);
    },
  },
  /**
   * Starting the proxy, for the one screen that cannot reach it over http.
   *
   * This is the exception to "no Node API is bridged across" above, and it is
   * narrow on purpose: two fixed channels, no caller-supplied arguments, and
   * neither can name a command, a path or a port. The renderer can ask "is it
   * up?" and "bring it up on the port this app already chose" — nothing else.
   * It cannot spawn anything of its own choosing, which is what would make this
   * an arbitrary-execution bridge rather than a button.
   */
  proxy: {
    /** `{ running, port, pid, managed }` — cheap enough to poll. */
    status: () => ipcRenderer.invoke("proxy:status"),
    /**
     * Resolves only once the proxy actually answers `/healthz`, or with
     * `{ ok: false, error }` explaining why it did not. An already-running
     * proxy is adopted rather than raced with.
     */
    start: () => ipcRenderer.invoke("proxy:start"),
    /**
     * Backend-only contract for the separate renderer lane: restore only
     * OpenCodex-owned native Codex routing/catalog state. The renderer supplies
     * no path, command, argv, or error-detail preference.
     */
    restoreNative: () => ipcRenderer.invoke("proxy:restore-native"),
  },
  /**
   * The toy-lock recovery route: "delete this app's local application-data
   * folder" (see `gui/src/shell/app-data-path.ts` and the Support Tickets
   * surface). Two fixed channels, no caller-supplied argument — the renderer
   * can ask where the folder is and ask to have it opened, and cannot name any
   * other path for either call to act on.
   */
  appData: {
    /** The real, resolved absolute path — named exactly, not guessed. */
    path: () => ipcRenderer.invoke("appData:path"),
    /** Opens it in the platform's own file manager. Never deletes anything itself. */
    open: () => ipcRenderer.invoke("appData:open"),
  },
  /**
   * The always-on-top Start-download / Download-complete popups (see
   * `shell/DownloadsBridge.tsx`). One fixed channel, two caller-supplied
   * strings: which of the two fixed popup kinds, and which download record —
   * never an arbitrary URL or window configuration. The main process resolves
   * the actual window position, size and `alwaysOnTop` flag; the renderer
   * cannot ask for anything beyond "show me the decision/completion card for
   * this id".
   */
  downloads: {
    openPopup: (kind, id) => ipcRenderer.invoke("downloads:open-popup", { kind, id }),
  },
  /**
   * The native file/folder picker behind every path text box.
   *
   * `mode` is a word this bridge chooses from -- "file", "directory" or "save"
   * -- not an Electron `properties` array. The main process decides what each
   * one means, so the renderer cannot ask for a picker the app never intended
   * to offer, and cannot read anything: the dialog returns only what the user
   * themselves selected.
   *
   * Always resolves. A cancelled dialog comes back `{ ok: true, canceled: true }`
   * rather than rejecting, because changing your mind is a normal outcome and a
   * caller should not have to tell it apart from a failure with a try/catch.
   */
  dialog: {
    openPath: (options) => ipcRenderer.invoke("dialog:open-path", {
      mode: options?.mode,
      title: options?.title,
      defaultPath: options?.defaultPath,
    }),
  },
});
