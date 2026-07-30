/**
 * Preload for the desktop shell.
 *
 * Deliberately tiny: the dashboard is the same build the browser loads, and it
 * talks to the proxy over http like any other client. No Node API is bridged
 * across, and nothing here can read the filesystem or spawn anything.
 *
 * What is exposed beyond the desktop marker is only what a *frameless* window
 * cannot do from web code: minimise, maximise, close, quit. Those exist because
 * the Material 3 app bar replaced the native title bar and its controls — without
 * this bridge the window would have no way to be minimised or closed at all.
 *
 * Each call is a fixed channel name with no caller-supplied arguments, so the
 * renderer cannot ask the main process for anything beyond these actions.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencodexDesktop", {
  isDesktop: true,
  platform: process.platform,
  /**
   * True when this shell draws its own window controls. macOS keeps its native
   * traffic lights, so the app bar must not add a second set there.
   */
  customWindowControls: process.platform !== "darwin",
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    /** Resolves to the new maximised state, so the button can update immediately. */
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    /** Close the window. The tray keeps the app running — this is not a quit. */
    close: () => ipcRenderer.invoke("window:close"),
    /**
     * Really quit. The dashboard calls this only after the proxy has confirmed it
     * finished in-flight work and stopped, so this just closes the shell.
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
});
