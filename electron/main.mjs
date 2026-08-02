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

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleSquirrelEvent } from "./squirrel.mjs";
import { readBuildStamp } from "./build-stamp.mjs";
import { describeConflict, planProxyAdoption } from "./proxy-adoption.mjs";

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

const DEFAULT_PORT = Number(process.env.OPENCODEX_PORT || 10100);
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
 */
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
/** A build conflict found during a `--hidden` start, asked about when a window first opens. */
let deferredConflict = null;

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

/**
 * Ask /healthz who is listening. Returns the payload, or null when nothing
 * answers. The caller compares `pid` so an unrelated service squatting on the
 * port is never mistaken for our child.
 */
async function probeHealth(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === "opencodex" ? body : null;
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

/**
 * Wait for the replaced proxy to actually let go of the port.
 *
 * Polling `/healthz` rather than sleeping a fixed interval: a graceful shutdown
 * drains in-flight turns first, so how long it takes depends on what it was
 * doing. Giving up after the deadline is deliberate — `spawnProxy` will fail
 * loudly on a bound port, which is a better outcome than waiting forever with a
 * blank window.
 */
async function waitForPortFree(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeHealth(port))) return true;
    await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}

/**
 * Ask what to do about another build holding the port.
 *
 * A blocking dialog, and one of the few that earns it: it is a genuine decision
 * with no safe default. The copy names both builds, because "which one am I
 * looking at" is precisely what the user could not previously find out.
 */
async function promptProxyConflict(plan, port) {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Another opencodex is running",
    message: `Another opencodex is already using port ${port}.`,
    detail: describeConflict(ourStamp(), plan.theirs, port),
    buttons: ["Replace it with this build", "Open the running one", "Quit"],
    defaultId: 0,
    cancelId: 2,
    normalizeAccessKeys: true,
  });
  return response === 0 ? "replace" : response === 1 ? "adopt" : "cancel";
}

function spawnProxy(port) {
  const entry = join(ROOT, "bin", "ocx.mjs");
  if (!existsSync(entry)) {
    throw new Error(
      `The proxy launcher is missing from this build (expected ${entry}). `
      + "Reinstall opencodex, or report this if a fresh install does the same.",
    );
  }
  const child = spawn(process.execPath, [entry, "start", "--port", String(port)], {
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
 * Bring a proxy up on `port` and return once it is answering.
 *
 * If a healthy opencodex of *the same build* is already listening — the user
 * started one from the CLI, or this app is relaunching against the proxy it left
 * running — we attach to it rather than spawning a competitor, and leave it
 * running on quit because we did not start it.
 *
 * A *different* build holding the port is not adopted silently. That is what
 * made an update look like it had done nothing: the new app attached to the old
 * install's proxy and rendered the old install's `gui/dist`, with a version
 * string that read the same either way. The decision belongs to the user, so it
 * gets a real dialog — replacing another install's proxy can drop work it is
 * mid-way through, and continuing with it means not seeing the update.
 *
 * `askConflict` is injected so the startup path stays reachable without a dialog
 * (and so `--hidden` autostart can answer for itself rather than blocking on a
 * window nobody is looking at).
 */
async function ensureProxy(port, { askConflict = promptProxyConflict } = {}) {
  const existing = await probeHealth(port);
  const plan = planProxyAdoption(existing, ourStamp());

  if (plan.action === "adopt") {
    console.log(`[desktop] attaching to the opencodex already on :${port} (pid ${plan.pid})`);
    return { port, adopted: true };
  }

  if (plan.action === "conflict") {
    const choice = await askConflict(plan, port);
    if (choice === "adopt") {
      console.log(`[desktop] user kept the other build on :${port} (pid ${plan.pid})`);
      return { port, adopted: true, foreign: true };
    }
    if (choice === "cancel") throw new Error(`Port ${port} is held by another opencodex build.`);
    // "replace": stop the other proxy and take the port. Its own shutdown path
    // restores the native Codex config, so SIGTERM rather than a hard kill.
    if (plan.pid) {
      console.log(`[desktop] replacing the opencodex on :${port} (pid ${plan.pid})`);
      try { process.kill(plan.pid, "SIGTERM"); } catch { /* already gone, or not ours to signal */ }
      await waitForPortFree(port);
    }
  }

  proxy = spawnProxy(port);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!proxy) throw new Error("The proxy exited before it finished starting.");
    const health = await probeHealth(port);
    if (health) return { port, adopted: false };
    await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`The proxy did not answer /healthz on :${port} within ${STARTUP_TIMEOUT_MS / 1000}s.`);
}

function stopProxy() {
  if (!proxy) return;
  const child = proxy;
  proxy = null;
  // SIGTERM lets the proxy restore the native Codex config it swapped out.
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5000).unref?.();
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
    const health = await probeHealth(proxyPort);
    return { running: !!health, port: proxyPort, pid: health?.pid ?? null, managed: proxy !== null };
  });

  ipcMain.handle("proxy:start", async () => {
    const already = await probeHealth(proxyPort);
    if (already) return { ok: true, port: proxyPort, adopted: true };
    try {
      const result = await ensureProxy(proxyPort);
      return { ok: true, port: result.port, adopted: result.adopted };
    } catch (error) {
      // The renderer shows this verbatim, so it has to be a sentence a user can
      // act on rather than a stack frame.
      return { ok: false, error: String(error?.message ?? error) };
    }
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

function showWindow() {
  if (!mainWindow) {
    // A conflict deferred by `--hidden` is asked here, where there is finally
    // somebody to answer it. Cleared first so a declined prompt is not re-asked
    // on every tray click.
    if (deferredConflict) {
      const plan = deferredConflict;
      deferredConflict = null;
      void promptProxyConflict(plan, proxyPort).then(async choice => {
        if (choice !== "replace") return;
        // No pid means /healthz did not report one, so there is nothing to
        // signal and nothing to wait for — going ahead would burn the fifteen
        // second port-free timeout and then fail to bind, which reads to the
        // user as "Replace did nothing, slowly". `ensureProxy` guards the same
        // way on its own path.
        if (!plan.pid) {
          dialog.showErrorBox(
            "opencodex could not replace the running build",
            `The opencodex on port ${proxyPort} did not report a process id, so it cannot be asked to stop.`
            + " Quit it yourself and relaunch this app.",
          );
          return;
        }
        try { process.kill(plan.pid, "SIGTERM"); } catch { /* already gone */ }
        await waitForPortFree(proxyPort);
        try {
          proxy = spawnProxy(proxyPort);
          mainWindow?.webContents.reloadIgnoringCache();
        } catch (error) {
          dialog.showErrorBox("opencodex could not take over the port", String(error?.message ?? error));
        }
      });
    }
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
  // A login-item start goes to the tray with no window, so there is nobody to
  // answer a modal. It takes the old behaviour — attach and carry on — and
  // *remembers* that it did, so the question is asked the first time a window is
  // actually opened rather than dropped. Silently adopting and never mentioning
  // it is the original bug; deferring the question is not.
  const hidden = process.argv.includes("--hidden");
  try {
    const started = await ensureProxy(DEFAULT_PORT, hidden
      ? { askConflict: async plan => { deferredConflict = plan; return "adopt"; } }
      : {});
    proxyPort = started.port;
  } catch (error) {
    dialog.showErrorBox("opencodex could not start", String(error?.message ?? error));
    app.quit();
    return;
  }

  registerWindowIpc();
  buildAppMenu();
  buildTray();
  // `--hidden` is what the login item passes, so an auto-start boots to the tray.
  if (!process.argv.includes("--hidden")) createWindow(proxyPort);
});

app.on("window-all-closed", () => {
  // The tray keeps the app alive on every platform; without one, closing quits.
  if (!tray) { quitting = true; app.quit(); }
});

app.on("activate", showWindow);

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", stopProxy);
process.on("exit", stopProxy);
