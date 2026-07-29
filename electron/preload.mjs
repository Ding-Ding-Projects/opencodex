/**
 * Preload for the desktop shell.
 *
 * Deliberately almost empty: the dashboard is the same build the browser loads,
 * and it talks to the proxy over http like any other client. The only thing
 * exposed is a read-only marker so a screen can tell it is running inside the
 * desktop app (for example, to offer "start at login" instead of a bookmark
 * hint). No Node API is bridged across.
 */

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("opencodexDesktop", {
  isDesktop: true,
  platform: process.platform,
});
