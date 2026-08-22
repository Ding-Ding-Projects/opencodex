/**
 * opencodex desktop shell.
 *
 * The Electron main process owns the proxy lifecycle: it spawns the same
 * `bin/ocx.mjs start` the CLI does, waits for `/healthz` to identify *that*
 * child (by pid, so a foreign server already on the port is never adopted), and
 * only then points a window at the dashboard the proxy serves.
 *
 * Nothing about the dashboard is special-cased for Electron — it is the same
 * build the browser gets, loaded over http from the loopback interface, so the
 * management-auth session bootstrap works unchanged.
 */

import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleSquirrelEvent, planSquirrelEvent } from "./squirrel.mjs";
import { readBuildStamp } from "./build-stamp.mjs";
import { classifyDesktopHealth, desktopLauncherPath, launcherExists, normalizeDesktopProbeHostname, planDesktopStartup, readDesktopPortState, runFixedNativeRestore } from "./startup-recovery.mjs";
import { installCliOnPath, recordDesktopCliPathStatus, uninstallCliOnPath } from "./cli-path.mjs";
import { createDesktopAutoUpdater, DEFAULT_DESKTOP_UPDATE_FEED } from "./auto-updater.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Repo root in development; `resources/app/` in a packaged build.
 *
 * The installer is built with `asar: false` on purpose. The proxy is Bun
 * reading TypeScript off disk and exec'ing a bundled `bun.exe`, and neither
 * works from inside an asar archive — you cannot exec a binary in it, and
 * Bun's own module loader does not know how to read one. Leaving the app
 * unpacked keeps every path in `bin/ocx.mjs` true as written.
 */
const ROOT = join(HERE, "..");

const PORT_STATE = readDesktopPortState();
const DEFAULT_PORT = PORT_STATE.hardPin ?? PORT_STATE.configuredPort ?? 10100;
const HOST = "127.0.0.1";
/** How long to wait for the spawned proxy to answer /healthz before giving up. */
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;

/**
 * Squirrel's install-time launches, answered before anything else happens.
 *
 * Squirrel runs this app with `--squirrel-install`, `--squirrel-updated`,
 * `--squirrel-uninstall` or `--squirrel-obsolete` during install and uninstall.
 * Ignoring them starts the window, the tray and a proxy bound to port 10100 once
 * per flag during a supposedly silent install — and on uninstall, Squirrel waits
 * for this process to exit before deleting the directory, so a running proxy
 * blocks its own removal.
 *
 * The logic lives in `./squirrel.mjs` so it can be tested: this file imports
 * `electron`, which is not installed in this repo, so nothing in it is reachable
 * from a test.
 *
 * `app.exit(0)` rather than `app.quit()`: quit runs `before-quit` and the whole
 * shutdown path, and this process has started nothing to shut down.
 *
 * `--squirrel-install` and `--squirrel-updated` are also when this app makes
 * sure its own `ocx` shim is on the user's PATH (`./cli-path.mjs`) — without
 * this, a Squirrel-only install (no npm, nobody ran scripts/install.ps1 by
 * hand) ships a GUI and no usable command line. It runs BEFORE
 * handleSquirrelEvent below so it completes while Squirrel is still waiting
 * on this process, and it must never throw or block that exit: installCliOnPath
 * already fails closed and returns a result object instead of throwing for
 * every failure it anticipates, and the try/catch here is the last-resort net
 * for anything it does not.
 */
const squirrelPlan = planSquirrelEvent(process.argv, process.execPath, process.platform);
if (squirrelPlan && (squirrelPlan.event === "--squirrel-install" || squirrelPlan.event === "--squirrel-updated")) {
  try {
    recordDesktopCliPathStatus(installCliOnPath(process.execPath));
  } catch {
    // Never let a PATH-install surprise block Squirrel's own install/update —
    // it is waiting on this process to exit within about a second either way.
  }
}
if (squirrelPlan?.event === "--squirrel-uninstall") {
  try {
    // Only the final uninstall owns cleanup. --squirrel-obsolete deliberately
    // leaves the stable shim and PATH entry for the incoming version.
    recordDesktopCliPathStatus(uninstallCliOnPath(process.execPath));
  } catch {
    // Never let optional PATH cleanup block Squirrel's own uninstall.
  }
}

if (handleSquirrelEvent({ spawn, exit: code => app.exit(code) })) {
  // Nothing below this line may run: the process is on its way out.
} else if (!app.requestSingleInstanceLock()) {
  /** Single instance: a second launch focuses the existing window instead of racing for the port. */
  app.quit();
}

let mainWindow = null;
let tray = null;
let proxy = null;
let proxyPort = DEFAULT_PORT;
/** True once the user has chosen Quit, so window-close stops meaning "hide to tray". */
let quitting = false;
let desktopUpdater = null;

function appVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function iconPath() {
  for (const candidate of [
    join(ROOT, "gui", "dist", "logo.png"),
    join(ROOT, "gui", "public", "logo.png"),
    join(ROOT, "assets", "logo-light.png"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ proxy -- */

/** Ask /healthz who is listening. A non-OpenCodex body is retained for ownership decisions. */
async function probeHealth(port, hostname = HOST) {
  const validPort = Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
  if (!validPort) return null;
  const safeHostname = normalizeDesktopProbeHostname(hostname);
  if (!safeHostname) return null;
  try {
    const res = await fetch(`http://${safeHostname}:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** This install's identity, read once from the packaged tree. */
let stampCache = null;
function ourStamp() {
  stampCache ??= readBuildStamp(ROOT);
  return stampCache;
}

function spawnProxy(pinnedPort) {
  const entry = join(ROOT, "bin", "ocx.mjs");
  if (!launcherExists(entry)) {
    throw new Error(
      `The proxy launcher is missing from this build (expected ${entry}). `
      + "Reinstall opencodex, or report this if a fresh install does the same.",
    );
  }
  const argv = [entry, "start"];
  if (Number.isSafeInteger(pinnedPort) && pinnedPort >= 1 && pinnedPort <= 65_535) {
    argv.push("--port", String(pinnedPort));
  }
  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    // ELECTRON_RUN_AS_NODE makes the packaged Electron binary behave as plain Node,
    // so `bin/ocx.mjs` runs on it exactly as it does on a system Node install and
    // the app does not have to ship a second runtime just to host the shim.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", chunk => process.stdout.write(`[ocx] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[ocx] ${chunk}`));
  child.on("exit", (code, signal) => {
    proxy = null;
    if (quitting) return;
    // An unexpected exit is worth interrupting for: without the proxy the window shows nothing.
    dialog.showErrorBox(
      "opencodex stopped",
      `The proxy exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}). Restart the app to try again.`,
    );
  });

  return child;
}

/**
 * Bring a proxy up and return once the identity-matching endpoint is answering.
 *
 * If a healthy opencodex of *the same build* is already listening — the user
 * started one from the CLI, or this app is relaunching against the proxy it left
 * running — we attach to it rather than spawning a competitor, and leave it
 * running on quit because we did not start it.
 *
 * A *different* build holding a persisted candidate is never adopted and never
 * stopped. The new app restores its own native state, asks the proxy's normal
 * automatic start policy for an unpinned endpoint, and discovers that endpoint
 * from its identity-checked health response.
 *
 * A healthy listener that is not this exact build remains untouched. When no
 * same-build owner exists, restore native Codex state first and launch without a
 * port pin unless the caller supplied a valid explicit pin.
 */
async function ensureProxy() {
  const state = readDesktopPortState();
  const healthByPort = new Map();
  for (const port of state.candidates) {
    const hostname = state.runtime?.port === port
      ? normalizeDesktopProbeHostname(state.runtime.hostname)
      : state.configuredPort === port ? state.configuredHostname : HOST;
    if (!hostname) continue;
    const health = await probeHealth(port, hostname);
    if (health) healthByPort.set(port, health);
  }
  const plan = planDesktopStartup({
    candidates: state.candidates,
    hardPin: state.hardPin,
    healthByPort,
    stamp: ourStamp(),
  });
  if (plan.action === "adopt") {
    proxyPort = plan.port;
    console.log(`[desktop] attaching to the same-build opencodex on :${plan.port} (pid ${plan.pid ?? "unknown"})`);
    return { port: plan.port, adopted: true };
  }
  if (plan.action === "blocked") throw new Error(plan.reason);

  const restore = await runFixedNativeRestore({
    execPath: process.execPath,
    launcherPath: desktopLauncherPath(ROOT),
    cwd: ROOT,
  });
  if (!restore.ok) throw new Error(restore.error);

  proxy = spawnProxy(plan.pinnedPort);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!proxy) throw new Error("The proxy exited before it finished starting.");
    const next = readDesktopPortState();
    for (const port of next.candidates) {
      const hostname = next.runtime?.port === port
        ? normalizeDesktopProbeHostname(next.runtime.hostname)
        : next.configuredPort === port ? next.configuredHostname : HOST;
      if (!hostname) continue;
      const health = await probeHealth(port, hostname);
      const healthPlan = classifyDesktopHealth(health, ourStamp());
      if (healthPlan.action === "adopt") {
        proxyPort = port;
        return { port, adopted: false };
      }
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`The proxy did not answer an identity-matching /healthz within ${STARTUP_TIMEOUT_MS / 1000}s.`);
}

function stopProxy() {
  if (!proxy) return;
  const child = proxy;
  proxy = null;
  // SIGTERM lets the proxy restore the native Codex config it swapped out.
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5000).unref?.();
}

function broadcastDesktopUpdateState(state) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("desktop-update:state", state);
  }
}

/** Start Electron's built-in Squirrel updater only for the installed artifact. */
function startDesktopUpdater() {
  if (!app.isPackaged || process.platform !== "win32") return;
  const feedUrl = process.env.OPENCODEX_UPDATE_FEED_URL
    || `${DEFAULT_DESKTOP_UPDATE_FEED}${encodeURIComponent(appVersion())}`;
  desktopUpdater = createDesktopAutoUpdater({
    updater: autoUpdater,
    feedUrl,
    packaged: true,
    onState: broadcastDesktopUpdateState,
  });
  void desktopUpdater.start().catch(error => {
    broadcastDesktopUpdateState({
      ...desktopUpdater.snapshot(),
      status: "failed",
      error: String(error?.message ?? error),
    });
  });
}

/* ------------------------------------------------------------ window IPC -- */

/**
 * The window controls the Material 3 app bar draws, and the app bar's Exit.
 *
 * These exist because the window is frameless: with no native title bar and no
 * Window Controls Overlay, nothing else can minimise, maximise or close it. Each
 * handler acts on the window the request came from rather than a module-level
 * reference, so a control can never operate on the wrong window.
 *
 * `app:exit` is the deliberate counterpart to closing the window: window-close
 * hides to the tray, whereas this really quits. The dashboard has already asked
 * the proxy to finish in-flight work and stop (POST /api/host/exit) before
 * calling it, so by this point quitting is just closing the shell — and
 * `will-quit` still runs stopProxy as the backstop for a proxy that did not go
 * down on its own.
 */
function registerWindowIpc() {
  const windowFor = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle("window:minimize", (event) => { windowFor(event)?.minimize(); });
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = windowFor(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:is-maximized", (event) => windowFor(event)?.isMaximized() ?? false);
  // Close, not quit: the tray keeps the app running, exactly as the native button did.
  ipcMain.handle("window:close", (event) => { windowFor(event)?.close(); });
  ipcMain.handle("app:exit", () => { quitting = true; app.quit(); });

  /**
   * The two channels behind the toy-lock recovery route and the Support
   * Tickets "resolution" step (see `gui/src/shell/app-data-path.ts`).
   *
   * Both are the same shape as every other bridge call in this file: a fixed
   * channel, no caller-supplied argument, so the renderer can ask "where is
   * it?" and "open it" and nothing else — it cannot name an arbitrary path for
   * this to open. `app.getPath("userData")` is Electron's own answer for
   * "where does this app's data actually live on this machine", which is what
   * lets the recovery copy name the real folder instead of a guessed one.
   */
  /**
   * The native file/folder picker, for every path text box in the app.
   *
   * Until this existed there was no `showOpenDialog` anywhere in the tree, and
   * the converter and PDF screens said so to the user's face: "No page in this
   * app has a native file-browse dialog yet." Honest, and still a text box
   * asking somebody to type `C:\Users\...\Documents\file` by hand.
   *
   * Modal to the window that asked, so it cannot end up behind the app, and
   * always resolves — a cancelled dialog is `{ ok: true, canceled: true }`
   * rather than a rejection, because "the user changed their mind" is a normal
   * outcome and a renderer should not have to tell it apart from a failure by
   * catching.
   *
   * The renderer chooses `mode`, never a raw Electron properties array: this
   * side decides what the modes mean, so a compromised or simply buggy renderer
   * cannot ask for a picker this app never intended to offer.
   */
  ipcMain.handle("dialog:open-path", async (event, payload) => {
    const window = windowFor(event);
    if (!window) return { ok: false, canceled: false, error: "no window" };
    const mode = payload?.mode === "directory" ? "directory" : payload?.mode === "save" ? "save" : "file";
    const title = typeof payload?.title === "string" ? payload.title : undefined;
    // Only ever used as a starting directory. A defaultPath the renderer made
    // up cannot read anything on its own; the user still has to choose.
    const defaultPath = typeof payload?.defaultPath === "string" && payload.defaultPath
      ? payload.defaultPath
      : undefined;
    try {
      if (mode === "save") {
        const res = await dialog.showSaveDialog(window, { title, defaultPath });
        return { ok: true, canceled: res.canceled, path: res.canceled ? undefined : res.filePath };
      }
      const res = await dialog.showOpenDialog(window, {
        title,
        defaultPath,
        properties: [mode === "directory" ? "openDirectory" : "openFile"],
      });
      return { ok: true, canceled: res.canceled, path: res.canceled ? undefined : res.filePaths[0] };
    } catch (err) {
      return { ok: false, canceled: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("appData:path", () => app.getPath("userData"));
  ipcMain.handle("appData:open", async () => {
    const dir = app.getPath("userData");
    // `shell.openPath` resolves to an error string on failure, "" on success —
    // never rejects, so there is nothing to catch here.
    const error = await shell.openPath(dir);
    return { ok: !error, path: dir, error: error || undefined };
  });

  /**
   * Is it running, and start it if not.
   *
   * The dashboard's offline screen used to say "Cannot connect to proxy. Is it
   * running? Run `ocx start`" — which names the fix and then leaves the user to
   * go and do it, in the one place that already has everything needed to do it
   * for them. Inside the desktop shell this window IS the app: there is no
   * terminal in front of the user, and telling them to open one is the whole
   * reason the desktop build exists.
   *
   * `ensureProxy` is reused rather than reimplemented, so the button behaves
   * exactly like startup: an opencodex already listening is *adopted* rather
   * than raced with, and the call only resolves once /healthz actually answers.
   * Reporting "started" the moment a process was spawned would hand the
   * dashboard a green light while the port was still closed.
   */
  ipcMain.handle("proxy:status", async () => {
    const state = readDesktopPortState();
    const hostname = state.runtime?.port === proxyPort
      ? normalizeDesktopProbeHostname(state.runtime.hostname)
      : state.configuredPort === proxyPort ? state.configuredHostname : HOST;
    const health = await probeHealth(proxyPort, hostname);
    const plan = classifyDesktopHealth(health, ourStamp());
    return { running: plan.action === "adopt", port: proxyPort, pid: plan.action === "adopt" ? health?.pid ?? null : null, managed: proxy !== null };
  });

  ipcMain.handle("proxy:start", async () => {
    try {
      const result = await ensureProxy();
      return { ok: true, port: result.port, adopted: result.adopted };
    } catch (error) {
      // The renderer shows this verbatim, so it has to be a sentence a user can
      // act on rather than a stack frame.
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle("proxy:restore-native", async () => {
    const result = await runFixedNativeRestore({
      execPath: process.execPath,
      launcherPath: desktopLauncherPath(ROOT),
      cwd: ROOT,
    });
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.error };
  });

  ipcMain.handle("desktop-update:state", () => desktopUpdater?.snapshot() ?? {
    status: "current",
    version: appVersion(),
    progress: 0,
    releaseNotesUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/latest",
    error: null,
  });
  ipcMain.handle("desktop-update:start", async () => desktopUpdater ? desktopUpdater.start() : {
    status: "current",
    version: appVersion(),
    progress: 0,
    releaseNotesUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/latest",
    error: null,
  });
  ipcMain.handle("desktop-update:check", async () => desktopUpdater ? desktopUpdater.check() : null);
  ipcMain.handle("desktop-update:cancel", () => desktopUpdater?.cancel() ?? null);
  ipcMain.handle("desktop-update:install", async event => {
    if (!desktopUpdater) return { ok: false, reason: "desktop_updater_unavailable" };
    const window = windowFor(event);
    const decision = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Restart to install update",
      message: "Save any work before restarting to install the downloaded update.",
      buttons: ["Restart to install update", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return desktopUpdater.install({ confirm: async () => decision.response === 0 });
  });

  ipcMain.handle("downloads:open-popup", (_event, payload) => {
    const kind = payload?.kind === "start" || payload?.kind === "complete" ? payload.kind : null;
    const id = typeof payload?.id === "string" && payload.id ? payload.id : null;
    if (!kind || !id) return { ok: false };
    openDownloadPopup(kind, id);
    return { ok: true };
  });
}

/* ----------------------------------------------------------------- window -- */

function createWindow(port) {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 480,
    show: false,
    backgroundColor: "#101010",
    title: `opencodex v${appVersion()}`,
    // No native title bar, and on Windows/Linux no native controls either: the
    // dashboard's Material 3 app bar IS the chrome, minimise/maximise/close
    // included. The Window Controls Overlay used to float OS-drawn buttons over
    // the app bar, which meant the one part of the window that could not be
    // themed was sitting inside the themed surface. The app bar declares its own
    // drag region (app-region) and drives these through the window IPC below.
    // macOS keeps its traffic lights: hiding them leaves a Mac window with no
    // way to close it, and they are a platform convention rather than chrome.
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin" ? { frame: false } : {}),
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      // .cjs, not .mjs: this window is sandboxed, and Electron only loads an ESM
      // preload when sandbox is off. An .mjs preload here fails silently — no
      // error, no `window.opencodexDesktop`, no drag region, no window controls.
      preload: join(HERE, "preload.cjs"),
      // The dashboard is ordinary web content; it gets no Node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(`http://${HOST}:${port}/`);

  // The app bar's maximise button draws two different icons, so it has to hear
  // about state changes it did not initiate — a double-click on the drag region,
  // a Win+Up, or the OS restoring the window.
  const sendMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("window:maximized-changed", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  // Anything that is not the local dashboard opens in the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://${HOST}:${port}`)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on("close", event => {
    // Closing the window hides to the tray; quitting is explicit.
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ------------------------------------------------------ download popups -- */

/**
 * The Start-download and Download-complete surfaces the browser-extension
 * download-capture contract asks be "above the originating browser window" —
 * real OS-level `alwaysOnTop` windows, not an in-app overlay, so they float
 * over Chrome/Edge/Firefox and not just over this app's own window.
 *
 * Keyed by `kind:id` so `DownloadsBridge.tsx` polling from a webContents that
 * is still alive can call this repeatedly for the same record without
 * stacking duplicate windows — a second call for an id already open focuses
 * the existing one instead. Content is the SAME build the dashboard serves,
 * just a different route (`pages/DownloadPopup.tsx` via `main.tsx`'s
 * popup-mode branch): no second UI implementation to keep in sync.
 */
const downloadPopups = new Map();

function openDownloadPopup(kind, id) {
  const key = `${kind}:${id}`;
  const existing = downloadPopups.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const icon = iconPath();
  // These heights are sized for the REAL content `pages/DownloadPopup.tsx`
  // renders at default density/font-scale, not guessed. 220/180 (this
  // window's dimensions before this fix) were too short for the six-child
  // "start" card and the up-to-five-child "complete" card to lay out without
  // shrinking — see the long comment on `.m3-dlpopup` in
  // `gui/src/styles/m3-shell.css` for the exact flexbox mechanism that made
  // the shortfall invisible (the filename/URL paragraphs collapsed to a ~2px
  // line box) rather than an obvious clipped/overflowing card.
  // `scripts/download-popup-layout-check.ts` measured the real, unsquished
  // content height of every child in a real browser at these exact window
  // dimensions: icon 34 + title 19.19 + file 21 + url 18.75 + hint 18.75 +
  // actions 56 = 167.69, plus five `--sp-2` (10px) gaps and top+bottom
  // `--sp-4` (19px) padding = 255.69px for "start"; the "complete" card drops
  // the hint row but can still show icon/title/file/url/actions =
  // 148.94 + four gaps + padding = 226.94px. Both get rounded up with a
  // margin for locale/DPI/font-metric variance rather than shipped exact —
  // `.m3-dlpopup`'s own `overflow-y: auto` is the remaining safety net for
  // whatever margin still is not enough (a longer bilingual string, a larger
  // font-scale preference).
  const win = new BrowserWindow({
    width: 360,
    height: kind === "start" ? 260 : 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#101010",
    title: kind === "start" ? "opencodex — Start download" : "opencodex — Download",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // "Always on top" over ordinary windows still normally sits under another
  // app's own always-on-top surfaces; the "screen-saver" level is what macOS
  // and Windows both treat as floating above regular application windows,
  // which is the actual ask here. Harmless where the platform ignores the level.
  win.setAlwaysOnTop(true, "screen-saver");
  win.once("ready-to-show", () => win.show());
  win.loadURL(`http://${HOST}:${proxyPort}/#/downloads?popup=${kind}&id=${encodeURIComponent(id)}`);
  win.on("closed", () => { downloadPopups.delete(key); });
  downloadPopups.set(key, win);
}

function showWindow() {
  if (!mainWindow) {
    return createWindow(proxyPort);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------ tray + menu -- */

function autoStartEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}

function buildTray() {
  const icon = iconPath();
  if (!icon) return;
  const image = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(`opencodex · :${proxyPort}`);
  refreshTrayMenu();
  tray.on("click", showWindow);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `opencodex v${appVersion()} · :${proxyPort}`, enabled: false },
    { type: "separator" },
    { label: "Open dashboard", click: showWindow },
    { label: "Open in browser", click: () => void shell.openExternal(`http://${HOST}:${proxyPort}/`) },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: autoStartEnabled(),
      click: menuItem => { setAutoStart(menuItem.checked); refreshTrayMenu(); },
    },
    { type: "separator" },
    { label: "Quit opencodex", click: () => { quitting = true; app.quit(); } },
  ]));
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open in browser", click: () => void shell.openExternal(`http://${HOST}:${proxyPort}/`) },
        { type: "separator" },
        {
          label: "Start at login",
          type: "checkbox",
          checked: autoStartEnabled(),
          click: menuItem => { setAutoStart(menuItem.checked); refreshTrayMenu(); },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { label: "Quit", click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "opencodex on GitHub", click: () => void shell.openExternal("https://github.com/lidge-jun/opencodex") },
      ],
    },
  ]));
}

/* --------------------------------------------------------------- lifecycle -- */

app.on("second-instance", showWindow);

app.whenReady().then(async () => {
  // Register the recovery and updater backend before proxy startup. A proxy
  // startup failure is recoverable from the desktop shell and must not erase
  // update state or make the manual retry channels disappear.
  registerWindowIpc();
  startDesktopUpdater();
  buildAppMenu();
  buildTray();

  // A login-item start goes to the tray with no window, so there is nobody to
  // answer a modal. It takes the old behaviour — attach and carry on — and
  // *remembers* that it did, so the question is asked the first time a window is
  // actually opened rather than dropped. Silently adopting and never mentioning
  // it is the original bug; deferring the question is not.
  try {
    const started = await ensureProxy();
    proxyPort = started.port;
  } catch (error) {
    dialog.showErrorBox(
      "opencodex could not start",
      `${String(error?.message ?? error)}\n\nThe proxy startup failed; keeping the desktop recovery shell alive so you can retry.`,
    );
  }

  // `--hidden` is what the login item passes, so an auto-start boots to the tray.
  if (!process.argv.includes("--hidden")) createWindow(proxyPort);
});

app.on("window-all-closed", () => {
  // The tray keeps the app alive on every platform; without one, closing quits.
  if (!tray) { quitting = true; app.quit(); }
});

app.on("activate", showWindow);

app.on("before-quit", () => { quitting = true; desktopUpdater?.stop(); });
app.on("will-quit", stopProxy);
process.on("exit", stopProxy);
