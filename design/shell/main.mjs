/**
 * DESIGN-COMPARISON SHELL ONLY -- not part of the shipped opencodex app.
 *
 * This is the plain Electron renderer for the checked-in design reference. It
 * deliberately does not edit or reinterpret the visual source. Capture input
 * is supplied as an exact route tuple and recorded in a receipt so a later
 * parity run can prove which source, fixture, font set, and runtime it saw.
 */

import { app, BrowserWindow, Menu, session } from "electron";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_SOURCE_ROOT = normalize(join(HERE, ".."));
const VENDOR_ROOT = normalize(join(HERE, "vendor"));
const ENTRY = "OpenCodex M3.dc.html";
const ROUTES_FILE = join(HERE, "routes.json");
const DEFAULT_CONFIG = {
  screen: "dashboard",
  state: "overview",
  theme: "light",
  width: 1440,
  height: 900,
  scale: 1,
  locale: "en",
  seed: "2F6B4F",
  fixedTimeMs: Date.parse("2026-07-29T12:00:00.000Z"),
  timezone: "UTC",
  fixtureRevision: "design-fixture-v1",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function jsonConfig() {
  const raw = process.env.OCX_DESIGN_CAPTURE_CONFIG;
  if (!raw) return { ...DEFAULT_CONFIG };
  let supplied;
  try { supplied = JSON.parse(raw); } catch (error) {
    throw new Error(`OCX_DESIGN_CAPTURE_CONFIG is not valid JSON: ${String(error)}`);
  }
  return { ...DEFAULT_CONFIG, ...supplied };
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

/** Resolve one exact, addressable screen/state/theme/viewport/scale/locale tuple. */
export async function resolveCaptureRoute(config = jsonConfig()) {
  const routes = JSON.parse(await readFile(ROUTES_FILE, "utf8"));
  const screen = String(config.screen);
  const state = String(config.state);
  const theme = String(config.theme);
  const locale = String(config.locale);
  const route = routes.screens?.[screen];
  if (!route || !Array.isArray(route.states) || !route.states.includes(state)) {
    throw new Error(`unknown design-reference screen/state: ${screen}/${state}`);
  }
  if (!routes.themes.includes(theme)) throw new Error(`theme is not addressable: ${theme}`);
  if (!routes.locales.includes(locale)) throw new Error(`locale is not addressable: ${locale}`);
  const width = integer(Number(config.width), "viewport.width", 320, 4096);
  const height = integer(Number(config.height), "viewport.height", 240, 4096);
  const scale = Number(config.scale);
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error("scale must be between 1 and 4");
  const fixedTimeMs = Number(config.fixedTimeMs);
  if (!Number.isFinite(fixedTimeMs)) throw new Error("fixedTimeMs must be finite");
  const seed = String(config.seed || "").replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(seed)) throw new Error("seed must be a six-digit hexadecimal color");
  const timezone = String(config.timezone || "UTC");
  const fixtureRevision = String(config.fixtureRevision || "");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(fixtureRevision)) throw new Error("fixtureRevision is not bounded");
  const query = new URLSearchParams({ screen, state, theme, viewport: `${width}x${height}`, scale: String(scale), locale });
  return {
    screen, state, theme, locale,
    viewport: { width, height },
    scale, seed: `#${seed.toUpperCase()}`, fixedTimeMs, timezone, fixtureRevision,
    query: `?${query.toString()}`,
  };
}

function sourceCommit(sourceRoot) {
  try {
    return execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}

async function manifestReceipt() {
  const path = join(VENDOR_ROOT, "manifest.json");
  const bytes = await readFile(path);
  const manifest = JSON.parse(bytes.toString("utf8"));
  return { path: "design/shell/vendor/manifest.json", sha256: createHash("sha256").update(bytes).digest("hex"), version: manifest.version, assets: manifest.assets };
}

function assetRedirects(manifest, port) {
  const redirects = new Map();
  for (const asset of manifest.assets || []) {
    if (!asset.sourceUrl || !asset.localPath) continue;
    redirects.set(asset.sourceUrl, `http://127.0.0.1:${port}/__design-vendor/${asset.localPath.replace(/\\/g, "/")}`);
  }
  return redirects;
}

// Named explicitly so the no-CDN contract remains reviewable in source.
const REMOTE_ASSET_REDIRECTS = assetRedirects;

function isOwnedLocalUrl(raw, port) {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && String(url.port) === String(port);
  } catch { return false; }
}

/** A static server for the original source plus explicitly vendored assets. */
function startStaticServer(sourceRoot, portRef) {
  return new Promise((resolveServer, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let targetRoot = sourceRoot;
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/" || rel === "") rel = "/" + ENTRY;
        if (rel.startsWith("/__design-vendor/")) {
          targetRoot = VENDOR_ROOT;
          rel = rel.slice("/__design-vendor/".length);
        } else {
          rel = rel.replace(/^\/+/, "");
        }
        const target = normalize(join(targetRoot, rel));
        if (!(target === targetRoot || target.startsWith(targetRoot + sep))) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const info = await stat(target).catch(() => null);
        if (!info || !info.isFile()) { res.writeHead(404).end("not found"); return; }
        const body = await readFile(target);
        res.writeHead(200, { "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(body);
      } catch (error) {
        res.writeHead(500).end(String(error && error.stack || error));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("static server did not expose a port"));
      portRef.port = address.port;
      resolveServer(server);
    });
  });
}

async function writeCaptureReceipt(receiptPath, receipt) {
  if (!receiptPath) return;
  await writeFile(resolve(receiptPath), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
}

const config = jsonConfig();
const sourceRoot = normalize(resolve(process.env.OCX_DESIGN_SOURCE_ROOT || DEFAULT_SOURCE_ROOT));
const captureReceiptPath = process.env.OCX_DESIGN_RECEIPT;
const portRef = { port: 0 };
const routePromise = resolveCaptureRoute(config);

// These switches are process-wide and must be installed before app readiness.
app.commandLine.appendSwitch("force-time-zone", String(config.timezone || "UTC"));
app.commandLine.appendSwitch("lang", String(config.locale || "en"));
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-features", "MediaRouter,OptimizationHints,AutofillServerCommunication");

let win = null;
let server = null;

app.whenReady().then(async () => {
  const route = await routePromise;
  const manifest = JSON.parse(await readFile(join(VENDOR_ROOT, "manifest.json"), "utf8"));
  Menu.setApplicationMenu(null);
  server = await startStaticServer(sourceRoot, portRef);
  const port = portRef.port;
  const redirects = REMOTE_ASSET_REDIRECTS(manifest, port);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    const redirect = redirects.get(details.url.split("#", 1)[0]);
    if (redirect) { callback({ redirectURL: redirect }); return; }
    if (isOwnedLocalUrl(details.url, port) || details.url.startsWith("data:") || details.url.startsWith("blob:")) { callback({}); return; }
    callback({ cancel: true });
  });

  const expectedUrl = `http://127.0.0.1:${port}/${encodeURIComponent(ENTRY)}${route.query}`;
  const receipt = {
    version: 1,
    sourceCommit: sourceCommit(sourceRoot),
    sourceRoot: "design/",
    entry: ENTRY,
    route: { screen: route.screen, state: route.state, theme: route.theme, viewport: route.viewport, scale: route.scale, locale: route.locale },
    fixtureRevision: route.fixtureRevision,
    seed: route.seed,
    fixedTimeMs: route.fixedTimeMs,
    timezone: route.timezone,
    expectedUrl,
    network: { allowAmbientNetwork: false, redirects: [...redirects.keys()], localVendorOnly: true },
    fonts: await manifestReceipt(),
    tools: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, bun: process.env.BUN_VERSION || "not-used" },
  };
  await writeCaptureReceipt(captureReceiptPath, receipt);

  win = new BrowserWindow({
    width: route.viewport.width,
    height: route.viewport.height,
    useContentSize: true,
    autoHideMenuBar: true,
    show: true,
    resizable: false,
    webPreferences: { devTools: false, contextIsolation: false, nodeIntegration: false, sandbox: false, preload: join(HERE, "preload.mjs"), additionalArguments: [`--ocx-capture-config=${Buffer.from(JSON.stringify(route)).toString("base64url")}`] },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await win.loadURL(expectedUrl);
});

app.on("window-all-closed", () => { server?.close(); app.quit(); });
