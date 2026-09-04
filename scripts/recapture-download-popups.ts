/**
 * Recapture `assets/shots/download-start-popup.png` and
 * `download-complete-popup.png` from the real, fixed built artifact, through
 * the real Electron app — not a mock, not a static-served stub.
 *
 * This is the same live-flow discipline `scripts/capture-shots.ts` documents
 * at its own module top, applied to the two popup windows specifically:
 *
 *   - Isolates `OPENCODEX_HOME`, `CODEX_HOME` and `GROK_HOME` to a throwaway
 *     profile before Electron ever launches — an unset `OPENCODEX_HOME` falls
 *     back to this machine's real `~/.opencodex`, and a normal `ocx start`
 *     will rewrite `~/.grok/config.toml`/`~/.codex/config.toml` if either
 *     exists. Two agents working this exact codebase have accidentally
 *     mutated the operator's real config by skipping this.
 *   - Uses a scratch `--user-data-dir`, wiped every run.
 *   - Launches `electron/main.mjs` directly (not `electron .`).
 *
 * Where it differs from `capture-shots.ts`: it does not drive an actual
 * browser extension or a real internet download. It creates the download
 * record the SAME way the extension does — a POST to the real, loopback-only
 * `/api/downloads/capture` route, from inside the loaded page, same-origin —
 * and for the "complete" popup, points that download at a tiny asset the
 * app's own static server already ships (`/favicon.png`), so the transfer is
 * a real HTTP fetch through the real `src/lib/downloads/manager.ts` engine,
 * completing in well under a second, with no external network dependency and
 * nothing invented about the response. The browser-extension half of this
 * feature is exercised by `capture-shots.ts`'s own throwaway orchestrator
 * (see the commit that produced the ORIGINAL, broken versions of these two
 * PNGs); this script exists only to prove the CSS/window-size fix against the
 * exact same two popup windows.
 *
 * `defaultDownloadsDir()` is not scoped by `OPENCODEX_HOME` (see
 * `src/lib/downloads/paths.ts`) and always resolves to `os.homedir()`'s real
 * Downloads folder. Deleting the one file this script writes there and
 * verifying it is gone (every time, success or failure) is necessary but was
 * not sufficient: the deletion never undid the fact that the completed
 * transfer's destination path — the operator's real Windows username inside
 * it — had already been photographed into `download-complete-popup.png`
 * before the delete ever ran. `capture-env-privacy.ts`'s
 * `applyNeutralCaptureHome()`, called below before `os.homedir()` is ever
 * read, is what actually fixes that: it rehomes this whole process tree onto
 * `C:\Users\Public\...`, so `defaultDownloadsDir()` resolves to a neutral
 * path and the pixels never carry the real username in the first place. The
 * delete-and-verify step stays, unchanged, as real cleanup of a real write
 * outside the isolated profile — it was just never the privacy fix.
 *
 * Run it: `bun run scripts/recapture-download-popups.ts`
 * (build `gui/dist` first — `cd gui && bun run build`).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyNeutralCaptureHome } from "./capture-env-privacy";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "assets", "shots");
const PS_TOOL = join(ROOT, "scripts", "window-tools.ps1");
const PS_FIND = join(ROOT, "scripts", "popup-window-find.ps1");
const PROXY_PORT = Number(process.env.OCX_RECAPTURE_PORT || 10193);
const CDP_PORT = Number(process.env.OCX_RECAPTURE_CDP_PORT || 10194);

const RECAPTURE_TAG = "ocx-recapture-popup-fix-test";

/**
 * Rehome BEFORE `tmpdir()` is touched below — `os.tmpdir()` reads
 * `TEMP`/`TMP`, which default to the real `C:\Users\<operator>\...\Temp`.
 * The module doc comment above already names the exact defect this fixes:
 * `defaultDownloadsDir()` (`src/lib/downloads/paths.ts`) is not scoped by
 * `OPENCODEX_HOME`, so the "complete" popup's real confirmed transfer wrote
 * — and this script's own committed `download-complete-popup.png`
 * photographed — the operator's real Windows username before this line
 * existed. See `capture-env-privacy.ts` for the full account.
 */
const NEUTRAL = applyNeutralCaptureHome("ocx-recapture-privacy-home");

// -------------------------------------------------------------- isolation --

const scratchRoot = mkdtempSync(join(tmpdir(), "ocx-popup-recapture-"));
const CAPTURE_HOME = join(scratchRoot, "opencodex-home");
const CAPTURE_CODEX_HOME = join(scratchRoot, "codex-home");
const CAPTURE_GROK_HOME = join(scratchRoot, "grok-home");
const PROFILE = join(scratchRoot, "electron-profile");
for (const dir of [CAPTURE_HOME, CAPTURE_CODEX_HOME]) mkdirSync(dir, { recursive: true });

console.log(`isolated OPENCODEX_HOME=${CAPTURE_HOME}`);
console.log(`isolated CODEX_HOME=${CAPTURE_CODEX_HOME}`);
console.log(`isolated GROK_HOME=${CAPTURE_GROK_HOME} (left unwritten on purpose)`);
console.log(`neutral os.homedir()=${NEUTRAL.root} (real Downloads folder now resolves under this, not the real profile)`);

// ---------------------------------------------------------------- electron --

function pinnedElectronVersion(): string {
  const yml = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
  const found = /^electronVersion:\s*(\S+)\s*$/m.exec(yml);
  if (!found) throw new Error("electron-builder.yml does not pin an electronVersion");
  return found[1];
}

/**
 * `npx -p electron@version node -e "require('electron')"` (capture-shots.ts's
 * approach) resolves `require('electron')` relative to `process.cwd()`, not
 * to npx's temp install — verified against this exact host: it throws
 * `MODULE_NOT_FOUND` even with a warm npm cache. A real scratch `npm install`
 * plus a direct `require()` from inside that install directory is what
 * actually works here (also verified against this host — `require('electron')`
 * lazily triggers the binary download the first time it runs and prints the
 * resolved `electron.exe` path).
 */
function resolveElectron(): string {
  if (process.env.OCX_ELECTRON) return process.env.OCX_ELECTRON;
  const version = pinnedElectronVersion();
  const installDir = join(scratchRoot, "electron-install");
  mkdirSync(installDir, { recursive: true });
  const initRes = spawnSync("npm", ["init", "-y"], { cwd: installDir, encoding: "utf8", shell: true });
  if (initRes.status !== 0) throw new Error(`npm init failed:\n${initRes.stdout}\n${initRes.stderr}`);
  const installRes = spawnSync("npm", ["install", `electron@${version}`], { cwd: installDir, encoding: "utf8", shell: true });
  if (installRes.status !== 0) throw new Error(`npm install electron@${version} failed:\n${installRes.stdout}\n${installRes.stderr}`);
  const probe = spawnSync("node", ["-e", "console.log(require('electron'))"], { cwd: installDir, encoding: "utf8", shell: true });
  const path = (probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!path || !existsSync(path)) {
    throw new Error(
      `could not resolve electron@${version}.\n`
      + `  stdout: ${(probe.stdout || "").trim()}\n  stderr: ${(probe.stderr || "").trim()}\n`
      + "  Set OCX_ELECTRON to an electron binary to skip this lookup.",
    );
  }
  return path;
}

function powershell(scriptPath: string, args: string[]): string[] {
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { encoding: "utf8" },
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (res.status !== 0) throw new Error(`${scriptPath} ${args.join(" ")} failed:\n${out}`);
  const lines = out.split(/\r?\n/).filter(l => l.startsWith("OK"));
  if (!lines.length) throw new Error(`${scriptPath} printed no OK line:\n${out}`);
  return lines;
}

console.log("resolving electron…");
const electronBin = resolveElectron();
console.log(`electron: ${electronBin}`);

rmSync(PROFILE, { recursive: true, force: true });

const child = spawn(electronBin, [
  join(ROOT, "electron", "main.mjs"),
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    OPENCODEX_PORT: String(PROXY_PORT),
    OPENCODEX_HOME: CAPTURE_HOME,
    CODEX_HOME: CAPTURE_CODEX_HOME,
    GROK_HOME: CAPTURE_GROK_HOME,
  },
  stdio: "ignore",
});
console.log(`electron pid=${child.pid}`);

// ------------------------------------------------------------------- CDP --

let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function connect(wsUrl: string): WebSocket {
  const socket = new WebSocket(wsUrl);
  socket.addEventListener("message", ev => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (msg.id == null || !pending.has(msg.id)) return;
    const slot = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });
  return socket;
}
function send(socket: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(socket: WebSocket, expression: string): Promise<any> {
  const res = await send(socket, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text ?? JSON.stringify(res.exceptionDetails));
  return res?.result?.value;
}

async function waitOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("cdp socket failed to open")), { once: true });
  });
}

async function findMainPageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && t.url.includes(`:${PROXY_PORT}`) && !t.url.includes("popup="));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await Bun.sleep(500);
  }
  throw new Error(`no main-window CDP page target on :${CDP_PORT} after 60s`);
}

async function findPopupTarget(kindHash: string): Promise<{ ws: string; targetId: string } | null> {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const list = (await res.json()) as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>;
  const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && t.url.includes(kindHash));
  return page?.webSocketDebuggerUrl ? { ws: page.webSocketDebuggerUrl, targetId: page.id } : null;
}

interface FoundWindow { hwnd: number; title: string; w: number; h: number }

function listTopLevelWindows(pid: number): FoundWindow[] {
  return powershell(PS_FIND, ["-OwnerPid", String(pid)]).map(line => {
    const parts = line.split("\t");
    return {
      hwnd: Number(parts[0].replace(/^OK\s+/, "")),
      title: parts[1] ?? "",
      w: Number(parts[2] ?? 0),
      h: Number(parts[3] ?? 0),
    };
  });
}

/**
 * Find the popup `BrowserWindow` by elimination rather than by its
 * `electron/main.mjs`-declared title.
 *
 * Chromium syncs a `BrowserWindow`'s title to the loaded page's
 * `document.title` by default the moment the page sets one, and this app's
 * pages do (`opencodex · proxy dashboard`, route-specific titles) — so the
 * `title: "opencodex — Start download"` option passed at construction is
 * overwritten within the same tick the page finishes its first render, before
 * this script ever gets to read it back. Confirmed live against this exact
 * build: the popup opened with the exact requested 360x260 client size, but
 * its title read "opencodex · proxy dashboard", not "Start download".
 * Diffing against the window set that existed BEFORE `openPopup()` was called
 * sidesteps that entirely — whatever title Chromium settles on, the popup is
 * still the one hwnd that is new.
 */
async function findNewWindow(pid: number, priorHwnds: ReadonlySet<number>): Promise<FoundWindow> {
  let lastSeen: FoundWindow[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const windows = listTopLevelWindows(pid);
      lastSeen = windows;
      const fresh = windows.filter(w => !priorHwnds.has(w.hwnd));
      if (fresh.length === 1) return fresh[0];
      if (fresh.length > 1) {
        throw new Error(`expected exactly one new window, found ${fresh.length}: ${JSON.stringify(fresh)}`);
      }
    } catch (err) {
      if (String(err).includes("expected exactly one")) throw err;
      lastSeen = [];
    }
    await Bun.sleep(300);
  }
  throw new Error(`no new top-level window for pid ${pid} after 12s. Last seen:\n${JSON.stringify(lastSeen, null, 2)}`);
}

let leftoverFile: string | null = null;

async function main() {
  console.log("waiting for main window CDP target…");
  const mainWs = await findMainPageTarget();
  const main = connect(mainWs);
  await waitOpen(main);
  await send(main, "Page.enable");
  await send(main, "Runtime.enable");

  // Give the renderer time to mount, fetch its bootstrap state, and apply
  // tokens — the same settle window capture-shots.ts uses.
  await Bun.sleep(2000);

  const origin = await evaluate(main, "window.location.origin");
  console.log(`main window origin: ${origin}`);

  // ---- 1. Start popup: a real queued record, never confirmed. -----------
  console.log("\n--- capturing download-start-popup.png ---");
  const startId = await evaluate(main, `(async () => {
    const res = await fetch("/api/downloads/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: ${JSON.stringify("https://cdn.example.com/releases/opencodex/opencodex-portable-x64.exe")},
        suggestedFilename: ${JSON.stringify(`${RECAPTURE_TAG}.exe`)},
        pageUrl: window.location.href,
        mimeType: "application/octet-stream",
      }),
    });
    if (!res.ok) throw new Error("capture failed: " + res.status + " " + await res.text());
    const record = await res.json();
    return record.id;
  })()`);
  console.log(`created queued record ${startId}`);

  const beforeStart = new Set(listTopLevelWindows(child.pid!).map(w => w.hwnd));
  await evaluate(main, `window.opencodexDesktop.downloads.openPopup("start", ${JSON.stringify(startId)})`);
  console.log("opened start popup window, locating its hwnd…");
  const startWindow = await findNewWindow(child.pid!, beforeStart);
  const startHwnd = startWindow.hwnd;
  console.log(`start popup hwnd=${startHwnd} title="${startWindow.title}" ${startWindow.w}x${startWindow.h}, fitting + capturing`);
  powershell(PS_TOOL, ["-Action", "fit", "-Hwnd", String(startHwnd), "-Width", "360", "-Height", "260"]);
  await Bun.sleep(400);

  const startTarget = await findPopupTarget("popup=start");
  if (startTarget) {
    const popupSocket = connect(startTarget.ws);
    await waitOpen(popupSocket);
    await send(popupSocket, "Runtime.enable");
    const measured = await evaluate(popupSocket, `(() => {
      const box = sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || "").trim() };
      };
      return {
        tokensApplied: !!getComputedStyle(document.documentElement).getPropertyValue('--m3-primary').trim(),
        file: box('.m3-dlpopup__file'),
        url: box('.m3-dlpopup__url'),
      };
    })()`);
    console.log(`  live start-popup measurement: ${JSON.stringify(measured)}`);
    popupSocket.close();
  } else {
    console.log("  (could not attach CDP to the start popup's own target — hwnd capture still proceeds)");
  }

  const startShot = join(OUT, "download-start-popup.png");
  powershell(PS_TOOL, ["-Action", "capture", "-Hwnd", String(startHwnd), "-Out", startShot]);
  console.log(`wrote ${startShot}`);

  // ---- 2. Complete popup: a real, tiny, same-origin download. -----------
  console.log("\n--- capturing download-complete-popup.png ---");
  const completeId = await evaluate(main, `(async () => {
    const res = await fetch("/api/downloads/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: window.location.origin + "/favicon.png",
        suggestedFilename: ${JSON.stringify(`${RECAPTURE_TAG}.png`)},
        pageUrl: window.location.href,
        mimeType: "image/png",
      }),
    });
    if (!res.ok) throw new Error("capture failed: " + res.status + " " + await res.text());
    const record = await res.json();
    return record.id;
  })()`);
  console.log(`created queued record ${completeId}, confirming…`);
  await evaluate(main, `(async () => {
    const res = await fetch("/api/downloads/${completeId}/confirm", { method: "POST" });
    if (!res.ok) throw new Error("confirm failed: " + res.status + " " + await res.text());
  })()`);

  // Poll until the real transfer engine reports it finished — this is the
  // ACTUAL fetch/write/rename completing, not a timer.
  let finalState = "";
  for (let i = 0; i < 40; i++) {
    finalState = await evaluate(main, `(async () => {
      const res = await fetch("/api/downloads/${completeId}");
      const record = await res.json();
      return record.state;
    })()`);
    if (finalState === "completed" || finalState === "error") break;
    await Bun.sleep(250);
  }
  console.log(`download ${completeId} reached state "${finalState}"`);
  if (finalState !== "completed") throw new Error(`recapture download never completed (state=${finalState})`);

  const destinationPath = await evaluate(main, `(async () => {
    const res = await fetch("/api/downloads/${completeId}");
    const record = await res.json();
    return record.destinationPath;
  })()`);
  console.log(`real destination path: ${destinationPath}`);
  if (destinationPath) leftoverFile = destinationPath;

  const beforeComplete = new Set(listTopLevelWindows(child.pid!).map(w => w.hwnd));
  const openResult = await evaluate(main, `window.opencodexDesktop.downloads.openPopup("complete", ${JSON.stringify(completeId)})`);
  console.log(`openPopup("complete", …) returned: ${JSON.stringify(openResult)}`);
  console.log("opened complete popup window, locating its hwnd…");
  // Diagnostic independent of Win32 window visibility — CDP target listing
  // reflects every webContents the moment it exists, shown or not.
  await Bun.sleep(500);
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as Array<{ type: string; url: string }>;
    console.log(`CDP targets right after openPopup("complete"): ${JSON.stringify(targets.map(t => ({ type: t.type, url: t.url })))}`);
  } catch (err) { console.log(`(CDP target list probe failed: ${err})`); }
  // Auto-dismisses after AUTO_CLOSE_MS (8s) — move fast.
  const completeWindow = await findNewWindow(child.pid!, beforeComplete);
  const completeHwnd = completeWindow.hwnd;
  console.log(`complete popup hwnd=${completeHwnd} title="${completeWindow.title}" ${completeWindow.w}x${completeWindow.h}, fitting + capturing`);
  powershell(PS_TOOL, ["-Action", "fit", "-Hwnd", String(completeHwnd), "-Width", "360", "-Height", "230"]);
  await Bun.sleep(300);

  const completeTarget = await findPopupTarget("popup=complete");
  if (completeTarget) {
    const popupSocket = connect(completeTarget.ws);
    await waitOpen(popupSocket);
    await send(popupSocket, "Runtime.enable");
    const measured = await evaluate(popupSocket, `(() => {
      const box = sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || "").trim() };
      };
      return {
        tokensApplied: !!getComputedStyle(document.documentElement).getPropertyValue('--m3-primary').trim(),
        file: box('.m3-dlpopup__file'),
        url: box('.m3-dlpopup__url'),
      };
    })()`);
    console.log(`  live complete-popup measurement: ${JSON.stringify(measured)}`);
    popupSocket.close();
  } else {
    console.log("  (could not attach CDP to the complete popup's own target — hwnd capture still proceeds)");
  }

  const completeShot = join(OUT, "download-complete-popup.png");
  powershell(PS_TOOL, ["-Action", "capture", "-Hwnd", String(completeHwnd), "-Out", completeShot]);
  console.log(`wrote ${completeShot}`);

  main.close();
}

try {
  await main();
  console.log("\nrecapture succeeded.");
} finally {
  console.log("\nshutting down electron…");
  if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await Bun.sleep(500);
  // Best-effort: a just-killed Chromium/Electron helper process (GPU,
  // crashpad) can hold a file handle open in the profile dir for a moment
  // after taskkill returns. Losing this scratch directory is not worth
  // failing the whole recapture over, and it is in %TEMP% regardless.
  try { rmSync(scratchRoot, { recursive: true, force: true }); }
  catch (err) { console.error(`(non-fatal) could not fully remove scratch dir ${scratchRoot}: ${err}`); }

  // `defaultDownloadsDir()` is not scoped by OPENCODEX_HOME (see
  // src/lib/downloads/paths.ts) — the confirmed transfer above really did
  // land in `os.homedir()`'s real Downloads folder, which `NEUTRAL.root`
  // above has already rehomed to `C:\Users\Public\...` rather than the
  // operator's real profile. Delete it, and every "(1)", "(2)", … collision
  // variant a repeated run of this script could have left behind, then
  // verify none remain.
  const downloadsDir = NEUTRAL.downloads;
  const leftovers: string[] = [];
  try {
    for (const name of readdirSync(downloadsDir)) {
      if (name.startsWith(RECAPTURE_TAG)) leftovers.push(join(downloadsDir, name));
    }
  } catch { /* Downloads dir unreadable/missing — nothing to clean up */ }
  if (leftoverFile && existsSync(leftoverFile) && !leftovers.includes(leftoverFile)) leftovers.push(leftoverFile);

  for (const path of leftovers) {
    try { unlinkSync(path); console.log(`deleted real-Downloads leftover: ${path}`); }
    catch (err) { console.error(`FAILED to delete ${path}: ${err}`); }
  }
  const stillThere = leftovers.filter(p => existsSync(p));
  if (stillThere.length) {
    console.error(`WARNING: ${stillThere.length} recapture file(s) still present in the real Downloads folder: ${stillThere.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`verified: no "${RECAPTURE_TAG}*" file remains in the real Downloads folder.`);
  }
}
