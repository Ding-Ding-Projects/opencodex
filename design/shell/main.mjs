/**
 * DESIGN-COMPARISON SHELL ONLY -- not part of the shipped opencodex app.
 *
 * A plain, minimal Electron window whose only job is to render
 * `design/OpenCodex M3.dc.html` (the Material 3 design prototype) honestly, at
 * whatever size the caller asks for, so it can be photographed and compared
 * side by side with the real app's own screenshots
 * (`scripts/capture-shots.ts` / `assets/shots/`).
 *
 * It has no menu, no chrome, no IPC, no proxy, no persistence beyond what the
 * prototype itself keeps in `localStorage`, and it is never packaged or
 * referenced by `electron-builder.yml`. Nothing here should grow product
 * behavior -- if it needs a feature, that feature belongs in the real app.
 *
 * ## Why a local HTTP server instead of a bare `file://` load
 *
 * `design/support.js` resolves `./ocx-data.js` and `./ocx-i18n.js` through
 * dynamic `import()`. Chromium's ES-module loader is markedly more reliable
 * over http(s) than over `file://` (module fetches go through the same
 * CORS-shaped checks as any other module request, and a `file://` origin can
 * trip "not allowed to load local resource" in ways an ordinary `<script src>`
 * load never would). Serving the prototype's own directory over a throwaway
 * loopback server sidesteps that class of failure entirely, and costs nothing
 * else: the prototype's Google Fonts `<link>` is an outbound HTTPS request
 * either way, unaffected by which local origin loaded the page.
 *
 * ## Sizing
 *
 * This file does not try to be pixel-exact on its own. It opens a reasonable
 * default window; a caller that needs the exact client-area size the app's own
 * capture harness uses (see `scripts/capture-shots.ts`'s `DESKTOP` viewport) is
 * expected to resize the real OS window afterward, the same way
 * `scripts/window-tools.ps1` does for the product screenshots. Two environment
 * variables let a caller skip that step when it does not need to:
 *
 *   OCX_DESIGN_WIDTH / OCX_DESIGN_HEIGHT  - initial content-area size, in CSS
 *     pixels (`useContentSize: true`, so these are the exact web-content
 *     dimensions Chromium lays out against -- not the outer window including
 *     any OS chrome). Defaults to 1440x900, the prototype's own declared
 *     `$preview` size and the app capture harness's `DESKTOP.css`.
 */

import { app, BrowserWindow, Menu } from "electron";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** `design/shell/main.mjs` -> `design/` (the prototype's own directory). */
const DESIGN_ROOT = normalize(join(HERE, ".."));
const ENTRY = "OpenCodex M3.dc.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** A tiny static file server rooted at `design/`. Nothing but `GET` a file. */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/" || rel === "") rel = "/" + ENTRY;
        const target = normalize(join(DESIGN_ROOT, rel));
        // Refuse to serve anything outside design/ (e.g. a `..` escape).
        if (!(target === DESIGN_ROOT || target.startsWith(DESIGN_ROOT + sep))) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const info = await stat(target).catch(() => null);
        if (!info || !info.isFile()) {
          res.writeHead(404).end("not found: " + rel);
          return;
        }
        const body = await readFile(target);
        res.writeHead(200, {
          "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500).end(String(err && err.stack || err));
      }
    });
    server.on("error", reject);
    // Port 0: let the OS pick a free loopback port. This shell is never meant
    // to be reached by anything but the window it opens for itself.
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const CSS_WIDTH = Number(process.env.OCX_DESIGN_WIDTH || 1440);
const CSS_HEIGHT = Number(process.env.OCX_DESIGN_HEIGHT || 900);

let win = null;
let server = null;

app.whenReady().then(async () => {
  // No File/Edit/View/Window/Help bar, no chrome of any kind beyond the OS's
  // own default window frame -- and nothing here would show up in a capture
  // anyway, since the harness photographs only the client area (see
  // `scripts/window-tools.ps1`'s `PW_CLIENTONLY` comment).
  Menu.setApplicationMenu(null);

  server = await startStaticServer();
  const { port } = server.address();

  win = new BrowserWindow({
    width: CSS_WIDTH,
    height: CSS_HEIGHT,
    // The web-content area is exactly width x height in CSS pixels; the OS
    // frame (if any) is added on top rather than eating into it. This is what
    // makes the size promised by OCX_DESIGN_WIDTH/HEIGHT exact instead of
    // approximate.
    useContentSize: true,
    autoHideMenuBar: true,
    show: true,
    resizable: true,
    webPreferences: { devTools: false, contextIsolation: true, nodeIntegration: false },
  });

  await win.loadURL(`http://127.0.0.1:${port}/${encodeURIComponent(ENTRY)}`);
});

app.on("window-all-closed", () => {
  server?.close();
  app.quit();
});
