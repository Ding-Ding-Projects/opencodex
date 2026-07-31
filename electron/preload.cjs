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
  },
});
