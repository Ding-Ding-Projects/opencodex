/**
 * DESIGN-COMPARISON CAPTURE ONLY -- not part of the shipped opencodex app,
 * not run in CI, not referenced by `npm run` scripts. It exists purely so the
 * Material 3 design prototype (`design/OpenCodex M3.dc.html`) can be
 * photographed at the exact window size `scripts/capture-shots.ts` uses for
 * the real app, and the two sets of images compared side by side.
 *
 * It launches `design/shell/main.mjs` -- a plain Electron shell whose only job
 * is to render the prototype -- fits its real OS window to the app capture
 * harness's own `DESKTOP` viewport, clicks through the prototype's own nav
 * rail to reach each of its 19 pages, and photographs the real window via the
 * same `scripts/window-tools.ps1` Win32 `PrintWindow` route the app harness
 * uses (never `Page.captureScreenshot`, for the same reason documented there:
 * it renders web contents only, so it cannot prove a real OS window opened at
 * a real size).
 *
 * ## Why it verifies before writing
 *
 * `scripts/capture-shots.ts`'s whole module doc comment exists because six
 * shots were once committed under the wrong names after a click that didn't
 * do what was expected. The design prototype is a different codebase with a
 * different failure shape -- its `<sc-if>` genuinely unmounts an inactive
 * page rather than hiding it, so there is no "closed dialog still in the DOM"
 * trap here -- but "the click silently missed and the previous page was still
 * on screen" is still possible, and a screenshot cannot look wrong about its
 * own filename. So every capture asserts that exactly one of the prototype's
 * 19 `[data-screen-label]` page sections is present and visible, and that its
 * label is the one this target claims, before the shutter fires.
 *
 * ## Fonts
 *
 * The prototype loads Material Symbols Rounded, Roboto Flex, Roboto Mono and
 * Noto Sans HK from Google Fonts over the network (see the `<link>` in the
 * `.dc.html`'s `<helmet>`). The shipped app bundles its own copies of the
 * latter three and never loads Material Symbols at all (its icons are hand
 * -authored SVGs generated from the same glyph geometry -- see
 * `gui/src/icons.tsx`'s header comment). This script checks
 * `document.fonts.check(...)` for all four after load and prints the result
 * loudly: a prototype capture that fell back to a system face would make every
 * pixel comparison downstream worthless, silently.
 *
 * ## Running it
 *
 *   bun run scripts/design-capture-shots.ts
 *
 * It resolves the same pinned Electron version `electron-builder.yml` and
 * `scripts/capture-shots.ts` use, launches the shell, sizes the window,
 * captures every page, and kills what it started. It writes a JSON summary to
 * `node_modules/.cache/ocx-design-capture-result.json` and a line-by-line log
 * to `node_modules/.cache/ocx-design-capture.log`, because this script is
 * designed to also run detached (e.g. on an off-screen desktop where nothing
 * reads its stdout) -- both files are the only way to learn what happened.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "assets", "design-shots");
const PS_TOOL = join(ROOT, "scripts", "window-tools.ps1");
const DESIGN_ROOT = join(ROOT, "design");
const SHELL_MAIN = join(DESIGN_ROOT, "shell", "main.mjs");
const PROFILE = join(ROOT, "node_modules", ".cache", "ocx-design-capture-profile");
const CDP_PORT = Number(process.env.OCX_DESIGN_CDP_PORT || 9224);

const LOG_FILE = join(ROOT, "node_modules", ".cache", "ocx-design-capture.log");
const RESULT_FILE = join(ROOT, "node_modules", ".cache", "ocx-design-capture-result.json");

/**
 * The window size the app's own capture harness uses for its `DESKTOP`
 * viewport (`scripts/capture-shots.ts`): 1440x900 CSS pixels at a forced
 * device-scale-factor of 2, i.e. a 2880x1800 physical-pixel window. Matching
 * it exactly is the entire point of this script -- it is what makes "the same
 * size" true rather than approximate.
 */
const CSS = { width: 1440, height: 900 } as const;
const SCALE = 2;
const PIXELS = { width: CSS.width * SCALE, height: CSS.height * SCALE } as const;

// ------------------------------------------------------------------ logging

mkdirSync(join(ROOT, "node_modules", ".cache"), { recursive: true });
writeFileSync(LOG_FILE, "");
function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_FILE, stamped + "\n");
}

// ------------------------------------------------------------- electron path

/**
 * Resolves the pinned Electron binary the same way
 * `scripts/capture-shots.ts` does -- via `npx -p electron@<version>` rather
 * than a repo dependency, since Electron is deliberately not one -- but
 * differently *how* it reads the answer back.
 *
 * `npx --yes -p electron@<version> node -e "console.log(require('electron'))"`
 * does not chdir into the package it just installed (verified against this
 * machine's npm 11.17: `process.cwd()` inside that `-e` string is still the
 * caller's own cwd), so `require('electron')` fails to resolve from there with
 * `MODULE_NOT_FOUND` -- there is no local `node_modules/electron` to find,
 * deliberately. The npx *install* still lands correctly, into npm's own
 * `_npx/<hash>/node_modules/electron` cache directory; this just reads the
 * result off disk afterward instead of asking a freshly spawned `node -e` to
 * self-report a path it cannot actually see.
 */
function resolveElectron(): string {
  if (process.env.OCX_ELECTRON) return process.env.OCX_ELECTRON;

  const yml = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
  const found = /^electronVersion:\s*(\S+)\s*$/m.exec(yml);
  if (!found) throw new Error("electron-builder.yml does not pin an electronVersion");
  const version = found[1];

  log(`resolving electron@${version} via npx (idempotent if already cached)...`);
  const install = spawnSync("npx", ["--yes", "-p", `electron@${version}`, "node", "-e", "0"], {
    encoding: "utf8",
    shell: true,
  });
  if (install.status !== 0) {
    throw new Error(
      `npx could not install electron@${version}.\n  stdout: ${(install.stdout || "").trim()}\n  stderr: ${(install.stderr || "").trim()}`,
    );
  }

  const cacheRootRes = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf8", shell: true });
  const cacheRoot = (cacheRootRes.stdout || "").trim();
  const npxRoot = join(cacheRoot, "_npx");
  if (!existsSync(npxRoot)) {
    throw new Error(`npm's npx cache (${npxRoot}) does not exist after a successful install`);
  }

  for (const entry of readdirSync(npxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(npxRoot, entry.name, "node_modules", "electron", "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let pkg: { version?: string };
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }
    if (pkg.version !== version) continue;
    const exe = join(npxRoot, entry.name, "node_modules", "electron", "dist", "electron.exe");
    if (existsSync(exe)) {
      log(`resolved electron@${version} -> ${exe}`);
      return exe;
    }
  }
  throw new Error(`installed electron@${version} via npx but could not find electron.exe under ${npxRoot}`);
}

// -------------------------------------------------------------- window-tools

function powershell(args: string[]): string {
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_TOOL, ...args],
    { encoding: "utf8" },
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (res.status !== 0) throw new Error(`window-tools ${args[1]} failed: ${out}`);
  const ok = out.split(/\r?\n/).find(l => l.startsWith("OK "));
  if (!ok) throw new Error(`window-tools ${args[1]} printed no OK line: ${out}`);
  return ok;
}

// ------------------------------------------------------------------ CDP client

let socket: WebSocket;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
    watchdog.unref?.();
    pending.set(id, {
      resolve: v => { clearTimeout(watchdog); resolve(v); },
      reject: e => { clearTimeout(watchdog); reject(e); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "page threw");
  return res.result?.value;
}

const lit = (v: unknown) => JSON.stringify(v);

async function connectCdp(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"));
      if (page?.webSocketDebuggerUrl) {
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("CDP socket failed to open")), { once: true });
        });
        socket.addEventListener("message", ev => {
          const msg = JSON.parse(String(ev.data));
          const slot = pending.get(msg.id);
          if (!slot) return;
          pending.delete(msg.id);
          if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`));
          else slot.resolve(msg.result);
        });
        return;
      }
    } catch { /* not listening yet */ }
    await Bun.sleep(500);
  }
  throw new Error(`no CDP page target on :${CDP_PORT} after 60s`);
}

// --------------------------------------------------------------------- targets

/**
 * The prototype's 19 pages, in the order its own nav rail lists them
 * (`this.PAGES` in the `.dc.html`'s component script). `navLabel` is what the
 * nav rail button's `title` attribute (and, at this window width, its visible
 * text) reads in the prototype's default `en` locale (`design/ocx-i18n.js`'s
 * `nav.*` keys). `sectionLabel` is the exact `data-screen-label` the page's
 * own `<section>` carries -- written down here, not read back from the app,
 * for the same reason `scripts/capture-shots.ts`'s `ROUTE_HEADINGS` is: so a
 * copy change breaks this loudly instead of silently redefining what each
 * screenshot is allowed to contain. A few genuinely differ from the nav label
 * (`api` / "API access", `logs` / "Logs and Debug", `startup` / "Startup
 * safety") -- that split is in the prototype's own markup, not a typo here.
 */
interface Target { id: string; navLabel: string; sectionLabel: string }

const TARGETS: Target[] = [
  { id: "dashboard", navLabel: "Dashboard", sectionLabel: "Dashboard" },
  { id: "codex-auth", navLabel: "Codex Auth", sectionLabel: "Codex Auth" },
  { id: "providers", navLabel: "Providers", sectionLabel: "Providers" },
  { id: "models", navLabel: "Models", sectionLabel: "Models" },
  { id: "combos", navLabel: "Combos", sectionLabel: "Combos" },
  { id: "subagents", navLabel: "Subagents", sectionLabel: "Subagents" },
  { id: "logs", navLabel: "Logs & Debug", sectionLabel: "Logs and Debug" },
  { id: "usage", navLabel: "Usage", sectionLabel: "Usage" },
  { id: "storage", navLabel: "Storage", sectionLabel: "Storage" },
  { id: "api", navLabel: "API", sectionLabel: "API access" },
  { id: "claude", navLabel: "Claude", sectionLabel: "Claude" },
  { id: "grok", navLabel: "Grok", sectionLabel: "Grok" },
  { id: "startup", navLabel: "Startup", sectionLabel: "Startup safety" },
  { id: "appearance", navLabel: "Appearance", sectionLabel: "Appearance" },
  { id: "language", navLabel: "Language & voice", sectionLabel: "Language and voice" },
  { id: "regex", navLabel: "Regex builder", sectionLabel: "Regex builder" },
  { id: "changelog", navLabel: "Changelog", sectionLabel: "Changelog" },
  { id: "history", navLabel: "Version history", sectionLabel: "Version history" },
  { id: "notifications", navLabel: "Notifications", sectionLabel: "Notifications" },
];

const ALL_SECTION_LABELS = TARGETS.map(t => t.sectionLabel);

// ------------------------------------------------------------------ page ops

async function clickNav(navLabel: string): Promise<void> {
  const ok = await evaluate(`
    (() => {
      const aside = document.querySelector('aside[data-screen-label="Navigation"]');
      if (!aside) return false;
      const want = ${lit(navLabel)};
      const btn = [...aside.querySelectorAll("button[title]")].find(b => {
        const box = b.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && b.getAttribute("title").trim() === want;
      });
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
  if (!ok) throw new Error(`no visible nav button titled "${navLabel}"`);
  await Bun.sleep(450);
}

interface ScreenProbe { visibleLabels: string[] }

/**
 * What must be true before the shutter fires: exactly one of the prototype's
 * page sections is present *and visible*, and it is the one this target
 * claims. `<sc-if>` unmounts its inactive branch entirely (verified against
 * `design/support.js`'s `walkIf`: the false branch returns `null`, not a
 * hidden node), so in practice this will only ever see zero or one match --
 * catching that fact changing later is exactly why it is asserted rather than
 * assumed.
 */
async function probeScreen(): Promise<ScreenProbe> {
  const raw = await evaluate(`
    (() => {
      const visible = el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const known = new Set(${lit(ALL_SECTION_LABELS)});
      return [...document.querySelectorAll("[data-screen-label]")]
        .filter(el => known.has(el.getAttribute("data-screen-label")) && visible(el))
        .map(el => el.getAttribute("data-screen-label"));
    })()`);
  return { visibleLabels: raw ?? [] };
}

async function assertOnScreen(target: Target): Promise<void> {
  const seen = await probeScreen();
  if (seen.visibleLabels.length !== 1) {
    throw new Error(
      `expected exactly one visible page section ("${target.sectionLabel}"), saw ${JSON.stringify(seen.visibleLabels)}`,
    );
  }
  if (seen.visibleLabels[0] !== target.sectionLabel) {
    throw new Error(`on-screen section is "${seen.visibleLabels[0]}", expected "${target.sectionLabel}"`);
  }
}

interface FontReport {
  robotoFlex: boolean;
  robotoMono: boolean;
  notoSansHK: boolean;
  materialSymbolsRounded: boolean;
  bodyFontFamily: string;
}

async function checkFonts(): Promise<FontReport> {
  return await evaluate(`
    (async () => {
      await document.fonts.ready;
      const h1 = document.querySelector("h1");

      // document.fonts.check(font, text) defaults \`text\` to U+0020 (space) when
      // omitted. Noto Sans HK ships as ~300 unicode-range-subsetted @font-face
      // rules (one Google-Fonts-generated chunk per glyph block), and its
      // Latin/space-covering chunk is never selected -- "Roboto Flex" is first
      // in the CSS font stack and already covers Latin in full, so the browser
      // never falls through to Noto Sans HK for a space or any other Latin
      // character. Checking with the default text therefore reports "not
      // loaded" even when the family is perfectly reachable, simply because
      // nothing on an English-locale screen ever asked for a CJK glyph. Passing
      // a real Cantonese sample forces the actual subset this app cares about,
      // and additionally proves the network fetch itself (not just the
      // stylesheet's @font-face declaration) by awaiting document.fonts.load()
      // for that text and checking it did not reject.
      const cjkSample = "\\u5ee3\\u6771\\u8a71\\u6e2c\\u8a66"; // "廣東話測試" - a Cantonese sample string
      let notoSansHK = false;
      try {
        const faces = await document.fonts.load("400 16px 'Noto Sans HK'", cjkSample);
        notoSansHK = faces.length > 0 && document.fonts.check("400 16px 'Noto Sans HK'", cjkSample);
      } catch { notoSansHK = false; }

      return {
        robotoFlex: document.fonts.check("400 16px 'Roboto Flex'"),
        robotoMono: document.fonts.check("400 16px 'Roboto Mono'"),
        notoSansHK,
        materialSymbolsRounded: document.fonts.check("400 24px 'Material Symbols Rounded'"),
        bodyFontFamily: getComputedStyle(h1 || document.body).fontFamily,
      };
    })()`);
}

/** Wait for the prototype's first mount: the dynamic `import()` of its data + i18n modules, plus first paint. */
async function waitForFirstMount(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const has = await evaluate(`!!document.querySelector("[data-screen-label]")`);
    if (has) {
      await Bun.sleep(500); // let late layout/paint settle
      return;
    }
    await Bun.sleep(300);
  }
  throw new Error("no [data-screen-label] element appeared within 20s of load");
}

// -------------------------------------------------------------------- capture

async function writeShot(target: Target): Promise<{ width: number; height: number }> {
  const file = join(OUT, `${target.id}.png`);
  const line = powershell(["-Action", "capture", "-Hwnd", String(hwnd), "-Out", file]);
  const [, w, h] = line.split(/\s+/);
  if (Number(w) !== PIXELS.width || Number(h) !== PIXELS.height) {
    throw new Error(`captured ${w}x${h}, expected ${PIXELS.width}x${PIXELS.height}`);
  }
  return { width: Number(w), height: Number(h) };
}

// ------------------------------------------------------------ app lifecycle

let child: ReturnType<typeof spawn> | null = null;
let hwnd = 0;

function shutdown(): void {
  try { socket?.close(); } catch { /* already gone */ }
  if (child?.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  child = null;
}

// ----------------------------------------------------------------------- main

interface Report {
  startedAt: string;
  finishedAt?: string;
  viewport: { css: typeof CSS; scale: number; pixels: typeof PIXELS };
  fonts?: FontReport;
  written: Array<{ id: string; file: string; width: number; height: number }>;
  failures: string[];
  ok: boolean;
  error?: string;
}

const report: Report = {
  startedAt: new Date().toISOString(),
  viewport: { css: CSS, scale: SCALE, pixels: PIXELS },
  written: [],
  failures: [],
  ok: false,
};

function writeReport(): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  log(`wrote report -> ${RESULT_FILE}`);
}

// A watchdog independent of every individual timeout above: if something
// wedges in a way none of those catch, this still leaves a result file behind
// rather than a silent hang -- the whole point of writing one at all when this
// script is meant to be launched detached, with nobody reading its stdout.
const watchdog = setTimeout(() => {
  report.error = "global 4-minute watchdog fired";
  report.failures.push(report.error);
  log(`FATAL: ${report.error}`);
  writeReport();
  shutdown();
  process.exit(1);
}, 4 * 60_000);
watchdog.unref?.();

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });

  const electron = resolveElectron();

  log(`launching design shell (${SHELL_MAIN}) via ${electron}`);
  child = spawn(electron, [
    SHELL_MAIN,
    `--remote-debugging-port=${CDP_PORT}`,
    `--force-device-scale-factor=${SCALE}`,
    `--user-data-dir=${PROFILE}`,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      OCX_DESIGN_WIDTH: String(CSS.width),
      OCX_DESIGN_HEIGHT: String(CSS.height),
    },
    stdio: "ignore",
  });

  const found = powershell(["-Action", "find", "-OwnerPid", String(child.pid)]);
  hwnd = Number(found.split(/\s+/)[1]);
  log(`found window hwnd=${hwnd}`);

  powershell(["-Action", "fit", "-Hwnd", String(hwnd), "-Width", String(PIXELS.width), "-Height", String(PIXELS.height)]);
  log(`fit window to ${PIXELS.width}x${PIXELS.height}`);

  await connectCdp();
  await send("Page.enable");
  await send("Runtime.enable");
  await waitForFirstMount();
  log("first mount settled");

  report.fonts = await checkFonts();
  log(`font check: ${JSON.stringify(report.fonts)}`);
  const criticalFontsMissing = !report.fonts.robotoFlex || !report.fonts.robotoMono || !report.fonts.notoSansHK;
  if (criticalFontsMissing) {
    const msg =
      "LOUD WARNING: one or more of the prototype's own typography fonts "
      + "(Roboto Flex / Roboto Mono / Noto Sans HK) did NOT load. Every capture "
      + "below is rendered in a fallback face and is NOT a valid basis for "
      + "comparison against the app's own screenshots.";
    log(msg);
    report.failures.push(msg);
  }
  if (!report.fonts.materialSymbolsRounded) {
    log(
      "note (not a failure): Material Symbols Rounded did not load. The "
      + "prototype uses it as an icon-ligature font; the shipped app never "
      + "loads it at all and renders the same glyphs as hand-authored SVGs "
      + "(gui/src/icons.tsx), so this alone does not invalidate a comparison -- "
      + "icon GLYPH SHAPE just cannot be compared pixel-for-pixel via this font.",
    );
  }

  for (const target of TARGETS) {
    try {
      if (target.id !== "dashboard") await clickNav(target.navLabel);
      await assertOnScreen(target);
      await Bun.sleep(300); // final paint settle, matching the app harness's own pre-shutter pause
      const dims = await writeShot(target);
      report.written.push({ id: target.id, file: `assets/design-shots/${target.id}.png`, ...dims });
      log(`${target.id.padEnd(16)} ${dims.width}x${dims.height} ok`);
    } catch (err) {
      const msg = `${target.id}: ${(err as Error).message}`;
      report.failures.push(msg);
      log(`${target.id.padEnd(16)} FAILED - ${(err as Error).message}`);
    }
  }

  report.ok = report.failures.length === 0;
}

main()
  .catch(err => {
    report.error = String((err as Error)?.stack || err);
    report.failures.push(report.error);
    log(`FATAL: ${report.error}`);
  })
  .finally(() => {
    clearTimeout(watchdog);
    writeReport();
    shutdown();
    log(`done. ok=${report.ok} written=${report.written.length}/${TARGETS.length} failures=${report.failures.length}`);
    process.exit(report.ok ? 0 : 1);
  });
