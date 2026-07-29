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

import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const DEFAULT_PORT = Number(process.env.OPENCODEX_PORT || 10100);
const HOST = "127.0.0.1";
/** How long to wait for the spawned proxy to answer /healthz before giving up. */
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;

/** Single instance: a second launch focuses the existing window instead of racing for the port. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let proxy = null;
let proxyPort = DEFAULT_PORT;
/** True once the user has chosen Quit, so window-close stops meaning "hide to tray". */
let quitting = false;

function appVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function iconPath() {
  for (const candidate of [
    join(ROOT, "gui", "public", "favicon.png"),
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

function spawnProxy(port) {
  const entry = join(ROOT, "bin", "ocx.mjs");
  const child = spawn(process.execPath, [entry, "start", "--port", String(port)], {
    cwd: ROOT,
    // ELECTRON_RUN_AS_NODE makes the packaged Electron binary behave as plain Node
    // for the child, so the shim's own runtime detection is not confused by it.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
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
 * If a healthy opencodex is already listening — the user started one from the
 * CLI — we attach to it rather than spawning a competitor, and leave it running
 * on quit because we did not start it.
 */
async function ensureProxy(port) {
  const existing = await probeHealth(port);
  if (existing) {
    console.log(`[desktop] attaching to the opencodex already on :${port} (pid ${existing.pid})`);
    return { port, adopted: true };
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
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(HERE, "preload.mjs"),
      // The dashboard is ordinary web content; it gets no Node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(`http://${HOST}:${port}/`);

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
  if (!mainWindow) return createWindow(proxyPort);
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
  try {
    const started = await ensureProxy(DEFAULT_PORT);
    proxyPort = started.port;
  } catch (error) {
    dialog.showErrorBox("opencodex could not start", String(error?.message ?? error));
    app.quit();
    return;
  }

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
